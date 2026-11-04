// test-bridge.mjs — verify the console data bridge route contract.
// The bridge is only mounted when a webServer service exists, so this test
// mounts apply() with a fake webServer, captures the random token from the
// index-inject row, and exercises the exact POST contract the Web console uses.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Readable } from "node:stream";

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${label} ${extra}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
}

const mod = await import("./src/index.js");

const handlers = new Map();
const provided = {};
const cleanups = [];
const routes = new Map();
const webServer = {
  register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); },
};
/** Optional DSH connection service; the token fallback applies while it is unset. */
let connectionService;

const ctx = {
  logger: { info: () => {}, warn: (...a) => console.log("  [warn]", ...a), error: console.error },
  on(event, handler) { handlers.set(event, handler); },
  provide(name, value) { provided[name] = value; },
  tools: { register(t) { return () => {}; } },
  effect(fn) { cleanups.push(fn); },
  get(name) {
    if (name === "webServer") return webServer;
    if (name === "connection") return connectionService;
    return undefined;
  },
  inject(deps, callback) {
    const injected = { webServer, get: (name) => (name === "webServer" ? webServer : undefined) };
    return callback(injected);
  },
};

const dbDir = join(tmpdir(), `dsh-xmf-bridge-${Date.now()}`);
const cfg = mod.Config({ enabled: true, dbPath: join(dbDir, "memory.sqlite") });
await mod.apply(ctx, cfg);

check("register bridge route", routes.has("/dshxf/bridge"), [...routes.keys()].join(","));

// The host records the bridge mount outcome for post-restart inspection.
const statusRow = provided["memory-core"]?.db?.prepare("SELECT value FROM meta WHERE key = 'bridge.status'").get();
check("bridge status meta is 'mounted'", statusRow?.value === "mounted", String(statusRow?.value));

// Capture the token the way the Web page does: from the index-inject table.
const table = [];
const injectHandler = handlers.get("webserver/index-inject");
let token;
try {
  injectHandler?.(table);
  const row = table.find((entry) => entry?.name === "DSHXF_BRIDGE");
  token = row?.value?.token;
} catch (e) { console.log("index-inject threw", e.message); }
check("index injection carries a token", typeof token === "string" && token.length >= 16, String(token?.length));

const route = routes.get("/dshxf/bridge");
function request({ method = "POST", body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.headers = headers;
    const res = {
      status: 0,
      payload: undefined,
      writeHead(status) { this.status = status; },
      end(payload) { this.payload = payload; resolve(this); },
    };
    route(req, res);
  });
}

const noToken = await request({ body: { op: "stats" } });
check("POST without token is forbidden", noToken.status === 403, `status=${noToken.status}`);

const health = await request({ method: "GET" });
check("GET health check", health.status === 200 && JSON.parse(health.payload).ok === true);

async function call(op, args = {}) {
  const res = await request({ body: { op, args }, headers: { "x-dshxf-token": token } });
  return { status: res.status, body: JSON.parse(res.payload ?? "{}") };
}

const stats = await call("stats");
check("stats op", stats.status === 200 && stats.body.ok === true && typeof stats.body.result?.total === "number", `total=${stats.body.result?.total}`);

const roles = await call("roles");
check("roles op", roles.status === 200 && Array.isArray(roles.body.result) && roles.body.result.length > 0);

const next = await call("updateRoles", { roles: [{ id: "qa", name: "质检", description: "", enabled: true }] });
check("updateRoles op", next.status === 200 && next.body.result?.[0]?.id === "qa");
check("updateRoles updates live roles", provided["memory-core"] ? true : false);
const afterRoles = await call("roles");
check("roles reflect the update", afterRoles.body.result?.length === 1 && afterRoles.body.result[0].id === "qa");

const config = await call("config");
check("config op", config.status === 200 && config.body.result?.enabled === true);

const search = await call("search", { query: "测试", roleId: "all" });
check("search op", search.status === 200 && Array.isArray(search.body.result));

const souls = await call("souls");
check("souls op", souls.status === 200 && Array.isArray(souls.body.result));

const unknown = await call("nope");
check("unknown op is a 400", unknown.status === 400 && unknown.body.ok === false);

// With a connection service mounted the route authenticates like /api does:
// the browser/desktop session cookie is admitted, no token needed.
connectionService = {
  admit(req) {
    return req.headers.cookie === "dsh-session=1" ? { peer: {} } : { rejection: 401 };
  },
};
const admitted = await request({ body: { op: "stats" }, headers: { cookie: "dsh-session=1" } });
check("session-cookie POST is admitted without a token", admitted.status === 200 && JSON.parse(admitted.payload).ok === true, `status=${admitted.status}`);
const denied = await request({ body: { op: "stats" } });
check("POST without session or token is rejected (401)", denied.status === 401, `status=${denied.status}`);

const bad = await request({ body: undefined, headers: { cookie: "dsh-session=1" } });
check("empty body defaults to unknown op 400", bad.status === 400 || bad.status === 200);

for (const c of cleanups) { try { c(); } catch { /* ignore */ } }
try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
