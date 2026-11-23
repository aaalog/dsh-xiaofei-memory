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
 * Hard ceiling on what one memory row may hold. Capture is indiscriminate, and
 * a long row costs three times over: it is truncated to 300 chars when the
 * always-on block renders it, it inflates every FTS row, and the LIKE fallback
 * scans it whole. 400 characters is more than any distilled fact needs.
 */
export const MAX_MEMORY_CHARS = 400;

/**
 * Credential-shaped text must not reach the store. The memory database is a
 * plain SQLite file and the injection paths paste rows straight into prompts;
 * a pasted deploy note once carried a literal delivery password into the
 * always-on core block, where it was replayed to the model every turn.
 *
 * Deliberately narrow: the separator is mandatory, so a genuine discussion of
 * 密码学 or "the password field" survives while an assigned value does not.
 */
const SECRET_PATTERNS = [
  /((?:密码|口令|password|passwd|pwd)\s*(?:[:：=]|是|为)\s*)[^\s，。；,;]{4,}/gi,
  // English copula, kept separate so the CJK rule stays tight around 是/为.
  /((?:password|passwd|pwd)\s+(?:is|are)\s+)[^\s,;]{4,}/gi,
  /((?:api[_-]?key|apikey|token|secret|access[_-]?key)\s*[:：=]\s*)[A-Za-z0-9_\-.]{8,}/gi,
  /\bsk-[A-Za-z0-9]{10,}\b/g,
  // One-time verification codes: worthless as a memory, a live credential while
  // they last. The separator is optional because "验证码 8899" is the common form,
  // but the value must be latin/digits — otherwise "验证码五分钟内有效" matches.
  /((?:验证码|校验码|动态码|verification\s+code|otp)\s*(?:[:：=]|是|为|is)?\s*)[A-Za-z0-9]{4,8}\b/gi,
  // Authorization headers, with or without the header name.
  /((?:authorization\s*[:：]\s*)(?:bearer|basic|token)\s+)[A-Za-z0-9._\-+/=]{8,}/gi,
  /\bbearer\s+[A-Za-z0-9._\-+/=]{16,}/gi,
];

/**
 * Replace credential values with `***`, keeping the surrounding sentence so
 * the fact itself ("投递密码是***") stays readable and searchable.
 */
export function scrubSecrets(text) {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix) => (typeof prefix === "string" ? prefix + "***" : "***"));
  }
  return out;
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

/** Bigram set of a string (a single character is its own gram). */
function bigrams(s) {
  const set = new Set();
  const chars = Array.from(s);
  if (chars.length === 1) return new Set([chars[0]]);
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
  return set;
}

/**
 * Deterministic, cheap text similarity in [0,1] using bigram overlap.
 * Good enough for dedup and conflict detection without an embedding model.
 *
 * The denominator is `min(|a|,|b|)` — "how much of the shorter text appears in
 * the longer one". That is what dedup/conflict detection wants, but it is the
 * wrong signal for ranking a short query against a long memory: two shared
 * common bigrams can look like a 0.6 match. Retrieval uses queryCoverage().
 */
export function similarity(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  if (a.length === 0 || b.length === 0) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / Math.max(1, Math.min(ga.size, gb.size));
}

/**
 * Query coverage in [0,1]: the share of the QUERY's bigrams that appear in the
 * document. The denominator is the query, so a long memory cannot inflate the
 * score and an unrelated query scores ~0. This is the ranking signal retrieval
 * uses, and the quantity the relevance floor is expressed in.
 */
export function queryCoverage(query, doc) {
  if (typeof query !== "string" || typeof doc !== "string") return 0;
  if (query.length === 0 || doc.length === 0) return 0;
  const gq = bigrams(query);
  const gd = bigrams(doc);
  if (gq.size === 0 || gd.size === 0) return 0;
  let inter = 0;
  for (const g of gq) if (gd.has(g)) inter++;
  return inter / gq.size;
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
/**
 * Entities that carry no grouping signal.
 *
 * extractEntities() slides a window over Han runs and also captures Latin
 * terms, so ordinary prose yields tokens like "Time", "Browser", "Asia" or
 * "目前" alongside real entities. Grouping distillation by those would merge
 * unrelated memories, so they are filtered before grouping.
 *
 * Deliberately conservative: only well-known calendar/locale/time words and
 * pure boilerplate are dropped. Identifiers such as "dsh-xiaofei-memory"
 * or "SQLite" are meaningful and are kept.
 */
const NOISE_ENTITIES = new Set([
  // calendar / clock
  "time", "date", "day", "today", "tomorrow", "yesterday", "now", "utc", "gmt",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "am", "pm", "week", "month", "year", "hour", "minute", "second",
  // client / platform boilerplate
  "browser", "user", "agent", "system", "message", "messages", "ok", "error",
  "http", "https", "html", "json", "true", "false", "null", "undefined",
  // timezone / region noise seen in this store
  "asia", "shanghai", "china", "beijing", "utf", "browser time zone",
  // common CJK filler captured by the 2-4 char window
  "目前", "然后", "这个", "那个", "可以", "需要", "如果", "因为", "所以",
  "这样", "那样", "我们", "你们", "他们", "什么", "怎么", "还有", "已经",
  // Measured on the live store (2026-11-21): these were still ranking as
  // entities after the first pass — 现在 alone held 25 links and 好的/继续
  // survived on filler turns. Time adverbs and bare acknowledgements carry no
  // retrieval signal, so they stay out of the graph.
  "现在", "刚才", "之前", "之后", "后来", "一下", "看看", "好的", "继续",
  // "elapsed" leaked in through the runtime trailer before it was stripped
  // (see INJECTED_TAIL in capture.js); kept here as a second line of defence
  // so any record captured by an older build cannot keep a graph node alive.
  "elapsed", "preceding",
]);

/**
 * Whether an extracted entity is worth grouping by.
 *
 * @param {unknown} entity
 * @returns {boolean}
 */
export function isMeaningfulEntity(entity) {
  if (typeof entity !== "string") return false;
  const t = entity.trim().toLowerCase();
  if (t.length < 2) return false;
  if (NOISE_ENTITIES.has(t)) return false;
  // Reject pure punctuation / digits / separators.
  if (!/[\p{L}\p{N}]/u.test(t)) return false;
  // Bare 2-char Latin tokens are almost always fragments ("in", "of", "to").
  if (/^[a-z]{1,2}$/.test(t)) return false;
  return true;
}

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
