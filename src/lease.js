// lib/lease.js — a one-shot claim in the `meta` table.
//
// The nightly pass is scheduled per process, so two DSH windows waking at 03:00
// each ran a full sleep plus VACUUM; a review measured them 1.19 seconds apart.
// The work is idempotent but not free: it contends for the write lock and
// double-counts the log. A lease makes the second process stand down.
//
// Claim and release are single transactions, because both are read-modify-write
// on one row and the whole point is to be correct across processes.

import { metaGet, metaSet, withTransaction } from "./db.js";

/**
 * Try to take a lease.
 *
 * @param {any} db open database handle
 * @param {string} key the `meta` key holding the holder's timestamp
 * @param {number} ttlMs how long a claim stays valid without a release
 * @returns {boolean} true when this caller now holds the lease
 */
export function claimLease(db, key, ttlMs) {
  try {
    return withTransaction(db, () => {
      const held = Number(metaGet(db, key)) || 0;
      if (held > 0 && Date.now() - held < Math.max(0, Number(ttlMs) || 0)) return false;
      metaSet(db, key, String(Date.now()));
      return true;
    });
  } catch {
    // A lease failure must not be read as "someone else is running": a broken
    // claim would otherwise disable the nightly pass forever.
    return true;
  }
}

/** Drop a claim so the next occurrence can take it. */
export function releaseLease(db, key) {
  try {
    withTransaction(db, () => metaSet(db, key, "0"));
  } catch { /* ignore */ }
}
