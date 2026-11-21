// src/client/index.tsx — dsh-xiaofei-memory management console (Browser half).
// A 4-tab settings page mounted to the `settings.section` slot.
// Config is read/written through the settings scope; data operations go
// through the host `memory-console` service bridged by the `remote` proxy.

import * as React from "react";
import cssText from "./styles.css";

type Role = { id: string; name: string; description: string; enabled: boolean };
type MemRow = { id: string; roleId: string; layer: string; content: string; strength: number; createdAt: string; score: number };
type Stats = { total: number; byLayer: Record<string, number>; byRole: Record<string, number>; evolution: { retrievalWeight: number; timeDecay: number } };

const NS = "dsh-xiaofei-memory";

/** Injected by build.mjs; the fallback covers source-mode runs. */
const BUILD_STAMP = typeof __DSHXF_BUILD__ === "string" ? __DSHXF_BUILD__ : "dev";

/**
 * Warn when the page and the running host come from different builds.
 *
 * Rebuilding writes new files to disk, but the host module is already in the
 * Node module cache — only a restart reloads it. Without this check the only
 * symptom is an "unknown op" error from whichever new op the page calls first.
 */
function useBuildMismatch(): { client: string; host: string | null } {
  const [host, setHost] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    callBridge("build")
      .then((r) => { if (alive && r && typeof r.build === "string") setHost(r.build); })
      .catch(() => { if (alive) setHost("unknown"); });
    return () => { alive = false; };
  }, []);
  return { client: BUILD_STAMP, host };
}

function hostService(ctx: any, name: string): any {
  try {
    const remote = ctx?.remote;
    if (remote && typeof remote === "object") {
      const svc = (remote as any)[name];
      if (svc) return svc;
    }
  } catch { /* ignore */ }
  try {
    if (typeof ctx.get === "function") {
      const direct = ctx.get(name);
      if (direct) return direct;
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Data bridge to the host half. DSH only exposes build-time generated Remote
 * namespaces to the page, so this plugin's console operations travel over the
 * host's owner-only loopback route (`/dshxf/bridge`). The page is authenticated
 * by the DSH session cookie that the shell attaches to every Host request; the
 * injected DSHXF_BRIDGE token is sent as an extra header when the host
 * provided one (fallback for compositions without a connection service).
 */
async function callBridge(op: string, args: any = {}): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bridge = (globalThis as any).DSHXF_BRIDGE;
  if (bridge && typeof bridge.token === "string") headers["x-dshxf-token"] = bridge.token;
  // Absolute, not relative: the View also renders on /s/<id>, where a relative
  // "dshxf/bridge" would resolve to /s/dshxf/bridge and 404. The host mounts the
  // route at the root, so anchor it there.
  const res = await fetch("/dshxf/bridge", {
    method: "POST",
    headers,
    body: JSON.stringify({ op, args }),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || !data || data.ok !== true) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "未授权：数据桥拒绝访问（请刷新页面）"
        : (data?.error ?? `HTTP ${res.status}`),
    );
  }
  return data.result;
}

// ── Shared list primitives ─────────────────────────────────────────────────
/**
 * How many rows fit on screen, capped at 12.
 *
 * A fixed page size either wastes a tall window or forces scrolling in a short
 * one, so the count follows the available height. The cap is 12 because more
 * than that stops being scannable regardless of screen size.
 */
const PAGE_SIZE_MAX = 12;
const PAGE_SIZE_MIN = 4;

function useRowsPerPage(rowHeight: number, cap = PAGE_SIZE_MAX): number {
  const [size, setSize] = React.useState(PAGE_SIZE_MIN);
  React.useEffect(() => {
    const compute = () => {
      // Reserve room for the tab chrome above the list and the pager below it.
      const available = Math.max(240, (window.innerHeight || 800) - 430);
      setSize(Math.min(cap, Math.max(PAGE_SIZE_MIN, Math.floor(available / rowHeight))));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [rowHeight, cap]);
  return size;
}

/** Page slice + the page state the pager needs. */
function usePaged<T>(items: T[], size: number) {
  const [page, setPage] = React.useState(1);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages);
  // A new result set starts at page 1; staying on page 7 of a 2-page list was
  // showing an empty table.
  React.useEffect(() => { setPage(1); }, [items.length, size]);
  const start = (current - 1) * size;
  return { page: current, setPage, pages, slice: items.slice(start, start + size), start };
}

/** Numbered pager: previous / page numbers / next, plus a total. */
function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) {
    return <div className="dshxf-pager"><span className="dshxf-pager-info">{total} 条</span></div>;
  }
  const from = Math.max(1, Math.min(page - 2, pages - 4));
  const to = Math.min(pages, from + 4);
  const nums: number[] = [];
  for (let n = from; n <= to; n++) nums.push(n);
  return (
    <div className="dshxf-pager">
      <button className="dshxf-pg" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      {nums.map((n) => (
        <button
          key={n}
          className={"dshxf-pg" + (n === page ? " dshxf-pg-on" : "")}
          aria-current={n === page ? "page" : undefined}
          onClick={() => onPage(n)}
        >{n}</button>
      ))}
      <button className="dshxf-pg" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button>
      <span className="dshxf-pager-info">{total} 条 · {pages} 页</span>
    </div>
  );
}

export function apply(ctx: any): () => void {
  // No `window.__ctx__` export: publishing the whole host context on the page
  // global handed every other same-origin plugin a wider capability surface
  // than the bridge token ever did. Nothing outside this module read it.
  try { injectCss(); } catch { /* ignore */ }
  probe("apply");

  // Primary mount: a first-class Conversation View tab, beside 对话/轨迹/上下文.
  // `conversation.view` is an open list with replaceRisk "none": registering a
  // fresh id adds a cell instead of shadowing a shipped one.
  const disposeView = mountConversationView(ctx);

  // Secondary mount: the detailed console in Settings, kept for the write-side
  // operations (role editing, manual sleep) that do not belong in a read-only
  // conversation tab.
  const disposeSettings = mountSettings(ctx);

  return () => {
    try { disposeView?.(); } catch { /* ignore */ }
    try { disposeSettings?.(); } catch { /* ignore */ }
  };
}

/**
 * Mount the memory view as a Conversation View tab.
 *
 * Ordered after the shipped 对话(0)/轨迹(10) and dsh-context's 上下文(20)/
 * 编队(30), so it lands at the right edge of the row without disturbing them.
 */
function mountConversationView(ctx: any): () => void {
  let disposeEntry: (() => void) | null = null;
  let disposeInjection: (() => void) | null = null;
  const register = () => {
    try { disposeEntry?.(); } catch { /* ignore */ }
    try {
      disposeEntry = ctx.slots.register(
        {
          name: "conversation.view",
          id: NS,
          order: 40,
          // A thunk so the label follows the active locale without re-registering.
          label: () => "记忆引擎",
        },
        MemoryView
      );
      probe("conversation.view registered");
    } catch (e) {
      console.warn("[dsh-xiaofei-memory] conversation.view unavailable:", e);
    }
  };
  try { disposeInjection = ctx.slots.inject("conversation.view", register); }
  catch (e) { console.warn("[dsh-xiaofei-memory] conversation.view inject failed", e); }
  return () => {
    try { disposeInjection?.(); } catch { /* ignore */ }
    try { disposeEntry?.(); } catch { /* ignore */ }
  };
}

/**
 * Mount the console into the Settings page section, following meow-memory's
 * strategy: use settingsScope.bind({namespace}) when present, otherwise poll
 * the configForms service (up to ~30s) and mount with configForms.get(ns).
 */
function mountSettings(ctx: any): () => void {
  const mountWithScope = (scope: any) => {
    probe("mountWithScope scope=" + (scope ? "yes" : "no"));
    let disposeEntry: (() => void) | null = null;
    let disposeInjection: (() => void) | null = null;
    const registerSection = () => {
      try { disposeEntry?.(); } catch { /* ignore */ }
      probe("register settings.section");
      try {
        disposeEntry = ctx.slots.register(
          {
            name: "settings.section",
            id: NS,
            order: 35,
            label: () => "小肥鱼记忆引擎",
            inject: () => ({ scope }),
          },
          ConsolePage
        );
      } catch (e) {
        console.warn("[dsh-xiaofei-memory] settings.section unavailable:", e);
      }
    };
    try { disposeInjection = ctx.slots.inject("settings.section", registerSection); }
    catch (e) { console.warn("[dsh-xiaofei-memory] settings slot inject failed", e); }
    return () => {
      try { disposeInjection?.(); } catch { /* ignore */ }
      try { disposeEntry?.(); } catch { /* ignore */ }
    };
  };

  const settingsScope = softService(ctx, "settingsScope");
  if (settingsScope !== undefined && settingsScope !== null) {
    probe("settingsScope present");
    return mountWithScope(typeof settingsScope.bind === "function" ? settingsScope.bind({ namespace: NS }) : settingsScope);
  }

  let disposer: (() => void) | null = null;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    const forms = softService(ctx, "configForms");
    if (forms !== undefined && typeof forms.get === "function") {
      probe("configForms ready at attempt " + attempts);
      clearInterval(timer);
      disposer = mountWithScope(forms.get(NS));
    } else if (attempts >= 75) {
      clearInterval(timer);
      probe("configForms NOT ready after 30s");
      console.info("[dsh-xiaofei-memory] configForms not ready; settings section unregistered");
    }
  }, 400);
  return () => {
    clearInterval(timer);
    try { disposer?.(); } catch { /* ignore */ }
  };
}

function softService(ctx: any, name: string): any {
  try { if (typeof ctx.get === "function") return ctx.get(name); } catch { /* ignore */ }
  try { return ctx[name]; } catch { return undefined; }
}

/**
 * Diagnostic hook, now inert.
 *
 * It used to append a line to `%TEMP%\dshxf-probe.log` on every apply and on
 * every mount attempt, which is debugging scaffolding that should not ship. The
 * call sites are kept so the surrounding flow stays readable; the body is a
 * no-op, and it no longer needs the host context.
 */
function probe(_msg: string): void {
  /* intentionally empty */
}

/**
 * The 记忆引擎 Conversation View.
 *
 * Read-only by design: a conversation tab is for understanding, and every
 * mutation lives in the Settings console. The always-on block is rendered by
 * the host from the same selector the prompt section uses, so what is shown
 * here is exactly what the model receives.
 */
function MemoryView(_props: any) {
  const [core, setCore] = React.useState<any>(null);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [err, setErr] = React.useState("");
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<MemRow[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    // Load independently: one failing op must not blank the whole view. The
    // always-on block is the primary content, so a stats failure should only
    // cost the numbers, not the page.
    callBridge("core")
      .then((c) => { if (alive) setCore(c); })
      .catch((e: any) => { if (alive) setErr(String(e?.message ?? e)); });
    callBridge("stats")
      .then((s) => { if (alive) setStats(s); })
      .catch(() => { /* stats are optional */ });
    return () => { alive = false; };
  }, []);

  const search = async () => {
    if (!q.trim()) { setHits(null); return; }
    setBusy(true);
    try { setHits(await callBridge("search", { query: q })); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };

  const layers = stats?.byLayer ?? {};
  const build = useBuildMismatch();
  const stale = build.host !== null && build.host !== "unknown" && build.host !== build.client;
  return React.createElement("div", { className: "dshxf-view" },
    React.createElement("div", { className: "dshxf-inner" },
    stale
      ? React.createElement("div", { className: "dshxf-card dshxf-warn" },
          React.createElement("b", null, "插件已更新，但运行时仍在用旧版本"),
          React.createElement("div", { className: "dshxf-note" },
            `页面构建 ${build.client} · 运行时构建 ${build.host}。请重启 DSH 以加载新的后端模块。`))
      : null,
    err
      ? React.createElement("div", { className: "dshxf-card dshxf-danger" },
          React.createElement("div", { className: "dshxf-note" }, `数据桥错误：${err}`))
      : null,
    // ── always-on block ──────────────────────────────────────────────
    React.createElement("div", { className: "dshxf-card" },
      React.createElement("div", { className: "dshxf-card-head" },
        React.createElement("h3", { className: "dshxf-h" }, "常驻记忆"),
        React.createElement("span", { className: "dshxf-tag" },
          core ? `${core.entries?.length ?? 0} 条 · ${core.tokens} tokens` : "加载中…")
      ),
      React.createElement("p", { className: "dshxf-note" },
        "以下内容每轮都会作为系统提示词注入，不依赖检索。段名 ",
        React.createElement("code", null, core?.section ?? "memory:core"),
        "，顺序 ",
        React.createElement("code", null, String(core?.order ?? 10150)),
        "。"
      ),
      React.createElement("pre", { className: "dshxf-pre" }, core?.text || "（暂无常驻记忆）")
    ),

    // ── stats ────────────────────────────────────────────────────────
    React.createElement("div", { className: "dshxf-card" },
      React.createElement("h3", { className: "dshxf-h" }, "记忆总量"),
      React.createElement("div", { className: "dshxf-stats" },
        React.createElement("div", { className: "dshxf-stat" },
          React.createElement("b", null, String(stats?.total ?? 0)),
          React.createElement("span", null, "条活跃")),
        ["core", "weekly", "recent"].map((k) =>
          React.createElement("div", { className: "dshxf-stat", key: k },
            React.createElement("b", null, String(layers[k] ?? 0)),
            React.createElement("span", null, k)))
      )
    ),

    // ── full console (roles / graph / sleep / system) ────────────────
    // Reuses the Settings page component verbatim: one implementation, two
    // mount points, so the View is never a reduced copy of the real console.
    React.createElement("div", { className: "dshxf-card" },
      React.createElement(ConsolePage, { scope: getScope((window as any).__ctx__) })
    ),

    // ── search ───────────────────────────────────────────────────────
    React.createElement("div", { className: "dshxf-card" },
      React.createElement("h3", { className: "dshxf-h" }, "检索预览"),
      React.createElement("div", { className: "dshxf-row" },
        React.createElement("input", {
          className: "dshxf-in dshxf-grow",
          placeholder: "输入一句话，看会检索到什么…",
          value: q,
          onChange: (e: any) => setQ(e.target.value),
          onKeyDown: (e: any) => { if (e.key === "Enter") void search(); },
        }),
        React.createElement("button", {
          className: "dshxf-btn dshxf-primary",
          onClick: () => void search(),
          disabled: busy,
        }, busy ? "检索中…" : "检索")
      ),
      hits === null
        ? null
        : React.createElement("div", { className: "dshxf-list" },
            hits.length === 0
              ? React.createElement("div", { className: "dshxf-note" }, "无匹配")
              : hits.map((m) =>
                  React.createElement("div", { className: "dshxf-mem", key: m.id },
                    React.createElement("div", { className: "dshxf-mem-meta" },
                      React.createElement("span", { className: "dshxf-tag" }, m.layer),
                      React.createElement("span", { className: "dshxf-tag" }, m.roleId),
                      React.createElement("span", { className: "dshxf-str" }, `s=${Number(m.strength).toFixed(2)}`),
                      React.createElement("span", { className: "dshxf-str" }, `score=${Number(m.score).toFixed(3)}`)
                    ),
                    React.createElement("div", { className: "dshxf-mem-body" }, m.content)
                  )))
    )
    )
  );
}

function getScope(ctx: any): any {
  const s = softService(ctx, "settingsScope");
  if (s !== undefined && s !== null) return typeof s.bind === "function" ? s.bind({ namespace: NS }) : s;
  const forms = softService(ctx, "configForms");
  if (forms !== undefined && typeof forms.get === "function") {
    try { return forms.get(NS); } catch { /* ignore */ }
  }
  return undefined;
}

function injectCss() {
  try {
    const existing = document.querySelector("style[data-dshxf-console-css]");
    if (existing) return;
    const tag = document.createElement("style");
    tag.dataset.dshxfConsoleCss = "true";
    tag.dataset.plugin = "dsh-xiaofei-memory";
    tag.textContent = cssText;
    document.head.appendChild(tag);
  } catch { /* ignore */ }
}

export const inject = ["slots"];

/** Stable fallback snapshot: useSyncExternalStore requires a cached value. */
const EMPTY_CONFIG = { user: {}, mode: "unknown" };

// ── shared hook: read config from settings scope ────────────────────────────
// Always calls the same hooks regardless of `scope`, so an initially-missing
// scope (then present) cannot violate the React hooks order.
function useConfig(scope: any): { user: any; mode: string } {
  const subscribe = React.useCallback(
    (cb: () => void) => (scope && typeof scope.subscribe === "function" ? scope.subscribe(cb) : () => {}),
    [scope]
  );
  const getSnapshot = React.useCallback(
    () => (scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : EMPTY_CONFIG),
    [scope]
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function ConsolePage(props: any) {
  const scope = props.scope;
  const { user, mode } = useConfig(scope);
  const [tab, setTab] = React.useState<"roles" | "memories" | "sleep" | "system">("roles");
  const tabs: { id: string; label: string }[] = [
    { id: "roles", label: "角色与路由" },
    { id: "memories", label: "记忆图谱" },
    { id: "sleep", label: "夜间睡眠" },
    { id: "system", label: "底层系统" },
  ];
  return (
    <div className="dshxf-console">
      <div className="dshxf-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            className={`dshxf-tab ${tab === t.id ? "is-active" : ""}`}
            onClick={() => setTab(t.id as any)}>{t.label}</button>
        ))}
      </div>
      <div className="dshxf-panel" role="tabpanel">
        {mode === "memory" && <div className="dshxf-note">镜像模式：配置只读，需退出记忆镜像才能修改。</div>}
        {tab === "roles" && <RolesTab scope={scope} user={user} />}
        {tab === "memories" && <MemoriesTab scope={scope} user={user} />}
        {tab === "sleep" && <SleepTab scope={scope} user={user} />}
        {tab === "system" && <SystemTab scope={scope} user={user} />}
      </div>
    </div>
  );
}

// ── Tab 1: Roles & routing ─────────────────────────────────────────────────
function RolesTab({ scope, user }: { scope: any; user: any }) {
  const scopeReady = !!scope && typeof scope.set === "function";
  const propRoles: Role[] = Array.isArray(user?.roles) ? user.roles : [];
  const [draft, setDraft] = React.useState<Role[]>(propRoles.map((r) => ({ ...r })));
  const [msg, setMsg] = React.useState("");
  React.useEffect(() => {
    if (scopeReady) {
      setDraft(propRoles.map((r) => ({ ...r })));
      return;
    }
    callBridge("roles")
      .then((rows) => setDraft(Array.isArray(rows) ? rows.map((r: Role) => ({ ...r })) : []))
      .catch((e: any) => setMsg("读取角色失败: " + (e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeReady, JSON.stringify(propRoles)]);

  const save = async () => {
    try {
      if (scopeReady) {
        const ok = await scope.set("roles", draft);
        setMsg(ok === false ? "保存未生效" : "已保存 ✓");
      } else {
        const next = await callBridge("updateRoles", { roles: draft });
        if (Array.isArray(next)) setDraft(next.map((r: Role) => ({ ...r })));
        setMsg("已保存 ✓");
      }
    } catch (e: any) { setMsg("保存失败: " + (e?.message ?? e)); }
  };
  const mutate = (i: number, patch: Partial<Role>) =>
    setDraft((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <div>
      <h3 className="dshxf-h">角色与路由</h3>
      {draft.map((r, i) => (
        <div className="dshxf-row" key={i}>
          <input className="dshxf-in" value={r.id} placeholder="id"
            onChange={(e) => mutate(i, { id: e.target.value })} />
          <input className="dshxf-in dshxf-grow" value={r.name} placeholder="名称"
            onChange={(e) => mutate(i, { name: e.target.value })} />
          <input className="dshxf-in dshxf-grow" value={r.description} placeholder="描述"
            onChange={(e) => mutate(i, { description: e.target.value })} />
          <label className="dshxf-check">
            <input type="checkbox" checked={r.enabled} onChange={(e) => mutate(i, { enabled: e.target.checked })} />
            启用
          </label>
          <button className="dshxf-btn dshxf-danger" onClick={() => setDraft((p) => p.filter((_, idx) => idx !== i))}>删</button>
        </div>
      ))}
      <div className="dshxf-actions">
        <button className="dshxf-btn" onClick={() => setDraft((p) => [...p, { id: "", name: "", description: "", enabled: true }])}>+ 添加角色</button>
        <button className="dshxf-btn dshxf-primary" onClick={save}>保存角色</button>
        <span className="dshxf-msg">{msg}</span>
      </div>
    </div>
  );
}

// ── Tab 2: Memory graph ────────────────────────────────────────────────────
/**
 * MemorySea — a canvas starfield of memories.
 *
 * Design constraints, in order:
 * 1. It must stay readable. A pretty cloud that hides what it means is worse
 *    than a list, so the list stays below and the canvas is a map, not a table.
 * 2. It must stay cheap. Canvas 2D, no dependency, a hard node cap, and a
 *    single rAF loop that stops when the layout settles or the tab is hidden.
 * 3. It must reflect the engine. Position comes from a small force layout over
 *    the same entity links `entity_index` produces, so clusters mean what the
 *    retriever thinks they mean.
 *
 * Layer sets the colour; strength sets the radius; a search hit pulses.
 */
const LAYER_COLORS: Record<string, string> = {
  core: "#e8b84b",
  weekly: "#4fb3d9",
  recent: "#9b8cd9",
  diffusion: "#6b7280",
};

type SeaNode = {
  id: string; layer: string; strength: number; excerpt: string;
  entities: string[]; x: number; y: number; vx: number; vy: number;
};
type SeaLink = { source: string; target: string; entity: string; weight: number };

function MemorySea(props: {
  nodes: any[]; links: SeaLink[]; highlight?: string | null;
  onHover?: (id: string | null) => void; onPick?: (id: string) => void;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const stateRef = React.useRef<{ nodes: SeaNode[]; links: SeaLink[] }>({ nodes: [], links: [] });
  const hoverRef = React.useRef<string | null>(null);
  const [size, setSize] = React.useState({ w: 640, h: 300 });

  // Build the simulation nodes once per data change.
  React.useEffect(() => {
    const cap = 200;
    const raw = (props.nodes || []).slice(0, cap);
    const { w, h } = size;
    const nodes: SeaNode[] = raw.map((n: any, i: number) => {
      const a = (i / Math.max(1, raw.length)) * Math.PI * 2;
      // Seed on a spiral so the first frames already look like a field.
      const r = Math.min(w, h) * (0.14 + 0.34 * ((i % 7) / 7));
      return {
        id: n.id,
        layer: n.layer || "recent",
        strength: Number(n.strength) || 1,
        excerpt: n.excerpt || "",
        entities: Array.isArray(n.entities) ? n.entities : [],
        x: w / 2 + Math.cos(a) * r,
        y: h / 2 + Math.sin(a) * r,
        vx: 0, vy: 0,
      };
    });
    const known = new Set(nodes.map((n) => n.id));
    const links = (props.links || [])
      .filter((l: SeaLink) => known.has(l.source) && known.has(l.target))
      .slice(0, 900);
    stateRef.current = { nodes, links };
  }, [props.nodes, props.links]);

  // Track the wrapper size. Measure once immediately: a tab that mounts while
  // hidden has zero width, and waiting for a ResizeObserver callback alone can
  // leave the canvas at its placeholder size forever.
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      if (w > 0) {
        setSize((cur) => (cur.w === w ? cur : { w, h: Math.max(240, Math.min(420, Math.round(w * 0.42))) }));
      }
    };
    measure();
    let ro: any = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    const t = setTimeout(measure, 60);
    return () => { clearTimeout(t); try { ro?.disconnect(); } catch { /* ignore */ } };
  }, []);

  // The single animation loop.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, (window as any).devicePixelRatio || 1);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let alive = true;
    let ticks = 0;

    const step = () => {
      const { nodes, links } = stateRef.current;
      const { w, h } = size;
      const cx = w / 2, cy = h / 2;
      const index = new Map(nodes.map((n) => [n.id, n]));

      // ── forces ──────────────────────────────────────────────────
      for (const n of nodes) {
        n.vx += (cx - n.x) * 0.0012;
        n.vy += (cy - n.y) * 0.0012;
      }
      for (const l of links) {
        const a = index.get(l.source), b = index.get(l.target);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const target = 60 + 40 * (1 - Math.min(1, l.weight));
        const f = ((d - target) / d) * 0.012 * (0.4 + l.weight);
        const fx = dx * f, fy = dy * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      if (nodes.length <= 200) {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            let dx = b.x - a.x, dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) { d2 = 1; dx = 0.5; dy = 0.5; }
            if (d2 > 40000) continue;
            const f = 90 / d2;
            const d = Math.sqrt(d2);
            a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
            b.vx += (dx / d) * f; b.vy += (dy / d) * f;
          }
        }
      }
      for (const n of nodes) {
        n.vx *= 0.86; n.vy *= 0.86;
        n.x += n.vx; n.y += n.vy;
        const pad = 18;
        if (n.x < pad) { n.x = pad; n.vx *= -0.4; }
        if (n.x > w - pad) { n.x = w - pad; n.vx *= -0.4; }
        if (n.y < pad) { n.y = pad; n.vy *= -0.4; }
        if (n.y > h - pad) { n.y = h - pad; n.vy *= -0.4; }
      }

      // ── draw ────────────────────────────────────────────────────
      ctx.clearRect(0, 0, w, h);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.6);
      glow.addColorStop(0, "rgba(80,110,180,0.10)");
      glow.addColorStop(1, "rgba(80,110,180,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      const hi = props.highlight || null;
      const hovered = hoverRef.current;

      for (const l of links) {
        const a = index.get(l.source), b = index.get(l.target);
        if (!a || !b) continue;
        const active = hi ? (a.id === hi || b.id === hi) : false;
        ctx.strokeStyle = active ? "rgba(120,200,255,0.55)" : "rgba(140,160,200," + (0.05 + 0.12 * l.weight) + ")";
        ctx.lineWidth = active ? 1.4 : 0.6;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      for (const n of nodes) {
        const base = LAYER_COLORS[n.layer] || LAYER_COLORS.recent;
        const r = 2.2 + Math.min(5.5, Math.log2(1 + n.strength) * 1.7);
        const isHi = hi === n.id;
        const isHover = hovered === n.id;
        ctx.globalAlpha = hi && !isHi ? 0.28 : 1;

        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3.2);
        g.addColorStop(0, base);
        g.addColorStop(0.35, base + "88");
        g.addColorStop(1, base + "00");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 3.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = base;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();

        if (isHi || isHover) {
          ctx.strokeStyle = isHi ? "#7fd4ff" : "#ffffff";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      ticks++;
      // Settle: once the layout is calm, stop instead of burning frames on a
      // static picture. Hover or a data change restarts it.
      const moving = nodes.some((n) => Math.abs(n.vx) + Math.abs(n.vy) > 0.05);
      if (alive && (moving || ticks < 120)) raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);

    const pick = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      let best: SeaNode | null = null;
      let bestD = 22;
      for (const n of stateRef.current.nodes) {
        const d = Math.hypot(n.x - mx, n.y - my);
        if (d < bestD) { bestD = d; best = n; }
      }
      return best;
    };
    const wake = () => {
      cancelAnimationFrame(raf);
      ticks = 0;
      raf = requestAnimationFrame(step);
    };
    const onMove = (ev: MouseEvent) => {
      const hit = pick(ev);
      const id = hit ? hit.id : null;
      if (id !== hoverRef.current) {
        hoverRef.current = id;
        canvas.style.cursor = id ? "pointer" : "default";
        props.onHover?.(id);
        wake();
      }
    };
    const onClick = (ev: MouseEvent) => {
      const hit = pick(ev);
      if (hit) props.onPick?.(hit.id);
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);

    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else wake();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [size, props.nodes, props.links, props.highlight]);

  const nodeCount = (props.nodes || []).length;
  return React.createElement("div", { className: "dshxf-sea", ref: wrapRef },
    nodeCount === 0
      ? React.createElement("div", { className: "dshxf-sea-empty" }, "正在载入记忆…")
      : null,
    React.createElement("canvas", {
      ref: canvasRef,
      className: "dshxf-sea-canvas",
      style: { width: "100%", height: size.h + "px" },
    }),
    React.createElement("div", { className: "dshxf-sea-legend" },
      ["core", "weekly", "recent"].map((k) =>
        React.createElement("span", { key: k, className: "dshxf-sea-key" },
          React.createElement("i", { style: { background: LAYER_COLORS[k] } }), k))
    )
  );
}

function MemoriesTab({ scope, user }: { scope: any; user: any }) {
  const roles: Role[] = Array.isArray(user?.roles) ? user.roles : [];
  const [query, setQuery] = React.useState("");
  const [roleId, setRoleId] = React.useState("all");
  const [rows, setRows] = React.useState<MemRow[]>([]);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [msg, setMsg] = React.useState("");
  const [graph, setGraph] = React.useState<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] });
  const [hoverId, setHoverId] = React.useState<string | null>(null);
  const [pickId, setPickId] = React.useState<string | null>(null);
  const pageSize = useRowsPerPage(78);
  const paged = usePaged(rows, pageSize);

  const refreshStats = () => {
    callBridge("stats")
      .then((s) => setStats(s))
      .catch((e: any) => setMsg("统计失败: " + (e?.message ?? e)));
  };
  const doSearch = () => {
    setMsg("检索中…");
    callBridge("search", { query, roleId })
      .then((res) => {
        setRows(Array.isArray(res) ? res : []);
        setMsg(`找到 ${Array.isArray(res) ? res.length : 0} 条`);
      })
      .catch((e: any) => setMsg("检索失败: " + (e?.message ?? e)));
  };
  React.useEffect(() => {
    refreshStats();
    // The sea needs every active memory, not just a query's hits.
    callBridge("graph")
      .then((g) => {
        if (g && Array.isArray(g.nodes)) setGraph({ nodes: g.nodes, links: g.links || [] });
        else setMsg("图谱数据格式异常");
      })
      .catch((e: any) => { setMsg("图谱加载失败: " + (e?.message ?? e)); });
  }, []);

  return (
    <div>
      <h3 className="dshxf-h">记忆图谱</h3>
      <div className="dshxf-note">
        {graph.nodes.length > 0
          ? `${graph.nodes.length} 个节点 · ${graph.links.length} 条关系`
          : "尚无节点数据"}
        {msg ? ` · ${msg}` : ""}
      </div>
      <MemorySea
        nodes={graph.nodes}
        links={graph.links}
        highlight={hoverId || pickId}
        onHover={(id) => setHoverId(id)}
        onPick={(id) => setPickId((cur) => (cur === id ? null : id))}
      />
      {pickId
        ? React.createElement("div", { className: "dshxf-sea-pick" },
            (() => {
              const n = graph.nodes.find((x) => x.id === pickId);
              if (!n) return null;
              return React.createElement(React.Fragment, null,
                React.createElement("div", { className: "dshxf-mem-meta" },
                  React.createElement("span", { className: "dshxf-tag" }, n.layer),
                  React.createElement("span", { className: "dshxf-tag" }, n.roleId || "global"),
                  React.createElement("span", { className: "dshxf-str" }, "s=" + Number(n.strength).toFixed(2)),
                  React.createElement("span", { className: "dshxf-str" }, n.length + " 字")
                ),
                React.createElement("div", { className: "dshxf-mem-body" }, n.excerpt)
              );
            })()
          )
        : React.createElement("div", { className: "dshxf-note" }, "悬停查看关系，点击星点查看内容")}
      {stats && (
        <div className="dshxf-stats">
          <span>总记忆 <b>{stats.total}</b></span>
          <span>core <b>{stats.byLayer.core ?? 0}</b></span>
          <span>weekly <b>{stats.byLayer.weekly ?? 0}</b></span>
          <span>recent <b>{stats.byLayer.recent ?? 0}</b></span>
          <span>检索权重 <b>{typeof stats.evolution?.retrievalWeight === "number" ? stats.evolution.retrievalWeight.toFixed(2) : "—"}</b></span>
        </div>
      )}
      <div className="dshxf-actions">
        <input className="dshxf-in dshxf-grow" placeholder="检索关键词…" value={query}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doSearch()} />
        <select className="dshxf-in" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="all">全部角色</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button className="dshxf-btn dshxf-primary" onClick={doSearch}>检索</button>
        <button className="dshxf-btn" onClick={refreshStats}>刷新统计</button>
      </div>
      <div className="dshxf-msg">{msg}</div>
      <div className="dshxf-rows">
        {paged.slice.map((r) => (
          <div key={r.id} className="dshxf-rrow">
            <div className="dshxf-rrow-top">
              <span className="dshxf-tag">{r.roleId}</span>
              <span className="dshxf-tag">{r.layer}</span>
              <span className="dshxf-tag dshxf-str">强度 {typeof r.strength === "number" ? r.strength.toFixed(2) : String(r.strength ?? "—")}</span>
              {typeof r.score === "number" && <span className="dshxf-tag">分 {r.score.toFixed(2)}</span>}
            </div>
            <div className="dshxf-rrow-body">{r.content}</div>
          </div>
        ))}
        {rows.length === 0 && <div className="dshxf-empty">没有结果</div>}
      </div>
      <Pager page={paged.page} pages={paged.pages} total={rows.length} onPage={paged.setPage} />
    </div>
  );
}

// ── Tab 3: Nightly sleep ───────────────────────────────────────────────────
function SleepTab({ scope, user }: { scope: any; user: any }) {
  const hour = Number(user?.sleepTimeHour ?? 3);
  const [msg, setMsg] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [hourDraft, setHourDraft] = React.useState(hour);
  const [log, setLog] = React.useState<any[]>([]);
  const pageSize = useRowsPerPage(86);
  const paged = usePaged(log, pageSize);
  const loadLog = () => {
    // History is a convenience: a failure here must not block the tab.
    callBridge("sleeplog", { limit: 30 })
      .then((rows) => setLog(Array.isArray(rows) ? rows : []))
      .catch(() => { /* ignore */ });
  };
  React.useEffect(() => { loadLog(); }, []);
  const saveHour = async () => {
    try {
      if (!scope || typeof scope.set !== "function") throw new Error("设置命名空间不可用");
      await scope.set("sleepTimeHour", hourDraft);
      setMsg("时间已保存 ✓");
    } catch (e: any) { setMsg("保存失败: " + (e?.message ?? e)); }
  };
  const run = async () => {
    setBusy(true);
    setMsg("正在执行夜间代谢…");
    try {
      const r: any = await callBridge("sleep");
      // Report what the pass actually returns. This used to read `r.summarized`,
      // a field the host never sends, so it always showed the archived count.
      const groups = Number(r?.distilledGroups) || 0;
      const archived = Number(r?.archived) || 0;
      const skipped = r?.distillSkipped ? "（无总结器，已跳过蒸馏）" : "";
      setMsg(`完成：蒸馏 ${groups} 组 · 归档 ${archived} 条${r?.vacuumed ? " · 已 VACUUM" : ""}${skipped}`);
      loadLog();
    } catch (e: any) { setMsg("执行失败: " + (e?.message ?? e)); }
    setBusy(false);
  };
  return (
    <div>
      <h3 className="dshxf-h">夜间睡眠（代谢）</h3>
      <div className="dshxf-actions">
        <label>每日执行时间（时）
          <input type="number" min={0} max={23} className="dshxf-in" value={hourDraft}
            onChange={(e) => setHourDraft(Number(e.target.value))} />
        </label>
        <button className="dshxf-btn" onClick={saveHour}>保存时间</button>
      </div>
      <div className="dshxf-actions">
        <button className="dshxf-btn dshxf-danger dshxf-lg" disabled={busy} onClick={run}>
          {busy ? "代谢中…" : "立即执行夜间代谢"}
        </button>
        <span className="dshxf-msg">{msg}</span>
      </div>
      <p className="dshxf-note">夜间代谢会按实体聚类，把密集的同主题记忆压缩成 100 字核心，并归档原始条目、清理冗余。</p>

      <h4 className="dshxf-sub">执行记录</h4>
      <div className="dshxf-rows">
        {paged.slice.map((e) => {
          const when = new Date(Number(e.at) || 0);
          const stamp = Number.isFinite(when.getTime()) ? when.toLocaleString() : "—";
          const groups = Array.isArray(e.groups) ? e.groups : [];
          return (
            <div key={String(e.at) + stamp} className="dshxf-rrow">
              <div className="dshxf-rrow-top">
                <span className="dshxf-rrow-time">{stamp}</span>
                <span className="dshxf-tag">扫描 {e.scanned ?? 0}</span>
                <span className="dshxf-tag">阈值 {e.threshold ?? "—"}</span>
                <span className="dshxf-tag">蒸馏 {e.distilledGroups ?? 0} 组</span>
                <span className="dshxf-tag">归档 {e.archived ?? 0}</span>
                {e.distillSkipped ? <span className="dshxf-tag dshxf-warn-tag">无总结器</span> : null}
                {e.vacuumed ? <span className="dshxf-tag">VACUUM</span> : null}
              </div>
              <div className="dshxf-rrow-body">
                {groups.length > 0
                  ? "蒸馏：" + groups.map((g: any) => `${g.entity}${g.roleId ? "@" + g.roleId : ""}(${g.count})`).join("、")
                  : "本次未蒸馏任何分组"}
              </div>
            </div>
          );
        })}
        {log.length === 0 && <div className="dshxf-empty">尚无执行记录</div>}
      </div>
      <Pager page={paged.page} pages={paged.pages} total={log.length} onPage={paged.setPage} />
    </div>
  );
}

// ── Tab 4: System ──────────────────────────────────────────────────────────
function SystemTab({ scope, user }: { scope: any; user: any }) {
  const [model, setModel] = React.useState(String(user?.extractionModel ?? "deepseek-chat"));
  const [souls, setSouls] = React.useState<any[]>([]);
  const [msg, setMsg] = React.useState("");
  const pageSize = useRowsPerPage(66);
  const paged = usePaged(souls, pageSize);
  const saveModel = async () => {
    try {
      if (!scope || typeof scope.set !== "function") throw new Error("设置命名空间不可用");
      await scope.set("extractionModel", model);
      setMsg("模型已保存 ✓");
    } catch (e: any) { setMsg("保存失败: " + (e?.message ?? e)); }
  };
  const loadSouls = () => {
    callBridge("souls")
      .then((rows) => setSouls(Array.isArray(rows) ? rows : []))
      .catch((e: any) => setMsg("读取失败: " + (e?.message ?? e)));
  };
  React.useEffect(() => { loadSouls(); }, []);
  return (
    <div>
      <h3 className="dshxf-h">底层系统</h3>
      <div className="dshxf-actions">
        <label>抽取模型
          <input className="dshxf-in" value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <button className="dshxf-btn" onClick={saveModel}>保存</button>
      </div>
      <div className="dshxf-actions">
        <button className="dshxf-btn" onClick={loadSouls}>加载灵魂初始记忆</button>
        <span className="dshxf-msg">{msg}</span>
      </div>
      <div className="dshxf-rows">
        {paged.slice.map((s) => (
          <div key={s.id} className="dshxf-rrow">
            <div className="dshxf-rrow-top">
              <span className="dshxf-tag">{s.id}</span>
              <span className="dshxf-tag">{s.layer}</span>
            </div>
            <div className="dshxf-rrow-body">{s.content}</div>
          </div>
        ))}
        {souls.length === 0 && <div className="dshxf-empty">尚未加载</div>}
      </div>
      <Pager page={paged.page} pages={paged.pages} total={souls.length} onPage={paged.setPage} />
    </div>
  );
}

// The client bundle runs inside the DSH module loader; expose the shared ctx
// so components can reach the host bridge (`ctx.get("remote")`).
//
// NEVER add `export default` here: the Loader's `unwrapExports()` prefers
// `module.exports.default` and would hand Cordis a bare function plugin,
// silently dropping `inject = ["slots"]` — the plugin then activates "fine"
// while every `ctx.slots.*` call throws and NO slot registration ever happens.
declare global { interface Window { __ctx__?: any } }
