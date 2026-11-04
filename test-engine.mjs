// test-engine.mjs — verify dsh-xiaofei-memory engine modules against PRD acceptance.
import { openMemoryDb, closeMemoryDb, addMemory, searchMemories, graphExpand, countMemories, metaGet, metaSet } from "./src/db.js";
import { retrieveForPrompt } from "./src/retrieval.js";
import { CaptureTracker } from "./src/capture.js";
import { FeedbackManager } from "./src/feedback.js";
import { runNightlySleep } from "./src/sleep.js";
import { loadEvolution, runEvolution } from "./src/evolution.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${label} ${extra}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
}

const dir = join(tmpdir(), `dsh-xmf-test-${Date.now()}`);
const dbPath = join(dir, "memory.sqlite");
const db = openMemoryDb(dbPath);

console.log("== 1. Schema & seed ==");
check("seeds 10 soul memories", countMemories(db) === 10, `got ${countMemories(db)}`);
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
check("captured layer inferred", newMem && newMem.layer === "core", `layer=${newMem?.layer}`); // contains 记住 -> core
check("captured content present", newMem && newMem.content.includes("47.104.102.35"));

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
const sleepStats = await runNightlySleep(db, {});
check("sleep distilled a core summary", sleepStats.distilledGroups >= 1, JSON.stringify(sleepStats));
check("sleep archived >=12 originals", sleepStats.archived >= 12, `archived=${sleepStats.archived}`);
const coreRows = db.prepare("SELECT count(*) n FROM memories WHERE layer='core' AND status='active'").get();
check("core summaries added", (coreRows?.n ?? 0) > 6, `core=${coreRows?.n}`);
const archivedRows = db.prepare("SELECT count(*) n FROM memories WHERE status='archived'").get();
check("archived purged after vacuum", (archivedRows?.n ?? 0) === 0, `archived=${archivedRows?.n}`);

console.log("== 7. Evolution ==");
const beforeEv = loadEvolution(db);
const ev = runEvolution(db, { recallCount: 10, recallCorrections: 6 });
check("evolution nudges weight down", ev.changed && ev.retrievalWeight < beforeEv.retrievalWeight, `${beforeEv.retrievalWeight} -> ${ev.retrievalWeight}`);
check("evolution persists to meta", metaGet(db, "evolution.retrievalWeight") !== null);

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
