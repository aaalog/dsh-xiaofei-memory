// lib/correction.js — did the owner just tell us the recall was wrong?
//
// The damping machinery already existed, but nothing fed it: `correctionTools`
// defaults to an empty list, so `recallStats.corrections` could only ever be
// zero and no memory was ever damped. The plugin therefore looked like it had a
// self-correction loop while it had none — the review called it "a pie in the
// sky", and that was accurate.
//
// The owner's own words are the signal, and they cost nothing. False positives
// are cheap here on purpose: one relevant memory loses 15% of its strength and
// recovers fifteen minutes later. False negatives keep the loop dead, which is
// the failure we are fixing.

/** Phrases that mean "what you recalled is not what I said". */
const PATTERNS = [
  { reason: "misremembered", re: /记错|记混|搞错|搞混|弄错/ },
  { reason: "not-that-one", re: /不是(这个|那条|这条|它|他)|不对[，,、]?\s*是/ },
  { reason: "what-i-said", re: /我说的是|我说过的是|我的原话/ },
  { reason: "explicit-correction", re: /纠正一下|更正一下|更正为/ },
];

/**
 * @param {unknown} text the owner's message for this turn
 * @returns {{ hit: boolean, reason?: string }}
 */
export function detectCorrection(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { hit: false };
  for (const { reason, re } of PATTERNS) {
    if (re.test(raw)) return { hit: true, reason };
  }
  return { hit: false };
}
