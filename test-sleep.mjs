// test-sleep.mjs — nightly sleep: dynamic threshold, entity noise filter, seed safety.
import { openMemoryDb, closeMemoryDb, addMemory, listLayerMemories, metaGet, metaSet } from "./src/db.js";
import { runNightlySleep, distillThreshold, SLEEP_LEASE_KEY, acceptSummary } from "./src/sleep.js";
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

console.log("== 3b. distillation must stay inside one role ==");
{
  // The old grouping key was the entity alone, over a layer-wide query. Two
  // roles sharing an entity were merged into one group: the summariser saw both
  // roles' text, the summary landed in whichever role sorted first, and the
  // other role's originals were archived and then physically purged.
  const xDir = mkdtempSync(join(tmpdir(), "dshxf-role-"));
  const xDb = openMemoryDb(join(xDir, "m.sqlite"));
  const seenInputs = [];
  for (const t of [
    "线上接口改动前必须核验真实响应数据",
    "交付前要跑完所有回归用例并记录结果",
    "报价表新增供应商维度需要逐层叠加",
    "分页 tie-breaker 要带一个稳定排序字段",
  ]) {
    addMemory(xDb, { roleId: "work", layer: "recent", content: t, entities: ["共同实体"] });
  }
  const companionId = addMemory(xDb, {
    roleId: "companion",
    layer: "recent",
    content: "主人今天很累，周末想去海边走走",
    entities: ["共同实体"],
  }).id;

  const stats = await runNightlySleep(xDb, {
    summarize: async (texts) => { seenInputs.push(texts.join(" / ")); return "角色要点：" + texts[0].slice(0, 40); },
  });

  const summary = xDb
    .prepare("SELECT role_id, layer FROM memories WHERE layer='core' AND role_id='work' ORDER BY created_at DESC LIMIT 1")
    .get();
  check("summary written into the group's own role", summary?.role_id === "work", JSON.stringify(summary));
  check("summarizer never saw the other role's text",
    !seenInputs.some((s) => s.includes("海边")), seenInputs.join(" | ").slice(0, 120));
  // Count the specific row, not the role: seed mem_008 lives in companion too.
  const compRow = xDb.prepare("SELECT status FROM memories WHERE id = ?").get(companionId);
  check("other role's memory is not archived", compRow?.status === "active", JSON.stringify(compRow));
  check("the over-threshold role still distils", stats.distilledGroups >= 1, "groups=" + stats.distilledGroups);
  check("details carry the role that was distilled",
    stats.details.every((d) => d.roleId === "work"), JSON.stringify(stats.details.map((d) => d.roleId)));

  closeMemoryDb(xDb);
  try { rmSync(xDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log("== 3c. distillation archives only what the summariser saw ==");
{
  // "Eight in, twenty out": the summariser was fed at most eight rows while the
  // whole group was archived and then purged, so twelve rows per group were
  // deleted without ever contributing to the summary.
  const d = mkdtempSync(join(tmpdir(), "dshxf-8in-"));
  const db8 = openMemoryDb(join(d, "m.sqlite"));
  const ins = db8.prepare(
    "INSERT INTO memories (id, role_id, layer, content, entities, strength, created_at, status) VALUES (?, 'global', 'recent', ?, ?, 1.0, ?, 'active')"
  );
  const insEnt = db8.prepare("INSERT OR IGNORE INTO entity_index (entity, memory_id, confidence) VALUES (?, ?, 1.0)");
  for (let i = 0; i < 20; i++) {
    const id = `many_${i}`;
    ins.run(id, `关于同一个主题的第${i}条独立记录，内容互不相同以便不被合并处理。`, JSON.stringify(["共同主题"]), Date.now() - i * 1000);
    insEnt.run("共同主题", id);
  }
  // Batched now: a twenty-row group is summarised eight at a time, and the
  // trailing four are too small to be their own group, so they wait. Every
  // summary must still match exactly the rows archived with it.
  const fedSizes = [];
  const stats = await runNightlySleep(db8, {
    summarize: async (texts) => { fedSizes.push(texts.length); return "合并要点：" + texts[0].slice(0, 40); },
  });
  check("no batch exceeds 8 rows", fedSizes.every((n) => n <= 8), JSON.stringify(fedSizes));
  const fedTotal = fedSizes.reduce((a, b) => a + b, 0);
  check("archived count equals what was summarised", stats.archived === fedTotal, `archived=${stats.archived} fed=${fedTotal}`);
  check("a twenty-row group is processed in batches", stats.distilledGroups >= 2, `groups=${stats.distilledGroups} sizes=${JSON.stringify(fedSizes)}`);
  // Count only this fixture's rows: the seeds live in `recent` too.
  const still = db8.prepare("SELECT COUNT(*) n FROM memories WHERE layer='recent' AND status='active' AND id LIKE 'many\_%' ESCAPE '\\'").get().n;
  check("leftovers stay in the layer for the next pass", still === 20 - fedTotal, `left=${still} expected=${20 - fedTotal}`);
  check("the leftover is below the batch floor, not lost", 20 - fedTotal < 5, `left=${20 - fedTotal}`);
  closeMemoryDb(db8);
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log("== 3d. one pass per night, across channels ==");
{
  // The scheduled pass and a manual trigger both go through the same lease now:
  // a click during 03:00 used to run a second sleep+VACUUM.
  const d = mkdtempSync(join(tmpdir(), "dshxf-lease-"));
  const dbL = openMemoryDb(join(d, "m.sqlite"));

  const ran = await runNightlySleep(dbL, { lease: true });
  check("a leased pass runs", ran.skipped === undefined, JSON.stringify(ran.skipped));
  check("it releases the lease when done", metaGet(dbL, SLEEP_LEASE_KEY) === "0", String(metaGet(dbL, SLEEP_LEASE_KEY)));

  metaSet(dbL, SLEEP_LEASE_KEY, String(Date.now()));
  const blocked = await runNightlySleep(dbL, { lease: true });
  check("a held lease makes the next pass stand down", blocked.skipped === "leased", String(blocked.skipped));
  metaSet(dbL, SLEEP_LEASE_KEY, "0");

  // A throwing summariser must not hold the lease for its six-hour TTL.
  await runNightlySleep(dbL, { lease: true, summarize: async () => { throw new Error("boom"); } });
  check("a failing pass still releases the lease", metaGet(dbL, SLEEP_LEASE_KEY) === "0", String(metaGet(dbL, SLEEP_LEASE_KEY)));

  closeMemoryDb(dbL);
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log("== 3e. output acceptance: a reply is not automatically a memory ==");
{
  // The first real run stored this refusal as a core memory:
  //   "由于涉及多个记忆条目且部分内容不完整，无法准确压缩为一句不超过100字的要点。建议补充完整信息后重试。"
  const refusal = "由于涉及多个记忆条目且部分内容不完整，无法准确压缩为一句不超过100字的要点。建议补充完整信息后重试。";
  const sources = ["豆包负责审核插件源码并生成报告", "把报告存到 reports 目录下"];
  check("a refusal is rejected", acceptSummary(refusal, sources).ok === false, acceptSummary(refusal, sources).reason);

  const good = "豆包负责审核插件源码并生成报告存于 reports 目录，只改报告不改代码。";
  const verdict = acceptSummary(good, sources);
  check("a real summary passes", verdict.ok === true, JSON.stringify(verdict));

  check("a question is not a summary",
    acceptSummary("这几条记忆说的是同一件事吗？", sources).ok === false);
  check("an apology is rejected",
    acceptSummary("抱歉，我无法完成这个压缩任务。", sources).ok === false);
  check("a bare acknowledgement is too short",
    acceptSummary("好的", sources).ok === false);
  check("no shared content means noise",
    acceptSummary("今天天气不错适合出去走走散散步吧", sources).ok === false);
  // The first real summary ended with "多语言按lang合并，" — cut mid-sentence by
  // the model's token limit. A dangling separator must not be stored.
  const dangling = acceptSummary("豆包负责审核插件源码并生成报告，多语言按lang合并，", sources);
  check("a dangling separator is stripped", dangling.ok === true && !/[，、；：,;]$/.test(dangling.text),
    JSON.stringify(dangling));
  check("an acknowledgement with a dangling separator is rejected",
    acceptSummary("好的，", sources).ok === false);

  check("an over-long reply is cut at a sentence boundary",
    (() => {
      const long = ("豆包负责审核插件源码。" ).repeat(20);
      const v = acceptSummary(long, sources);
      return v.ok === true && Array.from(v.text).length <= 120;
    })());

  // End to end: a rejected group must keep its originals — nothing written,
  // nothing archived — so the rows come back next night.
  const d = mkdtempSync(join(tmpdir(), "dshxf-gate-"));
  const dbG = openMemoryDb(join(d, "m.sqlite"));
  const ins = dbG.prepare(
    "INSERT INTO memories (id, role_id, layer, content, entities, strength, created_at, status) VALUES (?, 'global', 'recent', ?, ?, 1.0, ?, 'active')"
  );
  const ie = dbG.prepare("INSERT OR IGNORE INTO entity_index (entity, memory_id, confidence) VALUES (?, ?, 1.0)");
  for (let i = 0; i < 14; i++) {
    ins.run(`gate_${i}`, `关于豆包审核流程的第${i}条记录，内容各不相同。`, JSON.stringify(["豆包审核"]), Date.now() - i * 1000);
    ie.run("豆包审核", `gate_${i}`);
  }
  const gStats = await runNightlySleep(dbG, { summarize: async () => refusal });
  const alive = dbG.prepare("SELECT COUNT(*) n FROM memories WHERE status='active' AND id LIKE 'gate\_%' ESCAPE '\\'").get().n;
  check("a rejected group archives nothing", gStats.archived === 0, `archived=${gStats.archived}`);
  check("its originals are all still active", alive === 14, `alive=${alive}/14`);
  check("the rejection is recorded", gStats.rejectedGroups === 1 && gStats.rejections?.[0]?.reason === "refusal",
    JSON.stringify(gStats.rejections));
  closeMemoryDb(dbG);
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

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
