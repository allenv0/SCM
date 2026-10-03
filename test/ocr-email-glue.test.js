"use strict";

// Unit tests for Email-tab recallmadness: glueEmailFragments in
// indexer/ocr-worker.js re-assembles addresses Tesseract fractures into
// adjacent tokens ("jordan" + "parkes9@example" + "com") before confidence
// filtering drops the sub-threshold pieces. Plain node, no Electron:
//   node test/ocr-email-glue.test.js

const assert = require("node:assert/strict");

const worker = require("../indexer/ocr-worker.js");

assert.equal(
	typeof worker.glueEmailFragments,
	"function",
	"glueEmailFragments exported",
);

const W = 1658;
const H = 1342;

function word(text, confidence, x0, y0, x1, y1) {
	return { text, confidence, bbox: { x0, y0, x1, y1 } };
}

// The SCR-20260927-bkbm.png bubble, as Tesseract reported it full-page:
// "jordan" clears the bar, "parkes9@example" + "com" fall just under it.
const bubble = [
	word("jordan", 74, 1076, 145, 1160, 185),
	word("parkes9@example", 68, 1080, 149, 1400, 190),
	word("com", 68, 1433, 145, 1500, 185),
];

const glued = worker.glueEmailFragments(bubble, W, H);
assert.equal(glued.length, 1, "three fragments become one token");
assert.equal(glued[0].text, "jordan.parkes9@example.com", "dots restored");
assert.equal(glued[0].confidence, 74, "max part confidence carried");
assert.deepEqual(
	glued[0].bbox,
	{ x0: 1076, y0: 145, x1: 1500, y1: 190 },
	"union bbox for highlight boxes",
);

// The glued token survives the normal filter path (conf >= 70, real word).
assert.equal(worker.isRealWord(glued[0].text), true);
assert.equal(
	worker.cleanText("", glued),
	"jordan.parkes9@example.com",
	"glued token reaches index text",
);

// Spaced "@" prose is never manufactured: no anchor, no glue.
const spaced = [
	word("contact", 90, 0, 0, 80, 20),
	word("me", 90, 90, 0, 120, 20),
	word("@", 80, 130, 0, 145, 20),
	word("work.", 85, 155, 0, 210, 20),
	word("today", 88, 220, 0, 280, 20),
];
assert.deepEqual(
	worker.glueEmailFragments(spaced, W, H).map((w) => w.text),
	["contact", "me", "@", "work.", "today"],
	"spaced @ untouched",
);

// "@handle" has no alnum left of "@": not an anchor.
const handle = [
	word("follow", 90, 0, 0, 70, 20),
	word("me", 88, 80, 0, 110, 20),
	word("@handle", 75, 120, 0, 200, 20),
];
assert.deepEqual(
	worker.glueEmailFragments(handle, W, H).map((w) => w.text),
	["follow", "me", "@handle"],
	"handle untouched",
);

// A preceding "at" is a preposition, not local text: expansion stops at it.
const preposition = [
	word("reach", 90, 800, 140, 880, 180),
	word("me", 90, 890, 140, 930, 180),
	word("at", 85, 940, 140, 970, 180),
	word("jordan.parkes9@example", 72, 980, 145, 1400, 190),
	word("com", 70, 1410, 145, 1470, 185),
];
const preGlued = worker.glueEmailFragments(preposition, W, H);
assert.deepEqual(
	preGlued.map((w) => w.text),
	["reach", "me", "at", "jordan.parkes9@example.com"],
	"at kept separate, address glued without it",
);

// No "@" anywhere: prose passes through (dictated shapes stay detector-side).
const prose = [
	word("interned", 85, 0, 0, 90, 20),
	word("at", 80, 100, 0, 120, 20),
	word("Acme.AI", 75, 130, 0, 230, 20),
];
assert.deepEqual(
	worker.glueEmailFragments(prose, W, H).map((w) => w.text),
	["interned", "at", "Acme.AI"],
	"dictated-less prose untouched",
);

// An already-valid anchor does not swallow following prose: only dot-led
// pieces continue a valid run, so "or" stays separate.
const tailProse = [
	word("a@b.co", 70, 0, 0, 80, 20),
	word("or", 80, 90, 0, 115, 20),
];
assert.deepEqual(
	worker.glueEmailFragments(tailProse, W, H).map((w) => w.text),
	["a@b.co", "or"],
	"bare word after valid run not consumed",
);

// Degenerate inputs pass through (null normalizes to []).
assert.deepEqual(worker.glueEmailFragments([], W, H), []);
assert.deepEqual(worker.glueEmailFragments(null, W, H), []);
assert.deepEqual(worker.glueEmailFragments(undefined, W, H), []);

console.log("ocr-email-glue: all assertions passed");
