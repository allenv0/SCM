import { expect, test } from "bun:test";
import {
	containsEmailAddress,
	extractEmailAddresses,
	extractEmailMatches,
	formatEmailEvidence,
} from "../src/lib/emailAddress";

// Membership tests for the Email tab's OCR detector. The input is what the
// OCR worker joins into index.ocr: confident words, space-joined — so these
// cases exercise both clean reads and the OCR noise shapes that actually
// occur (comma-for-dot, a TLD split off as its own word).
test("detects a plain email address in otherwise-empty text", () => {
	expect(containsEmailAddress("allen@example.com")).toBe(true);
});

test("detects addresses embedded among other OCR words", () => {
	expect(
		containsEmailAddress(
			"Contact me at bob.smith+tag@sub.example.co.uk or call the office",
		),
	).toBe(true);
	expect(containsEmailAddress("Email: ME@EXAMPLE.COM")).toBe(true);
});

test("detects trailing punctuation glued to the address", () => {
	expect(containsEmailAddress("Reach out: allen@example.com.")).toBe(true);
	expect(containsEmailAddress("Reach out: allen@example.com, thanks")).toBe(
		true,
	);
});

test("tolerates OCR noise: comma instead of the domain dot", () => {
	expect(containsEmailAddress("allen@example,com")).toBe(true);
});

test("detects dictated addresses: at/dot spelled out", () => {
	expect(containsEmailAddress("allen at gmail dot com")).toBe(true);
	expect(containsEmailAddress("allen at example dot com")).toBe(true);
	expect(containsEmailAddress("Contact allen AT gmail DOT com today")).toBe(
		true,
	);
	expect(containsEmailAddress("support [at] example [dot] com")).toBe(true);
	expect(containsEmailAddress("support(at)example(dot)com")).toBe(true);
	expect(containsEmailAddress("allen at gmail dots com")).toBe(true);
	// Bracketed at is explicit obfuscation: literal dot still counts.
	expect(containsEmailAddress("support [at] example.com")).toBe(true);
	// Mixed: real @ with a dictated dot.
	expect(containsEmailAddress("allen@gmail dot com")).toBe(true);
	// Trailing punctuation still tolerated on dictated shapes.
	expect(containsEmailAddress("Reach me at allen at gmail dot com.")).toBe(
		true,
	);
});

test("dictated shapes still refuse non-address prose", () => {
	// "at" with no TLD tail after normalization ("me@the office").
	expect(containsEmailAddress("meet me at the office")).toBe(false);
	// "dot" with no @ anywhere.
	expect(containsEmailAddress("polka dot dress")).toBe(false);
	// Multi-word phrase: the space before "park dot org" breaks the shape.
	expect(containsEmailAddress("Rock at the park dot org")).toBe(false);
	// Bare "at" with only a LITERAL dot is ordinary prose ("verb at
	// Company.TLD"), not a dictated address — even with a valid TLD tail.
	expect(containsEmailAddress("allen at gmail.com")).toBe(false);
	expect(containsEmailAddress("and interned at Acme.AI (a VC firm)")).toBe(
		false,
	);
	expect(containsEmailAddress("and interned at Acme.Al (a VC firm)")).toBe(
		false,
	);
	expect(containsEmailAddress("currently working at Example Digital")).toBe(
		false,
	);
	expect(containsEmailAddress("studied at Tsinghua University")).toBe(false);
});

test("bare-at prose does not hide a real dictated address elsewhere", () => {
	// Locality: the dot-word check is per candidate, not per text. The prose
	// clause has no dot word so it is rejected, while the later dictated
	// clause still matches.
	expect(
		extractEmailAddresses(
			"and interned at Acme.AI (a VC firm) and contact allen at gmail dot com today",
		),
	).toEqual(["allen@gmail.com"]);
	expect(
		extractEmailAddresses(
			"jordan.parkes9@gmail.com and interned at Acme.Al (a VC firm)",
		),
	).toEqual(["jordan.parkes9@gmail.com"]);
});

test("tolerates OCR noise: TLD split into its own word", () => {
	expect(containsEmailAddress("allen@example. com")).toBe(true);
	expect(containsEmailAddress("allen@example. com.")).toBe(true);
});

test("rejects text without an address-like shape", () => {
	// No @ at all — a bare domain or the word 'email' is not an address.
	expect(containsEmailAddress("gmail.com")).toBe(false);
	expect(containsEmailAddress("please email us for more")).toBe(false);
	// @ without a dot-separated alphabetic tail (the photo shows a handle,
	// not an address).
	expect(containsEmailAddress("follow me @handle")).toBe(false);
	expect(containsEmailAddress("reach @office")).toBe(false);
	expect(containsEmailAddress("allen@example")).toBe(false);
	expect(containsEmailAddress("a@b")).toBe(false);
	// Numeric tails are not TLDs.
	expect(containsEmailAddress("a@b.1x")).toBe(false);
	expect(containsEmailAddress("a@b.z1")).toBe(false);
	// Spaces around the @ break the shape.
	expect(containsEmailAddress("contact me @ work. today")).toBe(false);
});

test("empty or absent OCR text never matches", () => {
	expect(containsEmailAddress(null)).toBe(false);
	expect(containsEmailAddress(undefined)).toBe(false);
	expect(containsEmailAddress("")).toBe(false);
	expect(containsEmailAddress("   ")).toBe(false);
});

test("extracts the address for card display", () => {
	expect(extractEmailAddresses("Contact allen@example.com today")).toEqual([
		"allen@example.com",
	]);
	expect(extractEmailAddresses("Email: ME@EXAMPLE.COM")).toEqual([
		"me@example.com",
	]);
});

test("extraction cleans OCR noise and trailing punctuation", () => {
	expect(extractEmailAddresses("Reach out: allen@example.com.")).toEqual([
		"allen@example.com",
	]);
	expect(extractEmailAddresses("allen@example,com")).toEqual([
		"allen@example.com",
	]);
	expect(extractEmailAddresses("allen@example. com")).toEqual([
		"allen@example.com",
	]);
	expect(extractEmailAddresses("allen at gmail dot com")).toEqual([
		"allen@gmail.com",
	]);
	expect(extractEmailAddresses("support [at] example [dot] com")).toEqual([
		"support@example.com",
	]);
});

test("extraction dedupes and caps", () => {
	expect(extractEmailAddresses("a@x.com and A@X.com and b@y.org")).toEqual([
		"a@x.com",
		"b@y.org",
	]);
	expect(extractEmailAddresses("a@x.com b@y.org c@z.net d@w.io", 2)).toEqual([
		"a@x.com",
		"b@y.org",
	]);
	expect(extractEmailAddresses("no address here")).toEqual([]);
	expect(extractEmailAddresses(null)).toEqual([]);
});

test("evidence copy names what the detector saw", () => {
	expect(
		formatEmailEvidence({
			address: "allen@gmail.com",
			raw: "allen at gmail dot com",
			tier: "dictated",
		}),
	).toBe('Found as "allen at gmail dot com" (spelled-out at/dot)');
	expect(
		formatEmailEvidence({
			address: "support@example.com",
			raw: "support [at] example.com",
			tier: "bracketed",
		}),
	).toBe('Found as "support [at] example.com" (obfuscated at/dot)');
	expect(
		formatEmailEvidence({
			address: "allen@example.com",
			raw: "allen@example,com",
			tier: "literal",
		}),
	).toBe('Found as "allen@example,com"');
	expect(
		formatEmailEvidence({
			address: "me@example.com",
			raw: "me@example.com.",
			tier: "literal",
		}),
	).toBe('Found as "me@example.com."');
	expect(
		formatEmailEvidence({
			address: "allen@example.com",
			raw: "allen@example.com",
			tier: "literal",
		}),
	).toBe("Found in photo text");
});

test("extraction shows several addresses by default (show-all, first-seen)", () => {
	expect(
		extractEmailAddresses("a@x.com b@y.org c@z.net d@w.io e@v.dev"),
	).toEqual(["a@x.com", "b@y.org", "c@z.net", "d@w.io", "e@v.dev"]);
});

test("matches carry tier + raw evidence", () => {
	expect(extractEmailMatches("Contact allen@example.com today")).toEqual([
		{
			address: "allen@example.com",
			raw: "allen@example.com",
			tier: "literal",
			index: 8,
		},
	]);
	expect(extractEmailMatches("allen at gmail dot com")).toEqual([
		{
			address: "allen@gmail.com",
			raw: "allen at gmail dot com",
			tier: "dictated",
			index: 0,
		},
	]);
	expect(extractEmailMatches("support [at] example.com")).toEqual([
		{
			address: "support@example.com",
			raw: "support [at] example.com",
			tier: "bracketed",
			index: 0,
		},
	]);
	expect(extractEmailMatches("allen@gmail dot com")).toEqual([
		{
			address: "allen@gmail.com",
			raw: "allen@gmail dot com",
			tier: "literal",
			index: 0,
		},
	]);
	// Raw preserves the caller's original text (comma, not normalized dot).
	expect(extractEmailMatches("allen@example,com")[0]?.raw).toBe(
		"allen@example,com",
	);
	expect(extractEmailMatches("Email: ME@EXAMPLE.COM")[0]).toMatchObject({
		address: "me@example.com",
		tier: "literal",
	});
});

test("bare-at dot-word must be after the separator", () => {
	// A dot-word before the "at" cannot satisfy the gate — only the domain
	// portion (strictly after the separator) counts. A global "dot word
	// anywhere in the text" check would wrongly accept the first line.
	expect(extractEmailAddresses("please dot at office today")).toEqual([]);
	expect(extractEmailAddresses("see dot then allen at gmail.com")).toEqual([]);
	// Post-separator dot-word still matches.
	expect(extractEmailMatches("dotty at gmail dot com")).toMatchObject([
		{ address: "dotty@gmail.com", tier: "dictated" },
	]);
	// Mixed: prose clause rejected, dictated clause kept, first-seen order.
	expect(
		extractEmailMatches(
			"and interned at Acme.AI (a VC firm) and contact allen at gmail dot com today",
		),
	).toMatchObject([{ address: "allen@gmail.com", tier: "dictated" }]);
});

test("repairs an underscore Tesseract dropped as a space", () => {
	// The reported bug: photo reads celeste_li@example.com, OCR joins it as
	// "celeste li@example.com", detector kept only "li@example.com".
	expect(extractEmailAddresses("celeste li@example.com")).toEqual([
		"celeste_li@example.com",
	]);
	expect(extractEmailMatches("celeste li@example.com")).toMatchObject([
		{
			address: "celeste_li@example.com",
			raw: "celeste li@example.com",
			tier: "literal",
			index: 0,
		},
	]);
	// Left fragment already carrying the underscore: no double "__".
	expect(extractEmailAddresses("celeste_ li@example.com")).toEqual([
		"celeste_li@example.com",
	]);
	// Embedded among prose, evidence keeps the spaced source text.
	expect(extractEmailAddresses("Contact celeste li@example.com today")).toEqual(
		["celeste_li@example.com"],
	);
});

test("underscore repair stays conservative around prose and neighbours", () => {
	// Full local part: nothing to repair.
	expect(extractEmailAddresses("Contact johndoe@example.com today")).toEqual([
		"johndoe@example.com",
	]);
	// Sentence-case prose before a short local: left alone (capital guard).
	expect(extractEmailAddresses("Contact li@example.com today")).toEqual([
		"li@example.com",
	]);
	// Adjacent addresses never glue across the gap.
	expect(extractEmailAddresses("a@x.com b@y.org")).toEqual([
		"a@x.com",
		"b@y.org",
	]);
	expect(extractEmailAddresses("bob@example.com smith@x.org")).toEqual([
		"bob@example.com",
		"smith@x.org",
	]);
	// Dictated/prose shapes unaffected.
	expect(extractEmailAddresses("meet me at the office")).toEqual([]);
	expect(extractEmailAddresses("allen at gmail dot com")).toEqual([
		"allen@gmail.com",
	]);
});
