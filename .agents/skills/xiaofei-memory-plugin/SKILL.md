---
name: xiaofei-memory-plugin
description: Use when modifying, building, testing, deploying, or debugging the dsh-xiaofei-memory plugin (the "digital hippocampus" long-term memory engine for DSH / DeepSeek Harness) — including its SQLite store, always-on core memory, memory sea UI, nightly sleep, and the pnpm/GitHub install cycle.
whenToUse: Any task that touches dsh-xiaofei-memory source, its dist bundles, its installed copy under the DSH profile, its SQLite memory database, or that needs the build → push → reinstall → restart cycle to take effect.
---

# dsh-xiaofei-memory plugin work

A headless long-term memory plugin for DSH (DeepSeek Harness). Node-side engine
plus a browser-side View. Zero runtime dependencies apart from `node:sqlite`.

## The one false fact that has cost the most time

**The name is `dsh-xiaofei-memory`. There is no `runtime-xiaofei-memory`, and no
`~/.runtime`.** `runtime-` appears all over this repo's prose and log strings,
but it is a transcription error that predates this file — not a display
transform. Ground truth re-verified on disk 2026-11-14:

- Repo / workspace dir: `C:\Users\Administrator\Documents\deepseek-harness\dsh-xiaofei-memory`
- DSH home: `~/.dsh` (bytes `2e 64 73 68` = `. d s h`)
- Package name and plugin id: `dsh-xiaofei-memory`
- Repo: `https://github.com/aaalog/dsh-xiaofei-memory`
- Store: `~/.dsh/plugin-data/dsh-xiaofei-memory/memory.sqlite`

Why "the display layer rewrites it" is wrong: the profile pins the dependency as
`github:aaalog/dsh-xiaofei-memory#<SHA>`, and `pnpm-lock.yaml` records a tarball
fetched from `https://codeload.github.com/aaalog/dsh-xiaofei-memory/tar.gz/<SHA>`
together with its integrity hash. A `runtime-` literal in that position would
404 and the install would fail. Nothing rewrites the bytes.

Bytes `64 73 68` spell `d`, `s`, `h`. Any text claiming that hex equals
`runtime` is itself the bug. So: **do not "correct" `dsh` to `runtime` in paths,
output or files.** If a name looks wrong, check the filesystem, `git remote -v`
and `package.json` — not the prose in this repo, and not session history, which
both carry the same corruption.

**Host changes need a restart; client changes only need a page refresh.**

| Bundle | Loaded when | Effect of editing |
|---|---|---|
| `dist/index.js` (host) | process start, cached in the ESM module registry | **requires DSH restart** |
| `dist/client/index.js` (browser) | page load, re-read from disk | refresh the page |

Editing the host without a restart is the #1 confusion source: the UI shows
new features while every new bridge op returns `unknown op "xxx"`. The plugin
now guards against this — `build.mjs` stamps both bundles and the View shows a
warning when the page and the running host disagree.

## Layout

```
src/index.js         plugin entry: Config schema, apply(), bridge ops, tools
src/core-memory.js   always-on tier: systemPrompt section, render cache
src/memory-index.js  catalogue tier + on-demand read resolution
src/capture.js       turn capture, merge/conflict pass, non-capturable filter
src/retrieval.js     hybrid retrieval and <memory-recall> injection
src/sleep.js         nightly distillation
src/db.js            SQLite schema, queries, seed memories, purge guard
src/console.js       host-side helpers backing the Web console
src/client/          browser half: Conversation View, memory sea, console tabs
build.mjs            esbuild: backend ESM + frontend __ModuleLoader__ bundle
```

## Non-obvious invariants

These are load-bearing. Breaking one silently degrades the engine.

- **The ten seed memories (`mem_001`–`mem_010`) are irreplaceable.**
  `seedIfEmpty` only seeds when the *whole table* is empty, so a deleted seed
  never comes back. `purgeArchived` resurrects any archived seed before
  deleting, and `addMemory`'s conflict pass refuses to archive one. Keep both.
- **`addMemory` archives a row whose similarity passes ~0.75.** Bulk-inserting
  near-identical fixture text collapses rows and breaks tests. Test fixtures
  must use genuinely different sentences.
- **Prompt section text must be stable.** KV reuse is a prefix cache: anything
  after the first changed token is invalidated. The always-on section is
  ordered `10150` (tail of the assembled prompt) precisely so a change costs
  only the trailing persona suffix. Selection order is
  `strength DESC, created_at DESC, id ASC` — total, so identical state renders
  identically.
- **A prompt section must never throw.** A throw fails prompt assembly for
  every request on that agent. Every path in `core-memory.js` catches and
  degrades to an empty section.
- **`agent/created` is a serial event.** A rejection there fails agent
  creation. The listener wraps everything in try/catch; do not remove it.
- **Per-agent registration, not global.** `agent.ctx.inject` gives a fiber
  scoped to one agent, which is what keeps role namespaces isolated.
- **Bridge calls use the absolute path `/dshxf/bridge`.** A relative path
  resolves against `/s/<id>` on the conversation page and 404s.
- **Canvas views must own their height.** A Conversation View renders inside
  the session column that also hosts the composer; without
  `height:100%` + `overflow-y:auto` the composer shows through.

## Verify a change

```bash
export PATH="/c/Users/Administrator/AppData/Roaming/nvm/v22.18.0:$PATH"
for t in test-engine test-load test-console test-core-memory test-sleep \
         test-memory-index test-capture-filter test-dist test-client \
         test-bridge test-dist-load; do
  printf "%-24s " "$t"; node "$t.mjs" 2>&1 | grep -E "^RESULT"
done
```

Expected total: **261 passed, 0 failed**. The system default `node` is v16 and
has no `node:sqlite`; always pin v22.18.0 or the node bundled with the DSH
runtime.

## Build → push → reinstall (the only way a change reaches the running plugin)

The profile installs this plugin **from GitHub at a pinned commit**, so local
source edits alone never take effect.

```bash
# 1. build (writes dist/ and stamps both bundles)
node build.mjs

# 2. run the tests above, then commit and push
git add -A && git commit -m "..." && git push origin main
SHA=$(git rev-parse HEAD)

# 3. re-pin the profile dependency to the new commit
#    profile: ~/.dsh/profiles/desktop/package.json
#    "dsh-xiaofei-memory": "github:aaalog/dsh-xiaofei-memory#<SHA>"

# 4. install with DSH's own toolchain
NODE="~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
PNPM="~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
"$NODE" "$PNPM" install --filter .   # cwd = the profile dir
```

Then **restart DSH** (host changed).

Back up before touching anything installed:
`cp -r <plugin dir> <repo>/.backup/installed-before-<reason>-<ts>/`

`.backup/` and `.dsh-vision-router/` are gitignored — keep them that way.

## Touching the memory database

Production store: `~/.dsh/plugin-data/dsh-xiaofei-memory/memory.sqlite`

- **Read-only unless explicitly authorized**: `sqlite3.connect("file:"+path+"?mode=ro", uri=True)`
- **Back up first** — both a `.sqlite` copy and a JSON dump — and verify the
  backup opens and has the expected row count before deleting anything.
- **Never delete a seed row.** Exclude `id GLOB 'mem_0[0-9][0-9]'` from every
  delete set, and assert it afterwards.
- Nightly sleep runs at 03:00 and calls `purgeArchived`, which physically
  deletes archived rows.

Locating the store without literal paths:

```python
home = os.path.expanduser("~")
dsh  = next(os.path.join(home, n) for n in os.listdir(home)
            if n.startswith(".") and os.path.isdir(os.path.join(home, n, "profiles")))
pdir = next(os.path.join(dsh, "plugin-data", n) for n in os.listdir(os.path.join(dsh, "plugin-data"))
            if "xiaofei" in n)
db   = os.path.join(pdir, "memory.sqlite")
```

## Known state and deferred work

- **B1 nightly distillation is volume-unblocked but quality-blocked.** The
  threshold is `clamp(ceil(layerSize * 0.15), 3, 10)`. At 222 memories
  (core 16 / weekly 46 / recent 160) the recent threshold is 10, so real
  candidates do clear it (`SpdiamPriduct` 18 hits, `SQL` 19). Size is no longer
  the obstacle; entity quality is. Before the second noise pass the single
  largest "entity" in the store was `Elapsed`, the runtime trailer word, with
  78 hits and 41 graph links. Fix extraction before expecting useful
  distillation.
- **No embeddings.** Retrieval is FTS5 trigram + LIKE + bigram similarity. Two-
  character CJK terms never match FTS (trigram needs 3), so LIKE does the work
  and recall degrades past ~17k rows (measured 305–862 ms at 17.7k).
- **`entity_index.confidence` is always 1.0**, so `graphExpand`'s
  `confidence >= 0.8` filter is a no-op. It has never filtered anything.
- The plugin calls itself a "digital hippocampus" but implements no PPR —
  it is retrieval + 1-hop entity co-occurrence + layer ordering. Do not build
  on the metaphor.
- **Two leak defences, and both are load-bearing.** `isNonCapturable` rejects
  by source kind (`OWN_SOURCE_KINDS`) and then by text prefix;
  `stripInjectedContext` removes runtime blocks and trailers (`INJECTED_TAIL`)
  from whatever survives. The trailer regex is line-anchored on purpose — an
  unanchored version ate the rest of a user's sentence whenever they merely
  *discussed* the phrase. Test block 10 in `test-capture-filter.mjs` guards it.
- **Noise entities are re-derived from measurements, not guessed.** Read the
  live `entity_index` before touching `NOISE_ENTITIES`; a word earns a place
  there only if it actually held links without carrying retrieval signal.

## Console / UI landmarks

- The Conversation View tabs live in slot `conversation.view` (list,
  `replaceRisk: none`). This plugin registers `id: dsh-xiaofei-memory`,
  `order: 40` — after chat(0)/trajectory(10)/context(20)/fleet(30).
- Section slot: `systemPrompt.section({ name: "memory:core", order: 10150,
  interpolate: false, text })`. `interpolate: false` matters: memory text may
  contain `{{…}}`.
- `getSectionOrder()` returns `undefined` for names not in `SECTION_ORDERS`,
  and `section()` rejects a non-finite order — hence the literal `10150`.
- Bridge ops: `stats`, `search`, `preview`, `graph`, `core`, `build`, `sleep`,
  `roles`, `updateRoles`, `souls`, `config`. Adding one to the host without
  restarting yields `unknown op`.
