// test-dist.mjs — verify the production dist build loads and is well-formed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const failures = [];
let passed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`); }
}

// 1. dist/index.js exists and is a loadable ESM bundle exposing Config/apply
ok(fs.existsSync(path.join(root, "dist", "index.js")), "dist/index.js exists");
let mod;
try {
  mod = await import(pathToFileURL(path.join(root, "dist", "index.js")).href);
} catch (e) {
  console.log("  dist/index.js import failed:", e.message);
}
ok(mod && typeof mod.Config === "function", "dist/index.js exposes Config");
ok(mod && typeof mod.apply === "function", "dist/index.js exposes apply");
ok(Array.isArray(mod.inject), "dist/index.js exposes inject[]");

// 2. dist/client/index.js exists and is a module-loader bundle
ok(fs.existsSync(path.join(root, "dist", "client", "index.js")), "dist/client/index.js exists");
const clientCode = fs.readFileSync(path.join(root, "dist", "client", "index.js"), "utf8");
ok(clientCode.includes("window.__ModuleLoader__.load"), "dist/client/index.js registers via __ModuleLoader__");
ok(clientCode.includes('id: "dsh-xiaofei-memory"'), "dist/client/index.js has plugin id");
ok(clientCode.includes('require("react")'), "dist/client/index.js keeps react external");

// 3. Host bundle keeps @deepseek-ai + node builtins external (not inlined)
const hostCode = fs.readFileSync(path.join(root, "dist", "index.js"), "utf8");
ok(hostCode.includes("@deepseek-ai/schemastery"), "dist/index.js keeps schemastery external");
ok(!hostCode.includes("Cannot find module"), "dist/index.js has no unresolved require markers");

console.log(`\nRESULT: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
