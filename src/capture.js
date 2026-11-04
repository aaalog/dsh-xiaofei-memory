// lib/capture.js — Async capture engine for dsh-xiaofei-memory.
// PRD section 4.1: on turn/end, asynchronously extract facts and fuse them
// into the store (dedup -> strength bump, conflict -> archive + cover).

import { addMemory } from "./db.js";
import { extractEntities, normalizeContent, tokenEstimate, clamp } from "./util.js";

const IMPORTANCE_CORE_RE =
  /(记住|永远|务必|重要|核心|关键|红线|必须|一定|教训|原则|准则|决定)/;
const IMPORTANCE_WEEKLY_RE = /(计划|项目|目标|方案|架构|设计|开发|部署|长期|后续|接下来|打算)/;

/**
 * Per-session capture tracker: accumulates the active turn's user and
 * assistant text, and extracts+stores on turn/end. Async via queueMicrotask.
 */
export class CaptureTracker {
  constructor({ store, roleOf, logger, extractor }) {
    this.store = store;
    this.roleOf = roleOf || (() => "global");
    this.logger = logger;
    this.extractor = extractor; // optional async (text) => {content,entities,layer} | null
    this.turn = new Map(); // sessionId -> { user: string[], assistant: string[], seq: number }
  }

  /** Feed a session event into the tracker. Returns true if it flushed. */
  onEvent(sessionId, event) {
    if (!event || typeof event !== "object") return false;
    const t = event.type;
    if (t === "turn/start") {
      this.turn.set(sessionId, { user: [], assistant: [], seq: event.seq ?? 0 });
      return false;
    }
    if (t === "user/message" || t === "assistant/message") {
      const state = this.turn.get(sessionId);
      if (!state) return false;
      const data = event.data;
      const text = (data?.content ?? [])
        .filter((b) => b?.type === "text" && typeof b?.text === "string")
        .map((b) => b.text)
        .join("\n");
      if (!text.trim()) return false;
      const source = data?.source;
      // Skip our own injected <memory-recall> / notice messages.
      if (source?.kind && String(source.kind).startsWith("memory")) return false;
      if (t === "user/message") state.user.push(text);
      else state.assistant.push(text);
      return false;
    }
    if (t === "turn/end") {
      const state = this.turn.get(sessionId);
      if (!state) return false;
      this.turn.delete(sessionId);
      const userText = state.user.join("\n").trim();
      const assistantText = state.assistant.join("\n").trim();
      if (!userText) return false;
      // Async capture must never block the main response.
      queueMicrotask(() => {
        void this._capture(sessionId, userText, assistantText).catch((e) => {
          try {
            this.logger?.warn?.(`dsh-xiaofei-memory: capture failed (${e?.message ?? e})`);
          } catch { /* ignore */ }
        });
      });
      return true;
    }
    return false;
  }

  async _capture(sessionId, userText, assistantText) {
    const roleId = this.roleOf(sessionId);
    // Prefer the user query; fall back to the assistant answer for context.
    const primary = userText.length >= 8 ? userText : (assistantText || userText);
    const source = normalizeContent(primary);
    if (!source || source.length < 8) return;

    let extracted = null;
    if (typeof this.extractor === "function") {
      try {
        extracted = await this.extractor(source, { userText, assistantText, sessionId });
      } catch { /* fall back to heuristic */ }
    }

    const entities = (extracted?.entities?.length ? extracted.entities : extractEntities(source)).slice(0, 16);
    const layer = extracted?.layer ?? inferLayer(source);
    const content = normalizeContent(extracted?.content ?? source);

    const res = this.store({ roleId, layer, content, entities });
    if (res?.merged) {
      this.logger?.info?.(
        `dsh-xiaofei-memory: captured (merged, layer=${layer}, id=${String(res.id).slice(-6)})`
      );
    } else if (res?.id) {
      this.logger?.info?.(
        `dsh-xiaofei-memory: captured (new, layer=${layer}, id=${String(res.id).slice(-6)})`
      );
    }
  }
}

/** Heuristic importance -> layer. Core is the highest-value layer. */
function inferLayer(text) {
  const t = text ?? "";
  const tokens = tokenEstimate(t);
  if (IMPORTANCE_CORE_RE.test(t)) return "core";
  if (IMPORTANCE_WEEKLY_RE.test(t) || tokens >= 60) return "weekly";
  return "recent";
}

/**
 * Optional LLM-backed extractor seam (PRD 4.1). Wired when an extractionModel
 * is configured and an llm service is available. Returns the same shape as the
 * heuristic path: { content, entities, layer }.
 *
 * This is intentionally a thin, fail-open wrapper: any error falls back to the
 * deterministic heuristic extractor so the write track never blocks.
 */
export function makeLlmExtractor(callLlm, { model }) {
  if (typeof callLlm !== "function") return null;
  return async (text) => {
    const prompt = `你是长期记忆抽取引擎。从下面这段对话文本中提取一条值得跨会话记住的记忆。
严格输出 JSON（不要 Markdown，不要注释）：{"content": "一句话事实(<=60字)", "entities": ["核心实体", ...(<=8个)], "layer": "core|weekly|recent"}
layer 规则：永久原则/红线/重大决定=core；项目/计划/长期=weekly；其他=recent。
对话文本：
${text.slice(0, 2000)}`;
    const reply = await callLlm(prompt, { model });
    if (!reply) return null;
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!parsed || typeof parsed.content !== "string" || !parsed.content.trim()) return null;
    return {
      content: parsed.content.trim(),
      entities: Array.isArray(parsed.entities) ? parsed.entities.map(String).slice(0, 8) : [],
      layer: ["core", "weekly", "recent"].includes(parsed.layer) ? parsed.layer : "recent",
    };
  };
}
