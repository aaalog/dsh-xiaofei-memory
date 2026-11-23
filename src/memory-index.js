// lib/memory-index.js — Progressive disclosure for always-on memory.
//
// The always-on block can only afford to carry the few highest-value memories
// in full. Everything else was previously invisible: if a memory did not fit
// the token budget it simply did not exist as far as the model was concerned.
//
// This adds a second, much cheaper tier: a compact catalogue of the memories
// that are *available* but not included. Each line carries just enough to
// decide whether the full text is worth fetching, and a tool call
// (memory_core_read) expands any entry on demand.
//
// The trade is deliberate and cheap: a catalogue line costs ~15-25 tokens,
// fetching a memory costs a tool round-trip. For a store with tens of memories
// that beats either extreme (dump everything, or show nothing).

import { tokenEstimate } from "./util.js";

const DEFAULT_INDEX_HEADER = "## 记忆索引\n以下记忆未展开。需要全文时调用 memory_core_read(id)。";
const BUDGET_SAFETY_TOKENS = 6;

/** Collapse whitespace and cut at a character boundary. */
function shorten(text, chars) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const arr = Array.from(flat);
  if (arr.length <= chars) return flat;
  return arr.slice(0, chars).join("") + "…";
}

/**
 * Short, human-readable handle for a memory id.
 *
 * Generated ids look like `mem_mw2v98qt_o21ky4`; the trailing segment is the
 * part a person (or the model) can match by eye, and the seeded ids are
 * already short. Both are accepted by the read tool.
 */
export function shortMemoryId(id) {
  const s = String(id ?? "");
  const lastUnderscore = s.lastIndexOf("_");
  if (lastUnderscore > 0 && s.length - lastUnderscore - 1 >= 4) return s.slice(lastUnderscore + 1);
  return s;
}

/**
 * Build the catalogue of memories that are not already shown in full.
 *
 * Ordering matches the full block (strength, recency, id) so the same state
 * always produces the same catalogue — a changing catalogue would invalidate
 * the prompt prefix on every request for no benefit.
 *
 * @returns {Array<{id:string, short:string, layer:string, title:string, chars:number}>}
 */
export function buildMemoryIndex(db, {
  roleIds = ["global"],
  excludeIds = [],
  maxTokens = 200,
  titleChars = 26,
  limit = 40,
  layers = ["core", "weekly"],
} = {}) {
  if (!db) return [];
  const roles = Array.isArray(roleIds) && roleIds.length > 0 ? roleIds : ["global"];
  const layerList = Array.isArray(layers) && layers.length > 0 ? layers : ["core", "weekly"];
  const rolePh = roles.map(() => "?").join(",");
  const layerPh = layerList.map(() => "?").join(",");

  let rows;
  try {
    rows = db.prepare(
      `SELECT id, layer, content, strength, created_at FROM memories
       WHERE status = 'active'
         AND role_id IN (${rolePh})
         AND layer IN (${layerPh})
       ORDER BY strength DESC, created_at DESC, id ASC
       LIMIT ?`
    ).all(...roles, ...layerList, Math.max(1, Math.min(200, Number(limit) || 40)));
  } catch {
    return [];
  }

  const skip = new Set((Array.isArray(excludeIds) ? excludeIds : []).map(String));
  const budget = Math.max(0, (Number(maxTokens) || 0) - BUDGET_SAFETY_TOKENS);
  const out = [];
  let used = 0;
  const cap = Math.max(8, Number(titleChars) || 26);

  for (const r of rows) {
    if (skip.has(String(r.id))) continue;
    const raw = typeof r.content === "string" ? r.content.trim() : "";
    if (!raw) continue;
    // Same guard as the full block: never surface our own injected wrapper.
    if (raw.includes("<memory-recall>")) continue;

    const line = `- [${r.layer}] ${shortMemoryId(r.id)} ${shorten(raw, cap)}`;
    const cost = tokenEstimate(line);
    if (cost <= 0) continue;
    if (used + cost > budget) break; // keep the catalogue a stable prefix

    out.push({
      id: String(r.id),
      short: shortMemoryId(r.id),
      layer: String(r.layer),
      title: shorten(raw, cap),
      chars: Array.from(raw).length,
    });
    used += cost;
  }
  return out;
}

/** Render the catalogue to the exact prompt text. */
export function renderMemoryIndex(entries, { header = DEFAULT_INDEX_HEADER } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  const lines = entries.map((e) => `- [${e.layer}] ${e.short} ${e.title}`);
  return `${header}\n${lines.join("\n")}`;
}

/** Stable signature so the cache only re-renders when the catalogue changes. */
export function memoryIndexSignature(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return entries.map((e) => `${e.id}:${e.chars}`).join("|");
}

/**
 * Resolve an id passed to the read tool.
 *
 * Accepts the full id, the short handle, or any unambiguous trailing suffix —
 * the model only ever sees the short handle, but a human may paste the full
 * one. Ambiguous suffixes resolve to null rather than guessing.
 */
/**
 * Resolve a memory id or short id to one active row.
 *
 * `roleIds` restricts the lookup to the caller's namespaces. Without it a short
 * id — six characters shown in the index — was enough to read any role's
 * memory in full, which defeats the namespace isolation the rest of the plugin
 * maintains.
 *
 * @param {any} db open database handle
 * @param {unknown} ref full id, or the short id printed in the index
 * @param {{ roleIds?: string[] }} [options]
 * @returns {any | null}
 */
export function resolveMemoryRef(db, ref, { roleIds } = {}) {
  const want = String(ref ?? "").trim();
  if (!want || !db) return null;
  const roles = Array.isArray(roleIds) && roleIds.length > 0 ? roleIds : null;
  const roleSql = roles ? ` AND role_id IN (${roles.map(() => "?").join(",")})` : "";
  const roleArgs = roles ?? [];
  try {
    const exact = db.prepare(
      `SELECT * FROM memories WHERE id = ? AND status = 'active'${roleSql}`
    ).get(want, ...roleArgs);
    if (exact) return exact;
    const rows = db.prepare(
      `SELECT * FROM memories WHERE status = 'active'${roleSql} AND id LIKE ? LIMIT 3`
    ).all(...roleArgs, `%${want}`);
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) {
      // Prefer an exact trailing-segment match over a loose substring hit.
      const exactTail = rows.filter((r) => shortMemoryId(r.id) === want);
      if (exactTail.length === 1) return exactTail[0];
    }
  } catch {
    /* fall through */
  }
  return null;
}

export { DEFAULT_INDEX_HEADER };
