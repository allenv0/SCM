"use strict";

// Packaging guard: every first-party module the packaged app can require at
// startup must be shipped inside the asar. Regression test for the
// "Cannot find module './main-lib/settings.js'" crash — main.js was split
// into main-lib/ but build.files in package.json was never updated, so
// `electron .` worked from source while the installed DMG crashed on launch.
//
// What it checks:
//   1. All relative require() targets in the prod source set (main.js,
//      preload.js, screenshot-probe.js, main-lib/, indexer/) resolve to a
//      file that exists.
//   2. Every such target outside scripts/ and test/ is covered by the
//      build.files include globs (i.e. it lands in the asar).
//   3. Requires into scripts/ and test/ are smoke-only: they must be lazy
//      (indented, inside an env-gated branch in main.js) so a production
//      launch never touches them — and they must stay OUT of build.files.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(
	fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
const globs = pkg.build.files;
assert.ok(
	Array.isArray(globs) && globs.length > 0,
	"package.json build.files must exist",
);

function listJsFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listJsFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
	}
	return out;
}

const SOURCES = [
	path.join(ROOT, "main.js"),
	path.join(ROOT, "preload.js"),
	path.join(ROOT, "screenshot-probe.js"),
	...listJsFiles(path.join(ROOT, "main-lib")),
	...listJsFiles(path.join(ROOT, "indexer")),
];
for (const src of SOURCES) {
	assert.ok(fs.existsSync(src), `prod source missing: ${src}`);
}

// Minimal matcher for the glob shapes used in build.files: "dir/**" prefix
// globs and exact file entries (plus "!" excludes).
function coveredByGlobs(relPosix) {
	let covered = false;
	for (const entry of globs) {
		if (entry.startsWith("!")) continue;
		if (entry.endsWith("/**")) {
			const prefix = entry.slice(0, -3);
			if (relPosix === prefix || relPosix.startsWith(`${prefix}/`)) {
				covered = true;
			}
		} else if (entry === relPosix) {
			covered = true;
		}
	}
	if (!covered) return false;
	for (const entry of globs) {
		if (!entry.startsWith("!")) continue;
		const excl = entry.slice(1);
		if (excl.endsWith("/**")) {
			const prefix = excl.slice(0, -3);
			if (relPosix === prefix || relPosix.startsWith(`${prefix}/`)) {
				return false;
			}
		} else if (excl === relPosix) {
			return false;
		}
	}
	return true;
}

const REQUIRE_RE = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
const failures = [];
let prodCount = 0;
let smokeCount = 0;

for (const src of SOURCES) {
	const text = fs.readFileSync(src, "utf8");
	const lines = text.split("\n");
	for (const [lineIndex, line] of lines.entries()) {
		REQUIRE_RE.lastIndex = 0;
		let match;
		while ((match = REQUIRE_RE.exec(line)) !== null) {
			const target = match[1];
			let resolved = path.normalize(path.join(path.dirname(src), target));
			if (!resolved.endsWith(".js")) resolved += ".js";
			const rel = path.relative(ROOT, resolved);
			const relPosix = rel.split(path.sep).join("/");
			assert.ok(
				!rel.startsWith("..") && !path.isAbsolute(rel),
				`${path.relative(ROOT, src)}:${lineIndex + 1} escapes the repo: ${target}`,
			);
			assert.ok(
				fs.existsSync(resolved),
				`${path.relative(ROOT, src)}:${lineIndex + 1} requires missing file: ${target}`,
			);
			const isSmokeOnly =
				relPosix.startsWith("scripts/") || relPosix.startsWith("test/");
			if (isSmokeOnly) {
				smokeCount++;
				// Smoke helpers run under ELECTRON_SMOKE_* branches; a
				// top-level (column-0) require would execute on every
				// production launch and crash the packaged app, which does
				// not ship scripts/ or test/.
				assert.ok(
					path.basename(src) === "main.js",
					`smoke-only require of ${relPosix} must live in main.js, found in ${path.relative(ROOT, src)}`,
				);
				assert.ok(
					/^\s/.test(line),
					`${path.relative(ROOT, src)}:${lineIndex + 1} requires smoke-only ${relPosix} at top level — it would run on production launch`,
				);
				assert.ok(
					!coveredByGlobs(relPosix),
					`smoke-only ${relPosix} must stay out of build.files`,
				);
			} else {
				prodCount++;
				if (!coveredByGlobs(relPosix)) {
					failures.push(
						`${path.relative(ROOT, src)}:${lineIndex + 1} requires ${relPosix}, which no build.files entry ships`,
					);
				}
			}
		}
	}
}

assert.deepEqual(
	failures,
	[],
	`${failures.length} prod require(s) missing from build.files:\n${failures.join("\n")}`,
);

console.log(
	`[packaged-files] OK — ${prodCount} prod require(s) covered by build.files, ${smokeCount} smoke-only require(s) lazy in main.js`,
);
