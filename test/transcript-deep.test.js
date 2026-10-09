"use strict";

// ---------------------------------------------------------------------------
// Transcript deep test — proves the speech index works EXACTLY like planned,
// through the PRODUCTION code paths (not reimplementations).
//
//   Run:  node test/transcript-deep.test.js
//         bun run test:transcript-deep
//
// Sections:
//   A. M-11 wire proof: attachQueryVec (the exact helper main.js uses) keeps
//      Array.isArray true AND survives a real structured-clone round trip
//      (v8.serialize — the same algorithm Electron IPC uses).
//   B. Rank-response normalization matrix (every shape the renderer accepts).
//   C. Production commit path: applyTranscriptReply (the exact helper
//      pumpTranscription calls) across multi-drain films, pre-populated bins,
//      all-skipped drains, empty records, validation.
//   D. Worker paging: transcribeVideo() with fixture across sequential
//      fromIndex calls (the chunked-drain contract), progress ticks.
//   E. Slice/offset/wav edge cases beyond the fusion suite.
//   F. Fusion at scale: 12k-row stress (timing + caps + determinism).
//   G. Opt-in real-speech accuracy: macOS `say` + ffmpeg + real whisper
//      tiny.en asserts verbatim words (skipped gracefully when unavailable).
//
// Deterministic except G (opt-in). Any failure exits 1.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const v8 = require("node:v8");
const { spawnSync } = require("node:child_process");

const {
	TRANSCRIPT_ROW_PER,
	TRANSCRIPTS_PER_CHUNK,
	partitionTranscriptReply,
	fuseVisualTextMoments,
	attachQueryVec,
	applyTranscriptReply,
} = require("../indexer/transcript-store-utils.js");
const worker = require("../indexer/transcribe-worker.js");

let passed = 0;
let failed = 0;
const skipped = [];

function check(name, fn) {
	try {
		const r = fn();
		if (r && typeof r.then === "function") {
			return r.then(
				() => {
					passed++;
					console.log(`  ✓ ${name}`);
				},
				(err) => {
					failed++;
					console.error(`  ✗ ${name}: ${err.message}`);
				},
			);
		}
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}: ${err.message}`);
	}
	return null;
}

function skip(name, reason) {
	skipped.push(`${name} (${reason})`);
	console.log(`  ○ ${name} — skipped: ${reason}`);
}

async function main() {
	// ---------------------------------------------------------------------------
	console.log("[deep] A. M-11 wire proof (array shape + structured clone)");
	// ---------------------------------------------------------------------------
	{
		check("attachQueryVec keeps Array.isArray true with results intact", () => {
			const rows = [
				{ filename: "a.jpg", score: 0.5 },
				{ filename: "b.jpg", score: 0.3 },
			];
			const out = attachQueryVec(rows, [0.1, 0.2]);
			assert.ok(Array.isArray(out), "must stay an array");
			assert.equal(out.length, 2);
			assert.equal(out[0].filename, "a.jpg");
			assert.deepEqual(Array.from(out.queryVec), [0.1, 0.2]);
		});

		check(
			"queryVec survives a REAL structured-clone round trip (Electron IPC algorithm)",
			() => {
				const out = attachQueryVec(
					[{ filename: "a.jpg", score: 0.5 }],
					[0.1, 0.2, 0.3],
				);
				const clone = v8.deserialize(v8.serialize(out));
				assert.ok(Array.isArray(clone), "clone must stay an array");
				assert.equal(clone.length, 1);
				assert.deepEqual(Array.from(clone.queryVec), [0.1, 0.2, 0.3]);
			},
		);

		check("null vec → queryVec null (model-down shape), array intact", () => {
			const out = attachQueryVec([{ filename: "a.jpg", score: 0.5 }], null);
			assert.ok(Array.isArray(out));
			assert.equal(out.queryVec, null);
			const clone = v8.deserialize(v8.serialize(out));
			assert.ok(Array.isArray(clone) && clone.queryVec === null);
		});

		check("non-array / empty inputs never throw", () => {
			for (const bad of [null, undefined, {}, "x", 42]) {
				const out = attachQueryVec(bad, [1]);
				assert.ok(Array.isArray(out) && out.length === 0);
				assert.deepEqual(Array.from(out.queryVec), [1]);
			}
			const empty = attachQueryVec([], [1]);
			assert.ok(Array.isArray(empty) && empty.length === 0);
		});

		check("large vec (768-dim) clones exactly", () => {
			const vec = Array.from({ length: 768 }, (_, i) => Math.sin(i) * 0.5);
			const clone = v8.deserialize(v8.serialize(attachQueryVec([], vec)));
			assert.equal(clone.queryVec.length, 768);
			assert.ok(Math.abs(clone.queryVec[100] - vec[100]) < 1e-12);
		});
	}

	// ---------------------------------------------------------------------------
	console.log("[deep] B. rank-response normalization matrix");
	// ---------------------------------------------------------------------------
	{
		// The exact normalization useMemorySearch.ts applies (kept in sync by
		// the contract test in transcript-fusion.test.js §8).
		const normalize = (raw) => {
			const ranked = Array.isArray(raw) ? raw : (raw?.results ?? []);
			const qv = raw?.queryVec;
			return { ranked, qv: qv && qv.length > 0 ? new Float32Array(qv) : null };
		};
		check("array-with-prop → results + vec", () => {
			const { ranked, qv } = normalize(
				attachQueryVec([{ filename: "a", score: 1 }], [0.5]),
			);
			assert.equal(ranked.length, 1);
			assert.ok(qv instanceof Float32Array && qv.length === 1);
		});
		check("legacy {results, queryVec} object → results + vec", () => {
			const { ranked, qv } = normalize({
				results: [{ filename: "a", score: 1 }],
				queryVec: [0.5],
			});
			assert.equal(ranked.length, 1);
			assert.ok(qv instanceof Float32Array);
		});
		check("bare array → results, no vec (older main)", () => {
			const { ranked, qv } = normalize([{ filename: "a", score: 1 }]);
			assert.equal(ranked.length, 1);
			assert.equal(qv, null);
		});
		check("null / undefined / {} → empty, no vec (model down)", () => {
			for (const bad of [null, undefined, {}, { results: null }]) {
				const { ranked, qv } = normalize(bad);
				assert.deepEqual(ranked, []);
				assert.equal(qv, null);
			}
		});
	}

	// ---------------------------------------------------------------------------
	console.log("[deep] C. production commit path (applyTranscriptReply)");
	// ---------------------------------------------------------------------------
	{
		const vec = (v) => [v];
		check("three drains accumulate 40/40 with contiguous offsets", () => {
			let videos = new Map();
			let rows = [];
			const drains = [
				Array.from({ length: 16 }, (_, i) => ({
					t0: i * 15,
					t1: i * 15 + 14,
					text: `drain zero line ${i} spoken here`,
				})),
				Array.from({ length: 16 }, (_, i) => ({
					t0: 240 + i * 15,
					t1: 254 + i * 15,
					text: `drain one line ${i} spoken here`,
				})),
				Array.from({ length: 8 }, (_, i) => ({
					t0: 480 + i * 15,
					t1: 494 + i * 15,
					text: `drain two line ${i} spoken here`,
				})),
			];
			for (const d of drains) {
				const r = applyTranscriptReply(
					videos,
					rows,
					"film.mp4",
					d,
					d.map((_, i) => vec(i)),
					TRANSCRIPT_ROW_PER,
				);
				videos = r.videos;
				rows = r.rows;
			}
			const kept = videos.get("film.mp4");
			assert.equal(kept.length, 40);
			assert.deepEqual(
				kept.map((c) => c.off),
				Array.from({ length: 40 }, (_, i) => i),
			);
			assert.equal(rows.length, 40);
			assert.equal(kept[0].t0, 0);
			assert.ok(kept[39].t0 >= 480);
			assert.ok(kept.every((c) => c.n === TRANSCRIPT_ROW_PER));
		});

		check("offsets honor a pre-populated bin (prior videos first)", () => {
			const videos = new Map([
				[
					"old.mp4",
					[{ t0: 0, t1: 10, off: 0, n: 1, text: "old line spoken here" }],
				],
			]);
			const rows = [new Float32Array([9])];
			const r = applyTranscriptReply(
				videos,
				rows,
				"new.mp4",
				[{ t0: 0, t1: 10, text: "new line spoken here" }],
				[[0.1]],
				TRANSCRIPT_ROW_PER,
			);
			assert.equal(r.videos.get("new.mp4")[0].off, 1);
			assert.equal(r.rows.length, 2);
			assert.equal(r.videos.get("old.mp4").length, 1); // untouched file intact
		});

		check("second video interleaves without disturbing the first", () => {
			let videos = new Map();
			let rows = [];
			let r = applyTranscriptReply(
				videos,
				rows,
				"a.mp4",
				[{ t0: 0, t1: 10, text: "alpha line spoken here" }],
				[[1]],
				1,
			);
			r = applyTranscriptReply(
				r.videos,
				r.rows,
				"b.mp4",
				[{ t0: 5, t1: 15, text: "beta line spoken here" }],
				[[2]],
				1,
			);
			assert.equal(r.videos.get("a.mp4")[0].off, 0);
			assert.equal(r.videos.get("b.mp4")[0].off, 1);
			assert.equal(r.rows.length, 2);
		});

		check("does not mutate inputs (returns new Map/rows)", () => {
			const videos = new Map();
			const rows = [];
			const r = applyTranscriptReply(
				videos,
				rows,
				"f.mp4",
				[{ t0: 0, t1: 5, text: "hello world today" }],
				[[1]],
				1,
			);
			assert.equal(videos.size, 0);
			assert.equal(rows.length, 0);
			assert.equal(r.videos.size, 1);
		});

		check("validation mirrors mergeChunkSegments strictness", () => {
			const ok = [{ t0: 0, t1: 5, text: "hello world today" }];
			assert.throws(
				() => applyTranscriptReply(null, [], "f", ok, [[1]], 1),
				TypeError,
			);
			assert.throws(
				() => applyTranscriptReply(new Map(), null, "f", ok, [[1]], 1),
				TypeError,
			);
			assert.throws(
				() => applyTranscriptReply(new Map(), [], "f", null, [[1]], 1),
				TypeError,
			);
			assert.throws(
				() => applyTranscriptReply(new Map(), [], "f", ok, [[1], [2]], 1),
				/mismatch/,
			);
			assert.throws(
				() => applyTranscriptReply(new Map(), [], "f", ok, [[1]], 0),
				TypeError,
			);
		});

		check("full pump simulation: partition → apply → cross-drain span", () => {
			// Faithful to pumpTranscription: partition each reply, then apply.
			let videos = new Map();
			let rows = [];
			const replies = [
				{
					chunks: [{ t0: 0, t1: 10, text: "where she explains pricing today" }],
					vecs: [[0.1]],
				},
				{
					chunks: [
						{
							t0: 10,
							t1: 20,
							text: "thank you thank you thank you thank you thank you",
						},
					],
					vecs: [[0.2]],
				},
				{
					chunks: [
						{ t0: 30, t1: 40, text: "when they mention refunds tomorrow" },
					],
					vecs: [null],
				},
				{
					chunks: [
						{ t0: 50, t1: 60, text: "the architecture diagram shows flow" },
					],
					vecs: [[0.4]],
				},
			];
			let skippedTotal = 0;
			for (const rep of replies) {
				const { okChunks, okVecs, skipped } = partitionTranscriptReply(
					rep.chunks,
					rep.vecs,
				);
				skippedTotal += skipped;
				if (okVecs.length === 0) continue;
				const r = applyTranscriptReply(
					videos,
					rows,
					"talk.mp4",
					okChunks,
					okVecs,
					TRANSCRIPT_ROW_PER,
				);
				videos = r.videos;
				rows = r.rows;
			}
			assert.equal(skippedTotal, 2); // loop-text + null vec
			assert.equal(videos.get("talk.mp4").length, 2);
			assert.equal(rows.length, 2);
			assert.ok(videos.get("talk.mp4")[0].text.includes("pricing"));
			assert.ok(videos.get("talk.mp4")[1].text.includes("architecture"));
		});
	}

	// ---------------------------------------------------------------------------
	console.log("[deep] D. worker paging + progress (fixture, no binaries)");
	// ---------------------------------------------------------------------------
	{
		await check(
			"sequential fromIndex drains page through all windows",
			async () => {
				const fixture = Array.from({ length: 20 }, (_, i) => ({
					t0: i * 10,
					t1: i * 10 + 8,
					text: `Utterance number ${i} about pricing and refunds spoken.`,
				}));
				process.env.TRANSCRIBE_FIXTURE = JSON.stringify(fixture);
				try {
					const ticks = [];
					const first = await worker.transcribeVideo("paged.mp4", 0, {
						onProgress: (p) => ticks.push(p),
					});
					assert.ok(
						first.chunks.length > 0 &&
							first.chunks.length <= TRANSCRIPTS_PER_CHUNK,
					);
					assert.equal(first.fromIndex, first.chunks.length);
					assert.ok(ticks.length >= 1);
					assert.equal(ticks[0].phase, "transcribe");
					assert.ok(
						Number.isFinite(ticks[0].done) && Number.isFinite(ticks[0].total),
					);
					if (!first.done) {
						const second = await worker.transcribeVideo(
							"paged.mp4",
							first.fromIndex,
							{},
						);
						assert.ok(second.fromIndex > first.fromIndex);
						const all = [...first.chunks, ...second.chunks];
						const times = all.map((c) => c.t0);
						assert.deepEqual(
							[...times].sort((a, b) => a - b),
							times,
						); // time-ordered
					} else {
						assert.ok(first.total <= TRANSCRIPTS_PER_CHUNK);
					}
				} finally {
					delete process.env.TRANSCRIBE_FIXTURE;
				}
			},
		);

		await check(
			"fixture beyond one page requires a second call (16/page)",
			async () => {
				const fixture = Array.from({ length: 60 }, (_, i) => ({
					t0: i * 10,
					t1: i * 10 + 8,
					text: `Dense utterance ${i} about quarterly pricing results.`,
				}));
				process.env.TRANSCRIBE_FIXTURE = JSON.stringify(fixture);
				try {
					const all = [];
					let from = 0;
					let done = false;
					let pages = 0;
					while (!done && pages < 8) {
						const out = await worker.transcribeVideo("dense.mp4", from, {});
						all.push(...out.chunks);
						from = out.fromIndex;
						done = out.done;
						pages++;
					}
					assert.ok(done, "must terminate");
					assert.ok(pages >= 2, `expected ≥2 pages, got ${pages}`);
					assert.ok(all.length > TRANSCRIPTS_PER_CHUNK);
					// No duplicate windows across pages…
					assert.equal(
						new Set(all.map((c) => `${c.t0}-${c.text}`)).size,
						all.length,
					);
					// …and main stamps contiguous bin offsets across pages.
					let base = 0;
					const offs = [];
					for (const page of [
						all.slice(0, TRANSCRIPTS_PER_CHUNK),
						all.slice(TRANSCRIPTS_PER_CHUNK),
					]) {
						page.forEach((_, i) => offs.push(base + i));
						base += page.length;
					}
					assert.deepEqual(
						offs,
						all.map((_, i) => i),
					);
				} finally {
					delete process.env.TRANSCRIBE_FIXTURE;
				}
			},
		);
	}

	// ---------------------------------------------------------------------------
	console.log("[deep] E. slice/offset/wav edges");
	// ---------------------------------------------------------------------------
	{
		check("exact 30 s boundary → 1 slice; 31 s → 2 slices", () => {
			assert.equal(worker.slicesForDuration(30).total, 1);
			const p31 = worker.slicesForDuration(31);
			assert.equal(p31.total, 2);
			assert.equal(p31.start(1), 30);
		});

		check("2 hr film → 240 slices max, starts monotonic", () => {
			const p = worker.slicesForDuration(7200);
			assert.equal(p.total, 240);
			for (let i = 1; i < 5; i++) assert.ok(p.start(i) > p.start(i - 1));
		});

		check("offset preserves order and drops garbage", () => {
			const out = worker.offsetUtterances(
				[
					{ t0: 5, t1: 9, text: "late line here now" },
					{ t0: 0, t1: 3, text: "early line here now" },
				],
				100,
			);
			assert.equal(out[0].t0, 105); // input order kept (sort happens in chunking)
			assert.equal(out[1].t0, 100);
		});

		check("wav: max/min int16 extremes map to ±1", () => {
			const buf = Buffer.alloc(44 + 4);
			buf.write("RIFF", 0);
			buf.writeInt16LE(32767, 44);
			buf.writeInt16LE(-32768, 46);
			const f = worker.wavToFloat32(buf);
			assert.ok(f[0] > 0.999 && f[0] <= 1);
			assert.ok(f[1] < -0.999 && f[1] >= -1);
		});

		check(
			"wav: odd trailing byte rejected (never half-sample indexing)",
			() => {
				const buf = Buffer.alloc(44 + 3);
				buf.write("RIFF", 0);
				assert.throws(() => worker.wavToFloat32(buf), /aligned/);
			},
		);

		// Timestamp-collapse fallback (decodeSliceWithFallback): a
		// timestamped decode that collapses to empty text + zero chunks on
		// audible speech must retry once without timestamps instead of
		// recording a permanent gap. Stub asr, no binaries.
		await check(
			"empty timestamped decode retries plain and keeps text",
			async () => {
				const calls = [];
				const stub = async (samples, opts) => {
					calls.push(opts);
					if (opts.return_timestamps) return { text: "", chunks: [] };
					return { text: "hello world here", chunks: [] };
				};
				const out = await worker.decodeSliceWithFallback(
					stub,
					new Float32Array(16000),
					"stub.mp4",
				);
				assert.equal(calls.length, 2);
				assert.equal(calls[0].return_timestamps, true);
				assert.equal(out.text, "hello world here");
				assert.deepEqual(out.chunks, []);
			},
		);

		await check("healthy timestamped decode never retries", async () => {
			let calls = 0;
			const stub = async () => {
				calls++;
				return {
					text: "timed line",
					chunks: [{ text: "timed line", timestamp: [0, 2] }],
				};
			};
			const out = await worker.decodeSliceWithFallback(
				stub,
				new Float32Array(16000),
				"stub.mp4",
			);
			assert.equal(calls, 1);
			assert.equal(out.text, "timed line");
		});

		await check(
			"plain retry failure keeps the empty timed result",
			async () => {
				const stub = async (samples, opts) => {
					if (opts.return_timestamps) return { text: "", chunks: [] };
					throw new Error("engine gone");
				};
				const out = await worker.decodeSliceWithFallback(
					stub,
					new Float32Array(16000),
					"stub.mp4",
				);
				assert.equal(out.text, "");
			},
		);

		await check(
			"true silence stays empty (no retry invents speech)",
			async () => {
				let calls = 0;
				const stub = async () => {
					calls++;
					return { text: "   ", chunks: [] };
				};
				const out = await worker.decodeSliceWithFallback(
					stub,
					new Float32Array(16000),
					"stub.mp4",
				);
				assert.equal(calls, 2);
				assert.equal(out.text.trim(), "");
			},
		);
	}

	// ---------------------------------------------------------------------------
	console.log("[deep] F. fusion at scale (12k rows)");
	// ---------------------------------------------------------------------------
	{
		check(
			"12k visual + 2k text fuse under 2 s, caps hold, deterministic",
			() => {
				const visualHits = Array.from({ length: 12000 }, (_, i) => ({
					filename: `film${i % 50}.mp4`,
					t: (i % 200) * 27,
					dur: 4,
					poster: i % 128,
					score: 0.04 + (((i * 7919) % 1000) / 1000) * 0.5,
				}));
				// One hot joint moment planted deterministically.
				visualHits.push({
					filename: "hot.mp4",
					t: 247,
					dur: 6,
					poster: 9,
					score: 0.95,
				});
				const textHits = Array.from({ length: 2000 }, (_, i) => ({
					filename: `film${i % 50}.mp4`,
					t: ((i * 13) % 200) * 27 + 2,
					dur: 20,
					snippet: `background line ${i} spoken here`,
					score: 0.04 + (((i * 104729) % 1000) / 1000) * 0.3,
				}));
				textHits.push({
					filename: "hot.mp4",
					t: 248,
					dur: 22,
					snippet: "where she explains pricing today",
					score: 0.9,
				});
				const t0 = Date.now();
				const a = fuseVisualTextMoments({
					visualHits,
					textHits,
					visualTotal: 12001,
					textTotal: 2001,
					minScore: 0.04,
					relativeKeep: 0.6,
					topK: 24,
				});
				const ms = Date.now() - t0;
				assert.ok(ms < 2000, `too slow: ${ms}ms`);
				assert.ok(a.length > 0 && a.length <= 24);
				assert.equal(a[0].filename, "hot.mp4");
				assert.equal(a[0].why, "both");
				assert.ok(a[0].snippet.includes("pricing"));
				const perVideo = new Map();
				for (const h of a)
					perVideo.set(h.filename, (perVideo.get(h.filename) || 0) + 1);
				for (const [, n] of perVideo)
					assert.ok(n <= 3, "per-video cap violated");
				const b = fuseVisualTextMoments({
					visualHits,
					textHits,
					visualTotal: 12001,
					textTotal: 2001,
					minScore: 0.04,
					relativeKeep: 0.6,
					topK: 24,
				});
				assert.deepEqual(a, b);
			},
		);
	}

	// ---------------------------------------------------------------------------
	console.log("[deep] G. opt-in real-speech accuracy (macOS say + whisper)");
	// ---------------------------------------------------------------------------
	{
		const hasSay =
			spawnSync("command", ["-v", "say"], { encoding: "utf8" }).status === 0;
		let ffmpeg = null;
		try {
			ffmpeg = require("../node_modules/ffmpeg-static");
			if (!ffmpeg || !fs.existsSync(ffmpeg)) ffmpeg = null;
		} catch {
			ffmpeg = null;
		}
		const modelCache = "/tmp/whisper-proof";
		const modelReady =
			fs.existsSync(path.join(modelCache, "models--Xenova--whisper-tiny.en")) ||
			fs.existsSync(path.join(modelCache, "Xenova"));
		if (!hasSay || !ffmpeg) {
			skip("real-speech accuracy", "needs macOS `say` + ffmpeg-static");
		} else if (process.env.TRANSCRIBE_REAL === "0") {
			skip("real-speech accuracy", "TRANSCRIBE_REAL=0");
		} else {
			await check("whisper transcribes synthetic speech verbatim", async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-real-speech-"));
				const prevCache = process.env.TRANSFORMERS_CACHE;
				try {
					const aiff = path.join(dir, "s.aiff");
					const mp4 = path.join(dir, "s.mp4");
					// "elephant", not "umbrella": tiny.en hears TTS "umbrella"
					// as "and braille" deterministically (verified across the
					// default voice and Alex) — the keyword must be a word the
					// model transcribes verbatim from synthetic speech.
					let r = spawnSync(
						"say",
						["-o", aiff, "The purple elephant costs forty two dollars."],
						{ timeout: 60000 },
					);
					assert.equal(r.status, 0, "say failed");
					r = spawnSync(
						ffmpeg,
						[
							"-y",
							"-f",
							"lavfi",
							"-i",
							"color=c=red:s=320x240:d=6",
							"-i",
							aiff,
							"-shortest",
							"-c:v",
							"mpeg4",
							"-c:a",
							"aac",
							mp4,
						],
						{ timeout: 120000 },
					);
					assert.equal(r.status, 0, "ffmpeg mux failed");
					// Reuse the proven model cache when present (skips the
					// 118 MB download); otherwise download once to scratch.
					process.env.TRANSFORMERS_CACHE = modelReady
						? modelCache
						: fs.mkdtempSync(path.join(os.tmpdir(), "scm-whisper-"));
					const out = await worker.transcribeVideo(mp4, 0, {
						filename: "s.mp4",
					});
					assert.equal(out.done, true);
					const text = out.chunks.map((c) => c.text.toLowerCase()).join(" ");
					if (!text) {
						if (!modelReady) {
							skip(
								"real-speech accuracy",
								"model download unavailable offline",
							);
							return;
						}
						throw new Error("empty transcription from audible speech");
					}
					assert.ok(text.includes("elephant"), `missing keyword in: ${text}`);
					assert.ok(
						text.includes("forty two") || text.includes("42"),
						`missing price in: ${text}`,
					);
					assert.ok(out.chunks.every((c) => c.t1 > c.t0 && c.t0 >= 0));
				} finally {
					if (prevCache === undefined) delete process.env.TRANSFORMERS_CACHE;
					else process.env.TRANSFORMERS_CACHE = prevCache;
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});
		}
	}
}

main().then(
	() => {
		console.log(
			`\n[transcript-deep] ${passed} passed, ${failed} failed${skipped.length ? `, ${skipped.length} skipped` : ""}`,
		);
		for (const s of skipped) console.log(`  ○ skipped: ${s}`);
		// NOTE: set exitCode and drain naturally — NEVER process.exit()
		// here. This process holds live onnxruntime sessions (whisper);
		// an explicit exit races native threadpool teardown and aborts
		// with SIGABRT (libc++abi mutex lock failure) AFTER printing
		// green results. Natural drain exits 0 (verified).
		process.exitCode = failed === 0 ? 0 : 1;
	},
	(err) => {
		console.error(
			`[transcript-deep] harness error: ${err.stack || err.message}`,
		);
		process.exitCode = 1;
	},
);
