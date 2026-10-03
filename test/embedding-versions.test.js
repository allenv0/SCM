"use strict";

// Unit tests for main-lib/embedding-versions.js (named embedding versions).
// Plain node, no Electron: initEmbeddingVersions() points the module at a
// tmpdir holding a fake library dir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const V = require("../main-lib/embedding-versions.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-versions-"));
V.initEmbeddingVersions({ userDataDir: dir });
const lib = path.join(dir, "library");
const photos = path.join(lib, "photos");
fs.mkdirSync(photos, { recursive: true });

const index = { images: ["a.jpg", "b.mp4"], modelId: "clip-vit-l14-336" };
function seedLive(images) {
	fs.writeFileSync(
		path.join(lib, "memories-index.json"),
		JSON.stringify({ images, modelId: "clip-vit-l14-336" }),
	);
	fs.writeFileSync(path.join(lib, "memory-models.json"), "{}");
	for (const f of images) fs.writeFileSync(path.join(photos, f), "x");
}
seedLive(["a.jpg", "b.mp4"]);

// slugify: lowercase, dash-joined, capped, bare punctuation rejected.
assert.equal(V.slugifyName("  Hello WORLD!!  "), "hello-world");
assert.equal(V.slugifyName("!!!"), "");

// create: happy path + manifest contents.
let r = V.createVersion({
	name: "First take",
	appVersion: "9.9",
	settings: { videoQuality: "balanced" },
	index,
});
assert.equal(r.ok, true);
assert.equal(r.slug, "first-take");
assert.ok(r.totalBytes > 0);
assert.equal(V.listVersions().length, 1);
assert.equal(V.listVersions()[0].rowCount, 2);
assert.equal(V.listVersions()[0].name, "First take");

// create: duplicate name (case-insensitive slug) refused.
assert.match(
	V.createVersion({ name: "FIRST take", index }).error,
	/already exists/,
);
// create: garbage / empty / overlong names refused.
assert.match(
	V.createVersion({ name: "!!!", index }).error,
	/letters or numbers/,
);
assert.match(V.createVersion({ name: "  ", index }).error, /Name the version/);
assert.match(
	V.createVersion({ name: "x".repeat(200), index }).error,
	/under 80/,
);
// Failed creates leave no directory behind.
assert.ok(!fs.existsSync(path.join(lib, "versions", "x".repeat(60))));

// Corrupt manifests are skipped by list (a crash mid-copy leaves a
// manifest-less dir — also skipped).
fs.mkdirSync(path.join(lib, "versions", "half-written"), { recursive: true });
fs.writeFileSync(path.join(lib, "versions", "broken"), "not a dir either");
fs.mkdirSync(path.join(lib, "versions", "corrupt"), { recursive: true });
fs.writeFileSync(
	path.join(lib, "versions", "corrupt", "manifest.json"),
	"{nope",
);
assert.equal(V.listVersions().length, 1);

// rename: keeps slug, refuses foreign collisions and garbage.
assert.deepEqual(V.renameVersion("first-take", "Second take"), { ok: true });
assert.equal(V.listVersions()[0].name, "Second take");
V.createVersion({ name: "Other", index });
assert.match(V.renameVersion("first-take", "Other").error, /already named/);
assert.match(V.renameVersion("nope", "X").error, /no longer exists/);
assert.match(V.renameVersion("first-take", "  ").error, /Name the version/);

// restore: live mutation is overwritten; missing files reported.
seedLive(["c.jpg"]);
let restored = V.restoreVersion("first-take", photos);
assert.equal(restored.ok, true);
assert.deepEqual(restored.missing, []);
assert.deepEqual(
	JSON.parse(fs.readFileSync(path.join(lib, "memories-index.json"), "utf8"))
		.images,
	["a.jpg", "b.mp4"],
);
// A row whose app copy is gone restores as a reported ghost.
fs.unlinkSync(path.join(photos, "b.mp4"));
restored = V.restoreVersion("first-take", photos);
assert.equal(restored.ok, true);
assert.deepEqual(restored.missing, ["b.mp4"]);
// Unknown slugs refuse.
assert.match(V.restoreVersion("ghost", photos).error, /no longer exists/);
assert.match(V.deleteVersion("ghost").error, /no longer exists/);

// Cap: refuses past MAX_VERSIONS with the remedy named.
V.deleteVersion("first-take");
const keep = V.listVersions().length; // "Other" remains
for (let i = 0; i < V.MAX_VERSIONS - keep; i++) {
	const created = V.createVersion({ name: `v${i}`, index });
	assert.equal(created.ok, true, `seed ${i} should succeed`);
}
const capped = V.createVersion({ name: "one-too-many", index });
assert.equal(capped.ok, false);
assert.match(capped.error, /delete one first/);

// delete: frees the directory immediately.
assert.deepEqual(V.deleteVersion("v0"), { ok: true });
assert.ok(!fs.existsSync(path.join(lib, "versions", "v0")));

console.log("embedding-versions: all assertions passed");
