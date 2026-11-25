// test-engine.mjs — verify dsh-xiaofei-memory engine modules against PRD acceptance.
import { openMemoryDb, closeMemoryDb, addMemory, searchMemories, graphExpand, countMemories, metaGet, metaSet, getMemory, purgeArchived, archiveMemory, restoreMemory } from "./src/db.js";
import { retrieveForPrompt } from "./src/retrieval.js";
import { CaptureTracker } from "./src/capture.js";
import { FeedbackManager } from "./src/feedback.js";
import { runNightlySleep } from "./src/sleep.js";
import { coreMemorySignature } from "./src/core-memory.js";
import { resolveMemoryRef } from "./src/memory-index.js";
import { isRoleEnabled, roleIdsForAgent } from "./src/roles.js";
import { claimLease, releaseLease } from "./src/lease.js";
import { buildLlmCaller, resolveModelRoute } from "./src/llm-call.js";
import { loadEvolution, runEvolution } from "./src/evolution.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${label} ${extra}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
}

const dir = join(tmpdir(), `dsh-xmf-test-${Date.now()}`);
const dbPath = join(dir, "memory.sqlite");
const db = openMemoryDb(dbPath);

console.log("== 1. Schema & seed ==");
const seedRows = db.prepare("SELECT COUNT(*) n FROM memories WHERE id GLOB 'mem_0[0-9][0-9]'").get().n;
check("seeds 10 soul memories", seedRows === 10, `got ${seedRows}`);
// The ten seeds stay unpinned; one derived row represents them in the block.
check("one derived soul digest row, unpinned seeds",
  countMemories(db) === 11 && db.prepare("SELECT pinned FROM memories WHERE id='mem_soul_digest'").get()?.pinned === 1,
  `active=${countMemories(db)}`);
const seedCheck = db.prepare("SELECT id, role_id, layer FROM memories WHERE id='mem_001'").get();
check("mem_001 role=global", seedCheck?.role_id === "global");
check("mem_001 layer=core", seedCheck?.layer === "core");
const ftsCheck = db.prepare("SELECT count(*) n FROM memories_fts").get();
check("FTS mirror populated", (ftsCheck?.n ?? 0) >= 10, `fts=${ftsCheck?.n}`);

console.log("== 2. Retrieval (PRD acceptance #3) ==");
const recall = retrieveForPrompt(db, { query: "你觉得我是谁", roleIds: ["global"], maxTokens: 1200, limit: 8 });
check("recall produced", recall !== null && recall.text.length > 0);
check("recall mentions 赛博战友", recall?.text.includes("赛博战友"));
check("recall mentions 陪伴", recall?.text.includes("陪伴"));

console.log("== 2b. Relevance floor (unrelated queries must inject nothing) ==");
const noOverlap = searchMemories(db, "量子色动力学中的渐近自由", ["global"], { limit: 8 });
check("no-overlap search returns []", noOverlap.length === 0, `n=${noOverlap.length}`);
const optInFallback = searchMemories(db, "量子色动力学中的渐近自由", ["global"], { limit: 8, allowFallback: true });
check("opt-in fallback still works", optInFallback.length > 0, `n=${optInFallback.length}`);
const unrelated = retrieveForPrompt(db, { query: "量子色动力学中的渐近自由", roleIds: ["global"], maxTokens: 1200, limit: 8 });
check("unrelated query injects nothing", unrelated === null, unrelated ? unrelated.text.slice(0, 40) : "");

console.log("== 2c. Two-character CJK queries (LIKE fallback) ==");
addMemory(db, { roleId: "global", layer: "recent", content: "生产环境最终部署在宝塔服务器上，走 HTTPS 管理。" });
const twoChar = searchMemories(db, "部署", ["global"], { limit: 8 });
check("2-char CJK query hits via LIKE", twoChar.length > 0 && twoChar[0].content.includes("部署"), `n=${twoChar.length}`);

console.log("== 2d. FTS path (3+ chars) and role filter ==");
addMemory(db, { roleId: "global", layer: "recent", content: "数据库迁移脚本已经备份到对象存储，回滚步骤写在 runbook 里。" });
const ftsHit = searchMemories(db, "数据库迁移", ["global"], { limit: 8 });
check("FTS phrase query finds the row", ftsHit.some((r) => r.content.includes("数据库迁移")), `n=${ftsHit.length}`);
addMemory(db, { roleId: "work-assistant", layer: "recent", content: "数据库迁移由开发A负责执行和复核。" });
const ftsScoped = searchMemories(db, "数据库迁移", ["global"], { limit: 20 });
check("role filter still applied on the FTS path", !ftsScoped.some((r) => r.content.includes("开发A")), `n=${ftsScoped.length}`);

const archFact = addMemory(db, { roleId: "global", layer: "recent", content: "归档测试：数据库迁移计划书草案。" });
db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(archFact.id);
const ftsArch = searchMemories(db, "数据库迁移", ["global"], { limit: 20 });
check("archived rows excluded on the FTS path", !ftsArch.some((r) => r.id === archFact.id), `n=${ftsArch.length}`);

const ftsMulti = searchMemories(db, "数据库迁移", ["global", "work-assistant"], { limit: 20 });
check("multi-role query spans both namespaces",
  ftsMulti.some((r) => r.role_id === "global") && ftsMulti.some((r) => r.role_id === "work-assistant"),
  `n=${ftsMulti.length}`);

console.log("== 2e. the FTS pre-filter must stay a rowid subquery ==");
const seenSql = [];
const originalPrepare = db.prepare.bind(db);
let spyOk = false;
try {
  db.prepare = (sql) => { seenSql.push(String(sql)); return originalPrepare(sql); };
  spyOk = db.prepare !== originalPrepare;
} catch { spyOk = false; }
if (spyOk) {
  try { searchMemories(db, "数据库迁移", ["global"], { limit: 8 }); }
  finally { db.prepare = originalPrepare; }
  check("FTS pre-filter uses rowid IN (SELECT rowid ...)",
    seenSql.some((s) => /rowid IN \(SELECT rowid FROM memories_fts/.test(s)),
    `${seenSql.length} statements seen`);
} else {
  check("prepare() spy unavailable (skipped)", true, "runtime does not allow re-binding prepare");
}

console.log("== 2f. candidate cap: >800 candidates still returns the strongest match ==");
const capDir = join(tmpdir(), `dsh-xmf-cap-${Date.now()}`);
const capDb = openMemoryDb(join(capDir, "cap.sqlite"));
const insCap = capDb.prepare("INSERT INTO memories (id, role_id, layer, content, strength, created_at, status) VALUES (?, 'global', 'recent', ?, ?, ?, 'active')");
capDb.exec("BEGIN");
for (let i = 0; i < 900; i++) insCap.run("cap_" + i, "服务器缓存相关的第" + i + "条记录", 1.0, Date.now() - i * 1000);
insCap.run("cap_strong", "服务器缓存层的高价值方案：接入两级缓存并预热。", 5.0, Date.now());
capDb.exec("COMMIT");
const capped = searchMemories(capDb, "服务器缓存", ["global"], { limit: 8 });
check("capped search returns results", capped.length > 0, `n=${capped.length}`);
check("strongest relevant memory survives the cap", capped.some((r) => r.id === "cap_strong"), capped.map((r) => r.id).join(","));
closeMemoryDb(capDb);
try { rmSync(capDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log("== 3. Role isolation (PRD acceptance #2) ==");
const isolated = retrieveForPrompt(db, { query: "负反馈 试错 进化", roleIds: ["global"], maxTokens: 1200, limit: 8 });
// mem_004 (work-assistant) must NOT appear in a global-only recall.
check("work-assistant memory hidden from global", !(isolated?.text ?? "").includes("雕刻我的灵魂"));
const waRecall = retrieveForPrompt(db, { query: "负反馈 试错 进化", roleIds: ["work-assistant"], maxTokens: 1200, limit: 8 });
check("work-assistant memory visible to its role", (waRecall?.text ?? "").includes("雕刻我的灵魂"));

console.log("== 4. Capture & fusion ==");
const tracker = new CaptureTracker({ store: (a) => addMemory(db, a), roleOf: () => "global", logger: console });
tracker.onEvent("s1", { type: "turn/start", seq: 1 });
tracker.onEvent("s1", { type: "user/message", seq: 2, data: { source: { kind: "user" }, content: [{ type: "text", text: "记住，我们的服务器是47.104.102.35，用宝塔管理，以后维护都走这个。" }] } });
const flushed = tracker.onEvent("s1", { type: "turn/end", seq: 3, data: { reason: { kind: "stop" } } });
check("turn/end flushed capture", flushed === true);
await new Promise((r) => setTimeout(r, 50));
const after = countMemories(db);
check("capture added a memory", after >= 11, `active=${after}`);
const newMem = db.prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT 1").get();
// Capture can no longer produce core: the always-on block is identity only
// (pinned rows). A "记住/必须" hint reaches weekly at most.
check("captured layer inferred", newMem && newMem.layer === "weekly", `layer=${newMem?.layer}`);
check("captured content present", newMem && newMem.content.includes("47.104.102.35"));

console.log("== 4b. merge keeps the richer text ==");
const shortFact = addMemory(db, { roleId: "global", layer: "recent", content: "部署完成" });
const longFact = addMemory(db, {
  roleId: "global",
  layer: "core",
  content: "部署完成：宝塔面板已升级到 9.2，站点证书自动续期已开启，回滚脚本放在 /opt/rollback.sh。",
});
check("long fact merged into the short row", longFact.merged === true && longFact.id === shortFact.id, JSON.stringify({ short: shortFact, long: longFact }));
const mergedRow = db.prepare("SELECT content FROM memories WHERE id = ?").get(shortFact.id);
check("merged row kept the longer content", (mergedRow?.content ?? "").includes("回滚脚本"), (mergedRow?.content ?? "").slice(0, 40));

console.log("== 5. Feedback damp ==");
const fb = new FeedbackManager({ db, dampFactor: 0.85, logger: console });
const before = db.prepare("SELECT strength FROM memories WHERE id='mem_001'").get().strength;
const damped = fb.damp("mem_001");
const afterS = db.prepare("SELECT strength FROM memories WHERE id='mem_001'").get().strength;
check("damp applied", damped === true && afterS < before, `${before} -> ${afterS}`);

console.log("== 6. Sleep distillation ==");
// Fabricate 12 distinct recent memories sharing entities (bypass dedup so they
// survive as separate rows and trigger distillation).
const ins = db.prepare(
  "INSERT INTO memories (id, role_id, layer, content, entities, strength, created_at, status) VALUES (?, 'global', 'recent', ?, ?, 1.0, ?, 'active')"
);
const insEnt = db.prepare("INSERT OR IGNORE INTO entity_index (entity, memory_id, confidence) VALUES (?, ?, 1.0)");
const topics = [
  "配置了WAL模式确保读写并发", "FTS5触发器保持全文索引同步", "检索权重重排公式参数调优",
  "图谱扩散限制置信度0.8", "夜间蒸馏把recent压缩成core", "VACUUM物理回收空间",
  "时间衰减因子初始0.01", "阻尼因子0.85用于纠错", "token预算上限1200",
  "角色隔离global与work-assistant", "捕获异步不阻塞主响应", "进化引擎自动微调权重",
];
db.exec("BEGIN");
for (let i = 0; i < topics.length; i++) {
  const id = `tst_${i}`;
  ins.run(id, `关于记忆插件：${topics[i]}，我们在部署和测试中反复验证了效果。`, JSON.stringify(["记忆插件", "部署"]), Date.now() - i * 1000);
  insEnt.run("记忆插件", id);
  insEnt.run("部署", id);
}
db.exec("COMMIT");
const preSleep = countMemories(db);
const guardStats = await runNightlySleep(db, {});
check("no summarizer => distillation skipped (no data loss)",
  guardStats.distilledGroups === 0 && guardStats.archived === 0,
  JSON.stringify({ groups: guardStats.distilledGroups, archived: guardStats.archived }));
const coreBefore = db.prepare("SELECT count(*) n FROM memories WHERE layer='core' AND status='active'").get().n;
const sleepStats = await runNightlySleep(db, { summarize: async (texts) => "总结：" + texts[0] });
check("sleep distilled a core summary", sleepStats.distilledGroups >= 1, JSON.stringify(sleepStats));
check("sleep archived >=12 originals", sleepStats.archived >= 12, `archived=${sleepStats.archived}`);
const coreRows = db.prepare("SELECT count(*) n FROM memories WHERE layer='core' AND status='active'").get();
check("core summaries added", (coreRows?.n ?? 0) > coreBefore, `core ${coreBefore} -> ${coreRows?.n}`);
// Retirement now has a retention window: a supersede decision must be readable
// after the fact instead of disappearing the same night.
const archivedRows = db.prepare("SELECT count(*) n FROM memories WHERE status='archived'").get();
check("archived rows survive the retention window", (archivedRows?.n ?? 0) > 0, `archived=${archivedRows?.n}`);

purgeArchived(db, { retentionMs: 0 });
const purged = db.prepare("SELECT count(*) n FROM memories WHERE status='archived'").get();
check("an expired retention is purged", (purged?.n ?? 0) === 0, `archived=${purged?.n}`);

console.log("== 7. Evolution ==");
const beforeEv = loadEvolution(db);
const ev = runEvolution(db, { recallCount: 10, recallCorrections: 6 });
check("evolution nudges weight down", ev.changed && ev.retrievalWeight < beforeEv.retrievalWeight, `${beforeEv.retrievalWeight} -> ${ev.retrievalWeight}`);
check("evolution persists to meta", metaGet(db, "evolution.retrievalWeight") !== null);

console.log("== 7b. store hygiene: secrets, length cap, transaction nesting ==");
{
  const secretId = addMemory(db, {
    roleId: "global", layer: "recent", content: "部署机投递密码是123123，回头记得改",
  }).id;
  const secretRow = getMemory(db, secretId);
  check("assigned password is redacted",
    !String(secretRow.content).includes("123123") && String(secretRow.content).includes("***"),
    secretRow.content.slice(0, 40));
  check("the sentence around it survives",
    String(secretRow.content).includes("部署机投递"), secretRow.content.slice(0, 40));

  const proseId = addMemory(db, {
    roleId: "global", layer: "recent", content: "密码学里非对称加密的密钥长度要足够大才安全",
  }).id;
  const proseRow = getMemory(db, proseId);
  check("prose about 密码学 is not mistaken for a credential",
    String(proseRow.content).includes("非对称加密"), proseRow.content.slice(0, 40));

  const longId = addMemory(db, {
    roleId: "global", layer: "recent", content: "记忆长度上限测试" + "重复内容".repeat(300),
  }).id;
  const longRow = getMemory(db, longId);
  check("over-long content is capped", longRow.content.length <= 401, "len=" + longRow.content.length);

  check("no transaction left open after writes", db.isTransaction === false);

  // A caller may wrap our write in its own transaction (the sleep tests do).
  // That used to throw "cannot start a transaction within a transaction".
  db.exec("BEGIN");
  let nestedOk = true;
  try {
    addMemory(db, { roleId: "global", layer: "recent", content: "外层事务里的嵌套写入必须成功落库" });
  } catch { nestedOk = false; }
  db.exec("COMMIT");
  check("write inside an externally opened transaction works", nestedOk);
}

console.log("== 7c. dedupe and schema invariants ==");
{
  // The similarity pass only ever saw the most recent 20 rows, so writing the
  // same text again after enough unrelated history produced a second row. The
  // live store held six such pairs at similarity 1.00.
  const role = "dedupe-role";
  const probeText = "这条记忆会在候选窗口之外被原样重写一次";
  const first = addMemory(db, { roleId: role, layer: "recent", content: probeText }).id;
  for (let i = 0; i < 30; i++) {
    // Dissimilar on purpose: near-identical filler would collapse through the
    // merge path and never push the probe row out of the window.
    addMemory(db, { roleId: role, layer: "recent", content: "填充 " + Math.random().toString(36).slice(2) + " " + i });
  }
  const again = addMemory(db, { roleId: role, layer: "recent", content: probeText });
  check("exact repeat merges instead of duplicating", again.merged === true && again.id === first, JSON.stringify(again));

  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='memories_fts_au'").get();
  check("FTS update trigger is scoped OF content", /OF\s+content/i.test(trigger?.sql ?? ""),
    String(trigger?.sql ?? "").slice(0, 80));
}

console.log("== 7d. core signature tracks content, not length ==");
{
  const a = coreMemorySignature([{ id: "m1", content: "甲乙丙丁" }]);
  const b = coreMemorySignature([{ id: "m1", content: "甲乙戊己" }]);
  check("same-length edit changes the signature", a !== b, a.slice(0, 8) + " vs " + b.slice(0, 8));
  check("identical slice keeps the signature",
    a === coreMemorySignature([{ id: "m1", content: "甲乙丙丁" }]));
}

console.log("== 7e. a long paste must not erase the ask at the end ==");
{
  // People paste a stack trace or a diff and then write the actual question
  // underneath. The old tokenizer took the first 24 bigrams in appearance
  // order, so the paste consumed the whole budget and the trailing intent never
  // reached the SQL: measured as 0 results on a store that held the answer.
  const role = "longq";
  const target = addMemory(db, {
    roleId: role,
    layer: "weekly",
    content: "记录12 模块 部署 的接口核验必须对比真实响应数据",
  }).id;
  const insNoise = db.prepare(
    "INSERT INTO memories (id, role_id, layer, content, entities, strength, created_at, status) VALUES (?, ?, 'recent', ?, '[]', 3.0, ?, 'active')"
  );
  for (let i = 0; i < 120; i++) {
    insNoise.run(`noise_${i}`, role, `无关噪声记录编号${i}`, Date.now() - i * 1000);
  }

  const multiline = ("2026-11-21 10:00:01 ERROR failed to connect to upstream\n").repeat(40) +
    "帮我查一下 记录12 模块 部署 的接口核验";
  const oneLine = "以下是贴过来的一大段代码和日志 ".repeat(60) + " 记录12 模块 部署 的接口核验";
  const fenced = "```js\n" + "const x = 1;\n".repeat(80) + "```\n记录12 模块 部署 的接口核验";

  for (const [label, q] of [["multiline log", multiline], ["single-line paste", oneLine], ["fenced code", fenced]]) {
    const hits = searchMemories(db, q, [role], { limit: 5 });
    check(`trailing ask survives a ${label}`, hits.some((h) => h.id === target), `hits=${hits.length}`);
  }
}

console.log("== 7f. soul digest is created once, then left alone ==");
{
  // The digest is ordinary memory content the owner may edit. Re-asserting the
  // shipped constant on every open would revert those edits, and re-unpinning
  // the seeds on every open would undo a deliberate pin.
  const d = mkdtempSync(join(tmpdir(), "dshxf-digest-"));
  const file = join(d, "m.sqlite");

  const d1 = openMemoryDb(file);
  const first = d1.prepare("SELECT content FROM memories WHERE id = 'mem_soul_digest'").get();
  check("digest created on first open", (first?.content ?? "").length > 50, `len=${(first?.content ?? "").length}`);
  const seedPins = d1.prepare("SELECT COALESCE(SUM(pinned),0) s FROM memories WHERE id GLOB 'mem_0[0-9][0-9]'").get();
  check("seeds start unpinned", seedPins?.s === 0, `sum=${seedPins?.s}`);
  check("one-shot marker recorded", metaGet(d1, "seedPinnedMigrated") === "1");
  d1.prepare("UPDATE memories SET content = '我改过的身份摘要' WHERE id = 'mem_soul_digest'").run();
  closeMemoryDb(d1);

  const d2 = openMemoryDb(file);
  const edited = d2.prepare("SELECT content FROM memories WHERE id = 'mem_soul_digest'").get();
  check("an edited digest survives a reopen", edited?.content === "我改过的身份摘要", String(edited?.content).slice(0, 16));
  d2.prepare("UPDATE memories SET pinned = 1 WHERE id = 'mem_001'").run();
  closeMemoryDb(d2);

  const d3 = openMemoryDb(file);
  const kept = d3.prepare("SELECT pinned FROM memories WHERE id = 'mem_001'").get();
  check("a deliberately pinned seed stays pinned", kept?.pinned === 1, `pinned=${kept?.pinned}`);
  closeMemoryDb(d3);
  rmSync(d, { recursive: true, force: true });
}

console.log("== 7g. credential redaction and real entity confidence ==");
{
  // The redaction pass covered the body only; the same text in the entity
  // column reached the index verbatim, and confidence was a hardcoded 1.0 that
  // made graphExpand's 0.8 filter a no-op.
  const id = addMemory(db, {
    roleId: "conf-role", layer: "recent",
    content: "部署 接口 核验 必须对比真实响应",
    entities: ["部署", "凭空推断的实体"],
  }).id;
  const conf = Object.fromEntries(
    db.prepare("SELECT entity, confidence FROM entity_index WHERE memory_id = ?").all(id)
      .map((r) => [r.entity, r.confidence]),
  );
  check("entity present in the text scores 1.0", conf["部署"] === 1, String(conf["部署"]));
  check("entity absent from the text scores 0.6", conf["凭空推断的实体"] === 0.6, String(conf["凭空推断的实体"]));

  const secretId = addMemory(db, {
    roleId: "conf-role", layer: "recent",
    content: "这行正文不含凭据，只是说明",
    entities: ["password: abcdefgh12345678", "正常实体"],
  }).id;
  const kept = db.prepare("SELECT entity FROM entity_index WHERE memory_id = ?").all(secretId).map((r) => r.entity);
  check("a credential-shaped entity is not indexed", !kept.some((e) => e.includes("abcdefgh")), JSON.stringify(kept));
  check("ordinary entities still indexed", kept.includes("正常实体"), JSON.stringify(kept));

  // One memory reachable only through an inferred entity.
  addMemory(db, { roleId: "conf-role", layer: "recent", content: "完全无关的正文内容", entities: ["只能推断的实体"] });
  check("the 0.8 filter now excludes inferred entities",
    graphExpand(db, ["只能推断的实体"], ["conf-role"], { confidence: 0.8, limit: 5 }).length === 0);
  check("lowering the threshold includes them",
    graphExpand(db, ["只能推断的实体"], ["conf-role"], { confidence: 0.5, limit: 5 }).length > 0);
}

console.log("== 7h. credential patterns (no over-redaction) ==");
{
  const redacted = [
    ["投递密码是123123", "123123"],
    ["password is hunter2", "hunter2"],
    ["验证码 8899，五分钟内有效", "8899"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9", "eyJhbGciOiJIUzI1NiJ9"],
    ["token: abcdefgh12345678", "abcdefgh12345678"],
  ];
  for (const [text, secret] of redacted) {
    const stored = getMemory(db, addMemory(db, { roleId: "scrub-role", layer: "recent", content: text }).id);
    check(`redacts ${JSON.stringify(secret)}`, !String(stored.content).includes(secret) && String(stored.content).includes("***"),
      stored.content.slice(0, 40));
  }
  const preserved = ["密码学里非对称加密的密钥长度要足够大", "验证码五分钟内有效", "这个项目的验证码机制设计得不错"];
  for (const text of preserved) {
    const stored = getMemory(db, addMemory(db, { roleId: "scrub-role", layer: "recent", content: text }).id);
    check(`keeps prose: ${text.slice(0, 10)}`, String(stored.content) === text, stored.content.slice(0, 40));
  }
}

console.log("== 7i. role policy is enforced, not decorative ==");
{
  const roles = [
    { id: "work", enabled: true },
    { id: "off", enabled: false },
    { id: "legacy" },
  ];
  check("enabled role", isRoleEnabled(roles, "work") === true);
  check("disabled role", isRoleEnabled(roles, "off") === false);
  check("unknown role stays enabled", isRoleEnabled(roles, "nobody") === true);
  check("global always enabled", isRoleEnabled(roles, "global") === true);

  const agent = (roleId) => ({ session: { header: { roleId } } });
  check("agent reads its own role plus global",
    JSON.stringify(roleIdsForAgent(roles, agent("work"), "global")) === '["work","global"]',
    JSON.stringify(roleIdsForAgent(roles, agent("work"), "global")));
  check("a disabled own-role falls back to global",
    JSON.stringify(roleIdsForAgent(roles, agent("off"), "global")) === '["global"]');
  check("no session role uses the configured fallback",
    JSON.stringify(roleIdsForAgent(roles, undefined, "work")) === '["work","global"]');

  // A short id from the index must not be a key to every namespace.
  const rid = addMemory(db, { roleId: "secret-role", layer: "recent", content: "别的角色的私密记忆内容" }).id;
  check("cross-role read is refused", resolveMemoryRef(db, rid, { roleIds: ["global"] }) === null);
  check("own-role read works", resolveMemoryRef(db, rid, { roleIds: ["secret-role", "global"] })?.id === rid);
  check("omitting roleIds keeps the unrestricted behaviour", resolveMemoryRef(db, rid)?.id === rid);
}

console.log("== 7j. intent extraction: the question under a paste ==");
{
  // A paste of DISTINCT lines (not the same line repeated, whose bigram set
  // collapses) is what actually diluted the query: scoring used the whole
  // message, so the answer row fell to ~0.18 and under the floor. Scoring the
  // last line instead fixes it — and must not change the bare-question result.
  const role = "intent-role";
  const target = addMemory(db, {
    roleId: role, layer: "weekly",
    content: "Spdiam 价格配置 评审要按逐层叠加的方式改",
  }).id;
  const lines = [];
  for (let i = 0; i < 90; i++) {
    lines.push(`2026-11-2${(i % 9) + 1} 1${i % 10}:0${i % 6} ERROR code=ERR_${(i * 7919).toString(36)} ` +
      `route=/api/v${i % 4}/sku/${i * 31} handler=SpdiamController${i}`);
  }
  const ask = "Spdiam 价格配置 评审怎么改？";
  const bare = searchMemories(db, ask, [role], { limit: 5, minSim: 0.3 });
  check("bare question still recalls", bare.some((h) => h.id === target), `hits=${bare.length}`);

  const pasted = searchMemories(db, lines.join("\n") + "\n\n" + ask, [role], { limit: 5, minSim: 0.3 });
  check("a varied 7k paste still recalls the trailing question", pasted.some((h) => h.id === target), `hits=${pasted.length}`);
  const bareSim = bare.find((h) => h.id === target)?._sim ?? -1;
  const pastedSim = pasted.find((h) => h.id === target)?._sim ?? -2;
  check("the paste scores the answer like the bare question",
    Math.abs(bareSim - pastedSim) < 0.01, `${bareSim.toFixed(3)} vs ${pastedSim.toFixed(3)}`);

  // Same line: copy a log and append the question without pressing Enter. The
  // intent is the window ending at the last question mark, with the politeness
  // prefix cut, because a window cut from a paste still carries its tail.
  const oneLine = lines.join(" ") + " 请问 " + ask;
  const single = searchMemories(db, oneLine, [role], { limit: 5, minSim: 0.3 });
  check("a single-line paste still recalls the trailing question", single.some((h) => h.id === target), `hits=${single.length}`);

  // The other direction: an unrelated question must stay empty.
  const unrelated = searchMemories(db, "今天晚饭吃什么", [role], { limit: 5, minSim: 0.3 });
  check("an unrelated question still returns nothing", unrelated.length === 0, `hits=${unrelated.length}`);
}

console.log("== 7k. identity writes reach the block, at any candidate scale ==");
{
  // Merge must not demote: an unpinned row that collides with a pinned fact has
  // to become pinned, otherwise the model's explicit identity write is lost.
  const base = addMemory(db, { roleId: "pin-role", layer: "core", content: "这是一条先写入的普通核心记录", entities: [] });
  check("plain core write stays unpinned", db.prepare("SELECT pinned FROM memories WHERE id=?").get(base.id)?.pinned === 0);
  const same = addMemory(db, { roleId: "pin-role", layer: "core", content: "这是一条先写入的普通核心记录", entities: [], pinned: true });
  check("a pinned write that merges promotes the row",
    same.merged === true && db.prepare("SELECT pinned FROM memories WHERE id=?").get(same.id)?.pinned === 1,
    JSON.stringify(same));

  // Candidate pre-selection must not lose the answer when many rows share the
  // query's words: the previous orderings kept either the strong or the short
  // noise and dropped the row that answered.
  const role = "cap-role";
  const ins = db.prepare(
    "INSERT INTO memories (id, role_id, layer, content, entities, strength, created_at, status) VALUES (?, ?, 'recent', ?, '[]', 1.0, ?, 'active')"
  );
  // Noise matches one half of the query; the answer matches both, so it has to
  // rank above 1600 rows that are otherwise identical to it.
  for (let i = 0; i < 1600; i++) ins.run(`cap_${i}`, role, `共同词 噪声条目 ${i}`, Date.now() - i);
  const answerId = addMemory(db, {
    roleId: role, layer: "weekly",
    content: "共同词 的正确答案在这里：结论是先核对数据再改配置。" + "这是一条比较长的复盘记录，".repeat(12),
  }).id;
  const hits = searchMemories(db, "共同词 核对数据", [role], { limit: 5, minSim: 0 });
  check("the answer survives 1600 same-word candidates", hits.some((h) => h.id === answerId), `hits=${hits.length}`);
}

console.log("== 7l. the identity row cannot be lost ==");
{
  db.prepare("UPDATE memories SET status='archived' WHERE id='mem_soul_digest'").run();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const reopened = openMemoryDb(dbPath);
  const revived = reopened.prepare("SELECT status, pinned, layer FROM memories WHERE id='mem_soul_digest'").get();
  check("an archived digest is revived on open",
    revived?.status === "active" && revived?.pinned === 1 && revived?.layer === "core", JSON.stringify(revived));
  reopened.prepare("UPDATE memories SET status='archived' WHERE id='mem_soul_digest'").run();
  purgeArchived(reopened);
  const survived = reopened.prepare("SELECT COUNT(*) n FROM memories WHERE id='mem_soul_digest'").get().n;
  check("purge does not delete the digest", survived === 1, `n=${survived}`);
  closeMemoryDb(reopened);
}

console.log("== 7m. the nightly pass runs once across processes ==");
{
  const key = "test.lease";
  check("first claim wins", claimLease(db, key, 60_000) === true);
  check("a second claim while held is refused", claimLease(db, key, 60_000) === false);
  releaseLease(db, key);
  check("after release the next claim wins", claimLease(db, key, 60_000) === true);
  // An expired claim must not wedge the pass forever.
  metaSet(db, key, String(Date.now() - 120_000));
  check("an expired claim can be taken", claimLease(db, key, 60_000) === true);
  releaseLease(db, key);
}

console.log("== 7n. a changed key token means a different fact, not a correction ==");
{
  // "订单 1234" and "订单 5678" score 0.615. An earlier rule retired the first
  // one because the numbers differed, so a numbered series collapsed to a single
  // row. A differing key token now only prevents a merge; the rows coexist.
  const role = "parallel-role";
  const first = addMemory(db, { roleId: role, layer: "weekly", content: "订单 1234 的退款已经到账，客户已确认" });
  const second = addMemory(db, { roleId: role, layer: "weekly", content: "订单 5678 的退款已经到账，客户已确认" });
  const active = (id) => db.prepare("SELECT status FROM memories WHERE id=?").get(id)?.status === "active";
  check("parallel facts both stay active", active(first.id) && active(second.id),
    `${first.id}:${active(first.id)} ${second.id}:${active(second.id)}`);

  for (let i = 0; i < 12; i++) {
    addMemory(db, { roleId: role, layer: "weekly", content: `系列笔记 要点${i}：这是第${i}条独立结论` });
  }
  const series = db.prepare("SELECT COUNT(*) n FROM memories WHERE role_id=? AND status='active' AND content LIKE '系列笔记 %'").get(role).n;
  check("a numbered series is not eaten row by row", series === 12, `active=${series}/12`);

  // A single digit is a key token too: "版本 2.3" -> "版本 3.3" used to merge and
  // silently keep 2.3.
  const rule = "，发布前必须跑完全部用例再合并，这条规则请一直记住";
  addMemory(db, { roleId: role, layer: "recent", content: "本次发布的目标版本是 2.3" + rule });
  const updated = addMemory(db, { roleId: role, layer: "recent", content: "本次发布的目标版本是 3.3" + rule });
  check("a changed single digit is not merged away", updated.merged === false, JSON.stringify(updated));
  const versions = db.prepare("SELECT content FROM memories WHERE role_id=? AND status='active' AND content LIKE '%目标版本是%'").all(role)
    .map((r) => (r.content.match(/版本是 ([0-9.]+)/) ?? [])[1]);
  check("the new value is stored", versions.includes("3.3"), JSON.stringify(versions));

  // A short generic fact has no key token: a detailed follow-up still merges.
  const generic = addMemory(db, { roleId: role, layer: "weekly", content: "部署完成" });
  const detailed = addMemory(db, { roleId: role, layer: "weekly", content: "部署完成：回滚脚本放在 rollback.sh" });
  check("a keyless short fact still merges with detail", detailed.merged === true && detailed.id === generic.id, JSON.stringify(detailed));
}

console.log("== 7o. a retired memory can be looked up and brought back ==");
{
  const role = "restore-role";
  const kept = addMemory(db, { roleId: role, layer: "weekly", content: "这条记忆稍后会被归档再恢复" });
  archiveMemory(db, kept.id, { supersededBy: "mem_successor" });

  check("a retired row is hidden from the normal lookup",
    resolveMemoryRef(db, kept.id, { roleIds: [role] }) === null);
  const retired = resolveMemoryRef(db, kept.id, { roleIds: [role], includeArchived: true });
  check("the retirement window keeps it findable", retired?.id === kept.id, String(retired?.id));
  check("it records who replaced it", retired?.superseded_by === "mem_successor", String(retired?.superseded_by));

  check("restore reports success", restoreMemory(db, kept.id) === true);
  const back = db.prepare("SELECT status, archived_at, superseded_by FROM memories WHERE id=?").get(kept.id);
  check("the row is live again", back?.status === "active", String(back?.status));
  check("the retirement markers are cleared",
    back?.archived_at === null && back?.superseded_by === null, JSON.stringify(back));
  check("and it is findable without the archived flag",
    resolveMemoryRef(db, kept.id, { roleIds: [role] })?.id === kept.id);
  check("restoring an unknown id is not an error", restoreMemory(db, "mem_does_not_exist") === false);
}

console.log("== 7p. the LLM caller speaks the service's actual API ==");
{
  // The host `llm` service exposes `stream()`, not `complete()`. The old caller
  // returned null whenever `complete` was missing, which made every LLM-backed
  // path silently fall back to the heuristic — distillation included.
  const chunks = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "三条记忆" },
    { type: "text-delta", index: 0, text: "压缩成一句要点" },
    { type: "finish", reason: { kind: "stop" } },
  ];
  const seen = [];
  const llm = {
    async listProviders() { return [{ id: "prov-a" }, { id: "prov-b" }]; },
    async listModels(provider) { return provider === "prov-b" ? [{ id: "wanted-model" }] : [{ id: "other" }]; },
    stream(options) {
      seen.push(options);
      return (async function* () { for (const c of chunks) yield c; })();
    },
  };
  const route = await resolveModelRoute(llm, "wanted-model");
  check("the route is resolved to the provider that advertises the model",
    route?.provider === "prov-b" && route?.model === "wanted-model", JSON.stringify(route));

  const caller = buildLlmCaller({ get: (name) => (name === "llm" ? llm : undefined) });
  const answer = await caller("把这几条压缩成一句", { model: "wanted-model" });
  check("the stream is assembled into one string", answer === "三条记忆压缩成一句要点", JSON.stringify(answer));
  check("the call names provider and model", seen[0]?.provider === "prov-b" && seen[0]?.model === "wanted-model",
    JSON.stringify({ provider: seen[0]?.provider, model: seen[0]?.model }));
  check("the prompt travels as a user message",
    seen[0]?.messages?.[0]?.role === "user" && seen[0]?.messages?.[0]?.content?.[0]?.text === "把这几条压缩成一句");

  check("no llm service means no caller", buildLlmCaller({ get: () => undefined }) === null);

  const broken = { async listProviders() { return ["p"]; }, async listModels() { return []; }, stream() { throw new Error("boom"); } };
  const brokenAnswer = await buildLlmCaller({ get: () => broken })("x", { model: "m" });
  check("a throwing stream degrades to null", brokenAnswer === null, String(brokenAnswer));

  const errorFinish = {
    async listProviders() { return ["p"]; },
    stream() { return (async function* () { yield { type: "finish", reason: { kind: "error" } }; })(); },
  };
  check("an error finish degrades to null",
    (await buildLlmCaller({ get: () => errorFinish })("x", { model: "m" })) === null);
}

console.log("== 8. Performance (PRD acceptance #4) ==");
const t0 = performance.now();
for (let i = 0; i < 20; i++) {
  retrieveForPrompt(db, { query: "你觉得我是谁 赛博战友 陪伴", roleIds: ["global"], maxTokens: 1200, limit: 8 });
}
const avg = (performance.now() - t0) / 20;
check("retrieval < 50ms avg", avg < 50, `avg=${avg.toFixed(2)}ms`);

closeMemoryDb(db);
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
