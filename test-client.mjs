// test-client.mjs — verify the built client bundle loads and registers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");

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

// Call apply() with a mock ctx that supports slots.register/inject.
const slotsRegistered = [];
const slotsInjected = [];
const mockCtx = {
  get: () => undefined,
  slots: {
    register: (def, comp) => { slotsRegistered.push({ def, comp }); return () => {}; },
    inject: (slot, fn) => { slotsInjected.push({ slot, fn }); return () => {}; },
  },
};
let disposer = null;
try {
  disposer = exportsObj.apply(mockCtx);
} catch (e) {
  console.log("apply threw:", e.message);
}
ok(slotsInjected.some((s) => s.slot === "settings.section"), "injects settings.section slot");
ok(slotsRegistered.some((r) => r.def.name === "settings.section"), "registers a settings.section entry");
ok(typeof disposer === "function", "apply returns disposer");

console.log(`\nRESULT: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
