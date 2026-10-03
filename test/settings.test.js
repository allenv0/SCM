"use strict";

// Unit tests for main-lib/settings.js (C-01 Wave 2, slice S1). Plain node,
// no Electron: initSettings() points the module at a tmpdir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const settings = require("../main-lib/settings.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-settings-"));
settings.initSettings({ userDataDir: dir });
const file = path.join(dir, "settings.json");

// readSettings: missing file -> {}.
assert.deepEqual(settings.readSettings(), {});

// writeSettings: round-trip + merge.
assert.deepEqual(settings.writeSettings({ a: 1 }), { a: 1 });
assert.deepEqual(settings.writeSettings({ b: 2 }), { a: 1, b: 2 });
assert.deepEqual(settings.readSettings(), { a: 1, b: 2 });
// No atomic-write leftovers.
assert.equal(
	fs.readdirSync(dir).filter((n) => n.includes(".tmp-")).length,
	0,
	"tmp leftovers after writeSettings",
);

// Corrupt JSON -> defaults, and accessors never throw.
fs.writeFileSync(file, "{not json");
assert.deepEqual(settings.readSettings(), {});
assert.equal(settings.readVideoQuality(), "balanced");
assert.equal(settings.readWhisperModel(), "tiny.en");
assert.equal(settings.readAppIcon(), "scm-vhs");
assert.deepEqual(settings.readOcrLangs(), ["chi_sim", "chi_tra", "jpn", "kor"]);
assert.equal(settings.resolveOcrLangString(), "eng+chi_sim+chi_tra+jpn+kor");
assert.equal(settings.readMenuBarOnly(), false);
assert.equal(settings.readNotifyOnDone(), true);
assert.equal(settings.readStartHidden(), false);
assert.equal(settings.readOcrLangsMigrated(), false);
assert.equal(settings.readOnboardingSeen(), false);

// Validation: unknown values fall back, known values stick.
settings.writeSettings({
	videoQuality: "ultra",
	whisperModel: "base.en",
	appIcon: "vh1",
	ocrLangs: ["chi_tra", "jpn"],
	menuBarOnly: true,
	notifyOnDone: false,
	startHidden: true,
});
assert.equal(settings.readVideoQuality(), "ultra");
assert.equal(settings.readWhisperModel(), "base.en");
assert.equal(settings.readAppIcon(), "vh1");
assert.deepEqual(settings.readOcrLangs(), ["chi_tra", "jpn"]);
assert.equal(settings.resolveOcrLangString(), "eng+chi_tra+jpn");
assert.equal(settings.resolveOcrLangString([]), "eng");
// Tier-1 ids validate; canonical order follows the shared table.
assert.deepEqual(settings.parseOcrLangs(["rus", "bogus", "fra"]), [
	"rus",
	"fra",
]);
assert.equal(settings.resolveOcrLangString(["rus", "fra"]), "eng+fra+rus");
assert.equal(settings.readMenuBarOnly(), true);
assert.equal(settings.readNotifyOnDone(), false);
assert.equal(settings.readStartHidden(), true);
settings.writeSettings({
	videoQuality: "bogus",
	whisperModel: "bogus",
	appIcon: "../../etc/passwd",
	ocrLangs: ["bogus", "chi_sim", "chi_sim"],
});
assert.equal(settings.readVideoQuality(), "balanced");
assert.equal(settings.readWhisperModel(), "tiny.en");
assert.equal(settings.readAppIcon(), "scm-vhs");
assert.deepEqual(settings.readOcrLangs(), ["chi_sim"]);

// OCR upgrade marker + migration decision.
assert.equal(
	settings.shouldMigrateOcrLangs({ photoCount: 0, migrated: false }),
	false,
	"no photos → no migration",
);
assert.equal(
	settings.shouldMigrateOcrLangs({ photoCount: 3, migrated: false }),
	true,
	"unmarked library with photos migrates once",
);
assert.equal(
	settings.shouldMigrateOcrLangs({ photoCount: 3, migrated: true }),
	false,
	"marked library never re-migrates",
);
assert.equal(
	settings.shouldMigrateOcrLangs({ photoCount: 0, migrated: true }),
	false,
);
settings.writeSettings({ ocrLangsMigrated: true });
assert.equal(settings.readOcrLangsMigrated(), true);
settings.writeSettings({ ocrLangsMigrated: "yes" });
assert.equal(settings.readOcrLangsMigrated(), false);

// First-run tour marker: only `true` counts as seen.
assert.equal(settings.readOnboardingSeen(), false);
settings.writeSettings({ onboardingSeen: true });
assert.equal(settings.readOnboardingSeen(), true);
settings.writeSettings({ onboardingSeen: "yes" });
assert.equal(settings.readOnboardingSeen(), false);
settings.writeSettings({ onboardingSeen: 1 });
assert.equal(settings.readOnboardingSeen(), false);

// videoBudgetForCurrentQuality resolves the triple for the stored preset.
settings.writeSettings({ videoQuality: "ultra" });
const budget = settings.videoBudgetForCurrentQuality();
assert.ok(
	Array.isArray(budget) || (budget && typeof budget === "object"),
	"budget triple resolves",
);

// parseAppIcon / appIconFileFor.
assert.equal(settings.parseAppIcon("vh1"), "vh1");
assert.equal(settings.parseAppIcon("black"), "scm-vhs");
assert.equal(settings.parseAppIcon("retro"), "scm-vhs");
assert.equal(settings.parseAppIcon("nope"), "scm-vhs");
assert.equal(settings.parseAppIcon(null), "scm-vhs");
assert.equal(settings.appIconFileFor("vh1"), "vh1.png");
assert.equal(settings.appIconFileFor("nope"), "scm-vhs.png");

// cleanupRemovedWhisperWeights: removes a fake small.en cache, never throws,
// and is a no-op when nothing is there.
const fakeLegacy = path.join(dir, "models", "Xenova", "whisper-small.en");
fs.mkdirSync(fakeLegacy, { recursive: true });
fs.writeFileSync(path.join(fakeLegacy, "weights.bin"), "x");
settings.cleanupRemovedWhisperWeights();
assert.equal(fs.existsSync(fakeLegacy), false, "fake small.en cache removed");
settings.cleanupRemovedWhisperWeights(); // no-op, must not throw

console.log("settings: all assertions passed");
