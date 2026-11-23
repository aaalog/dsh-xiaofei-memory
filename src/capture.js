// lib/capture.js — Async capture engine for dsh-xiaofei-memory.
// PRD section 4.1: on turn/end, asynchronously extract facts and fuse them
// into the store (dedup -> strength bump, conflict -> archive + cover).

import { extractEntities, normalizeContent, tokenEstimate, clamp } from "./util.js";

const IMPORTANCE_CORE_RE =
  /(记住|永远|务必|重要|核心|关键|红线|必须|一定|教训|原则|准则|决定)/;
const IMPORTANCE_WEEKLY_RE = /(计划|项目|目标|方案|架构|设计|开发|部署|长期|后续|接下来|打算)/;

/**
 * Per-session capture tracker: accumulates the active turn's user and
 * assistant text, and extracts+stores on turn/end. Async via queueMicrotask.
 */
/** Prefixes that mark runtime-generated instructions rather than user speech. */
const NON_CAPTURABLE_PREFIXES = [
  "[SCHEDULE REMINDER]",
  "[meow-memory-reflect]",
  "[memory-recall]",
  "<memory-recall>",
  // Background-job and subagent completion notices reach the session as
  // ordinary user messages, so nothing in the source tag marks them. The live
  // store had a 401-character "background job … finished [status: completed,
  // exit code: 0]" row captured verbatim — runtime chatter, not something the
  // user said, and worthless as a memory.
  "background job ",
  "Background job ",
  "Background subagent ",
];

/** Sources this plugin injects; their kind never starts with "memory". */
const OWN_SOURCE_KINDS = new Set(["dsh-xiaofei-memory"]);

/**
 * Whether a message must not be captured as a memory.
 *
 * Two distinct leaks showed up in practice:
 * 1. Our own pre-step injection is tagged `kind: "dsh-xiaofei-memory"`,
 *    which a naive `startsWith("memory")` check misses — the recall wrapper
 *    then gets stored and re-injected forever.
 * 2. Runtime-generated instructions (schedule reminders, reflect tasks) arrive
 *    as ordinary user text, so they were captured verbatim and then promoted
 *    to the always-on block.
 */
function isNonCapturable(source, text) {
  const kind = source?.kind;
  if (typeof kind === "string") {
    if (OWN_SOURCE_KINDS.has(kind)) return true;
    if (kind.startsWith("memory")) return true;
  }
  const head = String(text ?? "").trimStart();
  for (const prefix of NON_CAPTURABLE_PREFIXES) {
    if (head.startsWith(prefix)) return true;
  }
  // Any injected recall fragment inside the text, wherever it landed.
  if (head.includes("<memory-recall>")) return true;
  return false;
}

/**
 * Text the runtime appends to a user message rather than text the user typed.
 * Captured verbatim these become multi-KB "memories" and are then promoted into
 * the always-on block (live store seen: a 5.7 KB system-reminder blob and a
 * 1.4 KB "Current runtime context" snapshot, one of them re-created every turn).
 */
const INJECTED_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<memory-recall>[\s\S]*?<\/memory-recall>/g,
];
const INJECTED_TAIL = [
  // DSH appends a full runtime snapshot after the real user text. The marker
  // is distinctive enough that a genuine message is unlikely to contain it.
  /Current runtime context\. This snapshot supersedes[\s\S]*$/,
  // Plugin-injected guidance appended after the user text (e.g. the
  // "batching-guidance" block). Seen in the live store as a 11.7 KB "memory".
  /\[Plugin context from [\s\S]*$/,
  /Time sampled while preparing[^\n]*/g,
  /Browser time zone for this request:[^\n]*/g,
  // DSH appends this elapsed-time trailer after the runtime snapshot. Anchored
  // at line start and narrowed to the real format, so a user quoting the phrase
  // keeps the rest of their line.
  /^[ \t]*Elapsed since the preceding (?:model-visible message|step context): (?:unavailable|\d[^\n]*)/gm,
  /\[model changed:[^\]]*\]/g,
];

/**
 * Strip runtime-injected blocks, leaving only what the user actually wrote.
 * Returns "" when the message was boilerplate only.
 */
export function stripInjectedContext(text) {
  let out = String(text ?? "");
  for (const re of INJECTED_BLOCKS) out = out.replace(re, " ");
  for (const re of INJECTED_TAIL) out = out.replace(re, " ");
  return out.replace(/\s+/g, " ").trim();
}

/** A real memory is a sentence or two; anything longer is a paste or a leak. */
const MAX_CAPTURE_CHARS = 1500;
const MAX_EXTRACT_CHARS = 4000;
/**
 * Captured conversation starts below the always-on threshold on purpose. When
 * capture wrote at the same 1.0 that gated the block, any fragment captured was
 * instantly eligible for promotion, and recency did the rest.
 */
const CAPTURE_STRENGTH = 0.8;

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
      const raw = (data?.content ?? [])
        .filter((b) => b?.type === "text" && typeof b?.text === "string")
        .map((b) => b.text)
        .join("\n");
      if (!raw.trim()) return false;
      const source = data?.source;
      if (isNonCapturable(source, raw)) return false;
      // Drop runtime-injected boilerplate before it can be stored. A message
      // that was only boilerplate yields "" and is skipped entirely.
      const text = stripInjectedContext(raw);
      if (!text) return false;
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
    // A long paste is not one fact. Bound what the extractor sees, and never
    // let a blob become an always-on memory.
    const excerpt = source.length > MAX_EXTRACT_CHARS ? source.slice(0, MAX_EXTRACT_CHARS) : source;

    let extracted = null;
    if (typeof this.extractor === "function") {
      try {
        extracted = await this.extractor(excerpt, { userText, assistantText, sessionId });
      } catch { /* fall back to heuristic */ }
    }

    const entities = (extracted?.entities?.length ? extracted.entities : extractEntities(excerpt)).slice(0, 16);
    let layer = extracted?.layer ?? inferLayer(source);
    // Capture never pins, so it never produces an always-on row — direct the
    // extractor's "core" judgement into weekly instead of silently dropping it
    // out of the block later.
    if (layer === "core") layer = "weekly";
    let content = normalizeContent(extracted?.content ?? excerpt);
    if (content.length > MAX_CAPTURE_CHARS) {
      content = content.slice(0, MAX_CAPTURE_CHARS) + "…";
      // A truncated fragment is not a principle: keep it out of weekly too.
      layer = "recent";
    }

    const res = this.store({ roleId, layer, content, entities, strength: CAPTURE_STRENGTH });
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

/**
 * Heuristic importance -> layer.
 *
 * Capture never returns "core". The always-on block is reserved for identity
 * (pinned rows: the seeded soul memories plus facts recorded on purpose via
 * `memory_core_add_fact`). A conversation fragment that merely contains
 * 记住/必须/重要 used to be promoted to core and then replayed every turn — in
 * the live store one such fragment took a slot and pushed three identity seeds
 * out of the budget. A strong hint now only reaches weekly.
 */
function inferLayer(text) {
  const t = text ?? "";
  if (IMPORTANCE_CORE_RE.test(t)) return "weekly";
  if (IMPORTANCE_WEEKLY_RE.test(t) || tokenEstimate(t) >= 60) return "weekly";
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
