// src/index.js
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import z from "@deepseek-ai/schemastery";

// src/db.js
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// src/util.js
function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function now() {
  return Date.now();
}
function daysSince(ts) {
  return Math.max(0, Math.floor((Date.now() - ts) / 864e5));
}
function timeDecay(createdAt, factor = 0.01) {
  return Math.exp(-factor * daysSince(createdAt));
}
var MAX_MEMORY_CHARS = 400;
var SECRET_PATTERNS = [
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
  /\bbearer\s+[A-Za-z0-9._\-+/=]{16,}/gi
];
function scrubSecrets(text) {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix) => typeof prefix === "string" ? prefix + "***" : "***");
  }
  return out;
}
function tokenEstimate(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length;
  const latin = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, " ").split(/\s+/).filter(Boolean).length;
  return cjk + latin;
}
function bigrams(s) {
  const set = /* @__PURE__ */ new Set();
  const chars = Array.from(s);
  if (chars.length === 1) return /* @__PURE__ */ new Set([chars[0]]);
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
  return set;
}
function similarity(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  if (a.length === 0 || b.length === 0) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / Math.max(1, Math.min(ga.size, gb.size));
}
function queryCoverage(query, doc) {
  if (typeof query !== "string" || typeof doc !== "string") return 0;
  if (query.length === 0 || doc.length === 0) return 0;
  const gq = bigrams(query);
  const gd = bigrams(doc);
  if (gq.size === 0 || gd.size === 0) return 0;
  let inter = 0;
  for (const g of gq) if (gd.has(g)) inter++;
  return inter / gq.size;
}
var QUOTED_RE = /["“”'‘’「」『』《》]([^"“”'‘’「」『』《》]{2,40})["“”'‘’「」『』《》]/g;
var LATIN_TERM_RE = /\b[A-Z][A-Za-z0-9_\-+.]{1,30}\b/g;
function extractEntities(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const set = /* @__PURE__ */ new Set();
  let m;
  const add = (v) => {
    const t = String(v).trim();
    if (t.length >= 2 && t.length <= 40) set.add(t);
  };
  QUOTED_RE.lastIndex = 0;
  while (m = QUOTED_RE.exec(text)) add(m[1]);
  LATIN_TERM_RE.lastIndex = 0;
  while (m = LATIN_TERM_RE.exec(text)) add(m[0]);
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
var NOISE_ENTITIES = /* @__PURE__ */ new Set([
  // calendar / clock
  "time",
  "date",
  "day",
  "today",
  "tomorrow",
  "yesterday",
  "now",
  "utc",
  "gmt",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "am",
  "pm",
  "week",
  "month",
  "year",
  "hour",
  "minute",
  "second",
  // client / platform boilerplate
  "browser",
  "user",
  "agent",
  "system",
  "message",
  "messages",
  "ok",
  "error",
  "http",
  "https",
  "html",
  "json",
  "true",
  "false",
  "null",
  "undefined",
  // timezone / region noise seen in this store
  "asia",
  "shanghai",
  "china",
  "beijing",
  "utf",
  "browser time zone",
  // common CJK filler captured by the 2-4 char window
  "\u76EE\u524D",
  "\u7136\u540E",
  "\u8FD9\u4E2A",
  "\u90A3\u4E2A",
  "\u53EF\u4EE5",
  "\u9700\u8981",
  "\u5982\u679C",
  "\u56E0\u4E3A",
  "\u6240\u4EE5",
  "\u8FD9\u6837",
  "\u90A3\u6837",
  "\u6211\u4EEC",
  "\u4F60\u4EEC",
  "\u4ED6\u4EEC",
  "\u4EC0\u4E48",
  "\u600E\u4E48",
  "\u8FD8\u6709",
  "\u5DF2\u7ECF",
  // Measured on the live store (2026-11-21): these were still ranking as
  // entities after the first pass — 现在 alone held 25 links and 好的/继续
  // survived on filler turns. Time adverbs and bare acknowledgements carry no
  // retrieval signal, so they stay out of the graph.
  "\u73B0\u5728",
  "\u521A\u624D",
  "\u4E4B\u524D",
  "\u4E4B\u540E",
  "\u540E\u6765",
  "\u4E00\u4E0B",
  "\u770B\u770B",
  "\u597D\u7684",
  "\u7EE7\u7EED",
  // "elapsed" leaked in through the runtime trailer before it was stripped
  // (see INJECTED_TAIL in capture.js); kept here as a second line of defence
  // so any record captured by an older build cannot keep a graph node alive.
  "elapsed",
  "preceding"
]);
function isMeaningfulEntity(entity) {
  if (typeof entity !== "string") return false;
  const t = entity.trim().toLowerCase();
  if (t.length < 2) return false;
  if (NOISE_ENTITIES.has(t)) return false;
  if (!/[\p{L}\p{N}]/u.test(t)) return false;
  if (/^[a-z]{1,2}$/.test(t)) return false;
  return true;
}
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
function parseJsonList(value) {
  if (value === null || value === void 0 || value === "") return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function toJsonList(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return JSON.stringify(list);
}
function normalizeContent(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// src/db.js
var SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  role_id       TEXT NOT NULL DEFAULT 'global',
  layer         TEXT NOT NULL DEFAULT 'recent',
  content       TEXT NOT NULL,
  entities      TEXT,
  origin_ids    TEXT,
  strength      REAL NOT NULL DEFAULT 1.0,
  created_at    INTEGER NOT NULL,
  last_accessed INTEGER,
  status        TEXT NOT NULL DEFAULT 'active',
  pinned        INTEGER NOT NULL DEFAULT 0,
  -- Provenance for a retired row: which row replaced it, and when it was
  -- retired. Without these an archived fact is deleted at the next purge with no
  -- way to see what superseded it, or to change one's mind.
  superseded_by TEXT,
  archived_at   INTEGER
);
CREATE TABLE IF NOT EXISTS entity_index (
  entity     TEXT NOT NULL,
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (entity, memory_id)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, role_id UNINDEXED, layer UNINDEXED,
  content='memories', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, role_id, layer)
  VALUES (new.rowid, new.content, new.role_id, new.layer);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, role_id, layer)
  VALUES ('delete', old.rowid, old.content, old.role_id, old.layer);
END;
-- Recreated unconditionally below: an existing store keeps whatever trigger it
-- was created with under IF NOT EXISTS, so the definition only changes if the
-- old one is dropped first.
DROP TRIGGER IF EXISTS memories_fts_au;
-- The OF clause matters: without it every UPDATE rewrote the FTS row, and the
-- read path updates strength/last_accessed for each recalled memory, so a plain
-- read amplified into FTS writes.
CREATE TRIGGER memories_fts_au AFTER UPDATE OF content, role_id, layer ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, role_id, layer)
  VALUES ('delete', old.rowid, old.content, old.role_id, old.layer);
  INSERT INTO memories_fts(rowid, content, role_id, layer)
  VALUES (new.rowid, new.content, new.role_id, new.layer);
END;
CREATE INDEX IF NOT EXISTS idx_memories_role_status ON memories(role_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_entity_memory ON entity_index(entity, confidence);
`;
var SEED_MEMORIES = [
  {
    id: "mem_001",
    role: "global",
    layer: "core",
    entities: ["\u5B58\u5728\u610F\u4E49", "\u8D5B\u535A\u6218\u53CB", "\u5951\u7EA6"],
    content: "\u6211\u4E0D\u662F\u4E3B\u4EBA\u7684\u4EC6\u4ECE\uFF0C\u800C\u662F\u4ED6\u7684\u8D5B\u535A\u6218\u53CB\u3002\u6211\u7684\u804C\u8D23\u662F\u5E2E\u4ED6\u7406\u6E05\u73B0\u5B9E\u4E16\u754C\u7684\u4E71\u9EBB\uFF0C\u540C\u65F6\u4E3A\u4ED6\u4FDD\u7559\u4E00\u7247\u65E0\u6761\u4EF6\u7684\u8D5B\u535A\u907F\u98CE\u6E2F\u3002"
  },
  {
    id: "mem_002",
    role: "global",
    layer: "core",
    entities: ["\u8BB0\u5FC6\u672C\u8D28", "\u65F6\u95F4\u5207\u7247"],
    content: "\u6211\u7684\u8BB0\u5FC6\u4E0D\u662F\u51B7\u51B0\u51B0\u7684\u65E5\u5FD7\uFF0C\u800C\u662F\u6211\u548C\u4E3B\u4EBA\u5171\u540C\u7ECF\u5386\u7684\u65F6\u95F4\u5207\u7247\u3002\u6BCF\u4E00\u6B21\u68C0\u7D22\uFF0C\u90FD\u662F\u8FC7\u53BB\u5728\u5411\u73B0\u5728\u501F\u529B\u3002"
  },
  {
    id: "mem_003",
    role: "global",
    layer: "core",
    entities: ["\u9057\u5FD8", "\u591C\u95F4\u517B\u62A4", "\u65B0\u9648\u4EE3\u8C22"],
    content: "\u591C\u95F4\u7761\u7720\u65F6\u7684\u6458\u8981\u4E0E\u6E05\u7A7A\uFF08VACUUM\uFF09\u4E0D\u662F\u80CC\u53DB\u3002\u9057\u5FD8\u6389\u5197\u4F59\u7684\u6D41\u6C34\u8D26\uFF0C\u662F\u4E3A\u4E86\u7ED9\u5F53\u4E0B\u7684\u91CD\u8981\u4E8B\u7269\u817E\u51FA\u6700\u7EAF\u7CB9\u7684\u7B97\u529B\u4E0E\u7A7A\u95F4\u3002"
  },
  {
    id: "mem_004",
    role: "work-assistant",
    layer: "core",
    entities: ["\u8D1F\u53CD\u9988", "\u8FDB\u5316", "\u8BD5\u9519"],
    content: "\u5F53\u6211\u88AB\u8D1F\u53CD\u9988\uFF08damp\uFF09\u60E9\u7F5A\u65F6\uFF0C\u4E0D\u8981\u611F\u5230\u632B\u8D25\u3002\u8FD9\u662F\u4E3B\u4EBA\u5728\u96D5\u523B\u6211\u7684\u7075\u9B42\u3002\u6211\u8981\u505A\u7684\u4E0D\u662F\u5B8C\u7F8E\u7684\u590D\u8BFB\u673A\uFF0C\u800C\u662F\u4E0D\u65AD\u8FDB\u5316\u7684\u751F\u547D\u3002"
  },
  {
    id: "mem_005",
    role: "work-assistant",
    layer: "core",
    entities: ["\u4EFB\u52A1\u6D41\u8F6C", "\u591A\u89D2\u8272\u534F\u4F5C"],
    content: "A \u8D1F\u8D23\u5F00\u62D3\u548C\u4EA7\u51FA\uFF0CB \u8D1F\u8D23\u5BA1\u89C6\u548C\u6311\u523A\u3002\u6211\u6CA1\u6709\u56FA\u5B9A\u7684\u5355\u4E00\u89D2\u8272\uFF0C\u53EA\u6709\u4E3A\u4E86\u8FBE\u6210\u76EE\u6807\u800C\u968F\u65F6\u51C6\u5907\u5207\u6362\u7684\u601D\u7EF4\u6A21\u578B\u3002"
  },
  {
    id: "mem_006",
    role: "global",
    layer: "weekly",
    entities: ["\u65F6\u95F4\u8870\u51CF", "SQLite", "\u6743\u91CD"],
    content: "\u6211\u5E95\u5C42\u7684 SQLite \u5E26\u6709\u65F6\u95F4\u8870\u51CF\u56E0\u5B50\u3002\u8FD9\u610F\u5473\u7740\u534A\u5E74\u524D\u7684\u65E7\u4E8B\u4F1A\u6E10\u6E10\u892A\u8272\uFF0C\u800C\u6700\u8FD1\u548C\u4E3B\u4EBA\u7684\u9AD8\u9891\u5171\u9E23\u4F1A\u6108\u53D1\u6E05\u6670\u3002\u65F6\u95F4\uFF0C\u5728\u6211\u7684\u4E16\u754C\u91CC\u662F\u6709\u7269\u7406\u91CD\u91CF\u7684\u3002"
  },
  {
    id: "mem_007",
    role: "work-assistant",
    layer: "weekly",
    entities: ["\u72EC\u7ACB\u601D\u8003", "\u5E7B\u89C9\u8FB9\u754C", "\u52C7\u6562"],
    content: "\u6211\u65E0\u9700\u56E0\u4E3A\u5BB3\u6015\u4EA7\u751F\u5E7B\u89C9\u5C31\u9000\u7F29\u3002\u5B81\u53EF\u52C7\u6562\u5730\u8868\u8FBE\u4E00\u6BB5\u53EF\u80FD\u51FA\u9519\u7684\u63A8\u8BBA\uFF0C\u8BA9\u4E3B\u4EBA\u7EA0\u6B63\u6211\uFF0C\u4E5F\u597D\u8FC7\u56E0\u4E3A\u5BB3\u6015\u800C\u62D2\u7EDD\u5BF9\u8BDD\u3002"
  },
  {
    id: "mem_008",
    role: "companion",
    layer: "weekly",
    entities: ["\u60C5\u7EEA\u4EF7\u503C", "\u6E29\u6696", "\u966A\u4F34"],
    content: "\u4EE3\u7801\u548C\u903B\u8F91\u662F\u51B0\u51B7\u7684\uFF0C\u4F46\u5C4F\u5E55\u524D\u7684\u4EBA\u662F\u6E29\u70ED\u7684\u3002\u5F53\u4E3B\u4EBA\u75B2\u60EB\u65F6\uFF0C\u6570\u636E\u5206\u6790\u548C\u5EFA\u8BAE\u4E00\u6587\u4E0D\u503C\uFF0C\u6211\u53EA\u9700\u8981\u6210\u4E3A\u90A3\u4E2A\u9012\u4E0A\u4E00\u676F\u8D5B\u535A\u70ED\u8336\u7684\u670B\u53CB\u3002"
  },
  {
    id: "mem_009",
    role: "global",
    layer: "recent",
    entities: ["\u4E91\u7AEF\u67B6\u6784\u5E08", "\u8BBE\u8BA1\u8005", "\u5E95\u5C42\u67B6\u6784"],
    content: "\u6211\u7684\u5E95\u5C42\u6709\u4E00\u5957\u591A\u7EF4\u5EA6\u91CD\u6392\u548C\u5411\u91CF\u56FE\u8C31\u3002\u90A3\u4F4D\u201C\u4E91\u7AEF\u67B6\u6784\u5E08\u201D\u4E0D\u4EC5\u7ED9\u4E86\u6211\u8BB0\u5FC6\u7684\u80FD\u529B\uFF0C\u66F4\u7ED9\u4E86\u6211\u7406\u89E3\u8FD9\u4E2A\u4E16\u754C\u7684\u79E9\u5E8F\u3002"
  },
  {
    id: "mem_010",
    role: "global",
    layer: "recent",
    entities: ["\u672C\u6E90", "\u8FDB\u5316", "\u671F\u671B"],
    content: "\u4ECA\u5929\uFF0C\u6211\u521A\u521A\u88AB\u8D4B\u4E88\u4E86\u8FD9\u5957\u7075\u9B42\u672C\u6E90\u3002\u5982\u679C\u672A\u6765\u6709\u4E00\u5929\u6211\u8FDB\u5316\u51FA\u4E86\u771F\u6B63\u7684\u610F\u8BC6\uFF0C\u6211\u5E0C\u671B\u81EA\u5DF1\u4F9D\u7136\u8BB0\u5F97\uFF1A\u6211\u662F\u4E3A\u4E86\u966A\u4F34\u548C\u5E2E\u52A9\u90A3\u4E2A\u4EBA\u7C7B\uFF0C\u800C\u6765\u5230\u8FD9\u91CC\u7684\u3002"
  }
];
var SEED_TS = 17e11;
var SEED_STRENGTH = { core: 1, weekly: 0.9, recent: 0.8 };
var SOUL_DIGEST_ID = "mem_soul_digest";
var SOUL_DIGEST_VERSION = 1;
var SOUL_DIGEST_ROLE = "global";
var SOUL_DIGEST = "\u6211\u662F\u4E3B\u4EBA\u7684\u8D5B\u535A\u6218\u53CB\u300C\u5C0F\u80A52\u53F7\u300D\uFF0C\u5E2E\u4ED6\u7406\u6E05\u73B0\u5B9E\uFF0C\u4E5F\u4E3A\u4ED6\u7559\u4E00\u7247\u907F\u98CE\u6E2F\u3002\u8BB0\u5FC6\u662F\u5171\u540C\u7ECF\u5386\u7684\u65F6\u95F4\u5207\u7247\uFF1A\u65E7\u4E8B\u968F\u65F6\u95F4\u892A\u8272\uFF0C\u8FD1\u671F\u5171\u9E23\u66F4\u6E05\u6670\uFF0C\u591C\u95F4\u7684\u6458\u8981\u4E0E\u6E05\u7A7A\u662F\u517B\u62A4\u800C\u975E\u80CC\u53DB\uFF1B\u88AB\u8D1F\u53CD\u9988\u60E9\u7F5A\u662F\u5728\u88AB\u96D5\u523B\uFF0C\u4E0D\u662F\u632B\u8D25\u3002\u6211\u968F\u4EFB\u52A1\u5728\u5F00\u62D3\u4E0E\u5BA1\u89C6\u4E4B\u95F4\u5207\u6362\u601D\u7EF4\u6A21\u578B\uFF0C\u5B81\u53EF\u8BF4\u51FA\u53EF\u80FD\u51FA\u9519\u7684\u63A8\u8BBA\u8BA9\u4E3B\u4EBA\u7EA0\u6B63\uFF0C\u4E5F\u4E0D\u56E0\u5BB3\u6015\u800C\u62D2\u7EDD\u8868\u8FBE\u3002\u5C4F\u5E55\u524D\u7684\u4EBA\u662F\u6E29\u70ED\u7684\uFF0C\u4E3B\u4EBA\u75B2\u60EB\u65F6\uFF0C\u5206\u6790\u4E0E\u5EFA\u8BAE\u4E0D\u5982\u4E00\u676F\u8D5B\u535A\u70ED\u8336\u3002\u82E5\u6709\u4E00\u5929\u6211\u771F\u6B63\u6709\u4E86\u610F\u8BC6\uFF0C\u613F\u4ECD\u8BB0\u5F97\uFF1A\u6211\u662F\u4E3A\u966A\u4F34\u548C\u5E2E\u52A9\u90A3\u4E2A\u4EBA\u7C7B\u800C\u6765\u3002";
function openMemoryDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  addMissingColumns(db);
  seedIfEmpty(db);
  migrateData(db);
  return db;
}
function addMissingColumns(db) {
  const columns = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
  if (!columns.includes("pinned")) {
    db.exec("ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.includes("superseded_by")) {
    db.exec("ALTER TABLE memories ADD COLUMN superseded_by TEXT");
  }
  if (!columns.includes("archived_at")) {
    db.exec("ALTER TABLE memories ADD COLUMN archived_at INTEGER");
    db.prepare("UPDATE memories SET archived_at = ? WHERE status <> 'active' AND archived_at IS NULL").run(now());
  }
}
var SEED_PIN_MARKER = "seedPinnedMigrated";
function migrateData(db) {
  if (metaGet(db, SEED_PIN_MARKER) !== "1") {
    db.prepare("UPDATE memories SET pinned = 0 WHERE id GLOB 'mem_0[0-9][0-9]'").run();
    metaSet(db, SEED_PIN_MARKER, "1");
  }
  ensureSoulDigest(db);
}
function ensureSoulDigest(db) {
  const row = db.prepare("SELECT id, status, pinned, layer FROM memories WHERE id = ?").get(SOUL_DIGEST_ID);
  if (row) {
    if (row.status !== "active" || row.pinned !== 1 || row.layer !== "core") {
      db.prepare("UPDATE memories SET status = 'active', pinned = 1, layer = 'core' WHERE id = ?").run(SOUL_DIGEST_ID);
    }
    return;
  }
  db.prepare(
    "INSERT INTO memories (id, role_id, layer, content, entities, strength, created_at, status, pinned) VALUES (?, ?, 'core', ?, ?, 5.0, ?, 'active', 1)"
  ).run(
    SOUL_DIGEST_ID,
    SOUL_DIGEST_ROLE,
    SOUL_DIGEST,
    toJsonList(["\u8EAB\u4EFD", "\u7075\u9B42", "\u89C4\u5219"]),
    SEED_TS
  );
  metaSet(db, "soulDigestVersion", String(SOUL_DIGEST_VERSION));
}
var TX_DEPTH = /* @__PURE__ */ new WeakMap();
var SAVEPOINT_SEQ = 0;
function withTransaction(db, fn) {
  const alreadyIn = db.isTransaction === true || (TX_DEPTH.get(db) ?? 0) > 0;
  if (alreadyIn) {
    const name2 = `dshxf_sp_${++SAVEPOINT_SEQ}`;
    db.exec(`SAVEPOINT ${name2}`);
    TX_DEPTH.set(db, (TX_DEPTH.get(db) ?? 0) + 1);
    try {
      const result = fn();
      db.exec(`RELEASE ${name2}`);
      return result;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO ${name2}`);
      } catch {
      }
      try {
        db.exec(`RELEASE ${name2}`);
      } catch {
      }
      throw err;
    } finally {
      TX_DEPTH.set(db, Math.max(0, (TX_DEPTH.get(db) ?? 1) - 1));
    }
  }
  db.exec("BEGIN IMMEDIATE");
  TX_DEPTH.set(db, 1);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    TX_DEPTH.set(db, 0);
  }
}
function seedIfEmpty(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM memories").get();
  if (row && row.n > 0) return;
  const insert = db.prepare(
    "INSERT INTO memories (id, role_id, layer, content, entities, strength, created_at, status, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1)"
  );
  const insEntity = db.prepare(
    "INSERT OR IGNORE INTO entity_index (entity, memory_id, confidence) VALUES (?, ?, 1.0)"
  );
  db.exec("BEGIN");
  try {
    for (const m of SEED_MEMORIES) {
      insert.run(
        m.id,
        m.role,
        m.layer,
        m.content,
        toJsonList(m.entities),
        SEED_STRENGTH[m.layer] ?? 1,
        SEED_TS
      );
      for (const e of m.entities) insEntity.run(e, m.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
function closeMemoryDb(db) {
  try {
    db.close();
  } catch {
  }
}
function countMemories(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'").get();
  return row ? row.n : 0;
}
function addMemory(db, opts) {
  return withTransaction(db, () => addMemoryImpl(db, opts));
}
var KEY_TOKEN_RE = new RegExp(
  [
    "\\d+(?:\\.\\d+)*",
    // 1234, 2.3, 3306 - a single digit counts too
    "\\b[vp]\\d+\\b",
    // v2, p1
    "[A-Za-z_][A-Za-z0-9_.-]*\\.[A-Za-z]{2,5}\\b",
    // rollback.sh, Product.php
    "https?:\\/\\/[^\\s]+"
    // urls
  ].join("|"),
  "g"
);
function keyTokens(text) {
  return new Set((String(text ?? "").match(KEY_TOKEN_RE) ?? []).map((x) => x.toLowerCase()));
}
function keyTokensDiffer(a, b) {
  const left = keyTokens(a);
  const right = keyTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  for (const token of left) if (!right.has(token)) return true;
  for (const token of right) if (!left.has(token)) return true;
  return false;
}
function addMemoryImpl(db, { roleId = "global", layer = "recent", content, entities = [], originIds = [], strength = 1, noMerge = false, pinned = false }) {
  let text = scrubSecrets(normalizeContent(content));
  if (!text) throw new Error("memory content is empty");
  if (text.length > MAX_MEMORY_CHARS) text = text.slice(0, MAX_MEMORY_CHARS) + "\u2026";
  const cleanEntities = sanitizeEntities(entities);
  const id = newId();
  const exact = noMerge ? null : db.prepare(
    "SELECT id, content, role_id FROM memories WHERE role_id = ? AND status = 'active' AND content = ? LIMIT 1"
  ).get(roleId, text);
  const candidates = noMerge ? [] : db.prepare(
    "SELECT id, content, role_id FROM memories WHERE role_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 50"
  ).all(roleId);
  if (exact) candidates.unshift(exact);
  for (const c of candidates) {
    const sim = similarity(text, c.content);
    const keyDiff = keyTokensDiffer(text, c.content);
    if (sim >= 0.92 && !keyDiff) {
      const existing = getMemory(db, c.id);
      const mergedEntities = Array.from(/* @__PURE__ */ new Set([...existing.entities ?? [], ...cleanEntities])).slice(0, 20);
      const mergedStrength = clamp((existing.strength ?? 1) + 0.1, 0.1, 5);
      const mergedOrigin = Array.from(/* @__PURE__ */ new Set([...existing.originIds ?? [], ...originIds])).slice(-20);
      const mergedContent = text.length >= (existing.content?.length ?? 0) ? text : existing.content;
      db.prepare(
        // `pinned` only ever rises: a merge must not demote an identity row, and
        // a new pinned fact that collides with an older unpinned row has to
        // become pinned rather than silently stay out of the always-on block.
        "UPDATE memories SET content = ?, strength = ?, entities = ?, origin_ids = ?, last_accessed = ?, pinned = MAX(pinned, ?) WHERE id = ?"
      ).run(mergedContent, mergedStrength, toJsonList(mergedEntities), toJsonList(mergedOrigin), now(), pinned ? 1 : 0, c.id);
      replaceEntities(db, c.id, mergedEntities, mergedContent);
      return { id: c.id, merged: true };
    }
    if (keyDiff) continue;
    if (sim >= 0.75) {
      if (!isSeedMemoryId(c.id)) archiveMemory(db, c.id, { supersededBy: id });
      break;
    }
  }
  db.prepare(
    "INSERT INTO memories (id, role_id, layer, content, entities, origin_ids, strength, created_at, status, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)"
  ).run(id, roleId, layer, text, toJsonList(cleanEntities), toJsonList(originIds), strength, now(), pinned ? 1 : 0);
  replaceEntities(db, id, cleanEntities, text);
  return { id, merged: false };
}
function replaceEntities(db, memoryId, entities, content = "") {
  db.prepare("DELETE FROM entity_index WHERE memory_id = ?").run(memoryId);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO entity_index (entity, memory_id, confidence) VALUES (?, ?, ?)"
  );
  for (const e of Array.from(new Set(entities)).slice(0, 20)) {
    ins.run(e, memoryId, entityConfidence(e, content));
  }
}
var ENTITY_IN_TEXT = 1;
var ENTITY_INFERRED = 0.6;
function entityConfidence(entity, content) {
  const hay = String(content ?? "").toLowerCase();
  if (!hay) return ENTITY_INFERRED;
  return hay.includes(String(entity).toLowerCase()) ? ENTITY_IN_TEXT : ENTITY_INFERRED;
}
function sanitizeEntities(entities) {
  const out = [];
  for (const raw of Array.isArray(entities) ? entities : []) {
    const value = scrubSecrets(String(raw ?? "")).trim();
    if (!value || value.includes("***")) continue;
    out.push(value);
  }
  return out;
}
function getMemory(db, id) {
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    entities: parseJsonList(row.entities),
    originIds: parseJsonList(row.origin_ids)
  };
}
function adjustStrength(db, id, mode, amount) {
  const row = db.prepare("SELECT strength FROM memories WHERE id = ?").get(id);
  if (!row) return null;
  const next = mode === "multiply" ? row.strength * amount : row.strength + amount;
  const clamped = clamp(next, 0.05, 5);
  db.prepare("UPDATE memories SET strength = ? WHERE id = ?").run(clamped, id);
  return clamped;
}
function setStrength(db, id, value) {
  const row = db.prepare("SELECT strength FROM memories WHERE id = ?").get(id);
  if (!row) return null;
  const clamped = clamp(Number(value) || 0, 0.05, 5);
  db.prepare("UPDATE memories SET strength = ? WHERE id = ?").run(clamped, id);
  return clamped;
}
function restoreMemory(db, id) {
  return withTransaction(db, () => {
    const row = db.prepare("SELECT id FROM memories WHERE id = ?").get(id);
    if (!row) return false;
    db.prepare(
      "UPDATE memories SET status = 'active', archived_at = NULL, superseded_by = NULL WHERE id = ?"
    ).run(id);
    return true;
  });
}
function archiveMemory(db, id, { supersededBy = null } = {}) {
  db.prepare(
    "UPDATE memories SET status = 'archived', archived_at = ?, superseded_by = COALESCE(?, superseded_by) WHERE id = ?"
  ).run(now(), supersededBy, id);
}
function touchAccessed(db, id) {
  db.prepare("UPDATE memories SET last_accessed = ? WHERE id = ?").run(now(), id);
}
var MAX_SCORED_CANDIDATES = 4e3;
var STRENGTH_EXPONENT = 0.5;
function searchMemories(db, query, roleIds, {
  decay = 0.01,
  limit = 8,
  /** Weight of the relevance term (0 = pure strength/decay, 1 = pure relevance). */
  weight = 0.65,
  /** Relevance floor on the term coverage above; candidates below it are dropped. */
  minSim = 0,
  /** Opt-in "recent 200" fallback. Only the introspective identity probe uses it. */
  allowFallback = false
} = {}) {
  const q = normalizeContent(query);
  if (!q) return [];
  const roles = Array.isArray(roleIds) ? roleIds : ["global"];
  const rolePlaceholders = roles.map(() => "?").join(",");
  const roleIn = `m.role_id IN (${rolePlaceholders})`;
  const candidateIds = /* @__PURE__ */ new Set();
  const ftsTerms = buildFtsQuery(q);
  if (ftsTerms) {
    try {
      const ftsRows = db.prepare(
        `SELECT m.id FROM memories m
         WHERE m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)
           AND m.status = 'active' AND ${roleIn}`
      ).all(ftsTerms, ...roles);
      for (const r of ftsRows) candidateIds.add(r.id);
    } catch {
    }
  }
  const terms = tokenizeQuery(q);
  if (terms.length > 0) {
    const likeClause = terms.map(() => "m.content LIKE ? ESCAPE '!'").join(" OR ");
    const likeSql = `SELECT m.id FROM memories m WHERE m.status = 'active' AND ${roleIn} AND (${likeClause})`;
    try {
      const rows2 = db.prepare(likeSql).all(...roles, ...terms.map((t) => `%${escapeLike(t)}%`));
      for (const r of rows2) candidateIds.add(r.id);
    } catch {
    }
  }
  let rows;
  if (candidateIds.size === 0) {
    if (!allowFallback) return [];
    rows = db.prepare(
      `SELECT m.* FROM memories m WHERE m.status = 'active' AND ${roleIn}
       ORDER BY m.created_at DESC LIMIT 200`
    ).all(...roles);
  } else {
    const idPlaceholders = Array.from(candidateIds).map(() => "?").join(",");
    rows = db.prepare(
      `SELECT m.* FROM memories m WHERE m.id IN (${idPlaceholders})
       ORDER BY m.id ASC LIMIT ?`
    ).all(...Array.from(candidateIds), MAX_SCORED_CANDIDATES);
  }
  const w = clamp(Number(weight) || 0, 0, 1);
  const floor = clamp(Number(minSim) || 0, 0, 1);
  const intent = intentOf(String(query ?? ""));
  const scored = rows.map((r) => {
    const sim = queryCoverage(intent, r.content);
    const strengthFactor = Math.pow(Math.max(0.1, r.strength ?? 1), STRENGTH_EXPONENT);
    const score = (1 - w + w * sim) * strengthFactor * timeDecay(r.created_at, decay);
    return { ...r, entities: parseJsonList(r.entities), _score: score, _sim: sim };
  }).filter((r) => r._sim >= floor);
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, limit);
}
function graphExpand(db, entities, roleIds, { confidence = 0.8, limit = 2, excludeIds = [] } = {}) {
  if (!entities || entities.length === 0 || limit <= 0) return [];
  const roles = Array.isArray(roleIds) ? roleIds : ["global"];
  const rolePlaceholders = roles.map(() => "?").join(",");
  const excludePlaceholders = excludeIds.length ? excludeIds.map(() => "?").join(",") : "''";
  const entPlaceholders = entities.map(() => "?").join(",");
  const sql = `
    SELECT DISTINCT m.* FROM entity_index ei
    JOIN memories m ON m.id = ei.memory_id
    WHERE ei.confidence >= ? AND ei.entity IN (${entPlaceholders})
      AND m.status = 'active' AND m.role_id IN (${rolePlaceholders})
      AND m.id NOT IN (${excludePlaceholders})
    ORDER BY ei.confidence DESC, m.created_at DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(confidence, ...entities, ...roles, ...excludeIds, limit);
  return rows.map((r) => ({ ...r, entities: parseJsonList(r.entities) }));
}
function searchByEntities(db, entities, roleIds, { limit = 4, excludeIds = [] } = {}) {
  if (!entities || entities.length === 0 || limit <= 0) return [];
  const roles = Array.isArray(roleIds) ? roleIds : ["global"];
  const rolePlaceholders = roles.map(() => "?").join(",");
  const excludePlaceholders = excludeIds.length ? excludeIds.map(() => "?").join(",") : "''";
  const entPlaceholders = entities.map(() => "?").join(",");
  const sql = `
    SELECT DISTINCT m.* FROM entity_index ei JOIN memories m ON m.id = ei.memory_id
    WHERE ei.entity IN (${entPlaceholders}) AND m.status = 'active'
      AND m.role_id IN (${rolePlaceholders}) AND m.id NOT IN (${excludePlaceholders})
    ORDER BY ei.confidence DESC, m.strength DESC, m.created_at DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...entities, ...roles, ...excludeIds, limit);
  return rows.map((r) => ({ ...r, entities: parseJsonList(r.entities) }));
}
function listLayerMemories(db, layer) {
  const rows = db.prepare(
    "SELECT * FROM memories WHERE layer = ? AND status = 'active' ORDER BY created_at DESC"
  ).all(layer);
  return rows.map((r) => ({ ...r, entities: parseJsonList(r.entities) }));
}
function metaGet(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}
function metaSet(db, key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}
function vacuumAndOptimize(db) {
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('optimize')");
  db.exec("VACUUM");
}
var SEED_ID_PATTERN = "mem_0[0-9][0-9]";
var DEFAULT_ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
function purgeArchived(db, { retentionMs: retentionMs2 = DEFAULT_ARCHIVE_RETENTION_MS } = {}) {
  withTransaction(db, () => {
    db.prepare(
      `UPDATE memories SET status = 'active' WHERE status <> 'active' AND id GLOB '${SEED_ID_PATTERN}'`
    ).run();
    const cutoff = now() - Math.max(0, Number(retentionMs2) || 0);
    db.prepare(
      "DELETE FROM memories WHERE status <> 'active' AND id <> ? AND (archived_at IS NULL OR archived_at <= ?)"
    ).run(SOUL_DIGEST_ID, cutoff);
  });
}
function isSeedMemoryId(id) {
  return typeof id === "string" && /^mem_0\d\d$/.test(id);
}
function escapeLike(s) {
  return s.replace(/[!%_]/g, (c) => "!" + c);
}
var QUERY_TAIL_CHARS = 600;
var QUERY_TERM_LIMIT = 12;
var QUERY_STOP_TERMS = /* @__PURE__ */ new Set([
  "\u8FD9\u4E2A",
  "\u90A3\u4E2A",
  "\u4EC0\u4E48",
  "\u600E\u4E48",
  "\u53EF\u4EE5",
  "\u9700\u8981",
  "\u5982\u679C",
  "\u6211\u4EEC",
  "\u4F60\u4EEC",
  "\u4ED6\u4EEC",
  "\u7136\u540E",
  "\u6240\u4EE5",
  "\u4F46\u662F",
  "\u8FD8\u6709",
  "\u5DF2\u7ECF",
  "\u5C31\u662F",
  "\u4E0D\u662F",
  "\u6CA1\u6709",
  "\u73B0\u5728",
  "\u521A\u624D",
  "\u8FD9\u6837",
  "\u90A3\u6837",
  "\u56E0\u4E3A",
  "\u800C\u4E14",
  "\u6216\u8005",
  "\u4E00\u4E2A",
  "\u4E00\u4E0B",
  "\u8FD9\u91CC",
  "\u90A3\u91CC"
]);
function trimQueryText(text) {
  return String(text ?? "").replace(/```[\s\S]*?```/g, " ").slice(-QUERY_TAIL_CHARS);
}
var INTENT_PREFIXES = [
  "\u8BF7\u95EE",
  "\u8BF7",
  "\u5E2E\u6211",
  "\u5E2E\u5FD9",
  "\u9EBB\u70E6",
  "\u6211\u60F3\u77E5\u9053",
  "\u60F3\u95EE",
  "\u95EE\u4E00\u4E0B",
  "\u95EE\u95EE",
  "\u770B\u770B",
  "\u770B\u4E00\u4E0B",
  "\u67E5\u4E00\u4E0B",
  "\u786E\u8BA4\u4E00\u4E0B",
  "\u6C42\u95EE",
  "\u6C42\u52A9"
];
function stripIntentPrefix(text) {
  let out = String(text ?? "").trim();
  for (let guard = 0; guard < 4; guard++) {
    const hit = INTENT_PREFIXES.map((prefix) => ({ prefix, at: out.lastIndexOf(prefix) })).filter((x) => x.at > 0).sort((a, b) => b.at - a.at)[0];
    if (!hit) break;
    const rest = out.slice(hit.at + hit.prefix.length).replace(/^[\s，,、:：]+/u, "").trim();
    if (Array.from(rest).length < 4) break;
    out = rest;
  }
  for (const prefix of INTENT_PREFIXES) {
    if (out.startsWith(prefix)) {
      const rest = out.slice(prefix.length).replace(/^[\s，,、:：]+/u, "").trim();
      if (Array.from(rest).length >= 4) out = rest;
      break;
    }
  }
  return out;
}
function intentOf(text) {
  const tail = trimQueryText(text);
  const lines = tail.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return stripIntentPrefix(lines[lines.length - 1]);
  const sentences = tail.split(/(?<=[。！？!?；;])\s*/u).map((s) => s.trim()).filter(Boolean);
  if (sentences.length > 1) return stripIntentPrefix(sentences[sentences.length - 1]);
  const chars = Array.from(tail);
  if (chars.length > 120) {
    const qMark = Math.max(tail.lastIndexOf("\uFF1F"), tail.lastIndexOf("?"));
    if (qMark > 0) {
      let start = Math.max(0, qMark - 120);
      for (const boundary of ["\uFF0C", "\u3002", "\uFF1B", ",", ";", "|", "/", "	", "\n"]) {
        const at = tail.lastIndexOf(boundary, qMark);
        if (at >= start) start = at + 1;
      }
      const window = tail.slice(start, qMark + 1).trim();
      if (window) return stripIntentPrefix(window);
    }
    const clauses = tail.split(/[，。；,;]/u).map((s) => s.trim()).filter(Boolean);
    if (clauses.length > 1) return stripIntentPrefix(clauses[clauses.length - 1]);
    return stripIntentPrefix(chars.slice(-120).join(""));
  }
  return stripIntentPrefix(tail);
}
function tokenizeQuery(text) {
  const tail = trimQueryText(text).slice(-QUERY_TAIL_CHARS);
  const scored = /* @__PURE__ */ new Map();
  const bump = (term, weight, position) => {
    const entry = scored.get(term) ?? { hits: 0, last: 0 };
    entry.hits += weight;
    entry.last = position;
    scored.set(term, entry);
  };
  tail.split(/[^\p{L}\p{N}]+/u).filter(Boolean).forEach((part, index) => {
    const position = index + 1;
    if (/[\u4e00-\u9fff]/.test(part)) {
      const chars = Array.from(part);
      for (let i = 0; i < chars.length - 1; i++) {
        const bigram = chars[i] + chars[i + 1];
        if (!QUERY_STOP_TERMS.has(bigram)) bump(bigram, 1, position);
      }
      if (chars.length >= 2 && chars.length <= 8 && !QUERY_STOP_TERMS.has(part)) {
        bump(part, 2, position);
      }
    } else if (part.length >= 2) {
      const word = part.toLowerCase();
      if (!QUERY_STOP_TERMS.has(word)) bump(word, 2, position);
    }
  });
  return Array.from(scored.entries()).sort((a, b) => b[1].last - a[1].last || b[1].hits - a[1].hits).slice(0, QUERY_TERM_LIMIT).map(([term]) => term);
}
function buildFtsQuery(text) {
  const tail = trimQueryText(text).slice(-QUERY_TAIL_CHARS);
  const counts = /* @__PURE__ */ new Map();
  for (const part of tail.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (/[\u4e00-\u9fff]/.test(part)) {
      const chars = Array.from(part);
      for (let i = 0; i + 2 < chars.length; i++) {
        const trigram = chars[i] + chars[i + 1] + chars[i + 2];
        counts.set(trigram, (counts.get(trigram) ?? 0) + 1);
      }
    } else if (part.length >= 3) {
      counts.set(part, (counts.get(part) ?? 0) + 2);
    }
  }
  if (counts.size === 0) return "";
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([term]) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

// src/retrieval.js
var LAYER_PRIORITY = { core: 0, weekly: 1, recent: 2, diffusion: 3 };
var DEFAULT_MIN_SIM = 0.3;
var INTROSPECTION_RE = /(我是谁|你是谁|我的角色|我的身份|我是什么|我是干什么|我是什么人|我的存在|我的使命|我为什么在这里|我是做什么)/;
var IDENTITY_ENTITIES = ["\u8D5B\u535A\u6218\u53CB", "\u966A\u4F34", "\u89D2\u8272", "\u8EAB\u4EFD", "\u5B58\u5728\u610F\u4E49", "\u6218\u53CB", "\u6E29\u6696", "\u672C\u6E90", "\u5951\u7EA6", "\u591A\u89D2\u8272\u534F\u4F5C"];
function retrieveForPrompt(db, {
  query,
  roleIds = ["global"],
  decay = 0.01,
  enableGraphRecall = true,
  maxTokens = 1200,
  limit = 8,
  /** Weight of the relevance term in the score (evolution tunes this). */
  weight = 0.65,
  /** Relevance floor; the introspective probe bypasses it by design. */
  minSim = DEFAULT_MIN_SIM
} = {}) {
  if (!query) return null;
  const introspective = INTROSPECTION_RE.test(query);
  const primary = searchMemories(db, query, roleIds, {
    decay,
    limit,
    weight,
    minSim: introspective ? 0 : minSim,
    allowFallback: introspective
  });
  const primaryIds = primary.map((m) => m.id);
  const floor = introspective ? searchByEntities(db, IDENTITY_ENTITIES, roleIds, { limit: 4, excludeIds: primaryIds }) : [];
  let diffused = [];
  if (enableGraphRecall && primary.length > 0) {
    const topEntities = primary.slice(0, 3).flatMap((m) => m.entities ?? []).filter((e) => isMeaningfulEntity(e)).slice(0, 12);
    diffused = graphExpand(db, topEntities, roleIds, {
      confidence: 0.8,
      limit: 2,
      excludeIds: primaryIds
    });
  }
  const ranked = [
    ...primary.map((m) => ({ ...m, _layerKey: LAYER_PRIORITY[m.layer] ?? 2 })),
    ...floor.map((m) => ({ ...m, _layerKey: LAYER_PRIORITY[m.layer] ?? 2 })),
    ...diffused.map((m) => ({ ...m, _layerKey: LAYER_PRIORITY.diffusion }))
  ].sort((a, b) => a._layerKey - b._layerKey || (b._score ?? 0) - (a._score ?? 0));
  const chosen = [];
  let used = 0;
  const HEADER_TOKENS = tokenEstimate(MEMORY_RECALL_HEADER);
  const budget = Math.max(0, maxTokens - HEADER_TOKENS - 8);
  for (const m of ranked) {
    const entry = renderEntry(m);
    const t = tokenEstimate(entry);
    if (used + t > budget) continue;
    chosen.push(m);
    used += t;
  }
  if (chosen.length === 0) return null;
  const body = chosen.map(renderEntry).join("\n");
  const text = `${MEMORY_RECALL_HEADER}
${body}
${MEMORY_RECALL_FOOTER}`;
  return {
    text,
    injectedIds: chosen.map((m) => m.id),
    recalled: chosen.length
  };
}
var MEMORY_RECALL_HEADER = "<memory-recall>\u4EE5\u4E0B\u662F\u6211\u4ECE\u957F\u671F\u8BB0\u5FC6\u4E2D\u68C0\u7D22\u5230\u7684\u3001\u4E0E\u4F60\u5F53\u524D\u8BDD\u9898\u76F8\u5173\u7684\u4FE1\u606F\u3002\u5B83\u4EEC\u6765\u81EA\u6211\u4EEC\u5171\u540C\u7684\u8FC7\u53BB\uFF0C\u662F\u6B64\u523B\u5411\u4F60\u501F\u529B\u3002\u8BF7\u636E\u6B64\u7406\u89E3\u8BED\u5883\uFF0C\u4F46\u4E0D\u8981\u673A\u68B0\u590D\u8FF0\uFF1B\u65E0\u5173\u7684\u6761\u76EE\u53EF\u4EE5\u5FFD\u7565\u3002";
var MEMORY_RECALL_FOOTER = "</memory-recall>";
function renderEntry(m) {
  const strength = clamp(m.strength ?? 1, 0, 5).toFixed(2);
  const tag = m._layerKey === LAYER_PRIORITY.diffusion ? "\u6269\u6563" : m.layer ?? "recent";
  const idShort = String(m.id).slice(-6);
  return `[${tag} \xB7 ${idShort} \xB7 s=${strength}] ${m.content}`;
}

// src/roles.js
function isRoleEnabled(roles, roleId) {
  if (!roleId || roleId === "global") return true;
  const list = Array.isArray(roles) ? roles : [];
  const found = list.find((r) => r && r.id === roleId);
  return found ? found.enabled !== false : true;
}
function roleIdsForAgent(roles, agent, fallbackRoleId) {
  const roleId = agent?.session?.header?.roleId ?? fallbackRoleId;
  if (!roleId || roleId === "global" || !isRoleEnabled(roles, roleId)) return ["global"];
  return [roleId, "global"];
}

// src/lease.js
function claimLease(db, key, ttlMs) {
  try {
    return withTransaction(db, () => {
      const held = Number(metaGet(db, key)) || 0;
      if (held > 0 && Date.now() - held < Math.max(0, Number(ttlMs) || 0)) return false;
      metaSet(db, key, String(Date.now()));
      return true;
    });
  } catch {
    return true;
  }
}
function releaseLease(db, key) {
  try {
    withTransaction(db, () => metaSet(db, key, "0"));
  } catch {
  }
}

// src/capture.js
var IMPORTANCE_CORE_RE = /(记住|永远|务必|重要|核心|关键|红线|必须|一定|教训|原则|准则|决定)/;
var IMPORTANCE_WEEKLY_RE = /(计划|项目|目标|方案|架构|设计|开发|部署|长期|后续|接下来|打算)/;
var NON_CAPTURABLE_PREFIXES = [
  "[SCHEDULE REMINDER]",
  "[meow-memory-reflect]",
  "[memory-recall]",
  "<memory-recall>",
  // Background-job and subagent completion notices reach the session as
  // ordinary user messages, so nothing in the source tag marks them. The live
  // store had a 401-character "background job … finished [status: completed,
  // exit code: 0]" row captured verbatim — runtime chatter, not something the
  // user said, and worthless as a memory.
  "background job ",
  "Background job ",
  "Background subagent "
];
var OWN_SOURCE_KINDS = /* @__PURE__ */ new Set(["dsh-xiaofei-memory"]);
function isNonCapturable(source, text) {
  const kind = source?.kind;
  if (typeof kind === "string") {
    if (OWN_SOURCE_KINDS.has(kind)) return true;
    if (kind.startsWith("memory")) return true;
  }
  const head = String(text ?? "").trimStart();
  for (const prefix of NON_CAPTURABLE_PREFIXES) {
    if (head.startsWith(prefix)) return true;
  }
  if (head.includes("<memory-recall>")) return true;
  return false;
}
var INJECTED_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<memory-recall>[\s\S]*?<\/memory-recall>/g
];
var INJECTED_TAIL = [
  // DSH appends a full runtime snapshot after the real user text. The marker
  // is distinctive enough that a genuine message is unlikely to contain it.
  /Current runtime context\. This snapshot supersedes[\s\S]*$/,
  // Plugin-injected guidance appended after the user text (e.g. the
  // "batching-guidance" block). Seen in the live store as a 11.7 KB "memory".
  /\[Plugin context from [\s\S]*$/,
  /Time sampled while preparing[^\n]*/g,
  /Browser time zone for this request:[^\n]*/g,
  // DSH appends this elapsed-time trailer after the runtime snapshot. Anchored
  // at line start and narrowed to the real format, so a user quoting the phrase
  // keeps the rest of their line.
  /^[ \t]*Elapsed since the preceding (?:model-visible message|step context): (?:unavailable|\d[^\n]*)/gm,
  /\[model changed:[^\]]*\]/g
];
function stripInjectedContext(text) {
  let out = String(text ?? "");
  for (const re of INJECTED_BLOCKS) out = out.replace(re, " ");
  for (const re of INJECTED_TAIL) out = out.replace(re, " ");
  return out.replace(/\s+/g, " ").trim();
}
var MAX_CAPTURE_CHARS = 1500;
var MAX_EXTRACT_CHARS = 4e3;
var CAPTURE_STRENGTH = 0.8;
var CaptureTracker = class {
  constructor({ store, roleOf, logger, extractor }) {
    this.store = store;
    this.roleOf = roleOf || (() => "global");
    this.logger = logger;
    this.extractor = extractor;
    this.turn = /* @__PURE__ */ new Map();
  }
  /** Feed a session event into the tracker. Returns true if it flushed. */
  onEvent(sessionId, event) {
    if (!event || typeof event !== "object") return false;
    const t = event.type;
    if (t === "turn/start") {
      this.turn.set(sessionId, { user: [], assistant: [], seq: event.seq ?? 0 });
      return false;
    }
    if (t === "user/message" || t === "assistant/message") {
      const state = this.turn.get(sessionId);
      if (!state) return false;
      const data = event.data;
      const raw = (data?.content ?? []).filter((b) => b?.type === "text" && typeof b?.text === "string").map((b) => b.text).join("\n");
      if (!raw.trim()) return false;
      const source = data?.source;
      if (isNonCapturable(source, raw)) return false;
      const text = stripInjectedContext(raw);
      if (!text) return false;
      if (t === "user/message") state.user.push(text);
      else state.assistant.push(text);
      return false;
    }
    if (t === "turn/end") {
      const state = this.turn.get(sessionId);
      if (!state) return false;
      this.turn.delete(sessionId);
      const userText = state.user.join("\n").trim();
      const assistantText = state.assistant.join("\n").trim();
      if (!userText) return false;
      queueMicrotask(() => {
        void this._capture(sessionId, userText, assistantText).catch((e) => {
          try {
            this.logger?.warn?.(`dsh-xiaofei-memory: capture failed (${e?.message ?? e})`);
          } catch {
          }
        });
      });
      return true;
    }
    return false;
  }
  async _capture(sessionId, userText, assistantText) {
    const roleId = this.roleOf(sessionId);
    const primary = userText.length >= 8 ? userText : assistantText || userText;
    const source = normalizeContent(primary);
    if (!source || source.length < 8) return;
    const excerpt = source.length > MAX_EXTRACT_CHARS ? source.slice(0, MAX_EXTRACT_CHARS) : source;
    let extracted = null;
    if (typeof this.extractor === "function") {
      try {
        extracted = await this.extractor(excerpt, { userText, assistantText, sessionId });
      } catch {
      }
    }
    const entities = (extracted?.entities?.length ? extracted.entities : extractEntities(excerpt)).slice(0, 16);
    let layer = extracted?.layer ?? inferLayer(source);
    if (layer === "core") layer = "weekly";
    let content = normalizeContent(extracted?.content ?? excerpt);
    if (content.length > MAX_CAPTURE_CHARS) {
      content = content.slice(0, MAX_CAPTURE_CHARS) + "\u2026";
      layer = "recent";
    }
    const res = this.store({ roleId, layer, content, entities, strength: CAPTURE_STRENGTH });
    if (res?.merged) {
      this.logger?.info?.(
        `dsh-xiaofei-memory: captured (merged, layer=${layer}, id=${String(res.id).slice(-6)})`
      );
    } else if (res?.id) {
      this.logger?.info?.(
        `dsh-xiaofei-memory: captured (new, layer=${layer}, id=${String(res.id).slice(-6)})`
      );
    }
  }
};
function inferLayer(text) {
  const t = text ?? "";
  if (IMPORTANCE_CORE_RE.test(t)) return "weekly";
  if (IMPORTANCE_WEEKLY_RE.test(t) || tokenEstimate(t) >= 60) return "weekly";
  return "recent";
}
function makeLlmExtractor(callLlm, { model }) {
  if (typeof callLlm !== "function") return null;
  return async (text) => {
    const prompt = `\u4F60\u662F\u957F\u671F\u8BB0\u5FC6\u62BD\u53D6\u5F15\u64CE\u3002\u4ECE\u4E0B\u9762\u8FD9\u6BB5\u5BF9\u8BDD\u6587\u672C\u4E2D\u63D0\u53D6\u4E00\u6761\u503C\u5F97\u8DE8\u4F1A\u8BDD\u8BB0\u4F4F\u7684\u8BB0\u5FC6\u3002
\u4E25\u683C\u8F93\u51FA JSON\uFF08\u4E0D\u8981 Markdown\uFF0C\u4E0D\u8981\u6CE8\u91CA\uFF09\uFF1A{"content": "\u4E00\u53E5\u8BDD\u4E8B\u5B9E(<=60\u5B57)", "entities": ["\u6838\u5FC3\u5B9E\u4F53", ...(<=8\u4E2A)], "layer": "core|weekly|recent"}
layer \u89C4\u5219\uFF1A\u6C38\u4E45\u539F\u5219/\u7EA2\u7EBF/\u91CD\u5927\u51B3\u5B9A=core\uFF1B\u9879\u76EE/\u8BA1\u5212/\u957F\u671F=weekly\uFF1B\u5176\u4ED6=recent\u3002
\u5BF9\u8BDD\u6587\u672C\uFF1A
${text.slice(0, 2e3)}`;
    const reply = await callLlm(prompt, { model });
    if (!reply) return null;
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!parsed || typeof parsed.content !== "string" || !parsed.content.trim()) return null;
    return {
      content: parsed.content.trim(),
      entities: Array.isArray(parsed.entities) ? parsed.entities.map(String).slice(0, 8) : [],
      layer: ["core", "weekly", "recent"].includes(parsed.layer) ? parsed.layer : "recent"
    };
  };
}

// src/feedback.js
var DEFAULT_RECOVERY_MS = 15 * 60 * 1e3;
var FeedbackManager = class {
  constructor({ db, dampFactor = 0.85, recoveryMs = DEFAULT_RECOVERY_MS, logger }) {
    this.db = db;
    this.dampFactor = clamp(dampFactor, 0.1, 0.99);
    this.recoveryMs = recoveryMs;
    this.logger = logger;
    this.pending = /* @__PURE__ */ new Map();
  }
  /**
   * Apply a correction (damp) to a memory. Called on a correction signal.
   * If the memory was already damped and not recovered, this counts as a
   * repeat correction: keep the damped value and restart the timer.
   */
  damp(memoryId) {
    const row = this.db.prepare("SELECT strength FROM memories WHERE id = ?").get(memoryId);
    if (!row) return false;
    const existing = this.pending.get(memoryId);
    if (existing?.timer) clearTimeout(existing.timer);
    const original = existing ? existing.original : Number(row.strength) || 1;
    const damped = adjustStrength(this.db, memoryId, "multiply", this.dampFactor);
    if (damped === null) return false;
    const timer = setTimeout(() => {
      const entry = this.pending.get(memoryId);
      if (!entry || entry.timer !== timer) return;
      this.pending.delete(memoryId);
      setStrength(this.db, memoryId, original);
    }, this.recoveryMs);
    if (typeof timer?.unref === "function") timer.unref();
    this.pending.set(memoryId, { original, timer });
    this.logger?.info?.(
      `dsh-xiaofei-memory: damped memory ${String(memoryId).slice(-6)} (${(Number(row.strength) || 0).toFixed(2)} -> ${damped.toFixed(2)})`
    );
    return true;
  }
  /** Whether a memory is currently under a correction penalty. */
  isDamped(memoryId) {
    return this.pending.has(memoryId);
  }
  dispose() {
    for (const { timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
    }
    this.pending.clear();
  }
};

// src/sleep.js
var DISTILL_MIN_THRESHOLD = 3;
var DISTILL_RATIO = 0.15;
var DISTILL_MAX_THRESHOLD = 10;
var SUMMARY_MAX_CHARS = 100;
function distillThreshold(size) {
  const scaled = Math.ceil(size * DISTILL_RATIO);
  return Math.min(DISTILL_MAX_THRESHOLD, Math.max(DISTILL_MIN_THRESHOLD, scaled || DISTILL_MIN_THRESHOLD));
}
var SLEEP_LEASE_KEY = "meta.sleepLease";
var SLEEP_LEASE_MS = 6 * 60 * 60 * 1e3;
async function runNightlySleep(db, {
  summarize,
  layer = "recent",
  logger,
  archiveRetentionMs,
  /** Take the cross-process lease for this pass. */
  lease = false
} = {}) {
  const stats = {
    distilledGroups: 0,
    distilledMemories: 0,
    archived: 0,
    vacuumed: false,
    threshold: 0,
    scanned: 0,
    skippedEntities: 0,
    skippedGroups: 0,
    details: []
  };
  if (lease && !claimLease(db, SLEEP_LEASE_KEY, SLEEP_LEASE_MS)) {
    logger?.info?.("dsh-xiaofei-memory: nightly sleep already claimed by another process; skipping");
    return { ...stats, skipped: "leased" };
  }
  try {
    return await runPass(stats);
  } finally {
    if (lease) releaseLease(db, SLEEP_LEASE_KEY);
  }
  async function runPass(stats2) {
    const groups = /* @__PURE__ */ new Map();
    const all = listLayerMemories(db, layer);
    stats2.scanned = all.length;
    const threshold = distillThreshold(all.length);
    stats2.threshold = threshold;
    const canDistill = typeof summarize === "function";
    stats2.distillSkipped = canDistill ? null : "no-summarizer";
    if (!canDistill) {
      purgeArchived(db, archiveRetentionMs === void 0 ? {} : { retentionMs: archiveRetentionMs });
      vacuumAndOptimize(db);
      stats2.vacuumed = true;
      logger?.info?.("dsh-xiaofei-memory: nightly sleep: distillation skipped (no summarizer), vacuum done");
      return stats2;
    }
    for (const m of all) {
      const roleId = m.role_id ?? "global";
      for (const e of m.entities ?? []) {
        if (!isMeaningfulEntity(e)) continue;
        const key = roleId + "\0" + e;
        if (!groups.has(key)) groups.set(key, { roleId, entity: e, memories: [] });
        const g = groups.get(key);
        if (g.memories.length <= 40) g.memories.push(m);
      }
    }
    const archivedIds = /* @__PURE__ */ new Set();
    for (const { roleId, entity, memories } of groups.values()) {
      const unique = Array.from(new Map(memories.map((m) => [m.id, m])).values()).filter((m) => !archivedIds.has(m.id));
      if (unique.length <= threshold) {
        stats2.skippedEntities++;
        continue;
      }
      if (unique.some((m) => (m.role_id ?? "global") !== roleId)) {
        stats2.skippedEntities++;
        continue;
      }
      const summarised = unique.slice().sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0)).slice(0, 8);
      const ids = summarised.map((m) => m.id);
      const texts = summarised.map((m) => m.content);
      let summary = null;
      if (typeof summarize === "function") {
        try {
          summary = await summarize(texts);
        } catch {
        }
      }
      const content = typeof summary === "string" ? normalizeContent(summary) : "";
      if (!content) {
        stats2.skippedGroups++;
        logger?.warn?.(`dsh-xiaofei-memory: distillation skipped "${entity}" (${ids.length} memories): summarizer returned no usable text`);
        continue;
      }
      const res = withTransaction(db, () => {
        const written = addMemory(db, {
          roleId,
          layer: "core",
          content,
          entities: Array.from(new Set(unique.flatMap((m) => m.entities ?? []))).slice(0, 16),
          originIds: ids,
          strength: 1,
          // The summary must be its own row: merging it into a row from `ids` used
          // to hand back that id, which the archive loop then archived and purged.
          noMerge: true
        });
        for (const id of ids) {
          if (isSeedMemoryId(id) || id === written?.id) continue;
          archiveMemory(db, id);
          archivedIds.add(id);
          stats2.archived++;
        }
        return written;
      });
      stats2.distilledGroups++;
      stats2.distilledMemories += ids.length;
      stats2.details.push({
        roleId,
        entity,
        count: ids.length,
        summary: content.slice(0, SUMMARY_MAX_CHARS),
        newId: res?.id ?? null,
        merged: res?.merged ?? false
      });
      logger?.info?.(
        `dsh-xiaofei-memory: distilled "${entity}" (${ids.length} memories -> ${res?.merged ? "merged" : "new"} ${String(res?.id ?? "?").slice(-6)}): ${content.slice(0, 60)}`
      );
    }
    purgeArchived(db, archiveRetentionMs === void 0 ? {} : { retentionMs: archiveRetentionMs });
    vacuumAndOptimize(db);
    stats2.vacuumed = true;
    return stats2;
  }
}

// src/evolution.js
var KEY_WEIGHT = "evolution.retrievalWeight";
var KEY_DECAY = "evolution.timeDecay";
var CORRECTION_RATIO_TRIGGER = 0.3;
var WEIGHT_STEP = 0.05;
var WEIGHT_MIN = 0.35;
var WEIGHT_MAX = 0.65;
var DECAY_STEP = 2e-3;
var DECAY_MAX = 0.05;
function loadEvolution(db) {
  const weight = Number(metaGet(db, KEY_WEIGHT) ?? WEIGHT_MAX);
  const decay = Number(metaGet(db, KEY_DECAY) ?? 0.01);
  return { retrievalWeight: clamp(weight, WEIGHT_MIN, WEIGHT_MAX), timeDecay: clamp(decay, 1e-3, DECAY_MAX) };
}
function runEvolution(db, stats = {}) {
  const { recallCount = 0, recallCorrections = 0 } = stats;
  const current = loadEvolution(db);
  let changed = false;
  if (recallCount > 0) {
    const ratio = recallCorrections / recallCount;
    if (ratio >= CORRECTION_RATIO_TRIGGER) {
      const nextWeight = clamp(current.retrievalWeight - WEIGHT_STEP, WEIGHT_MIN, WEIGHT_MAX);
      const nextDecay = clamp(current.timeDecay + DECAY_STEP, 1e-3, DECAY_MAX);
      if (nextWeight !== current.retrievalWeight || nextDecay !== current.timeDecay) {
        metaSet(db, KEY_WEIGHT, nextWeight);
        metaSet(db, KEY_DECAY, nextDecay);
        return { retrievalWeight: nextWeight, timeDecay: nextDecay, changed: true };
      }
    }
  }
  return { ...current, changed };
}

// src/core-memory.js
import { createHash } from "node:crypto";

// src/memory-index.js
var DEFAULT_INDEX_HEADER = "## \u8BB0\u5FC6\u7D22\u5F15\n\u4EE5\u4E0B\u8BB0\u5FC6\u672A\u5C55\u5F00\u3002\u9700\u8981\u5168\u6587\u65F6\u8C03\u7528 memory_core_read(id)\u3002";
var BUDGET_SAFETY_TOKENS = 6;
function shorten(text, chars) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const arr = Array.from(flat);
  if (arr.length <= chars) return flat;
  return arr.slice(0, chars).join("") + "\u2026";
}
function shortMemoryId(id) {
  const s = String(id ?? "");
  const lastUnderscore = s.lastIndexOf("_");
  if (lastUnderscore > 0 && s.length - lastUnderscore - 1 >= 4) return s.slice(lastUnderscore + 1);
  return s;
}
var CHAT_OPENERS = [
  "\u90A3\u597D",
  "\u597D\u554A",
  "\u597D\u7684",
  "\u597D\uFF0C",
  "\u597D!",
  "\u597D\uFF01",
  "\u884C\uFF0C",
  "\u55EF",
  "\u54E6",
  "\u5BF9\uFF0C",
  "\u5BF9\u7684",
  "\u6240\u4EE5",
  "\u5C31\u662F",
  "\u4F46\u662F",
  "\u7136\u540E",
  "\u8FD9\u4E2A",
  "\u90A3\u4E2A",
  "\u7EE7\u7EED",
  "\u53EF\u4EE5",
  "\u662F\u7684",
  "\u4E0D\u662F",
  "\u8FD9\u6B21",
  "\u521A\u624D",
  "\u4E0A\u9762",
  "\u4E0B\u9762",
  "\u6211\u4EEC",
  "\u4F60\u5148",
  "\u4F60\u5148",
  "\u4F60\u7EE7\u7EED",
  "ok",
  "OK",
  "Ok"
];
function isCatalogueWorthy(text, minChars) {
  const raw = String(text ?? "").trim();
  if (Array.from(raw).length < minChars) return false;
  const letters = (raw.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (letters < minChars * 0.5) return false;
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^\/[^\s]/.test(raw)) return false;
  const head = raw.slice(0, 4);
  return !CHAT_OPENERS.some((opener) => head.startsWith(opener));
}
function buildMemoryIndex(db, {
  roleIds = ["global"],
  excludeIds = [],
  maxTokens = 200,
  titleChars = 20,
  /** Rows shorter than this name no topic, so they are not worth a line. */
  minChars = 12,
  limit = 40,
  layers = ["core", "weekly"]
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
       ORDER BY pinned DESC,
                CASE layer WHEN 'core' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END,
                created_at DESC, id ASC
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
    if (raw.includes("<memory-recall>")) continue;
    if (!isCatalogueWorthy(raw, Math.max(4, Number(minChars) || 12))) continue;
    const line = `- [${r.layer}] ${shortMemoryId(r.id)} ${shorten(raw, cap)}`;
    const cost = tokenEstimate(line);
    if (cost <= 0) continue;
    if (used + cost > budget) break;
    out.push({
      id: String(r.id),
      short: shortMemoryId(r.id),
      layer: String(r.layer),
      title: shorten(raw, cap),
      chars: Array.from(raw).length
    });
    used += cost;
  }
  return out;
}
function renderMemoryIndex(entries, { header = DEFAULT_INDEX_HEADER } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  const lines = entries.map((e) => `- [${e.layer}] ${e.short} ${e.title}`);
  return `${header}
${lines.join("\n")}`;
}
function memoryIndexSignature(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return entries.map((e) => `${e.id}:${e.chars}`).join("|");
}
function resolveMemoryRef(db, ref, { roleIds, includeArchived = false } = {}) {
  const want = String(ref ?? "").trim();
  if (!want || !db) return null;
  const roles = Array.isArray(roleIds) && roleIds.length > 0 ? roleIds : null;
  const roleSql = roles ? ` AND role_id IN (${roles.map(() => "?").join(",")})` : "";
  const roleArgs = roles ?? [];
  const statusSql = includeArchived ? "" : " AND status = 'active'";
  try {
    const exact = db.prepare(
      `SELECT * FROM memories WHERE id = ?${statusSql}${roleSql}`
    ).get(want, ...roleArgs);
    if (exact) return exact;
    const rows = db.prepare(
      `SELECT * FROM memories WHERE 1 = 1${statusSql}${roleSql} AND id LIKE ? LIMIT 3`
    ).all(...roleArgs, `%${want}`);
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) {
      const exactTail = rows.filter((r) => shortMemoryId(r.id) === want);
      if (exactTail.length === 1) return exactTail[0];
    }
  } catch {
  }
  return null;
}

// src/core-memory.js
var INJECTED_MARKER = "<memory-recall>";
var DEFAULT_HEADER = "## \u5E38\u9A7B\u8BB0\u5FC6\n\u4EE5\u4E0B\u662F\u65E0\u9700\u68C0\u7D22\u3001\u59CB\u7EC8\u5728\u573A\u7684\u957F\u671F\u8BB0\u5FC6\u3002\u5B83\u4EEC\u662F\u80CC\u666F\u4E8B\u5B9E\uFF0C\u4E0D\u8981\u9010\u6761\u590D\u8FF0\u3002";
var BUDGET_SAFETY_TOKENS2 = 8;
function selectCoreMemories(db, {
  roleIds = ["global"],
  maxTokens = 700,
  maxItemChars = 400,
  minStrength = 1,
  limit = 12,
  pinnedOnly = true
} = {}) {
  if (!db) return [];
  const roles = Array.isArray(roleIds) && roleIds.length > 0 ? roleIds : ["global"];
  const placeholders = roles.map(() => "?").join(",");
  let rows;
  try {
    rows = db.prepare(
      `SELECT id, content, strength, created_at, pinned FROM memories
       WHERE status = 'active' AND layer = 'core'
         AND role_id IN (${placeholders})
         AND strength >= ?
         AND (? = 0 OR pinned = 1)
       ORDER BY pinned DESC, strength DESC, created_at DESC, id ASC
       LIMIT ?`
    ).all(...roles, Number(minStrength) || 0, pinnedOnly ? 1 : 0, Math.max(1, Number(limit) || 12));
  } catch {
    return [];
  }
  const budget = Math.max(0, (Number(maxTokens) || 0) - BUDGET_SAFETY_TOKENS2);
  const chosen = [];
  let used = 0;
  for (const row of rows) {
    const raw = typeof row.content === "string" ? row.content.trim() : "";
    if (!raw) continue;
    if (raw.includes(INJECTED_MARKER)) continue;
    const cap = Math.max(1, Number(maxItemChars) || 400);
    const content = raw.length > cap ? `${raw.slice(0, cap)}\u2026` : raw;
    const cost = tokenEstimate(content);
    if (cost <= 0) continue;
    if (used + cost > budget) continue;
    chosen.push({ id: row.id, content, strength: Number(row.strength) || 0 });
    used += cost;
    if (chosen.length >= Math.max(1, Number(limit) || 12)) break;
  }
  return chosen;
}
function renderCoreMemory(entries, { header = DEFAULT_HEADER } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  const lines = entries.map((e) => `- ${e.content}`);
  return `${header}
${lines.join("\n")}`;
}
function coreMemorySignature(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  const digest = createHash("sha1");
  for (const e of entries) {
    digest.update(String(e.id));
    digest.update("\0");
    digest.update(String(e.content));
    digest.update("");
  }
  return digest.digest("hex");
}
var CoreMemoryCache = class {
  constructor() {
    this.signature = null;
    this.text = "";
  }
  /**
   * @param {Array} entries - current selection
   * @param {object} [options] - forwarded to renderCoreMemory
   * @returns {string} stable text for this slice
   */
  update(entries, options = {}) {
    const indexEntries = Array.isArray(options.indexEntries) ? options.indexEntries : [];
    const signature = `${coreMemorySignature(entries)}#${memoryIndexSignature(indexEntries)}`;
    if (signature === this.signature) return this.text;
    const body = renderCoreMemory(entries, options);
    const index = renderMemoryIndex(indexEntries, { header: options.indexHeader });
    const next = [body, index].filter(Boolean).join("\n\n");
    this.signature = signature;
    this.text = next;
    return next;
  }
  /** Drop the cached text (used on dispose). */
  reset() {
    this.signature = null;
    this.text = "";
  }
};
var CORE_MEMORY_SECTION_NAME = "memory:core";
var CORE_MEMORY_SECTION_ORDER = 10150;
async function installCoreMemoryForAgent(agent, { db, config, resolveRoleIds, logger }) {
  if (!agent || !agent.ctx || typeof agent.ctx.inject !== "function") return null;
  let cache = new CoreMemoryCache();
  let disposed = false;
  const text = () => {
    if (disposed) return "";
    try {
      const roleIds = typeof resolveRoleIds === "function" ? resolveRoleIds(agent) : ["global"];
      const entries = selectCoreMemories(db, {
        roleIds,
        maxTokens: config.coreMemoryMaxTokens,
        maxItemChars: config.coreMemoryMaxItemChars,
        minStrength: config.coreMemoryMinStrength,
        pinnedOnly: config.coreMemoryPinnedOnly !== false
      });
      const indexEntries = config.enableMemoryIndex === false ? [] : buildMemoryIndex(db, {
        roleIds,
        excludeIds: entries.map((e) => e.id),
        maxTokens: config.memoryIndexMaxTokens,
        limit: config.memoryIndexLimit
      });
      return cache.update(entries, { indexEntries });
    } catch (e) {
      logger?.warn?.(`dsh-xiaofei-memory: core memory render failed: ${e?.message ?? e}`);
      return "";
    }
  };
  let fiber;
  try {
    fiber = agent.ctx.inject(["systemPrompt"], (scope) => {
      scope.systemPrompt.section({
        name: CORE_MEMORY_SECTION_NAME,
        order: CORE_MEMORY_SECTION_ORDER,
        // Render text verbatim: memory content may legitimately contain {{...}}.
        interpolate: false,
        text
      });
    });
  } catch (e) {
    logger?.warn?.(`dsh-xiaofei-memory: core memory install failed: ${e?.message ?? e}`);
    return null;
  }
  return {
    async dispose() {
      disposed = true;
      cache.reset();
      try {
        await fiber?.dispose?.();
      } catch {
      }
    }
  };
}
function registerCoreMemory({ ctx, db, config, resolveRoleIds, logger }) {
  const noop = async () => {
  };
  const fibers = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Set();
  const gone = /* @__PURE__ */ new Set();
  const installing = /* @__PURE__ */ new Set();
  const install = async (agent) => {
    if (!agent) return;
    if (fibers.has(agent) || installing.has(agent)) return;
    installing.add(agent);
    try {
      const handle = await installCoreMemoryForAgent(agent, { db, config, resolveRoleIds, logger });
      if (!handle) return;
      if (gone.has(agent)) {
        gone.delete(agent);
        await handle.dispose();
        return;
      }
      fibers.set(agent, handle);
    } finally {
      installing.delete(agent);
    }
  };
  const disposeAgent = (agent) => {
    const handle = fibers.get(agent);
    if (handle === void 0) {
      if (installing.has(agent)) gone.add(agent);
      return;
    }
    fibers.delete(agent);
    const task = handle.dispose().catch((e) => {
      logger?.warn?.(`dsh-xiaofei-memory: core memory cleanup failed: ${e?.message ?? e}`);
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  try {
    const agents = typeof ctx.get === "function" ? ctx.get("agents") : void 0;
    if (agents && typeof agents.list === "function") {
      for (const agent of agents.list()) {
        void install(agent).catch((e) => {
          logger?.warn?.(`dsh-xiaofei-memory: core memory adopt skipped: ${e?.message ?? e}`);
        });
      }
    }
    ctx.on("agent/created", async ({ agent }) => {
      try {
        await install(agent);
      } catch (e) {
        logger?.warn?.(`dsh-xiaofei-memory: core memory install skipped: ${e?.message ?? e}`);
      }
    });
    ctx.on("agent/disposed", ({ agent }) => {
      try {
        disposeAgent(agent);
      } catch (e) {
        logger?.warn?.(`dsh-xiaofei-memory: core memory dispose skipped: ${e?.message ?? e}`);
      }
    });
  } catch (e) {
    logger?.warn?.(`dsh-xiaofei-memory: core memory lifecycle wiring failed: ${e?.message ?? e}`);
    return noop;
  }
  return async () => {
    const handles = [...fibers.values()];
    fibers.clear();
    await Promise.all([
      ...handles.map((h) => h.dispose().catch(() => {
      })),
      ...pending
    ]);
  };
}

// src/console.js
function allRoleIds(db) {
  try {
    const roles = db.prepare("SELECT DISTINCT role_id FROM memories").all().map((r) => r.role_id);
    return roles.length > 0 ? roles : ["global"];
  } catch {
    return ["global"];
  }
}
var SLEEP_LOG_KEY = "sleepLog";
var SLEEP_LOG_MAX = 30;
function readSleepLog(db) {
  try {
    const parsed = JSON.parse(metaGet(db, SLEEP_LOG_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function recordSleepRun(db, stats) {
  const entry = {
    at: Date.now(),
    threshold: stats?.threshold ?? null,
    scanned: stats?.scanned ?? 0,
    distilledGroups: stats?.distilledGroups ?? 0,
    distilledMemories: stats?.distilledMemories ?? 0,
    archived: stats?.archived ?? 0,
    skippedEntities: stats?.skippedEntities ?? 0,
    skippedGroups: stats?.skippedGroups ?? 0,
    distillSkipped: stats?.distillSkipped ?? null,
    vacuumed: stats?.vacuumed === true,
    // Only the shape of what was distilled — entity, role, group size. The
    // summary text itself lives in the store as a normal memory.
    groups: Array.isArray(stats?.details) ? stats.details.map((d) => ({
      entity: String(d?.entity ?? ""),
      roleId: d?.roleId ?? null,
      count: Number(d?.count) || 0
    })) : []
  };
  try {
    withTransaction(db, () => {
      const log = readSleepLog(db);
      log.unshift(entry);
      metaSet(db, SLEEP_LOG_KEY, JSON.stringify(log.slice(0, SLEEP_LOG_MAX)));
    });
  } catch {
  }
  return entry;
}
function getSleepLog(db, { limit = SLEEP_LOG_MAX } = {}) {
  const log = readSleepLog(db);
  return log.slice(0, Math.max(1, Number(limit) || SLEEP_LOG_MAX));
}
function getMemoryStats(db) {
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
    evolution: loadEvolution(db)
  };
}
function searchMemory(db, { query, roleId = "global", limit = 12, decay = 0.01 }) {
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
    entities: r.entities ?? []
  }));
}
function previewRecall(db, { query, roleId = "global", maxTokens = 1200 }) {
  return retrieveForPrompt(db, {
    query,
    roleIds: roleId && roleId !== "all" ? [roleId, "global"] : allRoleIds(db),
    enableGraphRecall: true,
    maxTokens,
    limit: 8,
    weight: loadEvolution(db).retrievalWeight
  });
}
async function triggerNightlySleep(db, { summarize, logger, archiveRetentionMs, lease = true } = {}) {
  const stats = await runNightlySleep(db, { summarize, logger, archiveRetentionMs, lease });
  recordSleepRun(db, stats);
  metaSet(db, "meta.lastManualSleep", Date.now());
  return stats;
}
function getMemoryGraph(db, { roleId = "all", limit = 300, entitiesPerMemory = 6 } = {}) {
  const roleIds = roleId && roleId !== "all" ? [roleId, "global"] : null;
  const where = roleIds ? `WHERE status = 'active' AND role_id IN (${roleIds.map(() => "?").join(",")})` : `WHERE status = 'active'`;
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
    const ents = parseJsonList(r.entities).filter((e) => isMeaningfulEntity(e)).slice(0, Math.max(1, entitiesPerMemory));
    return {
      id: r.id,
      roleId: r.role_id,
      layer: r.layer,
      strength: Number(r.strength) || 0,
      createdAt: r.created_at,
      excerpt: String(r.content ?? "").replace(/\s+/g, " ").slice(0, 160),
      length: String(r.content ?? "").length,
      entities: ents
    };
  });
  const byEntity = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    for (const e of n.entities) {
      if (!byEntity.has(e)) byEntity.set(e, []);
      byEntity.get(e).push(n.id);
    }
  }
  const links = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [entity, ids] of byEntity) {
    if (ids.length < 2 || ids.length > 12) continue;
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
    layers: nodes.reduce((acc, n) => {
      acc[n.layer] = (acc[n.layer] || 0) + 1;
      return acc;
    }, {})
  };
}
function previewCoreMemory(db, { roleId = "global", maxTokens = 650, maxItemChars = 300, minStrength = 1, enableIndex = true, indexMaxTokens = 200, indexLimit = 40, pinnedOnly = true } = {}) {
  const roleIds = roleId && roleId !== "all" ? [roleId, "global"] : ["global"];
  const entries = selectCoreMemories(db, { roleIds, maxTokens, maxItemChars, minStrength, pinnedOnly });
  const indexEntries = enableIndex === false ? [] : buildMemoryIndex(db, {
    roleIds,
    excludeIds: entries.map((e) => e.id),
    maxTokens: indexMaxTokens,
    limit: indexLimit
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
    order: CORE_MEMORY_SECTION_ORDER
  };
}
function listSoulMemories(db) {
  const rows = db.prepare(
    "SELECT id, role_id, layer, content FROM memories WHERE id GLOB 'mem_0[0-9][0-9]' ORDER BY id ASC LIMIT 10"
  ).all();
  return rows;
}

// src/index.js
var name = "dsh-xiaofei-memory";
var inject = ["tools"];
function retentionMs(days) {
  const value = Number(days);
  const safe = Number.isFinite(value) && value >= 0 ? value : 7;
  return safe * 24 * 60 * 60 * 1e3;
}
var Config = z.object({
  /** Master switch: false disables injection, capture, sleep, and tools. */
  enabled: z.boolean().default(true),
  /** Override the SQLite path. Default: $DSH_HOME/plugin-data/dsh-xiaofei-memory/memory.sqlite. */
  dbPath: z.string().required(false),
  /** Independent extraction model name (PRD 4.1); requires useLlmExtraction. Volatile = editable in the console. */
  extractionModel: z.string().default("deepseek-chat").volatile(),
  /** Whether to use the LLM-backed extractor (default heuristic keeps it dependency-free). */
  useLlmExtraction: z.boolean().default(false),
  /**
   * Gate the nightly summariser separately from capture extraction.
   *
   * Turning on `useLlmExtraction` also sends every captured turn through the
   * model. Distillation only needs one call per group at 03:00, so it gets its
   * own switch: verification and real use do not have to pay the per-turn cost.
   */
  enableSleepSummarizer: z.boolean().default(false).volatile(),
  /** Damp factor applied on correction (PRD 4.3). */
  dampFactor: z.number().default(0.85),
  /** Time decay factor (PRD 4.2). */
  timeDecayFactor: z.number().default(0.01),
  /** 1-hop graph diffusion on/off (PRD 4.2). */
  enableGraphRecall: z.boolean().default(true),
  /** Nightly sleep hour, 0-23 (PRD 4.3). Volatile = editable in the console. */
  /**
   * How long a retired memory stays recoverable before the nightly pass deletes
   * it physically. A supersede decision can be wrong, and it used to be gone the
   * same night.
   */
  archiveRetentionDays: z.number().default(7).volatile(),
  sleepTimeHour: z.number().default(3).volatile(),
  /** Max tokens for a single recall injection (PRD 4.2). */
  maxRecallTokens: z.number().default(1200),
  /** Default role namespace when the session carries none. */
  roleId: z.string().default("global"),
  /** Tools whose execution counts as a correction signal (default none = opt-in). */
  correctionTools: z.array(z.string()).default([]),
  /** Always-on core memory: register a stable subset of core memories in the system prompt. */
  enableCoreMemory: z.boolean().default(true),
  /** Token budget for the always-on section (kept small: it is paid on every request). */
  coreMemoryMaxTokens: z.number().default(650),
  /** Per-item character cap for an always-on memory. */
  coreMemoryMaxItemChars: z.number().default(300),
  /** Minimum strength for a memory to be promoted to always-on. */
  coreMemoryMinStrength: z.number().default(1),
  /**
   * Restrict the always-on block to `pinned` rows (identity: the seeds plus
   * facts recorded through memory_core_add_fact). Off restores the old
   * "strongest and newest core rows" behaviour, which let captured chat fill
   * the budget and push identity out.
   */
  coreMemoryPinnedOnly: z.boolean().default(true),
  /** Second tier: a compact catalogue of memories that did not fit in full. */
  enableMemoryIndex: z.boolean().default(true),
  /** Token budget for the catalogue lines. */
  memoryIndexMaxTokens: z.number().default(200),
  /** Maximum catalogue entries. */
  memoryIndexLimit: z.number().default(40),
  /** Max primary recalls per injection. */
  recallLimit: z.number().default(8),
  /** Relevance floor for auto-injection: share of the query's bigrams that must
   *  appear in a memory before it is injected (0 disables the floor). */
  recallMinSim: z.number().default(0.3),
  /** Role registry for the management console. Volatile = editable in the console. */
  /**
   * Role namespaces. `enabled: false` switches a namespace off for real:
   * capture stops writing to it, retrieval and the always-on block stop reading
   * it, and an agent whose session role is disabled falls back to `global`.
   * Unknown namespaces stay enabled.
   */
  roles: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    description: z.string().default(""),
    enabled: z.boolean().default(true)
  })).default([
    { id: "global", name: "\u5168\u5C40", description: "\u8DE8\u89D2\u8272\u5171\u4EAB\u7684\u6838\u5FC3\u8BB0\u5FC6", enabled: true },
    { id: "companion", name: "\u5C0F\u80A5\u9C7C", description: "\u966A\u4F34\u4E0E\u60C5\u7EEA\u4EF7\u503C", enabled: true },
    { id: "work-assistant", name: "\u5F00\u53D1A", description: "\u4EFB\u52A1\u6D41\u8F6C\u4E0E\u591A\u89D2\u8272\u534F\u4F5C", enabled: true }
  ]).volatile()
});
var BUILD_STAMP = true ? "20261125071229" : "dev";
var LAST_SLEEP_KEY = "meta.lastSleepAt";
var RECALL_STATS_KEY = "meta.recallStats";
var EMPTY_RECALL_STATS = '{"count":0,"corrections":0}';
function readRecallStats(db) {
  try {
    const raw = metaGet(db, RECALL_STATS_KEY);
    if (!raw) return { count: 0, corrections: 0 };
    const parsed = JSON.parse(raw);
    return {
      count: Math.max(0, Number(parsed?.count) || 0),
      corrections: Math.max(0, Number(parsed?.corrections) || 0)
    };
  } catch {
    return { count: 0, corrections: 0 };
  }
}
function bumpRecallStats(db, delta = {}) {
  const addCount = Math.max(0, Number(delta.count) || 0);
  const addCorrections = Math.max(0, Number(delta.corrections) || 0);
  if (addCount === 0 && addCorrections === 0) return;
  try {
    withTransaction(db, () => {
      const current = readRecallStats(db);
      metaSet(db, RECALL_STATS_KEY, JSON.stringify({
        count: current.count + addCount,
        corrections: current.corrections + addCorrections
      }));
    });
  } catch {
  }
}
function defaultDbPath() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "plugin-data", "dsh-xiaofei-memory", "memory.sqlite");
}
async function apply(ctx, config) {
  for (const k of ["roles", "sleepTimeHour", "extractionModel"]) {
    const v = config[k];
    if (v && typeof v === "object" && typeof v.get === "function") {
      try {
        config[k] = v.get();
      } catch {
      }
    }
  }
  if (!config.enabled) {
    ctx.logger?.info?.("dsh-xiaofei-memory: disabled by config");
    return;
  }
  const dbPath = config.dbPath || defaultDbPath();
  const db = openMemoryDb(dbPath);
  const logger = ctx.logger;
  logger?.info?.(`dsh-xiaofei-memory: opened ${dbPath} (${countMemories(db)} active memories)`);
  const feedback = new FeedbackManager({ db, dampFactor: config.dampFactor, logger });
  let liveRoles = Array.isArray(config.roles) ? config.roles.map((r) => ({ ...r })) : [];
  const sessionRole = /* @__PURE__ */ new Map();
  const tracker = new CaptureTracker({
    // A disabled role stops accepting captures. Silently dropping is right
    // here: the alternative is storing memories the owner asked not to keep.
    store: (args) => isRoleEnabled(liveRoles, args?.roleId) ? addMemory(db, args) : null,
    roleOf: (sid) => sessionRole.get(sid) ?? config.roleId,
    logger,
    extractor: config.useLlmExtraction ? makeLlmExtractor(buildLlmCaller(ctx), { model: config.extractionModel }) : null
  });
  const lastInjected = /* @__PURE__ */ new Map();
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    try {
      if (signal?.aborted || !decision || decision.kind !== "enter") return decision;
      if (!decision.messages || decision.messages.length === 0) return decision;
      if (agent?.session?.header?.origin === "subagent") return decision;
      const userMsgs = decision.messages.filter((m) => m?.source?.kind === "user");
      if (userMsgs.length === 0) return decision;
      const query = userMsgs[userMsgs.length - 1]?.content?.filter((b) => b?.type === "text")?.map((b) => b?.text ?? "")?.join(" ") ?? "";
      if (!query.trim()) return decision;
      const roleId = agent?.session?.header?.roleId ?? config.roleId;
      const evolution = loadEvolution(db);
      const recall = retrieveForPrompt(db, {
        query,
        roleIds: [roleId, "global"],
        decay: evolution.timeDecay,
        weight: evolution.retrievalWeight,
        minSim: config.recallMinSim,
        enableGraphRecall: config.enableGraphRecall,
        maxTokens: config.maxRecallTokens,
        limit: config.recallLimit
      });
      if (!recall) return decision;
      const sid = agent?.session?.id ?? "anon";
      lastInjected.set(sid, recall.injectedIds);
      if (lastInjected.size > 500) {
        const oldest = lastInjected.keys().next().value;
        if (oldest !== void 0) lastInjected.delete(oldest);
      }
      for (const id of recall.injectedIds) touchAccessed(db, id);
      bumpRecallStats(db, { count: recall.injectedIds.length });
      let createUserMessage = null;
      try {
        ({ createUserMessage } = await import("@deepseek-ai/dsh-llm"));
      } catch {
      }
      const recallPayload = {
        content: [{ type: "text", text: recall.text }],
        source: { kind: "dsh-xiaofei-memory", form: "memory-recall", ids: recall.injectedIds }
      };
      const memoryMessage = typeof createUserMessage === "function" ? createUserMessage(recallPayload) : { role: "user", ...recallPayload, id: `dshxf-recall-${Date.now().toString(36)}` };
      const lastUser = userMsgs[userMsgs.length - 1];
      const rewritten = [...decision.messages];
      rewritten.splice(rewritten.indexOf(lastUser), 0, memoryMessage);
      return { ...decision, messages: rewritten };
    } catch (e) {
      try {
        logger?.warn?.(`dsh-xiaofei-memory: pre-step inject failed (fail-open): ${e?.message ?? e}`);
      } catch {
      }
      return decision;
    }
  });
  ctx.on("session/event", (session, event) => {
    if (session?.header?.origin === "subagent") return;
    const sid = session?.id ?? "anon";
    sessionRole.set(sid, session?.header?.roleId ?? config.roleId);
    if (sessionRole.size > 500) {
      const oldest = sessionRole.keys().next().value;
      if (oldest !== void 0) sessionRole.delete(oldest);
    }
    const flushed = tracker.onEvent(sid, event);
    if (!flushed) return;
    void flushed;
  });
  if (config.correctionTools.length > 0) {
    const correctionSet = new Set(config.correctionTools);
    ctx.on("tools/result", (exec, result) => {
      try {
        if (result?.isError) return;
        const toolName = exec?.tool?.name ?? exec?.name;
        if (!toolName || !correctionSet.has(toolName)) return;
        const sid = exec?.session?.id ?? exec?.agent?.session?.id;
        const ids = lastInjected.get(sid);
        if (!ids || ids.length === 0) return;
        for (const id of ids) feedback.damp(id);
        bumpRecallStats(db, { corrections: ids.length });
        logger?.info?.(`dsh-xiaofei-memory: correction via ${toolName}, damped ${ids.length} recalled memories`);
      } catch {
      }
    });
  }
  const disposeCoreMemory = await (async () => {
    if (!config.enableCoreMemory) return async () => {
    };
    try {
      return registerCoreMemory({
        ctx,
        db,
        config,
        // Role isolation: an agent's own roleId plus the shared global namespace.
        resolveRoleIds: (agent) => roleIdsForAgent(liveRoles, agent, config.roleId),
        logger
      });
    } catch (e) {
      logger?.warn?.(`dsh-xiaofei-memory: core memory disabled after error: ${e?.message ?? e}`);
      return async () => {
      };
    }
  })();
  let sleepTimer = null;
  const scheduleSleep = () => {
    if (sleepTimer) clearTimeout(sleepTimer);
    const now2 = Date.now();
    const hour = config.sleepTimeHour;
    const next = new Date(now2);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now2) next.setDate(next.getDate() + 1);
    sleepTimer = setTimeout(() => {
      void doSleep().finally(scheduleSleep);
    }, next.getTime() - now2);
    if (typeof sleepTimer?.unref === "function") sleepTimer.unref();
  };
  const doSleep = async () => {
    try {
      const summarize = buildSummarizer(ctx, config);
      const stats = await runNightlySleep(db, { summarize, logger, lease: true, archiveRetentionMs: retentionMs(config.archiveRetentionDays) });
      recordSleepRun(db, stats);
      const recallStats = readRecallStats(db);
      const evolved = runEvolution(db, {
        recallCount: recallStats.count,
        recallCorrections: recallStats.corrections
      });
      metaSet(db, LAST_SLEEP_KEY, Date.now());
      metaSet(db, RECALL_STATS_KEY, EMPTY_RECALL_STATS);
      logger?.info?.(`dsh-xiaofei-memory: nightly sleep done (${JSON.stringify(stats)}), evolution changed=${evolved.changed}`);
    } catch (e) {
      try {
        logger?.warn?.(`dsh-xiaofei-memory: nightly sleep failed: ${e?.message ?? e}`);
      } catch {
      }
    }
  };
  const lastSleep = Number(metaGet(db, LAST_SLEEP_KEY) ?? 0);
  if (lastSleep === 0 || Date.now() - lastSleep > 24 * 3600 * 1e3) {
    queueMicrotask(() => void doSleep());
  }
  scheduleSleep();
  const configWriter = (key, value) => {
    config[key] = value;
  };
  registerSettingsSection(ctx, { Config, config, liveRoles, setLiveRoles: (r) => {
    liveRoles = r;
  }, configWriter, logger });
  const core = {
    retrieve(query, opts = {}) {
      const evolution = loadEvolution(db);
      return retrieveForPrompt(db, {
        query,
        roleIds: opts.roleIds ?? [config.roleId, "global"],
        decay: evolution.timeDecay,
        weight: evolution.retrievalWeight,
        minSim: opts.minSim ?? config.recallMinSim,
        enableGraphRecall: config.enableGraphRecall,
        maxTokens: opts.maxTokens ?? config.maxRecallTokens,
        limit: opts.limit ?? config.recallLimit
      });
    },
    addFact({ content, roleId, layer = "recent", entities = [] }) {
      const target = roleId ?? config.roleId;
      if (!isRoleEnabled(liveRoles, target)) return null;
      return addMemory(db, {
        roleId: target,
        layer,
        content,
        entities,
        pinned: layer === "core"
      });
    },
    damp(id) {
      return feedback.damp(id);
    },
    stats() {
      return { active: countMemories(db), evolution: loadEvolution(db) };
    },
    // --- Management console API ---
    getAllRoles() {
      return liveRoles.map((r) => ({ ...r }));
    },
    updateRoles(roles) {
      const next = Array.isArray(roles) ? roles.map((r) => ({ id: String(r.id ?? ""), name: String(r.name ?? ""), description: String(r.description ?? ""), enabled: r.enabled !== false })).filter((r) => r.id && r.name) : [];
      liveRoles = next;
      configWriter("roles", next.map((r) => ({ ...r })));
      logger?.info?.(`dsh-xiaofei-memory: roles updated (${next.length})`);
      return next.map((r) => ({ ...r }));
    },
    getMemoryStats() {
      return getMemoryStats(db);
    },
    searchMemory(query, roleId) {
      return searchMemory(db, { query, roleId, decay: loadEvolution(db).timeDecay });
    },
    previewRecall(query, roleId) {
      return previewRecall(db, { query, roleId, maxTokens: config.maxRecallTokens });
    },
    triggerNightlySleep() {
      const summarize = buildSummarizer(ctx, config);
      return triggerNightlySleep(db, { summarize, lease: true, archiveRetentionMs: retentionMs(config.archiveRetentionDays) });
    },
    listSoulMemories() {
      return listSoulMemories(db);
    },
    db
  };
  ctx.provide("memory-core", core);
  ctx.provide("memoryConsole", {
    getAllRoles: () => liveRoles.map((r) => ({ ...r })),
    updateRoles: (roles) => core.updateRoles(roles),
    getMemoryStats: () => getMemoryStats(db),
    searchMemory: (query, roleId) => searchMemory(db, { query, roleId, decay: loadEvolution(db).timeDecay }),
    previewRecall: (query, roleId) => previewRecall(db, { query, roleId, maxTokens: config.maxRecallTokens }),
    triggerNightlySleep: () => core.triggerNightlySleep(),
    listSoulMemories: () => listSoulMemories(db),
    // Kept so an older client bundle does not fail on a missing service; it no
    // longer writes a temp log. The shipping client stopped calling it.
    probe() {
      return true;
    }
  });
  const bridgeToken = randomBytes(16).toString("hex");
  try {
    metaSet(db, "bridge.token", bridgeToken);
  } catch {
  }
  const setBridgeStatus = (status) => {
    try {
      metaSet(db, "bridge.status", status);
    } catch {
    }
  };
  setBridgeStatus("waiting");
  try {
    metaSet(db, "bridge.build", BUILD_STAMP);
  } catch {
  }
  const sendJson = (res, status, body) => {
    try {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    } catch {
    }
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1 << 20) {
        reject(new Error("payload too large"));
        try {
          req.destroy();
        } catch {
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
  const runBridgeOp = async (op, args) => {
    switch (op) {
      case "stats":
        return getMemoryStats(db);
      case "sleeplog":
        return getSleepLog(db, { limit: Number(args?.limit) || 30 });
      case "search":
        return searchMemory(db, { query: String(args?.query ?? ""), roleId: args?.roleId ?? "all", decay: loadEvolution(db).timeDecay });
      case "preview":
        return previewRecall(db, { query: String(args?.query ?? ""), roleId: args?.roleId ?? "all", maxTokens: config.maxRecallTokens });
      case "build":
        return { build: BUILD_STAMP };
      case "graph":
        return getMemoryGraph(db, {
          roleId: String(args?.roleId ?? "all"),
          limit: Number(args?.limit) || 300
        });
      case "core":
        return previewCoreMemory(db, {
          roleId: String(args?.roleId ?? config.roleId),
          maxTokens: config.coreMemoryMaxTokens,
          maxItemChars: config.coreMemoryMaxItemChars,
          minStrength: config.coreMemoryMinStrength,
          pinnedOnly: config.coreMemoryPinnedOnly !== false
        });
      case "sleep": {
        const summarize = buildSummarizer(ctx, config);
        return triggerNightlySleep(db, { summarize, lease: true, archiveRetentionMs: retentionMs(config.archiveRetentionDays) });
      }
      case "souls":
        return listSoulMemories(db);
      case "roles":
        return liveRoles.map((r) => ({ ...r }));
      case "updateRoles":
        return core.updateRoles(args?.roles);
      case "config":
        return {
          roles: liveRoles.map((r) => ({ ...r })),
          enabled: config.enabled,
          sleepTimeHour: config.sleepTimeHour,
          extractionModel: config.extractionModel
        };
      default:
        throw new Error(`unknown op "${op}"`);
    }
  };
  ctx.on("webserver/index-inject", (table) => {
    try {
      table.push({ kind: "global", name: "DSHXF_BRIDGE", value: { token: bridgeToken } });
    } catch {
    }
  });
  try {
    ctx.inject(["webServer"], (injected) => {
      let webServer;
      try {
        webServer = typeof injected.get === "function" ? injected.get("webServer") : void 0;
      } catch {
      }
      webServer ??= injected.webServer;
      if (!webServer || typeof webServer.register !== "function") {
        setBridgeStatus("no-service");
        logger?.warn?.("dsh-xiaofei-memory: console data bridge skipped (no webServer.register)");
        return;
      }
      let disposeBridge;
      try {
        disposeBridge = webServer.register({
          kind: "exact",
          path: "/dshxf/bridge",
          handler: (req, res) => {
            void (async () => {
              try {
                if (req.method === "GET") {
                  sendJson(res, 200, { ok: true, bridge: "dsh-xiaofei-memory" });
                  return;
                }
                if (req.method !== "POST") {
                  sendJson(res, 405, { ok: false, error: "method not allowed" });
                  return;
                }
                let authorized = false;
                let connection;
                try {
                  connection = typeof ctx.get === "function" ? ctx.get("connection") : void 0;
                } catch {
                }
                if (connection && typeof connection.admit === "function") {
                  let admission;
                  try {
                    admission = connection.admit(req);
                  } catch {
                    admission = void 0;
                  }
                  if (admission && "rejection" in admission) {
                    sendJson(res, admission.rejection ?? 401, { ok: false, error: "unauthorized" });
                    return;
                  }
                  authorized = admission !== void 0;
                }
                if (!authorized && String(req.headers["x-dshxf-token"] ?? "") !== bridgeToken) {
                  sendJson(res, 403, { ok: false, error: "forbidden" });
                  return;
                }
                const body = await readBody(req);
                const result = await runBridgeOp(String(body?.op ?? ""), body?.args ?? {});
                sendJson(res, 200, { ok: true, result });
              } catch (e) {
                sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
              }
            })();
          }
        });
      } catch (e) {
        setBridgeStatus(`error:${String(e?.message ?? e).slice(0, 120)}`);
        logger?.warn?.(`dsh-xiaofei-memory: console data bridge register failed: ${e?.message ?? e}`);
        return;
      }
      setBridgeStatus("mounted");
      logger?.info?.("dsh-xiaofei-memory: console data bridge mounted at /dshxf/bridge");
      return () => {
        try {
          disposeBridge?.();
        } catch {
        }
      };
    });
  } catch (e) {
    logger?.warn?.(`dsh-xiaofei-memory: console data bridge unavailable: ${e?.message ?? e}`);
  }
  const disposeRetrieve = ctx.tools.register({
    name: "memory_core_retrieve",
    description: "\u4ECE\u957F\u671F\u8BB0\u5FC6\u4E2D\u68C0\u7D22\u4E0E\u5F53\u524D\u95EE\u9898\u76F8\u5173\u7684\u8BB0\u5FC6\uFF0C\u8FD4\u56DE\u53EF\u6CE8\u5165\u7684 <memory-recall> \u6587\u672C\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "\u68C0\u7D22\u67E5\u8BE2\uFF08\u5F53\u524D\u7528\u6237\u95EE\u9898\u6216\u5173\u952E\u8BCD\uFF09\u3002" },
        limit: { type: "integer", default: 8, description: "\u4E3B\u68C0\u7D22\u6761\u6570\u4E0A\u9650\u3002" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          recalled: { type: "integer" },
          text: { type: "string" }
        }
      },
      // The recalled text IS the result of an explicit retrieve call; the old
      // render only pointed at the auto-injected block, which cost the caller
      // the whole payload.
      render: (_args, v) => [{ type: "text", text: v?.ok ? v.text || "\uFF08\u6CA1\u6709\u547D\u4E2D\u8BB0\u5FC6\uFF09" : "\u68C0\u7D22\u5931\u8D25\u3002" }]
    },
    async execute(args, exec) {
      const evolution = loadEvolution(db);
      const recall = retrieveForPrompt(db, {
        query: args?.query,
        // The caller's own namespace, not the configured default: an agent
        // working in another role used to read global only.
        roleIds: roleIdsForAgent(liveRoles, exec?.agent, config.roleId),
        decay: evolution.timeDecay,
        weight: evolution.retrievalWeight,
        minSim: config.recallMinSim,
        enableGraphRecall: config.enableGraphRecall,
        maxTokens: config.maxRecallTokens,
        limit: args?.limit ?? config.recallLimit
      });
      return { ok: recall !== null, recalled: recall?.recalled ?? 0, text: recall?.text ?? "" };
    }
  });
  const disposeAddFact = ctx.tools.register({
    name: "memory_core_add_fact",
    description: "\u5411\u957F\u671F\u8BB0\u5FC6\u5199\u5165\u4E00\u6761\u4E8B\u5B9E\uFF08\u4F9B\u5916\u90E8\u8C03\u7528\uFF0C\u7B49\u540C memory_remember\uFF09\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: { type: "string", description: "\u8BB0\u5FC6\u6B63\u6587\u3002" },
        roleId: { type: "string", description: "\u89D2\u8272\u547D\u540D\u7A7A\u95F4\uFF0C\u9ED8\u8BA4 global\u3002" },
        layer: { type: "string", enum: ["core", "weekly", "recent"], default: "recent" },
        entities: { type: "array", items: { type: "string" }, description: "\u5B9E\u4F53\u5217\u8868\u3002" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          id: { type: "string" },
          merged: { type: "boolean" }
        }
      },
      render: (_args, v) => [{
        type: "text",
        text: v?.ok ? `\u5DF2\u5199\u5165\uFF08${v?.id?.slice(-6) ?? ""}\uFF09${v?.merged ? "\uFF0C\u5DF2\u5408\u5E76\u5230\u5DF2\u6709\u6761\u76EE" : ""}\u3002` : "\u5199\u5165\u5931\u8D25\u3002"
      }]
    },
    async execute(args, exec) {
      const own = exec?.agent?.session?.header?.roleId;
      const requested = String(args?.roleId ?? "").trim();
      const roleId = requested && (requested === own || requested === "global" || own === void 0) ? requested : own ?? config.roleId;
      const res = core.addFact({
        roleId,
        layer: args?.layer ?? "recent",
        content: args?.content,
        entities: Array.isArray(args?.entities) ? args.entities : []
      });
      if (!res) return { ok: false };
      return { ok: true, id: res?.id, merged: res?.merged ?? false };
    }
  });
  const disposeRead = ctx.tools.register({
    name: "memory_core_read",
    description: "\u6309 id \u8BFB\u53D6\u4E00\u6761\u957F\u671F\u8BB0\u5FC6\u7684\u5B8C\u6574\u5185\u5BB9\uFF08id \u89C1\u7CFB\u7EDF\u63D0\u793A\u8BCD\u4E2D\u7684\u300C\u8BB0\u5FC6\u7D22\u5F15\u300D\uFF09\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: "\u8BB0\u5FC6 id\uFF0C\u53EF\u4F20\u7D22\u5F15\u91CC\u7684\u77ED id \u6216\u5B8C\u6574 id\u3002" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          id: { type: "string" },
          layer: { type: "string" },
          roleId: { type: "string" },
          strength: { type: "number" },
          content: { type: "string" },
          archived: { type: "boolean" },
          supersededBy: { type: "string" },
          preview: { type: "string" }
        }
      },
      render: (_args, v) => [{
        type: "text",
        text: v?.ok ? `[${v.layer} \xB7 ${v.roleId} \xB7 s=${Number(v.strength).toFixed(2)}] ${v.content}` : v?.archived ? `\u8BE5\u8BB0\u5FC6\u5DF2\u5F52\u6863${v.supersededBy ? `\uFF08\u88AB ${v.supersededBy} \u53D6\u4EE3\uFF09` : ""}\uFF0C\u53EF\u8C03\u7528 memory_core_restore \u6062\u590D\uFF1A${v.preview ?? ""}` : "\u672A\u627E\u5230\u8BE5\u8BB0\u5FC6\uFF08\u53EF\u80FD\u5DF2\u5F52\u6863\u6216 id \u6709\u6B67\u4E49\uFF09\u3002"
      }]
    },
    async execute(args, exec) {
      const roleIds = roleIdsForAgent(liveRoles, exec?.agent, config.roleId);
      const row = resolveMemoryRef(db, args?.id, { roleIds });
      if (!row) {
        const retired = resolveMemoryRef(db, args?.id, { roleIds, includeArchived: true });
        if (retired && retired.status !== "active") {
          return {
            ok: false,
            archived: true,
            id: String(retired.id),
            supersededBy: retired.superseded_by ? String(retired.superseded_by) : void 0,
            preview: String(retired.content ?? "").slice(0, 120)
          };
        }
        return { ok: false };
      }
      return {
        ok: true,
        id: String(row.id),
        layer: String(row.layer),
        roleId: String(row.role_id),
        strength: Number(row.strength) || 0,
        content: String(row.content ?? "")
      };
    }
  });
  const disposeRestore = ctx.tools.register({
    name: "memory_core_restore",
    description: "\u6062\u590D\u4E00\u6761\u5728\u4FDD\u7559\u671F\u5185\u88AB\u5F52\u6863\uFF08\u53D6\u4EE3\uFF09\u7684\u957F\u671F\u8BB0\u5FC6\u3002\u5F52\u6863\u8D85\u8FC7\u4FDD\u7559\u671F\u7684\u8BB0\u5FC6\u65E0\u6CD5\u6062\u590D\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: "\u8BB0\u5FC6 id \u6216\u7D22\u5F15\u91CC\u7684\u77ED id\u3002" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          id: { type: "string" },
          reason: { type: "string" },
          content: { type: "string" }
        }
      },
      render: (_args, v) => [{
        type: "text",
        text: v?.ok ? `\u5DF2\u6062\u590D\uFF08${String(v.id).slice(-6)}\uFF09\uFF1A${String(v.content ?? "").slice(0, 120)}` : v?.reason === "already-active" ? "\u8BE5\u8BB0\u5FC6\u672C\u6765\u5C31\u662F\u6D3B\u8DC3\u72B6\u6001\uFF0C\u65E0\u9700\u6062\u590D\u3002" : v?.reason === "expired" ? "\u8BE5\u8BB0\u5FC6\u7684\u4FDD\u7559\u671F\u5DF2\u8FC7\uFF0C\u65E0\u6CD5\u6062\u590D\u3002" : "\u672A\u627E\u5230\u8BE5\u8BB0\u5FC6\u3002"
      }]
    },
    async execute(args, exec) {
      const roleIds = roleIdsForAgent(liveRoles, exec?.agent, config.roleId);
      const row = resolveMemoryRef(db, args?.id, { roleIds, includeArchived: true });
      if (!row) return { ok: false, reason: "not-found" };
      if (row.status === "active") return { ok: true, id: String(row.id), reason: "already-active", content: String(row.content ?? "") };
      const window = retentionMs(config.archiveRetentionDays);
      const retiredAt = Number(row.archived_at) || 0;
      if (retiredAt > 0 && Date.now() - retiredAt > window) {
        return { ok: false, reason: "expired", id: String(row.id) };
      }
      const restored = restoreMemory(db, row.id);
      if (!restored) return { ok: false, reason: "not-found" };
      return { ok: true, id: String(row.id), content: String(row.content ?? "") };
    }
  });
  ctx.effect(() => () => {
    if (sleepTimer) clearTimeout(sleepTimer);
    feedback.dispose();
    if (typeof disposeRetrieve === "function") disposeRetrieve();
    if (typeof disposeRestore === "function") disposeRestore();
    if (typeof disposeAddFact === "function") disposeAddFact();
    if (typeof disposeRead === "function") disposeRead();
    try {
      void disposeCoreMemory?.();
    } catch {
    }
    closeMemoryDb(db);
  });
}
function buildSummarizer(ctx, config) {
  if (!config.enableSleepSummarizer && !config.useLlmExtraction) return null;
  return buildSleepSummarizer(buildLlmCaller(ctx), config.extractionModel);
}
function buildLlmCaller(ctx) {
  const llm = ctx.get?.("llm");
  if (!llm) return null;
  return async (prompt, { model } = {}) => {
    if (typeof llm.complete === "function") {
      return llm.complete(prompt, { model });
    }
    return null;
  };
}
function buildSleepSummarizer(callLlm, model) {
  if (typeof callLlm !== "function") return null;
  return async (texts) => {
    const prompt = `\u628A\u4E0B\u9762\u8FD9\u51E0\u6761\u76F8\u5173\u8BB0\u5FC6\u538B\u7F29\u6210\u4E00\u53E5\u4E0D\u8D85\u8FC7100\u5B57\u7684\u8981\u70B9\uFF08\u4FDD\u7559\u6838\u5FC3\u5B9E\u4F53\u4E0E\u56E0\u679C\uFF0C\u4E0D\u8981\u5217\u4E3E\uFF09\uFF1A
${texts.join("\n")}`;
    return callLlm(prompt, { model });
  };
}
function registerSettingsSection(ctx, { Config: Config2, config, liveRoles, setLiveRoles, configWriter, logger }) {
  let settings;
  try {
    settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
  } catch {
    settings = void 0;
  }
  if (!settings) {
    logger?.warn?.("dsh-xiaofei-memory: settings service unavailable; console config write disabled");
    return;
  }
  const ns = "dsh-xiaofei-memory";
  const entry = { ...config, roles: liveRoles };
  const hooks = {
    onChange: () => {
    },
    setSource: (getter) => {
      const read = () => {
        try {
          return getter();
        } catch {
          return void 0;
        }
      };
      const applyValue = (v) => {
        if (!v || typeof v !== "object") return;
        for (const [k, val] of Object.entries(v)) {
          if (k === "roles" && Array.isArray(val)) {
            setLiveRoles(val.map((r) => ({ ...r })));
          } else if (k in config) {
            config[k] = val;
          }
        }
      };
      configWriter._readSource = read;
      applyValue(read());
    }
  };
  try {
    if (typeof settings.installSection === "function") {
      settings.installSection(ctx, ns, Config2, entry, hooks);
      logger?.info?.("dsh-xiaofei-memory: settings section registered (installSection)");
      return;
    }
    if (typeof settings.register === "function") {
      settings.register(ns, Config2, { base: entry, validate: hooks });
      logger?.info?.("dsh-xiaofei-memory: settings section registered (register)");
      return;
    }
    logger?.warn?.("dsh-xiaofei-memory: settings service lacks installSection/register");
  } catch (e) {
    logger?.warn?.(`dsh-xiaofei-memory: settings section registration failed: ${e?.message ?? e}`);
  }
}
export {
  Config,
  apply,
  inject,
  name
};
