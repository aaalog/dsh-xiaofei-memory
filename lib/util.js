// lib/util.js — shared helpers for dsh-xiaofei-memory.
// Deterministic, dependency-free utilities used across the engine.

/** Generate a memory id: mem_<timestamp36>_<rand>. */
export function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Current epoch milliseconds. */
export function now() {
  return Date.now();
}

/** Whole days since a timestamp (rounded down). */
export function daysSince(ts) {
  return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
}

/**
 * Time decay factor: exp(-timeDecayFactor * days).
 * Mirrors the PRD: older memories fade, recent ones stay bright.
 */
export function timeDecay(createdAt, factor = 0.01) {
  return Math.exp(-factor * daysSince(createdAt));
}

/**
 * Rough token estimate for a text. CJK characters count ~1 token each,
 * Latin words ~1 token per whitespace token. Used for the 1200-token
 * injection budget and capture sizing.
 */
export function tokenEstimate(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  // CJK chars
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length;
  const latin = text
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + latin;
}

/**
 * Deterministic, cheap text similarity in [0,1] using bigram overlap.
 * Good enough for dedup and conflict detection without an embedding model.
 */
export function similarity(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  if (a.length === 0 || b.length === 0) return 0;
  const grams = (s) => {
    const set = new Set();
    const chars = Array.from(s);
    if (chars.length === 1) return new Set([chars[0]]);
    for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / Math.max(1, Math.min(ga.size, gb.size));
}

const QUOTED_RE = /["“”'‘’「」『』《》]([^"“”'‘’「」『』《》]{2,40})["“”'‘’「」『』《》]/g;
const LATIN_TERM_RE = /\b[A-Z][A-Za-z0-9_\-+.]{1,30}\b/g;

/**
 * Heuristic entity extraction: quoted phrases, capitalized Latin terms,
 * and stable CJK 2-4 char windows. Returns a de-duplicated array (<=16).
 */
export function extractEntities(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const set = new Set();
  let m;
  const add = (v) => {
    const t = String(v).trim();
    if (t.length >= 2 && t.length <= 40) set.add(t);
  };
  QUOTED_RE.lastIndex = 0;
  while ((m = QUOTED_RE.exec(text))) add(m[1]);
  LATIN_TERM_RE.lastIndex = 0;
  while ((m = LATIN_TERM_RE.exec(text))) add(m[0]);
  // CJK windows from runs of Han characters
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i < chars.length; i++) {
      for (let len = 2; len <= 4 && i + len <= chars.length; len++) {
        if (chars[i] === chars[i + len - 1] && len > 2) continue;
        add(chars.slice(i, i + len).join(""));
      }
    }
  }
  return Array.from(set).slice(0, 16);
}

/** Clamp a value into [min, max]. */
export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** Safe JSON parse of a column that may be null/undefined. */
export function parseJsonList(value) {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Stringify a list for a TEXT column (null when empty). */
export function toJsonList(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return JSON.stringify(list);
}

/** Normalize a memory content string. */
export function normalizeContent(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
