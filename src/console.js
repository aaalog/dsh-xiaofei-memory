// lib/console.js — Management console data operations for dsh-xiaofei-memory.
// Host-half helpers backing the Web console: stats, search, nightly sleep.

import { searchMemories, metaGet, metaSet } from "./db.js";
import { retrieveForPrompt } from "./retrieval.js";
import { runNightlySleep } from "./sleep.js";
import { loadEvolution } from "./evolution.js";

/** Count active memories grouped by layer and by role_id. */
export function getMemoryStats(db) {
  const byLayer = { core: 0, weekly: 0, recent: 0 };
  const byRole = {};
  const layerRows = db.prepare(
    "SELECT layer, COUNT(*) AS n FROM memories WHERE status='active' GROUP BY layer"
  ).all();
  for (const r of layerRows) byLayer[r.layer] = r.n;
  const roleRows = db.prepare(
    "SELECT role_id, COUNT(*) AS n FROM memories WHERE status='active' GROUP BY role_id"
  ).all();
  for (const r of roleRows) byRole[r.role_id] = r.n;
  return {
    total: Object.values(byLayer).reduce((a, b) => a + b, 0),
    byLayer,
    byRole,
    evolution: loadEvolution(db),
  };
}

/** Search memories, returning scored results (no token assembly). */
export function searchMemory(db, { query, roleId = "global", limit = 12, decay = 0.01 }) {
  const roleIds = roleId && roleId !== "all" ? [roleId, "global"] : ["global"];
  const rows = searchMemories(db, query, roleIds, { decay, limit });
  return rows.map((r) => ({
    id: r.id,
    roleId: r.role_id,
    layer: r.layer,
    content: r.content,
    strength: r.strength,
    createdAt: r.created_at,
    score: r._score,
    similarity: r._sim,
    entities: r.entities ?? [],
  }));
}

/** Build a recall text for a query (for console preview). */
export function previewRecall(db, { query, roleId = "global", maxTokens = 1200 }) {
  return retrieveForPrompt(db, {
    query,
    roleIds: roleId && roleId !== "all" ? [roleId, "global"] : ["global"],
    enableGraphRecall: true,
    maxTokens,
    limit: 8,
  });
}

/** Manually run the nightly sleep pass. */
export async function triggerNightlySleep(db, { summarize } = {}) {
  const stats = await runNightlySleep(db, { summarize });
  metaSet(db, "meta.lastManualSleep", Date.now());
  return stats;
}

/** Return the 10 soul seed memories (System tab). */
export function listSoulMemories(db) {
  const rows = db.prepare(
    "SELECT id, role_id, layer, content FROM memories WHERE id LIKE 'mem_%' ORDER BY id ASC LIMIT 10"
  ).all();
  return rows;
}
