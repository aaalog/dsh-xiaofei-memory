// lib/evolution.js — Adaptive self-evolution for dsh-xiaofei-memory.
// PRD section 4.4: when high-similarity recalls are frequently corrected,
// nudge the retrieval weight down and the time-decay penalty up, persisting
// to the meta table.

import { metaGet, metaSet } from "./db.js";
import { clamp } from "./util.js";

const KEY_WEIGHT = "evolution.retrievalWeight";
const KEY_DECAY = "evolution.timeDecay";
const CORRECTION_RATIO_TRIGGER = 0.3;
const WEIGHT_STEP = 0.05;
const WEIGHT_MIN = 0.35;
const WEIGHT_MAX = 0.65;
const DECAY_STEP = 0.002;
const DECAY_MAX = 0.05;

/**
 * Load the current evolution params with defaults (PRD: 0.65 weight, 0.01 decay).
 */
export function loadEvolution(db) {
  const weight = Number(metaGet(db, KEY_WEIGHT) ?? WEIGHT_MAX);
  const decay = Number(metaGet(db, KEY_DECAY) ?? 0.01);
  return { retrievalWeight: clamp(weight, WEIGHT_MIN, WEIGHT_MAX), timeDecay: clamp(decay, 0.001, DECAY_MAX) };
}

/**
 * Update evolution params from the last sleep window's feedback stats.
 * `stats` = { recallCount, recallCorrections }.
 * Returns the new params and whether they changed.
 */
export function runEvolution(db, stats = {}) {
  const { recallCount = 0, recallCorrections = 0 } = stats;
  const current = loadEvolution(db);
  let changed = false;
  if (recallCount > 0) {
    const ratio = recallCorrections / recallCount;
    if (ratio >= CORRECTION_RATIO_TRIGGER) {
      const nextWeight = clamp(current.retrievalWeight - WEIGHT_STEP, WEIGHT_MIN, WEIGHT_MAX);
      const nextDecay = clamp(current.timeDecay + DECAY_STEP, 0.001, DECAY_MAX);
      if (nextWeight !== current.retrievalWeight || nextDecay !== current.timeDecay) {
        metaSet(db, KEY_WEIGHT, nextWeight);
        metaSet(db, KEY_DECAY, nextDecay);
        return { retrievalWeight: nextWeight, timeDecay: nextDecay, changed: true };
      }
    }
  }
  return { ...current, changed };
}

export { KEY_WEIGHT, KEY_DECAY };
