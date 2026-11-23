// test-engine.mjs — verify dsh-xiaofei-memory engine modules against PRD acceptance.
import { openMemoryDb, closeMemoryDb, addMemory, searchMemories, graphExpand, countMemories, metaGet, metaSet, getMemory } from "./src/db.js";
import { retrieveForPrompt } from "./src/retrieval.js";
import { CaptureTracker } from "./src/capture.js";
import { FeedbackManager } from "./src/feedback.js";
import { runNightlySleep } from "./src/sleep.js";
import { coreMemorySignature } from "./src/core-memory.js";
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
const archivedRows = db.prepare("SELECT count(*) n FROM memories WHERE status='archived'").get();
check("archived purged after vacuum", (archivedRows?.n ?? 0) === 0, `archived=${archivedRows?.n}`);

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
