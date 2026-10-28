// The renderer index request is the hottest metadata path. It must not page
// the primary/phrase vectors into main just to report phraseDim; the header
// probe covers that, and the first actual ranking/bin read owns the load.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import * as store from "../main-lib/library-store.ts";
import { libraryBinsLoaded } from "../main-lib/store/index-core.ts";

test("loadLibrary stays metadata-only until vectors are actually read", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-lazy-bins-"));
	try {
		store.initLibraryStore({ userDataDir: dir });
		const first = store.loadLibrary();
		first.filenames = ["lazy.jpg"];
		first.sources = ["/tmp/lazy.jpg"];
		first.sourceMtimes = [null];
		first.ocr = [null];
		first.ocrWords = [null];
		first.hashes = [null];
		first.screenshotHints = [null];
		first.dim = 3;
		first.embeddings = [new Float32Array([0, 0, 1])];
		first.phrases = [new Float32Array([0, 1, 0])];
		await store.saveLibrary();

		store.resetLibraryCaches();
		const loaded = store.loadLibrary();
		assert.equal(loaded.filenames.length, 1);
		assert.equal(libraryBinsLoaded(), false, "boot does not load rows");

		const index = store.libraryIndex();
		assert.equal(index.phraseDim, 3, "phrase header is visible");
		assert.equal(
			libraryBinsLoaded(),
			false,
			"index metadata does not trigger a bin read",
		);

		const norms = store.libraryNorms();
		assert.equal(libraryBinsLoaded(), true, "ranking loads rows");
		assert.equal(norms?.length, 1);
		assert.deepEqual([...(loaded.embeddings[0] as Float32Array)], [0, 0, 1]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("lazy reads use the on-disk row count across filename mutations", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-lazy-mutate-"));
	try {
		store.initLibraryStore({ userDataDir: dir });
		const first = store.loadLibrary();
		first.filenames = ["a.jpg", "b.jpg"];
		first.sources = ["/tmp/a.jpg", "/tmp/b.jpg"];
		first.sourceMtimes = [null, null];
		first.ocr = [null, null];
		first.ocrWords = [null, null];
		first.hashes = [null, null];
		first.screenshotHints = [null, null];
		first.dim = 2;
		first.embeddings = [new Float32Array([1, 0]), new Float32Array([0, 1])];
		first.phrases = [new Float32Array([1, 0]), new Float32Array([0, 1])];
		await store.saveLibrary();
		store.resetLibraryCaches();

		// Simulate import ordering without an explicit materialize: append the
		// filename first, then touch the vector table. The disk still has two
		// rows, so the lazy read must not mistake the bin for three.
		const importing = store.loadLibrary();
		importing.filenames.push("c.jpg");
		importing.sources.push("/tmp/c.jpg");
		importing.embeddings.push(new Float32Array([1, 1]));
		importing.phrases.push(new Float32Array([1, 1]));
		assert.equal(importing.embeddings.length, 3);
		assert.deepEqual([...importing.embeddings[1]], [0, 1]);
		assert.deepEqual([...importing.embeddings[2]], [1, 1]);
		await store.saveLibrary();
		store.resetLibraryCaches();

		// Simulate delete ordering: shrink filenames first, then splice the
		// vector row. The lazy read sees the three-row disk state, then the
		// splice lands on the right row.
		const deleting = store.loadLibrary();
		deleting.filenames.splice(1, 1);
		deleting.sources.splice(1, 1);
		deleting.embeddings.splice(1, 1);
		deleting.phrases.splice(1, 1);
		assert.equal(deleting.embeddings.length, 2);
		assert.deepEqual([...deleting.embeddings[0]], [1, 0]);
		assert.deepEqual([...deleting.embeddings[1]], [1, 1]);
		await store.saveLibrary();
		store.resetLibraryCaches();

		const reloaded = store.loadLibrary();
		assert.equal(reloaded.filenames.length, 2);
		assert.deepEqual([...reloaded.embeddings[1]], [1, 1]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
