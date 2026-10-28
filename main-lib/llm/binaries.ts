// LLM binaries + GGUF weights: on-disk paths, downloaded checks, the
// release-resolution and streaming download layer. Split out of
// server.ts (2026-10-25); the sidecar lifecycle + chat stay in
// server.ts, the shared init state in runtime.ts.

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import {
	LLM_SERVER,
	getLlmModel,
	resolveLlmModelId,
	type LlmModel,
} from "./models.ts";
import { broadcastLlm, fetchImpl, llmStatusEvent, state } from "./runtime.ts";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths + on-disk checks
// ---------------------------------------------------------------------------

function llmRoot(): string {
	return path.join(state.userDataDir as string, "llm");
}
function binDir(): string {
	return path.join(llmRoot(), "bin");
}
export function binaryPath(): string {
	if (state.overrides.binaryPath) return state.overrides.binaryPath;
	return path.join(binDir(), "llama-server");
}
function modelsDir(): string {
	return path.join(llmRoot(), "models");
}
export function modelFilePath(modelId: string): string {
	if (state.overrides.modelPath) return state.overrides.modelPath;
	const m = getLlmModel(modelId);
	return path.join(modelsDir(), m ? m.hfFile : `${modelId}.gguf`);
}
export function binaryMetaPath(): string {
	return path.join(binDir(), "server-meta.json");
}

export function binaryDownloaded(): boolean {
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

export function modelDownloaded(modelId: unknown): boolean {
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

interface StreamToFileOptions {
	signal?: AbortSignal | null;
	onProgress?: ((done: number, total: number) => void) | null;
	resume?: boolean;
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
	url: string,
	destPath: string,
	{ signal, onProgress, resume }: StreamToFileOptions = {},
): Promise<{ received: number; sha256: string }> {
	let startBytes = 0;
	if (resume) {
		try {
			startBytes = fs.statSync(destPath).size;
		} catch {
			startBytes = 0;
		}
	}
	const headers: Record<string, string> =
		startBytes > 0 ? { Range: `bytes=${startBytes}-` } : {};
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
		await new Promise<void>((resolve, reject) => {
			const stream = fs.createReadStream(destPath);
			stream.on("data", (c) => hash.update(c));
			stream.on("error", reject);
			stream.on("end", () => resolve());
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

export async function resolveReleaseAsset(): Promise<{
	tag: string;
	asset: {
		name: string;
		browser_download_url: string;
		/** GitHub's upload digest, `sha256:<hex>`, when the release has one. */
		digest?: string | null;
	};
}> {
	const base = `https://api.github.com/repos/${LLM_SERVER.repo}`;
	const fetchRelease = async (path: string): Promise<any> => {
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
	const pick = (release: any) => {
		const assets = (release.assets || []).filter(
			(a: any) =>
				a &&
				typeof a.name === "string" &&
				/\.(zip|tar\.gz|tgz)$/i.test(a.name) &&
				pattern.test(a.name),
		);
		if (assets.length === 0) return null;
		// Smallest matching archive: the toolchain zips differ mainly in
		// size, and the smallest is likeliest to be the plain runtime.
		assets.sort((a: any, b: any) => (a.size || 0) - (b.size || 0));
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
		(a: any) => a && a.name === "nightly-tag.txt",
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

interface DownloadOptions {
	signal?: AbortSignal | null;
}

function githubDigestSha256(digest: unknown): string | null {
	if (typeof digest !== "string") return null;
	const match = digest.match(/^sha256:([0-9a-f]{64})$/i);
	return match?.[1] ? match[1].toLowerCase() : null;
}

// One llama.cpp release archive → bin/llama-server. Extracted with the
// system unzip / bsdtar (no npm dep — upstream ships both formats), the
// entry binary ad-hoc signed (arm64 refuses to exec unsigned code), and
// published by rename only after everything landed.
export async function downloadBinary({
	signal,
}: DownloadOptions = {}): Promise<{ ok: boolean }> {
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
		const { received, sha256 } = await streamToFile(
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
		// GitHub publishes the upload digest on newer release assets. Verify
		// it when present; an absent digest falls back to the size floor
		// (older releases predate the field).
		const expected = githubDigestSha256(asset.digest);
		if (expected && sha256 !== expected) {
			try {
				fs.unlinkSync(archivePath);
			} catch {
				/* best-effort: a resumed prefix must not survive a mismatch */
			}
			throw new Error("binary archive SHA-256 mismatch");
		}
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
async function listFilesDeep(dir: string): Promise<string[]> {
	const files: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop() as string;
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

async function findFileByName(
	dir: string,
	name: string,
): Promise<string | null> {
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop() as string;
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
async function fetchModelSha256(model: LlmModel): Promise<string | null> {
	try {
		const url = `https://huggingface.co/api/models/${model.hfRepo}/tree/main`;
		const res = await fetchImpl()(url, {
			headers: { "User-Agent": "scm-ask" },
		});
		if (!res.ok) return null;
		const tree = await res.json();
		if (!Array.isArray(tree)) return null;
		const entry = tree.find((e: any) => e && e.path === model.hfFile);
		const oid = entry && entry.lfs && entry.lfs.oid;
		return typeof oid === "string" && /^[0-9a-f]{64}$/.test(oid) ? oid : null;
	} catch {
		return null;
	}
}

export async function downloadModel(
	modelId: unknown,
	{ signal }: DownloadOptions = {},
): Promise<{ ok: boolean; skipped?: boolean }> {
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
