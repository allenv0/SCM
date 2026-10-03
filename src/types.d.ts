// Window bridge types — the preload script exposes window.memories.
// L1 FP: fields are `readonly` (bridge payloads flow main -> renderer and
// must never be mutated in place — copy-then-sort / spread instead).
// Arrays stay mutable `T[]` (not `readonly T[]`) for now: flipping to deep
// readonly cascades into useState types + hot Float32Array loops where
// in-place math is intentional. See MDs/archive/Functional-Programming-Paradigm.md §6.

export interface ImportResult {
	readonly added: string[];
	readonly skipped: string[];
	readonly errors: { readonly file: string; readonly error: string }[];
	/** Folders newly added to the auto-watch list by this import (basenames). */
	readonly watched: string[];
}

export type ModelPhase = "loading" | "ready" | "error";

/** A folder the app watches: new photos in it are imported automatically
 *  (on every launch, and live while the app runs). Importing a folder
 *  through Import Photos adds it here. */
export interface WatchedFolder {
	/** Absolute path of the watched folder. */
	readonly path: string;
	/** Whether the folder currently exists on disk (it may have been
	 *  renamed/unmounted — the watch survives until the user stops it). */
	readonly exists: boolean;
}

export type ImportPhase =
	| "copying"
	| "embedding"
	| "poster"
	| "indexing"
	// Terminal event broadcast at batch end (even for main-initiated syncs)
	// — the renderer clears its progress card on it.
	| "done";

/** Phase of a model migration (re-embedding the library in a new model). */
export type MigratePhase = "embedding" | "indexing";

/** Phase of the background scene-analysis tray (Phase 4). */
export type EnrichPhase =
	| "detect" // ffmpeg shot-detection pass (longest for big films)
	| "embed" // per-segment CLIP embedding, chunked
	| "queued" // waiting in the background queue
	| "paused" // paused while a search/import runs
	| "done"
	| "idle";

/** Phase of the background OCR tray (visible text extraction). */
export type OcrPhase =
	| "queued" // waiting in the background queue
	| "ocr" // actively recognizing text
	| "idle";

/** Per-model ranking thresholds; calibrated in the main process. */
export interface ModelThresholds {
	readonly minSemanticScore: number;
	readonly relativeKeep: number;
}

/** One named embedding version (Settings → Library): a point-in-time
 *  snapshot of the searchable state across every model. */
export interface EmbeddingVersion {
	readonly slug: string;
	readonly name: string;
	readonly createdAt: string;
	readonly appVersion: string | null;
	readonly activeModelId: string | null;
	readonly modelIds: string[];
	readonly rowCount: number;
	readonly totalBytes: number;
	readonly settings: {
		readonly videoQuality?: string | null;
		readonly whisperModel?: string | null;
		readonly ocrLangs?: string[] | null;
	} | null;
}

/** One entry of the model registry manifest (/memories-models.json). */
export interface ModelInfo {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly dim: number;
	readonly inputSize: number;
	readonly license: string;
	readonly speed: string;
	readonly quality: string;
	readonly thresholds: ModelThresholds | null;
	/** Rows currently in this model's on-disk embedding bin (0 = never used). */
	readonly binCount: number;
	readonly calibrated: boolean;
	/** True when the model's weights are on disk (drives the picker's
	 *  per-model Download chip + the "download all" affordance). */
	readonly downloaded: boolean;
}

export interface ModelsManifest {
	readonly version: number;
	readonly activeModelId: string;
	readonly models: ModelInfo[];
}

export interface SetModelResult {
	readonly modelId: string;
	readonly reembedded: number;
	readonly failures: string[];
}

export type StatusPayload =
	| {
			type: "model";
			phase: ModelPhase;
			progress?: number | null;
			/** True while the model weights are absent from the cache (first launch). */
			firstRun?: boolean;
			/** The model the status describes. */
			modelId?: string;
	  }
	| {
			type: "migrate";
			phase: MigratePhase;
			done: number;
			total: number;
			/** The target model the library is being re-embedded for. */
			modelId: string;
	  }
	| {
			type: "import";
			phase: ImportPhase;
			filename: string;
			done?: number;
			total?: number;
	  }
	| { type: "library-updated" }
	| {
			type: "enrich";
			phase: EnrichPhase;
			/** The video currently being analyzed (active phases only). */
			filename?: string | null;
			/** Shot-detection decode progress 0..1 (null until the first tick). */
			pct?: number | null;
			/** Segments embedded so far (embed phase). */
			done?: number;
			/** Total segments for this video (embed phase). */
			total?: number;
			/** Videos still waiting in the background queue. */
			pending: number;
			/** True while a video is actively being analyzed. */
			active?: boolean;
			/** True while the user paused background work (tray toggle). */
			paused?: boolean;
	  }
	| {
			type: "transcribe";
			phase: "transcribe" | "queued" | "done" | "idle";
			/** The video currently being transcribed (active phases only). */
			filename?: string | null;
			/** Chunks transcribed so far. */
			done?: number;
			/** Total chunks for this video. */
			total?: number;
			/** Videos still waiting in the background queue. */
			pending: number;
			/** True while a video is actively being transcribed. */
			active?: boolean;
			/** True while the user paused background work (tray toggle). */
			paused?: boolean;
	  }
	| {
			type: "heal";
			/** Rows successfully re-embedded. */
			healed: number;
			/** Rows found corrupted and attempted. */
			attempted: number;
	  }
	| {
			type: "ocr";
			phase: OcrPhase;
			/** The photo currently being recognized (active phases only). */
			filename?: string | null;
			/** Photos recognized so far in this drain. */
			done?: number;
			/** Photos queued in this drain. */
			total?: number;
			/** Photos still waiting in the background queue. */
			pending: number;
			/** True while a photo is actively being recognized. */
			active?: boolean;
			/** True while the user paused background work (tray toggle). */
			paused?: boolean;
			/** Recognitions that failed in this drain (failed rows keep prior
			 *  text and retry on the next launch). Present on live broadcasts;
			 *  absent on older payloads. */
			failed?: number;
	  }
	| {
			type: "model-preload";
			/** The model whose weights are being downloaded. */
			modelId: string;
			phase: "loading" | "ready" | "error";
			progress?: number | null;
	  }
	| {
			type: "llm";
			/** Ask-mode sidecar lifecycle (MDs/Ask-Mode-Plan.md). Downloaded
			 *  target rides `target` ("binary" or a model id); progress is
			 *  0-100 during downloading. The tray never reads this type. */
			phase: "idle" | "downloading" | "loading" | "ready" | "error";
			target?: string;
			modelId?: string;
			progress?: number | null;
			detail?: string | null;
	  }
	| {
			type: "shortcut-error";
			/** Human-readable explanation of why registration failed. */
			error: string;
	  }
	| {
			type: "open-settings";
			/** Sent by the menu-bar tray ("Open Settings…"): the window is
			 *  already focused — just open the Settings sheet. */
	  };

/** AI insights for a single photo (what the AI "sees"). */
export interface AiInsightsConcept {
	/** The sample query this image matched. */
	readonly query: string;
	/** How strongly the image matches (0–1). */
	readonly score: number;
}

/** Ask-mode LLM config (settings.json `llm`, read back over the bridge). */
export interface LlmConfig {
	readonly enabled: boolean;
	readonly chatModel: string;
}

/** One entry of the LLMs model registry (Settings → LLMs Chat). */
export interface LlmModelInfo {
	readonly id: string;
	readonly label: string;
	/** Compact name for tight UI (search placeholder, badges). */
	readonly shortLabel: string;
	readonly blurb: string;
	readonly sizeBytes: number;
	readonly ctxTokens: number;
	readonly license: string;
	readonly speed: string;
	readonly downloaded: boolean;
}

/** LLMs sidecar status (binary + running process). */
export interface LlmServerStatus {
	readonly binaryDownloaded: boolean;
	readonly binaryTag: string | null;
	readonly running: boolean;
	readonly modelId: string | null;
}

export interface LlmStatus {
	readonly enabled: boolean;
	readonly chatModel: string;
	readonly models: LlmModelInfo[];
	readonly server: LlmServerStatus;
}

/** One evidence row behind an LLMs answer. Ordered — the index is the
 *  citation number the answer text refers to. */
export interface AskEvidenceRow {
	readonly kind: "ocr" | "dialogue" | "keyword";
	readonly filename: string;
	readonly score: number;
	/** OCR text / dialogue snippet (truncated, citation-ready). */
	readonly text?: string;
	readonly snippet?: string;
	/** Dialogue moment: seek time, shot span, scene-poster index. */
	readonly t?: number;
	readonly dur?: number;
	readonly poster?: number;
	readonly tier?: number;
	readonly tierLabel?: string;
}

/** The memories:ask result. `answer` is null with a `reason` when the
 *  evidence gate (or the disabled/missing install path) skipped the LLM.
 *  `stopped` + `partial` carry a user-stopped generation: what arrived
 *  stays visible instead of vanishing. */
export interface AskResult {
	readonly ok: boolean;
	readonly answer?: string | null;
	readonly reason?:
		| "empty"
		| "no-evidence"
		| "disabled"
		| "not-installed"
		| "stopped"
		| "error";
	readonly missing?: "binary" | "model";
	readonly error?: string;
	readonly stopped?: boolean;
	readonly partial?: string | null;
	/** Process numbers (retrieval cost measured, generation from the
	 *  sidecar's timings when reported). Absent on gated/error paths. */
	readonly stats?: AskStats;
	readonly evidence: AskEvidenceRow[];
}

/** Streaming LLMs event payloads (memories:ask-evidence / ask-token).
 *  `reqId` echoes the renderer's request id for stale-flight filtering. */
export interface AskEvidenceEvent {
	readonly reqId: number;
	readonly evidence: AskEvidenceRow[];
}

export interface AskTokenEvent {
	readonly reqId: number;
	readonly delta: string;
}

/** Cold-start notice (memories:ask-phase): sent only when the sidecar
 *  isn't resident and must spawn before generating. */
export interface AskPhaseEvent {
	readonly reqId: number;
	readonly phase: "spawning";
	readonly modelLabel?: string;
	readonly sizeBytes?: number | null;
}

/** Process numbers behind an LLMs answer. Retrieval fields are measured;
 *  generation fields come from the sidecar's own `timings` when the build
 *  reports them, else stay absent and the card estimates (flagged `~`). */
export interface AskStats {
	readonly filesScanned: number;
	readonly dialogueHits: number;
	readonly ocrHits: number;
	readonly keywordHits: number;
	readonly tier: "standard" | "wide" | "custom";
	readonly retrievalMs: number;
	readonly coldStart?: boolean;
	readonly elapsedMs?: number;
	readonly promptTokens?: number;
	readonly predictedTokens?: number;
	readonly tokensPerSec?: number;
	/** Engine facts for the expanded breakdown (registry + runtime). */
	readonly modelLabel?: string;
	readonly ctxTokens?: number | null;
	readonly sizeBytes?: number | null;
	readonly threads?: number;
	/** GPU path when known statically ("Metal" on macOS, else absent —
	 *  never claimed when the runtime may have fallen back to CPU). */
	readonly accelerator?: string | null;
}

export interface AiInsights {
	readonly filename: string;
	/** Keywords derived from the filename (e.g. ["screenshot", "2024", "game"]). */
	readonly keywords: string[];
	/** OCR-extracted text, if any was found in the image. */
	readonly ocrText: string | null;
	/** The CLIP model ID that processed this image. */
	readonly modelId: string;
	/** Human-readable model name. */
	readonly modelName: string;
	/** Top sample-query concepts this image matches, sorted by score. */
	readonly concepts: AiInsightsConcept[];
}

interface MemoriesBridge {
	embedQuery(text: string): Promise<number[] | null>;
	/** Rank the library against a query on the main process (no renderer math).
	 *  M-11 single round-trip: returns an ARRAY with an extra `queryVec`
	 *  prop (structured clone preserves it) so scene/transcript fusion never
	 *  re-embeds. Always Array.isArray(); queryVec is null when ranking fell
	 *  back. Legacy {results, queryVec} / bare array still accepted. */
	rankSearch(
		query: string,
		topK?: number,
	): Promise<
		| ({
				filename: string;
				score: number;
				dominant?: "semantic" | "phrase" | "filename" | "ocr";
				breakdown?: {
					semantic: number;
					phrase: number;
					filename: number;
					ocr: number;
				};
		  }[] & { queryVec?: number[] | null })
		| {
				results: {
					filename: string;
					score: number;
					dominant?: "semantic" | "phrase" | "filename" | "ocr";
					breakdown?: {
						semantic: number;
						phrase: number;
						filename: number;
						ocr: number;
					};
				}[];
				queryVec: number[] | null;
		  }
	>;
	/** Pure-visual scene moments (legacy-exact ranking, off-renderer).
	 *  Null-safe: [] when unavailable. why is always "visual". */
	rankScenes?(
		query: string,
		topK?: number,
	): Promise<
		{
			filename: string;
			score: number;
			t: number;
			dur: number;
			poster: number;
			why: "visual" | "text" | "both";
			snippet?: string | null;
		}[]
	>;
	/** Pure-transcript dialogue moments (speech index only). Null-safe: []
	 *  when unavailable. why is always "text", snippet always attached. */
	rankDialogue?(
		query: string,
		topK?: number,
	): Promise<
		{
			filename: string;
			score: number;
			t: number;
			dur: number;
			poster: number;
			why: "visual" | "text" | "both";
			snippet?: string | null;
		}[]
	>;
	/** Background transcription state (mirrors enrich-state). */
	getTranscribeState?(): Promise<StatusPayload | null>;
	importPaths(paths: string[]): Promise<ImportResult>;
	pickPhotos(): Promise<ImportResult | null>;
	/** App version from package.json (Settings footer, N-06). */
	getVersion(): Promise<string>;
	/** Folders watched for auto-import (see WatchedFolder). */
	getWatchedFolders(): Promise<WatchedFolder[]>;
	/** Reveal a watched folder in the OS file manager (Finder). */
	revealWatchedFolder(folder: string): Promise<{ ok: boolean }>;
	/** Stop watching a folder — its photos stay in the library. */
	removeWatchedFolder(folder: string): Promise<{ ok: boolean }>;
	revealInFinder(filename: string): Promise<{ ok: boolean }>;
	/** Open a library file in the OS default app (full-file playback for
	 *  searchable-only video containers the in-app player cannot demux). */
	openExternal?(
		filename: string,
	): Promise<{ ok: boolean; error?: string }>;
	deleteMemory(filename: string): Promise<{ ok: boolean }>;
	/** Pin a photo into (or out of) the Screenshots tab. The decision is
	 *  keyed by content hash in main and beats every automatic signal;
	 *  null clears it. The main process broadcasts "library-updated" so the
	 *  grid reloads with the new category. */
	setCategoryOverride(
		filename: string,
		category: "Screenshots" | "Projects" | null,
	): Promise<{ ok: boolean; error?: string }>;
	getIndexerStatus(): Promise<StatusPayload | null>;
	/** Current background scene-analysis state (Phase 4 tray). */
	getEnrichState(): Promise<StatusPayload | null>;
	/** Current background OCR state (visible-text extraction tray). */
	getOcrState(): Promise<StatusPayload | null>;
	/** Switch the library to another model: re-embeds every row (or flips
	 *  instantly when the target's bins already exist), then flips the index.
	 *  Progress streams as "migrate" status events. */
	setModel(modelId: string): Promise<SetModelResult>;
	/** Download one model's weights WITHOUT switching to it. Resolves
	 *  { modelId, downloaded, skipped? } — progress streams as
	 *  "model-preload" status events. */
	preloadModel(modelId: string): Promise<{
		modelId: string;
		downloaded?: boolean;
		skipped?: boolean;
		error?: string;
		/** Human-readable reason when skipped (active model / migration-owned). */
		note?: string;
	}>;
	/** Download every model's weights so future switches are instant. */
	preloadAllModels(): Promise<
		{
			modelId: string;
			downloaded?: boolean;
			skipped?: boolean;
			error?: string;
			note?: string;
		}[]
	>;
	getPathForFile(file: File): string;
	/** Read the user's global shortcut (Electron accelerator string, or null). */
	getShortcut(): Promise<string | null>;
	/** Save a global shortcut to bring SCM to focus. Pass null to clear. */
	setShortcut(
		accelerator: string | null,
	): Promise<{ ok: boolean; error?: string }>;
	/** Whether menu-bar-only mode is on (Dock hidden, tray icon resident). */
	getMenuBarOnly(): Promise<boolean>;
	/** Enable/disable menu-bar-only mode. Applies live, no restart needed. */
	setMenuBarOnly(
		enabled: boolean,
	): Promise<{ ok: boolean; enabled?: boolean; error?: string }>;
	/** Whether the first-run CRT tour has shown (settings.json marker). */
	getOnboardingSeen(): Promise<boolean>;
	/** Mark the first-run CRT tour seen/unseen. Resolves { ok }. */
	setOnboardingSeen(
		seen: boolean,
	): Promise<{ ok: boolean; onboardingSeen?: boolean; error?: string }>;
	/** Tray companion settings: OS login item, start-hidden, completion notes. */
	getTraySettings(): Promise<{
		openAtLogin: boolean;
		startHidden: boolean;
		notifyOnDone: boolean;
	}>;
	/** Save tray companion settings (any subset). Applies live. */
	setTraySettings(patch: {
		openAtLogin?: boolean;
		startHidden?: boolean;
		notifyOnDone?: boolean;
	}): Promise<{
		ok: boolean;
		settings?: {
			openAtLogin: boolean;
			startHidden: boolean;
			notifyOnDone: boolean;
		};
		error?: string;
	}>;
	/** Read the video search quality preset (eco | balanced | detailed | ultra | ultraPro). */
	getVideoQuality(): Promise<string>;
	/** Save the video search quality preset. Applies to videos analyzed
	 *  after the change; existing scene data keeps its old density until
	 *  reanalyzeVideos() runs. */
	setVideoQuality(
		quality: string,
	): Promise<{ ok: boolean; quality?: string; error?: string }>;
	/** Read the speech-model preference (tiny.en | base.en). */
	getWhisperModel(): Promise<string>;
	/** Save the speech-model preference. Invalidates the speech sidecar and
	 *  re-queues every video for background transcription. Resolves
	 *  { ok, model, queued }. */
	setWhisperModel(
		model: string,
	): Promise<{ ok: boolean; model?: string; queued?: number; error?: string }>;
	/** Read the OCR text-language selection (array of chi_sim, chi_tra, jpn, kor; eng is always on). */
	getOcrLangs(): Promise<string[]>;
	/** Save the OCR text-language selection. Re-queues every photo for
	 *  background re-OCR under the new traineddata set. Resolves
	 *  { ok, langs, queued }. */
	setOcrLangs(langs: string[]): Promise<{
		ok: boolean;
		langs?: string[];
		queued?: number;
		error?: string;
	}>;
	/** Re-read every library photo under the current OCR languages.
	 *  Resolves { ok, queued }. Per-row failures surface in the main-process
	 *  drain summary log and retry on the next launch. */
	reocrPhotos(): Promise<{ ok: boolean; queued?: number; error?: string }>;
	/** Read the app-icon choice (Settings → Appearance → App Icon). */
	getAppIcon(): Promise<string>;
	/** Save the app-icon choice. Applies live to Dock + windows. */
	setAppIcon(
		id: string,
	): Promise<{ ok: boolean; appIcon?: string; error?: string }>;
	/** Debug: settings file vs memory for app icon (staging while hidden). */
	getAppIconDebug?(): Promise<any>;
	/** Drop every library video's scene data and re-queue it for background
	 *  analysis under the current quality preset. Resolves { ok, queued }. */
	reanalyzeVideos(): Promise<{ ok: boolean; queued?: number }>;
	/** Per-video scene-coverage durations (seconds) for the Settings cost
	 *  line, measured from each video's segment sidecar (last row's
	 *  coverage end). Videos without scene data are omitted from `durations`
	 *  and counted in `unknownCount` — no measured length yet. */
	videosCostEstimate(): Promise<{
		ok: boolean;
		videoCount?: number;
		knownSeconds?: number;
		unknownCount?: number;
		durations?: number[];
		error?: string;
	}>;
	/** Detect sidecars truncated by the pre-fix chunk-accumulation bug
	 *  (scene search covers only the film's final minutes). Resolves
	 *  { ok, count, videos } — count is 0 when everything is fine. */
	suspectedTruncatedVideos(): Promise<{
		ok: boolean;
		count?: number;
		videos?: { filename: string; planned?: number; actual?: number }[];
	}>;
	/** List named embedding versions (newest first). */
	getEmbeddingVersions(): Promise<{
		ok: boolean;
		versions?: EmbeddingVersion[];
	}>;
	/** Snapshot the current searchable state under a name. */
	createEmbeddingVersion(name: string): Promise<{
		ok: boolean;
		slug?: string;
		totalBytes?: number;
		error?: string;
	}>;
	/** Rename a version (slug is stable — only the display name changes). */
	renameEmbeddingVersion(
		slug: string,
		name: string,
	): Promise<{ ok: boolean; error?: string }>;
	/** Delete a version and free its disk immediately. */
	deleteEmbeddingVersion(slug: string): Promise<{
		ok: boolean;
		error?: string;
	}>;
	/** Restore a version (auto-backs-up current state first). Resolves
	 *  { ok, backupSlug, restored, missing } — missing lists rows whose
	 *  app copy is gone on disk. */
	restoreEmbeddingVersion(slug: string): Promise<{
		ok: boolean;
		backupSlug?: string;
		restored?: string;
		missing?: string[];
		error?: string;
	}>;
	/** Delete the entire photo index and every derived artifact (fresh
	 *  start). Resolves { ok, rows, unwatched, files } — rows wiped,
	 *  watched folders stopped, files removed. Originals, settings,
	 *  weights, and versions are kept. */
	resetLibrary(): Promise<{
		ok: boolean;
		rows?: number;
		unwatched?: number;
		files?: number;
		error?: string;
	}>;
	/** Pause/resume all background pumps (scene analysis, transcription,
	 *  text extraction). Session-only — a relaunch resumes work. */
	setBackgroundPaused(paused: boolean): Promise<{
		ok: boolean;
		paused?: boolean;
	}>;
	/** Stop all background pumps cold: drops queued units, prunes orphan
	 *  sidecars, kills zombie workers. Unfinished videos re-queue fresh
	 *  next launch. Resolves { ok, queued, orphans }. */
	purgeBackground(): Promise<{
		ok: boolean;
		queued?: number;
		orphans?: number;
		error?: string;
	}>;
	/** AI insights for a photo: keywords, OCR text, model info, and visual concepts. */
	getAiInsights(filename: string): Promise<AiInsights | null>;
	/** LLMs mode (MDs/Ask-Mode-Plan.md): embedded sidecar status for the
	 *  Settings section + the grid's LLMs toggle visibility. */
	getLlmStatus(): Promise<LlmStatus>;
	/** Save the LLMs config (any subset). Returns the effective config. */
	setLlmConfig(patch: {
		enabled?: boolean;
		chatModel?: string;
	}): Promise<{ ok: boolean; config?: LlmConfig; error?: string }>;
	/** Download the sidecar binary ("binary") or one model's GGUF. Progress
	 *  streams as {type:"llm"} status events; resolves when done/failed. */
	downloadLlm(
		target: string,
	): Promise<{ ok: boolean; skipped?: boolean; error?: string }>;
	/** Ask the library a question with the local LLM. `filenames` is the scope the renderer
	 *  derived (empty/omitted = whole library); main validates every name
	 *  against the live index. `reqId` (renderer counter) echoes back on the
	 *  ask-evidence/ask-token events so stale flights filter cleanly. Never throws. */
	askScm(payload: {
		query: string;
		filenames?: string[];
		reqId?: number;
	}): Promise<AskResult>;
	/** Abort an in-flight Ask generation (the sidecar fetch stops; the
	 *  invoke resolves with reason "stopped" + partial text). Fire-and-forget. */
	stopAsk(reqId: number): void;
	/** Evidence-first event: chips + grid populate while the answer streams. */
	onAskEvidence(
		callback: (payload: AskEvidenceEvent & { stats?: AskStats }) => void,
	): () => void;
	/** Token deltas for the current generation. */
	onAskToken(callback: (payload: AskTokenEvent) => void): () => void;
	/** Cold-start notice (spawning phase), sent only when needed. */
	onAskPhase(callback: (payload: AskPhaseEvent) => void): () => void;
	onStatus(callback: (payload: StatusPayload) => void): () => void;
}

declare global {
	interface Window {
		memories: MemoriesBridge;
	}
}

export {};
