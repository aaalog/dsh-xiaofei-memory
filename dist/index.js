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
function tokenEstimate(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length;
  const latin = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, " ").split(/\s+/).filter(Boolean).length;
  return cjk + latin;
}
function similarity(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  if (a.length === 0 || b.length === 0) return 0;
  const grams = (s) => {
    const set = /* @__PURE__ */ new Set();
    const chars = Array.from(s);
    if (chars.length === 1) return /* @__PURE__ */ new Set([chars[0]]);
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
  status        TEXT NOT NULL DEFAULT 'active'
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
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
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
function openMemoryDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  seedIfEmpty(db);
  return db;
}
function seedIfEmpty(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM memories").get();
  if (row && row.n > 0) return;
  const insert = db.prepare(
    "INSERT INTO memories (id, role_id, layer, content, entities, strength, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')"
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
function addMemory(db, { roleId = "global", layer = "recent", content, entities = [], originIds = [], strength = 1 }) {
  const text = normalizeContent(content);
  if (!text) throw new Error("memory content is empty");
  const candidates = db.prepare(
    "SELECT id, content, role_id FROM memories WHERE role_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 20"
  ).all(roleId);
  for (const c of candidates) {
    const sim = similarity(text, c.content);
    if (sim >= 0.92) {
      const existing = getMemory(db, c.id);
      const mergedEntities = Array.from(/* @__PURE__ */ new Set([...existing.entities ?? [], ...entities])).slice(0, 20);
      const mergedStrength = clamp((existing.strength ?? 1) + 0.1, 0.1, 5);
      const mergedOrigin = Array.from(/* @__PURE__ */ new Set([...existing.originIds ?? [], ...originIds])).slice(-20);
      db.prepare(
        "UPDATE memories SET strength = ?, entities = ?, origin_ids = ?, last_accessed = ? WHERE id = ?"
      ).run(mergedStrength, toJsonList(mergedEntities), toJsonList(mergedOrigin), now(), c.id);
      replaceEntities(db, c.id, mergedEntities);
      return { id: c.id, merged: true };
    }
    if (sim >= 0.75) {
      db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(c.id);
      break;
    }
  }
  const id = newId();
  db.prepare(
    "INSERT INTO memories (id, role_id, layer, content, entities, origin_ids, strength, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')"
  ).run(id, roleId, layer, text, toJsonList(entities), toJsonList(originIds), strength, now());
  replaceEntities(db, id, entities);
  return { id, merged: false };
}
function replaceEntities(db, memoryId, entities) {
  db.prepare("DELETE FROM entity_index WHERE memory_id = ?").run(memoryId);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO entity_index (entity, memory_id, confidence) VALUES (?, ?, ?)"
  );
  for (const e of Array.from(new Set(entities)).slice(0, 20)) {
    ins.run(e, memoryId, 1);
  }
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
function archiveMemory(db, id) {
  db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(id);
}
function touchAccessed(db, id) {
  db.prepare("UPDATE memories SET last_accessed = ? WHERE id = ?").run(now(), id);
}
function searchMemories(db, query, roleIds, { decay = 0.01, limit = 8 } = {}) {
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
        `SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.status = 'active' AND ${roleIn}`
      ).all(ftsTerms, ...roles);
      for (const r of ftsRows) candidateIds.add(r.id);
    } catch {
    }
  }
  const terms = tokenizeQuery(q);
  if (terms.length > 0) {
    const likeSql = `SELECT m.id FROM memories m WHERE m.status = 'active' AND ${roleIn} AND m.content LIKE ? ESCAPE '\\'`;
    for (const t of terms) {
      try {
        const rows2 = db.prepare(likeSql).all(`%${escapeLike(t)}%`, ...roles);
        for (const r of rows2) candidateIds.add(r.id);
      } catch {
      }
    }
  }
  let rows;
  if (candidateIds.size === 0) {
    rows = db.prepare(
      `SELECT m.* FROM memories m WHERE m.status = 'active' AND ${roleIn}
       ORDER BY m.created_at DESC LIMIT 200`
    ).all(...roles);
  } else {
    const idPlaceholders = Array.from(candidateIds).map(() => "?").join(",");
    rows = db.prepare(
      `SELECT m.* FROM memories m WHERE m.id IN (${idPlaceholders})`
    ).all(...Array.from(candidateIds));
  }
  const scored = rows.map((r) => {
    const sim = similarity(q, r.content);
    const score = (0.35 + 0.65 * sim) * (r.strength ?? 1) * timeDecay(r.created_at, decay);
    return { ...r, entities: parseJsonList(r.entities), _score: score, _sim: sim };
  });
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
function purgeArchived(db) {
  db.prepare("DELETE FROM memories WHERE status = 'archived'").run();
}
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
function tokenizeQuery(text) {
  const out = /* @__PURE__ */ new Set();
  const parts = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const p of parts) {
    if (/[\u4e00-\u9fff]/.test(p)) {
      out.add(p);
      const chars = Array.from(p);
      for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
    } else if (p.length >= 2) {
      out.add(p);
    }
  }
  return Array.from(out).slice(0, 24);
}
function buildFtsQuery(text) {
  const terms = /* @__PURE__ */ new Set();
  const parts = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const p of parts) {
    if (/[\u4e00-\u9fff]/.test(p)) {
      if (p.length >= 3) terms.add(p);
    } else if (p.length >= 3) {
      terms.add(p);
    }
  }
  if (terms.size === 0) return "";
  return Array.from(terms).slice(0, 12).map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

// src/index.js
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";

// src/retrieval.js
var LAYER_PRIORITY = { core: 0, weekly: 1, recent: 2, diffusion: 3 };
var INTROSPECTION_RE = /(我是谁|你是谁|我的角色|我的身份|我是什么|我是干什么|我是什么人|我的存在|我的使命|我为什么在这里|我是做什么)/;
var IDENTITY_ENTITIES = ["\u8D5B\u535A\u6218\u53CB", "\u966A\u4F34", "\u89D2\u8272", "\u8EAB\u4EFD", "\u5B58\u5728\u610F\u4E49", "\u6218\u53CB", "\u6E29\u6696", "\u672C\u6E90", "\u5951\u7EA6", "\u591A\u89D2\u8272\u534F\u4F5C"];
function retrieveForPrompt(db, {
  query,
  roleIds = ["global"],
  decay = 0.01,
  enableGraphRecall = true,
  maxTokens = 1200,
  limit = 8
} = {}) {
  if (!query) return null;
  const primary = searchMemories(db, query, roleIds, { decay, limit });
  const primaryIds = primary.map((m) => m.id);
  const floor = INTROSPECTION_RE.test(query) ? searchByEntities(db, IDENTITY_ENTITIES, roleIds, { limit: 4, excludeIds: primaryIds }) : [];
  let diffused = [];
  if (enableGraphRecall && primary.length > 0) {
    const topEntities = primary.slice(0, 3).flatMap((m) => m.entities ?? []).slice(0, 12);
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

// src/capture.js
var IMPORTANCE_CORE_RE = /(记住|永远|务必|重要|核心|关键|红线|必须|一定|教训|原则|准则|决定)/;
var IMPORTANCE_WEEKLY_RE = /(计划|项目|目标|方案|架构|设计|开发|部署|长期|后续|接下来|打算)/;
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
      const text = (data?.content ?? []).filter((b) => b?.type === "text" && typeof b?.text === "string").map((b) => b.text).join("\n");
      if (!text.trim()) return false;
      const source = data?.source;
      if (source?.kind && String(source.kind).startsWith("memory")) return false;
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
    let extracted = null;
    if (typeof this.extractor === "function") {
      try {
        extracted = await this.extractor(source, { userText, assistantText, sessionId });
      } catch {
      }
    }
    const entities = (extracted?.entities?.length ? extracted.entities : extractEntities(source)).slice(0, 16);
    const layer = extracted?.layer ?? inferLayer(source);
    const content = normalizeContent(extracted?.content ?? source);
    const res = this.store({ roleId, layer, content, entities });
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
  const tokens = tokenEstimate(t);
  if (IMPORTANCE_CORE_RE.test(t)) return "core";
  if (IMPORTANCE_WEEKLY_RE.test(t) || tokens >= 60) return "weekly";
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
    const current = adjustStrength(this.db, memoryId, "multiply", this.dampFactor);
    if (current === null) return false;
    const pending = this.pending.get(memoryId);
    if (pending?.timer) clearTimeout(pending.timer);
    const target = current / this.dampFactor;
    const timer = setTimeout(() => {
      this.pending.delete(memoryId);
      if (!this.pending.has(memoryId)) {
        adjustStrength(this.db, memoryId, "multiply", 1 / this.dampFactor);
      }
    }, this.recoveryMs);
    if (typeof timer?.unref === "function") timer.unref();
    this.pending.set(memoryId, { original: target, timer });
    this.logger?.info?.(`dsh-xiaofei-memory: damped memory ${String(memoryId).slice(-6)}`);
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
var DISTILL_THRESHOLD = 10;
var SUMMARY_MAX_CHARS = 100;
async function runNightlySleep(db, { summarize, layer = "recent" } = {}) {
  const stats = { distilledGroups: 0, distilledMemories: 0, archived: 0, vacuumed: false };
  const groups = /* @__PURE__ */ new Map();
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
    const texts = unique.slice().sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0)).slice(0, 8).map((m) => m.content);
    let summary = null;
    if (typeof summarize === "function") {
      try {
        summary = await summarize(texts);
      } catch {
      }
    }
    const content = normalizeContent(summary || heuristicSummary(texts));
    if (!content) continue;
    const res = addMemory(db, {
      roleId: unique[0].role_id ?? "global",
      layer: "core",
      content,
      entities: Array.from(new Set(unique.flatMap((m) => m.entities ?? []))).slice(0, 16),
      originIds: ids,
      strength: 1
    });
    for (const id of ids) archiveMemory(db, id);
    stats.distilledGroups++;
    stats.distilledMemories += ids.length;
    stats.archived += ids.length;
  }
  purgeArchived(db);
  vacuumAndOptimize(db);
  stats.vacuumed = true;
  return stats;
}
function heuristicSummary(texts) {
  const joined = texts.join("\uFF1B");
  const chars = Array.from(joined);
  if (chars.length <= SUMMARY_MAX_CHARS) return joined;
  return chars.slice(0, SUMMARY_MAX_CHARS).join("") + "\u2026";
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

// src/console.js
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
    entities: r.entities ?? []
  }));
}
function previewRecall(db, { query, roleId = "global", maxTokens = 1200 }) {
  return retrieveForPrompt(db, {
    query,
    roleIds: roleId && roleId !== "all" ? [roleId, "global"] : ["global"],
    enableGraphRecall: true,
    maxTokens,
    limit: 8
  });
}
async function triggerNightlySleep(db, { summarize } = {}) {
  const stats = await runNightlySleep(db, { summarize });
  metaSet(db, "meta.lastManualSleep", Date.now());
  return stats;
}
function listSoulMemories(db) {
  const rows = db.prepare(
    "SELECT id, role_id, layer, content FROM memories WHERE id LIKE 'mem_%' ORDER BY id ASC LIMIT 10"
  ).all();
  return rows;
}

// src/index.js
var name = "dsh-xiaofei-memory";
var inject = ["tools"];
var Config = z.object({
  /** Master switch: false disables injection, capture, sleep, and tools. */
  enabled: z.boolean().default(true),
  /** Override the SQLite path. Default: $DSH_HOME/plugin-data/dsh-xiaofei-memory/memory.sqlite. */
  dbPath: z.string().required(false),
  /** Independent extraction model name (PRD 4.1); requires useLlmExtraction. Volatile = editable in the console. */
  extractionModel: z.string().default("deepseek-chat").volatile(),
  /** Whether to use the LLM-backed extractor (default heuristic keeps it dependency-free). */
  useLlmExtraction: z.boolean().default(false),
  /** Damp factor applied on correction (PRD 4.3). */
  dampFactor: z.number().default(0.85),
  /** Time decay factor (PRD 4.2). */
  timeDecayFactor: z.number().default(0.01),
  /** 1-hop graph diffusion on/off (PRD 4.2). */
  enableGraphRecall: z.boolean().default(true),
  /** Nightly sleep hour, 0-23 (PRD 4.3). Volatile = editable in the console. */
  sleepTimeHour: z.number().default(3).volatile(),
  /** Max tokens for a single recall injection (PRD 4.2). */
  maxRecallTokens: z.number().default(1200),
  /** Default role namespace when the session carries none. */
  roleId: z.string().default("global"),
  /** Tools whose execution counts as a correction signal (default none = opt-in). */
  correctionTools: z.array(z.string()).default([]),
  /** Max primary recalls per injection. */
  recallLimit: z.number().default(8),
  /** Role registry for the management console. Volatile = editable in the console. */
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
var LAST_SLEEP_KEY = "meta.lastSleepAt";
var RECALL_STATS_KEY = "meta.recallStats";
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
  const tracker = new CaptureTracker({
    store: (args) => addMemory(db, args),
    roleOf: () => config.roleId,
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
        enableGraphRecall: config.enableGraphRecall,
        maxTokens: config.maxRecallTokens,
        limit: config.recallLimit
      });
      if (!recall) return decision;
      const sid = agent?.session?.id ?? "anon";
      lastInjected.set(sid, recall.injectedIds);
      for (const id of recall.injectedIds) touchAccessed(db, id);
      const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
      const memoryMessage = createUserMessage({
        content: [{ type: "text", text: recall.text }],
        source: { kind: "dsh-xiaofei-memory", form: "memory-recall", ids: recall.injectedIds }
      });
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
        logger?.info?.(`dsh-xiaofei-memory: correction via ${toolName}, damped ${ids.length} recalled memories`);
      } catch {
      }
    });
  }
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
      const summarize = config.useLlmExtraction ? buildSleepSummarizer(buildLlmCaller(ctx), config.extractionModel) : null;
      const stats = await runNightlySleep(db, { summarize });
      const recallStats = JSON.parse(metaGet(db, RECALL_STATS_KEY) ?? '{"count":0,"corrections":0}');
      const evolved = runEvolution(db, {
        recallCount: recallStats.count,
        recallCorrections: recallStats.corrections
      });
      metaSet(db, LAST_SLEEP_KEY, Date.now());
      metaSet(db, RECALL_STATS_KEY, '{"count":0,"corrections":0}');
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
  let liveRoles = Array.isArray(config.roles) ? config.roles.map((r) => ({ ...r })) : [];
  registerSettingsSection(ctx, { Config, config, liveRoles, setLiveRoles: (r) => {
    liveRoles = r;
  }, configWriter, logger });
  const core = {
    retrieve(query, opts = {}) {
      return retrieveForPrompt(db, {
        query,
        roleIds: opts.roleIds ?? [config.roleId, "global"],
        decay: loadEvolution(db).timeDecay,
        enableGraphRecall: config.enableGraphRecall,
        maxTokens: opts.maxTokens ?? config.maxRecallTokens,
        limit: opts.limit ?? config.recallLimit
      });
    },
    addFact({ content, roleId, layer = "recent", entities = [] }) {
      return addMemory(db, { roleId: roleId ?? config.roleId, layer, content, entities });
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
      const summarize = config.useLlmExtraction ? buildSleepSummarizer(buildLlmCaller(ctx), config.extractionModel) : null;
      return triggerNightlySleep(db, { summarize });
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
    // Diagnostic probe: the Web client calls this to prove it is running and
    // which mount path it took. Writes a line to a temp log.
    probe(msg) {
      try {
        appendFileSync(join(tmpdir(), "dshxf-probe.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
      } catch {
      }
      return true;
    }
  });
  const bridgeToken = randomBytes(16).toString("hex");
  try {
    metaSet(db, "bridge.token", bridgeToken);
  } catch {
  }
  const webServer = safeService(ctx, "webServer");
  if (webServer && typeof webServer.register === "function") {
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
        case "search":
          return searchMemory(db, { query: String(args?.query ?? ""), roleId: args?.roleId ?? "all", decay: loadEvolution(db).timeDecay });
        case "preview":
          return previewRecall(db, { query: String(args?.query ?? ""), roleId: args?.roleId ?? "all", maxTokens: config.maxRecallTokens });
        case "sleep": {
          const summarize = config.useLlmExtraction ? buildSleepSummarizer(buildLlmCaller(ctx), config.extractionModel) : null;
          return triggerNightlySleep(db, { summarize });
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
    try {
      const disposeBridge = webServer.register({
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
              if (String(req.headers["x-dshxf-token"] ?? "") !== bridgeToken) {
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
      ctx.effect(() => () => {
        try {
          disposeBridge?.();
        } catch {
        }
      });
      ctx.on("webserver/index-inject", (table) => {
        try {
          table.push({ kind: "global", name: "DSHXF_BRIDGE", value: { token: bridgeToken } });
        } catch {
        }
      });
      logger?.info?.("dsh-xiaofei-memory: console data bridge mounted at /dshxf/bridge");
    } catch (e) {
      logger?.warn?.(`dsh-xiaofei-memory: console data bridge unavailable: ${e?.message ?? e}`);
    }
  } else {
    logger?.info?.("dsh-xiaofei-memory: webServer unavailable; console data bridge skipped");
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
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
      render: (_args, v) => [{ type: "text", text: v?.ok ? "\u5DF2\u68C0\u7D22\u3002\u8BE6\u89C1\u4E0A\u65B9\u6CE8\u5165\u7684\u8BB0\u5FC6\u3002" : "\u68C0\u7D22\u5931\u8D25\u3002" }]
    },
    async execute(args) {
      const recall = retrieveForPrompt(db, {
        query: args?.query,
        roleIds: [config.roleId, "global"],
        decay: loadEvolution(db).timeDecay,
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
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" }, id: { type: "string" } } },
      render: (_args, v) => [{ type: "text", text: v?.ok ? `\u5DF2\u5199\u5165\uFF08${v?.id?.slice(-6) ?? ""}\uFF09\u3002` : "\u5199\u5165\u5931\u8D25\u3002" }]
    },
    async execute(args) {
      const res = addMemory(db, {
        roleId: args?.roleId ?? config.roleId,
        layer: args?.layer ?? "recent",
        content: args?.content,
        entities: Array.isArray(args?.entities) ? args.entities : []
      });
      return { ok: true, id: res?.id, merged: res?.merged ?? false };
    }
  });
  ctx.effect(() => () => {
    if (sleepTimer) clearTimeout(sleepTimer);
    feedback.dispose();
    if (typeof disposeRetrieve === "function") disposeRetrieve();
    if (typeof disposeAddFact === "function") disposeAddFact();
    closeMemoryDb(db);
  });
}
function safeService(ctx, name2) {
  try {
    if (typeof ctx.get === "function") {
      const value = ctx.get(name2);
      if (value !== void 0) return value;
    }
  } catch {
  }
  try {
    return ctx[name2];
  } catch {
    return void 0;
  }
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
