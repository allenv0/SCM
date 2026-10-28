// A metadata-only save (timestamp backfill, OCR revision, stale-row prune)
// must not encode an empty in-memory table over the only good bin on disk.
// This is the C-05-adjacent failure mode: one failed/misaligned read followed
// by an unrelated save used to destroy the library's vectors.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import * as store from "../main-lib/library-store.ts";

test("saveLibrary keeps on-disk bins when the in-memory table is missing", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-save-guard-"));
	try {
		store.initLibraryStore({ userDataDir: dir });
		const first = store.loadLibrary();
		first.filenames = ["guard.jpg"];
		first.dim = 3;
		first.embeddings = [new Float32Array([0.25, 0.5, 0.75])];
		first.phrases = [new Float32Array([0.1, 0.2, 0.3])];
		await store.saveLibrary();

		const embedFile = store.embedFileFor(first.modelId);
		const before = fs.readFileSync(embedFile);
		assert.equal(store.readBin(embedFile, 1, 3).length, 1, "bin written");

		// Simulate loadLibrary's misalignment recovery: filenames survive,
		// vectors do not. An unrelated metadata save follows.
		store.resetLibraryCaches();
		const after = store.loadLibrary();
		assert.equal(after.filenames.length, 1);
		after.embeddings = [];
		after.phrases = [];
		await store.saveLibrary();

		const preserved = fs.readFileSync(embedFile);
		assert.deepEqual(preserved, before, "save must not rewrite the bin");
		assert.equal(
			store.readBin(embedFile, 1, 3).length,
			1,
			"the original row is still readable",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
