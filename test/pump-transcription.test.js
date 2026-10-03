"use strict";

// ---------------------------------------------------------------------------
// pumpTranscription chunk-accumulation unit test — the seconds-fast half of
// the transcript sidecar suite (mirrors test/pump-enrichment.test.js).
//
//   Run:  node test/pump-transcription.test.js
//
// The transcribe worker returns only the slice it embedded THIS call, so
// pumpTranscription must ACCUMULATE each chunk into the file's sidecar list.
// No Electron, no ffmpeg, no whisper binary: milliseconds.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const {
	TRANSCRIPT_ROW_PER,
	TRANSCRIPTS_PER_CHUNK,
	TRANSCRIBE_CHUNK_TIMEOUT_MS,
	TRANSCRIBE_MAX_RETRIES,
	TRANSCRIBE_LOAD_MAX_RETRIES,
	transcribeExitLabel,
	transcribeFailureLabel,
	isLoadPhaseCrash,
	buildTranscriptChunks,
	cleanTranscriptText,
	isRealTranscriptText,
	mergeChunkTranscripts,
	partitionTranscriptReply,
	suspectedTruncatedTranscripts,
} = require("../indexer/transcript-store-utils.js");

let passed = 0;
let failed = 0;

function check(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}: ${err.message}`);
	}
}

function planChunks(total, duration, stepSeconds) {
	const plan = Array.from({ length: total }, (_, i) => ({
		t0: Math.round(i * stepSeconds),
		t1: Math.round(i * stepSeconds + stepSeconds),
		text: `utterance number ${i} about pricing and refunds spoken clearly`,
	}));
	const chunks = [];
	for (let from = 0; from < plan.length; from += TRANSCRIPTS_PER_CHUNK) {
		chunks.push(plan.slice(from, from + TRANSCRIPTS_PER_CHUNK));
	}
	return chunks;
}

function simulateTranscription(chunks) {
	const videos = new Map();
	const rows = [];
	for (const chunk of chunks) {
		const base = rows.length;
		const merged = mergeChunkTranscripts(
			videos.get("talk.mp4") || [],
			chunk,
			base,
			TRANSCRIPT_ROW_PER,
		);
		videos.set("talk.mp4", merged);
		rows.push(...chunk.map((_, i) => new Float32Array([base + i])));
	}
	return { chunks: videos.get("talk.mp4"), rows };
}

// ---------------------------------------------------------------------------
console.log("[pump-transcription] multi-chunk accumulation (the regression)");
// ---------------------------------------------------------------------------
{
	const chunks = planChunks(40, 600, 15);
	const { chunks: kept, rows } = simulateTranscription(chunks);

	check("40 chunks planned → 3 drains (16/16/8)", () => {
		assert.deepEqual(
			chunks.map((c) => c.length),
			[16, 16, 8],
		);
	});

	check("ALL 40 chunks survive (not just the last drain's 8)", () => {
		assert.equal(kept.length, 40, `only ${kept.length} survived`);
	});

	check("first drain's chunks are still there (early film searchable)", () => {
		assert.equal(kept[0].t0, 0);
		assert.equal(kept[15].t0, 15 * 15);
	});

	check("coverage spans the whole film, not just the end", () => {
		assert.equal(kept[0].t0, 0);
		assert.equal(kept[39].t0, 15 * 39);
		assert.ok(kept[39].t1 - kept[0].t0 > 500, "span too short");
	});

	check("offsets are unique, contiguous, and land inside the bin", () => {
		const offs = kept.map((s) => s.off);
		assert.deepEqual(
			offs,
			Array.from({ length: 40 }, (_, i) => i),
		);
		assert.ok(
			offs.every((o) => o < rows.length),
			"offset outside bin",
		);
	});

	check("every row carries n = TRANSCRIPT_ROW_PER and capped text", () => {
		for (const s of kept) {
			assert.equal(s.n, TRANSCRIPT_ROW_PER);
			assert.ok(s.t1 > s.t0);
			assert.ok(s.text.length > 0 && s.text.length <= 240);
		}
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-transcription] single chunk (short clip — unaffected path)");
// ---------------------------------------------------------------------------
{
	const chunks = planChunks(12, 300, 25);
	const { chunks: kept } = simulateTranscription(chunks);

	check("single chunk passes through whole", () => {
		assert.equal(chunks.length, 1);
		assert.equal(kept.length, 12);
		assert.deepEqual(
			kept.map((s) => s.off),
			Array.from({ length: 12 }, (_, i) => i),
		);
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-transcription] chunking (utterance → windows)");
// ---------------------------------------------------------------------------
{
	check("empty input → [] (silent film is valid, not retried)", () => {
		assert.deepEqual(buildTranscriptChunks([]), []);
		assert.deepEqual(buildTranscriptChunks(null), []);
	});

	check("groups ~30 s windows with overlap, sentence-safe", () => {
		const utterances = Array.from({ length: 12 }, (_, i) => ({
			t0: i * 10,
			t1: i * 10 + 8,
			text: `Sentence number ${i} about the product launch.`,
		}));
		const out = buildTranscriptChunks(utterances);
		assert.ok(out.length >= 3 && out.length <= 8, `got ${out.length}`);
		assert.equal(out[0].t0, 0);
		for (const c of out) assert.ok(c.t1 > c.t0);
	});

	check("drops non-finite / empty utterances", () => {
		const out = buildTranscriptChunks([
			{ t0: 0, t1: 5, text: "Hello world pricing plans" },
			{ t0: NaN, t1: 9, text: "bad timestamp here" },
			{ t0: 10, t1: 8, text: "inverted range here" },
			{ t0: 12, t1: 18, text: "   " },
		]);
		assert.equal(out.length, 1);
	});

	check("rejects music-hallucination loops", () => {
		assert.equal(
			isRealTranscriptText("thank you thank you thank you thank you thank you"),
			false,
		);
		assert.equal(
			isRealTranscriptText("where she explains the pricing model today"),
			true,
		);
		assert.equal(isRealTranscriptText("hi"), false);
	});

	check("caps text at 240 chars", () => {
		assert.ok(cleanTranscriptText("x ".repeat(500)).length <= 240);
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-transcription] partition + validation");
// ---------------------------------------------------------------------------
{
	check("partition keeps ok rows, counts skipped", () => {
		const { okChunks, okVecs, skipped } = partitionTranscriptReply(
			[
				{ t0: 0, t1: 10, text: "where she explains pricing today" },
				{
					t0: 10,
					t1: 20,
					text: "thank you thank you thank you thank you thank you",
				},
				{ t0: 20, t1: 30, text: "when they mention refunds tomorrow" },
			],
			[[0.1], null, [0.3]],
		);
		assert.equal(okChunks.length, 2);
		assert.equal(okVecs.length, 2);
		assert.equal(skipped, 1);
	});

	check("merge validates inputs (TypeError, never silent drop)", () => {
		assert.throws(() => mergeChunkTranscripts(null, [], 0, 1), TypeError);
		assert.throws(() => mergeChunkTranscripts([], null, 0, 1), TypeError);
		assert.throws(() => mergeChunkTranscripts([], [], -1, 1), TypeError);
		assert.throws(() => mergeChunkTranscripts([], [], 0, 0), TypeError);
	});

	check("timeouts/retries sane", () => {
		assert.ok(TRANSCRIBE_CHUNK_TIMEOUT_MS >= 16 * 30000);
		assert.ok(TRANSCRIBE_MAX_RETRIES >= 1 && TRANSCRIBE_MAX_RETRIES <= 5);
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-transcription] truncation heuristic");
// ---------------------------------------------------------------------------
{
	check("tail-clustered multi-chunk sidecar flagged", () => {
		const videos = new Map([
			[
				"film.mp4",
				Array.from({ length: 16 }, (_, i) => ({
					t0: 3360 + i * 30,
					t1: 3390 + i * 30,
					off: i,
					n: 1,
					text: `line ${i} about refunds`,
				})),
			],
		]);
		const flagged = suspectedTruncatedTranscripts(videos);
		assert.equal(flagged.length, 1);
		assert.equal(flagged[0].filename, "film.mp4");
	});

	check("full-coverage sidecar not flagged", () => {
		const videos = new Map([
			[
				"talk.mp4",
				Array.from({ length: 20 }, (_, i) => ({
					t0: i * 30,
					t1: i * 30 + 28,
					off: i,
					n: 1,
					text: `point ${i} about pricing plans`,
				})),
			],
		]);
		assert.equal(suspectedTruncatedTranscripts(videos).length, 0);
	});

	check("non-Map input → [] (never throws at startup)", () => {
		assert.deepEqual(suspectedTruncatedTranscripts(null), []);
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-transcription] exit attribution (worker-died diagnostics)");
// ---------------------------------------------------------------------------
{
	check("SIGKILL names the OOM hint, plain code stays plain", () => {
		assert.match(transcribeExitLabel(1, null), /exit code 1/);
		assert.match(transcribeExitLabel(null, "SIGKILL"), /SIGKILL/);
		assert.match(transcribeExitLabel(null, "SIGKILL"), /OOM/);
		assert.match(transcribeExitLabel(null, "SIGTERM"), /SIGTERM/);
		assert.doesNotMatch(transcribeExitLabel(null, "SIGTERM"), /OOM/);
		assert.match(transcribeExitLabel(null, null), /no code\/signal/);
	});

	check("failure label carries model + phase + exit + heartbeat", () => {
		const label = transcribeFailureLabel({
			model: "tiny.en",
			phase: "load",
			signal: "SIGKILL",
			heartbeatAgeMs: 12000,
		});
		assert.match(label, /tiny\.en/);
		assert.match(label, /load/);
		assert.match(label, /SIGKILL/);
		assert.match(label, /12s/);
	});

	check("failure label never throws on empty input", () => {
		const label = transcribeFailureLabel({});
		assert.match(label, /unknown model/);
		assert.match(label, /unknown phase/);
	});

	check(
		"load-phase crash = no transcribe tick; any decode tick clears it",
		() => {
			assert.equal(isLoadPhaseCrash({ hadProgress: false, phase: null }), true);
			assert.equal(
				isLoadPhaseCrash({ hadProgress: false, phase: "model" }),
				true,
			);
			assert.equal(
				isLoadPhaseCrash({ hadProgress: false, phase: "transcribe" }),
				false,
			);
			assert.equal(
				isLoadPhaseCrash({ hadProgress: true, phase: "model" }),
				false,
			);
			assert.equal(isLoadPhaseCrash({ hadProgress: true }), false);
		},
	);

	check("load-phase retry budget is tighter than decode-phase", () => {
		assert.ok(TRANSCRIBE_LOAD_MAX_RETRIES >= 1);
		assert.ok(TRANSCRIBE_LOAD_MAX_RETRIES < TRANSCRIBE_MAX_RETRIES);
	});
}

console.log(`\n[pump-transcription] ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
