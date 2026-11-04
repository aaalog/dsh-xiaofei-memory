// lib/index.js — dsh-xiaofei-memory plugin entry.
// A headless, async, self-evolving long-term memory engine for DeepSeek Harness.
// DSH plugin contract: export { name, inject, Config, apply }.

import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";

import { openMemoryDb, closeMemoryDb, countMemories, addMemory, metaGet, metaSet, touchAccessed } from "./db.js";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { retrieveForPrompt } from "./retrieval.js";
import { CaptureTracker, makeLlmExtractor } from "./capture.js";
import { FeedbackManager } from "./feedback.js";
import { runNightlySleep } from "./sleep.js";
import { loadEvolution, runEvolution } from "./evolution.js";
import { getMemoryStats, searchMemory, previewRecall, triggerNightlySleep, listSoulMemories } from "./console.js";

export const name = "dsh-xiaofei-memory";

// We require the tools service (for the retrieve/addFact tools) and access the
// session/agent and llm via event payloads and optional ctx.get, so the plugin
// stays loadable even when those optional services are absent.
export const inject = ["tools"];

export const Config = z.object({
  /** Master switch: false disables injection, capture, sleep, and tools. */
  enabled: z.boolean().default(true),
  /** Override the SQLite path. Default: $DSH_HOME/plugin-data/dsh-xiaofei-memory/memory.sqlite. */
  dbPath: z.string().required(false),
  /** Independent extraction model name (PRD 4.1); requires useLlmExtraction. Volatile = editable in the console. */
  extractionModel: z.string().default("deepseek-chat").volatile(),
  /** Whether to use the LLM-backed extractor (default heuristic keeps it dependency-free). */
  useLlmExtraction: z.boolean().default(false),
  /** Damp factor applied on correction (PRD 4.3). */
  dampFactor: z.number().default(0.85),
  /** Time decay factor (PRD 4.2). */
  timeDecayFactor: z.number().default(0.01),
  /** 1-hop graph diffusion on/off (PRD 4.2). */
  enableGraphRecall: z.boolean().default(true),
  /** Nightly sleep hour, 0-23 (PRD 4.3). Volatile = editable in the console. */
  sleepTimeHour: z.number().default(3).volatile(),
  /** Max tokens for a single recall injection (PRD 4.2). */
  maxRecallTokens: z.number().default(1200),
  /** Default role namespace when the session carries none. */
  roleId: z.string().default("global"),
  /** Tools whose execution counts as a correction signal (default none = opt-in). */
  correctionTools: z.array(z.string()).default([]),
  /** Max primary recalls per injection. */
  recallLimit: z.number().default(8),
  /** Role registry for the management console. Volatile = editable in the console. */
  roles: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    description: z.string().default(""),
    enabled: z.boolean().default(true),
  })).default([
    { id: "global", name: "全局", description: "跨角色共享的核心记忆", enabled: true },
    { id: "companion", name: "小肥鱼", description: "陪伴与情绪价值", enabled: true },
    { id: "work-assistant", name: "开发A", description: "任务流转与多角色协作", enabled: true },
  ]).volatile(),
});

const LAST_SLEEP_KEY = "meta.lastSleepAt";
const RECALL_STATS_KEY = "meta.recallStats";

function defaultDbPath() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "plugin-data", "dsh-xiaofei-memory", "memory.sqlite");
}

export async function apply(ctx, config) {
  // Unwrap schemastery `.volatile()` accessors (settings-editable fields) into
  // plain values so the rest of the engine can read them normally.
  for (const k of ["roles", "sleepTimeHour", "extractionModel"]) {
    const v = config[k];
    if (v && typeof v === "object" && typeof v.get === "function") {
      try { config[k] = v.get(); } catch { /* keep the accessor if frozen */ }
    }
  }
  if (!config.enabled) {
    ctx.logger?.info?.("dsh-xiaofei-memory: disabled by config");
    return;
  }

  const dbPath = config.dbPath || defaultDbPath();
  const db = openMemoryDb(dbPath);
  const logger = ctx.logger;
  logger?.info?.(`dsh-xiaofei-memory: opened ${dbPath} (${countMemories(db)} active memories)`);

  // --- Feedback manager -------------------------------------------------
  const feedback = new FeedbackManager({ db, dampFactor: config.dampFactor, logger });

  // --- Capture tracker ---------------------------------------------------
  const tracker = new CaptureTracker({
    store: (args) => addMemory(db, args),
    roleOf: () => config.roleId,
    logger,
    extractor: config.useLlmExtraction
      ? makeLlmExtractor(buildLlmCaller(ctx), { model: config.extractionModel })
      : null,
  });

  // --- Per-session recall state (for correction tracking) ----------------
  const lastInjected = new Map(); // sessionId -> memoryId[]

  // --- Pre-step retrieval injection (PRD 4.2) ---------------------------
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    try {
      if (signal?.aborted || !decision || decision.kind !== "enter") return decision;
      if (!decision.messages || decision.messages.length === 0) return decision;
      if (agent?.session?.header?.origin === "subagent") return decision;

      const userMsgs = decision.messages.filter((m) => m?.source?.kind === "user");
      if (userMsgs.length === 0) return decision;

      const query = userMsgs[userMsgs.length - 1]
        ?.content?.filter((b) => b?.type === "text")
        ?.map((b) => b?.text ?? "")
        ?.join(" ") ?? "";
      if (!query.trim()) return decision;

      const roleId = agent?.session?.header?.roleId ?? config.roleId;
      const evolution = loadEvolution(db);
      const recall = retrieveForPrompt(db, {
        query,
        roleIds: [roleId, "global"],
        decay: evolution.timeDecay,
        enableGraphRecall: config.enableGraphRecall,
        maxTokens: config.maxRecallTokens,
        limit: config.recallLimit,
      });
      if (!recall) return decision;

      const sid = agent?.session?.id ?? "anon";
      lastInjected.set(sid, recall.injectedIds);
      for (const id of recall.injectedIds) touchAccessed(db, id);

      const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
      const memoryMessage = createUserMessage({
        content: [{ type: "text", text: recall.text }],
        source: { kind: "dsh-xiaofei-memory", form: "memory-recall", ids: recall.injectedIds },
      });
      const lastUser = userMsgs[userMsgs.length - 1];
      const rewritten = [...decision.messages];
      rewritten.splice(rewritten.indexOf(lastUser), 0, memoryMessage);
      return { ...decision, messages: rewritten };
    } catch (e) {
      try { logger?.warn?.(`dsh-xiaofei-memory: pre-step inject failed (fail-open): ${e?.message ?? e}`); } catch { /* ignore */ }
      return decision;
    }
  });

  // --- Session event capture (PRD 4.1) + correction (PRD 4.3) ------------
  ctx.on("session/event", (session, event) => {
    if (session?.header?.origin === "subagent") return;
    const sid = session?.id ?? "anon";
    const flushed = tracker.onEvent(sid, event);
    if (!flushed) return;
    // turn/end just flushed an async capture; nothing to do synchronously.
    void flushed;
  });

  // Correction damping via tools/result when a correction tool runs.
  if (config.correctionTools.length > 0) {
    const correctionSet = new Set(config.correctionTools);
    ctx.on("tools/result", (exec, result) => {
      try {
        if (result?.isError) return;
        const toolName = exec?.tool?.name ?? exec?.name;
        if (!toolName || !correctionSet.has(toolName)) return;
        const sid = exec?.session?.id ?? exec?.agent?.session?.id;
        const ids = lastInjected.get(sid);
        if (!ids || ids.length === 0) return;
        for (const id of ids) feedback.damp(id);
        logger?.info?.(`dsh-xiaofei-memory: correction via ${toolName}, damped ${ids.length} recalled memories`);
      } catch { /* ignore */ }
    });
  }

  // --- Nightly sleep (PRD 4.3 + 4.4) ------------------------------------
  let sleepTimer = null;
  const scheduleSleep = () => {
    if (sleepTimer) clearTimeout(sleepTimer);
    const now = Date.now();
    const hour = config.sleepTimeHour;
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    sleepTimer = setTimeout(() => {
      void doSleep().finally(scheduleSleep);
    }, next.getTime() - now);
    if (typeof sleepTimer?.unref === "function") sleepTimer.unref();
  };

  const doSleep = async () => {
    try {
      const summarize = config.useLlmExtraction
        ? buildSleepSummarizer(buildLlmCaller(ctx), config.extractionModel)
        : null;
      const stats = await runNightlySleep(db, { summarize });
      const recallStats = JSON.parse(metaGet(db, RECALL_STATS_KEY) ?? '{"count":0,"corrections":0}');
      const evolved = runEvolution(db, {
        recallCount: recallStats.count,
        recallCorrections: recallStats.corrections,
      });
      metaSet(db, LAST_SLEEP_KEY, Date.now());
      metaSet(db, RECALL_STATS_KEY, '{"count":0,"corrections":0}');
      logger?.info?.(`dsh-xiaofei-memory: nightly sleep done (${JSON.stringify(stats)}), evolution changed=${evolved.changed}`);
    } catch (e) {
      try { logger?.warn?.(`dsh-xiaofei-memory: nightly sleep failed: ${e?.message ?? e}`); } catch { /* ignore */ }
    }
  };

  // Compensation: run sleep on startup if it's been >24h since the last pass.
  const lastSleep = Number(metaGet(db, LAST_SLEEP_KEY) ?? 0);
  if (lastSleep === 0 || Date.now() - lastSleep > 24 * 3600 * 1000) {
    queueMicrotask(() => void doSleep());
  }
  scheduleSleep();

  // --- Settings panel registration (management console bridge) ----------
  // The client reads/writes the plugin Config through this section and calls
  // the data operations below through the memory-core service.
  const configWriter = (key, value) => { config[key] = value; };
  let liveRoles = Array.isArray(config.roles) ? config.roles.map((r) => ({ ...r })) : [];
  registerSettingsSection(ctx, { Config, config, liveRoles, setLiveRoles: (r) => { liveRoles = r; }, configWriter, logger });

  // --- Expose memory-core API (PRD 5.2) ---------------------------------
  const core = {
    retrieve(query, opts = {}) {
      return retrieveForPrompt(db, {
        query,
        roleIds: opts.roleIds ?? [config.roleId, "global"],
        decay: loadEvolution(db).timeDecay,
        enableGraphRecall: config.enableGraphRecall,
        maxTokens: opts.maxTokens ?? config.maxRecallTokens,
        limit: opts.limit ?? config.recallLimit,
      });
    },
    addFact({ content, roleId, layer = "recent", entities = [] }) {
      return addMemory(db, { roleId: roleId ?? config.roleId, layer, content, entities });
    },
    damp(id) {
      return feedback.damp(id);
    },
    stats() {
      return { active: countMemories(db), evolution: loadEvolution(db) };
    },
    // --- Management console API ---
    getAllRoles() {
      return liveRoles.map((r) => ({ ...r }));
    },
    updateRoles(roles) {
      const next = Array.isArray(roles)
        ? roles.map((r) => ({ id: String(r.id ?? ""), name: String(r.name ?? ""), description: String(r.description ?? ""), enabled: r.enabled !== false })).filter((r) => r.id && r.name)
        : [];
      liveRoles = next;
      configWriter("roles", next.map((r) => ({ ...r })));
      logger?.info?.(`dsh-xiaofei-memory: roles updated (${next.length})`);
      return next.map((r) => ({ ...r }));
    },
    getMemoryStats() {
      return getMemoryStats(db);
    },
    searchMemory(query, roleId) {
      return searchMemory(db, { query, roleId, decay: loadEvolution(db).timeDecay });
    },
    previewRecall(query, roleId) {
      return previewRecall(db, { query, roleId, maxTokens: config.maxRecallTokens });
    },
    triggerNightlySleep() {
      const summarize = config.useLlmExtraction ? buildSleepSummarizer(buildLlmCaller(ctx), config.extractionModel) : null;
      return triggerNightlySleep(db, { summarize });
    },
    listSoulMemories() {
      return listSoulMemories(db);
    },
    db,
  };
  ctx.provide("memory-core", core);

  // --- Management console service (bridged to the Web console) ----------
  ctx.provide("memoryConsole", {
    getAllRoles: () => liveRoles.map((r) => ({ ...r })),
    updateRoles: (roles) => core.updateRoles(roles),
    getMemoryStats: () => getMemoryStats(db),
    searchMemory: (query, roleId) => searchMemory(db, { query, roleId, decay: loadEvolution(db).timeDecay }),
    previewRecall: (query, roleId) => previewRecall(db, { query, roleId, maxTokens: config.maxRecallTokens }),
    triggerNightlySleep: () => core.triggerNightlySleep(),
    listSoulMemories: () => listSoulMemories(db),
    // Diagnostic probe: the Web client calls this to prove it is running and
    // which mount path it took. Writes a line to a temp log.
    probe(msg) {
      try { appendFileSync(join(tmpdir(), "dshxf-probe.log"), `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
      return true;
    },
  });

  // --- Tools: expose retrieve + addFact ---------------------------------
  const disposeRetrieve = ctx.tools.register({
    name: "memory_core_retrieve",
    description: "从长期记忆中检索与当前问题相关的记忆，返回可注入的 <memory-recall> 文本。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "检索查询（当前用户问题或关键词）。" },
        limit: { type: "integer", default: 8, description: "主检索条数上限。" },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
      render: (_args, v) => [{ type: "text", text: v?.ok ? "已检索。详见上方注入的记忆。" : "检索失败。" }],
    },
    async execute(args) {
      const recall = retrieveForPrompt(db, {
        query: args?.query,
        roleIds: [config.roleId, "global"],
        decay: loadEvolution(db).timeDecay,
        enableGraphRecall: config.enableGraphRecall,
        maxTokens: config.maxRecallTokens,
        limit: args?.limit ?? config.recallLimit,
      });
      return { ok: recall !== null, recalled: recall?.recalled ?? 0, text: recall?.text ?? "" };
    },
  });
  const disposeAddFact = ctx.tools.register({
    name: "memory_core_add_fact",
    description: "向长期记忆写入一条事实（供外部调用，等同 memory_remember）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: { type: "string", description: "记忆正文。" },
        roleId: { type: "string", description: "角色命名空间，默认 global。" },
        layer: { type: "string", enum: ["core", "weekly", "recent"], default: "recent" },
        entities: { type: "array", items: { type: "string" }, description: "实体列表。" },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" }, id: { type: "string" } } },
      render: (_args, v) => [{ type: "text", text: v?.ok ? `已写入（${v?.id?.slice(-6) ?? ""}）。` : "写入失败。" }],
    },
    async execute(args) {
      const res = addMemory(db, {
        roleId: args?.roleId ?? config.roleId,
        layer: args?.layer ?? "recent",
        content: args?.content,
        entities: Array.isArray(args?.entities) ? args.entities : [],
      });
      return { ok: true, id: res?.id, merged: res?.merged ?? false };
    },
  });

  // --- Cleanup -----------------------------------------------------------
  ctx.effect(() => () => {
    if (sleepTimer) clearTimeout(sleepTimer);
    feedback.dispose();
    if (typeof disposeRetrieve === "function") disposeRetrieve();
    if (typeof disposeAddFact === "function") disposeAddFact();
    closeMemoryDb(db);
  });
}

/** Build a minimal LLM caller from ctx.llm if present; else null. */
function buildLlmCaller(ctx) {
  const llm = ctx.get?.("llm");
  if (!llm) return null;
  return async (prompt, { model } = {}) => {
    // Prefer a simple complete() if present; otherwise try stream() assembly.
    if (typeof llm.complete === "function") {
      return llm.complete(prompt, { model });
    }
    return null;
  };
}

/** Build a sleep summarizer that calls the LLM once per distillation group. */
function buildSleepSummarizer(callLlm, model) {
  if (typeof callLlm !== "function") return null;
  return async (texts) => {
    const prompt = `把下面这几条相关记忆压缩成一句不超过100字的要点（保留核心实体与因果，不要列举）：
${texts.join("\n")}`;
    return callLlm(prompt, { model });
  };
}

/**
 * Register a settings section so the Web console can read/write the plugin
 * Config through ctx.settings. Falls back to a no-op when the settings
 * service is unavailable, so the host still loads.
 */
function registerSettingsSection(ctx, { Config, config, liveRoles, setLiveRoles, configWriter, logger }) {
  let settings;
  try {
    settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
  } catch {
    settings = undefined;
  }
  if (!settings) {
    logger?.warn?.("dsh-xiaofei-memory: settings service unavailable; console config write disabled");
    return;
  }
  const ns = "dsh-xiaofei-memory";
  const entry = { ...config, roles: liveRoles };
  const hooks = {
    onChange: () => {},
    setSource: (getter) => {
      // Reflect settings writes back into the live config snapshot.
      const read = () => {
        try { return getter(); } catch { return undefined; }
      };
      const applyValue = (v) => {
        if (!v || typeof v !== "object") return;
        for (const [k, val] of Object.entries(v)) {
          if (k === "roles" && Array.isArray(val)) {
            setLiveRoles(val.map((r) => ({ ...r })));
          } else if (k in config) {
            config[k] = val;
          }
        }
      };
      configWriter._readSource = read;
      applyValue(read());
    },
  };
  try {
    if (typeof settings.installSection === "function") {
      settings.installSection(ctx, ns, Config, entry, hooks);
      logger?.info?.("dsh-xiaofei-memory: settings section registered (installSection)");
      return;
    }
    if (typeof settings.register === "function") {
      settings.register(ns, Config, { base: entry, validate: hooks });
      logger?.info?.("dsh-xiaofei-memory: settings section registered (register)");
      return;
    }
    logger?.warn?.("dsh-xiaofei-memory: settings service lacks installSection/register");
  } catch (e) {
    logger?.warn?.(`dsh-xiaofei-memory: settings section registration failed: ${e?.message ?? e}`);
  }
}
