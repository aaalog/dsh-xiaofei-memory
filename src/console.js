// lib/console.js — Management console data operations for dsh-xiaofei-memory.
// Host-half helpers backing the Web console: stats, search, nightly sleep.

import { searchMemories, metaGet, metaSet } from "./db.js";
import { retrieveForPrompt } from "./retrieval.js";
import { runNightlySleep } from "./sleep.js";
import { loadEvolution } from "./evolution.js";
import { selectCoreMemories, renderCoreMemory, CORE_MEMORY_SECTION_NAME, CORE_MEMORY_SECTION_ORDER } from "./core-memory.js";
import { buildMemoryIndex, renderMemoryIndex } from "./memory-index.js";
import { tokenEstimate, isMeaningfulEntity, parseJsonList } from "./util.js";

/** Every role namespace present in the store ("all roles" queries). */
function allRoleIds(db) {
  try {
    const roles = db.prepare("SELECT DISTINCT role_id FROM memories").all().map((r) => r.role_id);
    return roles.length > 0 ? roles : ["global"];
  } catch {
    return ["global"];
  }
}

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
  const roleIds = roleId && roleId !== "all" ? [roleId, "global"] : allRoleIds(db);
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
    roleIds: roleId && roleId !== "all" ? [roleId, "global"] : allRoleIds(db),
    enableGraphRecall: true,
    maxTokens,
    limit: 8,
    weight: loadEvolution(db).retrievalWeight,
  });
}

/** Manually run the nightly sleep pass. */
export async function triggerNightlySleep(db, { summarize, logger } = {}) {
  const stats = await runNightlySleep(db, { summarize, logger });
  metaSet(db, "meta.lastManualSleep", Date.now());
  return stats;
}

/**
 * Data for the memory-sea view: every active memory plus the entity links
 * between them.
 *
 * Links come from `entity_index`, which is the same table graph recall uses, so
 * what the picture shows is what the engine can actually traverse. Entities are
 * capped per memory because the extractor harvests many overlapping CJK
 * windows; without a cap a single memory would join every cluster.
 */
export function getMemoryGraph(db, { roleId = "all", limit = 300, entitiesPerMemory = 6 } = {}) {
  const roleIds = roleId && roleId !== "all" ? [roleId, "global"] : null;
  const where = roleIds
    ? `WHERE status = 'active' AND role_id IN (${roleIds.map(() => "?").join(",")})`
    : `WHERE status = 'active'`;
  const args = roleIds ?? [];
  let rows;
  try {
    rows = db.prepare(
      `SELECT id, role_id, layer, content, strength, created_at, entities
       FROM memories ${where}
       ORDER BY strength DESC, created_at DESC
       LIMIT ?`
    ).all(...args, Math.max(1, Math.min(500, Number(limit) || 300)));
  } catch {
    return { nodes: [], links: [], truncated: false };
  }

  const nodes = rows.map((r) => {
    const ents = parseJsonList(r.entities)
      .filter((e) => isMeaningfulEntity(e))
      .slice(0, Math.max(1, entitiesPerMemory));
    return {
      id: r.id,
      roleId: r.role_id,
      layer: r.layer,
      strength: Number(r.strength) || 0,
      createdAt: r.created_at,
      excerpt: String(r.content ?? "").replace(/\s+/g, " ").slice(0, 160),
      length: String(r.content ?? "").length,
      entities: ents,
    };
  });

  // One link per shared entity pair, weighted by how rare that entity is: a
  // shared rare entity is stronger evidence of relatedness than "Time".
  const byEntity = new Map();
  for (const n of nodes) {
    for (const e of n.entities) {
      if (!byEntity.has(e)) byEntity.set(e, []);
      byEntity.get(e).push(n.id);
    }
  }
  const links = [];
  const seen = new Set();
  for (const [entity, ids] of byEntity) {
    if (ids.length < 2 || ids.length > 12) continue; // skip singletons and hubs
    const weight = Number((1 / Math.log2(2 + ids.length)).toFixed(3));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: ids[i], target: ids[j], entity, weight });
      }
    }
  }

  return {
    nodes,
    links,
    truncated: rows.length >= limit,
    layers: nodes.reduce((acc, n) => { acc[n.layer] = (acc[n.layer] || 0) + 1; return acc; }, {}),
  };
}

/**
 * Render the always-on core memory exactly as the model sees it.
 *
 * This is the one view that answers "what does the model actually remember
 * right now?" — it reuses the same selection and rendering the prompt section
 * uses, so the page cannot drift from the real injection.
 */
export function previewCoreMemory(db, { roleId = "global", maxTokens = 650, maxItemChars = 300, minStrength = 1.0, enableIndex = true, indexMaxTokens = 200, indexLimit = 40 } = {}) {
  const roleIds = roleId && roleId !== "all" ? [roleId, "global"] : ["global"];
  const entries = selectCoreMemories(db, { roleIds, maxTokens, maxItemChars, minStrength });
  const indexEntries = enableIndex === false
    ? []
    : buildMemoryIndex(db, {
        roleIds,
        excludeIds: entries.map((e) => e.id),
        maxTokens: indexMaxTokens,
        limit: indexLimit,
      });
  const body = renderCoreMemory(entries);
  const index = renderMemoryIndex(indexEntries);
  const text = [body, index].filter(Boolean).join("\n\n");
  return {
    entries,
    indexEntries,
    text,
    tokens: tokenEstimate(text),
    bodyTokens: tokenEstimate(body),
    indexTokens: tokenEstimate(index),
    section: CORE_MEMORY_SECTION_NAME,
    order: CORE_MEMORY_SECTION_ORDER,
  };
}

/** Return the 10 soul seed memories (System tab). */
export function listSoulMemories(db) {
  // Generated ids are `mem_<ts36>_<rand>` and also start with `mem_`, so the
  // seed range must be matched explicitly rather than by prefix.
  const rows = db.prepare(
    "SELECT id, role_id, layer, content FROM memories WHERE id GLOB 'mem_0[0-9][0-9]' ORDER BY id ASC LIMIT 10"
  ).all();
  return rows;
}
