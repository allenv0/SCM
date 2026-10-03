"use strict";

// Named embedding versions (Settings → Library): point-in-time snapshots of
// everything that defines the searchable state — the index, every model's
// embedding/phrase bins, scene + transcript sidecars, threshold
// calibrations, and category overrides — restorable with one action. The
// photos themselves are NOT copied: rows are validated against PHOTOS_DIR
// on restore and missing files are reported, never silently dropped.
//
// Layout: <DATA_DIR>/versions/<slug>/{manifest.json + snapshot files}.
// main.js owns the idle gate (no import/migration/pump activity), the
// pre-create persist drain, and the post-restore cache reload + pool
// handling; this module owns file enumeration, copying, validation, and
// the manifest. Storage root arrives via initEmbeddingVersions() — same
// pattern as initLibraryStore/initSettings. No electron dependency:
// plain-node unit tests init with a tmpdir.

const fs = require("fs");
const path = require("path");
// Explicit require: global `crypto` is absent on older Electron/node.
// eslint-disable-next-line no-redeclare
const crypto = require("crypto");
const { MODELS } = require("../indexer/models.js");

let DATA_DIR = null;
let VERSIONS_DIR = null;
function initEmbeddingVersions({ userDataDir }) {
	DATA_DIR = path.join(userDataDir, "library");
	VERSIONS_DIR = path.join(DATA_DIR, "versions");
}

// Cap: oldest versions are never auto-deleted (a silent prune of named
// user data would be the C-05 story all over again) — create refuses past
// the cap and names the remedy instead.
const MAX_VERSIONS = 10;
const MAX_NAME_LENGTH = 80;

function versionDirFor(slug) {
	return path.join(VERSIONS_DIR, slug);
}

function manifestPathFor(slug) {
	return path.join(versionDirFor(slug), "manifest.json");
}

// URL/filename-safe slug: lowercase, runs of anything else become one dash,
// capped so a pasted sentence can't make an absurd directory name.
function slugifyName(name) {
	const slug = String(name || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug;
}

// Snapshot file inventory for the CURRENT library state: the index, the
// threshold state, the overrides, plus every per-model bin/sidecar that
// exists on disk. Models never built contribute nothing (their absence
// restores as absence — restore never deletes live files it doesn't hold).
function snapshotFiles() {
	const files = [
		"memories-index.json",
		"memory-models.json",
		"category-overrides.json",
	];
	for (const modelId of Object.keys(MODELS)) {
		for (const name of [
			`memory-embeddings-${modelId}.bin`,
			`memory-phrase-embeddings-${modelId}.bin`,
			`memory-segments-${modelId}.json`,
			`memory-segment-embeddings-${modelId}.bin`,
			`memory-transcripts-${modelId}.json`,
			`memory-transcript-embeddings-${modelId}.bin`,
		]) {
			try {
				if (fs.statSync(path.join(DATA_DIR, name)).isFile()) files.push(name);
			} catch {
				/* model never built — contributes nothing */
			}
		}
	}
	return files;
}

function rowHash(filenames) {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(filenames || []))
		.digest("hex");
}

function dirBytes(dir) {
	let total = 0;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		try {
			if (entry.isDirectory()) total += dirBytes(full);
			else total += fs.statSync(full).size;
		} catch {
			/* raced deletion — count what survived */
		}
	}
	return total;
}

function readManifest(slug) {
	try {
		const parsed = JSON.parse(fs.readFileSync(manifestPathFor(slug), "utf8"));
		if (!parsed || parsed.version !== 1 || typeof parsed.name !== "string") {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function listVersions() {
	let slugs;
	try {
		slugs = fs
			.readdirSync(VERSIONS_DIR, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
	const out = [];
	for (const slug of slugs) {
		const manifest = readManifest(slug);
		if (!manifest) continue;
		out.push({
			slug,
			name: manifest.name,
			createdAt: manifest.createdAt,
			appVersion: manifest.appVersion || null,
			activeModelId: manifest.activeModelId || null,
			modelIds: Array.isArray(manifest.modelIds) ? manifest.modelIds : [],
			rowCount: manifest.rowCount ?? 0,
			totalBytes: dirBytes(versionDirFor(slug)),
			settings: manifest.settings || null,
		});
	}
	out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
	return out;
}

// Copy the live library state into a new named version. Callers flush
// pending persists BEFORE this so the snapshot is coherent; files are
// copied with copyFileSync (each write is independent — a crash mid-copy
// leaves a version WITHOUT a manifest, which listVersions skips, and the
// manifest lands last as the commit marker). opts: { appVersion, settings,
// index } — index is the parsed live memories-index.json (rows + modelId),
// so this module never parses the 35 MB file twice.
function createVersion({ name, appVersion, settings, index }) {
	const trimmed = String(name || "").trim();
	if (!trimmed) return { ok: false, error: "Name the version first." };
	if (trimmed.length > MAX_NAME_LENGTH) {
		return {
			ok: false,
			error: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
		};
	}
	const slug = slugifyName(trimmed);
	if (!slug) {
		return { ok: false, error: "Use letters or numbers in the name." };
	}
	try {
		if (fs.statSync(versionDirFor(slug)).isDirectory()) {
			return {
				ok: false,
				error: `A version named “${trimmed}” already exists — pick another name.`,
			};
		}
	} catch {
		/* free — proceed */
	}
	if (listVersions().length >= MAX_VERSIONS) {
		return {
			ok: false,
			error: `Version limit reached (${MAX_VERSIONS}) — delete one first.`,
		};
	}
	const filenames = Array.isArray(index?.images) ? index.images : [];
	const modelIds = Object.keys(MODELS).filter((modelId) => {
		try {
			return fs
				.statSync(path.join(DATA_DIR, `memory-embeddings-${modelId}.bin`))
				.isFile();
		} catch {
			return false;
		}
	});
	const dir = versionDirFor(slug);
	try {
		fs.mkdirSync(dir, { recursive: true });
		for (const name of snapshotFiles()) {
			try {
				fs.copyFileSync(path.join(DATA_DIR, name), path.join(dir, name));
			} catch {
				/* absent on disk — contributes nothing */
			}
		}
		const manifest = {
			version: 1,
			name: trimmed,
			slug,
			createdAt: new Date().toISOString(),
			appVersion: appVersion || null,
			activeModelId: index?.modelId || null,
			modelIds,
			rowCount: filenames.length,
			rowHash: rowHash(filenames),
			filenames,
			settings: settings || null,
		};
		fs.writeFileSync(manifestPathFor(slug), JSON.stringify(manifest, null, 2));
	} catch (err) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
		return { ok: false, error: `Could not save the version: ${err.message}` };
	}
	return { ok: true, slug, totalBytes: dirBytes(dir) };
}

function renameVersion(slug, name) {
	const manifest = readManifest(slug);
	if (!manifest) return { ok: false, error: "That version no longer exists." };
	const trimmed = String(name || "").trim();
	if (!trimmed) return { ok: false, error: "Name the version first." };
	if (trimmed.length > MAX_NAME_LENGTH) {
		return {
			ok: false,
			error: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
		};
	}
	// Renaming keeps the slug (the directory identity) — only the display
	// name changes, so a rename can never orphan or collide on disk. A name
	// taken by ANOTHER version is still refused to keep the list readable.
	if (listVersions().some((v) => v.slug !== slug && v.name === trimmed)) {
		return {
			ok: false,
			error: `Another version is already named “${trimmed}”.`,
		};
	}
	try {
		manifest.name = trimmed;
		fs.writeFileSync(manifestPathFor(slug), JSON.stringify(manifest, null, 2));
	} catch (err) {
		return { ok: false, error: `Could not rename: ${err.message}` };
	}
	return { ok: true };
}

function deleteVersion(slug) {
	if (!readManifest(slug))
		return { ok: false, error: "That version no longer exists." };
	try {
		fs.rmSync(versionDirFor(slug), { recursive: true, force: true });
	} catch (err) {
		return { ok: false, error: `Could not delete: ${err.message}` };
	}
	return { ok: true };
}

// Copy a version's files back over the live library. Returns the manifest
// plus the filenames whose app copy is missing on disk (rows that would
// restore as ghosts — reported, never silently dropped). Live files the
// version doesn't hold (e.g. a model built AFTER the snapshot) are left
// alone: restore adds knowledge, never destroys what it doesn't know.
// Callers reload in-memory caches and respawn the worker pool afterwards.
function restoreVersion(slug, photosDir) {
	const manifest = readManifest(slug);
	if (!manifest) return { ok: false, error: "That version no longer exists." };
	const dir = versionDirFor(slug);
	try {
		for (const entry of fs.readdirSync(dir)) {
			if (entry === "manifest.json") continue;
			const src = path.join(dir, entry);
			try {
				if (!fs.statSync(src).isFile()) continue;
			} catch {
				continue;
			}
			fs.copyFileSync(src, path.join(DATA_DIR, entry));
		}
	} catch (err) {
		return { ok: false, error: `Could not restore: ${err.message}` };
	}
	const missing = [];
	for (const filename of manifest.filenames || []) {
		if (typeof filename !== "string" || !filename) continue;
		try {
			if (!fs.existsSync(path.join(photosDir, filename)))
				missing.push(filename);
		} catch {
			/* existence check failed — don't claim it missing */
		}
	}
	return { ok: true, manifest, missing };
}

module.exports = {
	initEmbeddingVersions,
	MAX_VERSIONS,
	slugifyName,
	snapshotFiles,
	rowHash,
	listVersions,
	createVersion,
	renameVersion,
	deleteVersion,
	restoreVersion,
};
