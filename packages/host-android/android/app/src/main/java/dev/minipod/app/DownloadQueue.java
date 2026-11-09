package dev.minipod.app;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;

/**
 * Bounded FIFO download scheduler (pure Java, JVM-unit-testable).
 *
 * <ul>
 *   <li>At most {@code maxConcurrent} jobs are {@link State#RUNNING}; the rest wait
 *       {@link State#QUEUED} in FIFO order.
 *   <li>{@link #enqueue} is deduplicated per key: a key already QUEUED / RUNNING joins the
 *       existing job (its waiter is attached) instead of restarting the transfer.
 *   <li>As soon as a running job finishes (success, failure after retries, or cancellation) the
 *       next queued job is promoted.
 *   <li>{@link #cancel} removes a queued job without it ever running, or cancels the token of a
 *       running job (which aborts its network call / backoff sleep); {@link #cancelAll} does both
 *       for every job without promoting any of the cancelled ones.
 * </ul>
 *
 * Listener callbacks are invoked <b>outside</b> the scheduler lock.
 *
 * @param <S> job spec (what to download)
 * @param <R> job result
 */
final class DownloadQueue<S, R> {

    static final int MAX_CONCURRENT_DOWNLOADS = 3;

    enum State { QUEUED, RUNNING }

    /** Executes one job synchronously on an executor thread. */
    interface Runner<S, R> {
        R run(Job<S, R> job) throws Exception;
    }

    /** Per-caller completion callback (e.g. a pending Capacitor `PluginCall`). */
    interface Waiter<R> {
        void onSuccess(R result);

        /** @param cancelled true when the user stopped the download. */
        void onFailure(Throwable error, boolean cancelled);
    }

    interface Listener<S, R> {
        default void onQueued(Job<S, R> job) {}

        default void onStarted(Job<S, R> job) {}

        /**
         * Terminal. Not cancelled: exactly one of result / error is non-null. Cancelled: result is
         * non-null only when the transfer had already completed (its file must be discarded).
         */
        default void onFinished(Job<S, R> job, R result, Throwable error, boolean cancelled) {}

        /** Running / queued counts changed (after every transition). */
        default void onCountsChanged(int running, int queued) {}
    }

    static final class Job<S, R> {
        final String key;
        final DownloadCancelToken token = new DownloadCancelToken();
        final long enqueuedWallMs;
        private volatile S spec;
        private volatile State state = State.QUEUED;
        private final List<Waiter<R>> waiters = new ArrayList<>();
        volatile long bytesDownloaded;
        volatile long totalBytes = -1L;

        Job(String key, S spec, long enqueuedWallMs) {
            this.key = key;
            this.spec = spec;
            this.enqueuedWallMs = enqueuedWallMs;
        }

        S spec() {
            return spec;
        }

        State state() {
            return state;
        }
    }

    private final int maxConcurrent;
    private final Executor executor;
    private final Runner<S, R> runner;
    private final Listener<S, R> listener;
    private final Object lock = new Object();
    private final ArrayDeque<Job<S, R>> queued = new ArrayDeque<>();
    /** Identity set: a cancelled job may still be unwinding while its key was re-enqueued. */
    private final LinkedHashSet<Job<S, R>> running = new LinkedHashSet<>();
    private final Map<String, Job<S, R>> byKey = new LinkedHashMap<>();
    private final java.util.function.LongSupplier wallClock;

    DownloadQueue(int maxConcurrent, Executor executor, Runner<S, R> runner, Listener<S, R> listener) {
        this(maxConcurrent, executor, runner, listener, System::currentTimeMillis);
    }

    DownloadQueue(
        int maxConcurrent,
        Executor executor,
        Runner<S, R> runner,
        Listener<S, R> listener,
        java.util.function.LongSupplier wallClock
    ) {
        this.maxConcurrent = Math.max(1, maxConcurrent);
        this.executor = executor;
        this.runner = runner;
        this.listener = listener != null ? listener : new Listener<S, R>() {};
        this.wallClock = wallClock;
    }

    int maxConcurrent() {
        return maxConcurrent;
    }

    /**
     * Adds a job (or joins the existing QUEUED / RUNNING one for {@code key}).
     *
     * @return the job the waiter is attached to.
     */
    Job<S, R> enqueue(String key, S spec, Waiter<R> waiter) {
        Job<S, R> job;
        boolean created = false;
        List<Job<S, R>> started;
        int[] counts;
        synchronized (lock) {
            job = byKey.get(key);
            if (job == null || job.token.isCancelled()) {
                job = new Job<>(key, spec, wallClock.getAsLong());
                byKey.put(key, job);
                queued.addLast(job);
                created = true;
            }
            if (waiter != null) job.waiters.add(waiter);
            started = created ? pumpLocked() : Collections.emptyList();
            counts = countsLocked();
        }
        if (created) {
            listener.onQueued(job);
        }
        dispatch(started);
        if (created) listener.onCountsChanged(counts[0], counts[1]);
        return job;
    }

    /**
     * Attaches {@code waiter} to the live QUEUED / RUNNING job of {@code key} without ever creating
     * one (WebView re-attach after a cold reconnect). Returns false when no such job exists.
     */
    boolean attach(String key, Waiter<R> waiter) {
        synchronized (lock) {
            Job<S, R> job = byKey.get(key);
            if (job == null || job.token.isCancelled()) return false;
            if (waiter != null) job.waiters.add(waiter);
            return true;
        }
    }

    /** Cancels a QUEUED or RUNNING job; returns false when {@code key} is unknown. */
    boolean cancel(String key) {
        Job<S, R> removedQueued = null;
        Job<S, R> runningJob = null;
        int[] counts;
        synchronized (lock) {
            Job<S, R> job = byKey.get(key);
            if (job == null) return false;
            if (job.state == State.QUEUED) {
                queued.remove(job);
                byKey.remove(key);
                removedQueued = job;
            } else {
                runningJob = job;
            }
            counts = countsLocked();
        }
        if (removedQueued != null) {
            removedQueued.token.cancel();
            finishCancelledQueued(removedQueued);
            listener.onCountsChanged(counts[0], counts[1]);
        } else if (runningJob != null) {
            // The runner observes the token (aborted call / woken sleep) and settles via onJobDone.
            runningJob.token.cancel();
        }
        return true;
    }

    /** Cancels every queued and running job; queued ones never start. */
    List<String> cancelAll() {
        List<Job<S, R>> drained;
        List<Job<S, R>> active;
        int[] counts;
        synchronized (lock) {
            drained = new ArrayList<>(queued);
            queued.clear();
            for (Job<S, R> j : drained) byKey.remove(j.key);
            active = new ArrayList<>(running);
            for (Job<S, R> j : active) j.token.cancel();
            counts = countsLocked();
        }
        List<String> keys = new ArrayList<>();
        for (Job<S, R> j : drained) {
            j.token.cancel();
            finishCancelledQueued(j);
            keys.add(j.key);
        }
        for (Job<S, R> j : active) keys.add(j.key);
        if (!drained.isEmpty()) listener.onCountsChanged(counts[0], counts[1]);
        return keys;
    }

    Job<S, R> get(String key) {
        synchronized (lock) {
            return byKey.get(key);
        }
    }

    /** Running jobs first (start order), then queued jobs (FIFO). */
    List<Job<S, R>> snapshot() {
        synchronized (lock) {
            List<Job<S, R>> out = new ArrayList<>(running);
            out.addAll(queued);
            return out;
        }
    }

    int runningCount() {
        synchronized (lock) {
            return running.size();
        }
    }

    int queuedCount() {
        synchronized (lock) {
            return queued.size();
        }
    }

    boolean isIdle() {
        synchronized (lock) {
            return running.isEmpty() && queued.isEmpty();
        }
    }

    // ------------------------------------------------------------------ internals

    private int[] countsLocked() {
        return new int[] { running.size(), queued.size() };
    }

    private List<Job<S, R>> pumpLocked() {
        List<Job<S, R>> started = new ArrayList<>();
        while (running.size() < maxConcurrent) {
            Job<S, R> next = null;
            for (Iterator<Job<S, R>> it = queued.iterator(); it.hasNext(); ) {
                Job<S, R> candidate = it.next();
                if (candidate.token.isCancelled()) {
                    it.remove();
                    byKey.remove(candidate.key, candidate);
                    continue;
                }
                if (isKeyRunningLocked(candidate.key)) {
                    // A cancelled transfer of the same episode is still unwinding (deleting its
                    // `.part`): never run two transfers on one file. Promoted once it settles.
                    continue;
                }
                it.remove();
                next = candidate;
                break;
            }
            if (next == null) break;
            next.state = State.RUNNING;
            running.add(next);
            started.add(next);
        }
        return started;
    }

    private boolean isKeyRunningLocked(String key) {
        for (Job<S, R> j : running) {
            if (j.key.equals(key)) return true;
        }
        return false;
    }

    private void dispatch(List<Job<S, R>> started) {
        for (Job<S, R> job : started) {
            listener.onStarted(job);
            try {
                executor.execute(() -> runJob(job));
            } catch (RuntimeException rejected) {
                onJobDone(job, null, rejected);
            }
        }
    }

    private void runJob(Job<S, R> job) {
        R result = null;
        Throwable error = null;
        try {
            if (job.token.isCancelled()) {
                throw new DownloadTransfer.CancelledException();
            }
            result = runner.run(job);
        } catch (Throwable t) {
            error = t;
        }
        onJobDone(job, result, error);
    }

    private void onJobDone(Job<S, R> job, R result, Throwable error) {
        boolean cancelled = job.token.isCancelled();
        List<Waiter<R>> waiters;
        List<Job<S, R>> started;
        int[] counts;
        synchronized (lock) {
            running.remove(job);
            byKey.remove(job.key, job);
            waiters = new ArrayList<>(job.waiters);
            job.waiters.clear();
            started = pumpLocked();
            counts = countsLocked();
        }
        if (cancelled) {
            // `result` non-null: the transfer completed right as the user stopped it.
            listener.onFinished(job, result, error, true);
        } else {
            listener.onFinished(job, error == null ? result : null, error, false);
        }
        notifyWaiters(waiters, cancelled ? null : result, error, cancelled);
        dispatch(started);
        listener.onCountsChanged(counts[0], counts[1]);
    }

    private void finishCancelledQueued(Job<S, R> job) {
        List<Waiter<R>> waiters;
        synchronized (lock) {
            waiters = new ArrayList<>(job.waiters);
            job.waiters.clear();
        }
        listener.onFinished(job, null, null, true);
        notifyWaiters(waiters, null, null, true);
    }

    private void notifyWaiters(List<Waiter<R>> waiters, R result, Throwable error, boolean cancelled) {
        for (Iterator<Waiter<R>> it = waiters.iterator(); it.hasNext(); ) {
            Waiter<R> w = it.next();
            try {
                if (cancelled) {
                    w.onFailure(error != null ? error : new DownloadTransfer.CancelledException(), true);
                } else if (error != null) {
                    w.onFailure(error, false);
                } else {
                    w.onSuccess(result);
                }
            } catch (RuntimeException ignored) {
                // one broken waiter (e.g. a destroyed WebView bridge) must not starve the others
            }
        }
    }
}
