# TypeScript / ESM migration — live status

Tracked counterpart of the working plan (`MDs/ts-migration-plan.md`,
local-only). Goal: the whole Node-side tree (`main.js`, `main/**`,
`main-lib/**`, `indexer/**`, `preload.js`, `screenshot-probe.js`) is
TypeScript/ESM — reliably maintainable by AI agents — without a big-bang
rewrite.

## Decisions (locked)

- **No big bang.** Stage A makes the build pipeline a no-op (existing JS
  compiles through tsc, packaging swaps to `dist-main/`, zero renames);
  Stage B converts file-by-file to `.ts` with **CJS emit** (runtime
  identical); Stage C flips module groups to ESM only after asar /
  utilityProcess spikes prove it out; Stage D is cleanup.
- **`preload.js` stays a typed single-file CJS script forever**
  (`sandbox: true`; only `electron` may be required). It is `@ts-check`ed
  against `MemoriesBridge`.
- **`shared/*.mjs` stays `.mjs` + `@ts-check` for the campaign** (files
  serving both renderer bundler and node runtime); a `.ts` flip is
  optional Stage D work.
- Formatting is owned by prettier (`bun run format` before every commit);
  `indexer/text-mean/*.json` is generated minified data and ignored.
- Commits are atomic per Tier item; all work on `feat/ts-migration`
  rebased/merged to `main` per stage so the battery runs.

## Status

- [x] **Tier 0.1** tsc program covers all first-party JS
      (`main`, `main-lib`, `indexer`, `shared`, `preload.js`,
      `screenshot-probe.js`; `checkJs: false`, per-file `@ts-check`
      opts in). 75 → 117 files, ~2 s. `typecheck` script; explicit
      packaged-files CI gate. — `2b52a23`
- [x] **Tier 0.2** headless main-load harness (`test/main-load-harness.js`
      + `test/main-load.test.js`): stubbed `electron` via `Module._load`,
      fails on require-time TDZ/throws, reads of missing exports (proxy
      trap, negative-probe verified), load-time `utilityProcess.fork`,
      duplicate `ipcMain.handle`. 62 handle + 1 on channels at load. —
      `1e0db68`
- [x] **Tier 0.3** automatic PR subset (`changes` job → macOS
      `scripts/pr-subset.sh`: build + boot + cto + reveal); battery stays
      off PRs except the `battery` label; `workflow_dispatch` kept. —
      `6f5d271`
- [x] **Tier 0 hygiene** `format:check` was red on main (26 drifted
      files); mechanical reformat + generated-data ignore. — `60e3fde`
- [x] **Tier 0.4** `MemoriesBridge` exported; `preload.js` `@ts-check`ed
      against it (verified drift → TS2561); seam is exactly 62 invoke +
      1 send + 4 push = 62 handle + 1 on. — `ededd42`
- [x] **Tier 0.5** bun exit-code semantics re-verified on pinned
      **1.3.14** (standalone temp install): `bun test` file/dir modes and
      `bun run` propagate node-style failures. No code change needed.
- [x] **Tier 0.6** tracked `AGENTS.md` + this doc (compensates `MDs/`
      being gitignored). — `6d6feb5`
- [x] **Tier 1** re-landed Phase A: `noUncheckedIndexedAccess` (60 sites:
      guards, bounds-proven casts, APP_ICONS non-empty tuple) +
      `assertNever` on the two silent union switches. Conflict with the
      Tier 0.1 tsconfig comment resolved keeping both rationales. — `4a19ea4`
- [x] **Tier 2** IPC bridge contract: `scripts/bridge-table.mjs` (single
      source, 68 methods) + `scripts/gen-bridge.js` (byte-stable
      `preload.js` + generated `docs/ipc-contract.md`) +
      `test/ipc-bridge.test.js` (fail-probed on all four layers: preload
      staleness, doc staleness, registration file mismatch,
      `MemoriesBridge` member drift). Registration evidence comes from
      the main-load harness dump, not greps. — `cdf64a8`
- [x] **Tier 3** shared tokenization spec: `shared/cjk-tokens.ts` +
      `shared/rank-tokens.ts` (four documented variants); all six
      consumers delegate (renderer via `src/lib/cjkTokens.ts` re-export,
      Node side via require(esm) — Electron 43); `test/token-parity.test.ts`
      (fail-probed: re-inlined rune class caught, spec mutation
      propagates everywhere). packaged-files resolver now handles
      `.mjs`/`.cjs`; `build.files` ships `shared/**`.
- [x] **Tier 4** typed seams: `main/context.js` carries the `MainContext`
      typedef for all 67 slots (non-null by contract — load-then-read at
      call time) with `@ts-check` on the file; `shared/worker-messages.ts`
      declares the five worker protocols (`IndexerInbound`/`Outbound` —
      pool + migration preloads — `OcrInbound`/`Outbound`,
      `TranscribeInbound`/`Outbound`, `RankInbound`/`Outbound`);
      `main-lib/assert-never.js` (Node twin) guards the worker dispatch
      tails. `main-lib/rank-worker.js` is fully opted into `@ts-check`
      (zero errors) — fail-probed: a new union variant turns
      `assertNever(msg)` into TS2345. The remaining opt-in ramp
      (`indexer/ocr-worker.js` 40 errors, `indexer/transcribe-worker.js`
      95, `indexer/indexer.js` 96 — protocol annotations + `assertNever`
      calls already in place) was completed as Tier 4b below. — `2f94c33`
- [x] **Tier 4b** all three worker entries opted into `@ts-check` and
      burned down to zero (pragma line 1; no behavior changes; every
      file fail-probed by re-planting a type error):
      `indexer/ocr-worker.js` (40 → 0; `OcrOutbound` wire shape
      corrected to the real words contract `{ text, x, y, w, h }` —
      confidence never crosses the wire) — `469ec7e`;
      `indexer/transcribe-worker.js` (95 → 0; `CodedError` /
      `TranscribeProgress` typedefs, generic `withTimeout`,
      `video-utils` bridged via `typeof import`, `parseWhisperModel`
      gains its real return type, `TranscribeOutbound` gains the
      posted `ffmpeg-spawn`/`ffmpeg-exit` arms) — `4553591`;
      `indexer/indexer.js` (96 → 0; `WeightProgress` aliased to the
      transformers.js `ProgressInfo` union, `TextPair`/`ModelState`
      make the dynamic-interop seam explicit, bounds-proven casts for
      the typed-array math per the rank-search precedent,
      `IndexerOutbound` corrected to the produced wire shape —
      plain `number[]` vectors (the worker `Array.from()`s before
      posting; nulls allowed on video/texts/text-mean arms,
      enrich-progress carries no guaranteed phase) — `ab3e53c`.
      `video-utils.js` gained the JSDoc contracts its checked
      consumers need (`resolveFfmpeg` → `string`, `buildSegmentPlan`
      params/return). All three tails stay on `assertNever`. Docs
      for the corrections ride the commits.
- [x] **Stage A** pipeline no-op: `tsconfig.main.json` (allowJs,
      `checkJs: false`, nodenext, emit-fidelity flags: comments kept,
      `alwaysStrict: false`, `noEmitOnError`) compiles the whole main
      tree 1:1 into `dist-main/` — `main.js`, `main/**`, `main-lib/**`,
      `indexer/**`, `shared/**`, plus `preload.js` +
      `screenshot-probe.js` (both emitted so `__dirname`-relative
      consumers keep working: protocol.js's `join(appDirname,
      "preload.js")`, import.js's `../../screenshot-probe.js`).
      `build:main` = tsc + `scripts/copy-main-assets.js` (runtime assets
      tsc can't emit: `indexer/text-mean/*.json`); `build` = vite +
      `build:main`; `watch:main` for dev iteration. package.json `main`
      → `dist-main/main.js`; `build.files` ships `dist-main/**` only.
      App-root-relative assets (`dist/` renderer bundle, `public/` icons,
      dev smoke scripts) resolve via `app.getAppPath()` — the one new
      `requireDev()` dispatcher in main.js replaces 18 literal requires
      of `scripts/e2e/**` + `test/perf*.js|deep-test|cto-fixes|scene-noise`
      (they are never packaged; pinned by the reworked
      `test/packaged-files.test.js`, fail-probed both ways).
      `pr-subset.sh` now also runs `electron-builder --dir` + a packaged
      asar boot smoke — the real plumbing check. Verified green
      end-to-end (pr-subset exit 0 incl. the packaged boot): the
      packaged app boots from `dist-main/main.js` inside the asar, the
      emitted preload loads, and require(esm) works inside the asar in
      **both** processes — main process (rank-moments → rank-search →
      `shared/*.mjs` at load) and the utilityProcess indexer worker
      (→ memory-embedding-utils → `shared/rank-tokens.ts`, ran to
      model load). Full battery (`smoke-all.sh`): **ALL SMOKES PASSED**
      (35 steps, exit 0) — the smoke dispatch paths (e2e/deep/migrate/
      watched/etc.) all went through `requireDev()` here. — `1a8b91f`
      (PR #2)
- [~] **Spikes** require(esm) from a packaged asar is PROVEN for both
      processes (see Stage A). Still open: an ESM **entry-point** main
      (`"type": "module"` / `app.mjs`) and `utilityProcess` forking an
      `.mjs` worker — needed before Stage C flips.
- [~] **Stage B** incremental `.ts` conversions (CJS emit), leaf-first:
      `main-lib/settings.ts` (PR #4), the four `main-lib` leaves
      (PR #5), the `main-lib/store/*` graph (PR #6), `rank-search`
      (PR #7), `ask/*` (PR #8), `llm/*` (PR #9), `rank-worker` +
      `assert-never` (PR #10), the `main/ipc` leaves — `media` (PR #11),
      `reveal` + `watched` + `chrome-settings` + `previews` (PR #12),
      the `main/ipc/pumps/*` trio — `enrich`, `transcribe`, `ocr`
      (PR #13), `rank-moments` + `versions` (PR #14), `pool` +
      `migration` (PR #15), `protocol` + `chrome` (PR #16), `youtube` +
      `llm-ask` (PR #17), `import` (PR #18), `context` + `ipc-wrapper` +
      `screenshot-probe` (PR #19), `main.ts` (PR #20), the indexer
      leaves + the library-store facade (PR #21) — landed; the flow is
      settled in the playbook below. **The main side is fully
      TypeScript**: every `main/ipc` domain, the typed MainContext
      interface, the boot file (whose harness runs the compiled
      dist-main/main.js), and the whole store/facade layer. indexer/:
      the leaves (PR #21), `video-utils` (PR #22),
      `transcript-store-utils` (PR #23), `transcribe-worker` (PR #24),
      `ocr-worker` (PR #25), `build-memory-embeddings-core` (PR #26),
      and `indexer` (PR #27) are typed. **Stage B is COMPLETE — every
      first-party file is TypeScript** (or the deliberate `shared/*.mjs`
      / `preload.js` exceptions). Stage C is also DONE and battery-
      validated: the lazy-require audit hoisted the node:builtin
      requires, the 13 deliberate lazy requires carry inline disables
      with reasons, `@typescript-eslint/no-require-imports` is re-armed
      as an error for the converted trees, and the full battery PASSED
      again post-Stage-C (all 39 steps, all 16 electron exits 0).
      Stage D is also DONE: `shared/cjk-tokens.ts`, `rank-tokens.ts`,
      and `worker-messages.ts` replaced the `.mjs` files (JSDoc →
      native types, `worker-messages` typedefs → real `export type`
      unions); consumers import the `.ts` specifiers, the dist-main
      mirror emits their CJS, and Vite bundles the sources for the
      renderer — token-parity + cjk suites green, emit smokes PASS.
- [ ] **Stage C** ESM per module group.
- [x] **Stage D** cleanup: the optional `shared/*.mjs` → `.ts` flips.
      (The plan's "allowJs off" item is void by design — `preload.js`
      stays single-file CJS; `main/pumps/` is already gone.)

## Stage B playbook (COMPLETE — landed: `main-lib/settings.ts`, the four `main-lib` leaves, `main-lib/store/*`, `rank-search`, `ask/*`, `llm/*`, `rank-worker`/`assert-never`, the `main/ipc` leaves, the `main/ipc/pumps/*` trio, `rank-moments` + `versions`, `pool` + `migration`, `protocol` + `chrome`, `youtube` + `llm-ask`, `import`, `context` + `ipc-wrapper` + `screenshot-probe`, `main.ts`, the indexer leaves + the library-store facade, `video-utils`, `transcript-store-utils`, `transcribe-worker`, `ocr-worker`, `build-memory-embeddings-core`, `indexer`; PRs #4–#27)

One directory per conversion PR, leaf-first (plan §9 has the order:
`main-lib` leaves → `main/ipc` leaves → heavy handlers → `main.js` +
`screenshot-probe.js` → `indexer/` worker-by-worker). Per PR:

1. `git mv x.js x.ts`; `require`/`module.exports` → native `import`/`export`;
   JSDoc types → native types where they simplify. **Specifier rule
   (settled empirically on the first conversion):** imports of
   *unconverted* siblings keep their `.js` specifier; imports of
   *converted* siblings use an explicit `.ts` specifier. Node's ESM
   resolver has no `.js`→`.ts` fallback, so a `.js` specifier pointing at
   a `.ts` target dies inside `require(esm)` — `.ts` specifiers resolve
   literally under node and bun, and `rewriteRelativeImportExtensions`
   (both tsconfigs) emits them back to `.js` in `dist-main/`. Every
   top-level require becomes an import; **deliberately-lazy `require()`**
   (optional deps, require-cycle breaks like settings.ts →
   video-utils) stays as-is — the harness never executes those bodies,
   bun provides `require` in ESM modules, and production runs the
   emitted CJS. `eslint.config.js` pre-disables `no-require-imports` for
   the converted main trees (re-armed in Stage C).
2. `tsc` strict-checks the file from that moment (it is in the program).
3. Verify: `bunx tsc --noEmit` + `bun run lint` + `bun test test/` +
   `bash scripts/pr-subset.sh`; the main-load harness for wiring edits.

Flow facts (all verified, first conversion PR):

- **Unit scripts run under bun.** `bun` maps `.js` specifiers to the
  `.ts` sibling when the `.js` is absent (verified for `require`, ESM
  `import`, `bun test`, `bun run <script>`; bun 1.3.x, exit codes
  propagate) — all `test:*` unit scripts now run `bun run`. Only
  `test:main-load` / `test:ipc-bridge` stay plain `node` (the harness
  patches `Module._load` for the electron stub).
- **The main-load harness remaps `.js`→`.ts` in its `_load` patch** and
  keeps loading the SOURCE `main.js` (a `.js` specifier never probes the
  `.ts` sibling under real node — the harness is the remaining
  node-source consumer). It moves to the compiled `dist-main/main.js`
  when `main.js` itself converts.
- **Tests that read source files as text follow the extension** (grep
  with `.ts`); `test/ocr-cjk.test.js` / `test/whisper-model.test.js`
  updated for settings.ts, whisper-model/transcript-fusion for
  store/sidecars.ts, ask-retrieve for ask/retrieve.ts; the pumps batch
  moved the pump readers (`whisper-model`, `dialogue-exact`,
  `transcript-fusion`, `ocr-cjk` — the latter two also via
  `path.join(..., "ocr.ts")`-style split reads) and flushed stale
  `main/ipc/media.js` reads left over from the PR #11 conversion.
- **The packaged-files test learned both shapes**: the walk now scans
  `require(...)`, `import "…"`, and `from "…"` specifiers (multiline
  imports included), includes `.ts` files in the source set, and maps a
  `.js` specifier to its `.ts` source twin (shipped path stays the
  specifier's `.js`; `.ts` specifiers map to the emitted `.js` and are
  themselves known extensions — a `.ts` specifier must NOT get `.js`
  appended).
- **First converted→converted graph: `main-lib/store/*`** — five
  modules with deliberate cycles (all sibling access is call-time, so
  ESM cycles stay safe under both `require(esm)` and the CJS emit;
  graph siblings import as namespace imports to keep the call-time
  style). Findings from that batch: typed `export let` path vars keep
  live bindings in the CJS emit (verified under plain node); typing the
  in-memory `Library` forced checked-JS consumers (`rank-search.js`'s
  `RankLibrary` typedef) to align at tsc time; evolving-`any` locals
  (`let x;` assigned in try/catch, read in a later closure) keep
  working under the repo's strict flags; typed-array reads under
  `noUncheckedIndexedAccess` need bounds-proven casts or hoisted
  header reads.
- **`rank-search.ts` is the first node-side `.ts` importing
  `shared/*.mjs`**: under `module: nodenext` on TS 5.9 the `import`
  emits the same `require(esm)` call the CJS source used, so runtime
  resolution is unchanged (verified in the emitted smoke).
- **Calls into still-unchecked JS get inferred-default types**:
  `exactDialogueSearch` (`indexer/transcript-store-utils.js`) defaults
  `docs = []` / `segVideos = null`, so tsc infers `never[]` / `null`
  for those params — callers cast to the inferred shapes (see
  `main-lib/ask/retrieve.ts`). The casts drop out when that file
  converts; don't loosen the callee to "fix" them.
- **`llm/*` landed the first converted→converted edge into
  `settings.ts`** and the first `child_process` module: `id` params
  that resolve through `resolveLlmModelId` are typed `unknown` (the
  resolver validates + falls back), and the child-process state uses a
  `ChildProcess | null` slot with the first child captured before the
  nullable reassignment — closure reads lose assignment narrowings, so
  the exit race keeps a non-null alias.
- **`rank-worker`/`assert-never` carried the utilityProcess tree**:
  message types come from `shared/worker-messages.ts`
  (`RankInbound`/`RankOutbound`), `assertNever`'s `never` param makes
  the trailing dispatch branch the exhaustiveness guard, and the
  `__dirname`-relative fork in `rank-moments.ts` keeps resolving the
  emitted `dist-main/main-lib/rank-worker.js`.
- **The four remaining `main/ipc` leaves** (reveal, watched,
  chrome-settings, previews) added two harness facts: converted ESM
  files' `import … from "electron"` bypasses the `Module._load` stub
  (node's ESM resolver reaches the real npm package, a path string),
  so `main-load-harness.js` registers in-process `Module.registerHooks`
  resolve/load hooks mapping the bare specifier to a generated
  re-export module over the same stub object; and an `unknown`-typed
  parameter LOSES its earlier `typeof` narrowing after a reassignment
  (`dir = path.resolve(dir)` resets the flow type to the declared
  `unknown`) — keep a fresh local after the guards. Also: the
  `ctx.importPaths` typedef gained its `{ fromWatch }` options arg
  (watched was the only caller), and in-place-mutated `let` arrays
  become `const` under prefer-const after conversion — stable-identity
  mutation is the design, nothing else changes.
- **The first `main/ipc` leaf (`media.ts`) surfaced the node-ESM
  interop seams** — converted `.ts` files load as **ESM** under node's
  type stripping, so (a) node's `cjs-module-lexer` reads only the
  FIRST key of an aliased object-literal export
  (`module.exports = { a: x.y }` — the rest silently never become
  named exports); the `library-store.js` facade was rewritten to
  per-name `exports.*` assignments (always detected, same 49 exports);
  (b) ESM stack frames report `file://` URLs, so `callerFile()` in
  `main-load-harness.js` now normalizes them before the path checks
  (bridge attribution went to `null` otherwise). Handler callbacks in
  converted `main/ipc` files annotate IPC args as `unknown` (the
  `ipc-wrapper` is untyped passthrough) and validate as before; and
  evolving-`any` exports from still-unchecked pumps need JSDoc element
  types to cross a checked boundary (`enrichQueue`/`transcribeQueue`).
- **The `main/ipc/pumps/*` trio** (enrich, transcribe, ocr) closed the
  queue layer. Findings: the `MainContext` typedef was missing a slot
  `main.js` has assigned since Phase 1 (`isEnrichPendingQuery`) — tsc
  surfaced it from the converted consumer, `context.js` now documents
  it; `UtilityProcess.kill()` takes NO signal argument (the old
  `"SIGKILL"` string was inert — electron's documented SIGTERM + reap
  is what always ran); electron's utilityProcess `exit` event passes
  `code` only, so the listener keeps an optional `signal` param purely
  to preserve the old (always-`undefined`) shape; pending-request maps
  type `resolve`/`reject` as `unknown` and the askTranscribe reply is
  cast once at its call site (the `askPrimaryIndexer` union has no
  shared index signature); `noUncheckedIndexedAccess` loop reads
  followed the `l.filenames[i] as string` precedent (rank-search,
  model-state), and element reads behind `typeof` guards hoist to a
  local first (`l.ocr[i]` does not narrow — the index is a mutable
  loop variable). The JSDoc element types added for `media.ts`
  (PR #11) became real interfaces in the pumps.
- **`rank-moments` + `versions`** closed the ranking/versions pair.
  Findings: `migration.js` self-assigns `ctx.getMigrationState` /
  `ctx.getWorkerModelId` at load — smoke scripts must assign controlled
  stubs AFTER the requires (the modules read slots at call time, so
  post-load assignment wins); tsc does not carry `arr[0]?.x` narrowing
  into the following statement (queue-head reads hoist to locals) nor a
  fresh call's result from an earlier guard (the repeated
  `getTranscribeWorker()` calls in the ffmpeg-kill path hoist to one);
  rebroadcasting the pump snapshots forced the enrich/transcribe
  broadcast params' `filename` to widen to `string | null` (ocr already
  allowed it); and the three `settings.js` requires merged into one
  import (packaged-files count 219 → 217, exactly the two duplicates).
- **`pool` + `migration`** closed the worker-pool core. Findings: the
  worker-message listener casts once to `IndexerOutbound & { id?, ok?,
  error? }` — broadcast members lack the envelope props, but the
  listener handles every shape and resolves pending asks on the tagged
  ones; the union types `init-done`'s `ok` as literal `true` (failures
  ride the request type `"init"`), so pool's defensive ok:false branch
  needs a widened ok read or it collapses to `never`; a mid-file
  require of a module that never requires the importer back (migration
  ↔ pool) hoists to a top ESM import with no observable load-order
  change; module-let reads inside pump closures hoist behind invariant
  comments (tsc cannot narrow a module let across a closure boundary);
  `new Error(msg, { cause })` sets cause post-construction (the ROOT
  tsconfig lib is ES2020 while tsconfig.main is ES2022 — `bunx tsc
  --noEmit` checks under the root); and `context.js`'s `getWorkerModelId`
  slot widened to `() => string | null` (the second typedef fix after
  `isEnrichPendingQuery` — unchecked JS hid the drift both times).
- **`protocol` + `chrome`** closed the window/protocol layer. Findings:
  stale ctx typedefs surface the moment a checked consumer arrives —
  `ensurePreview`'s result discriminates now (every previews.ts return
  site already complied), and `imageContentType`'s slot claimed
  `(file: string)` while the real mime-sniff signature takes the
  `{ sniffed, extMime }` object; the DOM/node type frictions (stream/web
  vs DOM ReadableStream, Buffer vs BufferSource, createReadStream's null
  path) each cast once at their single point with a runtime-identity
  comment; module handles that live in closures (tray listeners) hoist
  to a local at creation; and the line-by-line rename diff is not
  ceremony — it caught the thumbnail single-flight's `.finally(delete)`
  dropped during a promise-chain restructure (a failed generation would
  have cached forever).
- **`youtube` + `llm-ask`** closed the agent/ask domains. Findings: the
  unchecked youtube-lib's config/meta surfaces infer as `{}` from its
  literal returns — checked call sites annotate `any` (the lib
  re-validates every field); the CJS `{ member: alias } = require()`
  destructure renames become `member as alias` imports (the `:`
  syntax is a SyntaxError in import statements); an event parameter a
  handler actually reads (`event.sender`) annotates
  `Electron.IpcMainInvokeEvent` while unread ones stay `unknown`; and
  two cheap drift checks catch what the eye skips — a string-literal
  diff (specifiers, `node:` prefixes, `use strict`, cast-embedded
  messages — and it caught one dropped comment block) and a
  control-flow-keyword count (if/for/catch/return/await must match
  HEAD exactly).
- **`import`** completed the main/ipc layer. Findings: a top-level
  `require()` in a converted file dies under the ESM harness (only
  *lazy* requires survive — the harness never executes those bodies) —
  the crypto require became a `node:crypto` import with its original
  comment intact; a discriminated outcome union + an annotated result
  shape fix the empty-literal `never[]` inference; a required field on
  the ask-site cast (`vec`) keeps the runtime guard honest; and the
  smoke for this domain documented three real behaviors the assertions
  initially got wrong — the batch-fixed hash set (same-content files
  in one batch BOTH import), scan-time pre-filtering of unsupported
  extensions (the error path only fires for directly-passed paths),
  and auto-watch dedup (watched rides only NEWLY watched folders).
- **`context` + `ipc-wrapper` + `screenshot-probe`** made the typed
  surface live. Findings: the JSDoc typedef converts to a real
  interface mechanically, but the SEAM it exposes is behavioral —
  main.js mutates the context object it requires, and a converted
  module's ESM namespace (and the emitted CJS `exports` wrapper) is
  frozen; the fix is `.default` on the require (the mutable holder in
  both worlds). The ipc-wrapper passthrough types its handler
  `(...args: any[]) => unknown` — `never[]` (the every-caller shape)
  is CONTRAvariant-wrong here because ipcMain invokes with
  `(event, ...args)`. The harness's callerFile skip and packaged-files'
  prod list went extensionless/.ts for the converted helpers.
- **`main.ts`** (the boot file) closed the main side with ONE
  deliberate exception to the import rule: the main/ipc domain
  requires stay `require()` calls at their exact pre-conversion
  positions — watched.ts and protocol.ts read VALUE context slots in
  top-level initializers, and hoisted ESM imports would race the
  assignments that must land first. The emitted CJS keeps the order
  1:1, and the main-load harness switched to running the compiled
  dist-main/main.js (which is also what dev/packaged Electron loads) —
  the source main.ts is never executed, so the positional requires are
  load-order-critical only in the emit. tsconfig.main.json is STRICTER
  than the root tsc — run `build:main` as a gate too (six casts: loop-
  guarded index reads, the capture-group regex matches, and node's
  guarded index reads, the capture-group regex matches, and node's
  widened `process.exitCode`).
- **The indexer leaves + the facade** made the typed-models surface
  ripple the day it landed: an unchecked consumer's implicit
  assumptions surface as real type errors the moment the callee is
  typed (indexer.js's worker-model null assumption, pool.ts's
  `getModel(...) || {}` fallback shapes, index-core's default-model
  fallback). Absorb them at the CONSUMER with a rationale comment —
  never by widening the typed callee. The facade's per-name CJS
  exports became grouped ESM re-exports; TS's emit
  (`Object.defineProperty` getters) stays cjs-module-lexer
  compatible, so the remaining CJS consumers keep named imports. And
  the emit-vs-source specifier rule bit once: LAZY `require()`
  specifiers must stay `.js` (require strings are not rewritten in
  the emit), while `import` specifiers flip freely.
- **The post-conversion battery** (all 39 steps green, real models)
  surfaced two classes the per-suite gates cannot see, both fixed:
  (1) test drivers and source-scans requiring SOURCE indexer modules
  by their old .js paths — node's TS fallback loads them as ESM where
  lazy `require()` is unavailable (resolveFfmpeg's ffmpeg-static probe
  swallowed the ReferenceError → "No ffmpeg binary available"), fixed
  by requiring the COMPILED dist-main mirrors (the main-load-harness
  precedent); (2) quit-drain exit races — the OCR worker kill and the
  native-session teardown polluted process.exitCode AFTER a suite's
  assertions all passed. smoke-all.sh now logs per-step electron exit
  codes (`[exit N] $step`), and the two races pin their outcomes
  (the ask branch's quitSmoke(0|1), indexer.ts's `process.exitCode =
  0` at its success line). The grid fixture also gained its modelId +
  per-model bin names (a model-less index is a "legacy library" by
  loadLibrary's contract — the retirement race hit the smoke's quit).
- **`smoke:indexer`** (`node indexer/indexer.js --smoke`) moves to the
  emitted `dist-main/indexer/indexer.js` once `indexer/` converts —
  nothing in the indexer require graph touches converted files yet.
- **`node:fs`-style builtins import as `import fs from "node:fs"`**;
  diagnostics casts use the Tier-4b shape (`err as { message?: string }
  | null` then `e && e.message`). The source drops the `"use strict"`
  prologue: ES modules are strict by definition and tsc emits the
  prologue into the CJS output for module files automatically
  (verified — `alwaysStrict: false` does not remove it for modules).

## Known issues / operational notes

- GitHub Actions is currently failing **before any step** with a billing
  error ("recent account payments have failed or your spending limit
  needs to be increased") — every run for at least a week. No CI
  feedback exists until this is fixed; treat local gates as truth.
- The full battery (`scripts/smoke-all.sh`) takes ~2 h and needs model
  weights; the PR subset is the everyday Electron check.
- `preload.js` and `docs/ipc-contract.md` are generated from
  `scripts/bridge-table.mjs` — never hand-edit them.

## Verification (every change)

```bash
bunx tsc --noEmit && bun run lint && bun run format:check
bun test test/
bun run test:main-load && bun run test:ipc-bridge && bun run test:token-parity
bun run test:packaged-files
bash scripts/pr-subset.sh        # when main-process wiring changed
```

See `AGENTS.md` for traps (load-order law, IPC seam, shared tokenization
spec, packaged-files extension rule, smoke isolation).
