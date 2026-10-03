"use strict";

// Import-failure cache (C-01 Wave 2, slice S2).
// Remembers files that failed to import (keyed by source path + size/mtime)
// so watched-folder events and polls skip them until they CHANGE. Storage
// root arrives via initFailedImports() — main.js calls it after the
// MEMORIES_DATA_DIR override. No electron dependency (plain-node tested).

const fs = require("fs");
const path = require("path");

let DATA_DIR = null;
function initFailedImports({ dataDir }) {
	DATA_DIR = dataDir;
}
const failedImportsFile = () => path.join(DATA_DIR, "failed-imports.json");

// ---------------------------------------------------------------------------
// Import-failure cache.
//
// A file in a watched folder that can never embed (corrupt/truncated media,
// an unsupported codec, an embed that always times out) would otherwise be
// re-copied and re-attempted on every fs event and every 60s poll forever,
// monopolizing the single-writer pipeline and pausing enrichment/OCR. Each
// failure is remembered here keyed by source path + size/mtime; after
// MAX_IMPORT_FAILURES identical attempts the file is skipped until it CHANGES
// (a file that was mid-write gets its size/mtime bumped, invalidating the
// entry and retrying — so this never permanently strands a recoverable file).
// ---------------------------------------------------------------------------

const MAX_IMPORT_FAILURES = 3;
let failedImports = null;
let failedImportsDirty = false;

function loadFailedImports() {
	if (failedImports) return failedImports;
	try {
		const parsed = JSON.parse(fs.readFileSync(failedImportsFile(), "utf8"));
		failedImports =
			parsed && parsed.failed && typeof parsed.failed === "object"
				? parsed.failed
				: {};
	} catch {
		failedImports = {};
	}
	// Prune entries whose source no longer exists (the file was deleted or
	// the folder unwatched) so the cache can't grow without bound.
	for (const p of Object.keys(failedImports)) {
		if (!fs.existsSync(p)) delete failedImports[p];
	}
	return failedImports;
}

// Fresh-start wipe: forget every remembered failure (memory + disk) so a
// re-imported file gets a clean evaluation instead of a cached skip.
function clearFailedImports() {
	failedImports = {};
	failedImportsDirty = true;
	saveFailedImports();
}

function saveFailedImports() {
	if (!failedImportsDirty) return;
	failedImportsDirty = false;
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.writeFileSync(
			failedImportsFile(),
			JSON.stringify({ version: 1, failed: failedImports }, null, "\t"),
		);
	} catch (err) {
		console.warn(`[memories] failed-imports save failed: ${err.message}`);
	}
}

// System-wide indexer failures (worker crashed, pool gone, model down) are
// transient and hit EVERY file in a batch — caching them would poison the
// whole library until each file changed. Only file-level failures (corrupt
// media, embed timeouts, copy stalls) are remembered.
function isSystemIndexerError(err) {
	const msg = err && err.message ? err.message : "";
	return (
		msg.startsWith("Indexer not running") ||
		msg.startsWith("Indexer exited") ||
		msg.startsWith("AI indexing unavailable")
	);
}

// Record a file that failed to import (stamped with its current size/mtime so
// a later change invalidates the entry and allows a retry).
function rememberImportFailure(filePath) {
	try {
		const st = fs.statSync(filePath);
		const rec = loadFailedImports()[filePath];
		loadFailedImports()[filePath] = {
			// Count consecutive failures of the UNCHANGED file; a changed file
			// (or a missing entry) restarts at 1.
			count:
				rec && rec.size === st.size && rec.mtimeMs === st.mtimeMs
					? (rec.count || 0) + 1
					: 1,
			size: st.size,
			mtimeMs: st.mtimeMs,
		};
		failedImportsDirty = true;
		saveFailedImports();
	} catch {
		/* unreadable — nothing to remember */
	}
}

// True when the file has failed MAX_IMPORT_FAILURES times UNCHANGED — skip it
// without copying. A changed file clears its entry (the retry may run).
function isKnownImportFailure(filePath) {
	const rec = loadFailedImports()[filePath];
	if (!rec) return false;
	try {
		const st = fs.statSync(filePath);
		if (st.size === rec.size && st.mtimeMs === rec.mtimeMs) {
			return (rec.count || 0) >= MAX_IMPORT_FAILURES;
		}
	} catch {
		/* file vanished — fall through to clearing */
	}
	delete loadFailedImports()[filePath];
	failedImportsDirty = true;
	saveFailedImports();
	return false;
}

// A successful import retires any failure-cache entry for the file
// (it was transient after all — the cache is only for poison files).
function retireImportFailure(filePath) {
	const cache = loadFailedImports();
	if (cache && cache[filePath]) {
		delete cache[filePath];
		failedImportsDirty = true;
		saveFailedImports();
	}
}

module.exports = {
	initFailedImports,
	failedImportsFile,
	MAX_IMPORT_FAILURES,
	loadFailedImports,
	saveFailedImports,
	clearFailedImports,
	isSystemIndexerError,
	rememberImportFailure,
	isKnownImportFailure,
	retireImportFailure,
};
