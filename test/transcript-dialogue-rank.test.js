"use strict";

// ---------------------------------------------------------------------------
// Dialogue ranking deep test — proves transcript search returns the right
// moments for "love" / "CIA" and stays silent for gibberish.
//
//   Run:  node test/transcript-dialogue-rank.test.js
//         bun run test:transcript-dialogue-rank
//
// Sections:
//   1. literalFraction matrix (exact, inflections, short-token rules)
//   2. fuse literal semantics (boost order, gate bypass, gibberish blocked,
//      visual-only byte-identical)
//   3. compactTranscriptStore (orphans dropped, offsets restamped, clean passthrough)
//   4. transcribeBackfillList (missing / partial-resume / complete / pruning)
//   5. REAL tower ranking (gated on cached clip-vit-l14-336 text model):
//      hand-written fixture with love/CIA literals + distractors, embedded
//      by the production tower path, ranked by rankDialogueMoments —
//      asserts literal moments lead and gibberish returns [].
//
// Deterministic except §5 (skipped gracefully without the cached model).
// Any failure exits 1 (exitCode — natural drain, never process.exit() with
// native modules loaded; see transcript-deep.test.js).
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	FUSION_W_TEXT,
	literalFraction,
	fuseVisualTextMoments,
	compactTranscriptStore,
	rankDialogueMoments,
	transcribeBackfillList,
	DIALOGUE_LITERAL_BOOST,
} = require("../indexer/transcript-store-utils.js");

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

const V = (filename, t, score, poster = 3, dur = 4) => ({
	filename,
	t,
	dur,
	poster,
	score,
});
const T = (
	filename,
	t,
	score,
	snippet = "spoken line here",
	dur = 20,
	literal = 0,
) => ({
	filename,
	t,
	dur,
	snippet,
	literal,
	score,
});

async function main() {
	// ---------------------------------------------------------------------------
	console.log("[dialogue-rank] 1. literalFraction");
	// ---------------------------------------------------------------------------
	{
		check("exact single-word match → 1", () => {
			assert.equal(literalFraction("love", "My love is true here"), 1);
			assert.equal(literalFraction("CIA", "Is he CIA or not today"), 1);
		});
		check("case + punctuation insensitive", () => {
			assert.equal(literalFraction("Love!", "(love)"), 1);
			assert.equal(literalFraction("CIA?", "is he... CIA!"), 1);
			// Dotted acronyms split to single chars, which are noise by
			// design (MIN_TOKEN_LENGTH precedent) — whisper emits "CIA".
			assert.equal(literalFraction("c.i.a", "the cia agent"), 0);
		});
		check(
			"inflections via prefix rule (documented: prefix only, no stemming)",
			() => {
				assert.equal(literalFraction("love", "Chaiyo loves everybody here"), 1);
				assert.equal(literalFraction("loves", "all you need is love today"), 1);
				assert.equal(literalFraction("love", "they loved the show tonight"), 1);
				assert.equal(literalFraction("price", "what are the prices today"), 1);
				// "loving" vs "loved" share only "lov" — neither is a prefix of
				// the other, so no match (cosine still ranks such chunks; the
				// boost is ordering-only).
				assert.equal(
					literalFraction("loving", "they loved the show tonight"),
					0,
				);
			},
		);
		check("short tokens stay exact-only", () => {
			assert.equal(literalFraction("ai", "the air is fresh today"), 0);
			assert.equal(literalFraction("ai", "about ai safety now"), 1);
			assert.equal(literalFraction("a", "anything at all here"), 0);
		});
		check("multi-word fraction is proportional", () => {
			assert.equal(
				literalFraction("love actually", "I love this film today"),
				0.5,
			);
			assert.equal(
				literalFraction("love actually", "nothing relevant here now"),
				0,
			);
		});
		check("empty / null / punctuation-only → 0, never throws", () => {
			for (const q of ["", "  ", "!!!", null, undefined]) {
				assert.equal(literalFraction(q, "some speech here now"), 0);
			}
			assert.equal(literalFraction("love", ""), 0);
			assert.equal(literalFraction("love", null), 0);
		});
	}

	// ---------------------------------------------------------------------------
	console.log("[dialogue-rank] 2. fuse literal semantics");
	// ---------------------------------------------------------------------------
	{
		check("literal moment jumps to front (ordering-only boost)", () => {
			const hits = fuseVisualTextMoments({
				visualHits: [],
				textHits: [
					T("f.mp4", 10, 0.3, "generic background chatter here", 20, 0),
					T("f.mp4", 100, 0.22, "where she explains pricing today", 20, 1),
				],
				visualTotal: 0,
				textTotal: 100,
				minScore: 0.04,
				relativeKeep: 0.0,
				topK: 24,
			});
			assert.equal(hits.length, 2);
			assert.ok(
				hits[0].snippet.includes("pricing"),
				`literal must lead, got: ${hits[0].snippet}`,
			);
			assert.ok(
				Math.abs(
					hits[0].score - (FUSION_W_TEXT * 0.22 + DIALOGUE_LITERAL_BOOST),
				) < 1e-9,
				`boost math wrong: ${hits[0].score}`,
			);
		});

		check(
			"boost never shrinks the set (below-cutoff literal stays out)",
			() => {
				const hits = fuseVisualTextMoments({
					visualHits: [],
					textHits: [
						T("f.mp4", 10, 0.9, "strong generic speech here now", 20, 0),
						T("f.mp4", 100, 0.05, "love", 20, 1),
					],
					visualTotal: 0,
					textTotal: 100,
					minScore: 0.04,
					relativeKeep: 0.6,
					topK: 24,
				});
				// top fused = 0.54 → cutoff 0.324; literal at 0.03 is cut (honesty floor holds).
				assert.ok(
					hits.every((h) => !h.snippet.includes("love") || h.score >= 0.324),
				);
			},
		);

		check("literal evidence bypasses the fraction gate (love scenario)", () => {
			// 240-row library, broad heat (51% above cutoff) WITH literals.
			const textHits = Array.from({ length: 240 }, (_, i) => ({
				filename: "m.mp4",
				t: i * 15,
				dur: 20,
				snippet: `background line number ${i} spoken here`,
				literal: 0,
				score: 0.15 + (((i * 7919) % 100) / 100) * 0.2, // 0.15–0.35 band
			}));
			textHits[10].snippet = "I just love this moment so much";
			textHits[10].literal = 1;
			textHits[10].score = 0.39;
			const hits = fuseVisualTextMoments({
				visualHits: [],
				textHits,
				visualTotal: 0,
				textTotal: 240,
				minScore: 0.04,
				relativeKeep: 0.6,
				topK: 24,
			});
			assert.ok(hits.length > 0, "literal query must not return []");
			assert.ok(hits[0].snippet.includes("love"), "literal moment must lead");
		});

		check("gibberish (zero literals) still gated to []", () => {
			const textHits = Array.from({ length: 240 }, (_, i) => ({
				filename: "m.mp4",
				t: i * 15,
				dur: 20,
				snippet: `background line number ${i} spoken here`,
				literal: 0,
				score: 0.15 + (((i * 104729) % 100) / 100) * 0.14, // 0.15–0.29 band
			}));
			const hits = fuseVisualTextMoments({
				visualHits: [],
				textHits,
				visualTotal: 0,
				textTotal: 240,
				minScore: 0.04,
				relativeKeep: 0.6,
				topK: 24,
			});
			assert.deepEqual(hits, []);
		});

		check("visual-only callers byte-identical (no literal field, w=1)", () => {
			const args = {
				visualHits: [V("f.mp4", 12, 0.5, 7), V("f.mp4", 200, 0.4, 8)],
				textHits: [],
				visualTotal: 100,
				textTotal: 0,
				minScore: 0.04,
				relativeKeep: 0.6,
				topK: 24,
				wVisual: 1,
				wText: 0,
			};
			const a = fuseVisualTextMoments(args);
			const b = fuseVisualTextMoments(args);
			assert.deepEqual(a, b);
			assert.equal(a[0].why, "visual");
			assert.ok(
				Math.abs(a[0].score - 0.5) < 1e-9,
				`w=1 default? got ${a[0].score}`,
			);
		});
	}

	// ---------------------------------------------------------------------------
	console.log("[dialogue-rank] 3. compactTranscriptStore");
	// ---------------------------------------------------------------------------
	{
		check("orphan rows dropped, offsets restamped contiguously", () => {
			const videos = new Map([
				["a.mp4", [{ t0: 0, t1: 10, off: 0, n: 1, text: "alpha line here" }]],
				["b.mp4", [{ t0: 5, t1: 15, off: 5, n: 1, text: "beta line here" }]],
			]);
			const rows = [
				new Float32Array([1]),
				new Float32Array([2]),
				new Float32Array([3]),
				new Float32Array([4]),
				new Float32Array([5]),
				new Float32Array([6]),
			];
			const r = compactTranscriptStore(videos, rows);
			assert.equal(r.dropped, 4);
			assert.equal(r.rows.length, 2);
			assert.deepEqual(
				r.videos.get("a.mp4").map((c) => c.off),
				[0],
			);
			assert.deepEqual(
				r.videos.get("b.mp4").map((c) => c.off),
				[1],
			);
			assert.ok(r.rows[0][0] === 1 && r.rows[1][0] === 6);
		});

		check("clean store passes through with dropped=0", () => {
			const videos = new Map([
				["a.mp4", [{ t0: 0, t1: 10, off: 0, n: 1, text: "alpha line here" }]],
			]);
			const rows = [new Float32Array([1])];
			const r = compactTranscriptStore(videos, rows);
			assert.equal(r.dropped, 0);
			assert.equal(r.rows.length, 1);
			assert.equal(r.videos.get("a.mp4")[0].off, 0);
		});

		check("malformed records dropped, never throws", () => {
			const videos = new Map([
				[
					"a.mp4",
					[
						{ t0: 0, t1: 10, off: 0, n: 1, text: "good line here" },
						{ t0: 5, t1: 4, off: 1, n: 1, text: "inverted range here" },
						{ t0: 6, t1: 16, off: 99, n: 1, text: "dangling offset here" },
					],
				],
				["b.mp4", "garbage"],
			]);
			const rows = [new Float32Array([1]), new Float32Array([2])];
			const r = compactTranscriptStore(videos, rows);
			assert.equal(r.videos.get("a.mp4").length, 1);
			assert.equal(r.rows.length, 1);
			assert.deepEqual(r.videos.get("b.mp4"), []);
		});
	}

	// ---------------------------------------------------------------------------
	console.log("[dialogue-rank] 4. transcribeBackfillList");
	// ---------------------------------------------------------------------------
	{
		check("missing entries start at 0", () => {
			const out = transcribeBackfillList(
				["a.mp4", "b.mp4"],
				new Map([
					["a.mp4", [{ t0: 0, t1: 5, off: 0, n: 1, text: "done line here" }]],
				]),
				{},
			);
			assert.deepEqual(out, [{ filename: "b.mp4", off: 0 }]);
		});
		check("partial progress resumes at done", () => {
			const out = transcribeBackfillList(
				["a.mp4", "b.mp4"],
				new Map([
					["a.mp4", [{ t0: 0, t1: 5, off: 0, n: 1, text: "done line here" }]],
					["b.mp4", [{ t0: 0, t1: 5, off: 1, n: 1, text: "part line here" }]],
				]),
				{ "b.mp4": { done: 32, total: 120 } },
			);
			assert.deepEqual(out, [{ filename: "b.mp4", off: 32 }]);
		});
		check("complete progress entries skip", () => {
			const out = transcribeBackfillList(
				["a.mp4"],
				new Map([
					["a.mp4", [{ t0: 0, t1: 5, off: 0, n: 1, text: "done line here" }]],
				]),
				{ "a.mp4": { done: 120, total: 120 } },
			);
			assert.deepEqual(out, []);
		});
		check("garbage inputs never throw", () => {
			assert.deepEqual(transcribeBackfillList(null, null, null), []);
			assert.deepEqual(transcribeBackfillList(["a.mp4"], "nope", 42), [
				{ filename: "a.mp4", off: 0 },
			]);
			assert.deepEqual(
				transcribeBackfillList(["a.mp4"], new Map([["a.mp4", []]]), {
					"a.mp4": { done: -5, total: 10 },
				}),
				[],
			);
		});
	}

	// ---------------------------------------------------------------------------
	console.log(
		"[dialogue-rank] 5. REAL tower ranking (cached clip-vit-l14-336)",
	);
	// ---------------------------------------------------------------------------
	{
		const towerDir = path.join(
			os.homedir(),
			"Library",
			"Application Support",
			"scm",
			"models",
			"Xenova",
			"clip-vit-large-patch14-336",
		);
		const hasTower =
			fs.existsSync(path.join(towerDir, "onnx", "text_model_quantized.onnx")) ||
			fs.existsSync(path.join(towerDir, "onnx", "text_model.onnx")) ||
			fs.existsSync(path.join(towerDir, "text_model.onnx"));
		if (!hasTower) {
			skip(
				"real-tower dialogue ranking",
				"clip-vit-large-patch14-336 text model not cached",
			);
		} else {
			await check(
				"love → literal love-chunks lead; CIA → its chunk; gibberish → []",
				async () => {
					process.env.TRANSFORMERS_CACHE = path.join(
						os.homedir(),
						"Library",
						"Application Support",
						"scm",
						"models",
					);
					const mod = await import("@huggingface/transformers");
					mod.env.cacheDir = process.env.TRANSFORMERS_CACHE;
					const core =
						await import("../indexer/build-memory-embeddings-core.js");
					const { centerText, TEXT_MEAN_SAMPLE } =
						await import("../indexer/memory-embedding-utils.js");
					const tp = {
						tokenizer: await mod.AutoTokenizer.from_pretrained(
							"Xenova/clip-vit-large-patch14-336",
						),
						textModel: await mod.CLIPTextModelWithProjection.from_pretrained(
							"Xenova/clip-vit-large-patch14-336",
							{ dtype: "q8" },
						),
						outputKey: "text_embeds",
					};
					const meanVecs = [];
					for (const t of TEXT_MEAN_SAMPLE)
						meanVecs.push(await core.embedText(t, tp, 768, 0));
					const mean = new Float32Array(768);
					for (const v of meanVecs)
						for (let i = 0; i < 768; i++) mean[i] += v[i];
					for (let i = 0; i < 768; i++) mean[i] /= meanVecs.length;
					let n = 0;
					for (let i = 0; i < 768; i++) n += mean[i] * mean[i];
					n = Math.sqrt(n);
					for (let i = 0; i < 768; i++) mean[i] /= n;
					const embedQ = async (q) => {
						const tmps = [q.trim()];
						if (q.trim().length >= 4)
							tmps.push(
								`a photo of ${q.trim()}`,
								`a screenshot of ${q.trim()}`,
							);
						const vs = [];
						for (const t of tmps) vs.push(await core.embedText(t, tp, 768, 0));
						const s = new Float32Array(768);
						for (const v of vs) for (let i = 0; i < 768; i++) s[i] += v[i];
						let m = 0;
						for (let i = 0; i < 768; i++) m += s[i] * s[i];
						m = Math.sqrt(m);
						for (let i = 0; i < 768; i++) s[i] /= m;
						return centerText(s, mean);
					};
					// Fixture: real sidecar phrasings (love/CIA literals + distractors).
					const texts = [
						[
							"hangover.mp4",
							100,
							120,
							"I just love a shot here. The Chad is back",
						],
						[
							"hangover.mp4",
							200,
							220,
							"We took on Bangkok and we won. I love you guys",
						],
						["samsung.mp4", 10, 30, "Okay, are you loving it right now"],
						["sicario.mp4", 50, 70, "Is he CIA? Are you? He is a DOD advisor"],
						["skyfall.mp4", 300, 320, "Well done, too. Huh? All of your own"],
						["alien.mp4", 400, 420, "Let us get that out of here right now"],
					];
					const items = [];
					for (const [filename, t0, t1, text] of texts.filter(
						(r) => r[2] > r[1],
					)) {
						const v = await core.embedText(text, tp, 768, 0);
						items.push({ filename, t0, t1, text, vec: centerText(v, mean) });
					}
					const loveQ = await embedQ("love");
					const loveHits = rankDialogueMoments({
						qVec: loveQ,
						items,
						segVideos: new Map(),
						minScore: 0.0734,
						relativeKeep: 0.6,
						topK: 24,
						query: "love",
					});
					assert.ok(loveHits.length > 0, "love must return hits");
					assert.ok(
						/lov/i.test(loveHits[0].snippet),
						`literal must lead, got: ${loveHits[0].snippet}`,
					);
					const ciaQ = await embedQ("CIA");
					const ciaHits = rankDialogueMoments({
						qVec: ciaQ,
						items,
						segVideos: new Map(),
						minScore: 0.0734,
						relativeKeep: 0.6,
						topK: 24,
						query: "CIA",
					});
					assert.ok(ciaHits.length > 0, "CIA must return hits");
					assert.ok(
						/cia/i.test(ciaHits[0].snippet),
						`CIA chunk must lead, got: ${ciaHits[0].snippet}`,
					);
					const gibQ = await embedQ("zzzxq nonsense");
					const gibHits = rankDialogueMoments({
						qVec: gibQ,
						items,
						segVideos: new Map(),
						minScore: 0.0734,
						relativeKeep: 0.6,
						topK: 24,
						query: "zzzxq nonsense",
					});
					assert.deepEqual(gibHits, [], "gibberish must stay empty");
				},
			);
		}
	}
}

main().then(
	() => {
		console.log(
			`\n[transcript-dialogue-rank] ${passed} passed, ${failed} failed${skipped.length ? `, ${skipped.length} skipped` : ""}`,
		);
		for (const s of skipped) console.log(`  ○ skipped: ${s}`);
		// Natural drain only (live ORT sessions in §5) — see transcript-deep.test.js.
		process.exitCode = failed === 0 ? 0 : 1;
	},
	(err) => {
		console.error(
			`[transcript-dialogue-rank] harness error: ${err.stack || err.message}`,
		);
		process.exitCode = 1;
	},
);
