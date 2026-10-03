"use strict";

// Manual category overrides (C-01 Wave 2, slice S3).
// The user's explicit Add to / Remove from Screenshots decisions, keyed by
// CONTENT HASH so they survive renames and re-imports. Storage root arrives
// via initCategoryOverrides() — main.js calls it after the
// MEMORIES_DATA_DIR override. No electron dependency (plain-node tested).

const fs = require("fs");
const path = require("path");

let DATA_DIR = null;
function initCategoryOverrides({ dataDir }) {
	DATA_DIR = dataDir;
}
const categoryOverridesFile = () =>
	path.join(DATA_DIR, "category-overrides.json");

// ---------------------------------------------------------------------------
// Manual category overrides (Screenshots tab): the user's explicit Add to /
// Remove from Screenshots decisions, keyed by CONTENT HASH so they survive
// renames and re-imports — any future row with the same bytes lands in the
// same bucket. A null decision removes the override, falling back to
// the automatic signals. Display-only metadata: no embedding row changes.
// ---------------------------------------------------------------------------

const CATEGORY_OVERRIDE_VALUES = new Set(["Screenshots", "Projects"]);
let categoryOverrides = null;

function loadCategoryOverrides() {
	if (categoryOverrides) return categoryOverrides;
	try {
		const parsed = JSON.parse(fs.readFileSync(categoryOverridesFile(), "utf8"));
		const overrides =
			parsed && parsed.overrides && typeof parsed.overrides === "object"
				? parsed.overrides
				: {};
		// Drop anything that isn't a known bucket so a hand-edited file can
		// never inject a phantom category.
		for (const [hash, value] of Object.entries(overrides)) {
			if (!CATEGORY_OVERRIDE_VALUES.has(value)) delete overrides[hash];
		}
		categoryOverrides = overrides;
	} catch {
		categoryOverrides = {};
	}
	return categoryOverrides;
}

function saveCategoryOverrides() {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.writeFileSync(
			categoryOverridesFile(),
			JSON.stringify({ version: 1, overrides: categoryOverrides }, null, "\t"),
		);
	} catch (err) {
		console.warn(`[memories] category-overrides save failed: ${err.message}`);
	}
}

// Fresh-start wipe: drop every manual decision (memory + disk). Content
// hashes are stable, so keeping them would resurrect old buckets on
// re-import — the opposite of clean.
function clearCategoryOverrides() {
	categoryOverrides = {};
	saveCategoryOverrides();
}

module.exports = {
	initCategoryOverrides,
	CATEGORY_OVERRIDE_VALUES,
	loadCategoryOverrides,
	saveCategoryOverrides,
	clearCategoryOverrides,
};
