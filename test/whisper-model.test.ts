import { expect, test } from "bun:test";
import {
	DEFAULT_WHISPER_MODEL,
	WHISPER_MODEL_IDS,
	parseWhisperModel,
} from "../src/lib/whisperModel";

// The renderer-side parse must accept exactly the two engine ids the
// main process stores (indexer/transcript-store-utils.js WHISPER_MODELS).
// small.en was removed (OOM on 8GB) — it aliases to base.en.
test("parseWhisperModel accepts tiny.en and base.en", () => {
	expect(parseWhisperModel("tiny.en")).toBe("tiny.en");
	expect(parseWhisperModel("base.en")).toBe("base.en");
});

test("parseWhisperModel aliases legacy small.en to base.en", () => {
	expect(parseWhisperModel("small.en")).toBe("base.en");
});

test("parseWhisperModel falls back to tiny.en on garbage", () => {
	expect(parseWhisperModel(null)).toBe("tiny.en");
	expect(parseWhisperModel(undefined)).toBe("tiny.en");
	expect(parseWhisperModel("")).toBe("tiny.en");
	expect(parseWhisperModel("small")).toBe("tiny.en");
	expect(parseWhisperModel("TINY.EN")).toBe("tiny.en");
	expect(parseWhisperModel("large-v3")).toBe("tiny.en");
	expect(parseWhisperModel(2)).toBe("tiny.en");
});

test("preset ids and default stay in sync with the main-process table", () => {
	expect([...WHISPER_MODEL_IDS].sort()).toEqual(["base.en", "tiny.en"]);
	expect(DEFAULT_WHISPER_MODEL).toBe("tiny.en");
});
