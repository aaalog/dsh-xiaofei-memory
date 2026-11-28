// lib/llm-call.js — one text completion over the host's `llm` service.
//
// The service exposes `stream()`, not `complete()`. The plugin's first attempt
// looked only for `complete` and returned null when it was absent, so every
// LLM-backed path — capture extraction and the nightly summariser — silently
// degraded to the heuristic. Nothing reported a failure; the feature simply
// never ran, for weeks.
//
// The second attempt streamed, but resolved the provider by reading `entry.id`.
// The live provider list carries `provider`, so the id list came back empty and
// every call returned null again — still silently. That is the failure this file
// is built to make impossible: every early return reports why through `onError`.

/**
 * Read a provider id out of whatever shape the host hands back.
 *
 * The list has carried `provider` in practice; `id` and a bare string are
 * accepted so a future rename cannot silently disable the feature again.
 *
 * @param {unknown} entry one element of `listProviders()`
 * @returns {string | null}
 */
export function providerIdOf(entry) {
  if (typeof entry === "string") return entry.trim() || null;
  if (!entry || typeof entry !== "object") return null;
  for (const key of ["provider", "id", "name"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Model ids an entry advertises inline, if any. */
function inlineModels(entry) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.models)) return [];
  return entry.models
    .map((m) => (typeof m === "string" ? m : m?.id))
    .filter((m) => typeof m === "string" && m);
}

/**
 * Resolve which provider route serves a model id.
 *
 * `stream()` takes `{ provider, model }` while the plugin's config names only a
 * model, so the provider has to be discovered. Inline `models` is checked first
 * (no extra RPC), then `listModels` when the service offers it; when nothing
 * advertises the model, the first registered provider is tried anyway, because a
 * catalog is advisory and a route may accept a model it does not list.
 *
 * @param {any} llm the host llm service
 * @param {unknown} model configured model id
 * @returns {Promise<{provider: string, model: string} | null>}
 */
export async function resolveModelRoute(llm, model, forcedProvider) {
  const wanted = String(model ?? "").trim();
  if (!llm) return null;
  // An explicit provider short-circuits discovery. Discovery picks the FIRST
  // route advertising the model, and several providers can advertise the same
  // one while only some have a live key — which is exactly how a "route found,
  // call failed" loop looks from the outside.
  const forced = String(forcedProvider ?? "").trim();
  if (forced && wanted) return { provider: forced, model: wanted };
  if (!wanted) return null;

  const ids = [];
  const inline = new Map();
  try {
    const providers = await llm.listProviders?.(void 0);
    for (const entry of Array.isArray(providers) ? providers : []) {
      const id = providerIdOf(entry);
      if (!id) continue;
      if (!ids.includes(id)) ids.push(id);
      const models = inlineModels(entry);
      if (models.length > 0) inline.set(id, models);
    }
  } catch { /* fall through to the single-provider guess */ }

  for (const provider of ids) {
    if ((inline.get(provider) ?? []).includes(wanted)) return { provider, model: wanted };
  }

  if (typeof llm.listModels === "function") {
    for (const provider of ids) {
      try {
        const models = await llm.listModels(provider);
        const hit = (Array.isArray(models) ? models : [])
          .find((m) => (typeof m === "string" ? m : m?.id) === wanted);
        if (hit) return { provider, model: typeof hit === "string" ? hit : hit.id };
      } catch { /* try the next provider */ }
    }
  }

  return ids.length > 0 ? { provider: ids[0], model: wanted } : null;
}

/**
 * Build a `(prompt, { model }) => Promise<string | null>` over `ctx.get("llm")`.
 *
 * Returns null when the service is unavailable, so callers keep their heuristic
 * path. A failure inside one call also returns null — a missing summary must not
 * wedge a turn — but it is reported through `onError` first, because a silent
 * null is what hid this bug for weeks.
 *
 * @param {any} ctx plugin context
 * @param {{ onError?: (reason: string) => void }} [options]
 * @returns {null | ((prompt: string, options?: { model?: string }) => Promise<string | null>)}
 */
export function buildLlmCaller(ctx, { onError, provider: forcedProvider } = {}) {
  const report = (reason) => {
    try { onError?.(String(reason).slice(0, 200)); } catch { /* diagnostics never throw */ }
  };

  let llm;
  try { llm = ctx?.get?.("llm"); } catch { llm = undefined; }
  if (!llm) {
    report("no-llm-service");
    return null;
  }

  return async (prompt, { model } = {}) => {
    const text = String(prompt ?? "");
    if (!text) { report("empty-prompt"); return null; }
    try {
      // A composition offering a one-shot helper still wins: it is cheaper.
      if (typeof llm.complete === "function") {
        const answer = await llm.complete(text, { model });
        const trimmed = typeof answer === "string" ? answer.trim() : "";
        if (!trimmed) { report("complete-empty"); return null; }
        return trimmed;
      }
      if (typeof llm.stream !== "function") { report("no-stream"); return null; }

      const route = await resolveModelRoute(llm, model, forcedProvider);
      if (!route) { report(`no-route(model=${String(model ?? "")})`); return null; }

      let assembled = "";
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: "user", content: [{ type: "text", text }] }],
      });
      for await (const chunk of stream) {
        if (chunk?.type === "text-delta") assembled += String(chunk.text ?? "");
        else if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
          // Keep the whole finish payload: the readable message has been empty
          // every time, so the useful part (code, status, provider error body)
          // lives somewhere else in the structure.
          report(`error-finish(${route.provider}/${route.model}): ${JSON.stringify(chunk.reason).slice(0, 260)}`);
          return null;
        }
      }
      const answer = assembled.trim();
      if (!answer) { report(`empty-stream(${route.provider}/${route.model})`); return null; }
      return answer;
    } catch (e) {
      report(`call-threw: ${e?.message ?? e}`);
      return null;
    }
  };
}
