// lib/sleep.js — Nightly sleep metabolism for dsh-xiaofei-memory.
// PRD section 4.3: distill over-densified recent memories into core summaries,
// archive the originals, then VACUUM + FTS optimize to reclaim space.

import { addMemory, listLayerMemories, listRecentByEntity, archiveMemory, vacuumAndOptimize, purgeArchived, isSeedMemoryId } from "./db.js";
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
export async function runNightlySleep(db, { summarize, layer = "recent", logger } = {}) {
  const stats = {
    distilledGroups: 0, distilledMemories: 0, archived: 0, vacuumed: false,
    threshold: 0, scanned: 0, skippedEntities: 0, details: [],
  };

  // Group recent memories by shared entity, ignoring noise entities.
  const groups = new Map(); // entity -> memories[]
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
    purgeArchived(db);
    vacuumAndOptimize(db);
    stats.vacuumed = true;
    logger?.info?.("dsh-xiaofei-memory: nightly sleep: distillation skipped (no summarizer), vacuum done");
    return stats;
  }

  for (const m of all) {
    for (const e of m.entities ?? []) {
      if (!isMeaningfulEntity(e)) continue;
      if (!groups.has(e)) groups.set(e, []);
      const arr = groups.get(e);
      if (arr.length <= 40) arr.push(m);
    }
  }

  for (const [entity, memories] of groups) {
    const unique = Array.from(new Map(memories.map((m) => [m.id, m])).values());
    if (unique.length <= threshold) { stats.skippedEntities++; continue; }
    const ids = unique.map((m) => m.id);
    // Build a distilled summary into core, then archive the originals.
    const texts = unique
      .slice()
      .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
      .slice(0, 8)
      .map((m) => m.content);
    let summary = null;
    if (typeof summarize === "function") {
      try { summary = await summarize(texts); } catch { /* heuristic fallback */ }
    }
    const content = normalizeContent(summary || heuristicSummary(texts));
    if (!content) continue;
    const res = addMemory(db, {
      roleId: unique[0].role_id ?? "global",
      layer: "core",
      content,
      entities: Array.from(new Set(unique.flatMap((m) => m.entities ?? []))).slice(0, 16),
      originIds: ids,
      strength: 1.0,
    });
    for (const id of ids) {
      // Never distil away the seeded soul memories.
      if (isSeedMemoryId(id)) continue;
      archiveMemory(db, id);
      stats.archived++;
    }
    stats.distilledGroups++;
    stats.distilledMemories += ids.length;
    stats.details.push({
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
  purgeArchived(db);
  vacuumAndOptimize(db);
  stats.vacuumed = true;
  return stats;
}

function heuristicSummary(texts) {
  const joined = texts.join("；");
  const chars = Array.from(joined);
  if (chars.length <= SUMMARY_MAX_CHARS) return joined;
  return chars.slice(0, SUMMARY_MAX_CHARS).join("") + "…";
}

export { DISTILL_MIN_THRESHOLD, DISTILL_RATIO, DISTILL_MAX_THRESHOLD, SUMMARY_MAX_CHARS };
