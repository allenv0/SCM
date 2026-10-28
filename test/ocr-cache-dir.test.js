"use strict";

// Seam guard for the OCR traineddata cache (2026-10-28): tesseract.js writes
// its cache with a bare fs.writeFile — no mkdir — and swallows the failure,
// so a missing ocr-data/ dir meant every worker start silently re-downloaded
// ~17MB from the CDN and offline OCR never worked. The pump must create the
// dir before forking the worker, and the worker must defend the standalone
// `--smoke` path. The deep smoke proves this end-to-end (the battery no
// longer pre-creates the dir); this keeps the wiring from regressing between
// battery runs.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const pump = fs.readFileSync(
	path.join(__dirname, "..", "main", "ipc", "pumps", "ocr.ts"),
	"utf-8",
);
assert.ok(
	pump.includes("fs.mkdirSync(ocrDataDir(), { recursive: true });"),
	"pumps/ocr.ts must mkdirSync(ocrDataDir(), { recursive: true }) before forking the OCR worker",
);

const worker = fs.readFileSync(
	path.join(__dirname, "..", "indexer", "ocr-worker.ts"),
	"utf-8",
);
assert.ok(
	worker.includes(
		"fs.mkdirSync(process.env.OCR_DATA_DIR, { recursive: true });",
	),
	"ocr-worker.ts must mkdir OCR_DATA_DIR in ensureWorker (standalone --smoke path)",
);

console.log("ocr-cache-dir.test.js: all assertions passed");
