// lib/sleep-trigger.js — when should the nightly pass run?
//
// The pass was scheduled for one hour a day, so a laptop that slept through it
// missed the window, and the hour it did fire often had nothing to distil (the
// largest group was below threshold). The owner's machine is on and off by
// turns, not a server on a timer.
//
// A watermark fixes that: as soon as the recent layer has enough rows, the pass
// is queued — "it sleeps when it is full, not when the clock says so". The
// hourly pass stays as a fallback for vacuum and expired-archive cleanup.

/**
 * Pure decision, kept separate from the plugin so it can be tested.
 *
 * @param {{recent: number, watermark: number, lastAt: number, now: number, minIntervalMs: number}} p
 * @returns {boolean}
 */
export function watermarkReached({ recent, watermark, lastAt, now, minIntervalMs }) {
  const rows = Number(recent);
  const mark = Number(watermark);
  if (!Number.isFinite(mark) || mark <= 0) return false;
  if (!Number.isFinite(rows) || rows < mark) return false;

  const interval = Number(minIntervalMs);
  const minInterval = Number.isFinite(interval) && interval > 0 ? interval : 6 * 60 * 60 * 1000;
  const last = Number(lastAt);
  if (last > 0 && Number(now) - last < minInterval) return false;

  return true;
}
