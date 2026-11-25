// lib/sleep.js — Nightly sleep metabolism for dsh-xiaofei-memory.
// PRD section 4.3: distill over-densified recent memories into core summaries,
// archive the originals, then VACUUM + FTS optimize to reclaim space.

import { addMemory, listLayerMemories, archiveMemory, vacuumAndOptimize, purgeArchived, isSeedMemoryId, withTransaction } from "./db.js";
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
export async function runNightlySleep(db, { summarize, layer = "recent", logger, archiveRetentionMs } = {}) {
  const stats = {
    distilledGroups: 0, distilledMemories: 0, archived: 0, vacuumed: false,
    threshold: 0, scanned: 0, skippedEntities: 0, skippedGroups: 0, details: [],
  };

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
    // One group is one unit: summary row + archives commit together, so an
    // exception can no longer leave a summary written while its originals
    // survive (duplicates) or originals archived with no summary (loss).
    const res = withTransaction(db, () => {
      const written = addMemory(db, {
        roleId,
        layer: "core",
        content,
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

export { DISTILL_MIN_THRESHOLD, DISTILL_RATIO, DISTILL_MAX_THRESHOLD, SUMMARY_MAX_CHARS };
