"use strict";

// Unit tests for screenshot-probe.js — the import-time PNG/JPEG metadata
// scan that feeds the Screenshots tab's rename-proof hint. Fixtures are
// built byte-by-byte (CRC32 included) so no real screencapture output or
// image library is needed.

const assert = require("node:assert");
const { test } = require("bun:test");
const zlib = require("zlib");
const {
	scanBuffer,
	probeScreenshotMetadata,
	DEFAULT_MAX_BYTES,
} = require("../screenshot-probe.js");

// --- PNG fixture helpers ---------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const typeBuf = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
	return Buffer.concat([len, typeBuf, data, crc]);
}

function ihdrChunk() {
	// 1x1, 8-bit, RGBA.
	return pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
}

function pngWithChunks(chunks) {
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		ihdrChunk(),
		...chunks,
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

// --- JPEG fixture helper (EXIF UserComment) ---------------------------------

function tiffWithUserComment(text) {
	const charset = Buffer.from("ASCII\0\0\0", "latin1");
	const value = Buffer.concat([charset, Buffer.from(text, "latin1")]);
	// Layout: header(8) + IFD0(2 + 12*1 + 4) + ExifIFD(2 + 12*1 + 4) + value
	const ifd0 = 8;
	const exifIfd = ifd0 + 2 + 12 + 4;
	const valueOffset = exifIfd + 2 + 12 + 4;
	const tiff = Buffer.alloc(valueOffset + value.length);
	tiff.write("II", 0, "latin1");
	tiff.writeUInt16LE(42, 2);
	tiff.writeUInt32LE(ifd0, 4);
	// IFD0: one entry → Exif sub-IFD pointer (0x8769, LONG, 1).
	tiff.writeUInt16LE(1, ifd0);
	tiff.writeUInt16LE(0x8769, ifd0 + 2);
	tiff.writeUInt16LE(4, ifd0 + 4);
	tiff.writeUInt32LE(1, ifd0 + 6);
	tiff.writeUInt32LE(exifIfd, ifd0 + 10);
	tiff.writeUInt32LE(0, ifd0 + 14); // next-IFD pointer
	// Exif sub-IFD: one entry → UserComment (0x9286, UNDEFINED, len).
	tiff.writeUInt16LE(1, exifIfd);
	tiff.writeUInt16LE(0x9286, exifIfd + 2);
	tiff.writeUInt16LE(7, exifIfd + 4);
	tiff.writeUInt32LE(value.length, exifIfd + 6);
	tiff.writeUInt32LE(valueOffset, exifIfd + 10);
	tiff.writeUInt32LE(0, exifIfd + 14);
	value.copy(tiff, valueOffset);
	return tiff;
}

function jpegWithExifUserComment(text) {
	const tiff = tiffWithUserComment(text);
	const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
	const seg = Buffer.alloc(4 + payload.length);
	seg[0] = 0xff;
	seg[1] = 0xe1;
	seg.writeUInt16BE(2 + payload.length, 2);
	payload.copy(seg, 4);
	// SOI + APP1(Exif) + EOI — JPEG does not require a JFIF APP0.
	return Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		seg,
		Buffer.from([0xff, 0xd9]),
	]);
}

// --- Tests -------------------------------------------------------------------

test("PNG tEXt Software=Screenshot (macOS screencapture) is detected", () => {
	const png = pngWithChunks([
		pngChunk("tEXt", Buffer.from("Software\0Screenshot", "latin1")),
	]);
	assert.strictEqual(scanBuffer(png), true);
});

test("PNG tEXt with unrelated comment is not a screenshot", () => {
	const png = pngWithChunks([
		pngChunk("tEXt", Buffer.from("Comment\0a photo of a dog", "latin1")),
	]);
	assert.strictEqual(scanBuffer(png), false);
});

test("PNG iTXt UserComment (iOS screenshot style) is detected", () => {
	const png = pngWithChunks([
		pngChunk(
			"iTXt",
			Buffer.concat([
				Buffer.from("UserComment\0\0\0\0\0", "latin1"),
				Buffer.from("Screenshot of the setup", "utf8"),
			]),
		),
	]);
	assert.strictEqual(scanBuffer(png), true);
});

test("PNG zTXt compressed text is decompressed and detected", () => {
	const png = pngWithChunks([
		pngChunk(
			"zTXt",
			Buffer.concat([
				Buffer.from("Comment\0", "latin1"),
				Buffer.from([0]), // deflate method
				zlib.deflateSync("Screenshot 2024-01-15"),
			]),
		),
	]);
	assert.strictEqual(scanBuffer(png), true);
});

test("JPEG EXIF UserComment (Snipping Tool JPEG style) is detected", () => {
	assert.strictEqual(scanBuffer(jpegWithExifUserComment("Screenshot")), true);
	// Little-endian TIFF with a lowercase match, and big-endian TIFF.
	assert.strictEqual(
		scanBuffer(jpegWithExifUserComment("screenshot of settings")),
		true,
	);
});

test("JPEG without EXIF is not a screenshot", () => {
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
	assert.strictEqual(scanBuffer(jpeg), false);
});

test("garbage bytes and truncated streams are safe negatives", () => {
	assert.strictEqual(
		scanBuffer(Buffer.from("hello world, not an image")),
		false,
	);
	// A truncated PNG chunk stream (bounded read stops mid-chunk).
	const png = pngWithChunks([
		pngChunk("tEXt", Buffer.from("Software\0Screenshot", "latin1")),
	]);
	assert.strictEqual(scanBuffer(png.subarray(0, 30)), false);
	// Empty buffer.
	assert.strictEqual(scanBuffer(Buffer.alloc(0)), false);
});

test("the bounded read stops at DEFAULT_MAX_BYTES and a full read still hits", () => {
	// Pad chunk pushes the tEXt chunk past the read budget: the default
	// budget misses it, the full buffer finds it.
	const padded = pngWithChunks([
		pngChunk("tEXt", Buffer.alloc(DEFAULT_MAX_BYTES - 64, 0x20)),
		pngChunk("tEXt", Buffer.from("Software\0Screenshot", "latin1")),
	]);
	assert.ok(padded.length > DEFAULT_MAX_BYTES);
	assert.strictEqual(scanBuffer(padded.subarray(0, DEFAULT_MAX_BYTES)), false);
	assert.strictEqual(scanBuffer(padded), true);
});

test("probeScreenshotMetadata reads a real file and survives errors", async () => {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-probe-"));
	try {
		const pngPath = path.join(dir, "shot.png");
		fs.writeFileSync(
			pngPath,
			pngWithChunks([
				pngChunk("tEXt", Buffer.from("Software\0Screenshot", "latin1")),
			]),
		);
		assert.strictEqual(await probeScreenshotMetadata(pngPath), true);

		const plainPath = path.join(dir, "plain.png");
		fs.writeFileSync(
			plainPath,
			pngWithChunks([
				pngChunk("tEXt", Buffer.from("Comment\0hello", "latin1")),
			]),
		);
		assert.strictEqual(await probeScreenshotMetadata(plainPath), false);

		// Missing file / unsupported bytes never throw.
		assert.strictEqual(
			await probeScreenshotMetadata(path.join(dir, "nope.png")),
			false,
		);
		const junkPath = path.join(dir, "junk.png");
		fs.writeFileSync(junkPath, Buffer.from("not an image at all"));
		assert.strictEqual(await probeScreenshotMetadata(junkPath), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
