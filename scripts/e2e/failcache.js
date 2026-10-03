"use strict";

// Poison-file failure-cache smoke (ELECTRON_SMOKE_FAILCACHE=1 +
// FAILCACHE_TEST_DIR + an isolated MEMORIES_DATA_DIR). A file that can never
// embed (garbage bytes with a media extension) must not be re-copied + re-
// attempted on every watch sync forever: after MAX_IMPORT_FAILURES identical
// failures the sync skips it entirely (no copy, no embed), a CHANGED file is
// retried (size/mtime invalidation), and a MANUAL re-import always bypasses
// the cache (the user explicitly asked for a fresh attempt).
//
// Extracted from main.js verbatim (C-01); prod seams arrive via ctx.

const fs = require("fs");
const path = require("path");
const { solidJpg, ensureDir } = require("./helpers.js");

async function runFailureCacheTest(ctx) {
	const {
		importPaths,
		loadLibrary,
		stopWatchedFolderWatchers,
		FAILED_IMPORTS_FILE,
	} = ctx;
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("MEMORIES_DATA_DIR is required (test isolation)");
	}
	const root = process.env.FAILCACHE_TEST_DIR;
	if (!root) throw new Error("FAILCACHE_TEST_DIR is required");
	const folder = path.join(root, "failcache-folder");
	ensureDir(folder);
	const poison = path.join(folder, "poison.jpg");
	await solidJpg(folder, "good.jpg", [60, 120, 200], 48);
	// Garbage bytes with a photo extension: passes the extension check, then
	// fails to decode — a file-level embed failure (never a system error, so
	// it is remembered, not excluded).
	fs.writeFileSync(
		poison,
		Buffer.from("definitely-not-a-real-jpeg-" + "x".repeat(512)),
	);
	const poisonBase = path.basename(poison);
	const failures = () => {
		const parsed = JSON.parse(fs.readFileSync(FAILED_IMPORTS_FILE, "utf8"));
		return parsed.failed || {};
	};

	// Phase A — manual import: the good file imports, the poison file fails
	// and is remembered (count 1); the folder auto-watches.
	const first = await importPaths([folder]);
	if (first.added.length !== 1 || first.added[0] !== "good.jpg") {
		throw new Error(`initial import wrong: ${JSON.stringify(first)}`);
	}
	if (first.errors.length !== 1 || first.errors[0].file !== poisonBase) {
		throw new Error(
			`poison file should error on import: ${JSON.stringify(first.errors)}`,
		);
	}
	if (failures()[poison]?.count !== 1) {
		throw new Error(
			`failure cache count should be 1: ${JSON.stringify(failures()[poison])}`,
		);
	}
	// The live watcher would react to the folder's own file changes below —
	// stop it so every sync below is the explicit fromWatch call (deterministic).
	stopWatchedFolderWatchers();

	// Phases B + C — two more fromWatch syncs: still under the retry budget,
	// so the poison file is attempted (and fails) again — count 2, then 3.
	for (const expectCount of [2, 3]) {
		const r = await importPaths([folder], { fromWatch: true });
		if (r.added.length !== 0)
			throw new Error(`unexpected add: ${JSON.stringify(r)}`);
		if (r.errors.length !== 1 || r.errors[0].file !== poisonBase) {
			throw new Error(
				`sync (count ${expectCount}) should attempt poison: ${JSON.stringify(r)}`,
			);
		}
		if (failures()[poison]?.count !== expectCount) {
			throw new Error(
				`failure cache count should be ${expectCount}: ${JSON.stringify(failures()[poison])}`,
			);
		}
	}

	// Phase D — retry budget exhausted: the sync SKIPS the poison file (no
	// copy, no embed) and the good file is skipped by path-dedupe.
	const skipped = await importPaths([folder], { fromWatch: true });
	if (skipped.added.length !== 0 || skipped.errors.length !== 0) {
		throw new Error(
			`poison file should be skipped at budget: ${JSON.stringify(skipped)}`,
		);
	}
	if (
		!skipped.skipped.includes(poisonBase) ||
		!skipped.skipped.includes("good.jpg")
	) {
		throw new Error(`skipped list wrong: ${JSON.stringify(skipped.skipped)}`);
	}
	if (loadLibrary().filenames.includes(poisonBase)) {
		throw new Error("poison file must never land in the library");
	}

	// Phase E — a MANUAL re-import bypasses the cache (fresh attempt) and
	// fails again; the count keeps climbing (still the same bytes).
	const manual = await importPaths([poison]);
	if (manual.errors.length !== 1 || manual.errors[0].file !== poisonBase) {
		throw new Error(
			`manual re-import must bypass the cache: ${JSON.stringify(manual)}`,
		);
	}
	if (failures()[poison]?.count !== 4) {
		throw new Error(
			`failure cache count should be 4 after manual retry: ${JSON.stringify(failures()[poison])}`,
		);
	}

	// Phase F — the file CHANGED (different size + bytes): the entry is
	// invalidated, the next sync retries it (fails again), count resets to 1.
	fs.writeFileSync(poison, Buffer.alloc(4096, 0xab));
	const retried = await importPaths([folder], { fromWatch: true });
	if (retried.errors.length !== 1 || retried.errors[0].file !== poisonBase) {
		throw new Error(
			`changed poison file must be retried: ${JSON.stringify(retried)}`,
		);
	}
	if (failures()[poison]?.count !== 1) {
		throw new Error(
			`changed file should reset the failure count: ${JSON.stringify(failures()[poison])}`,
		);
	}
	console.log(
		"[failcache] poison file: 3 attempts → skipped, manual re-import bypasses, change re-triggers retry",
	);
}

module.exports = { runFailureCacheTest };
