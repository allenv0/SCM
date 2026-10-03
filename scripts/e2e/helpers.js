"use strict";

// Shared helpers for the Electron smoke drivers (scripts/e2e/*). Drivers run
// inside the app process and receive prod functions via ctx — this module
// holds only test-side utilities with no dependency on main.js.

const fs = require("fs");
const path = require("path");

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// Poll fn() until truthy (or timeout): the main-process side of the
// wait-for pattern page scripts use. Returns fn()'s value.
async function poll(fn, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		let value;
		try {
			value = fn();
		} catch {
			/* keep polling */
		}
		if (value) return value;
		if (Date.now() - t0 >= timeoutMs) {
			throw new Error(`timed out waiting for ${label}`);
		}
		await sleep(500);
	}
}

// One solid-color JPEG fixture (sharp is an app dependency, dynamically
// imported like everywhere else — ESM-only from CJS).
async function solidJpg(dir, name, rgb, size = 64) {
	const sharp = (await import("sharp")).default;
	const file = path.join(dir, name);
	await sharp({
		create: {
			width: size,
			height: size,
			channels: 3,
			background: { r: rgb[0], g: rgb[1], b: rgb[2] },
		},
	})
		.jpeg()
		.toFile(file);
	return file;
}

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

module.exports = { sleep, poll, solidJpg, ensureDir };
