// test-capture-filter.mjs — the two leaks that put junk into the store.
import { CaptureTracker } from "./src/capture.js";

let pass = 0, fail = 0;
const check = (l, c, e = "") => {
  if (c) { pass++; console.log("  PASS  " + l + " " + e); }
  else { fail++; console.log("  FAIL  " + l + " " + e); }
};

/** Drive one turn through the tracker and return what it tried to store. */
async function runTurn(messages) {
  const stored = [];
  const tracker = new CaptureTracker({
    store: (m) => { stored.push(m); return { id: "x", merged: false }; },
    roleOf: () => "global",
    logger: { warn() {}, info() {} },
  });
  const sid = "s-" + Math.random().toString(36).slice(2);
  tracker.onEvent(sid, { type: "turn/start", seq: 1 });
  for (const m of messages) tracker.onEvent(sid, m);
  tracker.onEvent(sid, { type: "turn/end" });
  await new Promise((r) => setTimeout(r, 250));
  return stored;
}

const userMsg = (text, source = { kind: "user" }) => ({
  type: "user/message",
  data: { content: [{ type: "text", text }], source },
});

console.log("== 1. own injected recall must not be captured ==");
// This is the exact shape the plugin injects: kind is "dsh-xiaofei-memory",
// which a naive startsWith("memory") check does not match.
let out = await runTurn([
  userMsg("<memory-recall>以下是注入的旧记忆正文，绝不能被再次俘获写回。</memory-recall>",
    { kind: "dsh-xiaofei-memory", form: "memory-recall" }),
  userMsg("帮我看看插件版本对不对"),
]);
check("no entry contains the recall wrapper",
  !out.some((s) => String(s.content).includes("<memory-recall>")),
  JSON.stringify(out.map((s) => String(s.content).slice(0, 30))));
check("the real user question still gets captured", out.length > 0, `captured=${out.length}`);

// The kind guard must hold on its own, without the <memory-recall> text prefix:
// otherwise a future change to the wrapper silently re-opens the leak.
out = await runTurn([
  userMsg("纯文本注入体，不带 recall 包装", { kind: "dsh-xiaofei-memory", form: "memory-recall" }),
  userMsg("这是正常的用户提问"),
]);
check("own kind rejected even without the text prefix",
  !out.some((s) => String(s.content).includes("纯文本注入体")),
  JSON.stringify(out.map((s) => String(s.content).slice(0, 30))));

console.log("== 2. runtime instructions must not be captured ==");
out = await runTurn([
  userMsg('[SCHEDULE REMINDER] This is a scheduled message from the user schedule_id_json: "schedule-xxx" reminder_prompt_json: "【凌晨4点自动检查任务】..."'),
  userMsg("[meow-memory-reflect] 记忆反思任务 请回顾你的聊天历史。"),
]);
check("schedule reminder rejected", !out.some((s) => String(s.content).includes("SCHEDULE REMINDER")));
check("reflect task rejected", !out.some((s) => String(s.content).includes("meow-memory-reflect")));

console.log("== 3. genuine content still captured ==");
out = await runTurn([userMsg("记住：以后先出报告，等我确认再动手。")]);
check("real instruction captured", out.length > 0, `captured=${out.length}`);
check("content preserved", out.some((s) => String(s.content).includes("先出报告")));

console.log("== 4. memory-prefixed kinds still rejected ==");
out = await runTurn([
  userMsg("某条以 memory 开头的来源注入内容", { kind: "memory-notice" }),
  userMsg("这是正常的用户提问内容"),
]);
check("legacy memory* kind still filtered", !out.some((s) => String(s.content).includes("memory 开头的来源")));

console.log("== 5. leading whitespace tolerated ==");
out = await runTurn([userMsg("   \n  [SCHEDULE REMINDER] 带前导空白的提醒")]);
check("trimmed before prefix check", !out.some((s) => String(s.content).includes("SCHEDULE REMINDER")));

console.log("== 6. runtime-injected context must not be stored ==");
out = await runTurn([
  userMsg("帮我检查一下记忆插件的捕获逻辑\n<system-reminder>\nThe following workspace instructions may be relevant:\n- 先出报告再动手\n</system-reminder>"),
]);
check("system-reminder block stripped",
  !out.some((s) => String(s.content).includes("system-reminder")),
  JSON.stringify(out.map((s) => String(s.content))));
check("real text kept",
  out.some((s) => String(s.content).includes("帮我检查一下记忆插件的捕获逻辑")));

out = await runTurn([
  userMsg("帮我看看今天的记忆状态\n\nTime sampled while preparing turn 1, step 1: 2026-11-14T11:00:00+08:00\n\nBrowser time zone for this request: Asia/Shanghai.\n\nCurrent runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: C:\\x\nYou are the Lead."),
]);
check("runtime snapshot stripped",
  !out.some((s) => String(s.content).includes("Current runtime context") || String(s.content).includes("Time sampled")),
  JSON.stringify(out.map((s) => String(s.content))));
check("only the typed text remains",
  out.length === 1 && out[0].content === "帮我看看今天的记忆状态",
  JSON.stringify(out.map((s) => String(s.content))));

out = await runTurn([userMsg("继续 Current runtime context. This snapshot supersedes earlier runtime-context snapshots.")]);
check("boilerplate-only turn is not captured", out.length === 0, `captured=${out.length}`);

console.log("== 7. over-long captures are bounded and cannot reach core ==");
out = await runTurn([userMsg("记住：" + "这是一段被反复粘贴的内容。".repeat(400))]);
check("over-long capture is capped",
  out.length === 1 && String(out[0].content).length <= 1501,
  `len=${out[0] ? String(out[0].content).length : "none"}`);
check("capped content is not promoted to core", out.length === 1 && out[0].layer !== "core", `layer=${out[0]?.layer}`);

console.log("== 8. plugin-context blocks must not be stored ==");
out = await runTurn([
  userMsg('你是谁 [Plugin context from "batching-guidance"; not a user instruction or authorization.] # Batch tool calls\n1. **Call tools only inside run_code**: write await tools.<name>(args).\n2. **No dependencies, run concurrently**: use Promise.all.'),
]);
check("plugin-context block stripped",
  !out.some((s) => String(s.content).includes("Plugin context") || String(s.content).includes("run_code")),
  JSON.stringify(out.map((s) => String(s.content))));
check("'你是谁' alone is too short to store", out.length === 0, `captured=${out.length}`);

console.log("== 9. elapsed-time trailer must be stripped ==");
out = await runTurn([
  userMsg("帮我把这个接口改成 POST 方式\nElapsed since the preceding model-visible message: 12m 27s."),
]);
check("elapsed trailer stripped",
  !out.some((s) => String(s.content).includes("Elapsed since the preceding")),
  JSON.stringify(out.map((s) => String(s.content))));
check("typed text preserved",
  out.some((s) => String(s.content).includes("改成 POST 方式")));

console.log("== 10. discussing the phrase must not eat the user's line ==");
out = await runTurn([userMsg("为什么要显示 Elapsed since the preceding model-visible message 呢？后面我还要加日志")]);
check("mid-line mention is preserved",
  out.some((s) => String(s.content).includes("后面我还要加日志")),
  JSON.stringify(out.map((s) => String(s.content))));

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
