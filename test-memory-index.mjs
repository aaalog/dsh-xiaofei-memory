// test-memory-index.mjs — progressive disclosure: catalogue + on-demand read.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { openMemoryDb, closeMemoryDb, addMemory } from "./src/db.js";
import {
  buildMemoryIndex, renderMemoryIndex, memoryIndexSignature, resolveMemoryRef, shortMemoryId,
} from "./src/memory-index.js";
import { selectCoreMemories, CoreMemoryCache, renderCoreMemory } from "./src/core-memory.js";

let pass = 0, fail = 0;
const check = (l, c, e = "") => {
  if (c) { pass++; console.log("  PASS  " + l + " " + e); }
  else { fail++; console.log("  FAIL  " + l + " " + e); }
};

const dir = join(tmpdir(), `xmf-idx-${Date.now()}`);
const db = openMemoryDb(join(dir, "memory.sqlite"));

// A small store with a clear split: a few strong core memories that fit, and a
// tail that cannot — exactly the case the catalogue exists for.
//
// The texts must be genuinely dissimilar: addMemory archives a row whose
// similarity passes 0.75, and near-identical sentences built from one template
// collapse into each other, leaving fewer rows than intended.
const TOPICS = [
  "调试数据库锁超时，最后发现是 WAL 没有开。",
  "菜市场买了带鱼和青菜，回来做了红烧。",
  "打印机驱动坏了，重启后台服务就恢复。",
  "讨论衰减曲线，把半衰期设在六十九天。",
  "FTS5 的 trigram 分词对两个汉字完全失效。",
  "服务器证书快到期了，提前续了一张泛域名。",
  "把聊天桥接改成 WebSocket，省掉轮询开销。",
  "模型价格对比，便宜的flash够用但推理弱。",
  "夜间睡眠会把冗长的流水账压成摘要。",
  "实体抽取把时间地点词当实体，需要过滤。",
  "记忆按角色命名空间隔离，跨角色不串味。",
  "向量检索没做，目前全靠词法与共现。",
  "接口鉴权用临时令牌，只走本机回环。",
  "界面里的星云按层着色，强度决定大小。",
];
const made = [];
for (let i = 0; i < TOPICS.length; i++) {
  const r = addMemory(db, {
    roleId: "global",
    layer: i % 3 === 0 ? "weekly" : "core",
    content: TOPICS[i] + `（记录 ${i}）`,
    entities: [`主题${i}`, "记忆引擎"],
    strength: 3.0 - i * 0.15,
  });
  made.push(r.id);
}
const archived = db.prepare("SELECT count(*) c FROM memories WHERE status='archived'").get().c;
check("test fixture survived the merge pass", archived === 0, `archived=${archived}`);

console.log("== 1. short ids ==");
check("seeded id passes through", shortMemoryId("mem_003") === "mem_003");
check("generated id shortens to tail", shortMemoryId("mem_mw2v98qt_o21ky4") === "o21ky4");
check("non-mem id unchanged", shortMemoryId("plain") === "plain");

console.log("== 2. full block takes only what fits ==");
const full = selectCoreMemories(db, { roleIds: ["global"], maxTokens: 300, maxItemChars: 200, minStrength: 0 });
check("full block is budget-limited", full.length > 0 && full.length < made.length, `${full.length}/${made.length}`);

console.log("== 3. catalogue excludes what is already shown ==");
const idx = buildMemoryIndex(db, {
  roleIds: ["global"], excludeIds: full.map((f) => f.id), maxTokens: 200, limit: 40,
});
check("catalogue is non-empty", idx.length > 0, `${idx.length} entries`);
check("catalogue excludes the full block", idx.every((e) => !full.some((f) => f.id === e.id)));
check("catalogue has title + short id", idx.every((e) => e.short && e.title && e.chars > 0));

console.log("== 4. determinism ==");
const idx2 = buildMemoryIndex(db, {
  roleIds: ["global"], excludeIds: full.map((f) => f.id), maxTokens: 200, limit: 40,
});
check("same state -> same catalogue", JSON.stringify(idx) === JSON.stringify(idx2));
check("signature stable", memoryIndexSignature(idx) === memoryIndexSignature(idx2));

console.log("== 5. render ==");
const text = renderMemoryIndex(idx);
check("renders header + lines", text.includes("记忆索引") && text.includes("- ["));
check("mentions the read tool", text.includes("memory_core_read"));
check("empty catalogue renders empty", renderMemoryIndex([]) === "");

console.log("== 6. combined cache invalidation ==");
const cache = new CoreMemoryCache();
const t1 = cache.update(full, { indexEntries: idx });
const t2 = cache.update(full, { indexEntries: idx });
check("unchanged input -> identical text", t1 === t2);
check("text contains both tiers", t1.includes("常驻记忆") && t1.includes("记忆索引"));
// Drop one catalogue entry: the signature must change even though the full
// block is identical.
const t3 = cache.update(full, { indexEntries: idx.slice(1) });
check("catalogue change invalidates cache", t3 !== t1);

console.log("== 7. resolveMemoryRef ==");
const target = made[5];
const byFull = resolveMemoryRef(db, target);
check("resolves by full id", byFull && byFull.id === target);
const byShort = resolveMemoryRef(db, shortMemoryId(target));
check("resolves by short id", byShort && byShort.id === target, shortMemoryId(target));
check("unknown id returns null", resolveMemoryRef(db, "no_such_memory_id") === null);
check("empty ref returns null", resolveMemoryRef(db, "") === null);

console.log("== 8. never surfaces our own wrapper ==");
addMemory(db, { roleId: "global", layer: "core", content: "<memory-recall>注入残片，不应出现在索引</memory-recall>", entities: [], strength: 9 });
const idx3 = buildMemoryIndex(db, { roleIds: ["global"], maxTokens: 400, limit: 50 });
check("wrapper excluded from catalogue", !idx3.some((e) => e.title.includes("memory-recall")));

console.log("== 9. archived rows are invisible ==");
db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(target);
check("archived id no longer resolves", resolveMemoryRef(db, target) === null);
check("archived id not in catalogue", !buildMemoryIndex(db, { roleIds: ["global"], maxTokens: 400, limit: 50 }).some((e) => e.id === target));

// --- catalogue quality -------------------------------------------------
// The catalogue is how a memory outside the always-on block becomes findable
// without a search. Its budget fits a handful of lines, so a chat fragment in it
// costs a topic.
{
  const role = "catalogue-role";
  const fragment = addMemory(db, {
    roleId: role, layer: "weekly",
    content: "那好，你先开始重新设计这个app默认所有数据接口都存在后台",
  }).id;
  const rule = addMemory(db, {
    roleId: role, layer: "weekly",
    content: "公共数据的查询必须带 imgsrc LIKE http% 条件，否则会命中历史脏数据",
  }).id;
  const tiny = addMemory(db, { roleId: role, layer: "weekly", content: "好的" }).id;

  const cat = buildMemoryIndex(db, { roleIds: [role], maxTokens: 600, limit: 50 });
  const ids = cat.map((e) => e.id);
  check("a chat fragment is kept out of the catalogue", !ids.includes(fragment), JSON.stringify(ids.slice(0, 4)));
  check("a real rule is catalogued", ids.includes(rule));
  check("a two-character acknowledgement is not catalogued", !ids.includes(tiny));
  // Excluded from the catalogue, still readable: the guard is about display.
  check("the fragment is still readable on demand", resolveMemoryRef(db, fragment.slice(-6)) !== null);
}

closeMemoryDb(db);
rmSync(dir, { recursive: true, force: true });
console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
