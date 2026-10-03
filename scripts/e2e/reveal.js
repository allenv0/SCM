"use strict";

// Headless verification of the lightbox "Show in Finder" resolution logic.
// Two app launches share REVEAL_TEST_DIR and MEMORIES_DATA_DIR (the user
// scenario: import a photo, move the original away, reopen the app):
//   import — generates + imports a photo, asserts the reveal target is the
//            original source path (it still exists on disk).
//   verify — after the source was moved away, asserts the reveal target falls
//            back to the app-managed library copy, that unknown filenames /
//            path traversal resolve to null, and that a library item whose
//            copy is also gone resolves to null. shell.showItemInFolder is
//            intentionally never called here — the resolver under test is
//            what decides WHICH file Finder would reveal.
//
// Extracted from main.js verbatim (C-01); prod seams arrive via ctx.

const fs = require("fs");
const path = require("path");
const { solidJpg, ensureDir } = require("./helpers.js");

async function runRevealTest(ctx) {
	const { importPaths, resolveRevealTarget, PHOTOS_DIR } = ctx;
	const mode = process.env.ELECTRON_SMOKE_REVEAL;
	const root = process.env.REVEAL_TEST_DIR;
	// This test imports into the library, so it must never run against the
	// user's real data directory — the orchestrator always sets a temp one.
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("MEMORIES_DATA_DIR is required (test isolation)");
	}
	if (!root) throw new Error("REVEAL_TEST_DIR is required");
	const srcDir = path.join(root, "source");
	const srcFile = path.join(srcDir, "fallback-test.jpg");
	const libCopy = path.join(PHOTOS_DIR, "fallback-test.jpg");

	if (mode === "import") {
		ensureDir(srcDir);
		await solidJpg(srcDir, "fallback-test.jpg", [30, 90, 200]);
		const res = await importPaths([srcFile]);
		if (res.added.length !== 1) {
			throw new Error(`import failed: ${JSON.stringify(res)}`);
		}
		const target = resolveRevealTarget("fallback-test.jpg");
		if (target !== srcFile) {
			throw new Error(`expected reveal of source path, got ${target}`);
		}
		if (!fs.existsSync(target))
			throw new Error(`source target missing: ${target}`);
		console.log(
			`[reveal] import phase OK — reveal targets the source: ${target}`,
		);
		return;
	}

	if (mode === "verify") {
		// The orchestrating shell moved the source away between launches.
		if (fs.existsSync(srcFile)) {
			throw new Error(
				"test setup: source file must be moved before the verify launch",
			);
		}
		if (!fs.existsSync(path.join(srcDir, "moved-away.jpg"))) {
			throw new Error(
				"test setup: moved-away.jpg missing (was the source moved?)",
			);
		}
		if (!fs.existsSync(libCopy)) {
			throw new Error(`test setup: library copy missing: ${libCopy}`);
		}
		const target = resolveRevealTarget("fallback-test.jpg");
		if (target !== libCopy) {
			throw new Error(`expected library-copy fallback, got ${target}`);
		}
		console.log(
			`[reveal] verify phase OK — fell back to the library copy: ${target}`,
		);

		// Untrusted or unknown filenames must never resolve to a reveal target.
		if (resolveRevealTarget("../../etc/passwd") !== null) {
			throw new Error("path traversal was not rejected");
		}
		if (resolveRevealTarget("not-in-library.jpg") !== null) {
			throw new Error("unknown filename was not rejected");
		}

		// With the source moved AND the library copy deleted, nothing can be
		// revealed — the resolver must say so instead of guessing.
		fs.unlinkSync(libCopy);
		if (resolveRevealTarget("fallback-test.jpg") !== null) {
			throw new Error("expected null when both source and copy are gone");
		}
		console.log("[reveal] rejection + gone-file OK");
		return;
	}

	throw new Error(`unknown ELECTRON_SMOKE_REVEAL mode: ${mode}`);
}

module.exports = { runRevealTest };
