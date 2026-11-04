# Changelog

All notable changes to `dsh-xiaofei-memory` are recorded here.
Versioning follows semantic versioning; the plugin targets DSH `0.2.1-rc`.

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
