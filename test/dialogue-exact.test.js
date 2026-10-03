"use strict";

// ---------------------------------------------------------------------------
// Exact dialogue search (v3) — literal spoken-word retrieval for /dialogue.
//
//   Run:  node test/dialogue-exact.test.js
//         bun run test:dialogue-exact
//
// Sections:
//   1. dialogueKey stem matrix (inflections merge, roots stay apart)
//   2. Tier ordering: phrase > proximity > scattered; honest [] otherwise
//   3. Single-word strictness + noise queries
//   4. Snippet window + highlight offsets + pre-roll seek clamp
//   5. Caps (per-video 3, topK) + poster backfill + dedupe
//   6. Contracts: garbage docs skipped, non-array throws, chunks fallback
//   7. main.js wiring: utterance docs, no vectors, utterance accumulation
//   8. Renderer: tier labels, snippet strip, bridge passthrough
//
// Deterministic, no binaries, no network, no model. Any failure exits 1.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const {
	dialogueKey,
	dialogueTokens,
	porterStem,
	backfillPoster,
	exactDialogueSearch,
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

const DOCS = [
	{
		filename: "hangover.mp4",
		t0: 100,
		t1: 106,
		text: "I just love a shot here. The night is young",
	},
	{
		filename: "hangover.mp4",
		t0: 200,
		t1: 208,
		text: "We took on Bangkok and we won. I love you guys",
	},
	{
		filename: "hangover.mp4",
		t0: 300,
		t1: 306,
		text: "Well done, too. Huh? All of your own business",
	},
	{
		filename: "sicario.mp4",
		t0: 50,
		t1: 56,
		text: "Is he CIA? Are you? He is a DOD advisor",
	},
	{
		filename: "party.mp4",
		t0: 10,
		t1: 14,
		text: "Are you loving it right now, the party never stops",
	},
	{
		filename: "party.mp4",
		t0: 20,
		t1: 24,
		text: "The birthday celebration continues all night long",
	},
];

// ---------------------------------------------------------------------------
console.log("[dialogue-exact] 1. stem keys");
// ---------------------------------------------------------------------------
{
	check("inflections merge to one key", () => {
		assert.equal(dialogueKey("love"), dialogueKey("loves"));
		assert.equal(dialogueKey("love"), dialogueKey("loved"));
		assert.equal(dialogueKey("love"), dialogueKey("loving"));
		assert.equal(dialogueKey("party"), dialogueKey("parties"));
		assert.equal(dialogueKey("fly"), dialogueKey("flying"));
		assert.equal(dialogueKey("fly"), dialogueKey("flies"));
		assert.equal(dialogueKey("price"), dialogueKey("pricing"));
		assert.equal(dialogueKey("CIA"), "cia");
		assert.equal(dialogueKey("Love!"), dialogueKey("(love)"));
	});

	check("distinct roots stay apart; noise drops", () => {
		assert.notEqual(dialogueKey("car"), dialogueKey("carpet"));
		assert.notEqual(dialogueKey("ai"), dialogueKey("air"));
		assert.notEqual(dialogueKey("party"), dialogueKey("part"));
		assert.equal(dialogueKey("a"), "");
		assert.equal(dialogueKey("!!!"), "");
		assert.equal(dialogueKey(""), "");
		assert.equal(dialogueKey(null), "");
		// Dotted acronyms rejoin after cleaning (better than the old
		// split-then-filter rule — whisper emits CIA either way).
		assert.equal(dialogueKey("c.i.a"), "cia");
	});

	check(
		"porterStem deterministic on known forms (raw Porter; the i→y fold lives in dialogueKey)",
		() => {
			assert.equal(porterStem("parties"), "parti");
			assert.equal(porterStem("party"), "parti");
			assert.equal(porterStem("flying"), "fly");
			assert.equal(porterStem("flies"), "fli");
			assert.equal(porterStem("cia"), "cia");
			assert.equal(dialogueTokens("Hello, WORLD!").length, 2);
		},
	);

	check("trailing-i fold reunites fly/flies/flying + city/cities", () => {
		assert.equal(dialogueKey("flies"), dialogueKey("flying"));
		assert.equal(dialogueKey("flies"), dialogueKey("fly"));
		assert.equal(dialogueKey("cities"), dialogueKey("city"));
		assert.notEqual(dialogueKey("car"), dialogueKey("carpet"));
	});
}

// ---------------------------------------------------------------------------
console.log("[dialogue-exact] 2. tiers");
// ---------------------------------------------------------------------------
{
	check("love → tier-1 exact lines lead, no semantic fill", () => {
		const hits = exactDialogueSearch({ query: "love", docs: DOCS });
		assert.ok(hits.length >= 2, `expected love hits, got ${hits.length}`);
		assert.ok(
			hits.every((h) => h.tier === 1),
			"all love hits are tier 1",
		);
		assert.ok(
			hits.every((h) => /lov/i.test(h.snippet)),
			"every snippet speaks the word",
		);
		assert.ok(
			hits.every((h) => h.why === "text"),
			"compat why stays text",
		);
	});

	check("party matches parties-morph, not the birthday paraphrase", () => {
		const hits = exactDialogueSearch({ query: "party", docs: DOCS });
		assert.equal(
			hits.length,
			1,
			`party must hit once, got ${JSON.stringify(hits.map((h) => h.snippet))}`,
		);
		assert.ok(hits[0].snippet.includes("party"), "the literal line wins");
		assert.ok(
			!hits.some((h) => h.snippet.includes("birthday")),
			"paraphrase never surfaces",
		);
	});

	check("phrase > proximity > scattered across one film", () => {
		const docs = [
			{
				filename: "p.mp4",
				t0: 0,
				t1: 5,
				text: "Let us get out of here right now",
			},
			{ filename: "p.mp4", t0: 10, t1: 14, text: "Let us think" },
			{
				filename: "p.mp4",
				t0: 15,
				t1: 19,
				text: "we must get going, out the back door",
			},
			{
				filename: "p.mp4",
				t0: 100,
				t1: 130,
				text: "Let me tell you us a long story about how we get lost and never find our way out of this mess",
			},
		];
		const hits = exactDialogueSearch({ query: "let us get out", docs });
		assert.ok(
			hits.length === 3,
			`expected 3 tiers, got ${hits.map((h) => h.tier)}`,
		);
		assert.deepEqual(
			hits.map((h) => h.tier),
			[1, 2, 3],
		);
		assert.deepEqual(
			hits.map((h) => h.tierLabel),
			["Exact line", "Exact words", "Words spoken"],
		);
	});

	check("gibberish + unrelated → honest []", () => {
		assert.deepEqual(
			exactDialogueSearch({ query: "zzzxq nonsense", docs: DOCS }),
			[],
		);
		assert.deepEqual(exactDialogueSearch({ query: "fly", docs: DOCS }), []);
		assert.deepEqual(exactDialogueSearch({ query: "", docs: DOCS }), []);
		assert.deepEqual(exactDialogueSearch({ query: "   ", docs: DOCS }), []);
		assert.deepEqual(exactDialogueSearch({ query: "love", docs: [] }), []);
	});
}

// ---------------------------------------------------------------------------
console.log("[dialogue-exact] 3. strictness");
// ---------------------------------------------------------------------------
{
	check("1–2 word queries require full containment", () => {
		const hits = exactDialogueSearch({ query: "love actually", docs: DOCS });
		assert.deepEqual(hits, [], "half the words is not a hit");
		const cia = exactDialogueSearch({ query: "CIA", docs: DOCS });
		assert.equal(cia.length, 1);
		assert.ok(/cia/i.test(cia[0].snippet));
	});

	check("case + punctuation insensitive", () => {
		const a = exactDialogueSearch({ query: "LoVe!", docs: DOCS });
		const b = exactDialogueSearch({ query: "love", docs: DOCS });
		assert.deepEqual(
			a.map((h) => h.snippet),
			b.map((h) => h.snippet),
		);
	});
}

// ---------------------------------------------------------------------------
console.log("[dialogue-exact] 4. snippet + seek");
// ---------------------------------------------------------------------------
{
	check("snippet windows the match with highlight offsets", () => {
		const docs = [
			{
				filename: "f.mp4",
				t0: 60,
				t1: 66,
				text:
					"Well " + "and ".repeat(40) + "finally the party starts here tonight",
			},
		];
		const hits = exactDialogueSearch({ query: "party", docs });
		assert.equal(hits.length, 1);
		const h = hits[0];
		assert.ok(h.snippet.length < docs[0].text.length, "long line must window");
		assert.ok(h.snippet.includes("party"), "window must contain the hit");
		assert.equal(
			h.snippet.slice(h.matchStart, h.matchStart + h.matchLen),
			"party",
		);
	});

	check("seek = utterance start − 3s pre-roll, clamped ≥ 0", () => {
		const docs = [
			{ filename: "f.mp4", t0: 100, t1: 106, text: "I love this film" },
			{ filename: "g.mp4", t0: 1, t1: 5, text: "I love this film" },
		];
		const hits = exactDialogueSearch({ query: "love", docs });
		const byFile = Object.fromEntries(hits.map((h) => [h.filename, h]));
		assert.equal(byFile["f.mp4"].t, 97);
		assert.equal(byFile["g.mp4"].t, 0, "pre-roll clamps at film start");
		assert.ok(byFile["f.mp4"].dur >= 0.5);
	});
}

// ---------------------------------------------------------------------------
console.log("[dialogue-exact] 5. caps + posters + dedupe");
// ---------------------------------------------------------------------------
{
	check("per-video cap 3 holds on a chattery film", () => {
		const docs = Array.from({ length: 10 }, (_, i) => ({
			filename: "chat.mp4",
			t0: i * 30,
			t1: i * 30 + 5,
			text: `Take number ${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][i]}: I love this scene`,
		}));
		const hits = exactDialogueSearch({ query: "love", docs });
		assert.equal(hits.length, 3);
	});

	check("topK bounds the grid", () => {
		const docs = Array.from({ length: 40 }, (_, i) => ({
			filename: `f${i}.mp4`,
			t0: 10,
			t1: 15,
			text: "I love this scene",
		}));
		assert.equal(
			exactDialogueSearch({ query: "love", docs, topK: 5 }).length,
			5,
		);
	});

	check("poster backfills from nearest segment", () => {
		const segs = new Map([
			[
				"f.mp4",
				[
					{ t: 5, poster: 2 },
					{ t: 500, poster: 9 },
				],
			],
		]);
		const hits = exactDialogueSearch({
			query: "love",
			docs: [{ filename: "f.mp4", t0: 100, t1: 106, text: "I love this" }],
			segVideos: segs,
		});
		assert.equal(hits[0].poster, 2);
		assert.equal(backfillPoster(null, "f.mp4", 100), 0);
		assert.equal(backfillPoster(new Map(), "f.mp4", 100), 0);
	});

	check("no duplicate tier for subsumed single-doc hits", () => {
		const hits = exactDialogueSearch({ query: "CIA", docs: DOCS });
		assert.equal(hits.length, 1, "phrase hit subsumes the same-doc bag hit");
	});
}

// ---------------------------------------------------------------------------
console.log("[dialogue-exact] 6. contracts");
// ---------------------------------------------------------------------------
{
	check("garbage docs skipped, non-array throws", () => {
		const docs = [
			null,
			undefined,
			"nope",
			{ filename: "f.mp4", t0: 5, t1: 4, text: "inverted love" },
			{ filename: "f.mp4", t0: NaN, t1: 9, text: "nan love" },
			{ filename: "f.mp4", t0: 0, t1: 5, text: "" },
			{ filename: "f.mp4", t0: 0, t1: 5, text: "   " },
			{ filename: "f.mp4", t0: 10, t1: 15, text: "I love this" },
		];
		const hits = exactDialogueSearch({ query: "love", docs });
		assert.equal(hits.length, 1);
		assert.throws(
			() => exactDialogueSearch({ query: "love", docs: null }),
			TypeError,
		);
		assert.throws(
			() => exactDialogueSearch({ query: "love", docs: "x" }),
			TypeError,
		);
	});
}

// ---------------------------------------------------------------------------
console.log("[dialogue-exact] 7. main.js wiring");
// ---------------------------------------------------------------------------
{
	const main = read("main.js");

	check(
		"dialogue ranks exact over utterances, chunk fallback, no vectors",
		() => {
			const fn = main.slice(
				main.indexOf("async function rankTranscriptMoments"),
			);
			const body = fn.slice(
				0,
				fn.indexOf('ipcMain.handle("memories:rank-scenes"'),
			);
			assert.ok(
				body.includes("exactDialogueSearch({ query: trimmed, docs, segVideos"),
				"must call the exact engine",
			);
			assert.ok(body.includes("traUtterances"), "must prefer utterance lines");
			assert.ok(
				!body.includes("embedMomentQuery"),
				"must not embed (works with CLIP down)",
			);
			assert.ok(!body.includes("traRows"), "must not touch embedding rows");
			assert.ok(
				body.includes("text: c.text"),
				"chunk fallback keeps coarse seek",
			);
		},
	);

	check("pump accumulates utterance lines with dedupe + sort", () => {
		const fn = main.slice(main.indexOf("async function pumpTranscription"));
		assert.ok(
			fn.includes("c.utterances.set(job.filename, prev)"),
			"must accumulate lines",
		);
		assert.ok(fn.includes("toFixed(2)"), "dedupe key must quantize floats");
		assert.ok(
			fn.includes("c.utterances.delete(job.filename)"),
			"silent films clear lines",
		);
	});
}

// ---------------------------------------------------------------------------
console.log("[dialogue-exact] 8. renderer wiring");
// ---------------------------------------------------------------------------
{
	check("tier labels + snippet strip + bridge passthrough", () => {
		const rank = read("src/lib/memoryRank.ts");
		assert.ok(rank.includes("tierLabel"), "SceneMatch must carry tierLabel");
		assert.ok(
			rank.includes("matchStart"),
			"SceneMatch must carry highlight offsets",
		);
		const hook = read("src/hooks/useMemorySearch.ts");
		assert.ok(
			hook.includes("tierLabel: f.tierLabel"),
			"hook must pass tiers through",
		);
		const grid = read("src/components/MasonryGrid.tsx");
		assert.ok(grid.includes("tierLabel"), "grid must prefer the tier label");
		const card = read("src/components/MemoryCard.tsx");
		assert.ok(
			card.includes("data-speech-snippet"),
			"card must render the spoken line",
		);
		assert.ok(card.includes("Exact line"), "card must know tier labels");
		assert.ok(card.includes("data-scene-tier"), "badge must expose the tier");
	});
}

console.log(`\n[dialogue-exact] ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
