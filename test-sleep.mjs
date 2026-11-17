// test-sleep.mjs — nightly sleep: dynamic threshold, entity noise filter, seed safety.
import { openMemoryDb, closeMemoryDb, addMemory, listLayerMemories } from "./src/db.js";
import { runNightlySleep, distillThreshold } from "./src/sleep.js";
import { isMeaningfulEntity } from "./src/util.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (l, c, e = "") => {
  if (c) { pass++; console.log("  PASS  " + l + " " + e); }
  else { fail++; console.log("  FAIL  " + l + " " + e); }
};

console.log("== 1. distillThreshold curve ==");
console.log("    " + [0,1,5,10,20,40,100].map(n => n + "->" + distillThreshold(n)).join("  "));
check("tiny layer distills at 3", distillThreshold(1) === 3);
check("mid layer scales", distillThreshold(40) === 6);
check("large layer capped at 10", distillThreshold(100) === 10);

console.log("== 2. noise entities ==");
for (const e of ["Time","Browser","Asia","Shanghai","ok","user","message","am","to"]) {
  check("reject " + JSON.stringify(e), isMeaningfulEntity(e) === false);
}
for (const e of ["runtime-xiaofei-memory","SQLite","小肥鱼","2号","海马体"]) {
  check("keep " + JSON.stringify(e), isMeaningfulEntity(e) === true);
}

const dir = mkdtempSync(join(tmpdir(), "xmf-sleep3-"));
const db = openMemoryDb(join(dir, "m.sqlite"));

// Deliberately dissimilar texts sharing ONE entity, so the merge pass cannot
// collapse them. This is what real multi-session history looks like.
const texts = [
  "今天去菜市场买了带鱼和青菜，回来做了红烧。",
  "调试数据库锁超时问题，最后发现是 WAL 没有开。",
  "帮主人修了打印机的驱动，重启后台服务就恢复了。",
  "讨论记忆插件的衰减曲线，决定把半衰期设为六十九天。",
  "研究 FTS5 的 trigram 分词，中文两个字的查询直接失效。",
];
const ids = [];
db.exec("BEGIN");
for (const t of texts) {
  ids.push(addMemory(db, { roleId: "global", layer: "recent", content: t, entities: ["共同实体"], strength: 1.0 }).id);
}
db.exec("COMMIT");

const stored = listLayerMemories(db, "recent").length;
console.log("== 3. distillation ==");
console.log("    requested=5 stored=" + stored + " uniqueIds=" + new Set(ids).size);
// The seed pass puts mem_009/mem_010 into `recent` too, so 5 new + 2 seeds is correct.
check("5 new memories survive merge on top of 2 seeded recent rows", stored === 7, "stored=" + stored);

const logs = [];
console.log("    scanned=" + stored + " threshold=" + distillThreshold(stored));

console.log("== 3a. no summarizer => no distillation (data-loss guard) ==");
const noSum = await runNightlySleep(db, {});
check("distillation skipped without a summarizer", noSum.distilledGroups === 0 && noSum.archived === 0, JSON.stringify({ g: noSum.distilledGroups, a: noSum.archived }));
check("skip reason reported", noSum.distillSkipped === "no-summarizer", String(noSum.distillSkipped));
check("vacuum still runs", noSum.vacuumed === true);
check("original rows still present", listLayerMemories(db, "recent").length === stored, "n=" + listLayerMemories(db, "recent").length);

console.log("== 3a2. a summary that comes back empty must not archive anything ==");
const nullSum = await runNightlySleep(db, { summarize: async () => null });
check("null summary => no distillation", nullSum.distilledGroups === 0 && nullSum.archived === 0, JSON.stringify({ g: nullSum.distilledGroups, a: nullSum.archived }));
check("group skipped and reported", (nullSum.skippedGroups ?? 0) >= 1, `skipped=${nullSum.skippedGroups}`);
check("originals still present", listLayerMemories(db, "recent").length === stored, "n=" + listLayerMemories(db, "recent").length);

console.log("== 3a3. a throwing summarizer is skipped, not fatal ==");
const throwSum = await runNightlySleep(db, { summarize: async () => { throw new Error("boom"); } });
check("throwing summarizer => no distillation", throwSum.distilledGroups === 0 && throwSum.archived === 0, JSON.stringify({ g: throwSum.distilledGroups, a: throwSum.archived }));
check("skip reported in stats", throwSum.skippedGroups >= 1, `skipped=${throwSum.skippedGroups}`);
check("vacuum still runs", throwSum.vacuumed === true);
check("originals still present", listLayerMemories(db, "recent").length === stored, "n=" + listLayerMemories(db, "recent").length);

console.log("== 3b. distillation with an LLM summarizer ==");
const st = await runNightlySleep(db, {
  summarize: async (texts) => "共同实体摘要：" + texts.join("；").slice(0, 60),
  logger: { info: (m) => logs.push(m) },
});
console.log("    scanned=" + st.scanned + " threshold=" + st.threshold + " groups=" + st.distilledGroups + " archived=" + st.archived);
check("threshold is 3 for a 5-row layer", st.threshold === 3);
check("distilled the shared-entity group", st.distilledGroups >= 1, JSON.stringify(st.details.map((d) => d.entity)));
check("summary produced", !!(st.details[0] || {}).summary, (st.details[0] || {}).summary);
check("originals archived", st.archived >= 4, "archived=" + st.archived);
check("logger emitted", logs.length > 0, (logs[0] || "").slice(0, 80));

console.log("== 3c. the distilled summary must actually survive ==");
const summaryRow = st.details[0]?.newId
  ? db.prepare("SELECT id, status, content FROM memories WHERE id = ?").get(st.details[0].newId)
  : null;
check("summary row exists", !!summaryRow, JSON.stringify(st.details[0]));
check("summary row is active (not archived by its own group)", summaryRow?.status === "active", `status=${summaryRow?.status}`);
check("summary row keeps the summarizer text", (summaryRow?.content ?? "").includes("共同实体摘要"), (summaryRow?.content ?? "").slice(0, 30));
check("summary is a standalone row (no merge back into the group)", !ids.slice(0, 5).includes(summaryRow?.id), `newId=${summaryRow?.id}`);

console.log("== 3d. overlapping entity groups must distil once, not twice ==");
const ovDir = mkdtempSync(join(tmpdir(), "xmf-sleep-ov-"));
const ovDb = openMemoryDb(join(ovDir, "ov.sqlite"));
const ovTexts = [
  "缓存预热方案在压测环境验证通过。",
  "缓存淘汰策略改成两级 LRU 结构。",
  "压测报告已归档，淘汰阈值写进 runbook。",
  "缓存命中率提升到 97%，压测复跑通过。",
];
for (const t of ovTexts) addMemory(ovDb, { roleId: "global", layer: "recent", content: t, entities: ["缓存", "压测"] });
const ovStats = await runNightlySleep(ovDb, { summarize: async (texts) => "重叠实体摘要：" + texts.join("；").slice(0, 60) });
check("overlapping groups distil exactly once", ovStats.distilledGroups === 1, JSON.stringify({ g: ovStats.distilledGroups, a: ovStats.archived }));
check("archived count equals archived rows", ovStats.archived === 4, `archived=${ovStats.archived}`);
const ovSummaries = ovDb.prepare("SELECT COUNT(*) n FROM memories WHERE layer='core' AND origin_ids IS NOT NULL").get().n;
check("exactly one summary row", ovSummaries === 1, `n=${ovSummaries}`);
closeMemoryDb(ovDb);
try { rmSync(ovDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log("== 3e. a non-string summary must be rejected, not stringified ==");
const obDir = mkdtempSync(join(tmpdir(), "xmf-sleep-obj-"));
const obDb = openMemoryDb(join(obDir, "ob.sqlite"));
for (const t of ovTexts) addMemory(obDb, { roleId: "global", layer: "recent", content: t, entities: ["缓存", "压测"] });
const obStats = await runNightlySleep(obDb, { summarize: async () => ({ text: "对象摘要" }) });
check("object summary => no distillation", obStats.distilledGroups === 0 && obStats.archived === 0, JSON.stringify({ g: obStats.distilledGroups, a: obStats.archived }));
check("object summary counted as skipped", obStats.skippedGroups >= 1, `skipped=${obStats.skippedGroups}`);
const obRows = obDb.prepare("SELECT COUNT(*) n FROM memories WHERE content LIKE '%[object Object]%'").get().n;
check("no [object Object] row written", obRows === 0, `n=${obRows}`);
closeMemoryDb(obDb);
try { rmSync(obDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log("== 4. seed safety ==");
const seeds = db.prepare("SELECT count(*) c FROM memories WHERE id GLOB 'mem_0[0-9][0-9]'").get().c;
check("10 seeds intact after distillation", seeds === 10, "seeds=" + seeds);

db.prepare("UPDATE memories SET status='archived' WHERE id='mem_002'").run();
await runNightlySleep(db, {});
const s2 = db.prepare("SELECT status FROM memories WHERE id='mem_002'").get();
check("archived seed revived, not deleted", s2?.status === "active", JSON.stringify(s2));

closeMemoryDb(db);
rmSync(dir, { recursive: true, force: true });
console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
