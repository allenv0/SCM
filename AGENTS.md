# AGENTS.md

Working notes for AI agents (and humans) modifying this repo. Every trap
below caused a real regression; every command below is what CI runs when
CI can run (see the end).

## Process model

- **Source vs shipped**: everything below is SOURCE, edited in place.
  `bun run build` also compiles the whole Node side 1:1 into
  **`dist-main/`** (`tsc -p tsconfig.main.json` + the asset copy from
  `scripts/copy-main-assets.js` — Stage A of the TS migration) and the
  packaged app runs that mirror (`package.json` `main`, `build.files`).
  **Never edit `dist-main/`** — it is generated; `bun run build:main`
  rebuilds it, `bun run watch:main` watches it.
- `main.ts` — Electron main entry (1 file, wires everything). The packaged
  app runs its compiled mirror, `dist-main/main.js`.
- `main/**` — main-process modules. Cross-module traffic mostly runs
  through the shared **context object** (`main/context.ts`): `main.ts`
  assigns ctx slots via "stubs" that run in file order at load, and a
  stub that dereferences a `const` declared later in `main.ts` is a
  load-order (TDZ) crash — keep stub reads at call time. The slot
  surface is typed (`MainContext` interface, 69 slots); per-file
  `// @ts-check` opts files in, **and the pragma must be on line 1 —
  before `"use strict"` — or tsc silently ignores the whole file**. Leaf modules
  may also be required directly (e.g. `main/ipc/media.ts` →
  `main/ipc/pumps/*.ts`); never introduce a require **cycle** — a cycle
  shows up as a partially-initialized export (the main-load harness
  reports such reads as missing exports).
- `main-lib/**` — plain-node helper libraries (no electron import; unit
  testable). `main-lib/store/**` is the library/index persistence layer.
- `indexer/**` — code that runs inside `utilityProcess` workers
  (`indexer.ts`, `ocr-worker.ts`, `transcribe-worker.ts`,
  `main-lib/rank-worker.ts`). Workers fork at **boot**, never at load:
  `main/ipc/pool.ts`, `main/ipc/migration.ts`, `main/ipc/pumps/ocr.ts`,
  `main/ipc/pumps/transcribe.ts`, `main/ipc/rank-moments.ts`. Fork paths
  are `__dirname`-relative, so they follow the dist-main mirror for free.
- `preload.js` — the renderer bridge. Runs with `sandbox: true`, so it
  **must stay a single-file CommonJS script** — the only allowed
  `require` is `electron`. It is typed against `MemoriesBridge`
  (`src/types.d.ts`); that pairing is checked by `tsc`. It is emitted
  to `dist-main/preload.js` so protocol.js's
  `join(appDirname, "preload.js")` resolves in both source and compiled
  runs; never give it a relative require.
- `src/**` — React renderer (Vite, `dist/`). `shared/**` — modules
  imported by both sides (`.ts` since Stage D); the Node side imports them
  directly (type stripping at source, emitted CJS in dist-main — the
  packaged-asar boot in the PR subset guards this).
- **Stage B: COMPLETE** — every first-party Node file is `.ts` (the last
  holdout, `main-lib/youtube.js`, is now `main-lib/youtube.ts` and
  type-checked). `dist-main/` emits 1:1. A converted file
  imports *converted* siblings with explicit **`.ts` specifiers** and
  *unconverted* siblings (third-party, `preload.js`) with `.js`; both
  tsconfigs set `rewriteRelativeImportExtensions`, so the emit points at
  `.js`. Node's own source loads resolve `.ts` literally (require(esm));
  bun also maps `.js` → `.ts`. `eslint.config.js` pre-disables
  `no-require-imports` for the converted trees (deliberately-lazy requires
  stay until the Stage C audit).

## Never do this

- **Never drop the `HardwareMediaKeyHandling` disable switch in
  `main.ts`** — Chromium's macOS system-media-controls teardown (Now
  Playing / media keys, `MPRemoteCommandCenter`) is the one place that
  can SIGTRAP the whole app while users switch videos: the Oct-2026
  field crash (0.2.4, Electron 43.7.0 / Chromium 150) died on
  `-[MPRemoteCommand removeTarget:action:]` mid scene-switch. SCM never
  uses `navigator.mediaSession`; the OS integration is automatic and
  pure crash surface. The switch is the only thing keeping the app out
  of that state machine — see the comment above it.
- **Never run `node_modules/.bin/electron .` without
  `MEMORIES_DATA_DIR`** — it opens the developer's real library and
  mutates real data. Use the smoke runners instead (below). All smokes
  set a scratch data dir with the model cache symlinked in.
- **Never put `// @ts-check` after `"use strict"`** — TypeScript scans
  pragmas before the first statement; a pragma below the prologue is
  silently ignored and the file is never checked (learned when a
  "clean" opt-in hid 9 errors). Line 1, always.
- **Don't add a `.js` extension-less relative require in prod code** —
  `test/packaged-files.test.js` resolves extensionless requires by
  appending `.js`, and the packaged asar needs exactly the on-disk
  files. Always write explicit extensions (`require("./x.js")`).
- **Don't run a converted-graph script with plain `node`** — node never
  maps a `.js` specifier to its `.ts` sibling (Stage B). All `test:*`
  unit scripts run under `bun run`; only `test:main-load` /
  `test:ipc-bridge` stay on node (the harness patches `Module._load`
  for the `.js`→`.ts` remap and electron stub, and registers in-process
  ESM hooks so converted files' `import … from "electron"` reaches the
  same stub). `bun test test/` runs
  everything under bun.
- **Never literal-`require` `scripts/**` or `test/**` from prod code** —
  neither is packaged; the packaged app would crash if the branch ever
  ran. Smoke helpers go through `main.ts`'s `requireDev()`
  (`app.getAppPath()`-resolved, env-gated) — the dispatch itself lives
  in `main/smoke.ts` and receives `requireDev` as a dep; the
  packaged-files test fails on any literal that slips in.
- **Never resolve app-root assets (`dist/`, `public/`) with `__dirname`**
  — compiled code lives in `dist-main/`, one level down; use
  `app.getAppPath()` (repo root in dev, asar root packaged). Only
  paths inside the mirrored tree (`main/**`, `main-lib/**`,
  `indexer/**`, `shared/**`, `preload.js`) may be `__dirname`-relative.
- **Don't trust "it loaded in tests" for the main process.** Unit tests
  never execute `main.ts`. `bun run test:main-load` does — via its compiled
  mirror `dist-main/main.js` (run `bun run build:main` first), with a stubbed
  `electron` — so run it after touching any require wiring; the PR subset's
  packaged boot covers the asar. Both cover the same compiled entry.
- **Never spawn a child process raw in the main process.** Register it —
  `main-lib/child-registry.ts` (`trackChild`) for app-spawned children,
  `indexer/video-utils.ts`'s `spawnFfmpeg` for ffmpeg. A raw `spawn` in
  `main/` is invisible to `runWillQuitCleanup`, so the child survives the
  app, reparented to PID 1, still burning CPU / downloading / holding
  model weights with nothing left to observe it (the 2026-09-28 ffmpeg
  lesson, applied to yt-dlp, the ffmpeg merge and llama-server).
  `main/ipc/previews.ts` states the rule; it now has a mechanism behind
  it. Gate: `bun run test:child-registry` + `bun run test:ask`.
- **Never let a main-process child's lifetime depend on a promise that
  can be abandoned.** The sidecar was only adopted into `server.proc`
  after its health poll resolved, so a quit during that window had no
  handle on the child. Register the child at spawn; adopt it only if it
  is still the live one.

## Crash forensics (logs, breadcrumbs, dumps)

Added with the 0.2.4 scene-switch SIGTRAP: that field crash arrived with a
stack but nothing about what the app was doing.

- **Logs**: `userData/logs/main-YYYYMMDD.log`, rotated at 2 MB to `.1`,
  pruned past 14 days. Every console line lands there through a buffered
  write stream.
- **Breadcrumbs** (`[breadcrumb]` lines, main.ts `logBreadcrumb`): the
  user-action trail, fed by the renderer through the `memories:breadcrumb`
  send channel (lightbox open/switch/close today — add calls at other risky
  action sites the same way). Appended with `appendFileSync` the moment they
  arrive on purpose: buffered lines can be lost in a hard kill, which is
  precisely how the field crash behaved. Sanitized + capped at 300 chars.
- **Crash dumps**: `crashReporter.start({ uploadToServer: false })` in
  main.ts collects local Crashpad minidumps for main/renderer/child
  crashes under `app.getPath("crashDumps")` (startup logs the path as
  `[startup] crash dumps (local only): ...`; `MEMORIES_DATA_DIR` runs
  redirect it under the scratch dir). Nothing is ever uploaded — support
  asks the user for that directory when a native crash is reported.
- `[child-process-gone]` / `[render-process-gone]` log lines name
  worker/renderer deaths with reason + exit code.

## CJK / rank tokenization — one shared spec, never a copy

Tokenization lives in `shared/cjk-tokens.ts` (rune class, runs, bigrams,
CJK-aware joining) and `shared/rank-tokens.ts` (the four token variants,
their deliberate differences documented in the header). Renderer modules
import them through the `src/lib/cjkTokens.ts` facade; the Node side —
`main-lib/rank-search.ts`, `main-lib/ask/retrieve.ts`,
`indexer/ocr-worker.ts`, `indexer/memory-embedding-utils.ts` — import the
`.ts` directly (type stripping at source; the compiled dist-main mirror
ships the emitted CJS). `test/token-parity.test.ts` runs a corpus through
every consumer and
fails if any file re-inlines the rune class or drifts behaviorally. Change
the spec, run `bun run test:token-parity` plus the CJK/OCR sibling tests
(`bun test test/cjk-tokens.test.ts`, `bun run test/ocr-cjk.test.js`).

## IPC seam — 4 places, all of them

`scripts/bridge-table.mjs` is the single source of truth. Adding/renaming
a channel means:

1. Edit `scripts/bridge-table.mjs`, then `node scripts/gen-bridge.js`
   (this regenerates both `preload.js` and `docs/ipc-contract.md`).
2. `src/types.d.ts` — add the matching `MemoriesBridge` member (`tsc`
   fails on drift, both directions).
3. The owning handler in `main/**` (handlers register at module top via
   `main/ipc-wrapper.js`; duplicate `ipcMain.handle` throws at load).
4. Run `bun run test:ipc-bridge` — it fails if the table, the generated
   files, the channels actually registered at load, or `MemoriesBridge`
   disagree.

Never hand-edit `preload.js` or `docs/ipc-contract.md` — both are
generated. `ipcMain.on` vs `.handle`: request/response uses `handle`, the
single fire-and-forget channel (`memories:ask-stop`) uses `on`, pushes use
`webContents.send`.

**Failure contract (wrapper V2, 2026-10-24).** Every invoke declares its
failure shape in the table (`failure:` — `envelope` = `{ok:false, error}`,
`empty`/`null` = documented sentinels, `mixed` = the renderer reads every
shape and the entry says so; full legend beside the table). The wrapper
(`main/ipc-wrapper.ts`) adds one uniform *rejection* contract on top: a
handler that throws is logged as `[ipc] <channel>` and re-crosses the
bridge as a real Error — so a handler must still **resolve** its declared
result shape rather than throw, and a failure path that resolves a bare
`{ok:false}` without a reason is a bug (every such path carries `error`
now). The empty/null sentinels log their swallowed failures before
returning them.

## Verification commands (all run from repo root)

```bash
bunx tsc --noEmit            # or: bun run typecheck — all first-party JS+TS
bun run lint                 # eslint (0 errors is the bar; warnings exist)
bun run format               # prettier --write . (always run before commit)
bun run build:main           # fresh checkout: bun test test/ loads dist-main
bun test test/               # all suites, node-style files included
bun run test:main-load       # headless require of dist-main/main.js (build:main first)
bun run test:ipc-bridge      # bridge table ↔ preload ↔ registration ↔ types
bun run test:token-parity    # every consumer ↔ the shared tokenization spec
bun run test:packaged-files  # asar coverage of every prod require
bun run test:audit-runtime   # production advisories: fail closed, retry transient audit outages
SCM_REQUIRE_PACKAGED=1 bun run test:packaged-size  # after electron-builder --dir
bash scripts/pr-subset.sh    # build + boot + cto + reveal (real Electron)
bash scripts/smoke-all.sh    # full battery (~2 h, needs models; for main pushes)
```

Smoke logs: `/tmp/scm-pr-subset.log`, `/tmp/scm-battery.log`. Each smoke
takes `MEMORIES_DATA_DIR=tmp` plus model/OCR symlinks — copy the
`setup_tmp`/`electron_run` helpers from `scripts/smoke-all.sh` for new
smokes rather than inventing new isolation.

Bun is pinned via `packageManager` (**1.3.14**). Exit-code semantics were
verified on that exact version: `bun test` (file and directory mode, node-
style failing files included) and `bun run` both propagate failures. A
1.3.14 toolchain for local runs lives in `.tools/bun-1.3.14/` (gitignored).

**Test-file conventions (directory-run survival, learned 2026-10-24):**
`bun test test/` runs every file in ONE process, and it (a) dies silently
on any `process.exit()` and (b) ignores a plain script's `process.exitCode`.
So node-style suites must never call `process.exit()` — set `exitCode` AND
throw on failure (the throw is what the directory run counts; standalone
`node`/`bun run` still exit 1) — and any suite with async work and shared
module state must be a `bun:test` file (`test()` callbacks are awaited
before the next file starts; a plain script's un-awaited promise chain is
not, which is how ask-models' fetch mocks once leaked into ask-server).

Node's floor is `engines.node` (**>=20.9.0** — sharp 0.35's requirement);
`.nvmrc` tracks the CI LTS major (26). Keep them in sync when the native
deps move.

## CI status (2026-10)

**The public repo (`allenv0/SCM`) is the working CI harness** (free
minutes): every push runs gates plus the full smoke battery. First
fully green run incl. the battery came on 2026-10-18 (run
39149930080, on `c3f5af6`), enabled by the smoke-flake hardening in
`ff40b24` — honest waits, not just bigger timeouts: e2e drains the
boot backfill before cold-start searches through the new
`isEnrichInFlight`/`isTranscribeInFlight` ctx gate reads (adding ctx
slots follows the usual context-object rules), a rate-checked 420 s
segment deadline, the deep All-tab check re-scrolls every poll, and
the perf-grid span assert waits for the scroll span to settle.

**The dev repo (`allenv0/SCM-dev`) remains billing-blocked** — public
runs are currently the CI feedback loop. Dev runs die in ~7 s before
any step executes ("recent account payments have failed or your
spending limit needs to be increased"; e.g. run 39208389648,
2026-10-19). The local commands above are always the source of truth.
Once billing is fixed, PRs run gates plus an automatic main-process
subset (`.github/workflows/ci.yml`, `changes` job); the full battery
runs on main pushes / nightly / manual dispatch, or on a PR carrying
the `battery` label.
