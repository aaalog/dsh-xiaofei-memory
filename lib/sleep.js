// lib/sleep.js — Nightly sleep metabolism for dsh-xiaofei-memory.
// PRD section 4.3: distill over-densified recent memories into core summaries,
// archive the originals, then VACUUM + FTS optimize to reclaim space.

import { addMemory, listLayerMemories, listRecentByEntity, archiveMemory, vacuumAndOptimize, purgeArchived } from "./db.js";
import { normalizeContent, extractEntities, tokenEstimate } from "./util.js";

const DISTILL_THRESHOLD = 10; // >10 same-entity recent memories triggers distillation
const SUMMARY_MAX_CHARS = 100;

/**
 * Run one nightly sleep pass. Returns a stats object.
 * `summarize` is an optional async (texts[]) => string | null LLM hook;
 * falls back to a deterministic heuristic when absent.
 */
export async function runNightlySleep(db, { summarize, layer = "recent" } = {}) {
  const stats = { distilledGroups: 0, distilledMemories: 0, archived: 0, vacuumed: false };

  // Group recent memories by shared entity.
  const groups = new Map(); // entity -> memories[]
  const all = listLayerMemories(db, layer);
  for (const m of all) {
    for (const e of m.entities ?? []) {
      if (!groups.has(e)) groups.set(e, []);
      const arr = groups.get(e);
      if (arr.length <= 40) arr.push(m);
    }
  }

  for (const [entity, memories] of groups) {
    const unique = Array.from(new Map(memories.map((m) => [m.id, m])).values());
    if (unique.length <= DISTILL_THRESHOLD) continue;
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
    for (const id of ids) archiveMemory(db, id);
    stats.distilledGroups++;
    stats.distilledMemories += ids.length;
    stats.archived += ids.length;
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

export { DISTILL_THRESHOLD, SUMMARY_MAX_CHARS };
