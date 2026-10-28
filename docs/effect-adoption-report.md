# Recommendation

**Effect is a good fit for some of SCM’s main-process orchestration, but I would not make it the project-wide standard or begin a broad rewrite now.** Keep the current architecture as the default. If you want to evaluate Effect, run a small pilot around the local LLM chat request and streaming path, while preserving its Promise and IPC contracts.

SCM has real problems Effect is designed to help with: cancellation, retries, bounded concurrency, resource cleanup, and background work that must stop cleanly. It also already has carefully built solutions to those problems. A wholesale migration would replace a tested set of SCM-specific state machines with a second programming model, while leaving much of the most consequential process and persistence work custom.

## How the codebase is structured

SCM is an Electron app with three distinct runtimes:

- The Electron main process owns startup, IPC handlers, persistence, imports, watched folders, and application shutdown. The shipped entry point is the compiled `dist-main/main.js`; the build mirrors the main-process source into that directory. See [package.json](../package.json#L8) and [tsconfig.main.json](../tsconfig.main.json#L17).
- The React renderer uses Zustand stores and hooks for search, settings, progress, and UI state. It talks to the main process through the preload bridge.
- Utility processes run the heavy work: vision embeddings and video scenes, OCR, transcription, and ranking. They communicate through message protocols defined in [worker-messages.ts](../shared/worker-messages.ts#L1).

The product’s background work is substantial: local model loading and downloads, imports, watched-folder sync, OCR and scene backfills, video transcription, model migrations, thumbnail and preview generation, and an optional local LLM sidecar. The main process coordinates these jobs while keeping interactive search responsive.

There is already a strict IPC boundary. Channels are generated from a bridge table, the preload exposes a typed `MemoriesBridge`, and worker messages are discriminated unions with exhaustive dispatch checks. An Effect value cannot cross those process boundaries; callers would need to convert successes, failures, progress, and cancellation back into the existing plain messages and return shapes.

## Where SCM already has strong lifecycle handling

Several parts of the code show that this app’s reliability needs are specific and well understood:

- The main process owns many event-driven services through a typed shared context. Its load-order rules exist because early module reads and import cycles have caused boot failures before. See [main/context.ts](../main/context.ts#L1).
- The indexer pool assigns request IDs, times out requests, detects worker exits, and restarts a wedged worker. Enrichment is pinned to the primary worker because it holds cached video plans. See [pool.ts](../main/ipc/pool.ts#L344) and [pool.ts](../main/ipc/pool.ts#L627).
- OCR, enrichment, and transcription have separate queues and gates. They yield to queries, respect pause/import/migration state, and apply their own retry and watchdog rules. Transcription can restart a stalled worker and skip a poisoned slice; scene enrichment can resume at its previous offset.
- Model migration is checkpointed. It can reuse existing vectors, flip the active model, fill missing rows in the background, and resume incomplete work after a restart. See [migration.ts](../main/ipc/migration.ts#L252) and [migration.ts](../main/ipc/migration.ts#L636).
- Library writes use a serialized queue and atomic temp-file, fsync, and rename operations. Those ordering and durability guarantees are part of the data format’s safety, not generic async plumbing. See [persist.ts](../main-lib/store/persist.ts#L14).
- Main-process child processes are tracked from spawn time and killed during shutdown. Workers also report ffmpeg PIDs so those grandchildren can be killed if the worker exits. See [child-registry.ts](../main-lib/child-registry.ts#L37).
- Shutdown has deliberate ordering: stop save sources, kill workers and child processes, drain the persistence queue with a cap, sweep children again, then quit. See [main.ts](../main.ts#L2056).

This is not a project that lacks orchestration discipline. The opportunity is to reduce the amount of custom coordination code while preserving the domain-specific rules above.

## Fit by area

| Area | Effect fit | Assessment |
|---|---:|---|
| Main-process async orchestration | High | Typed failures, scoped cleanup, interruption, and bounded concurrency could help. |
| LLM request and stream handling | High | A contained pilot can exercise cancellation, timeouts, streaming, and error mapping. |
| Worker pool and utility-process protocols | Medium to low | Effect may help inside a worker, but Electron’s `utilityProcess`, request IDs, progress broadcasts, and restart policy still need adapters. |
| Persistence and model migration | Low to medium | Effect can describe the workflow, but it does not replace SCM’s atomic writes, checkpoints, row identity rules, or recovery behavior. |
| Renderer and Zustand state | Low | React and Zustand already fit the UI. Effect would add another state and lifecycle model without a clear gain. |
| Pure ranking, tokenization, and vector math | Low | These modules are already testable pure logic; Effect would add little. |

Effect’s documented strengths line up with SCM’s orchestration needs: typed errors, structured concurrency, resource safety, dependency injection, observability, and streams. Its guidance also recommends running effects near the edges of the application, which suits a gradual adapter around an existing Promise API. [Effect overview](https://effect.website/docs/v4/onboarding), [Running Effects](https://effect.website/docs/v4/getting-started/running-effects)

## Best pilot: LLM chat streaming

The narrowest useful trial is the request and streaming portion of [server.ts](../main-lib/llm/server.ts#L1042), called from the Ask handler in [llm-ask.ts](../main/ipc/llm-ask.ts#L183).

That path combines several concerns Effect handles well:

- Chat calls are serialized so a failed request does not poison later calls.
- Requests have timeouts and connect to an outer `AbortSignal`.
- Streaming SSE data produces token callbacks and partial results.
- User Stop must preserve partial text.
- A stream failure gets one non-streaming retry, unless the user explicitly stopped.

For a pilot, keep the sidecar process lifecycle, `trackChild`, and existing IPC behavior unchanged. Express one chat attempt and its stream consumption as an Effect, then run it at the `llmChat` boundary and map its outcome back to the existing `Promise<ChatResult>`. The pilot succeeds only if cancellation and error flow become easier to understand while preserving the existing behavior. If the Effect version needs as much glue as the current path, stop there.

Effect fibers support interruption and cleanup, but interruption alone does not replace SCM’s worker-kill strategy for native inference that cannot be cancelled cooperatively. The transcription and enrichment workers may still need to be killed and restarted to recover from stalled native work. [Effect concurrency and interruption](https://effect.website/docs/v4/concurrency/basic-concurrency)

## Adoption costs and constraints

**TypeScript compatibility is close, with one small range issue.** The project’s lockfile has TypeScript 5.9.3, while `package.json` declares `^5.5.3`. Effect v4’s installation guide requires TypeScript 5.9 or newer, so the current lock satisfies the requirement; if adopted, raise the declared minimum to 5.9 so the guarantee is explicit. SCM already uses `strict`; Effect Schema documents `exactOptionalPropertyTypes` as optional, and SCM has explicitly chosen not to enable it because of renderer prop churn. [Effect installation requirements](https://effect.website/docs/v4/getting-started/installation), [Effect Schema requirements](https://effect.website/docs/v4/schema/introduction)

**Electron lifecycle integration remains SCM’s job.** SCM’s utility workers are Electron `utilityProcess` instances. Effect’s documented Node worker adapter covers `worker_threads` and IPC-enabled Node child processes; it does not document an Electron `utilityProcess` adapter. A custom integration would still be needed for worker messages, exits, PID tracking, and app shutdown. The Effect v4 `ChildProcess` and `NodeWorker` APIs are also marked unstable in their references, so I would not base SCM’s critical process cleanup on them in the initial trial. [NodeWorker API](https://effect.website/docs/v4/api/platform-node/NodeWorker), [ChildProcess API](https://effect.website/docs/v4/api/effect/process/ChildProcess)

**The project’s module and packaging setup needs an explicit check.** Main-process TypeScript is emitted into the shipped `dist-main` mirror, and Electron Builder packages the runtime dependencies. Any pilot must verify that Effect imports work through this compiled path and in the packaged app. The existing main-load and packaged-files checks are relevant gates; the generated preload and IPC contract should remain plain serializable types.

**Effect only pays off when it shapes the workflow.** Wrapping each existing async function in `Effect.tryPromise` and immediately calling `Effect.runPromise` would mostly add ceremony. Typed errors help when they are allowed to propagate through the Effect program; SCM often deliberately catches failures and converts them into a status event, warning, or `{ ok: false }` response. Those mappings still need to be designed.

## Decision

Keep the renderer, numerical and ranking code, worker message protocols, and persistence layer in their current style. Consider Effect for new or materially reworked main-process workflows where cancellation, scoped cleanup, and retries are central. The Ask chat request path is a good test of that value.

I made no code changes and did not run tests. The repo has 61 test files, including targeted suites for Ask, worker pumps, persistence, and packaged-file coverage; those should be used to evaluate a future pilot.
