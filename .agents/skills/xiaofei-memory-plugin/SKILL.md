---
name: xiaofei-memory-plugin
description: Use when modifying, building, testing, deploying, or debugging the runtime-xiaofei-memory plugin (the "digital hippocampus" long-term memory engine for the DSH runtime) — including its SQLite store, always-on core memory, memory sea UI, nightly sleep, and the pnpm/GitHub install cycle.
whenToUse: Any task that touches runtime-xiaofei-memory source, its dist bundles, its installed copy under the DSH profile, its SQLite memory database, or that needs the build → push → reinstall → restart cycle to take effect.
---

# runtime-xiaofei-memory plugin work

A headless long-term memory plugin for the DSH runtime. Node-side engine plus a
browser-side View. Zero runtime dependencies apart from `node:sqlite`.

## The two facts that cause the most wasted time

**1. `runtime` and `runtime` are the same string, and this machine shows them
interchangeably.** The display layer rewrites `runtime` (bytes `64 73 68`) into
`runtime` (bytes `72 75 6e 74 69 6d 65`) in tool output AND in text you write.
Never trust a literal. Verify with hex:

```python
print([hex(ord(c)) for c in name][:3])   # 64 73 68 = runtime (correct)
```

- Real repo: `https://github.com/aaalog/runtime-xiaofei-memory`
- Real home dir: `~/.runtime` (bytes `2e 64 73 68`)
- Real plugin dir name: `runtime-xiaofei-memory`

Consequence: paths typed literally fail with "No such file or directory". Build
paths from `os.listdir` results instead of string literals.

**2. Host changes need a restart; client changes only need a page refresh.**

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

Expected total: **202 passed, 0 failed**. The system default `node` is v16 and
has no `node:sqlite`; always pin v22.18.0 or the runtime's bundled node.

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
#    profile: ~/.runtime/profiles/desktop/package.json
#    "runtime-xiaofei-memory": "github:aaalog/runtime-xiaofei-memory#<SHA>"

# 4. install with the runtime's own toolchain
NODE=".../runtime/primary-runtime/dependencies/node/bin/node.exe"
PNPM=".../runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
"$NODE" "$PNPM" install --filter .   # cwd = the profile dir
```

Then **restart DSH** (host changed).

Back up before touching anything installed:
`cp -r <plugin dir> <repo>/.backup/installed-before-<reason>-<ts>/`

`.backup/` and `.dsh-vision-router/` are gitignored — keep them that way.

## Touching the memory database

Production store: `~/.runtime/plugin-data/runtime-xiaofei-memory/memory.sqlite`

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

- **B1 nightly distillation is parked.** The threshold is
  `clamp(ceil(layerSize * 0.15), 3, 10)` and grouping skips noise entities, but
  with only ~20 memories the largest same-entity cluster is 3–4 across layers,
  so distillation still never fires. Revisit when the store reaches 100+.
  The fix direction is cross-layer grouping plus a relative-density threshold.
- **No embeddings.** Retrieval is FTS5 trigram + LIKE + bigram similarity. Two-
  character CJK terms never match FTS (trigram needs 3), so LIKE does the work
  and recall degrades past ~17k rows (measured 305–862 ms at 17.7k).
- **`entity_index.confidence` is always 1.0**, so `graphExpand`'s
  `confidence >= 0.8` filter is a no-op. It has never filtered anything.
- The plugin calls itself a "digital hippocampus" but implements no PPR —
  it is retrieval + 1-hop entity co-occurrence + layer ordering. Do not build
  on the metaphor.

## Console / UI landmarks

- The Conversation View tabs live in slot `conversation.view` (list,
  `replaceRisk: none`). This plugin registers `id: runtime-xiaofei-memory`,
  `order: 40` — after chat(0)/trajectory(10)/context(20)/fleet(30).
- Section slot: `systemPrompt.section({ name: "memory:core", order: 10150,
  interpolate: false, text })`. `interpolate: false` matters: memory text may
  contain `{{…}}`.
- `getSectionOrder()` returns `undefined` for names not in `SECTION_ORDERS`,
  and `section()` rejects a non-finite order — hence the literal `10150`.
- Bridge ops: `stats`, `search`, `preview`, `graph`, `core`, `build`, `sleep`,
  `roles`, `updateRoles`, `souls`, `config`. Adding one to the host without
  restarting yields `unknown op`.
