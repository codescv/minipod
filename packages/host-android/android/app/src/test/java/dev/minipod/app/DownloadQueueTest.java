package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Native 3-slot FIFO download queue: cap, FIFO promotion, dedupe, cancel, cancelAll. */
public class DownloadQueueTest {

    private ExecutorService pool;
    private final Map<String, CountDownLatch> release = new ConcurrentHashMap<>();
    private final List<String> startOrder = Collections.synchronizedList(new ArrayList<>());
    private final List<String> runOrder = Collections.synchronizedList(new ArrayList<>());
    private final List<String> events = Collections.synchronizedList(new ArrayList<>());
    private final AtomicInteger inFlight = new AtomicInteger();
    private final AtomicInteger maxInFlight = new AtomicInteger();
    private DownloadQueue<String, String> queue;

    @Before
    public void setUp() {
        pool = Executors.newCachedThreadPool();
        queue = new DownloadQueue<>(
            DownloadQueue.MAX_CONCURRENT_DOWNLOADS,
            pool,
            job -> {
                int now = inFlight.incrementAndGet();
                maxInFlight.accumulateAndGet(now, Math::max);
                runOrder.add(job.key);
                try {
                    CountDownLatch latch = release.computeIfAbsent(job.key, k -> new CountDownLatch(1));
                    // Blocks until released, or until cancelled (like an aborted socket / backoff).
                    while (!latch.await(5, TimeUnit.MILLISECONDS)) {
                        if (job.token.isCancelled()) throw new DownloadTransfer.CancelledException();
                    }
                    if (job.token.isCancelled()) throw new DownloadTransfer.CancelledException();
                    if (job.spec().startsWith("fail")) throw new java.io.IOException("boom");
                    return "result-" + job.key;
                } finally {
                    inFlight.decrementAndGet();
                }
            },
            new DownloadQueue.Listener<String, String>() {
                @Override
                public void onQueued(DownloadQueue.Job<String, String> job) {
                    events.add("QUEUED:" + job.key);
                }

                @Override
                public void onStarted(DownloadQueue.Job<String, String> job) {
                    startOrder.add(job.key);
                    events.add("RUNNING:" + job.key);
                }

                @Override
                public void onFinished(DownloadQueue.Job<String, String> job, String result, Throwable error, boolean cancelled) {
                    events.add((cancelled ? "NONE:" : error != null ? "FAILED:" : "DONE:") + job.key);
                }
            }
        );
    }

    @After
    public void tearDown() {
        for (CountDownLatch l : release.values()) {
            while (l.getCount() > 0) l.countDown();
        }
        pool.shutdownNow();
    }

    private static final class RecordingWaiter implements DownloadQueue.Waiter<String> {
        final CountDownLatch done = new CountDownLatch(1);
        volatile String result;
        volatile Throwable error;
        volatile boolean cancelled;

        @Override
        public void onSuccess(String r) {
            result = r;
            done.countDown();
        }

        @Override
        public void onFailure(Throwable e, boolean c) {
            error = e;
            cancelled = c;
            done.countDown();
        }

        void await() throws InterruptedException {
            assertTrue("waiter never settled", done.await(5, TimeUnit.SECONDS));
        }
    }

    private void finish(String key) {
        release.computeIfAbsent(key, k -> new CountDownLatch(1)).countDown();
    }

    private void awaitRunning(int n) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000;
        while (queue.runningCount() != n && System.currentTimeMillis() < deadline) Thread.sleep(2);
        assertEquals(n, queue.runningCount());
    }

    private static void awaitTrue(java.util.function.BooleanSupplier cond) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000;
        while (!cond.getAsBoolean() && System.currentTimeMillis() < deadline) Thread.sleep(2);
        assertTrue(cond.getAsBoolean());
    }

    @Test
    public void eightTasks_neverMoreThanThreeInFlight_promotedFifo() throws Exception {
        List<RecordingWaiter> waiters = new ArrayList<>();
        for (int i = 1; i <= 8; i++) {
            RecordingWaiter w = new RecordingWaiter();
            waiters.add(w);
            queue.enqueue("ep" + i, "spec", w);
        }
        awaitRunning(3);
        assertEquals(5, queue.queuedCount());
        assertEquals(List.of("ep1", "ep2", "ep3"), new ArrayList<>(startOrder));

        // Finish in a scrambled order: the waiting ones are still promoted strictly FIFO.
        String[] finishOrder = { "ep2", "ep1", "ep4", "ep3", "ep6", "ep5", "ep8", "ep7" };
        for (String k : finishOrder) {
            awaitTrue(() -> runOrder.contains(k));
            finish(k);
            Thread.sleep(5);
            assertTrue(queue.runningCount() <= 3);
        }
        for (RecordingWaiter w : waiters) w.await();
        assertEquals(List.of("ep1", "ep2", "ep3", "ep4", "ep5", "ep6", "ep7", "ep8"), new ArrayList<>(startOrder));
        assertTrue("max in flight " + maxInFlight.get(), maxInFlight.get() <= 3);
        assertEquals(3, maxInFlight.get());
        assertEquals("result-ep5", waiters.get(4).result);
        assertTrue(queue.isIdle());
    }

    @Test
    public void enqueueSameKey_joinsExistingJob_withoutRestarting() throws Exception {
        RecordingWaiter a = new RecordingWaiter();
        RecordingWaiter b = new RecordingWaiter();
        DownloadQueue.Job<String, String> j1 = queue.enqueue("ep1", "spec", a);
        awaitRunning(1);
        DownloadQueue.Job<String, String> j2 = queue.enqueue("ep1", "spec", b);
        assertSame(j1, j2);
        assertEquals(0, queue.queuedCount());
        finish("ep1");
        a.await();
        b.await();
        assertEquals("result-ep1", a.result);
        assertEquals("result-ep1", b.result);
        assertEquals(List.of("ep1"), new ArrayList<>(runOrder));
        assertEquals(1, Collections.frequency(events, "QUEUED:ep1"));
    }

    @Test
    public void dedupe_whileQueued_keepsSingleQueueEntry() throws Exception {
        for (int i = 1; i <= 3; i++) queue.enqueue("ep" + i, "spec", null);
        awaitRunning(3);
        queue.enqueue("ep4", "spec", null);
        queue.enqueue("ep4", "spec", null);
        assertEquals(1, queue.queuedCount());
    }

    @Test
    public void cancelQueued_neverRuns_andSettlesCancelled() throws Exception {
        for (int i = 1; i <= 3; i++) queue.enqueue("ep" + i, "spec", null);
        awaitRunning(3);
        RecordingWaiter w = new RecordingWaiter();
        queue.enqueue("ep4", "spec", w);
        assertTrue(queue.cancel("ep4"));
        w.await();
        assertTrue(w.cancelled);
        assertEquals(0, queue.queuedCount());
        finish("ep1");
        finish("ep2");
        finish("ep3");
        awaitTrue(() -> queue.isIdle());
        assertFalse(runOrder.contains("ep4"));
        assertTrue(events.contains("NONE:ep4"));
        assertFalse(events.contains("RUNNING:ep4"));
    }

    @Test
    public void cancelRunning_promotesNextQueued() throws Exception {
        RecordingWaiter w1 = new RecordingWaiter();
        queue.enqueue("ep1", "spec", w1);
        queue.enqueue("ep2", "spec", null);
        queue.enqueue("ep3", "spec", null);
        queue.enqueue("ep4", "spec", null);
        awaitRunning(3);
        assertFalse(runOrder.contains("ep4"));
        assertTrue(queue.cancel("ep1"));
        w1.await();
        assertTrue(w1.cancelled);
        awaitTrue(() -> runOrder.contains("ep4"));
        assertEquals(3, queue.runningCount());
        assertTrue(events.contains("NONE:ep1"));
    }

    @Test
    public void failure_settlesWaiter_andPromotesNext() throws Exception {
        RecordingWaiter w1 = new RecordingWaiter();
        queue.enqueue("ep1", "fail", w1);
        queue.enqueue("ep2", "spec", null);
        queue.enqueue("ep3", "spec", null);
        queue.enqueue("ep4", "spec", null);
        awaitRunning(3);
        finish("ep1");
        w1.await();
        assertFalse(w1.cancelled);
        assertNotNull(w1.error);
        awaitTrue(() -> runOrder.contains("ep4"));
        assertTrue(events.contains("FAILED:ep1"));
    }

    @Test
    public void cancelAll_stopsRunningAndQueued_withoutStartingQueued() throws Exception {
        List<RecordingWaiter> waiters = new ArrayList<>();
        for (int i = 1; i <= 6; i++) {
            RecordingWaiter w = new RecordingWaiter();
            waiters.add(w);
            queue.enqueue("ep" + i, "spec", w);
        }
        awaitRunning(3);
        List<String> cancelled = queue.cancelAll();
        assertEquals(6, cancelled.size());
        for (RecordingWaiter w : waiters) {
            w.await();
            assertTrue(w.cancelled);
        }
        awaitTrue(() -> queue.isIdle());
        assertEquals(List.of("ep1", "ep2", "ep3"), new ArrayList<>(startOrder));
        for (int i = 4; i <= 6; i++) assertFalse(runOrder.contains("ep" + i));
    }

    @Test
    public void cancelUnknownKey_returnsFalse() {
        assertFalse(queue.cancel("nope"));
    }

    @Test
    public void reEnqueueWhileCancelledJobUnwinds_waitsThenRunsFresh() throws Exception {
        CountDownLatch unwind = new CountDownLatch(1);
        AtomicInteger concurrentSameKey = new AtomicInteger();
        AtomicInteger maxSameKey = new AtomicInteger();
        AtomicInteger runs = new AtomicInteger();
        DownloadQueue<String, String> q = new DownloadQueue<>(3, pool, job -> {
            int n = concurrentSameKey.incrementAndGet();
            maxSameKey.accumulateAndGet(n, Math::max);
            try {
                if (runs.incrementAndGet() == 1) {
                    job.token.awaitCancelled(5_000);
                    unwind.await(5, TimeUnit.SECONDS); // still deleting `.part` ...
                    throw new DownloadTransfer.CancelledException();
                }
                return "fresh";
            } finally {
                concurrentSameKey.decrementAndGet();
            }
        }, null);
        RecordingWaiter first = new RecordingWaiter();
        q.enqueue("ep1", "spec", first);
        awaitTrue(() -> runs.get() == 1);
        q.cancel("ep1");
        RecordingWaiter second = new RecordingWaiter();
        DownloadQueue.Job<String, String> fresh = q.enqueue("ep1", "spec", second);
        Thread.sleep(30);
        assertEquals(1, runs.get());
        assertEquals(DownloadQueue.State.QUEUED, fresh.state());
        unwind.countDown();
        first.await();
        second.await();
        assertTrue(first.cancelled);
        assertEquals("fresh", second.result);
        assertEquals(1, maxSameKey.get());
    }

    @Test
    public void cancelToken_wakesBackoffSleepImmediately() throws Exception {
        DownloadCancelToken token = new DownloadCancelToken();
        AtomicInteger aborted = new AtomicInteger();
        token.setActiveAbort(aborted::incrementAndGet);
        long[] elapsed = { -1L };
        Thread t = new Thread(() -> {
            long start = System.nanoTime();
            boolean c = token.awaitCancelled(10_000);
            elapsed[0] = (System.nanoTime() - start) / 1_000_000L;
            assertTrue(c);
        });
        t.start();
        Thread.sleep(20);
        assertTrue(token.cancel());
        assertFalse(token.cancel());
        t.join(2_000);
        assertTrue("slept " + elapsed[0] + "ms", elapsed[0] >= 0 && elapsed[0] < 1_000);
        assertEquals(1, aborted.get());
        // A hook registered after cancellation runs immediately.
        token.setActiveAbort(aborted::incrementAndGet);
        assertEquals(2, aborted.get());
    }

    @Test
    public void attach_joinsLiveJobOnly_neverCreatesOne() throws Exception {
        RecordingWaiter orphan = new RecordingWaiter();
        assertFalse(queue.attach("ep1", orphan));
        assertTrue(queue.isIdle());
        assertEquals("orphan waiter is not settled by the queue", 1, orphan.done.getCount());

        RecordingWaiter owner = new RecordingWaiter();
        queue.enqueue("ep1", "spec", owner);
        awaitRunning(1);
        RecordingWaiter reattached = new RecordingWaiter();
        assertTrue(queue.attach("ep1", reattached));
        finish("ep1");
        owner.await();
        reattached.await();
        assertEquals("result-ep1", reattached.result);
        assertEquals(List.of("ep1"), new ArrayList<>(runOrder));
        assertFalse("finished job is gone", queue.attach("ep1", new RecordingWaiter()));
    }
}
