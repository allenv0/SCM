"use strict";

// Magic-byte sniffing for stored/served images. Files arrive with arbitrary
// extensions (screenshots saved as .png that are really WebP, downloads
// renamed by hand), and serving or naming by extension alone can route
// foreign bytes into the PNG decoder — a wrong-decoder hazard that has
// crashed Electron/Chromium on macOS Tahoe (EXC_BREAKPOINT / SIGTRAP on a
// ThreadPoolForegroundWorker inside the framework's Rust image code; Sep-2026
// production incident, SCM 0.2.1). The bytes, not the name, must decide the
// Content-Type and the stored extension — and when the bytes match NOTHING
// recognizable, the server must not name ANY image decoder (see
// imageContentType below): garbage/AVIF/HEIC bytes served as image/png are
// the same trap in a different coat.

const fs = require("fs");

// Sync 12-byte read; returns an image MIME or null when the content is not a
// recognized image (the caller then applies imageContentType, never the raw
// extension map). Never throws.
function sniffImageMime(filePath) {
	let fd = null;
	try {
		fd = fs.openSync(filePath, "r");
		const buf = Buffer.alloc(12);
		const n = fs.readSync(fd, buf, 0, 12, 0);
		if (
			n >= 8 &&
			buf[0] === 0x89 &&
			buf[1] === 0x50 &&
			buf[2] === 0x4e &&
			buf[3] === 0x47 &&
			buf[4] === 0x0d &&
			buf[5] === 0x0a &&
			buf[6] === 0x1a &&
			buf[7] === 0x0a
		)
			return "image/png";
		if (n >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
			return "image/jpeg";
		if (
			n >= 12 &&
			buf.toString("ascii", 0, 4) === "RIFF" &&
			buf.toString("ascii", 8, 12) === "WEBP"
		)
			return "image/webp";
		if (n >= 6) {
			const head = buf.toString("ascii", 0, 6);
			if (head === "GIF87a" || head === "GIF89a") return "image/gif";
		}
		// ISO-BMFF stills: ftyp box at 0, major brand at 8. AVIF brands as
		// avif; HEIC as heic/heix/hevc/hevx. Generic mif1/msf1 is
		// deliberately NOT claimed — without compatible-brand parsing it is
		// ambiguous between AVIF and HEIC, and a wrong claim is exactly the
		// hazard this module exists to prevent.
		if (n >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
			const brand = buf.toString("ascii", 8, 12);
			if (brand === "avif") return "image/avif";
			if (
				brand === "heic" ||
				brand === "heix" ||
				brand === "hevc" ||
				brand === "hevx"
			)
				return "image/heic";
		}
		if (n >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
		if (
			n >= 4 &&
			((buf[0] === 0x49 &&
				buf[1] === 0x49 &&
				buf[2] === 0x2a &&
				buf[3] === 0x00) ||
				(buf[0] === 0x4d &&
					buf[1] === 0x4d &&
					buf[2] === 0x00 &&
					buf[3] === 0x2a))
		)
			return "image/tiff";
		if (
			n >= 4 &&
			buf[0] === 0x00 &&
			buf[1] === 0x00 &&
			buf[2] === 0x01 &&
			buf[3] === 0x00
		)
			return "image/x-icon";
		// SVG is XML text: an <svg root tag or XML prolog in the first bytes.
		// Anything else textual (HTML error pages, scripts) stays null — the
		// safe fallback below handles it.
		if (n >= 5) {
			const head = buf.toString("ascii", 0, 5);
			if (head === "<svg " || head === "<svg>" || head === "<?xml")
				return "image/svg+xml";
		}
	} catch {
		/* fall through to null */
	} finally {
		try {
			if (fd !== null) fs.closeSync(fd);
		} catch {
			/* best-effort */
		}
	}
	return null;
}

// Canonical image extension for sniffed content (import normalization and
// serve-time fallback share this so the two can never disagree).
function canonicalImageExt(mime) {
	if (mime === "image/jpeg") return ".jpg";
	if (mime === "image/png") return ".png";
	if (mime === "image/webp") return ".webp";
	if (mime === "image/gif") return ".gif";
	if (mime === "image/avif") return ".avif";
	if (mime === "image/heic") return ".heic";
	if (mime === "image/bmp") return ".bmp";
	if (mime === "image/tiff") return ".tiff";
	if (mime === "image/x-icon") return ".ico";
	if (mime === "image/svg+xml") return ".svg";
	return null;
}

// Safe Content-Type for a served library file — the decision the app://
// projects route must make per request. Pure (all inputs are arguments) so
// the contract is unit-testable without a server:
//
//   sniffed — sniffImageMime(filePath) result (string) or null.
//   extMime — the extension map's answer for this filename, if any.
//
// Rules:
//   1. Recognized bytes win unconditionally (truthful decoder).
//   2. Unrecognized bytes under an image/* extension claim MUST NOT inherit
//      that claim — forcing e.g. the PNG decoder onto AVIF/garbage bytes is
//      the Sep-2026 trap. application/octet-stream lets Chromium sniff-or-
//      break the way the whole web already relies on, instead of executing
//      a decoder the bytes never asked for.
//   3. Everything else (video types, unknown extensions) keeps the
//      extension mapping — unchanged behavior outside the hazard.
function imageContentType({ sniffed, extMime }) {
	if (typeof sniffed === "string" && sniffed) return sniffed;
	if (typeof extMime === "string" && extMime.startsWith("image/")) {
		return "application/octet-stream";
	}
	return extMime || "application/octet-stream";
}

module.exports = { sniffImageMime, canonicalImageExt, imageContentType };
