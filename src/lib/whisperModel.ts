// Speech-model preference (Settings → Video search → Speech model): the
// whisper engine for background transcription. Pure helpers live here so
// parsing is unit-testable without a DOM or IPC bridge. Must stay in sync
// with WHISPER_MODELS in indexer/transcript-store-utils.js (the engine ids
// and timeout math live there; these blurbs only describe them).

export type WhisperModelSetting = "tiny.en" | "base.en";

export const WHISPER_MODEL_IDS: WhisperModelSetting[] = ["tiny.en", "base.en"];

export const DEFAULT_WHISPER_MODEL: WhisperModelSetting = "tiny.en";

// One-line cost/benefit blurbs shown under each option in Settings.
export const WHISPER_MODEL_BLURBS: Record<WhisperModelSetting, string> = {
	"tiny.en": "Fast, background-friendly",
	"base.en": "Best words, ~300MB download",
};

/** Parses a stored/bridge value into a valid setting; legacy "small.en" → "base.en", anything else → "tiny.en". */
export function parseWhisperModel(raw: unknown): WhisperModelSetting {
	if (raw === "small.en") return "base.en";
	return raw === "tiny.en" || raw === "base.en" ? raw : DEFAULT_WHISPER_MODEL;
}
