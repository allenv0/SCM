"use strict";

// Rename-duplicate smoke (ELECTRON_SMOKE_RENAMEDEDUPE=1 +
// RENAMEDEDUPE_TEST_DIR + an isolated MEMORIES_DATA_DIR). A file renamed
// inside a watched folder is a NEW source path (path-dedupe can't see it)
// but its bytes are already in the library — the content-hash dedupe must
// skip it instead of importing a duplicate copy. Genuinely new files still
// import, including same-content files from OTHER folders (the same photo
// exported anywhere is one copy in the library).
//
// Extracted from main.js verbatim (C-01); prod seams arrive via ctx.

const fs = require("fs");
const path = require("path");
const { solidJpg, ensureDir } = require("./helpers.js");

async function runRenameDedupeTest(ctx) {
	const { importPaths, loadLibrary, stopWatchedFolderWatchers } = ctx;
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("MEMORIES_DATA_DIR is required (test isolation)");
	}
	const root = process.env.RENAMEDEDUPE_TEST_DIR;
	if (!root) throw new Error("RENAMEDEDUPE_TEST_DIR is required");
	const folder = path.join(root, "watch-folder");
	ensureDir(folder);
	const gen = (dir, name, color) => solidJpg(dir, name, color, 48);

	await gen(folder, "photoA.jpg", [60, 120, 200]);
	const first = await importPaths([folder]);
	if (first.added.length !== 1 || first.added[0] !== "photoA.jpg") {
		throw new Error(`initial import wrong: ${JSON.stringify(first)}`);
	}
	stopWatchedFolderWatchers();

	// Rename photoA → photoB (same bytes, new path): the next sync must see
	// it as a duplicate by content hash — no copy, no "photoB (2).jpg".
	fs.renameSync(
		path.join(folder, "photoA.jpg"),
		path.join(folder, "photoB.jpg"),
	);
	const renamed = await importPaths([folder], { fromWatch: true });
	if (renamed.added.length !== 0 || renamed.errors.length !== 0) {
		throw new Error(
			`renamed file should be skipped, not imported: ${JSON.stringify(renamed)}`,
		);
	}
	if (!renamed.skipped.includes("photoB.jpg")) {
		throw new Error(
			`renamed file missing from skipped: ${JSON.stringify(renamed.skipped)}`,
		);
	}
	const l = loadLibrary();
	if (l.filenames.length !== 1 || l.filenames[0] !== "photoA.jpg") {
		throw new Error(
			`rename must not duplicate the row: ${JSON.stringify(l.filenames)}`,
		);
	}

	// A genuinely new file in the watched folder still imports.
	await gen(folder, "photoC.jpg", [200, 60, 60]);
	const added = await importPaths([folder], { fromWatch: true });
	if (added.added.length !== 1 || added.added[0] !== "photoC.jpg") {
		throw new Error(`new file should import: ${JSON.stringify(added)}`);
	}

	// The same content from a DIFFERENT folder is also a duplicate (the same
	// photo copied elsewhere hashes identically) — skipped.
	const other = path.join(root, "other");
	fs.mkdirSync(other, { recursive: true });
	fs.copyFileSync(
		path.join(folder, "photoB.jpg"),
		path.join(other, "photoD.jpg"),
	);
	const crossFolder = await importPaths([other], { fromWatch: true });
	if (
		crossFolder.added.length !== 0 ||
		!crossFolder.skipped.includes("photoD.jpg")
	) {
		throw new Error(
			`cross-folder duplicate should be skipped: ${JSON.stringify(crossFolder)}`,
		);
	}

	// And genuinely different content from another folder still imports.
	const other2 = path.join(root, "other2");
	fs.mkdirSync(other2, { recursive: true });
	await gen(other2, "photoE.jpg", [60, 200, 120]);
	const crossNew = await importPaths([other2], { fromWatch: true });
	if (crossNew.added.length !== 1 || crossNew.added[0] !== "photoE.jpg") {
		throw new Error(
			`new cross-folder file should import: ${JSON.stringify(crossNew)}`,
		);
	}
	if (loadLibrary().filenames.length !== 3) {
		throw new Error(
			`library should hold 3 rows: ${JSON.stringify(loadLibrary().filenames)}`,
		);
	}
	console.log(
		"[renamededupe] rename skipped by content hash; new + cross-folder-new files still import",
	);
}

module.exports = { runRenameDedupeTest };
