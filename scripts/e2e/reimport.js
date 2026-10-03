"use strict";

// Headless verification that re-importing already-imported files skips them
// (ELECTRON_SMOKE_REIMPORT=1 + REIMPORT_TEST_DIR + an isolated
// MEMORIES_DATA_DIR). Also proves a same-named file from a DIFFERENT folder
// is still imported — the source path, not the basename, decides.
//
// Extracted from main.js verbatim (C-01); prod seams arrive via ctx.

const path = require("path");
const { solidJpg, ensureDir } = require("./helpers.js");

async function runReimportTest(ctx) {
	const { importPaths, loadLibrary } = ctx;
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("MEMORIES_DATA_DIR is required (test isolation)");
	}
	const root = process.env.REIMPORT_TEST_DIR;
	if (!root) throw new Error("REIMPORT_TEST_DIR is required");

	const srcDir = path.join(root, "source");
	ensureDir(srcDir);
	await solidJpg(srcDir, "alpha.jpg", [60, 120, 200], 48);
	await solidJpg(srcDir, "beta.jpg", [60, 120, 200], 48);
	const paths = [path.join(srcDir, "alpha.jpg"), path.join(srcDir, "beta.jpg")];

	const first = await importPaths(paths);
	if (
		first.added.length !== 2 ||
		first.skipped.length !== 0 ||
		first.errors.length !== 0
	) {
		throw new Error(`first import wrong: ${JSON.stringify(first)}`);
	}

	const second = await importPaths(paths);
	if (
		second.added.length !== 0 ||
		second.skipped.length !== 2 ||
		second.errors.length !== 0
	) {
		throw new Error(
			`re-import should skip both files: ${JSON.stringify(second)}`,
		);
	}
	const l = loadLibrary();
	if (l.filenames.some((n) => n.includes(" (2)"))) {
		throw new Error(
			`renamed duplicate copies appeared: ${JSON.stringify(l.filenames)}`,
		);
	}
	console.log(
		`[reimport] same-folder re-import skipped both files (added=0, skipped=2)`,
	);

	// A different file that merely shares a basename must still import, and a
	// second import of IT must then be skipped.
	const otherDir = path.join(root, "other");
	ensureDir(otherDir);
	await solidJpg(otherDir, "alpha.jpg", [200, 60, 60], 48);
	const otherPath = path.join(otherDir, "alpha.jpg");
	const third = await importPaths([otherPath]);
	if (third.added.length !== 1 || third.skipped.length !== 0) {
		throw new Error(
			`same-basename different file should import: ${JSON.stringify(third)}`,
		);
	}
	const fourth = await importPaths([otherPath]);
	if (fourth.added.length !== 0 || fourth.skipped.length !== 1) {
		throw new Error(
			`second import of the other file should skip: ${JSON.stringify(fourth)}`,
		);
	}
	console.log(
		"[reimport] same-basename different file imports, then skips on re-import",
	);
}

module.exports = { runReimportTest };
