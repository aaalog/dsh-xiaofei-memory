// lib/feedback.js — Negative-feedback damping for dsh-xiaofei-memory.
// PRD section 4.3: on a correction signal, damp strength by dampFactor and
// arm a 15-minute recovery timer; a repeated correction keeps the damped value.

import { adjustStrength } from "./db.js";
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
    const current = adjustStrength(this.db, memoryId, "multiply", this.dampFactor);
    if (current === null) return false;
    const pending = this.pending.get(memoryId);
    if (pending?.timer) clearTimeout(pending.timer);
    // Restore target is the value just before this correction, so a single
    // correction recovers, a repeated one settles lower.
    const target = current / this.dampFactor;
    const timer = setTimeout(() => {
      this.pending.delete(memoryId);
      // Only restore if no further correction re-armed the entry.
      if (!this.pending.has(memoryId)) {
        adjustStrength(this.db, memoryId, "multiply", 1 / this.dampFactor);
      }
    }, this.recoveryMs);
    if (typeof timer?.unref === "function") timer.unref();
    this.pending.set(memoryId, { original: target, timer });
    this.logger?.info?.(`dsh-xiaofei-memory: damped memory ${String(memoryId).slice(-6)}`);
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
