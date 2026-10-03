"use strict";

// Ask sidecar lifecycle (MDs/Ask-Mode-Plan.md) against a STUB executable —
// no llama.cpp, no network beyond loopback, no model download in CI. Covers:
// health-poll readiness, chat round trip with <think> stripping, the
// unknown-flag retry (older llama.cpp builds reject --reasoning-budget),
// hard-failure surfacing via the stderr tail, and stop semantics.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
	initLlmServer,
	ensureServer,
	llmChat,
	stopServer,
	llmServerSnapshot,
	stripThink,
	createThinkStripper,
	parseSseLine,
	normalizeLlmTimings,
	downloadModel,
	binaryDownloaded,
} = require("../main-lib/llm/server.js");

function check(name, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => console.log(`ok - ${name}`))
		.catch((err) => {
			console.error(`FAIL - ${name}`);
			console.error(err && err.stack ? err.stack : err);
			process.exitCode = 1;
		});
}

const STUB_JS = `
const http = require("http");
const fs = require("fs");
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 0;
if (process.env.STUB_ARGV_FILE) {
  fs.appendFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(args) + "\\n");
}
if (process.env.STUB_REJECT_FLAG && args.includes("--reasoning-budget")) {
  process.stderr.write("error: invalid argument '--reasoning-budget'\\n");
  process.exit(1);
}
if (process.env.STUB_FAIL) {
  process.stderr.write("boom " + process.env.STUB_FAIL + "\\n");
  process.exit(2);
}
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }
  if (req.url.startsWith("/v1/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let wantStream = false;
      try { wantStream = JSON.parse(body).stream === true; } catch {}
      const answer = process.env.STUB_ANSWER || "<think>internal doubt</think>The answer is [1].";
      if (!wantStream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{
            message: { content: answer },
            finish_reason: "stop",
          }],
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (process.env.STUB_HANG) {
        // Never ends: the client abort is the test.
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "partial " } }] }) + "\\n\\n");
        return;
      }
      // SSE in small slices (exercises the client's line reassembly),
      // then a finish-reason frame and [DONE].
      const frames = [];
      for (let i = 0; i < answer.length; i += 5) {
        frames.push("data: " + JSON.stringify({ choices: [{ delta: { content: answer.slice(i, i + 5) } }] }));
      }
      frames.push("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], timings: { prompt_n: 42, prompt_ms: 200, predicted_n: 9, predicted_ms: 300 } }));
      frames.push("data: [DONE]");
      const payload = frames.join("\\n\\n") + "\\n\\n";
      for (let i = 0; i < payload.length; i += 7) {
        res.write(payload.slice(i, i + 7));
      }
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1", () => {});
process.on("SIGTERM", () => process.exit(0));
`;

// A stub "binary": the shell wrapper lets spawn exec it directly, exactly
// like the real llama-server path.
function writeStub(dir) {
	const stubJs = path.join(dir, "stub-server.js");
	fs.writeFileSync(stubJs, STUB_JS);
	const bin = path.join(dir, "llama-server-stub");
	fs.writeFileSync(bin, `#!/bin/sh\nexec node "${stubJs}" "$@"\n`);
	fs.chmodSync(bin, 0o755);
	return bin;
}

function init() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-ask-server-"));
	const bin = writeStub(dir);
	const model = path.join(dir, "fake.gguf");
	fs.writeFileSync(model, "gguf-bytes");
	const argvFile = path.join(dir, "argv.log");
	initLlmServer({
		userDataDir: dir,
		broadcast: () => {},
		binaryPath: bin,
		modelPath: model,
	});
	return { dir, bin, model, argvFile };
}

async function main() {
	await check("stripThink removes reasoning preambles", () => {
		assert.equal(stripThink("<think>hm</think>Answer"), "Answer");
		assert.equal(stripThink("<think>a</think>x<think>b</think>y"), "y");
		assert.equal(stripThink("plain"), "plain");
		assert.equal(stripThink(""), "");
	});

	await check("createThinkStripper holds partial tags mid-stream", () => {
		// Plain text flows straight through.
		const s1 = createThinkStripper();
		assert.equal(s1.push("Hello "), "Hello ");
		assert.equal(s1.push("world"), "world");
		assert.equal(s1.flush(), "");
		// A forming tag tail is held, not leaked, then dropped with its body.
		const s2 = createThinkStripper();
		assert.equal(s2.push("a <th"), "a ");
		assert.equal(s2.push("ink>hidden</think>b"), "b");
		assert.equal(s2.flush(), "");
		// A whole block at once releases only the answer (pre-tag kept —
		// the streaming path keeps output where stripThink drops it).
		const s3 = createThinkStripper();
		assert.equal(s3.push("Sure <think>x</think>Answer"), "Sure Answer");
		// A never-closed tail flushes as-is at end of stream.
		const s4 = createThinkStripper();
		assert.equal(s4.push("<think>oops"), "");
		assert.equal(s4.flush(), "<think>oops");
		// After the close, everything flows raw (second blocks included).
		const s5 = createThinkStripper();
		assert.equal(s5.push("<think>a</think>ok <think>again"), "ok <think>again");
	});

	await check("parseSseLine tolerates the llama-server dialect", () => {
		const delta = parseSseLine(
			'data: {"choices":[{"delta":{"content":"Hello"}}]}',
		);
		assert.equal(delta && delta.delta, "Hello");
		assert.deepEqual(parseSseLine("data: [DONE]"), { done: true });
		assert.equal(parseSseLine(""), null);
		assert.equal(parseSseLine(": comment"), null);
		assert.equal(parseSseLine("data: {broken"), null);
		const fin = parseSseLine(
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
		);
		assert.equal(fin && fin.finishReason, "stop");
		assert.equal(fin && fin.delta, undefined);
		// The final frame's server timings ride along when present.
		const timed = parseSseLine(
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"timings":{"prompt_n":18,"prompt_ms":120,"predicted_n":6,"predicted_ms":150}}',
		);
		assert.deepEqual(timed && timed.timings, {
			prompt_n: 18,
			prompt_ms: 120,
			predicted_n: 6,
			predicted_ms: 150,
		});
	});

	await check("normalizeLlmTimings keeps numbers-only timings", () => {
		assert.deepEqual(
			normalizeLlmTimings({ prompt_n: 18, predicted_n: 6, predicted_ms: 150 }),
			{ promptTokens: 18, predictedTokens: 6, predictedMs: 150 },
		);
		assert.equal(normalizeLlmTimings(null), null);
		assert.equal(normalizeLlmTimings({}), null);
		assert.equal(normalizeLlmTimings({ prompt_n: 18 }), null);
		assert.equal(
			normalizeLlmTimings({ prompt_n: "18", predicted_n: "6" }).promptTokens,
			18,
		);
	});

	await check(
		"ensureServer + llmChat round trip through the stub",
		async () => {
			const ctx = init();
			try {
				const port = await ensureServer("qwen3-1.7b-q4km");
				assert.ok(Number.isInteger(port) && port > 0);
				const reply = await llmChat({
					messages: [{ role: "user", content: "q" }],
					modelId: "qwen3-1.7b-q4km",
				});
				assert.equal(reply.content, "The answer is [1].");
				assert.equal(reply.stopReason, "stop");
				// A second call reuses the SAME process (same port, no respawn).
				const port2 = await ensureServer("qwen3-1.7b-q4km");
				assert.equal(port2, port);
			} finally {
				stopServer("test");
				fs.rmSync(ctx.dir, { recursive: true, force: true });
			}
		},
	);

	await check(
		"switching models respawns instead of leaking the old proc",
		async () => {
			// Regression for the Settings model switch: ensureServer(newId) must
			// stop the resident server first — otherwise the old child is
			// overwritten in server.proc/port and leaks (orphaned llama-server +
			// bound port + resident weights). The stub binary stands in for both
			// models (modelPath override), so any port change is the respawn.
			const registry = require("../main-lib/llm/models.js");
			const ids = Object.keys(registry.LLM_MODELS);
			assert.ok(ids.length >= 2, "registry needs two models for the switch");
			const ctx = init();
			try {
				const first = await ensureServer(ids[0]);
				assert.ok(Number.isInteger(first) && first > 0);
				assert.equal(llmServerSnapshot().modelId, ids[0]);
				const second = await ensureServer(ids[1]);
				assert.ok(Number.isInteger(second) && second > 0);
				assert.notEqual(
					second,
					first,
					`model switch must respawn (same port ${first} = leaked old proc)`,
				);
				assert.equal(llmServerSnapshot().modelId, ids[1]);
				// Same model after the switch reuses (no respawn churn).
				assert.equal(await ensureServer(ids[1]), second);
				// The new server answers.
				const reply = await llmChat({
					messages: [{ role: "user", content: "q" }],
					modelId: ids[1],
				});
				assert.equal(reply.content, "The answer is [1].");
			} finally {
				stopServer("test");
				fs.rmSync(ctx.dir, { recursive: true, force: true });
			}
		},
	);

	await check(
		"unknown --reasoning-budget retries once without the flag",
		async () => {
			const ctx = init();
			process.env.STUB_REJECT_FLAG = "1";
			process.env.STUB_ARGV_FILE = ctx.argvFile;
			try {
				const port = await ensureServer("qwen3-1.7b-q4km");
				assert.ok(port > 0);
				const launches = fs
					.readFileSync(ctx.argvFile, "utf-8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l));
				assert.equal(launches.length, 2, "two launches");
				assert.ok(launches[0].includes("--reasoning-budget"));
				assert.ok(
					!launches[1].includes("--reasoning-budget"),
					"retry drops the flag",
				);
			} finally {
				delete process.env.STUB_REJECT_FLAG;
				delete process.env.STUB_ARGV_FILE;
				stopServer("test");
				fs.rmSync(ctx.dir, { recursive: true, force: true });
			}
		},
	);

	await check("a hard spawn failure surfaces the stderr tail", async () => {
		const ctx = init();
		process.env.STUB_FAIL = "loudly";
		try {
			await assert.rejects(
				() => ensureServer("qwen3-1.7b-q4km"),
				/boom loudly/,
			);
		} finally {
			delete process.env.STUB_FAIL;
			stopServer("test");
			fs.rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	await check(
		"streaming chat forwards cleaned deltas then resolves",
		async () => {
			const ctx = init();
			try {
				await ensureServer("qwen3-1.7b-q4km");
				const deltas = [];
				const reply = await llmChat({
					messages: [{ role: "user", content: "q" }],
					modelId: "qwen3-1.7b-q4km",
					stream: true,
					onToken: (d) => deltas.push(d),
				});
				// The stub answer is "<think>internal doubt</think>The answer is
				// [1]." in 5-char SSE slices: deltas arrive cleaned and joined
				// they equal the final content (no reconcile flash in the UI).
				assert.ok(deltas.length > 1, `expected slices, got ${deltas.length}`);
				assert.ok(
					deltas.every((d) => !d.includes("<think>")),
					"no tag leaks mid-stream",
				);
				assert.equal(reply.content, "The answer is [1].");
				assert.equal(deltas.join(""), reply.content);
				assert.equal(reply.stopReason, "stop");
				// The stub's final frame carries server timings — captured for
				// the card's exact token readout.
				assert.deepEqual(reply.timings, {
					promptTokens: 42,
					predictedTokens: 9,
					predictedMs: 300,
				});
			} finally {
				stopServer("test");
				fs.rmSync(ctx.dir, { recursive: true, force: true });
			}
		},
	);

	await check("aborting a stream rejects and keeps what arrived", async () => {
		const ctx = init();
		process.env.STUB_HANG = "1";
		try {
			await ensureServer("qwen3-1.7b-q4km");
			const ctrl = new AbortController();
			const deltas = [];
			const pending = llmChat({
				messages: [{ role: "user", content: "q" }],
				modelId: "qwen3-1.7b-q4km",
				stream: true,
				signal: ctrl.signal,
				timeoutMs: 8000,
				onToken: (d) => {
					deltas.push(d);
					ctrl.abort();
				},
			});
			await assert.rejects(() => pending);
			assert.ok(deltas.length >= 1, "first chunk arrived before abort");
			assert.equal(deltas.join(""), "partial ");
		} finally {
			delete process.env.STUB_HANG;
			stopServer("test");
			fs.rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	await check("chat serializes through the single-flight queue", async () => {
		const ctx = init();
		try {
			await ensureServer("qwen3-1.7b-q4km");
			const [a, b] = await Promise.all([
				llmChat({
					messages: [{ role: "user", content: "a" }],
					modelId: "qwen3-1.7b-q4km",
				}),
				llmChat({
					messages: [{ role: "user", content: "b" }],
					modelId: "qwen3-1.7b-q4km",
				}),
			]);
			assert.equal(a.content, "The answer is [1].");
			assert.equal(b.content, "The answer is [1].");
		} finally {
			stopServer("test");
			fs.rmSync(ctx.dir, { recursive: true, force: true });
		}
	});

	await check(
		"a dropped model download RESUMES from the .part on retry",
		async () => {
			// Real fs paths (no modelPath override): the .part must survive the
			// dropped connection and the retry must send a matching Range header
			// and verify the whole file's sha256 — a 1.1GB download on a flaky
			// link must never restart from byte 0.
			const crypto = require("crypto");
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-ask-resume-"));
			const payload = Buffer.from(
				Array.from({ length: 64 }, (_, i) => `chunk-${i};`).join(""),
			);
			const half = Math.floor(payload.length / 2);
			const shaExpected = crypto
				.createHash("sha256")
				.update(payload)
				.digest("hex");
			const registry = require("../main-lib/llm/models.js");
			const model = registry.getLlmModel(registry.DEFAULT_LLM_MODEL_ID);
			let calls = 0;
			let servedFrom = null;
			const makeResponse = (from, until, status, fail) => {
				// `fail` errors on the SECOND pull (deterministic "half then
				// reset"): a start()-time setTimeout can fire before the reader
				// consumes the queued chunk, which would drop it into the error.
				let pulls = 0;
				const body = new ReadableStream({
					pull(controller) {
						pulls++;
						if (fail && pulls > 1) {
							controller.error(new Error("connection reset"));
							return;
						}
						if (pulls === 1)
							controller.enqueue(new Uint8Array(payload.subarray(from, until)));
						if (!fail && pulls >= 1) controller.close();
					},
				});
				return {
					ok: true,
					status,
					headers: {
						get: (k) =>
							k.toLowerCase() === "content-length"
								? String(payload.length - from)
								: null,
					},
					body,
				};
			};
			const fetchStub = async (url, opts = {}) => {
				if (url.includes("huggingface.co/api/models/")) {
					// The tree entry must key EXACTLY as the registry's hfFile,
					// or fetchModelSha256 finds nothing and skips verification.
					return {
						ok: true,
						json: async () => [
							{
								path: model.hfFile,
								lfs: { oid: shaExpected, size: payload.length },
							},
						],
					};
				}
				calls++;
				const range = opts.headers && opts.headers.Range;
				const from = range ? parseInt(String(range).split("=")[1], 10) : 0;
				servedFrom = from;
				// Attempt 1: the first half, then the connection dies.
				// Attempt 2: the requested range through the end.
				return makeResponse(
					calls === 1 ? 0 : from,
					calls === 1 ? half : payload.length,
					calls === 1 ? 200 : 206,
					calls === 1,
				);
			};
			initLlmServer({
				userDataDir: dir,
				broadcast: () => {},
				fetchImpl: fetchStub,
			});
			try {
				await assert.rejects(
					() => downloadModel(registry.DEFAULT_LLM_MODEL_ID),
					/connection reset/,
					"first attempt drops mid-stream",
				);
				const part = path.join(dir, "llm", "models", model.hfFile + ".part");
				assert.equal(
					fs.statSync(part).size,
					half,
					".part survives the drop with the first half",
				);
				assert.equal(calls, 1);
				const out = await downloadModel(registry.DEFAULT_LLM_MODEL_ID);
				assert.equal(out.ok, true);
				assert.equal(calls, 2, "retry hits the fetcher exactly once more");
				assert.equal(
					servedFrom,
					half,
					`retry must resume from the .part offset (Range bytes=${half}-), got ${servedFrom}`,
				);
				const finalPath = path.join(dir, "llm", "models", model.hfFile);
				assert.equal(
					fs.readFileSync(finalPath).toString(),
					payload.toString(),
					"assembled file is byte-complete",
				);
				assert.ok(
					!fs.existsSync(finalPath + ".part"),
					".part cleaned after publish",
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	await check(
		"a dylib-stripped (old-layout) install is treated as NOT downloaded",
		async () => {
			// The pre-layout-2 publish moved only the thin llama-server and
			// deleted the archive's dylibs — it must redownload, not pass as
			// installed (the "download finished but it never works" bug).
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-ask-layout-"));
			const bin = path.join(dir, "llm", "bin", "llama-server");
			fs.mkdirSync(path.dirname(bin), { recursive: true });
			fs.writeFileSync(bin, Buffer.alloc(2 * 1024 * 1024, 1)); // size floor passes
			const metaPath = path.join(dir, "llm", "bin", "server-meta.json");
			const registry = require("../main-lib/llm/models.js");
			initLlmServer({ userDataDir: dir, broadcast: () => {} });
			try {
				fs.writeFileSync(metaPath, JSON.stringify({ tag: "b10964" }));
				assert.equal(
					binaryDownloaded(),
					false,
					"unstamped meta must redownload",
				);
				fs.writeFileSync(
					metaPath,
					JSON.stringify({
						tag: "b10964",
						layoutVersion: registry.LLM_SERVER.layoutVersion,
					}),
				);
				assert.equal(
					binaryDownloaded(),
					true,
					"current-layout install is valid",
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	console.log(
		process.exitCode
			? "ask-server: FAILED"
			: "ask-server: all assertions passed",
	);
	// Explicit exit: this test spawns stub subprocesses (killed above), and
	// the tooling must not wait on anything downstream of them.
	process.exit(process.exitCode || 0);
}

main();
