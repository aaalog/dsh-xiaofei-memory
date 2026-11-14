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
