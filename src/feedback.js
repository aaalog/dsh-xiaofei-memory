// lib/feedback.js — Negative-feedback damping for dsh-xiaofei-memory.
// PRD section 4.3: on a correction signal, damp strength by dampFactor and
// arm a 15-minute recovery timer; a repeated correction keeps the damped value.

import { adjustStrength, setStrength } from "./db.js";
import { clamp } from "./util.js";

const DEFAULT_RECOVERY_MS = 15 * 60 * 1000;

export class FeedbackManager {
  constructor({ db, dampFactor = 0.85, recoveryMs = DEFAULT_RECOVERY_MS, logger }) {
    this.db = db;
    this.dampFactor = clamp(dampFactor, 0.1, 0.99);
    this.recoveryMs = recoveryMs;
    this.logger = logger;
    this.pending = new Map(); // memoryId -> { original, timer }
  }

  /**
   * Apply a correction (damp) to a memory. Called on a correction signal.
   * If the memory was already damped and not recovered, this counts as a
   * repeat correction: keep the damped value and restart the timer.
   */
  damp(memoryId) {
    const row = this.db.prepare("SELECT strength FROM memories WHERE id = ?").get(memoryId);
    if (!row) return false;
    const existing = this.pending.get(memoryId);
    if (existing?.timer) clearTimeout(existing.timer);
    // Remember the value from *before the first* correction: a repeated damp
    // lowers it further, and recovery restores the original. That is what
    // "a repeated correction settles lower" means.
    const original = existing ? existing.original : (Number(row.strength) || 1);
    const damped = adjustStrength(this.db, memoryId, "multiply", this.dampFactor);
    if (damped === null) return false;
    const timer = setTimeout(() => {
      const entry = this.pending.get(memoryId);
      if (!entry || entry.timer !== timer) return; // re-armed by a newer damp
      this.pending.delete(memoryId);
      setStrength(this.db, memoryId, original);
    }, this.recoveryMs);
    if (typeof timer?.unref === "function") timer.unref();
    this.pending.set(memoryId, { original, timer });
    this.logger?.info?.(
      `dsh-xiaofei-memory: damped memory ${String(memoryId).slice(-6)} (${(Number(row.strength) || 0).toFixed(2)} -> ${damped.toFixed(2)})`
    );
    return true;
  }

  /** Whether a memory is currently under a correction penalty. */
  isDamped(memoryId) {
    return this.pending.has(memoryId);
  }

  dispose() {
    for (const { timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
    }
    this.pending.clear();
  }
}
