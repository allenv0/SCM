import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

// Headless smoke dispatch, extracted from main.ts verbatim. Every
// ELECTRON_SMOKE_* mode lives here so the boot path in main.ts stays
// lifecycle-only; the branch order, messages and exit codes are unchanged.
//
// Contract: returns true when a mode ran and already called quitSmoke() —
// main.ts then stops before registering the activate handler, exactly as
// the inline `return`s did. The generic ELECTRON_SMOKE=1 probe returns
// false: it quit but historically fell through to the activate handler.
//
// Everything the modes touch is passed in as a dep (the same locals the
// inline block closed over), so this module never reaches into main.ts.
// The dep types are deliberately `any`: these are dev-only handles whose
// scripts are plain JS with their own ad-hoc shapes — pinning them here
// would duplicate each script's API instead of documenting it.
export interface SmokeDeps {
	win: BrowserWindow;
	requireDev: (rel: string) => any;
	quitSmoke: (forceCode?: number) => void;
	importPaths: any;
	loadLibrary: any;
	resetLibraryCaches: any;
	resolveRevealTarget: any;
	PHOTOS_DIR: any;
	POSTERS_DIR: any;
	DATA_DIR: any;
	INDEX_FILE: any;
	WEB_PREFERENCES: any;
	DEFAULT_MODEL_ID: any;
	VIDEO_EXTENSIONS: any;
	youtube: any;
	mergeYoutubeIntermediates: any;
	backfillYoutubeMeta: any;
	repairSilentYoutubeImports: any;
	resolveYtDlpFfmpegLocation: any;
	runYoutubeJob: any;
	watchedFolders: any;
	folderWatchers: any;
	watchFailedFolders: any;
	watchedFolderList: any;
	addWatchedFolder: any;
	removeWatchedFolder: any;
	watchedFolderRevealTarget: any;
	syncWatchedFolder: any;
	stopWatchedFolderWatchers: any;
	WATCHED_FOLDERS_FILE: any;
	isImportInFlight: any;
	setImportInFlight: any;
	failedImportsFile: any;
	askIndexer: any;
	binInfo: any;
	loadSegments: any;
	thresholdsFor: any;
	calibrateThresholds: any;
	getModel: any;
	cosine: any;
	reembedToModel: any;
	migrationSettled: any;
	modelDownloaded: any;
	embedFileFor: any;
	preloadAllModels: any;
	readVideoQuality: any;
	writeSettings: any;
	removeLibraryRow: any;
	saveLibrary: any;
	backfillEnrichment: any;
	suspectedTruncatedVideos: any;
	segmentsBinFileFor: any;
	segmentsMetaFileFor: any;
	enrichPhaseCounts: any;
	getEnrichQueue: any;
	getEnrichEventsObserved: any;
	getEnrichProgressViolations: any;
	isEnrichInFlight: any;
	isTranscribeInFlight: any;
	healPhraseBin: any;
	phraseFileFor: any;
	ocrQueue: any;
	isOcrInFlight: any;
	enrichQueue: any;
	pruneStaleLibraryEntries: any;
	readBin: any;
	saveSegments: any;
	libraryIndex: any;
	rankSearch: any;
}

export async function runSmokeModes(deps: SmokeDeps): Promise<boolean> {
	const {
		win,
		requireDev,
		quitSmoke,
		importPaths,
		loadLibrary,
		resetLibraryCaches,
		resolveRevealTarget,
		PHOTOS_DIR,
		POSTERS_DIR,
		DATA_DIR,
		INDEX_FILE,
		WEB_PREFERENCES,
		DEFAULT_MODEL_ID,
		VIDEO_EXTENSIONS,
		youtube,
		mergeYoutubeIntermediates,
		backfillYoutubeMeta,
		repairSilentYoutubeImports,
		resolveYtDlpFfmpegLocation,
		runYoutubeJob,
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
		failedImportsFile,
		askIndexer,
		binInfo,
		loadSegments,
		thresholdsFor,
		calibrateThresholds,
		getModel,
		cosine,
		reembedToModel,
		migrationSettled,
		modelDownloaded,
		embedFileFor,
		preloadAllModels,
		readVideoQuality,
		writeSettings,
		removeLibraryRow,
		saveLibrary,
		backfillEnrichment,
		suspectedTruncatedVideos,
		segmentsBinFileFor,
		segmentsMetaFileFor,
		enrichPhaseCounts,
		getEnrichQueue,
		getEnrichEventsObserved,
		getEnrichProgressViolations,
		isEnrichInFlight,
		isTranscribeInFlight,
		healPhraseBin,
		phraseFileFor,
		ocrQueue,
		isOcrInFlight,
		enrichQueue,
		pruneStaleLibraryEntries,
		readBin,
		saveSegments,
		libraryIndex,
		rankSearch,
	} = deps;
	// Pipe renderer console into the smoke log: renderer-side warnings
	// ([ocr-search], [memory-search], React key errors) are invisible in
	// headless runs — which is exactly where they are needed. Smoke-only:
	// the production window never attaches this.
	win?.webContents.on("console-message", (...args: unknown[]) => {
		const ev = args[0] as { message?: string } | undefined;
		const legacy =
			typeof args[2] === "string" ? (args[2] as string) : undefined;
		const msg = ev?.message ?? legacy ?? "";
		if (msg) console.log(`[renderer] ${msg}`);
	});
	// Headless smoke mode: ELECTRON_SMOKE=1 verifies boot + protocol +
	// renderer, then quits. With ELECTRON_SMOKE_E2E=1 it additionally
	// imports two generated test photos through the real import path and
	// checks that semantic queries rank the right one first.
	if (process.env.ELECTRON_SMOKE_REVEAL) {
		try {
			const { runRevealTest } = requireDev("scripts/e2e/reveal.js");
			await runRevealTest({ importPaths, resolveRevealTarget, PHOTOS_DIR });
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[smoke] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_REIMPORT) {
		try {
			const { runReimportTest } = requireDev("scripts/e2e/reimport.js");
			await runReimportTest({ importPaths, loadLibrary });
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[smoke] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_WATCHED) {
		try {
			const { runWatchedFoldersTest } = requireDev("scripts/e2e/watched.js");
			await runWatchedFoldersTest({
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
			});
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[smoke] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_FAILCACHE) {
		try {
			const { runFailureCacheTest } = requireDev("scripts/e2e/failcache.js");
			await runFailureCacheTest({
				importPaths,
				loadLibrary,
				stopWatchedFolderWatchers,
				FAILED_IMPORTS_FILE: failedImportsFile(),
			});
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[smoke] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_RENAMEDEDUPE) {
		try {
			const { runRenameDedupeTest } = requireDev("scripts/e2e/renamededupe.js");
			await runRenameDedupeTest({
				importPaths,
				loadLibrary,
				stopWatchedFolderWatchers,
			});
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[smoke] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_YOUTUBE) {
		try {
			const { runYoutubeTest } = requireDev("scripts/e2e/youtube.js");
			await runYoutubeTest({
				importPaths,
				loadLibrary,
				youtube,
				mergeYoutubeIntermediates,
				backfillYoutubeMeta,
				repairSilentYoutubeImports,
				resolveYtDlpFfmpegLocation,
				runYoutubeJob,
				PHOTOS_DIR,
			});
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[smoke] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_OCR_HIGHLIGHT) {
		try {
			const { runOcrHighlightProbe } = requireDev(
				"scripts/e2e/ocr-highlight.js",
			);
			await runOcrHighlightProbe({ win, app });
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[smoke] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_UI_REVIEW) {
		try {
			const { runUiReview } = requireDev("scripts/e2e/ui-review.js");
			await runUiReview({ win, app, loadLibrary, resetLibraryCaches });
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[ui-review] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_SEARCH_MATRIX) {
		try {
			const { runSearchMatrixProbe } = requireDev(
				"scripts/e2e/search-matrix.js",
			);
			await runSearchMatrixProbe({ win });
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[smoke] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_PERF) {
		try {
			console.log("[perf] starting");
			const { runPerfTest } = requireDev("test/perf-test.js");
			await runPerfTest({
				win,
				app,
				loadLibrary,
				importPaths,
				askIndexer,
				binInfo,
				loadSegments,
				thresholdsFor,
				calibrateThresholds,
			});
			console.log("[perf] OK");
		} catch (err) {
			console.error("[perf] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_GRID) {
		try {
			console.log("[grid] starting");
			const { runPerfGridTest } = requireDev("test/perf-grid.test.js");
			await runPerfGridTest({ win, app, loadLibrary });
			console.log("[grid] OK");
		} catch (err) {
			console.error("[grid] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_MIGRATE) {
		try {
			const { runMigrateTest } = requireDev("scripts/e2e/migrate.js");
			await runMigrateTest({
				getModel,
				app,
				importPaths,
				loadLibrary,
				askIndexer,
				cosine,
				reembedToModel,
				migrationSettled,
				binInfo,
				thresholdsFor,
				modelDownloaded,
				embedFileFor,
				preloadAllModels,
			});
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[smoke] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
		return true;
	}

	if (process.env.ELECTRON_SMOKE_ASK) {
		let askOk = false;
		try {
			console.log("[ask-e2e] starting");
			const { runAskTest } = requireDev("scripts/e2e/ask.js");
			await runAskTest({ win, app });
			console.log("[smoke] OK");
			askOk = true;
		} catch (err) {
			console.error("[ask-e2e] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke(askOk ? 0 : 1);
		return true;
	}

	if (process.env.ELECTRON_SMOKE === "1") {
		try {
			console.log("[smoke] step: title");
			const title = await win.webContents.executeJavaScript("document.title");
			console.log("[smoke] step: list");
			const list = await win.webContents.executeJavaScript(
				"fetch('/memories-index.json').then(r => r.json()).then(j => j.images.length)",
			);
			console.log("[smoke] step: photo");
			const photos = await win.webContents.executeJavaScript(
				"fetch('/images/projects/nope.jpg').then(r => r.status)",
			);
			console.log(
				`[smoke] title=${title} libraryImages=${list} missingPhotoStatus=${photos}`,
			);

			// Modes are mutually exclusive (each expects a specific library
			// state; PHASE4 assumes a drained enrichment queue at start).
			if (process.env.ELECTRON_SMOKE_E2E === "1") {
				console.log("[e2e] starting");
				const { runE2E } = requireDev("scripts/e2e/e2e.js");
				await runE2E({
					cold: process.env.ELECTRON_SMOKE_COLD === "1",
					app,
					BrowserWindow,
					importPaths,
					loadLibrary,
					askIndexer,
					cosine,
					VIDEO_EXTENSIONS,
					segmentsBinFileFor,
					segmentsMetaFileFor,
					getEnrichEventsObserved,
					getEnrichQueue,
					isEnrichInFlight,
					isTranscribeInFlight,
				});
			} else if (process.env.ELECTRON_SMOKE_PHASE4 === "1") {
				console.log("[phase4] starting");
				const { runPhase4DeepTest } = requireDev("scripts/e2e/phase4.js");
				await runPhase4DeepTest({
					app,
					BrowserWindow,
					importPaths,
					loadLibrary,
					loadSegments,
					readVideoQuality,
					writeSettings,
					removeLibraryRow,
					saveLibrary,
					backfillEnrichment,
					reembedToModel,
					migrationSettled,
					suspectedTruncatedVideos,
					segmentsBinFileFor,
					segmentsMetaFileFor,
					POSTERS_DIR,
					PHOTOS_DIR,
					enrichPhaseCounts,
					getEnrichQueue,
					getEnrichEventsObserved,
					getEnrichProgressViolations,
				});
			} else if (process.env.ELECTRON_SMOKE_DEEP === "1") {
				console.log("[deep] starting");
				const { runDeepTest } = requireDev("test/deep-test.js");
				await runDeepTest({
					win,
					app,
					loadLibrary,
					importPaths,
					askIndexer,
					binInfo,
					thresholdsFor,
					calibrateThresholds,
					healPhraseBin,
					loadSegments,
					phraseFileFor,
					PHOTOS_DIR,
					POSTERS_DIR,
					getOcrState: () => ({
						queue: ocrQueue.length,
						inFlight: isOcrInFlight(),
					}),
					getEnrichQueue: () => enrichQueue.length,
				});
			} else if (process.env.ELECTRON_SMOKE_CTO === "1") {
				console.log("[cto] starting");
				const { runCtoFixesTest } = requireDev("test/cto-fixes-test.js");
				await runCtoFixesTest({
					win,
					app,
					fs,
					path,
					DEFAULT_MODEL_ID,
					loadLibrary,
					resetLibraryCache: resetLibraryCaches,
					pruneStaleLibraryEntries,
					readBin,
					saveLibrary,
					saveSegments,
					loadSegments,
					libraryIndex,
					rankSearch,
					embedFileFor,
					phraseFileFor,
					segmentsBinFileFor,
					segmentsMetaFileFor,
					PHOTOS_DIR,
					DATA_DIR,
					INDEX_FILE,
					getWebPreferences: () => WEB_PREFERENCES,
				});
			} else if (process.env.ELECTRON_SMOKE_SCENENOISE === "1") {
				console.log("[scenenoise] starting");
				const { runSceneNoiseTest } = requireDev("test/scene-noise-test.js");
				await runSceneNoiseTest({
					win,
					loadLibrary,
					importPaths,
					loadSegments,
					getEnrichQueue: () => enrichQueue.length,
				});
			}
			console.log("[smoke] OK");
		} catch (err) {
			console.error("[smoke] FAILED:", err);
			process.exitCode = 1;
		}
		quitSmoke();
	}
	return false;
}
