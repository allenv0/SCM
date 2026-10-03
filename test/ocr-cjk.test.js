"use strict";

// Unit tests for CJK OCR support (plain node, no Electron):
//   - indexer/ocr-worker.js: resolveOcrLangs / isRealWord / joinOcrWords
//   - main-lib/settings.js: parseOcrLangs / readOcrLangs / resolveOcrLangString

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const worker = require("../indexer/ocr-worker.js");
const settings = require("../main-lib/settings.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-ocr-cjk-"));
settings.initSettings({ userDataDir: dir });

// resolveOcrLangs: missing/empty -> default; explicit subset honored;
// unknowns dropped; eng always first in canonical order.
assert.equal(
	worker.resolveOcrLangs(undefined),
	"eng+chi_sim+chi_tra+jpn+kor",
	"default langs",
);
assert.equal(worker.resolveOcrLangs(""), "eng+chi_sim+chi_tra+jpn+kor");
assert.equal(
	worker.resolveOcrLangs("eng+chi_tra+jpn"),
	"eng+chi_tra+jpn",
	"subset honored",
);
assert.equal(worker.resolveOcrLangs("eng"), "eng", "eng-only allowed");
assert.equal(
	worker.resolveOcrLangs("eng+fra+rus"),
	"eng+fra+rus",
	"Tier-1 ids resolve in table order",
);
assert.equal(
	worker.resolveOcrLangs("eng+rus+fra"),
	"eng+fra+rus",
	"canonical order, not input order",
);
assert.equal(
	worker.resolveOcrLangs("eng+bogus+chi_tra"),
	"eng+chi_tra",
	"unknowns dropped",
);
assert.equal(
	worker.resolveOcrLangs("eng+kor+jpn"),
	"eng+jpn+kor",
	"canonical order, not input order",
);
assert.equal(worker.DEFAULT_OCR_LANGS, "eng+chi_sim+chi_tra+jpn+kor");

// isRealWord: Latin rule unchanged; CJK single chars pass; punctuation-only fails.
assert.equal(worker.isRealWord("Hello"), true);
assert.equal(worker.isRealWord("AI"), true);
assert.equal(worker.isRealWord("a"), false, "lone Latin char is noise");
assert.equal(worker.isRealWord(')"—:'), false, "symbol soup rejected");
assert.equal(worker.isRealWord("台北車站"), true, "Traditional Chinese passes");
assert.equal(worker.isRealWord("駅"), true, "lone Kanji is searchable");
assert.equal(worker.isRealWord("スクリーンショット"), true, "Katakana passes");
assert.equal(worker.isRealWord("스크린샷"), true, "Hangul passes");
assert.equal(worker.isRealWord("「東京」"), true, "CJK punctuation stripped");
assert.equal(worker.isRealWord("。、"), false, "CJK punctuation only rejected");
// Tier-1 scripts pass exactly like Latin (Unicode \p{L} letter test).
assert.equal(worker.isRealWord("Привет"), true, "Cyrillic passes");
assert.equal(worker.isRealWord("γειά"), true, "Greek passes");
assert.equal(worker.isRealWord("مرحبا"), true, "Arabic passes");
assert.equal(worker.isRealWord("שלום"), true, "Hebrew passes");
assert.equal(worker.isRealWord("नमस्ते"), true, "Devanagari passes");
assert.equal(worker.isRealWord("café"), true, "Latin diacritics pass");
assert.equal(worker.isRealWord("123"), false, "digits-only still rejected");
assert.equal(worker.isRealWord(""), false);

// joinOcrWords: no spaces inside CJK runs, spaces elsewhere.
assert.equal(
	worker.joinOcrWords(["台北", "車站"]),
	"台北車站",
	"CJK words glued",
);
assert.equal(
	worker.joinOcrWords(["Photo", "東京駅", "2024"]),
	"Photo 東京駅 2024",
	"mixed text keeps Latin spacing",
);
assert.equal(worker.joinOcrWords(["Hello", "world"]), "Hello world");
assert.equal(worker.joinOcrWords([]), "");

// cleanText keeps CJK words and glues runs.
const cjkWords = [
	{ text: "台北車站", confidence: 85 },
	{ text: "Hello", confidence: 90 },
	{ text: "x", confidence: 90 },
	{ text: "junk", confidence: 10 },
];
assert.equal(worker.cleanText("", cjkWords), "台北車站 Hello");

// settings: parse/resolve round-trip + validation.
assert.deepEqual(settings.parseOcrLangs(undefined), [
	"chi_sim",
	"chi_tra",
	"jpn",
	"kor",
]);
assert.deepEqual(settings.parseOcrLangs(["chi_tra", "bogus", "chi_tra"]), [
	"chi_tra",
]);
assert.equal(
	settings.resolveOcrLangString(["kor", "jpn"]),
	"eng+jpn+kor",
	"settings canonical order",
);
settings.writeSettings({ ocrLangs: ["chi_tra"] });
assert.deepEqual(settings.readOcrLangs(), ["chi_tra"]);
assert.equal(settings.resolveOcrLangString(), "eng+chi_tra");

// Migration wiring (source assertions — main.js needs Electron to run):
// the upgrade path, the manual re-read IPC, and the failure accounting must
// stay wired from settings through the bridge to the Photo Search UI.
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
for (const needle of [
	"shouldMigrateOcrLangs",
	"readOcrLangsMigrated",
	'requeueAllPhotosForOcr("upgrade")',
	'ipcMain.handle("memories:reocr-photos"',
	"ocrFailedCount",
	"OCR drain finished",
	"ocrLangsMigrated: true",
	'require("./indexer/ocr-lang-list.js")',
]) {
	assert.ok(mainSrc.includes(needle), `main.js missing ${needle}`);
}
assert.ok(
	!mainSrc.includes('new Set(["chi_sim", "chi_tra", "jpn", "kor"])'),
	"main.js still carries the old 4-lang IPC allowlist",
);
const workerSrc = fs.readFileSync(
	path.join(__dirname, "..", "indexer", "ocr-worker.js"),
	"utf8",
);
for (const needle of [
	'require("./ocr-lang-list.js")',
	"OCR_TOGGLE_LANGS",
	"\\p{L}",
]) {
	assert.ok(workerSrc.includes(needle), `ocr-worker.js missing ${needle}`);
}
assert.ok(
	!workerSrc.includes("OCR_CJK_LANGS"),
	"ocr-worker.js still carries the old 4-lang allowlist",
);
const settingsSrc = fs.readFileSync(
	path.join(__dirname, "..", "main-lib", "settings.js"),
	"utf8",
);
assert.ok(
	settingsSrc.includes('require("../indexer/ocr-lang-list.js")'),
	"settings.js must share the language table, not hardcode it",
);
const preloadSrc = fs.readFileSync(
	path.join(__dirname, "..", "preload.js"),
	"utf8",
);
assert.ok(
	preloadSrc.includes("memories:reocr-photos"),
	"preload missing reocr-photos bridge",
);
const typesSrc = fs.readFileSync(
	path.join(__dirname, "..", "src", "types.d.ts"),
	"utf8",
);
assert.ok(typesSrc.includes("reocrPhotos"), "types missing reocrPhotos");
const hookSrc = fs.readFileSync(
	path.join(__dirname, "..", "src", "hooks", "useOcrLangs.ts"),
	"utf8",
);
assert.ok(hookSrc.includes("reocrPhotos"), "useOcrLangs missing reocrPhotos");
const sheetSrc = fs.readFileSync(
	path.join(__dirname, "..", "src", "components", "SettingsSheet.tsx"),
	"utf8",
);
assert.ok(
	sheetSrc.includes("Re-read all photos"),
	"SettingsSheet missing re-read button",
);

console.log("ocr-cjk: all assertions passed");
