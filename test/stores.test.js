"use strict";

// Unit tests for main-lib/failed-imports.js (C-01 Wave 2, slice S2) and
// main-lib/category-overrides.js (slice S3). Plain node, no Electron.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const failed = require("../main-lib/failed-imports.js");
const cto = require("../main-lib/category-overrides.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-stores-"));
failed.initFailedImports({ dataDir: dir });
cto.initCategoryOverrides({ dataDir: dir });

// ---- failed imports ----
assert.deepEqual(failed.loadFailedImports(), {});
assert.equal(
	failed.isSystemIndexerError(new Error("Indexer not running")),
	true,
);
assert.equal(failed.isSystemIndexerError(new Error("Indexer exited 1")), true);
assert.equal(
	failed.isSystemIndexerError(new Error("AI indexing unavailable")),
	true,
);
assert.equal(failed.isSystemIndexerError(new Error("corrupt jpeg")), false);
assert.equal(failed.isSystemIndexerError(null), false);

const poison = path.join(dir, "poison.jpg");
fs.writeFileSync(poison, "junk");
assert.equal(failed.isKnownImportFailure(poison), false); // no entry yet
failed.rememberImportFailure(poison);
failed.rememberImportFailure(poison);
assert.equal(failed.isKnownImportFailure(poison), false); // 2 < 3
failed.rememberImportFailure(poison);
assert.equal(failed.isKnownImportFailure(poison), true); // 3 identical
// A changed file invalidates the entry (size bump).
fs.writeFileSync(poison, "junk-junk-junk");
assert.equal(failed.isKnownImportFailure(poison), false);
// A successful import retires the entry.
failed.rememberImportFailure(poison);
failed.retireImportFailure(poison);
assert.equal(failed.isKnownImportFailure(poison), false);
failed.retireImportFailure(path.join(dir, "never-seen.jpg")); // no-op
// Missing file clears its entry instead of throwing.
const gone = path.join(dir, "gone.jpg");
fs.writeFileSync(gone, "x");
failed.rememberImportFailure(gone);
failed.rememberImportFailure(gone);
failed.rememberImportFailure(gone);
fs.unlinkSync(gone);
assert.equal(failed.isKnownImportFailure(gone), false);
// Persistence round-trip across a fresh module state is covered by the
// failcache smoke suite; here just assert the file was written.
assert.ok(fs.existsSync(path.join(dir, "failed-imports.json")));

// ---- category overrides ----
assert.deepEqual(cto.loadCategoryOverrides(), {});
assert.ok(cto.CATEGORY_OVERRIDE_VALUES.has("Screenshots"));
assert.ok(cto.CATEGORY_OVERRIDE_VALUES.has("Projects"));
assert.equal(cto.CATEGORY_OVERRIDE_VALUES.size, 2);

console.log("stores: all assertions passed");
