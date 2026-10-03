"use strict";

// Ask-mode sidecar: download, run, and talk to a llama.cpp `llama-server`
// bound to loopback (MDs/Ask-Mode-Plan.md). Owns the whole provider surface:
//
//   downloadBinary()      GitHub release zip → userData/llm/bin/llama-server
//   downloadModel()       GGUF from HF → userData/llm/models/<id>.gguf
//   ensureServer()        spawn + /health poll (single-flight, one process)
//   llmChat()             POST /v1/chat/completions (serialized, <think> stripped)
//   stopServer()          kill + status reset (idle timer, quit hook)
//
// The sidecar is deliberately NOT an Electron utilityProcess: it is an
// external binary in its own process, so a wedged model can never stall the
// CLIP pool, enrich, transcribe, or OCR pumps. No user text ever rides the
// command line — spawn argv is registry constants only; the query goes in
// the HTTP body. Plain-node testable: initLlmServer accepts path/spawn
// overrides and the download helpers accept injected fetchers.

const { spawn, execFile } = require("child_process");
// Explicit require: global `crypto` is absent on older Electron/node (the
// same guard main.js applies — the built-in shadows nothing here).
// eslint-disable-next-line no-redeclare
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const execFileP = promisify(execFile);

const { LLM_SERVER, getLlmModel, resolveLlmModelId } = require("./models.js");

// One answer's generation ceiling — also the natural upper bound on how
// long a stalled HTTP body stays open. A 1.7B on 4 threads answers well
// inside this; the cap exists so a wedged server can never hang Ask.
const CHAT_TIMEOUT_MS = 300_000;
// Model load on first spawn (mmap + warmup) is seconds, but a cold 3B on a
// busy 8GB machine may page — the health poll deadline stays generous.
const HEALTH_TIMEOUT_MS = 180_000;
// Kill the sidecar after this long with no chat (Ask is a burst feature).
const IDLE_STOP_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state = {
	init: false,
	userDataDir: null,
	broadcast: null,
	// Test overrides (see initLlmServer).
	overrides: { binaryPath: null, modelPath: null, fetchImpl: null },
};

const server = {
	proc: null,
	port: 0,
	modelId: null,
	ready: false,
	starting: null,
	// Which model the in-flight startup is for: a switch requested mid-start
	// must not join (and inherit) the wrong model's promise.
	startingModelId: null,
	lastUsed: 0,
	idleTimer: null,
	stderrTail: "",
	// Serializes chat calls: Ask is single-flight by design, and a second
	// question queued behind a generating one beats interleaved 503s.
	chatQueue: Promise.resolve(),
};

function broadcastLlm(payload) {
	if (typeof state.broadcast === "function") {
		try {
			state.broadcast(payload);
		} catch {
			/* status must never break the pipeline */
		}
	}
}

function llmStatusEvent(phase, extra = {}) {
	return { type: "llm", phase, ...extra };
}

// ---------------------------------------------------------------------------
// Paths + on-disk checks
// ---------------------------------------------------------------------------

function llmRoot() {
	return path.join(state.userDataDir, "llm");
}
function binDir() {
	return path.join(llmRoot(), "bin");
}
function binaryPath() {
	if (state.overrides.binaryPath) return state.overrides.binaryPath;
	return path.join(binDir(), "llama-server");
}
function modelsDir() {
	return path.join(llmRoot(), "models");
}
function modelFilePath(modelId) {
	if (state.overrides.modelPath) return state.overrides.modelPath;
	const m = getLlmModel(modelId);
	return path.join(modelsDir(), m ? m.hfFile : `${modelId}.gguf`);
}
function binaryMetaPath() {
	return path.join(binDir(), "server-meta.json");
}

function binaryDownloaded() {
	// Test override: a stub executable stands in for the real binary —
	// existence is the only sane check there (stubs are tiny).
	if (state.overrides.binaryPath)
		return fs.existsSync(state.overrides.binaryPath);
	try {
		if (fs.statSync(binaryPath()).size < (LLM_SERVER.minimumBinaryBytes || 1)) {
			return false;
		}
		// Layout integrity: an install stamped with an older layout (or an
		// unstamped one — the pre-dylib-aware publish stripped the archive's
		// dylibs and left a ~50KB llama-server that could never run) must
		// redownload rather than look installed.
		const meta = JSON.parse(fs.readFileSync(binaryMetaPath(), "utf-8"));
		return meta.layoutVersion === (LLM_SERVER.layoutVersion || 1);
	} catch {
		return false;
	}
}

function modelDownloaded(modelId) {
	const id = resolveLlmModelId(modelId);
	const m = getLlmModel(id);
	const floor = (m && m.minimumModelBytes) || 1024;
	if (state.overrides.modelPath)
		return fs.existsSync(state.overrides.modelPath);
	try {
		return fs.statSync(modelFilePath(id)).size >= floor;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Download plumbing (shared by binary + model)
// ---------------------------------------------------------------------------

function fetchImpl() {
	if (state.overrides.fetchImpl) return state.overrides.fetchImpl;
	// Node 18+ / Electron main both carry global fetch.
	return fetch;
}

// Stream a URL to a temp file with progress + incremental sha256. Never
// publishes directly: the caller verifies then renames, so an interrupted
// download can never masquerade as weights (the minimumWeightBytes lesson
// from indexer/models.js).
//
// Resume: when `resume` is set and a partial file exists, a Range request
// continues from its last byte (a server that ignores Range answers 200 —
// the file restarts cleanly), and the already-downloaded prefix is hashed
// from disk so the final sha256 still covers the whole file. A 1.1GB model
// on a slow or flaky link must not restart from byte 0.
async function streamToFile(
	url,
	destPath,
	{ signal, onProgress, resume } = {},
) {
	let startBytes = 0;
	if (resume) {
		try {
			startBytes = fs.statSync(destPath).size;
		} catch {
			startBytes = 0;
		}
	}
	const headers = startBytes > 0 ? { Range: `bytes=${startBytes}-` } : {};
	const res = await fetchImpl()(url, { signal, redirect: "follow", headers });
	if (!res.ok || !res.body) {
		throw new Error(`download failed (${res.status})`);
	}
	// 206 = ranged resume honored; 200 = server ignored the Range (or the
	// part was absent) — either way the bytes below are consistent.
	const resumed = res.status === 206 && startBytes > 0;
	if (!resumed) startBytes = 0;
	const total =
		Number(res.headers.get("content-length") || 0) + startBytes || 0;
	const hash = crypto.createHash("sha256");
	// Resume: the prefix on disk must enter the hash (read once — a local
	// 1GB sequential read is seconds, versus re-downloading it for hours).
	if (resumed) {
		await new Promise((resolve, reject) => {
			const stream = fs.createReadStream(destPath);
			stream.on("data", (c) => hash.update(c));
			stream.on("error", reject);
			stream.on("end", resolve);
		});
	}
	const fh = await fs.promises.open(destPath, resumed ? "a" : "w");
	let received = startBytes;
	const reader = res.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value && value.byteLength > 0) {
				await fh.write(value);
				hash.update(value);
				received += value.byteLength;
				if (onProgress && total > 0) onProgress(received, total);
			}
		}
	} finally {
		await fh.close();
		try {
			await reader.cancel();
		} catch {
			/* body already consumed */
		}
	}
	return { received, sha256: hash.digest("hex") };
}

// ---------------------------------------------------------------------------
// Server binary
// ---------------------------------------------------------------------------

async function resolveReleaseAsset() {
	const base = `https://api.github.com/repos/${LLM_SERVER.repo}`;
	const fetchRelease = async (path) => {
		const res = await fetchImpl()(path, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "scm-ask",
			},
		});
		if (!res.ok) throw new Error(`release lookup failed (${res.status})`);
		return res.json();
	};
	// Binary assets are .zip or .tar.gz named for their platform. Upstream
	// has bounced between both formats, so neither is assumed.
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const pattern = LLM_SERVER.archPatterns[arch];
	const pick = (release) => {
		const assets = (release.assets || []).filter(
			(a) =>
				a &&
				typeof a.name === "string" &&
				/\.(zip|tar\.gz|tgz)$/i.test(a.name) &&
				pattern.test(a.name),
		);
		if (assets.length === 0) return null;
		// Smallest matching archive: the toolchain zips differ mainly in
		// size, and the smallest is likeliest to be the plain runtime.
		assets.sort((a, b) => (a.size || 0) - (b.size || 0));
		return { tag: release.tag_name, asset: assets[0] };
	};
	const latest = await fetchRelease(
		LLM_SERVER.tag && LLM_SERVER.tag !== "latest"
			? `${base}/releases/tags/${encodeURIComponent(LLM_SERVER.tag)}`
			: `${base}/releases/latest`,
	);
	const direct = pick(latest);
	if (direct) return direct;
	// Upstream's "latest" may be a STUB: a single nightly-tag.txt asset
	// naming the tag whose release carries the real binaries. Follow the
	// pointer (fetch the tiny text file, then that tag's release).
	const pointer = (latest.assets || []).find(
		(a) => a && a.name === "nightly-tag.txt",
	);
	if (pointer && pointer.browser_download_url) {
		const res = await fetchImpl()(pointer.browser_download_url);
		if (res.ok) {
			const nightlyTag = (await res.text()).trim();
			if (/^[A-Za-z0-9._-]+$/.test(nightlyTag)) {
				const nightly = await fetchRelease(
					`${base}/releases/tags/${encodeURIComponent(nightlyTag)}`,
				);
				const fromNightly = pick(nightly);
				if (fromNightly) return fromNightly;
			}
		}
	}
	throw new Error(
		`no macOS ${arch} binary found in release ${latest.tag_name || "?"}`,
	);
}

// One llama.cpp release archive → bin/llama-server. Extracted with the
// system unzip / bsdtar (no npm dep — upstream ships both formats), the
// entry binary ad-hoc signed (arm64 refuses to exec unsigned code), and
// published by rename only after everything landed.
async function downloadBinary({ signal } = {}) {
	if (state.overrides.binaryPath) {
		throw new Error("binary path overridden — download disabled");
	}
	fs.mkdirSync(binDir(), { recursive: true });
	broadcastLlm(
		llmStatusEvent("downloading", { target: "binary", progress: 0 }),
	);
	const { tag, asset } = await resolveReleaseAsset();
	const isTar = /\.(tar\.gz|tgz)$/i.test(asset.name);
	const archivePath = path.join(binDir(), `llama-server-${asset.name}`);
	const extractDir = path.join(
		binDir(),
		`extract-${crypto.randomBytes(4).toString("hex")}`,
	);
	try {
		const { received } = await streamToFile(
			asset.browser_download_url,
			archivePath,
			{
				signal,
				// Resume the archive across retries (11MB — still worth it on a
				// slow link; the failure path keeps the partial archive).
				resume: true,
				onProgress: (done, total) =>
					broadcastLlm(
						llmStatusEvent("downloading", {
							target: "binary",
							progress: Math.min(99, Math.round((done / total) * 100)),
						}),
					),
			},
		);
		if (
			received <
			(LLM_SERVER.minimumArchiveBytes || LLM_SERVER.minimumBinaryBytes || 1)
		) {
			throw new Error(`binary archive suspiciously small (${received} bytes)`);
		}
		fs.mkdirSync(extractDir, { recursive: true });
		if (isTar) {
			await execFileP("tar", ["-xzf", archivePath, "-C", extractDir]);
		} else {
			await execFileP("unzip", ["-o", "-q", archivePath, "-d", extractDir]);
		}
		const bin = await findFileByName(extractDir, "llama-server");
		if (!bin) throw new Error("llama-server not found in the release archive");
		// Publish the WHOLE extracted runtime, not just the entry binary:
		// the macOS builds ship a thin llama-server dynamically linked
		// against the archive's libllama/libggml dylibs — publishing the
		// binary alone produced a ~50KB install that could never start.
		// Files merge into binDir() (same volume → rename = cheap).
		let publishedBin = null;
		for (const file of await listFilesDeep(extractDir)) {
			const dest = path.join(binDir(), path.basename(file));
			fs.renameSync(file, dest);
			if (path.basename(file) === "llama-server") publishedBin = dest;
		}
		if (!publishedBin) throw new Error("llama-server missing after publish");
		fs.chmodSync(publishedBin, 0o755);
		// Ad-hoc signature: macOS arm64 kills unsigned executables at execve.
		// Best-effort — an already-signed binary re-signs fine; a failure here
		// surfaces at spawn (the health poll rejects with the stderr tail).
		try {
			await execFileP("codesign", ["--force", "--sign", "-", publishedBin]);
		} catch {
			/* codesign unavailable/failure — retry without it */
		}
		fs.writeFileSync(
			binaryMetaPath(),
			JSON.stringify(
				{
					tag,
					asset: asset.name,
					layoutVersion: LLM_SERVER.layoutVersion || 1,
					downloadedAt: new Date().toISOString(),
				},
				null,
				"\t",
			),
		);
	} finally {
		try {
			fs.rmSync(extractDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
	// The archive is removed only after a successful publish — a failed
	// attempt keeps its partial bytes so the next Download click RESUMES
	// instead of starting over (the finally-above must not eat them).
	try {
		fs.unlinkSync(archivePath);
	} catch {
		/* best-effort */
	}
	broadcastLlm(llmStatusEvent("ready", { target: "binary", progress: 100 }));
	return { ok: true };
}

// Every FILE under dir (recursive) — symlinks INCLUDED. The archive's
// dylibs are versioned (libllama-common.0.4.1.dylib) and the binaries'
// @rpath expects the unversioned names (libllama-common.0.dylib), which
// the release ships as symlinks beside them; skipping symlinks produced
// an install dyld could not load ("Library not loaded: @rpath/…").
// renameSync moves the link itself, so relative targets stay intact.
async function listFilesDeep(dir) {
	const files = [];
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(cur, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() || entry.isSymbolicLink()) files.push(full);
		}
	}
	return files;
}

async function findFileByName(dir, name) {
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(cur, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name === name) return full;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// GGUF model
// ---------------------------------------------------------------------------

// The expected sha256 comes from the HF tree API at download time (TLS to
// huggingface.co), so a truncated/corrupted body is caught before publish
// without hardcoding digests that upstream re-uploads move.
async function fetchModelSha256(model) {
	try {
		const url = `https://huggingface.co/api/models/${model.hfRepo}/tree/main`;
		const res = await fetchImpl()(url, {
			headers: { "User-Agent": "scm-ask" },
		});
		if (!res.ok) return null;
		const tree = await res.json();
		if (!Array.isArray(tree)) return null;
		const entry = tree.find((e) => e && e.path === model.hfFile);
		const oid = entry && entry.lfs && entry.lfs.oid;
		return typeof oid === "string" && /^[0-9a-f]{64}$/.test(oid) ? oid : null;
	} catch {
		return null;
	}
}

async function downloadModel(modelId, { signal } = {}) {
	const id = resolveLlmModelId(modelId);
	const model = getLlmModel(id);
	if (!model) throw new Error(`Unknown LLM model: ${modelId}`);
	if (state.overrides.modelPath) {
		throw new Error("model path overridden — download disabled");
	}
	if (modelDownloaded(id)) return { ok: true, skipped: true };
	fs.mkdirSync(modelsDir(), { recursive: true });
	broadcastLlm(
		llmStatusEvent("downloading", { target: id, progress: 0, modelId: id }),
	);
	const shaExpected = await fetchModelSha256(model);
	const dest = modelFilePath(id);
	const partPath = `${dest}.part`;
	let published = false;
	try {
		const { sha256 } = await streamToFile(model.downloadUrl, partPath, {
			signal,
			// Resume from the .part on every attempt — a dropped connection on
			// a 1.1GB file continues instead of restarting (the app's own
			// retry path and the user re-clicking Download both benefit).
			resume: true,
			onProgress: (done, total) =>
				broadcastLlm(
					llmStatusEvent("downloading", {
						target: id,
						modelId: id,
						progress: Math.min(99, Math.round((done / total) * 100)),
					}),
				),
		});
		if (shaExpected && sha256 !== shaExpected) {
			// The assembled bytes are wrong — a resumed prefix is only valid
			// when the stream cut cleanly, so discard and start fresh.
			try {
				fs.unlinkSync(partPath);
			} catch {
				/* best-effort */
			}
			throw new Error("checksum mismatch — download discarded");
		}
		fs.renameSync(partPath, dest);
		published = true;
	} finally {
		// A network failure KEEPS the .part (the resume point); only a
		// published model (renamed away) and a checksum mismatch remove it.
		if (published) {
			try {
				fs.unlinkSync(partPath);
			} catch {
				/* renamed away already */
			}
		}
	}
	broadcastLlm(
		llmStatusEvent("ready", { target: id, modelId: id, progress: 100 }),
	);
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

function pickFreePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

function chatThreads() {
	return Math.max(1, Math.min(4, os.cpus() ? os.cpus().length : 1));
}

function noteStderr(chunk) {
	if (!chunk) return;
	server.stderrTail = (server.stderrTail + chunk.toString()).slice(-4000);
}

function spawnArgs(modelPath, port, ctxTokens, withReasoningFlag) {
	const args = [
		"-m",
		modelPath,
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"-c",
		String(ctxTokens),
		"-t",
		String(chatThreads()),
	];
	// Qwen3's chat template enables thinking by default — Ask answers cite
	// evidence and don't want a hidden reasoning preamble burning the ctx.
	// Older builds reject the flag: the caller retries without it once.
	if (withReasoningFlag) args.push("--reasoning-budget", "0");
	return args;
}

async function pollHealth(port, deadlineMs) {
	const started = Date.now();
	const fetchNow = fetchImpl();
	for (;;) {
		if (Date.now() - started > deadlineMs) {
			throw new Error("llama-server did not become healthy in time");
		}
		try {
			const res = await fetchNow(`http://127.0.0.1:${port}/health`, {
				signal: AbortSignal.timeout(2000),
			});
			if (res.ok) return true;
		} catch {
			/* not up yet — poll again */
		}
		await new Promise((r) => setTimeout(r, 300));
	}
}

function armIdleStop() {
	if (server.idleTimer) clearTimeout(server.idleTimer);
	server.idleTimer = setTimeout(() => {
		stopServer("idle");
	}, IDLE_STOP_MS);
	if (server.idleTimer.unref) server.idleTimer.unref();
}

// One sidecar for one model at a time — a model switch is a respawn (the
// weights stay resident otherwise), mirroring the CLIP pool's contract.
function stopServer(reason) {
	if (server.idleTimer) {
		clearTimeout(server.idleTimer);
		server.idleTimer = null;
	}
	if (server.proc) {
		try {
			server.proc.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
	const wasRunning = Boolean(server.proc);
	server.proc = null;
	server.port = 0;
	server.modelId = null;
	server.ready = false;
	server.starting = null;
	server.startingModelId = null;
	server.stderrTail = "";
	if (wasRunning || reason === "quit") {
		broadcastLlm(llmStatusEvent("idle", { detail: reason || null }));
	}
}

async function spawnAndAwait(modelId) {
	const id = resolveLlmModelId(modelId);
	const model = getLlmModel(id);
	if (!model) throw new Error(`Unknown LLM model: ${modelId}`);
	const bin = binaryPath();
	const modelPath = modelFilePath(id);
	if (!state.overrides.binaryPath && !binaryDownloaded()) {
		throw new Error("llama-server is not downloaded yet");
	}
	if (!state.overrides.modelPath && !modelDownloaded(id)) {
		throw new Error(`model ${id} is not downloaded yet`);
	}
	const port = await pickFreePort();
	const launch = (withReasoningFlag) => {
		const child = spawn(
			bin,
			spawnArgs(modelPath, port, model.ctxTokens, withReasoningFlag),
			{
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		child.stderr.on("data", noteStderr);
		return child;
	};
	broadcastLlm(llmStatusEvent("loading", { modelId: id }));
	let proc = launch(true);
	// Race health against an actual EXIT (bad flag, bad binary, bad weights).
	// A slow-but-alive load (3B paging on a busy 8GB machine) must keep
	// polling — only a real exit fails fast here.
	const healthPromise = pollHealth(port, HEALTH_TIMEOUT_MS);
	const exitPromise = new Promise((resolve) => {
		proc.once("exit", (code, signalName) => resolve({ code, signalName }));
	});
	let outcome;
	try {
		outcome = await Promise.race([
			healthPromise.then(() => "healthy"),
			exitPromise.then(() => "exited"),
		]);
	} catch (err) {
		// Health deadline hit while the process was still up.
		try {
			proc.kill("SIGKILL");
		} catch {
			/* already gone */
		}
		throw err;
	}
	if (outcome !== "healthy") {
		// Early death: retry once without the reasoning flag when stderr says
		// the flag was rejected; otherwise surface the stderr tail.
		proc = null;
		const tail = server.stderrTail;
		const flagRejected =
			/invalid argument|unknown (argument|option)|unrecognized/i.test(tail) &&
			/reasoning/i.test(tail);
		if (flagRejected) {
			server.stderrTail = "";
			proc = launch(false);
			await pollHealth(port, HEALTH_TIMEOUT_MS);
		} else {
			throw new Error(
				`llama-server failed to start: ${tail.trim().slice(-400) || "no output"}`,
			);
		}
	}
	server.proc = proc;
	server.port = port;
	server.modelId = id;
	server.ready = true;
	server.lastUsed = Date.now();
	proc.once("exit", () => {
		if (server.proc === proc) stopServer("exit");
	});
	armIdleStop();
	broadcastLlm(llmStatusEvent("ready", { modelId: id }));
	return port;
}

// Single-flight ensure: concurrent first asks share one startup.
function ensureServer(modelId) {
	const id = resolveLlmModelId(modelId);
	if (server.proc && server.ready && server.modelId === id) {
		server.lastUsed = Date.now();
		armIdleStop();
		return Promise.resolve(server.port);
	}
	if (server.starting) {
		// Same model still starting: join it. A different model requested
		// mid-start waits for the in-flight spawn, then switches — joining
		// the wrong promise would hand a Qwen port to a Llama waiter.
		if (server.startingModelId === id) return server.starting;
		return server.starting.then(
			() => ensureServer(id),
			() => ensureServer(id),
		);
	}
	// Switching away from a resident server: kill it FIRST. Spawning without
	// this overwrites server.proc/port with the new child and leaks the old
	// one (orphaned llama-server, bound port, resident weights) — the exact
	// state a Settings model switch leaves behind.
	if (server.proc) stopServer("switch");
	server.startingModelId = id;
	server.starting = spawnAndAwait(id).finally(() => {
		server.starting = null;
		server.startingModelId = null;
	});
	return server.starting;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

// Qwen3 emits a <think>…</think> preamble when the template's thinking mode
// stays on; the answer lives after the last closing tag.
function stripThink(text) {
	const src = String(text || "");
	if (!src.includes("</think>")) {
		return src.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
	}
	const idx = src.lastIndexOf("</think>");
	return src.slice(idx + "</think>".length).trim();
}

// Incremental <think> stripper for streamed output. The whole-text
// stripThink leaks a partial tag mid-stream ("<think>a" has no close yet,
// so it passes through, then vanishes when the close arrives — visible
// flicker). Instead: hold back from a possible tag start until the matching
// close is seen, then release. Two deliberate divergences from stripThink,
// both in the keep-output direction: pre-tag text is KEPT (stripThink drops
// everything before the last close) and a never-closed tail flushes as-is.
// With --reasoning-budget 0 this path is a near-no-op guard.
function createThinkStripper() {
	let hold = "";
	let closed = false;
	// A tail that could still grow into <think…> or </think>.
	const PARTIAL_TAG = /^<(\/)?t(h(i(n(k(\s[^<>]*)?)?)?)?)?$/i;
	return {
		push(chunk) {
			if (closed) return String(chunk || "");
			hold += String(chunk || "");
			const openMatch = hold.match(/<think(\s[^<>]*)?>/i);
			if (!openMatch) {
				// No open tag yet: release everything except a possibly
				// still-forming tag tail ("<", "</th", …).
				const lt = hold.lastIndexOf("<");
				let cut = hold.length;
				if (lt !== -1 && PARTIAL_TAG.test(hold.slice(lt))) cut = lt;
				const out = hold.slice(0, cut);
				hold = hold.slice(cut);
				return out;
			}
			const out = hold.slice(0, openMatch.index);
			const rest = hold.slice(openMatch.index);
			const closeMatch = rest.match(/<\/think\s*>/i);
			if (!closeMatch) {
				hold = rest;
				return out;
			}
			const after = rest.slice(closeMatch.index + closeMatch[0].length);
			hold = "";
			closed = true;
			return out + after;
		},
		flush() {
			const out = hold;
			hold = "";
			return out;
		},
	};
}

// One llama-server SSE line → { delta } | { done } | { finishReason } |
// { timings } | null (not a data line or malformed — skipped, never fatal).
// The final frame before [DONE] carries the server's own `timings`
// (prompt_n / predicted_n / predicted_ms) when the build reports them.
function parseSseLine(line) {
	const s = String(line || "").trim();
	if (!s.startsWith("data:")) return null;
	const payload = s.slice(5).trim();
	if (payload === "[DONE]") return { done: true };
	try {
		const json = JSON.parse(payload);
		const choice = json && json.choices && json.choices[0];
		return {
			delta:
				choice && choice.delta && typeof choice.delta.content === "string"
					? choice.delta.content
					: undefined,
			finishReason: (choice && choice.finish_reason) || undefined,
			timings:
				json && json.timings && typeof json.timings === "object"
					? json.timings
					: undefined,
		};
	} catch {
		return null;
	}
}

// Server `timings` → { promptTokens, predictedTokens, predictedMs } with
// numbers only (a half-present object degrades to null — the caller shows
// client-side estimates instead, flagged approximate).
function normalizeLlmTimings(t) {
	if (!t || typeof t !== "object") return null;
	const promptTokens = Number(t.prompt_n);
	const predictedTokens = Number(t.predicted_n);
	const predictedMs = Number(t.predicted_ms);
	if (!Number.isFinite(promptTokens) || !Number.isFinite(predictedTokens)) {
		return null;
	}
	return {
		promptTokens,
		predictedTokens,
		predictedMs: Number.isFinite(predictedMs) ? predictedMs : null,
	};
}

// Consume a streaming chat-completions response, forwarding cleaned text
// through onToken as it arrives. Resolves with the full cleaned content.
async function readChatStream(res, onToken) {
	const stripper = createThinkStripper();
	const parts = [];
	let finishReason = null;
	let timings = null;
	let finished = false;
	const emit = (text) => {
		if (text) {
			parts.push(text);
			onToken(text);
		}
	};
	const handleLine = (line) => {
		const parsed = parseSseLine(line);
		if (!parsed) return;
		if (parsed.done) {
			finished = true;
			return;
		}
		if (typeof parsed.delta === "string" && parsed.delta) {
			emit(stripper.push(parsed.delta));
		}
		if (parsed.finishReason) finishReason = parsed.finishReason;
		const normalized = normalizeLlmTimings(parsed.timings);
		if (normalized) timings = normalized;
	};
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (value) buf += decoder.decode(value, { stream: !done });
		if (buf.includes("\n") || done) {
			const lines = buf.split("\n");
			buf = done ? "" : lines.pop();
			for (const line of lines) handleLine(line);
			if (done && buf) handleLine(buf);
		}
		if (done || finished) break;
	}
	emit(stripper.flush());
	try {
		await reader.cancel().catch(() => {});
	} catch {
		/* already closed */
	}
	return { content: parts.join(""), stopReason: finishReason, timings };
}

function chatOnce({ messages, modelId, timeoutMs, signal, stream, onToken }) {
	const doChat = async () => {
		const port = await ensureServer(modelId);
		const ctrl = new AbortController();
		const timer = setTimeout(
			() => ctrl.abort(new Error("chat timed out")),
			timeoutMs || CHAT_TIMEOUT_MS,
		);
		const onOuterAbort = () => ctrl.abort(new Error("chat canceled"));
		if (signal) {
			if (signal.aborted) onOuterAbort();
			else signal.addEventListener("abort", onOuterAbort, { once: true });
		}
		const post = () =>
			fetchImpl()(`http://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages,
					temperature: 0.2,
					max_tokens: 1024,
					stream: stream === true,
				}),
				signal: ctrl.signal,
			});
		const failStatus = async (res) => {
			const detail = await res.text().catch(() => "");
			throw new Error(
				`llama-server ${res.status}${detail ? `: ${detail.slice(-200)}` : ""}`,
			);
		};
		try {
			if (stream === true && typeof onToken === "function") {
				const res = await post();
				if (!res.ok) await failStatus(res);
				return await readChatStream(res, onToken);
			}
			const res = await post();
			if (!res.ok) await failStatus(res);
			const data = await res.json();
			const content = data?.choices?.[0]?.message?.content ?? "";
			return {
				content: stripThink(content),
				stopReason: data?.choices?.[0]?.finish_reason ?? null,
				timings: normalizeLlmTimings(data && data.timings),
			};
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onOuterAbort);
			server.lastUsed = Date.now();
			if (server.ready) armIdleStop();
		}
	};
	// Serialize through the queue so concurrent asks run one at a time; a
	// failure must not poison later turns (the persistQueue pattern).
	const run = server.chatQueue.then(doChat, doChat);
	server.chatQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function llmChat(params) {
	return chatOnce(params);
}

// ---------------------------------------------------------------------------
// Init + snapshot
// ---------------------------------------------------------------------------

function initLlmServer({
	userDataDir,
	broadcast,
	binaryPath: binaryOverride,
	modelPath: modelOverride,
	fetchImpl: fetchOverride,
} = {}) {
	state = {
		init: true,
		userDataDir,
		broadcast: typeof broadcast === "function" ? broadcast : null,
		overrides: {
			binaryPath: binaryOverride || null,
			modelPath: modelOverride || null,
			fetchImpl: fetchOverride || null,
		},
	};
}

function llmServerSnapshot() {
	return {
		binaryDownloaded: binaryDownloaded(),
		binaryTag: (() => {
			try {
				return (
					JSON.parse(fs.readFileSync(binaryMetaPath(), "utf-8")).tag || null
				);
			} catch {
				return null;
			}
		})(),
		running: server.ready,
		modelId: server.modelId,
	};
}

module.exports = {
	initLlmServer,
	llmServerSnapshot,
	binaryDownloaded,
	modelDownloaded,
	binaryPath,
	modelFilePath,
	downloadBinary,
	downloadModel,
	ensureServer,
	llmChat,
	stopServer,
	stripThink,
	createThinkStripper,
	parseSseLine,
	normalizeLlmTimings,
	chatThreadCount: chatThreads,
	resolveReleaseAsset,
	CHAT_TIMEOUT_MS,
	IDLE_STOP_MS,
};
