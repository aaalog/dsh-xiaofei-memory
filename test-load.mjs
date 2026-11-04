// test-load.mjs — verify the plugin module imports and apply() wires up with a mock ctx.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${label} ${extra}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
}

const mod = await import("./src/index.js");
check("exports name", mod.name === "dsh-xiaofei-memory");
check("exports inject", Array.isArray(mod.inject));
check("exports Config (schemastery callable)", typeof mod.Config === "function");
check("exports apply", typeof mod.apply === "function");

// Mock ctx.
const handlers = new Map();
const provided = {};
const tools = [];
const cleanups = [];
const ctx = {
  logger: { info: () => {}, warn: (...a) => console.log("  [warn]", ...a), error: console.error },
  on(event, handler) { handlers.set(event, handler); },
  provide(name, value) { provided[name] = value; },
  tools: { register(t) { tools.push(t); return () => {}; } },
  effect(fn) { cleanups.push(fn); },
  get() { return undefined; },
  inject() {},
};

const dbDir = join(tmpdir(), `dsh-xmf-load-${Date.now()}`);
const cfg = mod.Config({
  enabled: true,
  dbPath: join(dbDir, "memory.sqlite"),
  correctionTools: ["edit", "write"],
});
check("config parses with defaults", cfg.enabled === true && cfg.dampFactor === 0.85);
check("config uses provided dbPath", cfg.dbPath.includes("memory.sqlite"));

await mod.apply(ctx, cfg);
check("registered agent/pre-step handler", handlers.has("agent/pre-step"));
check("registered session/event handler", handlers.has("session/event"));
check("registered tools/result handler (correction)", handlers.has("tools/result"));
check("provided memory-core", typeof provided["memory-core"] === "object");
check("memory-core exposes retrieve/addFact/damp/stats", typeof provided["memory-core"]?.retrieve === "function" && typeof provided["memory-core"]?.addFact === "function" && typeof provided["memory-core"]?.damp === "function");
check("registered retrieve tool", tools.some((t) => t.name === "memory_core_retrieve"));
check("registered add_fact tool", tools.some((t) => t.name === "memory_core_add_fact"));
check("memory-core stats seeded", provided["memory-core"]?.stats()?.active === 10, `active=${provided["memory-core"]?.stats()?.active}`);

// Exercise memory-core API.
const fact = provided["memory-core"].addFact({ content: "测试事实：宝塔服务器在47.104.102.35", entities: ["宝塔", "服务器"] });
check("addFact returns id", typeof fact?.id === "string");
const recall = provided["memory-core"].retrieve("你觉得我是谁", { limit: 8 });
check("memory-core retrieve produces recall", recall !== null && recall.text.length > 0);
check("recall includes 赛博战友", recall.text.includes("赛博战友"));

// Tool outputs must satisfy their declared output schema: the Host validates
// the execute() value strictly (additionalProperties:false), so any extra key
// turns a successful call into a reported failure.
const retrieveTool = tools.find((t) => t.name === "memory_core_retrieve");
const addFactTool = tools.find((t) => t.name === "memory_core_add_fact");
function schemaViolations(tool, value) {
  const props = Object.keys(tool.output.schema.properties ?? {});
  const extra = Object.keys(value).filter((key) => !props.includes(key));
  const missing = (tool.output.schema.required ?? []).filter((key) => !(key in value));
  return [...extra.map((key) => `extra:${key}`), ...missing.map((key) => `missing:${key}`)];
}
const addResult = await addFactTool.execute({ content: "工具 schema 校验测试", layer: "recent" });
check("add_fact output matches its schema", schemaViolations(addFactTool, addResult).length === 0, schemaViolations(addFactTool, addResult).join(","));
check("add_fact reports merged", typeof addResult.merged === "boolean");
const retResult = await retrieveTool.execute({ query: "赛博战友" });
check("retrieve output matches its schema", schemaViolations(retrieveTool, retResult).length === 0, schemaViolations(retrieveTool, retResult).join(","));
const retRendered = retrieveTool.output.render({}, retResult).map((block) => block.text ?? "").join("");
check("retrieve render carries the recall text", retRendered.includes("<memory-recall>") && retRendered.includes("赛博战友"), retRendered.slice(0, 40));

// Run the registered pre-step handler with a fake decision.
const preStepHandler = handlers.get("agent/pre-step");
const decision = {
  kind: "enter",
  messages: [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "你觉得我是谁？" }] },
  ],
};
const out = await preStepHandler(
  { agent: { session: { id: "sess-1", header: { origin: "host", roleId: "global" } } }, messages: decision.messages, signal: { aborted: false } },
  async () => decision
);
check("pre-step injects a message", Array.isArray(out?.messages) && out.messages.length === 2);
check("injected message is <memory-recall>", (out?.messages?.[0]?.content?.[0]?.text ?? "").includes("<memory-recall>"));
check("injected source tagged", out?.messages?.[0]?.source?.kind === "dsh-xiaofei-memory");

// Cleanup.
for (const c of cleanups) c();
try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
