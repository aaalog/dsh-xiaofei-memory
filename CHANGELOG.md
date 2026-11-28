# Changelog

All notable changes to `dsh-xiaofei-memory` are recorded here.
Versioning follows semantic versioning; the plugin targets DSH `0.2.2-rc.3`.

## 0.3.0 — 2026-11-25

Twenty-five commits and roughly 9,900 added lines since 0.2.0. The theme is
trust: the memory that survives a restart unchanged, cannot be lost to a wrong
similarity score, and can be read back when it is retired.

### Breaking changes

Read these before upgrading; the first is the one that changes what the model
sees on every turn.

- **The always-on block is identity only.** Selection is `pinned = 1` rather
  than "strongest core rows". Capture can no longer produce `core` at all (a
  `记住/必须` hint reaches `weekly`), and captured facts are written at strength
  0.8 instead of the 1.0 that made them instantly eligible. `coreMemoryPinnedOnly:
  false` restores the old selection.
- **The ten seed memories are unpinned.** They remain active, unchanged and
  retrievable; one derived row, `mem_soul_digest`, represents them in the block.
  The unpinning runs once behind `meta.seedPinnedMigrated`.
- **Distillation archives only what it summarised**, and a qualifying group is
  now processed in batches of eight rather than one slice: the threshold is
  absolute, so a group of ten to seventeen used to be distilled once and leave
  two to nine rows stranded below the threshold for ever. At most four batches
  per night; a trailing batch under five rows waits for more instead of becoming
  a permanent fragment.
- **A differing key token no longer retires a row.** Filenames, URLs and numbers
  are compared: a difference means a *different fact*, so the rows coexist. The
  previous release retired the older row, which ate parallel facts and numbered
  series.
- **Retired memories are kept for seven days** (`archiveRetentionDays`) before
  the nightly pass deletes them. Rows archived by an earlier build are stamped
  during migration, so they get the same window.
- **The self-tuning loop is gone.** `evolution.js` is deleted: `correctionTools`
  defaulted to empty, so `recallStats.corrections` was always zero and the loop
  never executed once. `dampFactor` and `timeDecayFactor` are plain configuration
  now. `stats()` no longer returns an `evolution` field.
- **Existing rows longer than 400 characters are not rewritten.** The cap applies
  to new writes only; trimming historical rows is a deliberate manual step.

### Added

- **Correction damping driven by the owner's words.** "记错了", "不是这个",
  "我说的是", "纠正一下" damp the memories injected on the previous turn
  (`strength × dampFactor`, restored after fifteen minutes) and increment
  `recallStats.corrections`. The damping machinery existed but had no signal
  source; false positives cost one memory a short, self-healing dip, while a
  false negative leaves the loop dead.
- **Always-on core memory** as a `systemPrompt` section (`memory:core`, order
  10150, `interpolate: false`), with a selection order that is total so identical
  store state renders identical text and the prompt prefix stays cacheable.
- **Derived soul digest**: one row distilled from the ten seeds, refreshed only
  when missing, so owner edits are never reverted.
- **Progressive disclosure**: a catalogue section listing memories that did not
  fit, plus `memory_core_read` to pull one back on demand.
- **`memory_core_restore`**, so retiring a memory is reversible from the tools
  rather than only from a SQL prompt; `memory_core_read` now says "archived,
  replaced by X" instead of "not found".
- **Nightly-sleep history** in `meta.sleepLog` (last 30 runs) with the scan size,
  threshold, distilled groups and their sizes, and whether a summariser existed.
  Rendered in the console with the same pager as every other list.
- **Memory-sea View**: a dependency-free canvas starfield on a first-class
  Conversation View tab, positioned by the same entity links retrieval uses.
- **Console rework**: lists are rows rather than cards, capped at 12 per page and
  sized to the window, with numbered pages; one spacing and type scale; the View
  takes the whole column instead of leaving the composer docked underneath.
- **`archiveRetentionDays`** (default 7) and the `superseded_by` / `archived_at`
  columns that make a retirement auditable.
- **`enableSleepSummarizer`**: the nightly summariser no longer requires
  `useLlmExtraction`, which also sends every captured turn through the model.
  Distillation needs one call per group at 03:00, not a per-turn cost.
- **`extractionProvider`**: pin the provider route instead of discovering it.
- **Volatile settings are unwrapped generically.** A hand-written key list let
  `extractionProvider` reach the model adapter as `"[object Object]"` and made
  `enableSleepSummarizer` truthy whether it was true or false.
- **The LLM caller speaks the service's actual API.** The host `llm` service
  exposes `stream()`, not `complete()`; the caller looked only for `complete` and
  returned null when it was missing, so capture extraction and the nightly
  summariser both fell back to the heuristic without a word. A streaming
  assembly replaces it, resolving the provider from the configured model id.
- **Cross-process lease** so the nightly pass runs once even when two windows are
  open; taken by both the scheduled and the manual path, released in `finally`.
- **Credential redaction** on write: assigned passwords, one-time verification
  codes and `Authorization: Bearer …` values become `***`, in the body and in the
  entity column.
- **Role policy** (`src/roles.js`): `roles[].enabled` is enforced for capture,
  retrieval, the always-on block and both tools; an agent reads its own namespace
  plus `global`, and `memory_core_read` refuses a cross-role id.
- **Entity confidence** now means something: 1.0 when the entity appears in the
  text, 0.6 when it was inferred, so `graphExpand`'s 0.8 threshold finally filters.

### Changed

- **Retrieval scores the question, not the paste.** Coverage is measured against
  the intent — the last line, or the window ending at the last question mark —
  so a log pasted above the question no longer dilutes it. Politeness prefixes
  are stripped; spaces are deliberately not clause boundaries.
- **Candidate selection** is neutral (by id) with a cap of 4000 and damped
  strength (`strength^0.5`), replacing orderings by strength and by length that
  each dropped the answer once enough rows shared the query's words.
- **FTS trigger** is scoped `OF content, role_id, layer`; a read no longer rewrites
  the index (measured 4.03× → 1.00×).
- **Merges** keep the new text when lengths are equal, raise `pinned` with
  `MAX(pinned, ?)`, and never absorb a value that only differs in a key token.
- **Catalogue ordering** is `pinned, layer, recency, id`, and shapes that name no
  topic (chat openers, bare paths, very short rows) are kept out of it while
  staying readable on demand.
- **`busy_timeout = 5000`** and `withTransaction` around every compound write,
  joining a caller's transaction with a savepoint instead of a nested `BEGIN`.

### Fixed

- **Bridge authentication prefers the injected token.** The cookie gate was
  consulted first and rejected a request before its token was read, so any
  client holding the panel's token but no browser session — a script, a future
  CLI — was locked out. The token is checked first now; the session cookie
  remains the browser's path.
- **Cross-role distillation**: a group mixed two roles' memories, wrote the
  summary into one and purged the other's originals. Groups are keyed by
  `(role_id, entity)`.
- **Capture leaks**: schedule reminders, the elapsed-time trailer, runtime
  snapshots, our own `<memory-recall>` wrapper, and background-job completion
  notices were all stored as memories.
- **The digest could be deleted**: it matched neither the seed pattern nor the
  purge exclusion, so archiving it emptied the always-on block until a restart.
- **Duplicate rows** outside the recent-20 window: an exact-content lookup now
  runs before the similarity scan.
- **Silent truncation** of over-long writes, and silent reverts of the soul
  digest, are both gone.
- Console: `injectCss` never applied a new stylesheet when one already existed;
  the sleep tab read a field the host never sends; `window.__ctx__` published the
  whole host context to the page.
- Tool contracts: every output field is declared, and `memory_core_add_fact` goes
  through the service method so a `core` fact is actually pinned.

### Notes

- Verified across four external review rounds; the review reports live in
  `reports/`.
- 364 assertions over 11 suites.

## 0.2.0 — 2026-11-04

### Added

- **Web management console** (`settings.section` page + session-header button):
  roles & routing, memory graph search, nightly-sleep controls, and system
  introspection, all rendered from the client bundle.
- **Console data bridge** at `POST /dshxf/bridge`: owner-only loopback route
  authenticated through `connection.admit()` (the same session-cookie gate as
  `/api`), with a token fallback for compositions without a connection
  service. Powers stats, search, sleep, souls, and role updates.
- Volatile, console-editable `Config` fields (`roles`, `sleepTimeHour`,
  `extractionModel`) so DSH discovers the plugin's settings namespace; values
  are unwrapped in `apply()`.

### Fixed

- **Client bundle must not export `default`**: the Loader's `unwrapExports()`
  prefers `module.exports.default`, which turned the plugin into a bare
  function and silently dropped `inject: ["slots"]` — the entry activated while
  registering nothing. `apply` + `inject` now stay on the CJS object.
- **Tool output schema mismatch**: `memory_core_retrieve` returned
  `recalled`/`text` and `memory_core_add_fact` returned `merged` without
  declaring them, so the Host's strict `additionalProperties: false` check
  reported failure after the work had already been done. Fields are declared,
  and `memory_core_retrieve` now renders the recalled `<memory-recall>` text
  instead of pointing at the auto-injected block.
- Stable `getSnapshot` fallback and numeric guards in the console, so a missing
  settings scope or number cannot crash the render and get the slot entry
  abdicated.

### Changed

- Tests: 90 checks across engine, load, console, bridge, client-bundle, and
  dist suites; `test-load` now validates every tool result against its schema.

## 0.1.0 — 2026-11-04

### Added

- Dual-track engine: `agent/pre-step` retrieval injection and `session/event`
  turn-end async capture.
- SQLite FTS5 (trigram) storage with bigram similarity scoring and entity
  graph recall.
- Nightly metabolism (entity clustering, distillation, archival) and an
  adaptive evolution loop that tunes retrieval weight and time decay.
- `memory-core` service and the `memory_core_retrieve` / `memory_core_add_fact`
  tools.
