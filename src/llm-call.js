// lib/llm-call.js — one text completion over the host's `llm` service.
//
// The service exposes `stream()`, not `complete()`. The plugin's previous caller
// looked only for `complete` and returned null when it was absent, so every
// LLM-backed path — capture extraction and the nightly summariser — silently
// degraded to the heuristic. Nothing reported a failure; the feature simply
// never ran.

/**
 * Resolve which provider route serves a model id.
 *
 * `stream()` takes `{ provider, model }` while the plugin's config names only a
 * model, so the provider has to be discovered. The first provider advertising
 * the model wins; when none does, the first registered provider is tried anyway,
 * because a catalog is advisory and a route may accept a model it does not list.
 *
 * @param {any} llm the host llm service
 * @param {unknown} model configured model id
 * @returns {Promise<{provider: string, model: string} | null>}
 */
export async function resolveModelRoute(llm, model) {
  const wanted = String(model ?? "").trim();
  if (!wanted || !llm) return null;
  const ids = [];
  try {
    const providers = await llm.listProviders();
    for (const entry of Array.isArray(providers) ? providers : []) {
      const id = typeof entry === "string" ? entry : entry?.id;
      if (id) ids.push(String(id));
    }
  } catch { /* fall through to the single-provider guess */ }
  for (const provider of ids) {
    try {
      const models = await llm.listModels(provider);
      const hit = (Array.isArray(models) ? models : [])
        .find((m) => (typeof m === "string" ? m : m?.id) === wanted);
      if (hit) return { provider, model: typeof hit === "string" ? hit : hit.id };
    } catch { /* try the next provider */ }
  }
  return ids.length > 0 ? { provider: ids[0], model: wanted } : null;
}

/**
 * Build a `(prompt, { model }) => Promise<string | null>` over `ctx.get("llm")`.
 *
 * Returns null when the service is unavailable, so callers keep their heuristic
 * path. A failure inside one call also returns null: a missing summary must not
 * wedge a turn.
 *
 * @param {any} ctx plugin context
 * @returns {null | ((prompt: string, options?: { model?: string }) => Promise<string | null>)}
 */
export function buildLlmCaller(ctx) {
  const llm = ctx?.get?.("llm");
  if (!llm) return null;
  return async (prompt, { model } = {}) => {
    const text = String(prompt ?? "");
    if (!text) return null;
    try {
      // A composition offering a one-shot helper still wins: it is cheaper.
      if (typeof llm.complete === "function") {
        const answer = await llm.complete(text, { model });
        return typeof answer === "string" && answer.trim() ? answer.trim() : null;
      }
      if (typeof llm.stream !== "function") return null;
      const route = await resolveModelRoute(llm, model);
      if (!route) return null;

      let assembled = "";
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: "user", content: [{ type: "text", text }] }],
      });
      for await (const chunk of stream) {
        if (chunk?.type === "text-delta") assembled += String(chunk.text ?? "");
        else if (chunk?.type === "finish" && chunk.reason?.kind === "error") return null;
      }
      const answer = assembled.trim();
      return answer || null;
    } catch {
      return null;
    }
  };
}
