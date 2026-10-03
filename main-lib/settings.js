"use strict";

// App settings + appearance-icon helpers (C-01 Wave 2, slice S1).
// Owns settings.json IO and the validated-fallback accessors the main
// process and renderer share. Storage root arrives via initSettings() —
// main.js calls it right after the MEMORIES_DATA_DIR override, so smoke
// launches keep pointing at their scratch dir. No electron dependency:
// plain-node unit tests init with a tmpdir.

const fs = require("fs");
const path = require("path");
const {
	parseWhisperModel,
	DEFAULT_WHISPER_MODEL,
} = require("../indexer/transcript-store-utils.js");

let USER_DATA_DIR = null;
function initSettings({ userDataDir }) {
	USER_DATA_DIR = userDataDir;
	// A fresh storage root invalidates the cache (unit tests re-init with a
	// new tmpdir; the main process inits once before any read).
	settingsCache = null;
}
const settingsFile = () => path.join(USER_DATA_DIR, "settings.json");

// P3 (CTO review 2026-09-14): readSettings() used to readFileSync +
// JSON.parse on EVERY accessor call (whisper model read per pump tick, app
// icon reads, tray rebuilds, menu reads) — dozens of parses per minute for
// a file that changes a few times per session, with a real correctness flap:
// a read racing an atomic rename could observe a missing/partial file and
// fall back to defaults mid-session. The cache below is write-through (every
// writeSettings drops it) and stat-validated (mtimeMs + size) on every read,
// so external edits to settings.json (hand edits, a second app instance)
// are still picked up — at one statSync per read instead of a full parse.

// App icon ids (Dock + BrowserWindow). Persisted as settings.json `appIcon`
// (validated; defaults to scm-vhs).
const APP_ICON_IDS = [
	"scm-vhs",
	"scm-vhs-player",
	"scm-kodak",
	"scm-bot",
	"vh1",
	"vh2",
];
const DEFAULT_APP_ICON = "scm-vhs"; // VHS — Retro tape (default for new installs)

function parseAppIcon(value) {
	if (typeof value === "string" && APP_ICON_IDS.includes(value)) return value;
	return DEFAULT_APP_ICON;
}

function appIconFileFor(id) {
	return `${parseAppIcon(id)}.png`;
}

function readAppIcon() {
	try {
		const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf-8")).appIcon;
		return parseAppIcon(raw);
	} catch {
		return DEFAULT_APP_ICON;
	}
}

// ---------------------------------------------------------------------------
// Settings (persisted shortcut, etc.)
// ---------------------------------------------------------------------------

let settingsCache = null; // { stat: { mtimeMs, size }, data } — see P3 note above

function readSettings() {
	const file = settingsFile();
	try {
		const stat = fs.statSync(file);
		if (
			settingsCache &&
			settingsCache.stat.mtimeMs === stat.mtimeMs &&
			settingsCache.stat.size === stat.size
		) {
			return settingsCache.data;
		}
		const data = JSON.parse(fs.readFileSync(file, "utf-8"));
		settingsCache = { stat: { mtimeMs: stat.mtimeMs, size: stat.size }, data };
		return data;
	} catch {
		// Missing or corrupt file: {} like before. Deliberately NOT cached —
		// the file may appear (first write) or be repaired (external edit)
		// between calls, and there is no stat to validate a cache against.
		return {};
	}
}

function writeSettings(patch) {
	const prev = readSettings();
	const next = { ...prev, ...patch };
	// Write-through: drop the cache so the next read revalidates against the
	// file we just wrote (rename + fallback paths both change the inode).
	settingsCache = null;
	fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
	// Atomic write so a crash mid-write never leaves truncated JSON that
	// would make readAppIcon()/readMenuBarOnly() fall back to defaults.
	// This is the user-visible "didn't stick" case when the file is
	// half-written while the Dock is hidden.
	const tmp = `${settingsFile()}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
		try {
			const fd = fs.openSync(tmp, "r");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			/* fsync is best-effort */
		}
		fs.renameSync(tmp, settingsFile());
		// Also fsync the directory so the rename is durable on APFS.
		try {
			const dirFd = fs.openSync(path.dirname(settingsFile()), "r");
			try {
				fs.fsyncSync(dirFd);
			} finally {
				fs.closeSync(dirFd);
			}
		} catch {
			/* directory fsync is best-effort */
		}
	} catch (err) {
		console.warn(`[settings] atomic write failed: ${err.message}`);
		// Fallback to direct write so the setting is not lost even if tmp/rename fails
		try {
			fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
		} catch (e2) {
			console.warn(`[settings] fallback write also failed: ${e2.message}`);
		}
		// Clean up tmp if it exists
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
	}
	return next;
}

// ---------------------------------------------------------------------------
// Video search quality (Settings → Video search): the scene-segment density
// preset for background enrichment. Stored in settings.json so the main
// process (which queues enrichment) and the renderer (which displays it)
// share one source of truth; the worker receives the resolved (target, min,
// max) triple per enrich-video message. Only affects enrichment planned
// AFTER the change — existing sidecars keep their old density until the
// user runs "Re-analyze videos".
// ---------------------------------------------------------------------------

function readVideoQuality() {
	try {
		return require("../indexer/video-utils.js").parseVideoQuality(
			readSettings().videoQuality,
		);
	} catch {
		return require("../indexer/video-utils.js").DEFAULT_VIDEO_QUALITY;
	}
}

// The resolved (targetSeconds, minSegments, maxSegments) triple for the
// user's current preset — what actually rides the enrich-video message.
function videoBudgetForCurrentQuality() {
	const vu = require("../indexer/video-utils.js");
	return vu.budgetForQuality(readVideoQuality());
}

// ---------------------------------------------------------------------------
// Speech model (Settings → Video search → Speech model): the whisper engine
// for background transcription. Stored in settings.json (same validated-
// fallback pattern as video quality); the resolved id rides each
// transcribe-video message and the sidecar is stamped with it — a switch
// invalidates the sidecar (transcripts are model-quality-dependent) and
// re-queues every video. Default tiny.en = today's behavior.
// ---------------------------------------------------------------------------

function readWhisperModel() {
	try {
		return parseWhisperModel(readSettings().whisperModel);
	} catch {
		return DEFAULT_WHISPER_MODEL;
	}
}

// Delete the orphaned small.en weight cache (~1GB) left by the removed rung.
// Checks both the current transformers.js layout (<cache>/Xenova/
// whisper-small.en) and the legacy v1 layout (<cache>/models--Xenova--
// whisper-small.en). Missing paths are normal (never downloaded). Never
// throws — cleanup must not block boot.
function cleanupRemovedWhisperWeights() {
	try {
		const cacheRoot = path.join(USER_DATA_DIR, "models");
		const targets = [
			path.join(cacheRoot, "Xenova", "whisper-small.en"),
			path.join(cacheRoot, "models--Xenova--whisper-small.en"),
		];
		for (const target of targets) {
			try {
				if (!fs.existsSync(target)) continue;
				const stat = fs.statSync(target);
				if (stat.isDirectory()) {
					fs.rmSync(target, { recursive: true, force: true });
				} else {
					fs.unlinkSync(target);
				}
				console.log(
					`[memories] removed orphaned whisper-small.en weights: ${target}`,
				);
			} catch (err) {
				console.warn(
					`[memories] could not remove orphaned weights ${target}: ${err.message}`,
				);
			}
		}
	} catch (err) {
		console.warn(`[memories] whisper weights cleanup skipped: ${err.message}`);
	}
}

// ---------------------------------------------------------------------------
// OCR text languages (Settings → Photo Search → Text languages): which
// tesseract traineddata files the OCR worker loads. English is always on
// (locked); each table entry is a toggle stored as settings.json `ocrLangs`
// (array of ids). Same validated-fallback pattern as video quality / whisper.
// Default = the CJK set (fresh-install behavior since the CJK rollout);
// everything else is opt-in (each extra model slows background recognition).
// Ids, order and defaults come from indexer/ocr-lang-list.js — the single
// source of truth shared with the worker and main.js.
// ---------------------------------------------------------------------------

const {
	OCR_LANG_IDS,
	DEFAULT_OCR_LANGS,
} = require("../indexer/ocr-lang-list.js");

function parseOcrLangs(raw) {
	if (!Array.isArray(raw)) return [...DEFAULT_OCR_LANGS];
	const out = [];
	for (const entry of raw) {
		if (OCR_LANG_IDS.includes(entry) && !out.includes(entry)) {
			out.push(entry);
		}
	}
	return out;
}

function readOcrLangs() {
	try {
		return parseOcrLangs(readSettings().ocrLangs);
	} catch {
		return [...DEFAULT_OCR_LANGS];
	}
}

// The tesseract language string the worker loads: eng always first, then the
// enabled CJK models in canonical order (e.g. "eng+chi_sim+chi_tra+jpn+kor").
function resolveOcrLangString(enabled) {
	const list = Array.isArray(enabled) ? enabled : readOcrLangs();
	const ordered = OCR_LANG_IDS.filter((id) => list.includes(id));
	return ["eng", ...ordered].join("+");
}

// One-time upgrade marker for the CJK rollout (Settings → Photo Search):
// pre-multilang OCR rows were all recognized eng-only (no shipped version
// ever produced CJK rows), so the first launch that sees photo rows without
// this marker force-re-queues the whole library once under the current
// language set. The marker is written ONLY when a full OCR drain completes
// with zero failures (see pumpOcr in main.js) — failed rows keep their prior
// text and retry on the next launch instead of being stamped as migrated.
function readOcrLangsMigrated() {
	try {
		return readSettings().ocrLangsMigrated === true;
	} catch {
		return false;
	}
}

// Pure migration decision for backfillOcr (unit-tested): migrate when the
// marker is absent and at least one photo row exists to re-process. The
// library stamp is deliberately NOT consulted — libraries stamped by the
// pre-migration builds may still hold eng-only rows, and only a completed
// drain proves otherwise.
function shouldMigrateOcrLangs({ photoCount, migrated }) {
	return migrated !== true && Number(photoCount) > 0;
}

function readMenuBarOnly() {
	try {
		return readSettings().menuBarOnly === true;
	} catch {
		return false;
	}
}

// Completion notifications for background work, gated two ways: the user
// opted in (settings.json `notifyOnDone`, default true) AND the window is
// currently hidden — while the app is in use the in-app UI already says it.
function readNotifyOnDone() {
	try {
		const v = readSettings().notifyOnDone;
		return v === undefined ? true : v === true;
	} catch {
		return true;
	}
}

function readStartHidden() {
	try {
		return readSettings().startHidden === true;
	} catch {
		return false;
	}
}

// First-run CRT tour marker (settings.json `onboardingSeen`, default
// false). This is the install-level "has the tour shown" flag: unlike the
// renderer's localStorage copy it survives profile/storage resets, so the
// intro shows exactly once per install. Only `true` counts — anything else
// (missing, corrupt, hand-edited) means "not seen yet".
function readOnboardingSeen() {
	try {
		return readSettings().onboardingSeen === true;
	} catch {
		return false;
	}
}

module.exports = {
	initSettings,
	APP_ICON_IDS,
	DEFAULT_APP_ICON,
	parseAppIcon,
	appIconFileFor,
	readAppIcon,
	readSettings,
	writeSettings,
	readVideoQuality,
	videoBudgetForCurrentQuality,
	readWhisperModel,
	cleanupRemovedWhisperWeights,
	OCR_LANG_IDS,
	DEFAULT_OCR_LANGS,
	parseOcrLangs,
	readOcrLangs,
	resolveOcrLangString,
	readOcrLangsMigrated,
	shouldMigrateOcrLangs,
	readMenuBarOnly,
	readNotifyOnDone,
	readStartHidden,
	readOnboardingSeen,
};
