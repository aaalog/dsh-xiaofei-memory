// lib/core-memory.js — Always-on core memory ("memory blocks").
//
// Registers a stable system-prompt section carrying a small, stable slice of
// high-value memories, so identity/permanent rules stay in context without
// depending on per-turn retrieval. This is the portable half of Letta's
// memory-blocks design: the data layer is ours, the prompt slot is the host's.
//
// Two hard constraints drive the whole file:
//
// 1. STABILITY. The host reuses a KV-cache prefix up to the first changed
//    token. A section whose text changes every step invalidates the cache on
//    every request and can cost more than the tokens it adds. So selection is
//    fully deterministic and the rendered string is cached until the selected
//    rows actually change.
//
// 2. NO CONTAMINATION. Memories whose text contains our own injected
//    <memory-recall> wrapper (a capture bug seen in the wild) must never be
//    promoted to always-on, or the poison becomes permanent.

import { tokenEstimate } from "./util.js";

/** Marker used by our own pre-step injection; such rows must never go core. */
const INJECTED_MARKER = "<memory-recall>";

const DEFAULT_HEADER = "## 常驻记忆\n以下是无需检索、始终在场的长期记忆。它们是背景事实，不要逐条复述。";

/** Keep the header's own cost out of the memory budget. */
const BUDGET_SAFETY_TOKENS = 8;

/**
 * Deterministically select the always-on slice.
 *
 * Order is `strength DESC, created_at DESC, id ASC`: the id tiebreak makes the
 * result total, so identical database state always yields an identical list.
 *
 * @returns {Array<{id:string, content:string, strength:number}>}
 */
export function selectCoreMemories(db, {
  roleIds = ["global"],
  maxTokens = 700,
  maxItemChars = 400,
  minStrength = 1.0,
  limit = 12,
} = {}) {
  if (!db) return [];
  const roles = Array.isArray(roleIds) && roleIds.length > 0 ? roleIds : ["global"];
  const placeholders = roles.map(() => "?").join(",");
  let rows;
  try {
    rows = db.prepare(
      `SELECT id, content, strength, created_at FROM memories
       WHERE status = 'active' AND layer = 'core'
         AND role_id IN (${placeholders})
         AND strength >= ?
       ORDER BY strength DESC, created_at DESC, id ASC
       LIMIT ?`
    ).all(...roles, Number(minStrength) || 0, Math.max(1, Number(limit) || 12));
  } catch {
    return [];
  }

  const budget = Math.max(0, (Number(maxTokens) || 0) - BUDGET_SAFETY_TOKENS);
  const chosen = [];
  let used = 0;
  for (const row of rows) {
    const raw = typeof row.content === "string" ? row.content.trim() : "";
    if (!raw) continue;
    // Never promote our own injected recall wrapper.
    if (raw.includes(INJECTED_MARKER)) continue;
    const cap = Math.max(1, Number(maxItemChars) || 400);
    const content = raw.length > cap ? `${raw.slice(0, cap)}…` : raw;
    const cost = tokenEstimate(content);
    if (cost <= 0) continue;
    if (used + cost > budget) continue; // keep scanning: a later short row may still fit
    chosen.push({ id: row.id, content, strength: Number(row.strength) || 0 });
    used += cost;
    if (chosen.length >= Math.max(1, Number(limit) || 12)) break;
  }
  return chosen;
}

/** Render the selected rows to the exact text placed in the prompt. */
export function renderCoreMemory(entries, { header = DEFAULT_HEADER } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  const lines = entries.map((e) => `- ${e.content}`);
  return `${header}\n${lines.join("\n")}`;
}

/** Content signature: changes only when the selected slice really changes. */
export function coreMemorySignature(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return entries.map((e) => `${e.id}:${e.content.length}`).join("|");
}

/**
 * A render cache that preserves string identity while the slice is unchanged.
 *
 * Returning the *same string instance* is not required by the host, but it
 * makes the "did anything actually change?" question cheap for callers and
 * keeps us honest about not re-rendering on every step.
 */
export class CoreMemoryCache {
  constructor() {
    this.signature = null;
    this.text = "";
  }

  /**
   * @param {Array} entries - current selection
   * @param {object} [options] - forwarded to renderCoreMemory
   * @returns {string} stable text for this slice
   */
  update(entries, options) {
    const signature = coreMemorySignature(entries);
    if (signature === this.signature) return this.text;
    // The previous text is rendered before the fields are replaced so that a
    // throw from a custom header cannot leave the cache half-updated.
    const next = renderCoreMemory(entries, options);
    this.signature = signature;
    this.text = next;
    return next;
  }

  /** Drop the cached text (used on dispose). */
  reset() {
    this.signature = null;
    this.text = "";
  }
}

export const CORE_MEMORY_SECTION_NAME = "memory:core";

/**
 * Section order.
 *
 * The host allocates repository-owned positions through
 * getSectionOrder(name), but an external contribution may use any finite order
 * (host docs: "External contributions may use any finite order"). We use a
 * literal because our name is not in SECTION_ORDERS: getSectionOrder() returns
 * undefined for unknown names and section() rejects a non-finite order.
 *
 * PLACEMENT IS A CACHE DECISION. KV reuse is a *prefix* cache: everything after
 * the first changed token is invalidated. This section can change (a new core
 * memory is promoted, one is archived), so putting it early would invalidate
 * the plan policy, team policy and every tool-guidance section that follows —
 * ~10k tokens of churn for a 700-token feature. Placing it at the tail of the
 * assembled prompt limits the blast radius to the deployment persona suffix
 * (10200) alone.
 *
 * 10150 = after WEB_SURFACE (10100), before DEPLOYMENT_PERSONA_SUFFIX (10200).
 */
export const CORE_MEMORY_SECTION_ORDER = 10150;

/**
 * Install the always-on section for one agent.
 *
 * Per-agent, not global: `agent.ctx.inject` opens a fiber scoped to that agent,
 * so role namespaces stay isolated and the section disappears with the agent.
 * This mirrors the host's own `context:file-reference` contributor, which is
 * the canonical pattern for agent-aware prompt sections.
 *
 * @returns {Promise<{dispose: () => Promise<void>}> | null}
 */
export async function installCoreMemoryForAgent(agent, { db, config, resolveRoleIds, logger }) {
  if (!agent || !agent.ctx || typeof agent.ctx.inject !== "function") return null;

  let cache = new CoreMemoryCache();
  let disposed = false;

  const text = () => {
    if (disposed) return "";
    try {
      const roleIds = typeof resolveRoleIds === "function" ? resolveRoleIds(agent) : ["global"];
      const entries = selectCoreMemories(db, {
        roleIds,
        maxTokens: config.coreMemoryMaxTokens,
        maxItemChars: config.coreMemoryMaxItemChars,
        minStrength: config.coreMemoryMinStrength,
      });
      return cache.update(entries);
    } catch (e) {
      // A prompt section must never throw: a throw breaks prompt assembly for
      // every request on this agent. Degrade to an empty section instead.
      logger?.warn?.(`runtime-xiaofei-memory: core memory render failed: ${e?.message ?? e}`);
      return "";
    }
  };

  let fiber;
  try {
    fiber = agent.ctx.inject(["systemPrompt"], (scope) => {
      scope.systemPrompt.section({
        name: CORE_MEMORY_SECTION_NAME,
        order: CORE_MEMORY_SECTION_ORDER,
        // Render text verbatim: memory content may legitimately contain {{...}}.
        interpolate: false,
        text,
      });
    });
  } catch (e) {
    logger?.warn?.(`runtime-xiaofei-memory: core memory install failed: ${e?.message ?? e}`);
    return null;
  }

  return {
    async dispose() {
      disposed = true;
      cache.reset();
      try { await fiber?.dispose?.(); } catch { /* already disposed */ }
    },
  };
}

/**
 * Wire per-agent installation to the agent lifecycle.
 *
 * @returns {() => Promise<void>} disposer that tears down every installed fiber
 */
export function registerCoreMemory({ ctx, db, config, resolveRoleIds, logger }) {
  const noop = async () => {};
  const fibers = new Map(); // agent -> handle
  const pending = new Set();  // in-flight disposals
  const gone = new Set();     // agents disposed while their install was in flight
  const installing = new Set(); // agents whose install is in flight (race guard)

  const install = async (agent) => {
    if (!agent) return;
    // `install` is async, so two lifecycle events can interleave here. Claim
    // the agent synchronously before the first await, or both callers would
    // pass the check and we would register two sections with the same name.
    if (fibers.has(agent) || installing.has(agent)) return;
    installing.add(agent);
    try {
      const handle = await installCoreMemoryForAgent(agent, { db, config, resolveRoleIds, logger });
      if (!handle) return;
      // A dispose that raced the install would have found nothing in the map,
      // so check once more: if the agent is already gone, tear this fiber down
      // now instead of leaking it for the lifetime of the process.
      if (gone.has(agent)) {
        gone.delete(agent);
        await handle.dispose();
        return;
      }
      fibers.set(agent, handle);
    } finally {
      installing.delete(agent);
    }
  };

  const disposeAgent = (agent) => {
    const handle = fibers.get(agent);
    if (handle === undefined) {
      // The install is still in flight; remember so it self-disposes.
      if (installing.has(agent)) gone.add(agent);
      return;
    }
    fibers.delete(agent);
    const task = handle.dispose().catch((e) => {
      logger?.warn?.(`runtime-xiaofei-memory: core memory cleanup failed: ${e?.message ?? e}`);
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  };

  try {
    // Adopt agents that already exist when this plugin loads.
    const agents = typeof ctx.get === "function" ? ctx.get("agents") : undefined;
    if (agents && typeof agents.list === "function") {
      for (const agent of agents.list()) {
        void install(agent).catch((e) => {
          logger?.warn?.(`runtime-xiaofei-memory: core memory adopt skipped: ${e?.message ?? e}`);
        });
      }
    }
    // `agent/created` is serial: a rejection here fails agent creation and
    // skips later listeners. Core memory is an enhancement, never a reason to
    // stop an agent from starting, so every failure is contained.
    ctx.on("agent/created", async ({ agent }) => {
      try { await install(agent); } catch (e) {
        logger?.warn?.(`runtime-xiaofei-memory: core memory install skipped: ${e?.message ?? e}`);
      }
    });
    ctx.on("agent/disposed", ({ agent }) => {
      try { disposeAgent(agent); } catch (e) {
        logger?.warn?.(`runtime-xiaofei-memory: core memory dispose skipped: ${e?.message ?? e}`);
      }
    });
  } catch (e) {
    logger?.warn?.(`runtime-xiaofei-memory: core memory lifecycle wiring failed: ${e?.message ?? e}`);
    return noop;
  }

  return async () => {
    const handles = [...fibers.values()];
    fibers.clear();
    await Promise.all([
      ...handles.map((h) => h.dispose().catch(() => {})),
      ...pending,
    ]);
  };
}
