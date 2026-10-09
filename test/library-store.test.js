"use strict";

// Unit tests for main-lib/library-store.js (C-01 Wave 2, slice S4).
// Plain node, no Electron: initLibraryStore() points the module at a tmpdir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../main-lib/library-store.js");
const {
	MODELS,
	DEFAULT_MODEL_ID,
	getRetiredModelMigration,
	resolveModelId,
} = require("../indexer/models.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-libstore-"));
store.initLibraryStore({ userDataDir: dir });

const MODEL = "test-model";

(async () => {
	// Fresh library, save, reset, re-read from disk.
	const l = store.loadLibrary();
	assert.ok(l && Array.isArray(l.filenames), "fresh library loads");
	assert.equal(l.filenames.length, 0, "fresh library is empty");
	l.filenames.push("a.jpg");
	l.sources.push(path.join(dir, "a.jpg"));
	await store.saveLibrary();
	store.resetLibraryCaches();
	const l2 = store.loadLibrary();
	assert.deepEqual(l2.filenames, ["a.jpg"], "library persists across reset");

	// Path helpers derive from the init root.
	assert.equal(
		store.embedFileFor(MODEL),
		path.join(dir, "library", `memory-embeddings-${MODEL}.bin`),
	);
	assert.equal(
		store.thumbFor("sub/b.png"),
		path.join(dir, "library", "thumbs", "b.jpg"),
	);

	// Segments + transcripts round-trip through reset.
	const segs = store.loadSegments(MODEL);
	assert.equal(segs.loaded, false, "segments start unloaded");
	await store.saveSegments();
	store.resetLibraryCaches();
	assert.equal(
		store.loadSegments(MODEL).modelId,
		MODEL,
		"segments reload for the model",
	);
	const tr = store.loadTranscripts(MODEL);
	assert.ok(tr && tr.videos instanceof Map, "transcripts load");
	store.resetTranscriptsFor("missing.jpg"); // no-op, must not throw
	store.removeTranscriptsFor("missing.jpg"); // no-op, must not throw
	await store.saveTranscripts();
	store.removeSegmentsFor("missing.jpg"); // no-op, must not throw

	// Model state + thresholds + bin info on an empty store.
	store.saveModelState();
	assert.equal(store.thresholdsFor("no-such-model"), null);
	assert.equal(store.binInfo(MODEL), null);
	assert.deepEqual([...store.libraryNorms()], [], "norms of an empty library");
	assert.deepEqual(store.loadSampleQueries(), { queries: [] });

	// encodeBin header layout pins [count, dim] Int32s.
	const buf = store.encodeBin([new Float32Array([1, 2, 3])], 3);
	const header = new Int32Array(buf.buffer, buf.byteOffset, 2);
	assert.deepEqual([...header], [1, 3]);

	// fileMtimeMs never throws (missing file -> null-ish).
	assert.doesNotThrow(() => store.fileMtimeMs(path.join(dir, "nope.jpg")));

	// cosine still works from its new home.
	assert.equal(store.cosine([1, 0], [1, 0]), 1);

	// MobileCLIP is retired from the live registry but must still be
	// recognized long enough to trigger a safe re-embed. A plain fallback to
	// CLIP would pair its old 512-d vectors with CLIP's 768-d query vectors.
	assert.equal(DEFAULT_MODEL_ID, "clip-vit-l14-336");
	assert.equal(MODELS["mobileclip2-s2"], undefined);
	assert.deepEqual(getRetiredModelMigration("mobileclip2-s2"), {
		targetId: "clip-vit-l14-336",
	});
	assert.equal(resolveModelId("mobileclip2-s2"), DEFAULT_MODEL_ID);

	const indexFile = path.join(dir, "library", "memories-index.json");
	fs.writeFileSync(
		indexFile,
		JSON.stringify({
			version: 4,
			modelId: "mobileclip2-s2",
			dim: 512,
			images: ["mobileclip-legacy.jpg"],
			textMean: new Array(512).fill(0),
		}),
	);
	store.resetLibraryCaches();
	const retired = store.loadLibrary();
	assert.equal(retired.modelId, DEFAULT_MODEL_ID);
	assert.deepEqual(retired.pendingModelMigration, {
		fromId: "mobileclip2-s2",
		targetId: DEFAULT_MODEL_ID,
	});
	assert.equal(retired.embeddings.length, 0);
	assert.equal(retired.phrases.length, 0);
	assert.equal(retired.textMean, null);
	await store.saveLibrary();
	assert.equal(
		JSON.parse(fs.readFileSync(indexFile, "utf8")).modelId,
		"mobileclip2-s2",
		"loading or startup maintenance must not overwrite the old index before re-embedding succeeds",
	);

	// Persist-drain semantics (quitSmoke + will-quit rely on it; the
	// warm→cold smoke caught stranded saves): fire several saves WITHOUT
	// awaiting, drain via the enqueuePersist noop, then the on-disk pair
	// must reflect every save — bin header and meta total agree, every
	// offset lands inside the bin, no .tmp litter left behind.
	{
		const DRAIN_MODEL = "drain-test-model";
		const dc = store.loadSegments(DRAIN_MODEL);
		dc.loaded = true;
		dc.dim = 4;
		dc.rows = [];
		dc.videos = new Map();
		for (let round = 0; round < 3; round++) {
			const base = dc.rows.length;
			const segsArr = [];
			for (let i = 0; i < 5; i++) {
				dc.rows.push(new Float32Array([round, i, 0, 1]));
				segsArr.push({ t: i, dur: 1, off: base + i, n: 1 });
			}
			dc.videos.set(`clip-${round}.mp4`, segsArr);
			store.saveSegments(); // deliberately unawaited: the drain must cover it
		}
		await store.enqueuePersist(() => {});
		const binFile = store.segmentsBinFileFor(DRAIN_MODEL);
		const bin = fs.readFileSync(binFile);
		const h = new Int32Array(bin.buffer, bin.byteOffset, 2);
		assert.equal(h[0], 15, "drained bin holds all three saves");
		store.resetLibraryCaches();
		const re = store.loadSegments(DRAIN_MODEL);
		assert.equal(re.videos.size, 3, "drained meta holds all three clips");
		const offs = [...re.videos.values()].flat().map((s) => s.off);
		assert.equal(new Set(offs).size, 15, "offsets unique after drain");
		assert.ok(
			offs.every((o) => o >= 0 && o < h[0]),
			"every offset lands inside the drained bin",
		);
		const tmps = fs
			.readdirSync(path.join(dir, "library"))
			.filter((f) => f.includes(".tmp-"));
		assert.deepEqual(tmps, [], "no tmp litter after drained saves");
	}

	console.log("library-store: all assertions passed");
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
