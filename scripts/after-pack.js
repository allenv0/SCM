"use strict";

// electron-builder afterPack hook: the macOS app only needs the darwin
// onnxruntime binaries. The npm package ships Linux and Windows runtimes plus
// a second copy of the darwin dylib under its versioned name; prune them
// before electron-builder signs the bundle. The binding loads
// `@rpath/libonnxruntime.1.dylib`, so the versioned copy is redundant.
//
// This runs after the app directory is assembled but before signing, which
// keeps the code signature valid. It is intentionally separate from
// build.files: asarUnpack patterns copy the whole package, and a files
// exclusion is not guaranteed to reach the unpacked tree.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const UNUSED_ARCHES = ["linux", "win32"];
// SCM imports local media and runs local models; it never asks macOS for a
// camera, microphone, or Bluetooth permission. Electron's default plist
// advertises all three, which makes the first-launch privacy story look far
// broader than the app actually is.
const UNUSED_USAGE_KEYS = [
	"NSCameraUsageDescription",
	"NSMicrophoneUsageDescription",
	"NSAudioCaptureUsageDescription",
	"NSBluetoothAlwaysUsageDescription",
	"NSBluetoothPeripheralUsageDescription",
];
// The binding resolves `@rpath/libonnxruntime.1.dylib`; the fully versioned
// dylib is a duplicate that must follow the onnxruntime package version.
const VERSIONED_DYLIB_RE = /^libonnxruntime\.\d+\.\d+\.\d+\.dylib$/;
const LOADED_DYLIB = "libonnxruntime.1.dylib";

function pruneOnnxRuntime(appDir) {
	const binRoot = path.join(
		appDir,
		"Contents",
		"Resources",
		"app.asar.unpacked",
		"node_modules",
		"onnxruntime-node",
		"bin",
		"napi-v6",
	);
	if (!fs.existsSync(binRoot)) return [];

	const removed = [];
	for (const arch of UNUSED_ARCHES) {
		const target = path.join(binRoot, arch);
		if (!fs.existsSync(target)) continue;
		fs.rmSync(target, { recursive: true, force: true });
		removed.push(path.relative(appDir, target));
	}

	const darwinRoot = path.join(binRoot, "darwin");
	if (fs.existsSync(darwinRoot)) {
		for (const arch of fs.readdirSync(darwinRoot)) {
			const dir = path.join(darwinRoot, arch);
			if (!fs.existsSync(path.join(dir, LOADED_DYLIB))) continue;
			for (const name of fs.readdirSync(dir)) {
				if (!VERSIONED_DYLIB_RE.test(name)) continue;
				const versioned = path.join(dir, name);
				fs.rmSync(versioned, { force: true });
				removed.push(path.relative(appDir, versioned));
			}
		}
	}
	return removed;
}

function pruneUsageDescriptions(appDir) {
	const plist = path.join(appDir, "Contents", "Info.plist");
	if (!fs.existsSync(plist)) return [];
	const removed = [];
	for (const key of UNUSED_USAGE_KEYS) {
		try {
			execFileSync("/usr/bin/plutil", ["-remove", key, plist], {
				stdio: "ignore",
			});
			removed.push(key);
		} catch {
			/* key absent on this Electron version */
		}
	}
	// electron-builder merges its own ATS dictionary into Electron's default,
	// and the existing `true` wins over mac.extendInfo. Patch the assembled
	// plist directly; this runs before signing, so the signature covers it.
	try {
		execFileSync(
			"/usr/bin/plutil",
			[
				"-replace",
				"NSAppTransportSecurity.NSAllowsArbitraryLoads",
				"-bool",
				"NO",
				plist,
			],
			{ stdio: "ignore" },
		);
		removed.push("NSAllowsArbitraryLoads");
	} catch {
		/* older plist without the key */
	}
	return removed;
}

module.exports = async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	const appDir = path.join(
		context.appOutDir,
		`${context.packager.appInfo.productFilename}.app`,
	);
	const removed = pruneOnnxRuntime(appDir);
	if (removed.length > 0) {
		console.log(`[after-pack] pruned ${removed.length} unused ONNX path(s)`);
	}
	const keys = pruneUsageDescriptions(appDir);
	if (keys.length > 0) {
		console.log(`[after-pack] hardened Info.plist (${keys.length} change(s))`);
	}
};

module.exports.pruneOnnxRuntime = pruneOnnxRuntime;
