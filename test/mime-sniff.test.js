"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	sniffImageMime,
	canonicalImageExt,
	imageContentType,
} = require("../indexer/mime-sniff.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-mime-"));
const write = (name, bytes) => {
	const p = path.join(dir, name);
	fs.writeFileSync(p, Buffer.from(bytes));
	return p;
};

// Minimal magic headers (decoders never run here — only the first 12 bytes).
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const WEBP = [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")];
const GIF89 = [...Buffer.from("GIF89a"), 0, 0, 0, 0, 0, 0];
const GIF87 = [...Buffer.from("GIF87a"), 0, 0, 0, 0, 0, 0];

assert.equal(sniffImageMime(write("a.png", PNG)), "image/png");
assert.equal(sniffImageMime(write("a.jpg", JPEG)), "image/jpeg");
assert.equal(sniffImageMime(write("a.webp", WEBP)), "image/webp");
assert.equal(sniffImageMime(write("a.gif", GIF89)), "image/gif");
assert.equal(sniffImageMime(write("b.gif", GIF87)), "image/gif");

// The crash-hazard case: WebP bytes under a .png name still sniff as WebP,
// so the server answers image/webp instead of routing into the PNG decoder.
assert.equal(sniffImageMime(write("air-ban.png", WEBP)), "image/webp");
assert.equal(sniffImageMime(write("photo.jpg", WEBP)), "image/webp");

// Non-images and missing files fall back to null (caller uses the extension).
assert.equal(
	sniffImageMime(write("notes.txt", [...Buffer.from("hello world!")])),
	null,
);
assert.equal(sniffImageMime(write("empty.bin", [])), null);
assert.equal(sniffImageMime(path.join(dir, "does-not-exist.png")), null);
assert.equal(sniffImageMime(write("truncated.png", [0x89, 0x50])), null);

assert.equal(canonicalImageExt("image/png"), ".png");
assert.equal(canonicalImageExt("image/jpeg"), ".jpg");
assert.equal(canonicalImageExt("image/webp"), ".webp");
assert.equal(canonicalImageExt("image/gif"), ".gif");
assert.equal(canonicalImageExt("image/avif"), ".avif");
assert.equal(canonicalImageExt("image/heic"), ".heic");
assert.equal(canonicalImageExt("image/bmp"), ".bmp");
assert.equal(canonicalImageExt("image/tiff"), ".tiff");
assert.equal(canonicalImageExt("image/x-icon"), ".ico");
assert.equal(canonicalImageExt("image/svg+xml"), ".svg");
assert.equal(canonicalImageExt("video/mp4"), null);
assert.equal(canonicalImageExt(null), null);

// Extended magics: ISO-BMFF stills, BMP, TIFF, ICO, SVG text.
const ftyp = (brand) => [
	...Buffer.from([0, 0, 0, 24]),
	...Buffer.from("ftyp"),
	...Buffer.from(brand),
];
assert.equal(sniffImageMime(write("a.avif", ftyp("avif"))), "image/avif");
assert.equal(sniffImageMime(write("a.heic", ftyp("heic"))), "image/heic");
assert.equal(sniffImageMime(write("a.heic", ftyp("hevx"))), "image/heic");
// Generic mif1 is ambiguous (AVIF vs HEIC) — must stay unclaimed rather
// than risk the wrong decoder.
assert.equal(sniffImageMime(write("a.mif", ftyp("mif1"))), null);
assert.equal(
	sniffImageMime(write("a.bmp", [0x42, 0x4d, 0, 0, 0, 0])),
	"image/bmp",
);
assert.equal(
	sniffImageMime(write("a.tif", [0x49, 0x49, 0x2a, 0x00])),
	"image/tiff",
);
assert.equal(
	sniffImageMime(write("b.tif", [0x4d, 0x4d, 0x00, 0x2a])),
	"image/tiff",
);
assert.equal(
	sniffImageMime(write("a.ico", [0x00, 0x00, 0x01, 0x00])),
	"image/x-icon",
);
assert.equal(
	sniffImageMime(write("a.svg", [...Buffer.from("<svg ")])),
	"image/svg+xml",
);
assert.equal(
	sniffImageMime(write("b.svg", [...Buffer.from("<?xml")])),
	"image/svg+xml",
);
// Non-SVG text stays unclaimed.
assert.equal(
	sniffImageMime(write("evil.svg", [...Buffer.from("<html>")])),
	null,
);

// imageContentType: the Sep-2026 serving contract. Truthful bytes win;
// unrecognized bytes under an image/* claim fall to octet-stream (the old
// inline logic returned the extension's MIME here — the trap); everything
// else keeps the extension mapping.
const ct = (sniffed, extMime) => imageContentType({ sniffed, extMime });
assert.equal(ct("image/png", "image/png"), "image/png");
assert.equal(ct("image/webp", "image/png"), "image/webp");
assert.equal(ct("image/avif", "image/jpeg"), "image/avif");
// The incident class — each of these served image/png or image/jpeg
// before the fix:
assert.equal(ct(null, "image/png"), "application/octet-stream");
assert.equal(ct(null, "image/jpeg"), "application/octet-stream");
assert.equal(ct(null, "image/gif"), "application/octet-stream");
assert.equal(ct(null, "image/webp"), "application/octet-stream");
assert.equal(ct(null, "image/svg+xml"), "application/octet-stream");
// Non-image mappings are untouched:
assert.equal(ct(null, "video/mp4"), "video/mp4");
assert.equal(ct(null, undefined), "application/octet-stream");
assert.equal(ct("", "image/png"), "application/octet-stream");

fs.rmSync(dir, { recursive: true, force: true });
console.log("mime-sniff: all assertions passed");
