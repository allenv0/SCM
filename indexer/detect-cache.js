"use strict";

// Per-file scene-detect result cache (Phase 1.4). Keyed by absolute path +
// size + mtime + the detect-config fingerprint, so a re-import or a quality
// / threshold / engine change misses cleanly. Pattern matches
// main-lib/library-store.js memory-models.json: one JSON file, atomic write,
// pure helpers unit-tested without ffmpeg.

const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");

const CACHE_SCHEMA = "scm-detect-cache/v1";
const CACHE_FILENAME = "detect-cache.json";
// Soft cap so a library of thousands of videos cannot grow the file forever.
const MAX_ENTRIES = 500;

function detectCachePath(cacheDir) {
	if (!cacheDir) return null;
	return path.join(cacheDir, CACHE_FILENAME);
}

// Fingerprint of everything that must invalidate a cached plan when it
// changes: the file identity and the detect configuration.
function detectCacheKey({ filePath, size, mtimeMs, configKey }) {
	const h = nodeCrypto.createHash("sha256");
	h.update(String(filePath));
	h.update("\0");
	h.update(String(size));
	h.update("\0");
	h.update(String(mtimeMs));
	h.update("\0");
	h.update(String(configKey));
	return h.digest("hex");
}

function fileIdentity(filePath) {
	const st = fs.statSync(filePath);
	return { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

function readCache(cachePath) {
	if (!cachePath || !fs.existsSync(cachePath)) {
		return { schema: CACHE_SCHEMA, entries: {} };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
		if (!raw || raw.schema !== CACHE_SCHEMA || typeof raw.entries !== "object") {
			return { schema: CACHE_SCHEMA, entries: {} };
		}
		return raw;
	} catch {
		return { schema: CACHE_SCHEMA, entries: {} };
	}
}

function writeCache(cachePath, cache) {
	if (!cachePath) return;
	const dir = path.dirname(cachePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${cachePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(cache) + "\n");
	fs.renameSync(tmp, cachePath);
}

function pruneEntries(entries) {
	const keys = Object.keys(entries);
	if (keys.length <= MAX_ENTRIES) return entries;
	// Drop oldest by createdAt.
	keys.sort((a, b) => {
		const ta = entries[a]?.createdAt || "";
		const tb = entries[b]?.createdAt || "";
		return ta < tb ? -1 : ta > tb ? 1 : 0;
	});
	const out = {};
	for (const k of keys.slice(keys.length - MAX_ENTRIES)) {
		out[k] = entries[k];
	}
	return out;
}

function getCachedDetect(cacheDir, { filePath, size, mtimeMs, configKey }) {
	const cachePath = detectCachePath(cacheDir);
	if (!cachePath) return null;
	const key = detectCacheKey({ filePath, size, mtimeMs, configKey });
	const cache = readCache(cachePath);
	const hit = cache.entries[key];
	if (!hit) return null;
	// Defensive: never serve a malformed entry.
	if (!Array.isArray(hit.boundaries)) return null;
	return {
		boundaries: hit.boundaries.map(Number).filter((x) => Number.isFinite(x)),
		duration: hit.duration == null ? null : Number(hit.duration),
		engine: hit.engine || null,
		wallMs: hit.wallMs ?? null,
		cached: true,
	};
}

function setCachedDetect(cacheDir, { filePath, size, mtimeMs, configKey }, result) {
	const cachePath = detectCachePath(cacheDir);
	if (!cachePath) return false;
	const key = detectCacheKey({ filePath, size, mtimeMs, configKey });
	const cache = readCache(cachePath);
	cache.entries[key] = {
		boundaries: result.boundaries || [],
		duration: result.duration ?? null,
		engine: result.engine || null,
		wallMs: result.wallMs ?? null,
		createdAt: new Date().toISOString(),
	};
	cache.entries = pruneEntries(cache.entries);
	writeCache(cachePath, cache);
	return true;
}

module.exports = {
	CACHE_SCHEMA,
	CACHE_FILENAME,
	detectCachePath,
	detectCacheKey,
	fileIdentity,
	readCache,
	writeCache,
	getCachedDetect,
	setCachedDetect,
	pruneEntries,
};
