"use strict";

// ---------------------------------------------------------------------------
// pumpEnrichment chunk-accumulation unit test — the seconds-fast half of the
// multi-chunk scene-search coverage suite.
//
//   Run:  bun run test:pump-enrichment   (or:  node test/pump-enrichment.test.js)
//
// The Electron half (real enrichment pipeline, 18 segments across 2 chunks,
// end-to-end through the worker) lives in main.js as ELECTRON_SMOKE_PHASE4=1.
// This file pins the pure contract instead: the worker (indexer/indexer.js)
// embeds ≤ SEGMENTS_PER_CHUNK=16 segments per enrich-video call and returns
// only the slice it embedded THIS call, so pumpEnrichment must ACCUMULATE
// each chunk into the file's sidecar list. Replacing it with the current
// chunk used to leave only the last chunk's segments — a long film became
// searchable only in its final minutes. No Electron, no ffmpeg: milliseconds.
// ---------------------------------------------------------------------------
"use strict";

const assert = require("node:assert/strict");
const {
	SEGMENT_ROW_PER,
	SEGMENTS_PER_CHUNK,
	ENRICH_CHUNK_TIMEOUT_MS,
	ENRICH_MAX_RETRIES,
	mergeChunkSegments,
	partitionChunkReply,
	shouldParkEnrichment,
	suspectedTruncated,
} = require("../indexer/segment-store-utils.js");
const { parseRawFrameSize } = require("../indexer/video-utils.js");

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

// A plan of `total` segments at `stepSeconds` spacing across `duration`
// seconds, sliced exactly like enrichVideo slices its plan.
function planChunks(total, duration, stepSeconds) {
	const plan = Array.from({ length: total }, (_, i) => ({
		t: Math.round(i * stepSeconds),
		dur: Math.min(stepSeconds, Math.max(1, duration - i * stepSeconds)),
		poster: i,
	}));
	const chunks = [];
	for (let from = 0; from < plan.length; from += SEGMENTS_PER_CHUNK) {
		chunks.push(plan.slice(from, from + SEGMENTS_PER_CHUNK));
	}
	return chunks;
}

// Faithful simulation of the pumpEnrichment commit path: for each reply
// chunk, base = the bin's row count BEFORE this chunk's rows are pushed, the
// chunk is merged into the file's accumulated list, then rows are appended.
// Returns { segments, rows } like the c.videos / c.rows sidecar store.
function simulateEnrichment(chunks) {
	const videos = new Map();
	const rows = [];
	for (const chunk of chunks) {
		const base = rows.length;
		const merged = mergeChunkSegments(
			videos.get("film.mp4") || [],
			chunk,
			base,
			SEGMENT_ROW_PER,
		);
		videos.set("film.mp4", merged);
		rows.push(...chunk.map((_, i) => new Float32Array([base + i])));
	}
	return { segments: videos.get("film.mp4"), rows };
}

// ---------------------------------------------------------------------------
console.log("[pump-enrichment] multi-chunk accumulation (the regression)");
// ---------------------------------------------------------------------------

// 40 segments on a 10-minute film (every 15 s) — 3 chunks (16/16/8).
// Before the fix, only the last chunk's 8 segments survived.
{
	const chunks = planChunks(40, 600, 15);
	const { segments, rows } = simulateEnrichment(chunks);

	check("40 segments planned → 3 chunks (16/16/8)", () => {
		assert.deepEqual(
			chunks.map((c) => c.length),
			[16, 16, 8],
		);
	});

	check("ALL 40 segments survive (not just the last chunk's 8)", () => {
		assert.equal(segments.length, 40, `only ${segments.length} survived`);
	});

	check(
		"first chunk's segments are still there (early film searchable)",
		() => {
			assert.equal(segments[0].t, 0);
			assert.equal(segments[15].t, 15 * 15); // chunk-1 tail at 225 s
		},
	);

	check("coverage spans the whole film, not just the end", () => {
		assert.equal(segments[0].t, 0);
		assert.equal(segments[39].t, 15 * 39); // 585 s of a 600 s film
		assert.ok(segments[39].t - segments[0].t > 500, "span too short");
	});

	check("offsets are unique, contiguous, and land inside the bin", () => {
		const offs = segments.map((s) => s.off);
		assert.deepEqual(
			offs,
			Array.from({ length: 40 }, (_, i) => i),
		);
		assert.ok(
			offs.every((o) => o < rows.length),
			"offset outside bin",
		);
	});

	check("every row carries n = SEGMENT_ROW_PER and its poster index", () => {
		for (const s of segments) {
			assert.equal(s.n, SEGMENT_ROW_PER);
			assert.equal(s.poster, s.t / 15);
			assert.ok(s.dur > 0);
		}
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-enrichment] single chunk (short clip — unaffected path)");
// ---------------------------------------------------------------------------
{
	const chunks = planChunks(12, 300, 25);
	const { segments } = simulateEnrichment(chunks);

	check("single chunk passes through whole", () => {
		assert.equal(chunks.length, 1);
		assert.equal(segments.length, 12);
		assert.deepEqual(
			segments.map((s) => s.off),
			Array.from({ length: 12 }, (_, i) => i),
		);
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-enrichment] offsets honor a non-empty bin (prior videos)");
// ---------------------------------------------------------------------------
{
	// 20 segments across 2 chunks, but the bin already holds 30 rows from
	// other videos — each chunk's offsets must start at the running row count.
	const chunks = planChunks(20, 600, 30);
	const videos = new Map();
	const rows = Array.from({ length: 30 }, () => new Float32Array(1));
	for (const chunk of chunks) {
		const base = rows.length;
		videos.set(
			"film.mp4",
			mergeChunkSegments(
				videos.get("film.mp4") || [],
				chunk,
				base,
				SEGMENT_ROW_PER,
			),
		);
		rows.push(...chunk.map((_, i) => new Float32Array([base + i])));
	}
	const segments = videos.get("film.mp4");

	check("offsets continue from the pre-existing row count (30..49)", () => {
		assert.equal(segments.length, 20);
		assert.deepEqual(
			segments.map((s) => s.off),
			Array.from({ length: 20 }, (_, i) => 30 + i),
		);
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-enrichment] input validation");
// ---------------------------------------------------------------------------
check("rejects a non-array existing list", () => {
	assert.throws(() => mergeChunkSegments(null, [], 0, 1), TypeError);
});
check("rejects a negative base offset", () => {
	assert.throws(() => mergeChunkSegments([], [], -1, 1), TypeError);
});

// ---------------------------------------------------------------------------
console.log(
	"[pump-enrichment] suspectedTruncated (pre-fix sidecar repair scan)",
);
// ---------------------------------------------------------------------------
// The balanced budget triple — same shape as videoUtils.budgetForQuality.
const BALANCED = { targetSeconds: 30, minSegments: 8, maxSegments: 128 };

// A 90-min film whose sidecar kept only the LAST 16-segment chunk (the
// pre-fix signature: t 3360..3810 of a 128-segment plan).
const truncated = Array.from({ length: 16 }, (_, i) => ({
	t: 3360 + i * 30,
	dur: 30,
	off: 0,
	n: 1,
}));

// The same film, fully enriched under the fix: all 128 segments spread
// across the whole duration.
const full = Array.from({ length: 128 }, (_, i) => ({
	t: i * 30,
	dur: 30,
	off: 0,
	n: 1,
}));

// A legitimately shot-sparse film: 12 long takes over 2 hours — segments
// cover the whole duration but fewer than the budget, which must NOT be
// mistaken for truncation.
const sparse = Array.from({ length: 12 }, (_, i) => ({
	t: i * 600,
	dur: 600,
	off: 0,
	n: 1,
}));

// A short clip: single chunk — the bug could never apply.
const shortClip = Array.from({ length: 8 }, (_, i) => ({
	t: i * 30,
	dur: 30,
	off: 0,
	n: 1,
}));

{
	const videos = new Map([
		["truncated.mp4", truncated],
		["full.mp4", full],
		["sparse.mp4", sparse],
		["short.mp4", shortClip],
		["empty.mp4", []],
	]);
	const flagged = suspectedTruncated(videos, BALANCED);
	const names = flagged.map((f) => f.filename);

	check("flags ONLY the tail-clustered truncated entry", () => {
		assert.deepEqual(names, ["truncated.mp4"]);
	});

	check("flagged entry reports planned 128 / actual 16", () => {
		const hit = flagged[0];
		assert.equal(hit.planned, 128);
		assert.equal(hit.actual, 16);
	});

	check("full multi-chunk coverage (128/128) is NOT flagged", () => {
		assert.ok(!names.includes("full.mp4"));
	});

	check("shot-sparse full-span film is NOT flagged", () => {
		assert.ok(!names.includes("sparse.mp4"));
	});

	check("single-chunk short clip is NOT flagged", () => {
		assert.ok(!names.includes("short.mp4"));
	});

	check("empty entries are skipped", () => {
		assert.ok(!names.includes("empty.mp4"));
	});
}

// The detection is preset-relative: the same 16-segment tail under ECO
// (target 60 s) plans 64 segments for the 90-min film — still multi-chunk,
// still flagged; under a hypothetical 4 s preset it would plan 1280 and the
// 128-segment FULL sidecar would look sparse — but its span is full, so the
// span test still clears it.
{
	const eco = { targetSeconds: 60, minSegments: 4, maxSegments: 32 };
	const flaggedEco = suspectedTruncated(
		new Map([
			["truncated.mp4", truncated],
			["full.mp4", full],
		]),
		eco,
	);
	check("flags under a different preset too (preset-relative planning)", () => {
		assert.deepEqual(
			flaggedEco.map((f) => f.filename),
			["truncated.mp4"],
		);
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-enrichment] never-stall: per-segment skip (long-film fix)");
// ---------------------------------------------------------------------------
// The worker returns parallel arrays (segments[i] ↔ vecs[i], null = skipped)
// so one corrupt GOP leaves a gap instead of freezing the tray at e.g.
// 16/1024 or dropping the whole 1024-seg film.
{
	const segments = Array.from({ length: 16 }, (_, i) => ({
		t: i * 10,
		dur: 10,
		poster: i,
		gi: i,
		...(i === 5
			? { skipped: true, error: "ffmpeg slow-seek failed at 50.0s" }
			: {}),
	}));
	const vecs = Array.from({ length: 16 }, (_, i) =>
		i === 5 ? null : [i, i + 1],
	);

	check("partition keeps 15 successes and counts 1 skip", () => {
		const { okSegments, okVecs, skipped } = partitionChunkReply(segments, vecs);
		assert.equal(okSegments.length, 15);
		assert.equal(okVecs.length, 15);
		assert.equal(skipped, 1);
		assert.ok(okSegments.every((s) => !s.skipped));
	});

	check("skipped chunk still merges successes with contiguous offsets", () => {
		const { okSegments, okVecs } = partitionChunkReply(segments, vecs);
		const merged = mergeChunkSegments([], okSegments, 0, SEGMENT_ROW_PER);
		assert.equal(merged.length, 15);
		assert.deepEqual(
			merged.map((s) => s.off),
			Array.from({ length: 15 }, (_, i) => i),
		);
		// Poster indices preserve the GLOBAL gi (gap at 5), so thumbnails
		// still derive from /images/posters/<stem>-scene-<gi>.jpg.
		assert.deepEqual(
			merged.map((s) => s.poster),
			[0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
		);
		assert.equal(okVecs.length, 15);
	});

	check(
		"all-skipped chunk partitions to empty success with full skip count",
		() => {
			const allSkipped = segments.map((s) => ({ ...s, skipped: true }));
			const allNull = vecs.map(() => null);
			const { okSegments, okVecs, skipped } = partitionChunkReply(
				allSkipped,
				allNull,
			);
			assert.equal(okSegments.length, 0);
			assert.equal(okVecs.length, 0);
			assert.equal(skipped, 16);
		},
	);

	check("null vec without flag also counts as skipped (defensive)", () => {
		const { skipped } = partitionChunkReply(
			[{ t: 0, dur: 1, poster: 0 }],
			[null],
		);
		assert.equal(skipped, 1);
	});

	check("chunk timeout budget covers a slow-but-alive Ultra chunk", () => {
		// 16 segments × worst-case ~30 s each < 10 min ceiling; retries bounded.
		assert.ok(ENRICH_CHUNK_TIMEOUT_MS >= 16 * 30000);
		assert.ok(ENRICH_MAX_RETRIES >= 1 && ENRICH_MAX_RETRIES <= 5);
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-enrichment] poison-pill parking (2026-09-26 loop fix)");
// ---------------------------------------------------------------------------
// A video whose every segment skips used to earn no `videos` entry, so
// backfillEnrichment re-queued it on EVERY launch and EVERY model switch and
// the tray showed "Embedding scenes" forever (2card-banner.mp4,
// scm-demo.mp4, scm-demo3.mp4 — all-skipped because parseRawFrameSize missed
// the SAR-less `WxH, q=` form). The pump now parks it with an empty entry.
{
	const parked = {
		done: true,
		ok: true,
		okTotal: 0,
		skippedTotal: 24,
		alreadyCovered: false,
	};

	check("final all-skipped chunk parks (no entry → backfill would loop)", () => {
		assert.equal(shouldParkEnrichment(parked), true);
	});

	check("non-final chunk never parks (job still advancing)", () => {
		assert.equal(shouldParkEnrichment({ ...parked, done: false }), false);
	});

	check("any success disables parking (partial coverage commits)", () => {
		assert.equal(shouldParkEnrichment({ ...parked, okTotal: 1 }), false);
	});

	check("zero attempts never parks (not evidence of failure)", () => {
		assert.equal(shouldParkEnrichment({ ...parked, skippedTotal: 0 }), false);
	});

	check("existing entry is never clobbered with empty", () => {
		assert.equal(
			shouldParkEnrichment({ ...parked, alreadyCovered: true }),
			false,
		);
	});

	check("failed reply (!ok) never parks (transient, retry path owns it)", () => {
		assert.equal(shouldParkEnrichment({ ...parked, ok: false }), false);
	});
}

// ---------------------------------------------------------------------------
console.log("[pump-enrichment] parseRawFrameSize SAR tolerance (root cause)");
// ---------------------------------------------------------------------------
{
	const bracket =
		"Output #0, rawvideo, to 'pipe:1':\n" +
		"  Stream #0:0(und): Video: rawvideo (RGB[24] / 0x18424752), rgb24(pc, gbr/unknown/unknown, progressive), 96x96 [SAR 1:1 DAR 1:1], q=2-31, 25 fps";
	const comma =
		"Output #0, rawvideo, to 'pipe:1':\n" +
		"  Stream #0:0(eng): Video: rawvideo (RGB[24] / 0x18424752), rgb24(pc, gbr/bt709/bt709, progressive), 480x270, q=2-31, 25 fps";

	check("bracket form still parses (96x96 [SAR 1:1 DAR 1:1])", () => {
		assert.deepEqual(parseRawFrameSize(bracket, 480), { width: 96, height: 96 });
	});

	check("SAR-less comma form parses (480x270, q= — the poison pill)", () => {
		assert.deepEqual(parseRawFrameSize(comma, 480), {
			width: 480,
			height: 270,
		});
	});

	check("224 fallback survives when Output section is missing", () => {
		assert.deepEqual(parseRawFrameSize("ffmpeg version 6.0", 224), {
			width: 224,
			height: 224,
		});
	});

	check("no dims + wide request returns null (not a silent 224)", () => {
		assert.equal(parseRawFrameSize("ffmpeg version 6.0", 480), null);
	});
}

console.log(`\npump-enrichment: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
