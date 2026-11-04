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

export function apply(ctx: any): () => void {
  (window as any).__ctx__ = ctx;
  try { injectCss(); } catch { /* ignore */ }
  let disposeEntry: (() => void) | null = null;
  let disposeInjection: (() => void) | null = null;
  const registerSection = () => {
    try { disposeEntry?.(); } catch { /* ignore */ }
    try {
      disposeEntry = ctx.slots.register(
        {
          name: "settings.section",
          id: NS,
          order: 30,
          label: () => "小肥鱼记忆引擎",
          inject: () => ({ scope: getScope(ctx) }),
        },
        ConsolePage
      );
    } catch (e) {
      // The settings.section slot may not be declared in this profile (the
      // settings-UI plugin can be disabled). Never crash DSH boot; the console
      // mounts automatically once the slot is declared.
      console.warn("[dsh-xiaofei-memory] settings.section unavailable:", e);
    }
  };
  try { disposeInjection = ctx.slots.inject("settings.section", registerSection); }
  catch (e) { console.warn("[dsh-xiaofei-memory] settings slot inject failed", e); }
  // Do NOT call registerSection() directly: an undeclared slot throws and would
  // abort the whole web boot. `inject` fires when/if the slot is declared.
  return () => {
    try { disposeInjection?.(); } catch { /* ignore */ }
    try { disposeEntry?.(); } catch { /* ignore */ }
  };
}

function getScope(ctx: any): any {
  try {
    if (typeof ctx.get === "function") {
      const s = ctx.get("settingsScope");
      if (s) return s;
    }
  } catch { /* ignore */ }
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

// ── shared hook: read config from settings scope ────────────────────────────
function useConfig(scope: any): { user: any; mode: string } {
  if (!scope) return { user: {}, mode: "unknown" };
  const subscribe = React.useCallback((cb: () => void) => scope.subscribe(cb), [scope]);
  const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope]);
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
  const roles: Role[] = Array.isArray(user?.roles) ? user.roles : [];
  const [draft, setDraft] = React.useState<Role[]>(roles.map((r) => ({ ...r })));
  const [msg, setMsg] = React.useState("");
  React.useEffect(() => setDraft(roles.map((r) => ({ ...r }))), [JSON.stringify(roles)]);

  const save = async () => {
    try {
      const ok = await scope.set("roles", draft);
      setMsg(ok === false ? "保存未生效" : "已保存 ✓");
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
function MemoriesTab({ scope, user }: { scope: any; user: any }) {
  const svc = hostService(window.__ctx__, "memoryConsole") as any;
  const roles: Role[] = Array.isArray(user?.roles) ? user.roles : [];
  const [query, setQuery] = React.useState("");
  const [roleId, setRoleId] = React.useState("all");
  const [rows, setRows] = React.useState<MemRow[]>([]);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [msg, setMsg] = React.useState("");

  const refreshStats = () => {
    if (!svc?.getMemoryStats) return;
    try { setStats(svc.getMemoryStats()); } catch (e: any) { setMsg("统计失败: " + (e?.message ?? e)); }
  };
  const doSearch = () => {
    if (!svc?.searchMemory) { setMsg("宿主 memory-console 不可用（数据桥未建立）。"); return; }
    try {
      const res = svc.searchMemory(query, roleId);
      setRows(Array.isArray(res) ? res : []);
      setMsg(`找到 ${Array.isArray(res) ? res.length : 0} 条`);
    } catch (e: any) { setMsg("检索失败: " + (e?.message ?? e)); }
  };
  React.useEffect(() => { refreshStats(); }, []);

  return (
    <div>
      <h3 className="dshxf-h">记忆图谱</h3>
      {stats && (
        <div className="dshxf-stats">
          <span>总记忆 <b>{stats.total}</b></span>
          <span>core <b>{stats.byLayer.core ?? 0}</b></span>
          <span>weekly <b>{stats.byLayer.weekly ?? 0}</b></span>
          <span>recent <b>{stats.byLayer.recent ?? 0}</b></span>
          <span>检索权重 <b>{stats.evolution?.retrievalWeight?.toFixed?.(2) ?? "—"}</b></span>
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
      <ul className="dshxf-list">
        {rows.map((r) => (
          <li key={r.id} className="dshxf-mem">
            <div className="dshxf-mem-meta">
              <span className="dshxf-tag">{r.roleId}</span>
              <span className="dshxf-tag">{r.layer}</span>
              <span className="dshxf-tag dshxf-str">强度 {r.strength.toFixed?.(2) ?? r.strength}</span>
              {typeof r.score === "number" && <span className="dshxf-tag">分 {r.score.toFixed(2)}</span>}
            </div>
            <div className="dshxf-mem-body">{r.content}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Tab 3: Nightly sleep ───────────────────────────────────────────────────
function SleepTab({ scope, user }: { scope: any; user: any }) {
  const svc = hostService(window.__ctx__, "memoryConsole") as any;
  const hour = Number(user?.sleepTimeHour ?? 3);
  const [msg, setMsg] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [hourDraft, setHourDraft] = React.useState(hour);
  const saveHour = async () => {
    try {
      await scope.set("sleepTimeHour", hourDraft);
      setMsg("时间已保存 ✓");
    } catch (e: any) { setMsg("保存失败: " + (e?.message ?? e)); }
  };
  const run = async () => {
    if (!svc?.triggerNightlySleep) { setMsg("宿主 memory-console 不可用（数据桥未建立）。"); return; }
    setBusy(true);
    setMsg("正在执行夜间代谢…");
    try {
      const r = await svc.triggerNightlySleep();
      setMsg(`完成：${typeof r === "object" && r ? (r.summarized ?? r.archived ?? 0) : r} 条处理`);
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
    </div>
  );
}

// ── Tab 4: System ──────────────────────────────────────────────────────────
function SystemTab({ scope, user }: { scope: any; user: any }) {
  const svc = hostService(window.__ctx__, "memoryConsole") as any;
  const [model, setModel] = React.useState(String(user?.extractionModel ?? "deepseek-chat"));
  const [souls, setSouls] = React.useState<any[]>([]);
  const [msg, setMsg] = React.useState("");
  const saveModel = async () => {
    try { await scope.set("extractionModel", model); setMsg("模型已保存 ✓"); }
    catch (e: any) { setMsg("保存失败: " + (e?.message ?? e)); }
  };
  const loadSouls = () => {
    if (!svc?.listSoulMemories) { setMsg("宿主 memory-console 不可用（数据桥未建立）。"); return; }
    try { setSouls(svc.listSoulMemories()); } catch (e: any) { setMsg("读取失败: " + (e?.message ?? e)); }
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
      <ul className="dshxf-list">
        {souls.map((s) => (
          <li key={s.id} className="dshxf-mem">
            <div className="dshxf-mem-meta"><span className="dshxf-tag">{s.id}</span><span className="dshxf-tag">{s.layer}</span></div>
            <div className="dshxf-mem-body">{s.content}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The client bundle runs inside the DSH module loader; expose the shared ctx
// so components can reach the host bridge (`ctx.get("remote")`).
declare global { interface Window { __ctx__?: any } }
export default apply;
