// test-client.mjs — verify the built client bundle loads and registers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(root, "dist", "client", "index.js"), "utf8");

const failures = [];
let passed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`); }
}

let captured = null;
const registered = [];
const window = {
  __ModuleLoader__: { load: (def) => { captured = def; } },
};
const document = { head: { appendChild: () => {} }, querySelector: () => null, createElement: () => ({ dataset: {} }) };

// Provide a fake `require` for react (the bundle calls require("react")).
const React = { createElement: () => null };
function fakeRequire(name) { if (name === "react") return React; throw new Error("unexpected require: " + name); }

// Run the bundle in a fake browser-ish global.
const fn = new Function("window", "document", "require", code);
try {
  fn(window, document, fakeRequire);
} catch (e) {
  console.log("bundle evaluation threw:", e.message);
  process.exit(1);
}

ok(captured !== null, "client registered via window.__ModuleLoader__.load");
ok(captured.id === "dsh-xiaofei-memory", "registered id = dsh-xiaofei-memory");

// Invoke the factory and check the exports.
let exportsObj = null;
try {
  exportsObj = captured.factory(fakeRequire);
} catch (e) {
  console.log("factory threw:", e.message);
}
ok(exportsObj && typeof exportsObj.apply === "function", "factory exports apply()");
ok(exportsObj && Array.isArray(exportsObj.inject), "factory exports inject[]");

// Call apply() with a mock ctx that supports slots.register/inject and exposes
// a settings scope (settingsScope.bind) so the settings section mounts.
const slotsRegistered = [];
const slotsInjected = [];
const scopeService = { bind: () => ({ mode: "session", subscribe: () => () => {}, getSnapshot: () => ({ user: {}, mode: "session" }) }) };
const mockCtx = {
  get: (name) => (name === "settingsScope" ? scopeService : undefined),
  slots: {
    register: (def, comp) => { slotsRegistered.push({ def, comp }); return () => {}; },
    // Simulate the slot being declared: the inject callback fires immediately.
    inject: (slot, fn) => { slotsInjected.push({ slot, fn }); try { fn(); } catch (e) { console.log("inject cb threw:", e.message); } return () => {}; },
  },
};
let disposer = null;
try {
  disposer = exportsObj.apply(mockCtx);
} catch (e) {
  console.log("apply threw:", e.message);
}
ok(slotsInjected.some((s) => s.slot === "conversation.view"), "injects conversation.view slot");
const viewReg = slotsRegistered.find((r) => r.def.name === "conversation.view");
ok(!!viewReg, "registers the conversation.view tab");
ok(viewReg && viewReg.def.id === "dsh-xiaofei-memory", "view id is the plugin namespace");
ok(viewReg && viewReg.def.order === 40, "view sits after context(20)/fleet(30)");
ok(viewReg && typeof viewReg.def.label === "function" && viewReg.def.label() === "记忆引擎", "label is a thunk reading 记忆引擎");
ok(!slotsInjected.some((s) => s.slot === "conversation.session.header.actions"), "header button removed");
ok(slotsInjected.some((s) => s.slot === "settings.section"), "injects settings.section slot");
ok(slotsRegistered.some((r) => r.def.name === "settings.section"), "registers via injected slot");
ok(typeof disposer === "function", "apply returns disposer");

// Regression: an UNdeclared settings.section slot must NOT make apply() throw
// (this exact case previously crashed DSH web boot).
const crashingCtx = {
  get: (name) => (name === "settingsScope" ? scopeService : undefined),
  slots: {
    register: () => { throw new Error('slot "settings.section" is not declared'); },
    inject: (slot, fn) => { try { fn(); } catch { /* swallow as the guard does */ } return () => {}; },
  },
};
let crashThrew = false;
try { exportsObj.apply(crashingCtx); } catch { crashThrew = true; }
ok(!crashThrew, "apply() does not throw when settings.section is undeclared");

// --- bundle-level contracts that were fixed after shipping broken ---
ok(code.includes("data-conversation-composer-overlay"),
  "view elects a composer overlay (full-bleed column, no input card)");
ok(/\.dshxf-view\s*\{[^}]*z-index:\s*10/.test(code),
  "view paints above the composer seat (z-index 10)");
ok(!code.includes("if (existing) return"),
  "injectCss overwrites an existing style tag instead of skipping");
ok(code.includes("dshxf-pager") && code.includes("dshxf-rrow"),
  "row lists and the pager are present");

console.log(`\nRESULT: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
