"use strict";

// Import-time screenshot metadata probe (main process). Screenshots saved by
// macOS screencapture and iOS embed PNG text metadata that says so —
// typically a tEXt chunk with Software/UserComment "Screenshot" — and the
// JPEG side of the world (Snipping Tool, phone exports) carries the same
// word in EXIF UserComment. Reading that word at import gives the Screenshots
// tab a rename-proof signal: the user can rename Bildschirmfoto-2024.png to
// anything and the classification still sticks.
//
// Pure Node, no dependencies, bounded reads (first maxBytes of the file —
// text/EXIF chunks sit near the file header in practice). Every parse step
// is bounds-checked; any surprise returns false instead of throwing. The
// matcher is deliberately liberal: any text chunk (tEXt/iTXt/zTXt/eXIf) whose
// keyword or value contains "screenshot" counts. Exported for tests.

const fsPromises = require("fs").promises;
const zlib = require("zlib");

const DEFAULT_MAX_BYTES = 256 * 1024;

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function containsScreenshot(text) {
	return typeof text === "string" && text.toLowerCase().includes("screenshot");
}

// Decode one text chunk: `keywordBuf` is the slice up to (not including) its
// NUL terminator, `valueBuf` the slice holding the text. Returns
// [keyword, value] or null when either side is malformed.
function decodeTextChunk(
	keywordBuf,
	valueBuf,
	{ compressed = false, utf8 = false } = {},
) {
	const keyword = keywordBuf.toString("latin1").trim();
	if (!keyword || valueBuf.length < 0) return null;
	try {
		const value = compressed
			? zlib.inflateSync(valueBuf).toString("utf8")
			: valueBuf.toString(utf8 ? "utf8" : "latin1");
		return [keyword.toLowerCase(), value];
	} catch {
		return null;
	}
}

// Walk a PNG buffer's chunk stream, checking every text-bearing chunk.
function scanPngChunks(buf) {
	let offset = PNG_SIGNATURE.length;
	while (offset + 12 <= buf.length) {
		const len = buf.readUInt32BE(offset);
		const type = buf.toString("latin1", offset + 4, offset + 8);
		const dataStart = offset + 8;
		const dataEnd = dataStart + len;
		// Truncated stream (bounded read or corrupt file) — stop scanning.
		if (dataEnd + 4 > buf.length) return false;
		const data = buf.subarray(dataStart, dataEnd);
		let hit = false;
		if (type === "tEXt") {
			// keyword\0 text
			const nul = data.indexOf(0);
			if (nul !== -1) {
				const decoded = decodeTextChunk(
					data.subarray(0, nul),
					data.subarray(nul + 1),
				);
				if (decoded)
					hit =
						containsScreenshot(decoded[0]) || containsScreenshot(decoded[1]);
			}
		} else if (type === "iTXt") {
			// keyword\0 compFlag(1) compMethod(1) langTag\0 translated\0 text
			const nul = data.indexOf(0);
			if (nul !== -1 && nul + 3 <= data.length) {
				const compFlag = data[nul + 1];
				const langEnd = data.indexOf(0, nul + 3);
				if (langEnd !== -1) {
					const translatedEnd = data.indexOf(0, langEnd + 1);
					if (translatedEnd !== -1) {
						const decoded = decodeTextChunk(
							data.subarray(0, nul),
							data.subarray(translatedEnd + 1),
							{ compressed: compFlag === 1, utf8: true },
						);
						if (decoded)
							hit =
								containsScreenshot(decoded[0]) ||
								containsScreenshot(decoded[1]);
					}
				}
			}
		} else if (type === "zTXt") {
			// keyword\0 compMethod(1) deflate(text)
			const nul = data.indexOf(0);
			if (nul !== -1 && nul + 2 <= data.length) {
				const decoded = decodeTextChunk(
					data.subarray(0, nul),
					data.subarray(nul + 2),
					{ compressed: true },
				);
				if (decoded)
					hit =
						containsScreenshot(decoded[0]) || containsScreenshot(decoded[1]);
			}
		} else if (type === "eXIf") {
			// The chunk data IS a TIFF structure.
			if (exifSaysScreenshot(data)) hit = true;
		}
		if (hit) return true;
		offset = dataEnd + 4;
	}
	return false;
}

// TIFF/EXIF: find the UserComment tag (0x9286) and check its text. Handles
// both byte orders and the ASCII / UTF-16 value encodings in the wild.
function exifSaysScreenshot(tiff) {
	if (tiff.length < 8) return false;
	const order = tiff.toString("latin1", 0, 2);
	let little;
	if (order === "II") little = true;
	else if (order === "MM") little = false;
	else return false;
	const u16 = (o) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
	const u32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));

	// findTag returns {type, count, valueOffset} — valueOffset is the entry's
	// value field position, which for inline values (count*unitSize <= 4)
	// already IS the value.
	const findTag = (ifdOffset, tag) => {
		if (ifdOffset <= 0 || ifdOffset + 2 > tiff.length) return null;
		const count = u16(ifdOffset);
		for (let i = 0; i < count; i++) {
			const entry = ifdOffset + 2 + i * 12;
			if (entry + 12 > tiff.length) return null;
			if (u16(entry) === tag) {
				return {
					type: u16(entry + 2),
					count: u32(entry + 4),
					valueOffset: u32(entry + 8),
				};
			}
		}
		return null;
	};

	// Tag unit sizes: 1 BYTE, 2 ASCII, 7 UNDEFINED = 1; 3 SHORT = 2;
	// 4 LONG = 4; 5/10 RATIONAL = 8. Unknown types are skipped defensively.
	const unitSize = (type) =>
		type === 3 ? 2 : type === 4 ? 4 : type === 5 || type === 10 ? 8 : 1;

	// IFD0 → Exif sub-IFD pointer (0x8769) → UserComment (0x9286).
	const exifPtr = findTag(8, 0x8769);
	if (!exifPtr || exifPtr.type !== 4) return false;
	const userComment = findTag(exifPtr.valueOffset, 0x9286);
	if (!userComment) return false;

	const size = unitSize(userComment.type) * userComment.count;
	if (size < 8) return false; // the 8-byte charset prefix alone
	if (
		userComment.valueOffset < 0 ||
		userComment.valueOffset + size > tiff.length
	) {
		return false;
	}
	const value = tiff.subarray(
		userComment.valueOffset,
		userComment.valueOffset + size,
	);
	const charset = value.toString("latin1", 0, 8);
	try {
		const text = value.subarray(8);
		if (charset.startsWith("UNICODE")) {
			// UTF-16 in the TIFF's byte order; Node only speaks LE, so BE
			// buffers get their byte pairs swapped first.
			const pairs = Buffer.from(
				text.subarray(0, Math.floor(text.length / 2) * 2),
			);
			if (!little) pairs.swap16();
			return containsScreenshot(pairs.toString("utf16le").replace(/\0/g, ""));
		}
		return containsScreenshot(text.toString("latin1").replace(/\0/g, ""));
	} catch {
		return false;
	}
}

function scanJpegForExif(buf) {
	// Walk segments: FF <marker> <len hi> <len lo> <payload…>.
	let offset = 2;
	while (offset + 4 <= buf.length) {
		if (buf[offset] !== 0xff) return false;
		const marker = buf[offset + 1];
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			// Standalone markers carry no length field.
			offset += 2;
			continue;
		}
		if (marker === 0xda) return false; // start of scan — EXIF lives earlier
		const len = buf.readUInt16BE(offset + 2);
		if (len < 2) return false;
		const payload = buf.subarray(
			offset + 4,
			Math.min(offset + 2 + len, buf.length),
		);
		if (
			marker === 0xe1 &&
			payload.length > 6 &&
			payload.toString("latin1", 0, 6) === "Exif\0\0"
		) {
			if (exifSaysScreenshot(payload.subarray(6))) return true;
		}
		offset += 2 + len;
	}
	return false;
}

// Sync core: buffer in, boolean out. Exported for tests.
function scanBuffer(buf) {
	try {
		if (
			buf.length >= PNG_SIGNATURE.length &&
			buf.subarray(0, 8).equals(PNG_SIGNATURE)
		) {
			return scanPngChunks(buf);
		}
		if (
			buf.length >= 3 &&
			buf[0] === 0xff &&
			buf[1] === 0xd8 &&
			buf[2] === 0xff
		) {
			return scanJpegForExif(buf);
		}
	} catch {
		return false;
	}
	return false;
}

// Bounded read + sniff. Never throws: any read/parse surprise is "no signal".
async function probeScreenshotMetadata(
	filePath,
	{ maxBytes = DEFAULT_MAX_BYTES } = {},
) {
	let fh;
	try {
		fh = await fsPromises.open(filePath, "r");
		const stat = await fh.stat();
		const length = Math.min(stat.size, maxBytes);
		if (length < 8) return false;
		const buf = Buffer.alloc(length);
		const { bytesRead } = await fh.read(buf, 0, length, 0);
		return scanBuffer(buf.subarray(0, bytesRead));
	} catch {
		return false;
	} finally {
		try {
			if (fh) await fh.close();
		} catch {
			/* already closed */
		}
	}
}

module.exports = {
	probeScreenshotMetadata,
	scanBuffer,
	DEFAULT_MAX_BYTES,
};
