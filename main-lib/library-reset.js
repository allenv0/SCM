"use strict";

// Fresh-start wipe (Settings → Library → danger zone): file-level half of
// deleting the entire photo index. Removes library-state files and empties
// the app-managed content dirs; everything else in DATA_DIR survives
// (settings.json, watched-folders.json, memory-models.json,
// memory-queries.json, versions/, models/, ocr-data/, llm/). Queue
// draining, watcher teardown, in-memory cache resets, and the idle gate
// live in main.js — this module only touches the disk, so plain-node unit
// tests can drive it against a tmpdir.

const fs = require("fs");
const path = require("path");

let DATA_DIR = null;
function initLibraryReset({ dataDir }) {
	DATA_DIR = dataDir;
}

// Library-state filenames in DATA_DIR that a reset removes.
function resettableFileNames() {
	const exact = new Set([
		"memories-index.json",
		"failed-imports.json",
		"category-overrides.json",
		"memory-embeddings.bin",
		"memory-phrase-embeddings.bin",
	]);
	const prefixes = [
		"memory-embeddings-",
		"memory-phrase-embeddings-",
		"memory-segments-",
		"memory-segment-embeddings-",
		"memory-transcripts-",
		"memory-transcript-embeddings-",
	];
	const out = [];
	let entries;
	try {
		entries = fs.readdirSync(DATA_DIR);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (
			exact.has(entry) ||
			prefixes.some((p) => entry.startsWith(p)) ||
			/^memory-.*\.tmp-/.test(entry)
		) {
			out.push(entry);
		}
	}
	return out;
}

// Best-effort unlink; true when something was removed.
function unlinkBestEffort(file) {
	try {
		if (!fs.statSync(file).isFile()) return false;
	} catch {
		return false;
	}
	try {
		fs.unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

// Empty a directory's CONTENTS (files and subdirs), keeping the directory
// itself — producers (loadLibrary, poster/thumb writers) mkdir on use.
function emptyDirContents(dir) {
	let removed = 0;
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		try {
			fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
			removed++;
		} catch {
			/* keep going — the result reports the shortfall */
		}
	}
	return removed;
}

// Delete every resettable file + empty the app-managed content dirs.
// Returns { files } — the count actually removed.
function resetLibraryFiles() {
	let files = 0;
	for (const name of resettableFileNames()) {
		if (unlinkBestEffort(path.join(DATA_DIR, name))) files++;
	}
	for (const sub of ["photos", "posters", "thumbs"]) {
		files += emptyDirContents(path.join(DATA_DIR, sub));
	}
	return { files };
}

module.exports = {
	initLibraryReset,
	resettableFileNames,
	resetLibraryFiles,
};
