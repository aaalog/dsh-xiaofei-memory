// lib/sleep.js — Nightly sleep metabolism for dsh-xiaofei-memory.
// PRD section 4.3: distill over-densified recent memories into core summaries,
// archive the originals, then VACUUM + FTS optimize to reclaim space.

import { addMemory, listLayerMemories, archiveMemory, vacuumAndOptimize, purgeArchived, isSeedMemoryId, withTransaction } from "./db.js";
import { claimLease, releaseLease } from "./lease.js";
import { normalizeContent, extractEntities, tokenEstimate, isMeaningfulEntity } from "./util.js";

// A fixed threshold of 10 never fires: real stores hold a handful of memories
// per entity, so the nightly pass only ever vacuumed. The effective threshold is
// proportional to how much is actually in the layer, clamped to a sane range.
const DISTILL_MIN_THRESHOLD = 3;
const DISTILL_RATIO = 0.15;
const DISTILL_MAX_THRESHOLD = 10;
const SUMMARY_MAX_CHARS = 100;

/**
 * Effective distill threshold for a layer of `size` active memories.
 * Small layers distill eagerly; large ones keep the original ceiling.
 */
export function distillThreshold(size) {
  const scaled = Math.ceil(size * DISTILL_RATIO);
  return Math.min(DISTILL_MAX_THRESHOLD, Math.max(DISTILL_MIN_THRESHOLD, scaled || DISTILL_MIN_THRESHOLD));
}

/**
 * Run one nightly sleep pass. Returns a stats object.
 * `summarize` is an optional async (texts[]) => string | null LLM hook;
 * falls back to a deterministic heuristic when absent.
 */
/** Phrases that mean the model explained why it could not do the job. */
const REFUSAL_PATTERNS = [
  /无法(?:准确)?(?:压缩|概括|总结|提炼)/,
  /(?:建议|请|需要)(?:补充|提供)(?:更)?(?:完整|详细|更多)/,
  /需要(?:更多|补充).{0,6}(?:信息|上下文|内容)/,
  /(?:内容|信息)(?:并)?不完整/,
  /(?:抱歉|对不起)/,
  /作为(?:一个|一名)?\s*(?:AI|人工智能|语言模型)/i,
  /(?:i'?m sorry|i am sorry|cannot|can'?t|unable to|as an ai\b)/i,
];

/** Self-reference to the instruction rather than the material. */
const META_PATTERNS = [/不超过\s*\d+\s*字/, /压缩成(?:一句|一段)要点/];

/** Character bigrams of the CJK text plus latin words of 3+ characters. */
function contentGrams(text) {
  const s = String(text ?? "");
  const set = new Set();
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let i = 0; i + 2 <= cjk.length; i++) set.add(cjk.slice(i, i + 2));
  for (const word of s.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? []) set.add(word);
  return set;
}

/**
 * Decide whether a summariser reply is a memory at all.
 *
 * Distillation writes its output into `core` and archives the rows it came
 * from, so a bad reply is not a wasted call — it becomes a permanent memory and
 * takes an index line. A flood of such rows pushes real memories out of the
 * catalogue.
 *
 * The first failure this caught was a refusal: "由于涉及多个记忆条目且部分内容
 * 不完整，无法准确压缩…" was stored as a summary. A refusal is the model talking
 * about the task, not about the subject, and must never be stored.
 *
 * @param {unknown} text the summariser reply
 * @param {string[]} sources the rows the summary was made from
 * @returns {{ ok: boolean, text?: string, reason?: string }}
 */
export function acceptSummary(text, sources, { minChars = 12, maxChars = 120 } = {}) {
  const raw = String(text ?? "").trim().replace(/^["'“”「」\s]+|["'“”「」\s]+$/g, "");
  if (!raw) return { ok: false, reason: "empty" };
  for (const pattern of REFUSAL_PATTERNS) if (pattern.test(raw)) return { ok: false, reason: "refusal" };
  for (const pattern of META_PATTERNS) if (pattern.test(raw)) return { ok: false, reason: "meta" };
  if (/[?？]\s*$/.test(raw)) return { ok: false, reason: "question" };

  let out = raw;
  if (Array.from(out).length > maxChars) {
    const chars = Array.from(out);
    const head = chars.slice(0, maxChars + 1).join("");
    // Cut at a sentence boundary when there is one in range; never mid-word.
    const cut = Math.max(
      head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("；"), head.lastIndexOf("，"),
    );
    out = cut >= minChars ? head.slice(0, cut + 1) : chars.slice(0, maxChars).join("");
    // The sentence boundary can sit at maxChars, which yields maxChars+1 after
    // including the punctuation; clamp so the limit is a real limit.
    if (Array.from(out).length > maxChars) out = Array.from(out).slice(0, maxChars).join("");
  }
  const length = Array.from(out).length;
  if (length < minChars) return { ok: false, reason: "too-short" };

  // No shared content means the reply is about something other than the input:
  // the summary says nothing the rows did not, which makes it noise.
  const mine = contentGrams(out);
  if (mine.size === 0) return { ok: false, reason: "no-content" };
  let overlaps = false;
  for (const source of Array.isArray(sources) ? sources : []) {
    for (const gram of contentGrams(source)) {
      if (mine.has(gram)) { overlaps = true; break; }
    }
    if (overlaps) break;
  }
  if (!overlaps) return { ok: false, reason: "no-overlap" };

  return { ok: true, text: out };
}

export const SLEEP_LEASE_KEY = "meta.sleepLease";
const SLEEP_LEASE_MS = 6 * 60 * 60 * 1000;

export async function runNightlySleep(db, {
  summarize, layer = "recent", logger, archiveRetentionMs,
  /** Take the cross-process lease for this pass. */
  lease = false,
} = {}) {
  const stats = {
    distilledGroups: 0, distilledMemories: 0, archived: 0, vacuumed: false,
    threshold: 0, scanned: 0, skippedEntities: 0, skippedGroups: 0, details: [],
    /** Replies rejected by the acceptance gate (not stored, originals kept). */
    rejectedGroups: 0, rejections: [],
  };

  // One pass per night, whichever channel asked for it. A manual run used to
  // bypass the lease, so a click during the 03:00 pass ran both.
  if (lease && !claimLease(db, SLEEP_LEASE_KEY, SLEEP_LEASE_MS)) {
    logger?.info?.("dsh-xiaofei-memory: nightly sleep already claimed by another process; skipping");
    return { ...stats, skipped: "leased" };
  }
  try {
    return await runPass(stats);
  } finally {
    // Released even when the pass throws: a lease held for its full six hours
    // would suppress the next night's run.
    if (lease) releaseLease(db, SLEEP_LEASE_KEY);
  }

  async function runPass(stats) {

  // Group recent memories by (role, shared entity), ignoring noise entities.
  //
  // The role half of the key is load-bearing. `listLayerMemories` returns the
  // whole layer, so keying by entity alone mixed one role's memories into
  // another's: the summariser was fed text from both, the summary was written
  // into whichever role happened to sort first, and the other role's originals
  // were archived and then physically purged. That is a namespace leak and a
  // permanent data loss in the same step.
  const groups = new Map(); // `${roleId}\u0000${entity}` -> { roleId, entity, memories[] }
  const all = listLayerMemories(db, layer);
  stats.scanned = all.length;
  const threshold = distillThreshold(all.length);
  stats.threshold = threshold;

  // Distillation replaces a group of memories with ONE summary and then purges
  // the originals. A deterministic truncation is not a summary, so without an
  // LLM summarizer this pass would destroy more information than it creates.
  // Skip it entirely; the vacuum below still reclaims space.
  const canDistill = typeof summarize === "function";
  stats.distillSkipped = canDistill ? null : "no-summarizer";
  if (!canDistill) {
    purgeArchived(db, archiveRetentionMs === undefined ? {} : { retentionMs: archiveRetentionMs });
    vacuumAndOptimize(db);
    stats.vacuumed = true;
    logger?.info?.("dsh-xiaofei-memory: nightly sleep: distillation skipped (no summarizer), vacuum done");
    return stats;
  }

  for (const m of all) {
    const roleId = m.role_id ?? "global";
    for (const e of m.entities ?? []) {
      if (!isMeaningfulEntity(e)) continue;
      const key = roleId + "\u0000" + e;
      if (!groups.has(key)) groups.set(key, { roleId, entity: e, memories: [] });
      const g = groups.get(key);
      if (g.memories.length <= 40) g.memories.push(m);
    }
  }

  // A memory usually carries several entities, so the same rows can land in
  // several groups. Once a group has been distilled its rows are archived;
  // skipping archived ids keeps the second group from writing a duplicate
  // summary and from double-counting `archived`.
  const archivedIds = new Set();

  for (const { roleId, entity, memories } of groups.values()) {
    const unique = Array.from(new Map(memories.map((m) => [m.id, m])).values())
      .filter((m) => !archivedIds.has(m.id));
    if (unique.length <= threshold) { stats.skippedEntities++; continue; }
    // Defence in depth: the key already scopes the group to one role, but a row
    // whose role_id changed mid-pass would still poison the summary.
    if (unique.some((m) => (m.role_id ?? "global") !== roleId)) { stats.skippedEntities++; continue; }
    // Summarise and archive the SAME slice. The summariser is fed at most eight
    // rows, so archiving the whole group deleted twelve rows per group whose
    // text never reached the summary - "eight in, twenty out". The remainder
    // stays in the layer and comes back next night, which makes distillation
    // progressive instead of lossy.
    const summarised = unique
      .slice()
      .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
      .slice(0, 8);
    const ids = summarised.map((m) => m.id);
    const texts = summarised.map((m) => m.content);
    let summary = null;
    if (typeof summarize === "function") {
      try { summary = await summarize(texts); } catch { /* skip this group */ }
    }
    // A summary that did not come back must NOT fall back to a truncation: the
    // originals are archived and then physically purged below, so a lossy
    // stand-in would destroy more than it preserves. Skip the group instead.
    // Accept only a string. A non-string (an object, or a provider that returns
    // a structured reply) would be coerced to "[object Object]" by
    // normalizeContent, pass the emptiness check, and then the originals would
    // be archived and purged in favour of garbage.
    const content = typeof summary === "string" ? normalizeContent(summary) : "";
    if (!content) {
      stats.skippedGroups++;
      logger?.warn?.(`dsh-xiaofei-memory: distillation skipped "${entity}" (${ids.length} memories): summarizer returned no usable text`);
      continue;
    }
    // Output acceptance. A reply that is a refusal, a meta-comment, a question,
    // or has no content in common with what it summarised is not a memory. The
    // group is left untouched — nothing written, nothing archived — so the rows
    // come back next night instead of being replaced by noise.
    const verdict = acceptSummary(content, texts);
    if (!verdict.ok) {
      stats.rejectedGroups++;
      stats.rejections.push({ entity, roleId, reason: verdict.reason, chars: Array.from(content).length });
      stats.skippedGroups++;
      logger?.warn?.(`dsh-xiaofei-memory: distillation rejected "${entity}" (${ids.length} memories): ${verdict.reason}`);
      continue;
    }
    // One group is one unit: summary row + archives commit together, so an
    // exception can no longer leave a summary written while its originals
    // survive (duplicates) or originals archived with no summary (loss).
    const res = withTransaction(db, () => {
      const written = addMemory(db, {
        roleId,
        layer: "core",
        content: verdict.text,
        entities: Array.from(new Set(unique.flatMap((m) => m.entities ?? []))).slice(0, 16),
        originIds: ids,
        strength: 1.0,
        // The summary must be its own row: merging it into a row from `ids` used
        // to hand back that id, which the archive loop then archived and purged.
        noMerge: true,
      });
      for (const id of ids) {
        // Never distil away the seeded soul memories, and never archive the row
        // the summary landed in (only reachable if `noMerge` is ever lost).
        if (isSeedMemoryId(id) || id === written?.id) continue;
        archiveMemory(db, id);
        archivedIds.add(id);
        stats.archived++;
      }
      return written;
    });
    stats.distilledGroups++;
    stats.distilledMemories += ids.length;
    stats.details.push({
      roleId,
      entity,
      count: ids.length,
      summary: content.slice(0, SUMMARY_MAX_CHARS),
      newId: res?.id ?? null,
      merged: res?.merged ?? false,
    });
    logger?.info?.(
      `dsh-xiaofei-memory: distilled "${entity}" (${ids.length} memories -> ${res?.merged ? "merged" : "new"} ${String(res?.id ?? "?").slice(-6)}): ${content.slice(0, 60)}`
    );
  }

  // Reclaim physical space for archived/soft-deleted rows.
  purgeArchived(db, archiveRetentionMs === undefined ? {} : { retentionMs: archiveRetentionMs });
  vacuumAndOptimize(db);
  stats.vacuumed = true;
  return stats;
  }
}

export { DISTILL_MIN_THRESHOLD, DISTILL_RATIO, DISTILL_MAX_THRESHOLD, SUMMARY_MAX_CHARS };
