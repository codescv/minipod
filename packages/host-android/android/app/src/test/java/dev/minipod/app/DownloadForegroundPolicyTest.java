package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/**
 * `EpisodeDownloadService` lifecycle helpers: foreground promotion / update / stop decisions,
 * Android 15+ `onTimeout` safety, wake + Wi-Fi lock transitions, notification progress.
 */
public class DownloadForegroundPolicyTest {

    private static final class FakeLock implements DownloadForegroundPolicy.Lock {
        boolean held;
        int acquires;
        int releases;
        long lastTimeout = -1L;
        boolean throwOnAcquire;

        @Override
        public void acquire(long timeoutMs) {
            if (throwOnAcquire) throw new SecurityException("no WAKE_LOCK");
            held = true;
            acquires++;
            lastTimeout = timeoutMs;
        }

        @Override
        public void release() {
            if (!held) throw new RuntimeException("under-locked");
            held = false;
            releases++;
        }

        @Override
        public boolean isHeld() {
            return held;
        }
    }

    @Test
    public void constants_doNotCollideWithPlayback() {
        assertEquals("minipod_downloads", EpisodeDownloadService.CHANNEL_ID);
        assertEquals(1002, EpisodeDownloadService.NOTIFICATION_ID);
        assertTrue(EpisodeDownloadService.NOTIFICATION_ID != PlaybackService.NOTIFICATION_ID);
        assertFalse(EpisodeDownloadService.CHANNEL_ID.equals(PlaybackService.NOTIFICATION_CHANNEL_ID));
        assertEquals("minipod:downloads", EpisodeDownloadService.WAKE_LOCK_TAG);
        assertEquals(3, DownloadQueue.MAX_CONCURRENT_DOWNLOADS);
    }

    @Test
    public void shouldRequestStart_onlyWhenActive_notAlive_notTimedOut() {
        assertTrue(DownloadForegroundPolicy.shouldRequestStart(false, false, 1, 0));
        assertTrue(DownloadForegroundPolicy.shouldRequestStart(false, false, 0, 4));
        assertFalse(DownloadForegroundPolicy.shouldRequestStart(false, false, 0, 0));
        assertFalse(DownloadForegroundPolicy.shouldRequestStart(true, false, 3, 2));
        assertFalse("Android 15 dataSync budget exhausted", DownloadForegroundPolicy.shouldRequestStart(false, true, 3, 2));
    }

    @Test
    public void serviceState_promotedEveryStart_updatesThrottled_stopsWhenDrained() {
        DownloadForegroundPolicy.ServiceState s = new DownloadForegroundPolicy.ServiceState();
        s.onStartCommand();
        s.onPromotionResult(true);
        assertTrue(s.isForeground());
        assertFalse(DownloadForegroundPolicy.ServiceState.shouldStopAfterStart(3, 5, false));

        assertEquals(DownloadForegroundPolicy.Action.UPDATE_NOTIFICATION, s.onUpdate(3, 5, 1_000L));
        // Same counts within 1 s: throttled.
        assertEquals(DownloadForegroundPolicy.Action.NONE, s.onUpdate(3, 5, 1_500L));
        // Counts changed (promotion): immediate.
        assertEquals(DownloadForegroundPolicy.Action.UPDATE_NOTIFICATION, s.onUpdate(3, 4, 1_600L));
        assertEquals(DownloadForegroundPolicy.Action.UPDATE_NOTIFICATION, s.onUpdate(3, 4, 2_700L));

        // A second (coalesced / late) start request on the live instance starts a fresh cycle and
        // is promoted again: the service never skips `startForeground` for a start request.
        s.onStartCommand();
        s.onPromotionResult(true);
        assertEquals(DownloadForegroundPolicy.Action.UPDATE_NOTIFICATION, s.onUpdate(3, 4, 2_800L));

        assertEquals(DownloadForegroundPolicy.Action.STOP, s.onUpdate(0, 0, 2_900L));
        s.onStopped();
        assertFalse(s.isForeground());
    }

    @Test
    public void shouldStopAfterStart_whenDrainedOrTimedOut() {
        // Late start request after the queue already drained: promote (mandatory), then stop.
        assertTrue(DownloadForegroundPolicy.ServiceState.shouldStopAfterStart(0, 0, false));
        // Start request landing after Android 15 `onTimeout`: stop right away.
        assertTrue(DownloadForegroundPolicy.ServiceState.shouldStopAfterStart(2, 3, true));
        assertFalse(DownloadForegroundPolicy.ServiceState.shouldStopAfterStart(0, 1, false));
    }

    @Test
    public void startGate_coalescesStartsForAWholeBatch() {
        DownloadForegroundPolicy.StartGate gate = new DownloadForegroundPolicy.StartGate();
        // `下载全部` x 10: ten syncs before the service instance exists -> exactly one start.
        int starts = 0;
        for (int i = 1; i <= 10; i++) {
            if (gate.tryBegin(false, false, Math.min(i, 3), Math.max(0, i - 3))) starts++;
        }
        assertEquals(1, starts);
        assertTrue(gate.isPending());
        gate.clear(); // onStartCommand
        assertFalse(gate.tryBegin(true, false, 3, 7));
        assertFalse(gate.tryBegin(false, true, 3, 7));
        assertFalse(gate.tryBegin(false, false, 0, 0));
        assertTrue(gate.tryBegin(false, false, 1, 0));
        gate.clear(); // start threw
        assertTrue(gate.tryBegin(false, false, 1, 0));
    }

    @Test
    public void serviceState_refusedPromotion_neverCrashes_runsBestEffort_stillStops() {
        DownloadForegroundPolicy.ServiceState s = new DownloadForegroundPolicy.ServiceState();
        s.onStartCommand();
        s.onPromotionResult(false);
        assertTrue(s.wasPromotionDenied());
        assertFalse(s.isForeground());
        assertEquals(DownloadForegroundPolicy.Action.NONE, s.onUpdate(2, 0, 0L));
        assertEquals(DownloadForegroundPolicy.Action.STOP, s.onUpdate(0, 0, 10L));
    }

    @Test
    public void serviceState_onTimeout_stopsForeground_andStopsService() {
        DownloadForegroundPolicy.ServiceState s = new DownloadForegroundPolicy.ServiceState();
        s.onStartCommand();
        s.onPromotionResult(true);
        assertEquals(DownloadForegroundPolicy.Action.STOP, s.onTimeout());
        assertTrue(s.isTimedOut());
        assertFalse(s.isForeground());
        assertEquals(DownloadForegroundPolicy.Action.NONE, s.onUpdate(1, 0, 0L));
        // A new start cycle (user back in the app) begins clean.
        s.onStartCommand();
        assertFalse(s.isTimedOut());
    }

    @Test
    public void locks_boundedWakeLockIsRenewedDuringLongDownloads() {
        FakeLock wake = new FakeLock();
        FakeLock wifi = new FakeLock();
        DownloadForegroundPolicy.Locks locks = new DownloadForegroundPolicy.Locks(wake, wifi);
        long t0 = 1_000_000L;
        locks.update(true, t0);
        assertEquals(1, wake.acquires);
        locks.update(true, t0 + 60_000L);
        assertEquals("progress ticks do not hammer acquire()", 1, wake.acquires);
        locks.update(true, t0 + DownloadForegroundPolicy.WAKE_LOCK_RENEW_MS);
        assertEquals(2, wake.acquires);
        assertTrue(DownloadForegroundPolicy.WAKE_LOCK_RENEW_MS < DownloadForegroundPolicy.WAKE_LOCK_TIMEOUT_MS);
        // The OS released it (timeout elapsed): re-acquired on the next tick.
        wake.held = false;
        locks.update(true, t0 + DownloadForegroundPolicy.WAKE_LOCK_RENEW_MS + 1_000L);
        assertEquals(3, wake.acquires);
        assertEquals(1, wifi.acquires);
        locks.update(false, t0 + 2 * DownloadForegroundPolicy.WAKE_LOCK_RENEW_MS);
        assertFalse(wake.held);
        assertFalse(wifi.held);
    }

    @Test
    public void locks_heldOnlyWhileActive_idempotent_releasedOnDrain() {
        FakeLock wake = new FakeLock();
        FakeLock wifi = new FakeLock();
        DownloadForegroundPolicy.Locks locks = new DownloadForegroundPolicy.Locks(wake, wifi);
        assertFalse(locks.isHeld());

        locks.update(true);
        assertTrue(wake.held);
        assertTrue(wifi.held);
        assertEquals(DownloadForegroundPolicy.WAKE_LOCK_TIMEOUT_MS, wake.lastTimeout);
        locks.update(true); // renews the bounded wake lock, Wi-Fi lock acquired once
        assertEquals(2, wake.acquires);
        assertEquals(1, wifi.acquires);

        locks.update(false);
        assertFalse(wake.held);
        assertFalse(wifi.held);
        locks.update(false); // no under-lock exception
        locks.releaseAll();
        assertEquals(1, wake.releases);
        assertEquals(1, wifi.releases);
        assertFalse(locks.isHeld());
    }

    @Test
    public void locks_toleratePermissionErrorsAndMissingLocks() {
        FakeLock wake = new FakeLock();
        wake.throwOnAcquire = true;
        DownloadForegroundPolicy.Locks locks = new DownloadForegroundPolicy.Locks(wake, null);
        locks.update(true);
        locks.update(false);
        new DownloadForegroundPolicy.Locks(null, null).update(true);
    }

    @Test
    public void aggregatePercent_ignoresUnknownSizes() {
        assertEquals(50, DownloadForegroundPolicy.aggregatePercent(new long[] { 50, 50 }, new long[] { 100, 100 }));
        assertEquals(25, DownloadForegroundPolicy.aggregatePercent(new long[] { 25, 999 }, new long[] { 100, -1 }));
        assertEquals(100, DownloadForegroundPolicy.aggregatePercent(new long[] { 500 }, new long[] { 100 }));
        assertEquals(-1, DownloadForegroundPolicy.aggregatePercent(new long[] { 10 }, new long[] { -1 }));
        assertEquals(-1, DownloadForegroundPolicy.aggregatePercent(new long[0], new long[0]));
        assertEquals(-1, DownloadForegroundPolicy.aggregatePercent(null, null));
    }

    @Test
    public void resultStore_journalsTerminalResults_untilAcked() {
        String[] backing = { null };
        DownloadResultStore store = new DownloadResultStore(new DownloadResultStore.Storage() {
            @Override
            public String read() {
                return backing[0];
            }

            @Override
            public void write(String value) {
                backing[0] = value;
            }
        });
        assertTrue(store.list().isEmpty());
        store.put(DownloadResultStore.Entry.done("ep1", "/files/downloads/ep1.mp3", 123L, "audio/mpeg", 10L));
        store.put(DownloadResultStore.Entry.failed("ep2", "network", "HTTP 503", 20L));

        // Survives a "process restart" (new store over the same persisted string).
        DownloadResultStore reopened = new DownloadResultStore(new DownloadResultStore.Storage() {
            @Override
            public String read() {
                return backing[0];
            }

            @Override
            public void write(String value) {
                backing[0] = value;
            }
        });
        List<DownloadResultStore.Entry> all = reopened.list();
        assertEquals(2, all.size());
        assertEquals("ep1", all.get(0).episodeKey);
        assertEquals("DONE", all.get(0).state);
        assertEquals("/files/downloads/ep1.mp3", all.get(0).path);
        assertEquals(123L, all.get(0).size);
        assertEquals("FAILED", all.get(1).state);
        assertEquals("HTTP 503", all.get(1).errorMessage);

        List<String> ack = new ArrayList<>();
        ack.add("ep1");
        ack.add("unknown");
        reopened.ack(ack);
        assertEquals(1, reopened.list().size());
        reopened.remove("ep2");
        assertTrue(reopened.list().isEmpty());

        backing[0] = "{corrupt";
        assertTrue(reopened.list().isEmpty());
        reopened.put(DownloadResultStore.Entry.done("ep3", "/p", 1L, null, 30L));
        assertEquals(1, reopened.list().size());
    }

    @Test
    public void resultStore_isBounded() {
        String[] backing = { null };
        DownloadResultStore store = new DownloadResultStore(new DownloadResultStore.Storage() {
            @Override
            public String read() {
                return backing[0];
            }

            @Override
            public void write(String value) {
                backing[0] = value;
            }
        });
        for (int i = 0; i < DownloadResultStore.MAX_ENTRIES + 15; i++) {
            store.put(DownloadResultStore.Entry.failed("ep" + i, "network", "x", i));
        }
        List<DownloadResultStore.Entry> all = store.list();
        assertEquals(DownloadResultStore.MAX_ENTRIES, all.size());
        assertEquals("ep15", all.get(0).episodeKey);
    }
}
