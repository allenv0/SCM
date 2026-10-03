"use strict";

// Watched-folder smoke (ELECTRON_SMOKE_WATCHED=import|sync + WATCH_TEST_DIR
// + an isolated MEMORIES_DATA_DIR). Two launches against one data dir:
//
//   import: imports TWO folders in one batch (both auto-watch + report in
//           the result), checks the watch list is persisted on disk and
//           armed with live watchers, exercises add-watch dedupe (re-add +
//           trailing-slash canonicalization) and the failed-arm marker
//           cleanup, verifies the LIVE watcher imports a photo dropped into
//           a folder mid-session, checks a re-scan is idempotent, then stops
//           the watchers and drops one photo per folder that only the NEXT
//           launch's sync can import.
//   sync:   boots again against the same data dir — the persisted watch
//           list must reload, the launch folder-sync must auto-import both
//           stragglers, re-sync must stay idempotent, the reveal-target
//           guard must hold, a sync retry scheduled while an import was busy
//           must NOT resurrect a folder removed from the watch list (stale-
//           retry regression), removal must close watchers + persist, and
//           re-importing an unwatched folder re-watches it.
//
// Extracted from main.js (C-01); prod seams arrive via ctx. Two deliberate
// adaptations vs the verbatim original:
//   - importInFlight reads/writes go through ctx.isImportInFlight() /
//     ctx.setImportInFlight() (a module-level `let` cannot be threaded).
//   - watchedFolders/folderWatchers/watchFailedFolders arrive by reference.
//     Contract: no watch-list reload runs mid-driver (load happens once at
//     boot), so the captured references stay live for the driver's lifetime.

const fs = require("fs");
const path = require("path");
const { solidJpg, ensureDir } = require("./helpers.js");

async function runWatchedFoldersTest(ctx) {
	const {
		importPaths,
		loadLibrary,
		watchedFolders,
		folderWatchers,
		watchFailedFolders,
		watchedFolderList,
		addWatchedFolder,
		removeWatchedFolder,
		watchedFolderRevealTarget,
		syncWatchedFolder,
		stopWatchedFolderWatchers,
		WATCHED_FOLDERS_FILE,
		isImportInFlight,
		setImportInFlight,
	} = ctx;
	if (!process.env.MEMORIES_DATA_DIR) {
		throw new Error("MEMORIES_DATA_DIR is required (test isolation)");
	}
	const mode = process.env.ELECTRON_SMOKE_WATCHED;
	const root = process.env.WATCH_TEST_DIR;
	if (!root) throw new Error("WATCH_TEST_DIR is required");
	const folder = path.join(root, "watch-folder");
	const folder2 = path.join(root, "watch-folder-2");
	const gen = (dir, name, color) => solidJpg(dir, name, color, 48);
	const waitFor = async (pred, label, timeoutMs = 60000) => {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (pred()) return;
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const persistedList = () => {
		const parsed = JSON.parse(fs.readFileSync(WATCHED_FOLDERS_FILE, "utf8"));
		return Array.isArray(parsed.folders) ? parsed.folders : [];
	};

	if (mode === "import") {
		ensureDir(folder);
		ensureDir(folder2);
		await gen(folder, "alpha.jpg", [60, 120, 200]);
		await gen(folder2, "delta.jpg", [120, 60, 200]);

		// One batch, two directories: both import AND both auto-watch.
		const res = await importPaths([folder, folder2]);
		if (res.added.length !== 2 || res.errors.length !== 0) {
			throw new Error(`two-folder batch wrong: ${JSON.stringify(res)}`);
		}
		if (res.watched.length !== 2) {
			throw new Error(
				`batch did not report both watched folders: ${JSON.stringify(res.watched)}`,
			);
		}
		for (const name of ["watch-folder", "watch-folder-2"]) {
			if (!res.watched.includes(name)) {
				throw new Error(
					`batch missed watched folder ${name}: ${JSON.stringify(res.watched)}`,
				);
			}
		}

		// Persisted on disk AND armed with live watchers, in memory.
		if (!fs.existsSync(WATCHED_FOLDERS_FILE)) {
			throw new Error("watched-folders.json was not persisted");
		}
		if (!watchedFolders.includes(folder) || !watchedFolders.includes(folder2)) {
			throw new Error(
				`watch list missing folders: ${JSON.stringify(watchedFolders)}`,
			);
		}
		if (!folderWatchers.has(folder) || !folderWatchers.has(folder2)) {
			throw new Error("both folders must have live watchers armed");
		}
		const listed = watchedFolderList();
		if (listed.length !== 2 || listed.some((f) => !f.exists)) {
			throw new Error(`watchedFolderList wrong: ${JSON.stringify(listed)}`);
		}

		// Watch-list dedupe: re-adding a watched folder is a no-op, and the
		// trailing-slash variant canonicalizes to the same entry.
		if (addWatchedFolder(folder) !== false) {
			throw new Error("re-adding a watched folder must be a no-op");
		}
		if (addWatchedFolder(`${folder}/`) !== false) {
			throw new Error(
				"trailing-slash variant must canonicalize to the same folder",
			);
		}
		// A non-existent folder can be added (the watch survives until the
		// folder returns) but its watcher fails to arm — and removal cleans
		// up both the entry and the failed-arm marker.
		const fresh = path.join(root, "fresh");
		if (addWatchedFolder(fresh) !== true) {
			throw new Error("adding a fresh folder should succeed");
		}
		if (!watchFailedFolders.has(fresh)) {
			throw new Error("failed watch arm must be recorded for retry gating");
		}
		if (removeWatchedFolder(fresh) !== true) {
			throw new Error("removing the fresh folder should succeed");
		}
		if (watchedFolders.includes(fresh) || watchFailedFolders.has(fresh)) {
			throw new Error("fresh folder cleanup left residue");
		}

		// A photo dropped into a folder mid-session must be picked up by
		// the LIVE watcher (fs event → debounce → sync → import), and the
		// batch must fully settle before the next assertion.
		await gen(folder, "gamma.jpg", [60, 200, 120]);
		await waitFor(
			() => loadLibrary().filenames.includes("gamma.jpg"),
			"live watcher to import gamma.jpg",
		);
		await waitFor(() => !isImportInFlight(), "live watcher import to finish");

		// A re-scan of a fully-synced folder adds nothing, skips everything,
		// and does not re-report it as watched.
		const again = await importPaths([folder]);
		if (
			again.added.length !== 0 ||
			again.skipped.length !== 2 ||
			again.watched.length !== 0
		) {
			throw new Error(`live re-scan not idempotent: ${JSON.stringify(again)}`);
		}

		// Stop the watchers so the files below can only be imported by the
		// NEXT launch's sync (the thing the sync phase verifies).
		stopWatchedFolderWatchers();
		await gen(folder, "beta.jpg", [200, 120, 60]);
		await gen(folder2, "epsilon.jpg", [200, 60, 120]);
		console.log(
			"[watched] import phase OK — 2 folders auto-watched + persisted + live-synced, dedupe + cleanup hold",
		);
		return;
	}

	if (mode === "sync") {
		// The watch list persisted by the previous launch must have reloaded.
		if (!watchedFolders.includes(folder) || !watchedFolders.includes(folder2)) {
			throw new Error(
				`watch list did not survive restart: ${JSON.stringify(watchedFolders)}`,
			);
		}
		// The launch folder-sync (kicked off after indexerReady) must import
		// the photos that landed after the first launch's import — in BOTH
		// folders — and fully settle before the pipeline is touched again.
		await waitFor(
			() =>
				["beta.jpg", "epsilon.jpg"].every((n) =>
					loadLibrary().filenames.includes(n),
				),
			"launch sync to import beta.jpg + epsilon.jpg",
		);
		await waitFor(() => !isImportInFlight(), "launch sync to finish");
		const l = loadLibrary();
		for (const name of [
			"alpha.jpg",
			"delta.jpg",
			"gamma.jpg",
			"beta.jpg",
			"epsilon.jpg",
		]) {
			if (!l.filenames.includes(name)) {
				throw new Error(`${name} missing after sync`);
			}
		}

		// Re-syncing must be idempotent: nothing new → nothing added, every
		// already-imported file is skipped, and nothing is re-reported as
		// watched.
		const again = await importPaths([folder, folder2]);
		if (
			again.added.length !== 0 ||
			again.skipped.length !== 5 ||
			again.watched.length !== 0
		) {
			throw new Error(`idempotent re-sync failed: ${JSON.stringify(again)}`);
		}

		// The panel's reveal action: while the folder is watched and on disk
		// it resolves to itself; anything else (unknown path, unwatched
		// folder, gone folder) must resolve to null so the renderer can
		// never open an arbitrary location.
		if (watchedFolderRevealTarget(folder) !== folder) {
			throw new Error("watched folder did not resolve as a reveal target");
		}
		if (watchedFolderRevealTarget(path.join(root, "not-watched")) !== null) {
			throw new Error("unwatched path resolved as a reveal target");
		}

		// Regression: a sync retry scheduled while an import is busy must
		// NOT resurrect a folder the user removed from the watch list
		// meanwhile (the retry used to re-arm the watcher and let
		// importPaths' auto-watch re-add the folder).
		setImportInFlight(true);
		syncWatchedFolder(folder); // schedules the 5s retry
		removeWatchedFolder(folder); // user removes it while "busy"
		setImportInFlight(false);
		await new Promise((r) => setTimeout(r, 5500));
		if (watchedFolders.includes(folder)) {
			throw new Error("removed folder was resurrected by a stale sync retry");
		}
		if (folderWatchers.has(folder)) {
			throw new Error(
				"removed folder watcher was re-armed by a stale sync retry",
			);
		}
		if (persistedList().includes(folder)) {
			throw new Error("removed folder was re-persisted by a stale sync retry");
		}

		// The panel's removal path for the remaining folder: drops it from
		// the list, closes its watcher, persists the change, and kills the
		// reveal target.
		if (!removeWatchedFolder(folder2)) {
			throw new Error(
				"removeWatchedFolder returned false for a watched folder",
			);
		}
		if (watchedFolders.length !== 0 || folderWatchers.size !== 0) {
			throw new Error(
				`removal left residue: folders=${JSON.stringify(watchedFolders)} watchers=${folderWatchers.size}`,
			);
		}
		if (persistedList().length !== 0) {
			throw new Error(
				`persisted watch list not emptied: ${JSON.stringify(persistedList())}`,
			);
		}
		if (watchedFolderRevealTarget(folder2) !== null) {
			throw new Error("removed folder still resolves as a reveal target");
		}

		// Re-importing an unwatched folder re-watches it (documented
		// behavior), then a final removal leaves a clean slate.
		const reimported = await importPaths([folder]);
		if (reimported.added.length !== 0 || reimported.skipped.length !== 3) {
			throw new Error(
				`re-import of unwatched folder wrong: ${JSON.stringify(reimported)}`,
			);
		}
		if (
			reimported.watched.length !== 1 ||
			reimported.watched[0] !== "watch-folder"
		) {
			throw new Error(
				`re-import did not re-watch the folder: ${JSON.stringify(reimported.watched)}`,
			);
		}
		if (!watchedFolders.includes(folder)) {
			throw new Error("re-imported folder not on the watch list");
		}
		if (!removeWatchedFolder(folder)) {
			throw new Error("final removal failed");
		}
		console.log(
			`[watched] sync phase OK — launch sync imported 2 photos (library=${l.filenames.length}), ` +
				"idempotent re-sync, reveal guard, stale-retry regression, removal, re-import re-watch all hold",
		);
		return;
	}

	throw new Error(`unknown ELECTRON_SMOKE_WATCHED mode: ${mode}`);
}

module.exports = { runWatchedFoldersTest };
