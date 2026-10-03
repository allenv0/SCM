"use strict";

// Ask retrieval + prompt contract (MDs/Ask-Mode-Plan.md). Pure-node tests
// over main-lib/ask/* plus wiring assertions over main.js — most importantly
// the WORKER-FREE guarantee: the Ask retrieval path must never touch the
// CLIP indexer pool, embed a query, or set a background-pump pending flag.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
	ASK_CAPS,
	ASK_CAPS_WIDE,
	askTokenSet,
	ocrEvidence,
	keywordEvidence,
	dialogueDocsFor,
	validateScopedFilenames,
	partitionScoped,
	buildAskEvidence,
	truncate,
} = require("../main-lib/ask/retrieve.js");
const {
	buildAskMessages,
	formatAskEvidence,
} = require("../main-lib/ask/prompts.js");

function check(name, fn) {
	try {
		fn();
		console.log(`ok - ${name}`);
	} catch (err) {
		console.error(`FAIL - ${name}`);
		console.error(err && err.stack ? err.stack : err);
		process.exitCode = 1;
	}
}

check("askTokenSet mirrors the shared token space", () => {
	assert.deepEqual([...askTokenSet("Bill Gurley said")].sort(), [
		"bill",
		"gurley",
		"said",
	]);
	// CJK runs expand to overlapping bigrams; a lone Han char stays.
	// (Sorted with the default UTF-16 comparator: 北 U+5317 < 台 U+53F0.)
	assert.deepEqual([...askTokenSet("台北車站")].sort(), [
		"北車",
		"台北",
		"車站",
	]);
	assert.deepEqual([...askTokenSet("駅")], ["駅"]);
	// Mixed queries contribute both sides.
	assert.ok(askTokenSet("東京 Tokyo").has("東京"));
	assert.ok(askTokenSet("東京 Tokyo").has("tokyo"));
	// Single-char Latin noise is dropped (same as queryTokens).
	assert.deepEqual([...askTokenSet("a b cd")], ["cd"]);
	// Ask-side punctuation fix: the Latin side splits like the document
	// side, so trailing "?" and hyphens can't void a match.
	assert.deepEqual([...askTokenSet("Gurley?")], ["gurley"]);
	assert.deepEqual([...askTokenSet("follow-up")].sort(), ["follow", "up"]);
	assert.ok(askTokenSet("what did Bill Gurley say in 2026?").has("2026"));
});

check("ocrEvidence matches through query punctuation (Ask-side fix)", () => {
	const out = ocrEvidence({
		query: "Gurley?",
		photoRows: [{ filename: "a.png", ocr: "Bill Gurley on stage" }],
		cap: 6,
		snippetChars: 300,
	});
	assert.equal(out.length, 1);
	assert.equal(out[0].filename, "a.png");
	const hyphen = ocrEvidence({
		query: "follow-up",
		photoRows: [{ filename: "b.png", ocr: "a follow up meeting" }],
		cap: 6,
		snippetChars: 300,
	});
	assert.equal(hyphen.length, 1);
});

check("ocrEvidence scores by token fraction, drops zero hits", () => {
	const rows = [
		{ filename: "a.png", ocr: "Bill Gurley on stage at the conference" },
		{ filename: "b.png", ocr: "Totally unrelated text here" },
		{ filename: "c.png", ocr: "" },
		// Only one of the two query tokens — half the fraction of a.png.
		{ filename: "d.png", ocr: "Bill says hello to Bill fans" },
	];
	const out = ocrEvidence({
		query: "Bill Gurley",
		photoRows: rows,
		cap: 6,
		snippetChars: 300,
	});
	assert.equal(out.length, 2);
	assert.equal(out[0].filename, "a.png"); // full fraction first
	assert.equal(out[0].kind, "ocr");
	assert.ok(out[0].score > out[1].score);
	assert.ok(out[0].text.includes("Bill Gurley"));
	// CJK containment: a bigram query matches spaceless text.
	const cjk = ocrEvidence({
		query: "車站",
		photoRows: [{ filename: "t.png", ocr: "歡迎來到台北車站" }],
		cap: 6,
		snippetChars: 300,
	});
	assert.equal(cjk.length, 1);
	assert.equal(cjk[0].filename, "t.png");
});

check("ocrEvidence truncates long text and honors the cap", () => {
	const long = "word ".repeat(200);
	const rows = Array.from({ length: 10 }, (_, i) => ({
		filename: `f${i}.png`,
		ocr: `bill ${long}`,
	}));
	const out = ocrEvidence({
		query: "bill",
		photoRows: rows,
		cap: 6,
		snippetChars: 300,
	});
	assert.equal(out.length, 6);
	for (const row of out) assert.ok(row.text.length <= 300);
	assert.equal(truncate("abcdef", 4).length, 4);
	assert.ok(truncate("abcdef", 4).endsWith("…"));
});

check("keywordEvidence ranks filename containment", () => {
	const out = keywordEvidence({
		query: "gurley",
		filenames: ["bill-gurley-2026.png", "other.png", "IMG_gurley.jpg"],
		cap: 4,
	});
	assert.equal(out.length, 2);
	assert.equal(out[0].kind, "keyword");
});

check(
	"dialogueDocsFor prefers utterances, falls back to chunks, stays scoped",
	() => {
		const transcripts = {
			utterances: new Map([
				["film.mp4", [{ t0: 10, t1: 12, text: "Bill Gurley speaking" }]],
				["other.mp4", [{ t0: 0, t1: 1, text: "outside scope" }]],
			]),
			videos: new Map([["film.mp4", [{ t0: 0, t1: 30, text: "chunk text" }]]]),
		};
		const docs = dialogueDocsFor({
			videoNames: new Set(["film.mp4"]),
			transcripts,
		});
		assert.equal(docs.length, 1);
		assert.equal(docs[0].text, "Bill Gurley speaking");
		// Chunk fallback when no utterances exist anywhere.
		const docs2 = dialogueDocsFor({
			videoNames: new Set(["film.mp4"]),
			transcripts: { utterances: new Map(), videos: transcripts.videos },
		});
		assert.equal(docs2.length, 1);
		assert.equal(docs2[0].text, "chunk text");
		// Empty transcripts → no docs (never a crash).
		assert.deepEqual(
			dialogueDocsFor({ videoNames: new Set(["film.mp4"]), transcripts: null }),
			[],
		);
	},
);

check("validateScopedFilenames drops everything outside the library", () => {
	const lib = ["a.png", "b.mp4"];
	const scoped = validateScopedFilenames(
		["a.png", "../etc/passwd", "b.mp4", 42, null, "c.png"],
		lib,
	);
	assert.deepEqual([...scoped], ["a.png", "b.mp4"]);
});

check(
	"partitionScoped splits photos from videos with the caller's predicate",
	() => {
		const scoped = validateScopedFilenames(
			["a.png", "b.mp4", "c.mov"],
			["a.png", "b.mp4", "c.mov"],
		);
		const { photoRows, videoNames } = partitionScoped(scoped, (n) =>
			/\.(mp4|mov)$/.test(n),
		);
		assert.deepEqual(
			photoRows.map((r) => r.filename),
			["a.png"],
		);
		assert.deepEqual(videoNames, ["b.mp4", "c.mov"]);
	},
);

check(
	"buildAskEvidence orders dialogue → ocr → keyword and caps the total",
	() => {
		const transcripts = {
			utterances: new Map([
				[
					"film.mp4",
					[{ t0: 5, t1: 9, text: "Bill Gurley said trust beats conviction" }],
				],
			]),
			videos: new Map(),
		};
		const evidence = buildAskEvidence({
			query: "Bill Gurley",
			photoRows: [
				{ filename: "shot.png", ocr: "Bill Gurley keynote" },
				{ filename: "bill-gurley.png", ocr: "" },
			],
			videoNames: ["film.mp4"],
			transcripts,
			segVideos: new Map(),
			caps: { dialogue: 1, ocr: 1, keyword: 1, total: 2, snippetChars: 300 },
		});
		// total cap trims the tail (keyword) first.
		assert.equal(evidence.all.length, 2);
		assert.equal(evidence.all[0].kind, "dialogue");
		assert.equal(evidence.all[1].kind, "ocr");
		assert.ok(evidence.dialogue[0].t >= 0);
		assert.ok(evidence.dialogue[0].tierLabel);
		// Empty evidence → empty everything (the gate skips the LLM).
		const empty = buildAskEvidence({
			query: "zzz nothing here",
			photoRows: [{ filename: "a.png", ocr: "hello" }],
			videoNames: [],
			transcripts: null,
			segVideos: new Map(),
		});
		assert.equal(empty.all.length, 0);
		// Empty query → empty everything.
		assert.equal(
			buildAskEvidence({
				query: "  ",
				photoRows: [],
				videoNames: [],
				transcripts: null,
				segVideos: new Map(),
			}).all.length,
			0,
		);
	},
);

check("formatAskEvidence numbers rows for citation", () => {
	const lines = formatAskEvidence([
		{
			kind: "dialogue",
			filename: "film.mp4",
			t: 75,
			snippet: "trust beats conviction",
		},
		{ kind: "ocr", filename: "shot.png", text: "Bill Gurley keynote" },
		{ kind: "keyword", filename: "gurley.png" },
	]);
	assert.ok(lines.startsWith('[1] Spoken in "film.mp4" at 01:15:'));
	assert.ok(lines.includes('[2] Text on "shot.png"'));
	assert.ok(lines.includes('[3] File named "gurley.png"'));
});

check("buildAskMessages gates the model to the evidence", () => {
	const messages = buildAskMessages({
		query: "what did Bill Gurley say",
		evidenceRows: [{ kind: "ocr", filename: "shot.png", text: "Bill Gurley" }],
	});
	assert.equal(messages.length, 2);
	assert.equal(messages[0].role, "system");
	const sys = messages[0].content;
	assert.ok(/ONLY from the numbered evidence/i.test(sys), "evidence-only rule");
	assert.ok(/cite the excerpt number/i.test(sys), "citation rule");
	assert.ok(/never invent/i.test(sys), "anti-hallucination rule");
	assert.ok(messages[1].content.includes("Question: what did Bill Gurley say"));
	assert.ok(messages[1].content.includes('[1] Text on "shot.png"'));
});

// --- wiring: the worker-free guarantee is a source contract, not just a
// behavior of today's code (repo style, cf. transcript-fusion.test.js).
check("the Ask path is worker-free by construction", () => {
	const retrieve = fs.readFileSync(
		path.join(__dirname, "..", "main-lib", "ask", "retrieve.js"),
		"utf-8",
	);
	for (const forbidden of [
		"askIndexer",
		"embed-query",
		"embedQuery",
		"utilityProcess",
		"spawnIndexer",
		"enrichPendingQuery",
		"ocrPendingQuery",
		"transcribePendingQuery",
	]) {
		assert.ok(
			!retrieve.includes(forbidden),
			`retrieve.js must not reference ${forbidden}`,
		);
	}
	const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf-8");
	assert.ok(main.includes('"memories:ask"'), "memories:ask handler exists");
	assert.ok(
		main.includes("validateScopedFilenames(payload.filenames"),
		"scope list is validated against the library",
	);
	// The Ask handler returns instead of throwing across IPC.
	const handler = main.slice(main.indexOf('"memories:ask"'));
	assert.ok(handler.includes('reason: "no-evidence"'), "empty-evidence gate");
	assert.ok(handler.includes('reason: "disabled"'), "disabled gate");
	// Retrieval must run BEFORE any model install check — the evidence
	// shape comes back even when the sidecar is missing.
	const gateIdx = handler.indexOf('reason: "no-evidence"');
	const installIdx = handler.indexOf('reason: "not-installed"');
	assert.ok(
		gateIdx > 0 && installIdx > gateIdx,
		"evidence gate precedes install gate",
	);
	// Quit hook stops the sidecar (imported under the llm-prefixed alias —
	// main.js's CLIP modelDownloaded/binaryDownloaded own the short names).
	assert.ok(
		main.includes('stopLlmServer("quit")'),
		"will-quit kills the sidecar",
	);
});

check("ASK_CAPS keep the evidence inside the context window", () => {
	assert.ok(ASK_CAPS.total <= 12);
	assert.ok(ASK_CAPS.snippetChars <= 300);
	assert.ok(
		ASK_CAPS.dialogue + ASK_CAPS.ocr + ASK_CAPS.keyword >= ASK_CAPS.total,
	);
});

check("ASK_CAPS_WIDE stays inside the context window", () => {
	assert.ok(ASK_CAPS_WIDE.total <= 16);
	assert.ok(ASK_CAPS_WIDE.snippetChars <= 300);
	assert.ok(
		ASK_CAPS_WIDE.dialogue + ASK_CAPS_WIDE.ocr + ASK_CAPS_WIDE.keyword >=
			ASK_CAPS_WIDE.total,
	);
	// The wide tier strictly extends the standard one.
	assert.ok(ASK_CAPS_WIDE.total > ASK_CAPS.total);
	assert.ok(ASK_CAPS_WIDE.dialogue >= ASK_CAPS.dialogue);
	assert.ok(ASK_CAPS_WIDE.ocr >= ASK_CAPS.ocr);
	assert.ok(ASK_CAPS_WIDE.keyword >= ASK_CAPS.keyword);
});

check("narrow questions are byte-identical to the standard tier", () => {
	const args = {
		query: "Bill Gurley",
		photoRows: [{ filename: "shot.png", ocr: "Bill Gurley keynote" }],
		videoNames: [],
		transcripts: null,
		segVideos: new Map(),
	};
	const narrowDefault = buildAskEvidence(args);
	const narrowStandard = buildAskEvidence({ ...args, caps: { ...ASK_CAPS } });
	assert.deepEqual(narrowDefault.all, narrowStandard.all);
	assert.equal(narrowDefault.tier, "standard");
	assert.equal(narrowStandard.tier, "custom");
});

check("wide tier appends overflow after an unchanged standard 12", () => {
	const photoRows = Array.from({ length: 10 }, (_, i) => ({
		filename: `bill-${i}.png`,
		ocr: `bill note number ${i} about the keynote`,
	}));
	const transcripts = {
		utterances: new Map([
			[
				"bill-talk.mp4",
				[
					{ t0: 1, t1: 3, text: "bill opens the talk" },
					{ t0: 5, t1: 7, text: "bill takes questions" },
				],
			],
			[
				"bill-qa.mp4",
				[
					{ t0: 2, t1: 4, text: "bill answers first" },
					{ t0: 6, t1: 8, text: "bill closes out" },
				],
			],
		]),
		videos: new Map(),
	};
	const args = {
		query: "bill",
		photoRows,
		videoNames: ["bill-talk.mp4", "bill-qa.mp4"],
		transcripts,
		segVideos: new Map(),
	};
	const wide = buildAskEvidence(args);
	const standard = buildAskEvidence({ ...args, caps: { ...ASK_CAPS } });
	// Broad question: overflow rows ship, total never passes 16.
	assert.ok(wide.all.length > ASK_CAPS.total);
	assert.ok(wide.all.length <= ASK_CAPS_WIDE.total);
	assert.equal(wide.tier, "wide");
	// Citation stability: the standard 12 are an exact prefix of the wide
	// answer — rows 1..12 never renumber.
	assert.equal(standard.all.length, ASK_CAPS.total);
	assert.deepEqual(wide.all.slice(0, ASK_CAPS.total), standard.all);
	// Every extra row is still a literal match (precision-first: the wide
	// tier adds rows, never looser matching).
	for (const row of wide.all.slice(ASK_CAPS.total)) {
		assert.ok(
			/^(dialogue|ocr|keyword)$/.test(row.kind),
			`unexpected kind ${row.kind}`,
		);
	}
});

console.log(
	process.exitCode
		? "ask-retrieve: FAILED"
		: "ask-retrieve: all assertions passed",
);
