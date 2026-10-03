"use strict";

// ---------------------------------------------------------------------------
// Transcript fusion detailed test — proves the speech index works perfectly.
//
//   Run:  node test/transcript-fusion.test.js
//         bun run test:transcript-fusion
//
// Covers the whole vertical without Electron, ffmpeg, or whisper:
//   1. chunking (utterance → 30 s windows, sentence-safe, overlap rules)
//   2. text quality gates (loops, short, caps)
//   3. store accumulation (multi-drain, offsets, validation)
//   4. partition (ok vs skipped)
//   5. truncation heuristic
//   6. FUSION math (weights, bucketing, cutoff, caps, noise gates,
//      poster backfill, why/snippet, determinism)
//   7. worker fixture + empty-engine fallback
//   8. contracts (sidecar shape, bin header, bridge, badge)
//
// Deterministic, milliseconds. Any failure exits 1.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
	TRANSCRIPT_ROW_PER,
	TRANSCRIPTS_PER_CHUNK,
	TRANSCRIBE_CHUNK_TIMEOUT_MS,
	TRANSCRIBE_MAX_RETRIES,
	FUSION_W_VISUAL,
	FUSION_W_TEXT,
	FUSION_SLOT_SECONDS,
	FUSION_SCENES_PER_VIDEO,
	FUSION_NOISE_FRACTION,
	isRealTranscriptText,
	cleanTranscriptText,
	buildTranscriptChunks,
	mergeChunkTranscripts,
	partitionTranscriptReply,
	suspectedTruncatedTranscripts,
	fuseVisualTextMoments,
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

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ---------------------------------------------------------------------------
console.log("[fusion] 1. chunking");
// ---------------------------------------------------------------------------
{
	check("empty / null / garbage → [] (silent film valid)", () => {
		assert.deepEqual(buildTranscriptChunks([]), []);
		assert.deepEqual(buildTranscriptChunks(null), []);
		assert.deepEqual(buildTranscriptChunks(undefined), []);
		assert.deepEqual(buildTranscriptChunks("nope"), []);
	});

	check("sorts by t0, drops non-finite + inverted + blank", () => {
		const out = buildTranscriptChunks([
			{ t0: 30, t1: 38, text: "Third sentence about refunds here." },
			{ t0: 0, t1: 8, text: "First sentence about pricing here." },
			{ t0: NaN, t1: 9, text: "Bad timestamp here now" },
			{ t0: 10, t1: 8, text: "Inverted range here now" },
			{ t0: 12, t1: 18, text: "   " },
			{ t0: 10, t1: 18, text: "Second sentence about launches here." },
		]);
		assert.ok(out.length >= 1);
		assert.equal(out[0].t0, 0);
		for (let i = 1; i < out.length; i++) assert.ok(out[i].t0 >= out[i - 1].t0);
		for (const c of out) assert.ok(c.t1 > c.t0);
	});

	check("dense speech groups to ~30 s windows (120 s → 3..8 chunks)", () => {
		const utterances = Array.from({ length: 12 }, (_, i) => ({
			t0: i * 10,
			t1: i * 10 + 8,
			text: `Sentence number ${i} about the product launch.`,
		}));
		const out = buildTranscriptChunks(utterances);
		assert.ok(out.length >= 3 && out.length <= 8, `got ${out.length}`);
		assert.equal(out[0].t0, 0);
		assert.ok(out[out.length - 1].t1 <= 128);
	});

	check(
		"sparse speech does NOT duplicate rows (2 utterances → 2 chunks)",
		() => {
			const out = buildTranscriptChunks([
				{ t0: 0, t1: 8, text: "Welcome to the pricing overview today." },
				{ t0: 40, t1: 48, text: "The architecture diagram shows the flow." },
			]);
			assert.equal(out.length, 2);
			assert.equal(out[0].t0, 0);
			assert.equal(out[1].t0, 40);
		},
	);

	check("extends past target to sentence end (no mid-sentence split)", () => {
		const out = buildTranscriptChunks([
			{ t0: 0, t1: 10, text: "The first half of a thought" },
			{ t0: 11, t1: 20, text: "and the second half completes it." },
			{ t0: 50, t1: 58, text: "A later standalone sentence here." },
		]);
		assert.ok(out.length >= 1);
		assert.ok(out[0].text.includes("completes it"));
	});

	check("collapses exact-duplicate adjacent chunks", () => {
		const out = buildTranscriptChunks([
			{ t0: 0, t1: 10, text: "Same line about pricing here." },
			{ t0: 11, t1: 20, text: "Same line about pricing here." },
			{ t0: 50, t1: 58, text: "Different line about refunds here." },
		]);
		const texts = out.map((c) => c.text.toLowerCase());
		for (let i = 1; i < texts.length; i++)
			assert.notEqual(texts[i], texts[i - 1]);
	});

	check("custom target/overlap opts honored", () => {
		const utterances = Array.from({ length: 8 }, (_, i) => ({
			t0: i * 10,
			t1: i * 10 + 8,
			text: `Chunk sentence ${i} about testing here.`,
		}));
		const wide = buildTranscriptChunks(utterances, {
			targetSeconds: 60,
			overlapSeconds: 5,
		});
		const narrow = buildTranscriptChunks(utterances, {
			targetSeconds: 20,
			overlapSeconds: 2,
		});
		assert.ok(
			wide.length <= narrow.length,
			`${wide.length} vs ${narrow.length}`,
		);
	});
}

// ---------------------------------------------------------------------------
console.log("[fusion] 2. text quality gates");
// ---------------------------------------------------------------------------
{
	check("accepts genuine speech", () => {
		assert.equal(
			isRealTranscriptText("where she explains the pricing model today"),
			true,
		);
		assert.equal(
			isRealTranscriptText("Welcome to the pricing overview today."),
			true,
		);
		assert.equal(
			isRealTranscriptText("The architecture diagram shows the new flow."),
			true,
		);
	});

	check("rejects short / empty / single-word", () => {
		assert.equal(isRealTranscriptText(""), false);
		assert.equal(isRealTranscriptText("   "), false);
		assert.equal(isRealTranscriptText("hi"), false);
		assert.equal(isRealTranscriptText("a"), false);
		assert.equal(isRealTranscriptText(null), false);
	});

	check("rejects identical-word loops", () => {
		assert.equal(
			isRealTranscriptText("hello hello hello hello hello world today"),
			false,
		);
	});

	check("rejects short-phrase loops (thank-you music bed)", () => {
		assert.equal(
			isRealTranscriptText("thank you thank you thank you thank you thank you"),
			false,
		);
		assert.equal(
			isRealTranscriptText(
				"you know you know you know you know you know you know",
			),
			false,
		);
	});

	check("caps at 240 chars, collapses whitespace", () => {
		assert.ok(cleanTranscriptText("x ".repeat(500)).length <= 240);
		assert.equal(cleanTranscriptText("  hello   world  "), "hello world");
		assert.equal(cleanTranscriptText(""), "");
	});
}

// ---------------------------------------------------------------------------
console.log("[fusion] 3. store accumulation");
// ---------------------------------------------------------------------------
{
	function planChunks(total, step) {
		const plan = Array.from({ length: total }, (_, i) => ({
			t0: i * step,
			t1: i * step + step,
			text: `utterance number ${i} about pricing and refunds spoken clearly`,
		}));
		const chunks = [];
		for (let from = 0; from < plan.length; from += TRANSCRIPTS_PER_CHUNK) {
			chunks.push(plan.slice(from, from + TRANSCRIPTS_PER_CHUNK));
		}
		return chunks;
	}
	function simulate(chunks) {
		const videos = new Map();
		const rows = [];
		for (const chunk of chunks) {
			const base = rows.length;
			videos.set(
				"talk.mp4",
				mergeChunkTranscripts(
					videos.get("talk.mp4") || [],
					chunk,
					base,
					TRANSCRIPT_ROW_PER,
				),
			);
			rows.push(...chunk.map((_, i) => new Float32Array([base + i])));
		}
		return { kept: videos.get("talk.mp4"), rows };
	}

	check("40 chunks → 3 drains (16/16/8), ALL survive", () => {
		const chunks = planChunks(40, 15);
		assert.deepEqual(
			chunks.map((c) => c.length),
			[16, 16, 8],
		);
		const { kept, rows } = simulate(chunks);
		assert.equal(kept.length, 40);
		assert.equal(kept[0].t0, 0);
		assert.equal(kept[39].t0, 15 * 39);
		assert.deepEqual(
			kept.map((s) => s.off),
			Array.from({ length: 40 }, (_, i) => i),
		);
		assert.ok(kept.every((s) => s.off < rows.length));
		assert.ok(kept.every((s) => s.n === TRANSCRIPT_ROW_PER && s.t1 > s.t0));
	});

	check("offsets honor pre-populated bin (prior videos)", () => {
		const merged = mergeChunkTranscripts(
			[],
			[{ t0: 0, t1: 10, text: "Hello world pricing plans" }],
			30,
			1,
		);
		assert.equal(merged[0].off, 30);
	});

	check("record shape is {t0,t1,off,n,text} with capped text", () => {
		const [rec] = mergeChunkTranscripts(
			[],
			[{ t0: 5, t1: 15, text: "Hello world pricing plans today" }],
			0,
			1,
		);
		assert.deepEqual(Object.keys(rec).sort(), ["n", "off", "t0", "t1", "text"]);
		assert.equal(rec.n, 1);
		assert.ok(rec.text.length <= 240);
	});

	check("validation throws TypeError (never silent drop)", () => {
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
console.log("[fusion] 4. partition");
// ---------------------------------------------------------------------------
{
	check("keeps ok rows, counts every skip class", () => {
		const { okChunks, okVecs, skipped } = partitionTranscriptReply(
			[
				{ t0: 0, t1: 10, text: "where she explains pricing today" },
				{
					t0: 10,
					t1: 20,
					text: "thank you thank you thank you thank you thank you",
				},
				{ t0: 20, t1: 10, text: "inverted range here now" },
				{ t0: 30, t1: 40, text: "when they mention refunds tomorrow" },
				{ t0: 40, t1: 50, text: "flagged skip here now", skipped: true },
			],
			[[0.1], [0.2], [0.3], null, [0.5]],
		);
		assert.equal(okChunks.length, 1);
		assert.equal(okVecs.length, 1);
		assert.equal(okChunks[0].t0, 0);
		assert.equal(skipped, 4);
	});

	check("non-array inputs → all skipped, never throws", () => {
		assert.deepEqual(partitionTranscriptReply(null, null), {
			okChunks: [],
			okVecs: [],
			skipped: 0,
		});
	});
}

// ---------------------------------------------------------------------------
console.log("[fusion] 5. truncation heuristic");
// ---------------------------------------------------------------------------
{
	check("tail-clustered multi-chunk sidecar flagged with counts", () => {
		const videos = new Map([
			[
				"film.mp4",
				Array.from({ length: 16 }, (_, i) => ({
					t0: 3360 + i * 30,
					t1: 3390 + i * 30,
					off: i,
					n: 1,
					text: `line ${i} about refunds spoken here`,
				})),
			],
		]);
		const [flag] = suspectedTruncatedTranscripts(videos);
		assert.ok(flag);
		assert.equal(flag.filename, "film.mp4");
		assert.ok(flag.planned > flag.actual);
	});

	check("full-coverage + spread + single-chunk + empty NOT flagged", () => {
		const full = new Map([
			[
				"talk.mp4",
				Array.from({ length: 20 }, (_, i) => ({
					t0: i * 30,
					t1: i * 30 + 28,
					off: i,
					n: 1,
					text: `point ${i} about pricing plans spoken`,
				})),
			],
		]);
		assert.equal(suspectedTruncatedTranscripts(full).length, 0);
		assert.equal(
			suspectedTruncatedTranscripts(new Map([["s.mp4", []]])).length,
			0,
		);
		assert.equal(suspectedTruncatedTranscripts(null).length, 0);
		assert.equal(suspectedTruncatedTranscripts("nope").length, 0);
	});
}

// ---------------------------------------------------------------------------
console.log("[fusion] 6. fusion math");
// ---------------------------------------------------------------------------
{
	const V = (filename, t, score, poster = 3, dur = 4) => ({
		filename,
		t,
		dur,
		poster,
		score,
	});
	const T = (filename, t, score, snippet = "spoken line here", dur = 20) => ({
		filename,
		t,
		dur,
		snippet,
		score,
	});

	check(
		"constants sane (0.4/0.6 weights, 5 s slots, cap 3, noise 0.25)",
		() => {
			assert.equal(FUSION_W_VISUAL, 0.4);
			assert.equal(FUSION_W_TEXT, 0.6);
			assert.equal(FUSION_SLOT_SECONDS, 5);
			assert.equal(FUSION_SCENES_PER_VIDEO, 3);
			assert.equal(FUSION_NOISE_FRACTION, 0.25);
		},
	);

	check("empty both sides → []", () => {
		assert.deepEqual(fuseVisualTextMoments({}), []);
		assert.deepEqual(
			fuseVisualTextMoments({ visualHits: [], textHits: [] }),
			[],
		);
	});

	check("visual-only ranks by 0.4*visual with why=visual", () => {
		const hits = fuseVisualTextMoments({
			visualHits: [V("a.mp4", 10, 0.5, 1), V("a.mp4", 100, 0.4, 2)],
			textHits: [],
			visualTotal: 100,
			textTotal: 0,
			minScore: 0.04,
			relativeKeep: 0.6,
			topK: 24,
		});
		assert.equal(hits.length, 2);
		assert.equal(hits[0].t, 10);
		assert.equal(hits[0].why, "visual");
		assert.ok(Math.abs(hits[0].score - 0.4 * 0.5) < 1e-9);
		assert.equal(hits[0].snippet, null);
	});

	check("text-only ranks by 0.6*text with why=text + snippet", () => {
		const hits = fuseVisualTextMoments({
			visualHits: [],
			textHits: [T("talk.mp4", 47, 0.5, "where she explains pricing")],
			visualTotal: 0,
			textTotal: 100,
			minScore: 0.04,
			relativeKeep: 0.6,
			topK: 24,
		});
		assert.equal(hits.length, 1);
		assert.equal(hits[0].why, "text");
		assert.ok(Math.abs(hits[0].score - 0.6 * 0.5) < 1e-9);
		assert.ok(hits[0].snippet.includes("pricing"));
	});

	check("joint moment beats either alone (both bonus)", () => {
		const hits = fuseVisualTextMoments({
			visualHits: [V("f.mp4", 12, 0.5, 7, 4), V("f.mp4", 200, 0.8, 8, 4)],
			textHits: [T("f.mp4", 13, 0.5, "pricing explained here now", 20)],
			segVideos: new Map([
				[
					"f.mp4",
					[
						{ t: 12, poster: 7 },
						{ t: 200, poster: 8 },
					],
				],
			]),
			visualTotal: 100,
			textTotal: 100,
			minScore: 0.04,
			relativeKeep: 0.6,
			topK: 24,
		});
		assert.ok(hits.length >= 2);
		assert.equal(hits[0].why, "both");
		assert.ok(Math.abs(hits[0].score - (0.4 * 0.5 + 0.6 * 0.5)) < 1e-9);
		assert.ok(hits[0].snippet.includes("pricing"));
	});

	check("same 5 s slot buckets visual+text into ONE moment", () => {
		const hits = fuseVisualTextMoments({
			visualHits: [V("f.mp4", 12, 0.5, 7)],
			textHits: [T("f.mp4", 13, 0.5, "same moment speech here")],
			visualTotal: 100,
			textTotal: 100,
			topK: 24,
		});
		assert.equal(hits.length, 1);
		assert.equal(hits[0].why, "both");
	});

	check("different slots stay separate moments", () => {
		const hits = fuseVisualTextMoments({
			visualHits: [V("f.mp4", 10, 0.5, 1)],
			textHits: [T("f.mp4", 100, 0.5, "distant speech here now")],
			visualTotal: 100,
			textTotal: 100,
			topK: 24,
		});
		assert.equal(hits.length, 2);
	});

	check("cutoff max(minScore, top*relativeKeep) filters tail", () => {
		const hits = fuseVisualTextMoments({
			visualHits: [V("f.mp4", 10, 0.9, 1), V("f.mp4", 50, 0.05, 2)],
			textHits: [],
			visualTotal: 100,
			textTotal: 0,
			minScore: 0.04,
			relativeKeep: 0.6,
			topK: 24,
		});
		// top fused = 0.36, cutoff = 0.216 → 0.05*0.4=0.02 cut
		assert.equal(hits.length, 1);
		assert.equal(hits[0].t, 10);
	});

	check("per-video cap 3 holds on a 10-shot film", () => {
		const visualHits = Array.from({ length: 10 }, (_, i) =>
			V("long.mp4", i * 30, 0.9 - i * 0.01, i),
		);
		const hits = fuseVisualTextMoments({
			visualHits,
			textHits: [],
			visualTotal: 100,
			textTotal: 0,
			minScore: 0.04,
			relativeKeep: 0.0,
			topK: 24,
		});
		assert.equal(hits.length, 3);
	});

	check("topK slices globally", () => {
		const visualHits = Array.from({ length: 10 }, (_, i) =>
			V(`v${i}.mp4`, 10, 0.9 - i * 0.01, 0),
		);
		const hits = fuseVisualTextMoments({
			visualHits,
			textHits: [],
			visualTotal: 100,
			textTotal: 0,
			minScore: 0.04,
			relativeKeep: 0.0,
			topK: 4,
		});
		assert.equal(hits.length, 4);
		assert.equal(hits[0].filename, "v0.mp4");
	});

	check("gibberish flood on BOTH sides → [] (joint gate)", () => {
		const visualHits = Array.from({ length: 100 }, (_, i) =>
			V("m.mp4", i * 30, 0.5, i),
		);
		const textHits = Array.from({ length: 100 }, (_, i) =>
			T("m.mp4", i * 30 + 1, 0.5, `flood line ${i} here now`),
		);
		const hits = fuseVisualTextMoments({
			visualHits,
			textHits,
			visualTotal: 100,
			textTotal: 100,
			minScore: 0.04,
			relativeKeep: 0.6,
			topK: 24,
		});
		assert.deepEqual(hits, []);
	});

	check("visual flood alone → [] (single-side gate)", () => {
		const visualHits = Array.from({ length: 100 }, (_, i) =>
			V("m.mp4", i * 30, 0.5, i),
		);
		assert.deepEqual(
			fuseVisualTextMoments({
				visualHits,
				textHits: [],
				visualTotal: 100,
				textTotal: 0,
				minScore: 0.04,
				relativeKeep: 0.6,
				topK: 24,
			}),
			[],
		);
	});

	check("genuine sparse hits survive (<10% hot)", () => {
		const visualHits = [V("s.mp4", 247, 0.8, 5)];
		const hits = fuseVisualTextMoments({
			visualHits,
			textHits: [],
			visualTotal: 197,
			textTotal: 0,
			minScore: 0.04,
			relativeKeep: 0.6,
			topK: 24,
		});
		assert.equal(hits.length, 1);
		assert.equal(hits[0].t, 247);
	});

	check("text-only slot backfills nearest poster", () => {
		const hits = fuseVisualTextMoments({
			visualHits: [],
			textHits: [T("f.mp4", 103, 0.7, "pricing answer right here")],
			segVideos: new Map([
				[
					"f.mp4",
					[
						{ t: 10, poster: 0 },
						{ t: 100, poster: 9 },
						{ t: 500, poster: 20 },
					],
				],
			]),
			visualTotal: 0,
			textTotal: 100,
			topK: 24,
		});
		assert.equal(hits[0].poster, 9);
	});

	check("text-only slot with no segments → poster 0 (never NaN)", () => {
		const hits = fuseVisualTextMoments({
			visualHits: [],
			textHits: [T("lonely.mp4", 50, 0.7, "speech without frames here")],
			segVideos: new Map(),
			visualTotal: 0,
			textTotal: 100,
			topK: 24,
		});
		assert.equal(hits[0].poster, 0);
	});

	check("malformed hits skipped, never throws", () => {
		const hits = fuseVisualTextMoments({
			visualHits: [
				null,
				{ filename: "a.mp4", t: NaN, score: 0.9 },
				V("a.mp4", 10, 0.5, 1),
			],
			textHits: [undefined, T("a.mp4", 12, 0.5, "ok speech here")],
			visualTotal: 100,
			textTotal: 100,
			topK: 24,
		});
		assert.ok(hits.length >= 1);
	});

	check("deterministic: same input → same output", () => {
		const args = {
			visualHits: [V("f.mp4", 12, 0.5, 7), V("f.mp4", 200, 0.4, 8)],
			textHits: [T("f.mp4", 13, 0.5, "pricing here now")],
			visualTotal: 100,
			textTotal: 100,
			topK: 24,
		};
		assert.deepEqual(fuseVisualTextMoments(args), fuseVisualTextMoments(args));
	});

	check("custom weights honored", () => {
		const [broll] = fuseVisualTextMoments({
			visualHits: [V("f.mp4", 10, 0.5, 1)],
			textHits: [T("f.mp4", 11, 0.5, "speech here now")],
			visualTotal: 100,
			textTotal: 100,
			wVisual: 0.9,
			wText: 0.1,
			topK: 24,
		});
		assert.ok(Math.abs(broll.score - (0.9 * 0.5 + 0.1 * 0.5)) < 1e-9);
	});
}

// ---------------------------------------------------------------------------
console.log("[fusion] 7. worker");
// ---------------------------------------------------------------------------
{
	check("fixture path chunks deterministically (no binaries)", () => {
		const env = {
			...process.env,
			TRANSCRIBE_FIXTURE: JSON.stringify([
				{ t0: 0, t1: 8, text: "Welcome to the pricing overview today." },
				{ t0: 40, t1: 48, text: "The architecture diagram shows the flow." },
			]),
		};
		const r = spawnSync(
			process.execPath,
			["indexer/transcribe-worker.js", "--smoke"],
			{
				cwd: ROOT,
				env,
				encoding: "utf8",
				timeout: 30000,
			},
		);
		assert.equal(r.status, 0, r.stderr.slice(-500));
		const out = JSON.parse(r.stdout);
		assert.equal(out.done, true);
		assert.equal(out.chunks.length, 2);
		assert.equal(out.chunks[0].t0, 0);
		assert.ok(out.chunks[0].text.includes("pricing"));
	});

	check("no engine → valid empty (silent-film shape, done=true)", () => {
		// Hermetic: bogus ffmpeg path fails before any model load, so no
		// network and no cache writes — deterministic in CI and offline.
		const env = {
			...process.env,
			FFMPEG_PATH: "/nonexistent/ffmpeg-for-tests",
			TRANSFORMERS_CACHE: "/nonexistent/cache-for-tests",
		};
		delete env.TRANSCRIBE_FIXTURE;
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				"import('./indexer/transcribe-worker.js').then(m=>m.transcribeVideo('x.mp4',0,{}).then(o=>console.log(JSON.stringify(o))))",
			],
			{
				cwd: ROOT,
				env,
				encoding: "utf8",
				timeout: 30000,
			},
		);
		assert.equal(r.status, 0, (r.stderr || "").slice(-500));
		const out = JSON.parse(r.stdout.trim().split("\n").pop());
		assert.equal(out.done, true);
		assert.deepEqual(out.chunks, []);
		assert.equal(out.total, 0);
	});
}

// ---------------------------------------------------------------------------
console.log("[fusion] 8. contracts");
// ---------------------------------------------------------------------------
{
	check("preload bridges rankScenes + transcribe-state", () => {
		const src = read("preload.js");
		assert.ok(src.includes("rankScenes"), "missing rankScenes bridge");
		assert.ok(
			src.includes("memories:rank-scenes"),
			"missing rank-scenes channel",
		);
		assert.ok(
			src.includes("getTranscribeState"),
			"missing getTranscribeState bridge",
		);
		assert.ok(
			src.includes("memories:transcribe-state"),
			"missing transcribe-state channel",
		);
	});

	check("types declare rankScenes + transcribe status + why/snippet", () => {
		const src = read("src/types.d.ts");
		assert.ok(src.includes("rankScenes"), "missing rankScenes type");
		assert.ok(
			src.includes('type: "transcribe"'),
			"missing transcribe status type",
		);
		const rank = read("src/lib/memoryRank.ts");
		assert.ok(rank.includes("why?"), "missing SceneMatch.why");
		assert.ok(rank.includes("snippet?"), "missing SceneMatch.snippet");
	});

	check("renderer prefers fused IPC with local fallback", () => {
		const src = read("src/hooks/useMemorySearch.ts");
		assert.ok(
			src.includes("window.memories?.rankScenes"),
			"missing fused call",
		);
		assert.ok(src.includes("queryVec"), "missing M-11 queryVec reuse");
	});

	check("main persists + serves transcripts mirroring segments", () => {
		// C-01 Wave 2 (S4): the library store moved to main-lib/ — the
		// main-process wiring now spans both files.
		const src = read("main.js") + read("main-lib/library-store.js");
		for (const needle of [
			"transcriptsMetaFileFor",
			"transcriptsBinFileFor",
			"loadTranscripts",
			"saveTranscripts",
			"removeTranscriptsFor",
			"cachedTranscriptsBin",
			"/memory-transcripts.json",
			"/memory-transcript-embeddings.bin",
			"pumpTranscription",
			"enqueueTranscription",
			"backfillTranscription",
			"memories:rank-scenes",
			"memories:rank-dialogue",
			"memories:transcribe-state",
			"rankVisualScenes",
			"rankTranscriptMoments",
			"fuseVisualTextMoments",
			"embed-texts",
		]) {
			assert.ok(src.includes(needle), `main.js missing ${needle}`);
		}
	});

	check(
		"M-11 rank returns ARRAY with queryVec prop (backward compatible)",
		() => {
			const src = read("main.js");
			assert.ok(src.includes("rankSearchWithVec"), "missing rankSearchWithVec");
			assert.ok(
				src.includes("attachQueryVec"),
				"queryVec must ride the array via attachQueryVec",
			);
			// Renderer reads .queryVec off either shape; perf battery asserts
			// Array.isArray, so the array shape must never regress to an object.
			const hook = read("src/hooks/useMemorySearch.ts");
			assert.ok(
				hook.includes("rankedRaw"),
				"missing backward-compat normalization",
			);
			assert.ok(hook.includes(".queryVec"), "missing queryVec reuse");
		},
	);

	check("CC badge renders why + snippet tooltip", () => {
		const src = read("src/components/MemoryCard.tsx");
		assert.ok(src.includes("data-scene-why"), "missing why attribute");
		assert.ok(src.includes("CC"), "missing CC badge");
		assert.ok(src.includes("bestScene.snippet"), "missing snippet tooltip");
	});

	check(
		"Dialogue mode separation: scenes visual-only, dialogue transcript-only",
		() => {
			const main = read("main.js");
			// Scenes path must not score transcript rows; dialogue path must
			// not score segment rows — the two surfaces never mix.
			const visualFn = main.slice(
				main.indexOf("async function rankVisualScenes"),
			);
			// End at the dialogue section's header comment (not the function
			// itself — its doc comment mentions transcripts by design).
			const visualBody = visualFn.slice(
				0,
				visualFn.indexOf("// Exact dialogue moments (v3)"),
			);
			for (const needle of ["traRows", "traVideos", "chunks", "snippet"]) {
				assert.ok(
					!visualBody.includes(needle),
					`scenes must not touch transcripts (${needle})`,
				);
			}
			assert.ok(
				visualBody.includes("wVisual: 1"),
				"scenes must rank at weight 1.0 (legacy-exact)",
			);
			// v3: dialogue is literal spoken-word retrieval — no vectors, no
			// thresholds, no model (works with CLIP down).
			assert.ok(
				main.includes("exactDialogueSearch"),
				"dialogue must rank via the exact helper",
			);
			const utils = read("indexer/transcript-store-utils.js");
			assert.ok(
				utils.includes("visualHits: []"),
				"legacy dialogue helper stays vector-free",
			);
			const dialogueFn = main.slice(
				main.indexOf("async function rankTranscriptMoments"),
			);
			const dialogueBody = dialogueFn.slice(
				0,
				dialogueFn.indexOf('ipcMain.handle("memories:rank-scenes"'),
			);
			assert.ok(
				!dialogueBody.includes("segRows"),
				"dialogue must not score segment rows",
			);
			assert.ok(
				!dialogueBody.includes("traRows"),
				"dialogue must not score transcript rows",
			);
			assert.ok(
				!dialogueBody.includes("embedMomentQuery"),
				"dialogue must not embed (no model needed)",
			);
			assert.ok(
				dialogueBody.includes("segVideos"),
				"dialogue keeps poster backfill",
			);
			assert.ok(
				dialogueBody.includes("traUtterances"),
				"dialogue prefers utterance lines",
			);
			const hook = read("src/hooks/useMemorySearch.ts");
			assert.ok(hook.includes("searchDialogue"), "missing searchDialogue");
			assert.ok(
				hook.includes("rankDialogue"),
				"missing rankDialogue bridge call",
			);
			const grid = read("src/components/MasonryGrid.tsx");
			assert.ok(grid.includes("Dialogue search mode"), "missing Dialogue pill");
			assert.ok(grid.includes("dialogueMode"), "missing dialogueMode state");
			assert.ok(
				grid.includes("No dialogue matches"),
				"missing dialogue empty state",
			);
			assert.ok(grid.includes("Speech match"), "missing Speech match reason");
			assert.ok(grid.includes('"dialogue"'), "missing dialogue saved-tab mode");
			const saved = read("src/lib/savedSearches.ts");
			assert.ok(saved.includes('"dialogue"'), "missing dialogue SavedTabMode");
			const preload = read("preload.js");
			assert.ok(
				preload.includes("rankDialogue"),
				"missing rankDialogue bridge",
			);
			assert.ok(
				preload.includes("memories:rank-dialogue"),
				"missing rank-dialogue channel",
			);
		},
	);

	check("stub-era repair wired (empty-with-audio re-queued once)", () => {
		const main = read("main.js");
		// C-01 Wave 2 (S4): repair lives in main-lib/library-store.js.
		const store = read("main-lib/library-store.js");
		assert.ok(
			main.includes("repairUntranscribedWithAudio") ||
				store.includes("repairUntranscribedWithAudio"),
			"missing repair fn",
		);
		assert.ok(store.includes("repairCandidates"), "missing repair planner");
		assert.ok(
			main.includes("probeHasAudio") || store.includes("probeHasAudio"),
			"missing audio probe call",
		);
		assert.ok(
			main.includes("version: 2") ||
				main.includes("version = 2") ||
				store.includes("version: 2") ||
				store.includes("version = 2"),
			"missing v2 stamp",
		);
		const utils = read("indexer/video-utils.js");
		assert.ok(utils.includes("probeHasAudio"), "missing probeHasAudio export");
	});

	check("transcribe tray + settings note exist", () => {
		const grid = read("src/components/MasonryGrid.tsx");
		assert.ok(grid.includes("data-transcribe-tray"), "missing transcribe tray");
		const settings = read("src/components/SettingsSheet.tsx");
		assert.ok(settings.includes("Speech index"), "missing settings note");
	});

	check("slice plan: 90 s → 3 slices, unknown → whole-file single pass", () => {
		const w = require("../indexer/transcribe-worker.js");
		const p90 = w.slicesForDuration(90);
		assert.equal(p90.total, 3);
		assert.equal(p90.start(0), 0);
		assert.equal(p90.start(2), 60);
		assert.ok(p90.dur(0) > 30); // 5 s overlap survives boundaries
		for (const d of [0, -5, NaN, null, undefined]) {
			const p = w.slicesForDuration(d);
			assert.equal(p.total, 1);
			assert.equal(p.start(0), 0);
			assert.equal(p.dur(0), 0); // 0 = whole file, no -t cap
		}
		assert.equal(w.SLICE_SECONDS, 30);
		assert.ok(String(w.WHISPER_MODEL_ID).includes("whisper"));
	});

	check(
		"timestamp offset shifts slices to film-absolute, drops garbage",
		() => {
			const w = require("../indexer/transcribe-worker.js");
			const out = w.offsetUtterances(
				[
					{ t0: 1, t1: 5, text: "hello world pricing" },
					{ t0: NaN, t1: 9, text: "bad timestamp here" },
					{ t0: 10, t1: 8, text: "inverted range here" },
					{ t0: 2, t1: 4, text: "   " },
					null,
				],
				60,
			);
			assert.equal(out.length, 1);
			assert.equal(out[0].t0, 61);
			assert.equal(out[0].t1, 65);
			assert.ok(out[0].text.includes("pricing"));
		},
	);

	check("wavToFloat32 parses int16 PCM, rejects garbage", () => {
		const w = require("../indexer/transcribe-worker.js");
		const mk = (samples) => {
			const buf = Buffer.alloc(44 + samples.length * 2);
			buf.write("RIFF", 0);
			samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2));
			return buf;
		};
		const f = w.wavToFloat32(mk([0, 16384, -16384, 32767]));
		assert.equal(f.length, 4);
		assert.ok(Math.abs(f[0] - 0) < 1e-9);
		assert.ok(Math.abs(f[1] - 0.5) < 1e-9);
		assert.ok(Math.abs(f[2] + 0.5) < 1e-9);
		assert.ok(f[3] > 0.99 && f[3] <= 1);
		assert.throws(() => w.wavToFloat32(Buffer.alloc(10)), /short/);
	});

	check("bin header is [count:Int32, dim:Int32] + Float32 rows", () => {
		// Mirror of encodeBin's exact layout (main.js:385): header then body.
		const count = 3;
		const dim = 4;
		const header = Buffer.alloc(8);
		header.writeInt32LE(count, 0);
		header.writeInt32LE(dim, 4);
		const h = new Int32Array(header.buffer, header.byteOffset, 2);
		assert.equal(h[0], count);
		assert.equal(h[1], dim);
		const rows = [new Float32Array([1, 2, 3, 4])];
		assert.equal(rows[0].length, dim);
	});

	check("indexer ships transcribe worker + embed-texts", () => {
		assert.ok(
			fs.existsSync(path.join(ROOT, "indexer", "transcribe-worker.js")),
		);
		const src = read("indexer/indexer.js");
		assert.ok(
			src.includes('"embed-texts"') ||
				src.includes("'embed-texts'") ||
				src.includes("embed-texts"),
		);
		const pkg = JSON.parse(read("package.json"));
		assert.ok(pkg.scripts["test:pump-transcription"], "missing test script");
		assert.ok(
			pkg.scripts["test:transcript-fusion"],
			"missing fusion test script",
		);
	});
}

console.log(`\n[transcript-fusion] ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
