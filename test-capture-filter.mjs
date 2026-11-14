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

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
