// test-console.mjs — verify the management console data operations.
import { openMemoryDb } from "./lib/db.js";
import { addMemory } from "./lib/db.js";
import { getMemoryStats, searchMemory, triggerNightlySleep, listSoulMemories } from "./lib/console.js";

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
ok(stats.evolution && typeof stats.evolution.retrievalWeight === "number", "getMemoryStats includes evolution");

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

console.log(`\nRESULT: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
