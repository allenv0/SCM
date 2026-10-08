"use strict";

// Unit tests for the delta-switch planner (planDeltaReuse + embed meta).
// Plain node, no Electron: initLibraryStore() points the module at a tmpdir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../main-lib/library-store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-delta-"));
store.initLibraryStore({ userDataDir: dir });

const MODEL = "delta-test-model";
const DIM = 4;
const vec = (base) =>
	new Float32Array([base + 1, base + 2, base + 3, base + 4]);

(async () => {
	// 1. No meta yet: unusable, everything missing.
	let plan = store.planDeltaReuse(MODEL, DIM, ["a.jpg"]);
	assert.equal(plan.usable, false, "no meta → unusable");
	assert.equal(plan.reason, "no-meta", "reason names the cause");
	assert.deepEqual(plan.missing, ["a.jpg"], "all rows missing");

	// Seed a 3-row library for the model (bins + meta via writeBins).
	const names3 = ["a.jpg", "b.jpg", "c.jpg"];
	await store.writeBins(
		MODEL,
		names3.map((_, i) => vec(i * 10)),
		names3.map((_, i) => vec(i * 10 + 100)),
		DIM,
		DIM,
		{ filenames: names3 },
	);
	const meta = store.readEmbedMeta(MODEL);
	assert.ok(meta, "meta written alongside bins");
	assert.equal(
		meta.codeVersion,
		store.EMBED_CODE_VERSION,
		"code version stamped",
	);
	assert.deepEqual(meta.filenames, names3, "snapshot records identity");
	assert.equal(meta.incomplete, false, "explicit write defaults to complete");

	// 2. Exact match: everything reused, nothing missing.
	plan = store.planDeltaReuse(MODEL, DIM, [...names3]);
	assert.equal(plan.usable, true, "matching snapshot → usable");
	assert.equal(plan.reused, 3, "all rows reused");
	assert.deepEqual(plan.missing, [], "nothing missing");
	assert.deepEqual(
		[...plan.reusedEmbeddings[1]],
		[...vec(10)],
		"reused rows align by identity",
	);

	// 3. Growth: one new file → only it is missing.
	plan = store.planDeltaReuse(MODEL, DIM, [...names3, "d.jpg"]);
	assert.equal(plan.usable, true, "growth still usable");
	assert.equal(plan.reused, 3, "old rows reused");
	assert.deepEqual(plan.missing, ["d.jpg"], "only the new file missing");
	assert.equal(plan.reusedEmbeddings[3], null, "missing slot is null");

	// 4. Delete: middle row removed → survivors reuse by identity.
	plan = store.planDeltaReuse(MODEL, DIM, ["a.jpg", "c.jpg"]);
	assert.equal(plan.usable, true, "shrink still usable");
	assert.equal(plan.reused, 2, "survivors reused");
	assert.deepEqual(plan.missing, [], "nothing missing after delete");
	assert.deepEqual(
		[...plan.reusedEmbeddings[1]],
		[...vec(20)],
		"c.jpg keeps its own vector, not b.jpg's",
	);

	// 5. Reorder: shuffled order reuses everything (no index-copy).
	plan = store.planDeltaReuse(MODEL, DIM, ["c.jpg", "a.jpg", "b.jpg"]);
	assert.equal(plan.usable, true, "reorder still usable");
	assert.equal(plan.reused, 3, "all rows reused across reorder");
	assert.deepEqual(
		[...plan.reusedEmbeddings[0]],
		[...vec(20)],
		"c.jpg first still maps to c.jpg's vector",
	);

	// 6. Zero-vector rows count as missing (failed rows self-heal).
	await store.writeBins(
		MODEL,
		[vec(0), new Float32Array(DIM), vec(20)],
		[vec(100), vec(110), vec(120)],
		DIM,
		DIM,
		{ filenames: names3 },
	);
	plan = store.planDeltaReuse(MODEL, DIM, [...names3]);
	assert.equal(plan.usable, true, "zero row doesn't poison the plan");
	assert.equal(plan.reused, 2, "zero row not reused");
	assert.deepEqual(plan.missing, ["b.jpg"], "zero row re-embeds");

	// 7. Pipeline version bump forces a full re-embed, never silent reuse.
	const metaFile = store.embedMetaFileFor(MODEL);
	const tampered = {
		...store.readEmbedMeta(MODEL),
		codeVersion: store.EMBED_CODE_VERSION + 1,
	};
	fs.writeFileSync(metaFile, JSON.stringify(tampered));
	plan = store.planDeltaReuse(MODEL, DIM, [...names3]);
	assert.equal(plan.usable, false, "version mismatch → unusable");
	assert.equal(plan.reason, "code-version", "reason names the cause");
	// Restore the valid snapshot for the remaining cases.
	await store.writeBins(
		MODEL,
		names3.map((_, i) => vec(i * 10)),
		names3.map((_, i) => vec(i * 10 + 100)),
		DIM,
		DIM,
		{ filenames: names3 },
	);

	// 8. Dim mismatch forces a full re-embed.
	plan = store.planDeltaReuse(MODEL, DIM + 1, [...names3]);
	assert.equal(plan.usable, false, "dim mismatch → unusable");
	assert.equal(plan.reason, "dim", "reason names the cause");

	// 9. Bins deleted out from under the snapshot → safe fallback.
	fs.unlinkSync(store.embedFileFor(MODEL));
	plan = store.planDeltaReuse(MODEL, DIM, [...names3]);
	assert.equal(plan.usable, false, "bin/meta divergence → unusable");
	assert.equal(plan.reason, "bin-meta-mismatch", "reason names the cause");

	// 10. readBinPartial is length-tolerant; readBin still quarantines rot.
	await store.writeBins(
		MODEL,
		[vec(0), vec(10)],
		[vec(100), vec(110)],
		DIM,
		DIM,
		{
			filenames: ["a.jpg", "b.jpg"],
		},
	);
	const partial = store.readBinPartial(store.embedFileFor(MODEL), DIM);
	assert.equal(partial.length, 2, "partial read returns all rows");
	fs.writeFileSync(store.embedFileFor("rot-model"), Buffer.from("12345"));
	const rotFile = store.embedFileFor("rot-model");
	assert.deepEqual(store.readBin(rotFile, 99, DIM), [], "rot reads empty");
	assert.ok(
		!fs.existsSync(rotFile) &&
			fs.readdirSync(path.dirname(rotFile)).some((f) => f.includes("corrupt")),
		"corrupt bin quarantined by readBin",
	);

	// 11. saveLibrary stamps the snapshot + incomplete flag for the active model.
	store.resetLibraryCaches();
	const l = store.loadLibrary();
	l.filenames.push("s1.jpg", "s2.jpg");
	l.sources.push("s1.jpg", "s2.jpg");
	l.embeddings.push(vec(0), vec(10));
	l.phrases.push(vec(100), vec(110));
	l.dim = DIM;
	store.setEmbedIncomplete(l.modelId, true);
	await store.saveLibrary();
	const libMeta = store.readEmbedMeta(l.modelId);
	assert.deepEqual(
		libMeta.filenames,
		["s1.jpg", "s2.jpg"],
		"saveLibrary snapshots live filenames",
	);
	assert.equal(libMeta.incomplete, true, "incomplete flag persists");
	store.setEmbedIncomplete(l.modelId, false);
	await store.saveLibrary();
	assert.equal(
		store.readEmbedMeta(l.modelId).incomplete,
		false,
		"completion clears the flag",
	);

	// 12. isZeroVector edge cases.
	assert.equal(store.isZeroVector(null), true, "null is zero");
	assert.equal(store.isZeroVector(new Float32Array(3)), true, "zeros are zero");
	assert.equal(store.isZeroVector(vec(0)), false, "nonzero is nonzero");

	console.log("delta-switch: all assertions passed");
})().catch((err) => {
	console.error(`delta-switch FAILED: ${err.stack || err.message}`);
	process.exitCode = 1;
});
