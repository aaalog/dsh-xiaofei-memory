// test-dist-load.mjs — load the *built* dist and exercise the new code paths.
// Proves the rebuild actually contains working A-tier and B1 logic, not just
// that the source modules import.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

let pass = 0, fail = 0;
const check = (l, c, e = "") => {
  if (c) { pass++; console.log("  PASS  " + l + " " + e); }
  else { fail++; console.log("  FAIL  " + l + " " + e); }
};

const mod = await import("./dist/index.js");

console.log("== 1. bundle shape ==");
// Compare against the built value instead of a literal: the on-disk
// directory name is displayed rewritten, so a hardcoded string is fragile.
check("name exported", typeof mod.name === "string" && mod.name.endsWith("-xiaofei-memory"), mod.name);
check("Config exported", typeof mod.Config === "function");
check("apply exported", typeof mod.apply === "function");

const cfg = new mod.Config({ dbPath: join(tmpdir(), `xfdl-${Date.now()}`, "m.sqlite") });
console.log("== 2. new config fields survive the build ==");
check("enableCoreMemory present", cfg.enableCoreMemory === true, String(cfg.enableCoreMemory));
check("coreMemoryMaxTokens = 650", cfg.coreMemoryMaxTokens === 650, String(cfg.coreMemoryMaxTokens));
check("coreMemoryMaxItemChars = 300", cfg.coreMemoryMaxItemChars === 300, String(cfg.coreMemoryMaxItemChars));
check("coreMemoryMinStrength = 1", cfg.coreMemoryMinStrength === 1, String(cfg.coreMemoryMinStrength));

console.log("== 3. apply() with a mock ctx registers the section ==");
const handlers = new Map();
const sections = [];
const agents = [];
const disposers = [];
const ctx = {
  logger: { info: () => {}, warn: (...a) => console.log("  [warn]", ...a), error: console.error },
  on(ev, fn) { handlers.set(ev, fn); },
  get(name) {
    if (name === "systemPrompt") {
      return { section(spec) { sections.push(spec); return () => {}; }, getSectionOrder: () => undefined };
    }
    if (name === "agents") return { list: () => agents };
    return undefined;
  },
  inject(names, cb) {
    const scope = {
      systemPrompt: {
        section(spec) { sections.push(spec); return () => {}; },
        getSectionOrder: () => undefined,
      },
    };
    cb(scope);
    return { dispose: () => Promise.resolve() };
  },
  effect(fn) { disposers.push(fn); },
  provide() {},
  tools: { register() { return () => {}; } },
};

let threw = null;
try { await mod.apply(ctx, cfg); } catch (e) { threw = e; }
check("apply() did not throw", threw === null, threw ? String(threw.message) : "");

console.log("== 4. lifecycle wiring from the built bundle ==");
check("agent/created wired", handlers.has("agent/created"));
check("agent/disposed wired", handlers.has("agent/disposed"));
check("pre-step still wired", handlers.has("agent/pre-step"));
check("session/event still wired", handlers.has("session/event"));

// Simulate an agent being created -> its section must appear.
const fakeAgent = {
  id: "agent-x",
  session: { id: "s1", header: { roleId: "global" } },
  ctx: {
    inject(names, cb) {
      const scope = {
        systemPrompt: {
          section(spec) { sections.push(spec); return () => {}; },
          getSectionOrder: () => undefined,
        },
      };
      cb(scope);
      return { dispose: () => Promise.resolve() };
    },
  },
};
const before = sections.length;
await handlers.get("agent/created")({ agent: fakeAgent });
check("creating an agent installs a section", sections.length === before + 1, `${before} -> ${sections.length}`);
const sec = sections[sections.length - 1];
check("section name is memory:core", sec?.name === "memory:core", String(sec?.name));
check("section order is 10150", sec?.order === 10150, String(sec?.order));
check("interpolate disabled", sec?.interpolate === false);

console.log("== 5. section text renders core memories ==");
let rendered = "";
try { rendered = typeof sec.text === "function" ? sec.text({ scope: {} }) : sec.text; } catch (e) { rendered = "THREW: " + e.message; }
check("text() did not throw", !rendered.startsWith("THREW"), rendered.slice(0, 40));
check("text contains seeded soul memory", rendered.includes("赛博战友") || rendered.includes("小肥2号"), rendered.slice(0, 60));
check("text never contains injected recall wrapper", !rendered.includes("<memory-recall>"));

console.log("== 6. dispose is clean ==");
let disposeErr = null;
try {
  for (const fn of disposers) { const r = fn(); if (r && typeof r.then === "function") await r; }
} catch (e) { disposeErr = e; }
check("disposers ran without error", disposeErr === null, disposeErr ? String(disposeErr.message) : "");

const dir = join(tmpdir(), `xfdl-${Date.now()}`);
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
const dbPath = cfg.dbPath;
try { rmSync(join(dbPath, ".."), { recursive: true, force: true }); } catch { /* ignore */ }

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
