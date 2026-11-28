// test-console.mjs — verify the management console data operations.
import { openMemoryDb } from "./src/db.js";
import { addMemory } from "./src/db.js";
import { getMemoryStats, searchMemory, triggerNightlySleep, listSoulMemories, recordSleepRun, getSleepLog } from "./src/console.js";

const failures = [];
let passed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`); }
}

const db = openMemoryDb(":memory:");

// Seed some distinct memories across layers/roles
addMemory(db, { roleId: "companion", layer: "core", content: "你是小肥鱼，我的赛博战友，陪我理清现实乱麻。" });
addMemory(db, { roleId: "work-assistant", layer: "weekly", content: "开发A负责把设计决策落实为代码并验证。" });
addMemory(db, { roleId: "global", layer: "recent", content: "github.com 连通性受 hosts 映射影响，修复后 push 成功。" });
addMemory(db, { roleId: "global", layer: "recent", content: "记忆引擎用 trigram FTS + 大二元相似度打分。" });

// getMemoryStats
const stats = getMemoryStats(db);
ok(typeof stats.total === "number" && stats.total >= 4, "getMemoryStats returns total");
ok(stats.byLayer.core >= 1 && stats.byLayer.weekly >= 1 && stats.byLayer.recent >= 2, "getMemoryStats groups by layer");
ok(stats.byRole.companion >= 1 && stats.byRole["work-assistant"] >= 1, "getMemoryStats groups by role");
ok(stats.evolution === undefined, "getMemoryStats no longer reports a dead evolution loop");
ok(typeof stats.byLayer === "object" && typeof stats.byRole === "object", "getMemoryStats still reports the layers and roles");

// searchMemory
const results = searchMemory(db, { query: "赛博战友 小肥鱼", roleId: "companion" });
ok(Array.isArray(results) && results.length > 0, "searchMemory returns results");
ok(typeof results[0].strength === "number" && typeof results[0].score === "number", "searchMemory includes strength + score");
ok("layer" in results[0] && "roleId" in results[0], "searchMemory includes layer + roleId");
const all = searchMemory(db, { query: "记忆引擎", roleId: "all" });
ok(all.some((r) => r.content.includes("trigram")), "searchMemory roleId=all spans roles");

// triggerNightlySleep (no LLM)
const sleepResult = await triggerNightlySleep(db, {});
ok(sleepResult && typeof sleepResult === "object", "triggerNightlySleep returns result");

// listSoulMemories — seed has 10 mem_% soul rows
const souls = listSoulMemories(db);
ok(Array.isArray(souls) && souls.length === 10, `listSoulMemories returns 10 soul seeds (got ${souls.length})`);

// Nightly-sleep history: the pass is unattended, so the record is the only way
// to answer "what did it do last night". `triggerNightlySleep` above already
// recorded its own run, so measure the delta rather than the absolute count.
const logBefore = getSleepLog(db).length;
recordSleepRun(db, {
  threshold: 10, scanned: 20, distilledGroups: 2, distilledMemories: 9,
  archived: 8, skippedEntities: 5, skippedGroups: 1, vacuumed: true,
  details: [{ entity: "共同主题", roleId: "global", count: 4 }],
});
const log = getSleepLog(db);
ok(log.length === logBefore + 1, `sleep log appends one run (${logBefore} -> ${log.length})`);
ok(log[0]?.archived === 8 && log[0]?.distilledGroups === 2, "sleep log keeps the counters");
ok(log[0]?.groups?.[0]?.entity === "共同主题" && log[0]?.groups?.[0]?.count === 4,
  "sleep log keeps the distilled group shape");
ok(!("content" in (log[0]?.groups?.[0] ?? {})), "sleep log stores no memory text");

for (let i = 0; i < 35; i++) recordSleepRun(db, { archived: i });
const capped = getSleepLog(db, { limit: 30 });
ok(capped.length === 30, `sleep log caps at 30 entries (got ${capped.length})`);
ok(capped[0]?.archived === 34, "sleep log is newest-first");

console.log(`\nRESULT: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
