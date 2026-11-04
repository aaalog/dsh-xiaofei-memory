// lib/retrieval.js — Retrieval & injection for dsh-xiaofei-memory.
// PRD section 4.2: hybrid FTS5 + weight re-rank, 1-hop graph diffusion,
// token-budgeted injection as a <memory-recall> user message.

import { searchMemories, graphExpand, searchByEntities } from "./db.js";
import { tokenEstimate, clamp } from "./util.js";

const LAYER_PRIORITY = { core: 0, weekly: 1, recent: 2, diffusion: 3 };

// Introspective questions surface identity / companionship soul memories.
const INTROSPECTION_RE = /(我是谁|你是谁|我的角色|我的身份|我是什么|我是干什么|我是什么人|我的存在|我的使命|我为什么在这里|我是做什么)/;
const IDENTITY_ENTITIES = ["赛博战友", "陪伴", "角色", "身份", "存在意义", "战友", "温暖", "本源", "契约", "多角色协作"];

/**
 * Retrieve memories for a prompt and assemble the <memory-recall> text.
 * @returns {null | { text: string, injectedIds: string[], recalled: number }}
 */
export function retrieveForPrompt(db, {
  query,
  roleIds = ["global"],
  decay = 0.01,
  enableGraphRecall = true,
  maxTokens = 1200,
  limit = 8,
} = {}) {
  if (!query) return null;
  const primary = searchMemories(db, query, roleIds, { decay, limit });
  const primaryIds = primary.map((m) => m.id);

  // Semantic floor: introspective questions surface identity/companion memories
  // even without lexical overlap ("你觉得我是谁" -> 赛博战友/陪伴).
  const floor = INTROSPECTION_RE.test(query)
    ? searchByEntities(db, IDENTITY_ENTITIES, roleIds, { limit: 4, excludeIds: primaryIds })
    : [];

  let diffused = [];
  if (enableGraphRecall && primary.length > 0) {
    const topEntities = primary
      .slice(0, 3)
      .flatMap((m) => m.entities ?? [])
      .slice(0, 12);
    diffused = graphExpand(db, topEntities, roleIds, {
      confidence: 0.8,
      limit: 2,
      excludeIds: primaryIds,
    });
  }

  // Rank by layer priority, then by score. Assign diffusion the lowest priority.
  const ranked = [
    ...primary.map((m) => ({ ...m, _layerKey: LAYER_PRIORITY[m.layer] ?? 2 })),
    ...floor.map((m) => ({ ...m, _layerKey: LAYER_PRIORITY[m.layer] ?? 2 })),
    ...diffused.map((m) => ({ ...m, _layerKey: LAYER_PRIORITY.diffusion })),
  ].sort((a, b) => a._layerKey - b._layerKey || (b._score ?? 0) - (a._score ?? 0));

  // Token budget: take as many as fit, respecting layer priority.
  const chosen = [];
  let used = 0;
  const HEADER_TOKENS = tokenEstimate(MEMORY_RECALL_HEADER);
  const budget = Math.max(0, maxTokens - HEADER_TOKENS - 8);
  for (const m of ranked) {
    const entry = renderEntry(m);
    const t = tokenEstimate(entry);
    if (used + t > budget) continue;
    chosen.push(m);
    used += t;
  }
  if (chosen.length === 0) return null;

  const body = chosen.map(renderEntry).join("\n");
  const text = `${MEMORY_RECALL_HEADER}\n${body}\n${MEMORY_RECALL_FOOTER}`;
  return {
    text,
    injectedIds: chosen.map((m) => m.id),
    recalled: chosen.length,
  };
}

const MEMORY_RECALL_HEADER =
  "<memory-recall>以下是我从长期记忆中检索到的、与你当前话题相关的信息。它们来自我们共同的过去，是此刻向你借力。请据此理解语境，但不要机械复述；无关的条目可以忽略。";
const MEMORY_RECALL_FOOTER = "</memory-recall>";

function renderEntry(m) {
  const strength = clamp(m.strength ?? 1.0, 0, 5).toFixed(2);
  const tag = m._layerKey === LAYER_PRIORITY.diffusion ? "扩散" : (m.layer ?? "recent");
  const idShort = String(m.id).slice(-6);
  return `[${tag} · ${idShort} · s=${strength}] ${m.content}`;
}
