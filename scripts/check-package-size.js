"use strict";

// Packaged-app guard. This is deliberately a standalone script, not a file
// under test/: `bun test test/` runs every file in one process, and an
// electron-builder build is far too slow (and too environment-dependent) for
// the unit suite. Run it after `electron-builder --dir`:
//
//   bun run build && CSC_IDENTITY_AUTO_DISCOVERY=false \
//     bunx electron-builder --mac --dir
//   bun run test:packaged-size
//
// CI can set SCM_REQUIRE_PACKAGED=1 so a missing build is a failure instead
// of a skip. SCM_PACKAGED_APP overrides the app path.

const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const ROOT = path.join(__dirname, "..");
const APP =
	process.env.SCM_PACKAGED_APP ||
	path.join(ROOT, "dist-app", "mac-arm64", "SCM.app");
const ASAR = path.join(APP, "Contents", "Resources", "app.asar");
const UNPACKED = path.join(APP, "Contents", "Resources", "app.asar.unpacked");
// Current baseline: app.asar ≈ 95 MiB, app ≈ 479 MiB. Leave ~15% headroom
// for an Electron patch bump, but fail before a model cache or a second
// runtime copy creeps back in.
const MAX_ASAR_BYTES = 150 * 1024 * 1024;
const MAX_APP_BYTES = 550 * 1024 * 1024;

const ASAR_DENY = [
	{
		name: "transformers model cache",
		re: /(^|\/)node_modules\/@huggingface\/transformers\/\.cache(\/|$)/,
	},
	{
		name: "unused onnxruntime-web package",
		re: /(^|\/)node_modules\/onnxruntime-web(\/|$)/,
	},
	{
		name: "unused @xenova package",
		re: /(^|\/)node_modules\/@xenova(\/|$)/,
	},
];

const UNPACKED_DENY = [
	{
		name: "non-macOS onnxruntime binaries",
		re: /(^|\/)onnxruntime-node\/bin\/napi-v6\/(linux|win32)(\/|$)/,
	},
	{
		name: "duplicate versioned onnxruntime dylib",
		re: /(^|\/)onnxruntime-node\/bin\/napi-v6\/darwin\/[^/]+\/libonnxruntime\.1\.30\.0\.dylib$/,
	},
];

function sizeOf(target) {
	const stat = fs.lstatSync(target);
	if (stat.isSymbolicLink()) return 0;
	if (stat.isFile()) return stat.size;
	let total = 0;
	for (const entry of fs.readdirSync(target)) {
		total += sizeOf(path.join(target, entry));
	}
	return total;
}

function walk(root, out = []) {
	if (!fs.existsSync(root)) return out;
	for (const entry of fs.readdirSync(root)) {
		const full = path.join(root, entry);
		const stat = fs.lstatSync(full);
		if (stat.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

function fail(message) {
	console.error(`[package-size] FAIL: ${message}`);
	process.exitCode = 1;
}

function main() {
	if (!fs.existsSync(APP) || !fs.existsSync(ASAR)) {
		const message = `packaged app not found: ${APP}`;
		if (process.env.SCM_REQUIRE_PACKAGED === "1") fail(message);
		else console.log(`[package-size] skip: ${message}`);
		return;
	}

	const asarBytes = fs.statSync(ASAR).size;
	const appBytes = sizeOf(APP);
	const asarMiB = (asarBytes / 1024 / 1024).toFixed(1);
	const appMiB = (appBytes / 1024 / 1024).toFixed(1);
	console.log(`[package-size] app.asar ${asarMiB} MiB, app ${appMiB} MiB`);

	if (asarBytes > MAX_ASAR_BYTES) {
		fail(
			`app.asar is ${asarMiB} MiB (budget ${MAX_ASAR_BYTES / 1024 / 1024} MiB)`,
		);
	}
	if (appBytes > MAX_APP_BYTES) {
		fail(
			`app bundle is ${appMiB} MiB (budget ${MAX_APP_BYTES / 1024 / 1024} MiB)`,
		);
	}

	const files = asar.listPackage(ASAR);
	for (const rule of ASAR_DENY) {
		const hit = files.find((file) => rule.re.test(file));
		if (hit) fail(`${rule.name} is still packaged: ${hit}`);
	}

	const unpacked = walk(UNPACKED);
	for (const rule of UNPACKED_DENY) {
		const hit = unpacked.find((file) => rule.re.test(file));
		if (hit) {
			fail(`${rule.name} is still unpacked: ${path.relative(APP, hit)}`);
		}
	}

	if (!process.exitCode) {
		console.log("[package-size] OK — no denylisted payloads, within budget");
	}
}

main();
