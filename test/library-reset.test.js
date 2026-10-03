"use strict";

// Unit tests for main-lib/library-reset.js (fresh-start wipe).
// Plain node, no Electron: initLibraryReset() points the module at a
// tmpdir holding a fake library dir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const R = require("../main-lib/library-reset.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-reset-"));
R.initLibraryReset({ dataDir: dir });

// Library state that must go…
const doomed = [
	"memories-index.json",
	"failed-imports.json",
	"category-overrides.json",
	"memory-embeddings.bin",
	"memory-phrase-embeddings.bin",
	"memory-embeddings-clip-vit-l14-336.bin",
	"memory-phrase-embeddings-clip-vit-l14-336.bin",
	"memory-segments-clip-vit-l14-336.json",
	"memory-segment-embeddings-clip-vit-l14-336.bin",
	"memory-transcripts-clip-vit-l14-336.json",
	"memory-transcript-embeddings-clip-vit-l14-336.bin",
	"memory-embeddings-clip-vit-l14-336.bin.tmp-123-4",
];
for (const f of doomed) fs.writeFileSync(path.join(dir, f), "x");
for (const sub of ["photos", "posters", "thumbs"]) {
	fs.mkdirSync(path.join(dir, sub), { recursive: true });
	fs.writeFileSync(path.join(dir, sub, "a.jpg"), "x");
	fs.mkdirSync(path.join(dir, sub, "nested"), { recursive: true });
	fs.writeFileSync(path.join(dir, sub, "nested", "b.jpg"), "x");
}
// …and everything that must survive.
const kept = [
	"settings.json",
	"watched-folders.json",
	"memory-models.json",
	"memory-queries.json",
	"unrelated.txt",
];
for (const f of kept) fs.writeFileSync(path.join(dir, f), "x");
fs.mkdirSync(path.join(dir, "versions", "v1"), { recursive: true });
fs.writeFileSync(path.join(dir, "versions", "v1", "manifest.json"), "{}");
fs.mkdirSync(path.join(dir, "models"), { recursive: true });
fs.writeFileSync(path.join(dir, "models", "weights.onnx"), "x");

const { files } = R.resetLibraryFiles();
// 12 root files + 2 entries × 3 content dirs (file + nested dir each).
assert.equal(files, 12 + 6);

// Doomed files are gone…
for (const f of doomed) {
	assert.ok(!fs.existsSync(path.join(dir, f)), `${f} should be deleted`);
}
// …content dirs are empty but still standing…
for (const sub of ["photos", "posters", "thumbs"]) {
	assert.ok(fs.statSync(path.join(dir, sub)).isDirectory());
	assert.deepEqual(fs.readdirSync(path.join(dir, sub)), []);
}
// …and everything else survived.
for (const f of kept) {
	assert.ok(fs.existsSync(path.join(dir, f)), `${f} should survive`);
}
assert.ok(fs.existsSync(path.join(dir, "versions", "v1", "manifest.json")));
assert.ok(fs.existsSync(path.join(dir, "models", "weights.onnx")));

// Idempotent: a second run removes nothing and throws nothing.
assert.deepEqual(R.resetLibraryFiles(), { files: 0 });

// Missing data dir: removes nothing, throws nothing.
R.initLibraryReset({ dataDir: path.join(dir, "nope") });
assert.deepEqual(R.resetLibraryFiles(), { files: 0 });

console.log("library-reset: all assertions passed");
