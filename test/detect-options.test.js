#!/usr/bin/env node
"use strict";
// Phase 1 detect helpers: pure option/filter/cache tests (no ffmpeg decode).
// Run: node test/detect-options.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
	resolveDetectOptions,
	detectConfigKey,
	buildDetectFilter,
	buildDetectArgs,
	parseDetectStderr,
	SCENE_THRESHOLD,
} = require("../indexer/video-utils.js");
const detectCache = require("../indexer/detect-cache.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}: ${err.message}`);
	}
}

// Isolate env knobs so the suite is deterministic.
const savedEnv = { ...process.env };
function resetEnv() {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("SCM_DETECT_")) delete process.env[k];
	}
}

console.log("[detect] resolveDetectOptions");
resetEnv();
check("defaults preserve historic software 360p full-rate 0.3", () => {
	const o = resolveDetectOptions({});
	assert.strictEqual(o.height, 360);
	assert.strictEqual(o.fps, 0);
	assert.strictEqual(o.threshold, SCENE_THRESHOLD);
	assert.strictEqual(o.keyframe, false);
	assert.strictEqual(o.cache, false, "no cacheDir → cache off");
});
check("opts override env", () => {
	process.env.SCM_DETECT_HEIGHT = "180";
	const o = resolveDetectOptions({ height: 360, fps: 10, hwaccel: "software" });
	assert.strictEqual(o.height, 360);
	assert.strictEqual(o.fps, 10);
	delete process.env.SCM_DETECT_HEIGHT;
});
check("env fills opts", () => {
	process.env.SCM_DETECT_HWACCEL = "videotoolbox";
	process.env.SCM_DETECT_FPS = "10";
	process.env.SCM_DETECT_KEYFRAME = "1";
	const o = resolveDetectOptions({});
	assert.strictEqual(o.hwaccel, "videotoolbox");
	assert.strictEqual(o.fps, 10);
	assert.strictEqual(o.keyframe, true);
	resetEnv();
});
check("invalid hwaccel falls back to auto", () => {
	const o = resolveDetectOptions({ hwaccel: "cuda" });
	assert.strictEqual(o.hwaccel, "auto");
});
check("cache requires cacheDir", () => {
	const off = resolveDetectOptions({ cache: true });
	assert.strictEqual(off.cache, false);
	const on = resolveDetectOptions({ cache: true, cacheDir: "/tmp/x" });
	assert.strictEqual(on.cache, true);
});

console.log("[detect] filter / args");
check("filter stays in quoted comma-chain form", () => {
	const o = resolveDetectOptions({ hwaccel: "software" });
	const f = buildDetectFilter(o);
	assert.ok(f.includes("scale=-2:360"));
	assert.ok(f.includes(`select='gt(scene,${SCENE_THRESHOLD})'`));
	assert.ok(f.includes("showinfo"));
	assert.ok(f.includes("split=2"));
	assert.ok(f.includes("[b]null[sb]"));
	assert.ok(!f.includes("select=gt(scene,"), "unquoted select is banned");
});
check("fps + height knobs land in the filter", () => {
	const o = resolveDetectOptions({ hwaccel: "software", height: 180, fps: 10 });
	const f = buildDetectFilter(o);
	assert.ok(f.includes("scale=-2:180"));
	assert.ok(f.includes("fps=10"));
});
check("hwdownload form inserts hwdownload,format=nv12", () => {
	const o = resolveDetectOptions({
		hwaccel: "videotoolbox",
		hwaccelOutputFormat: true,
	});
	const f = buildDetectFilter(o, { forHwDownload: true });
	assert.ok(f.includes("hwdownload,format=nv12,scale="));
});
check("software args have no -hwaccel; VT args do", () => {
	const soft = buildDetectArgs("/v.mp4", resolveDetectOptions({ hwaccel: "software" }));
	assert.ok(!soft.includes("-hwaccel"));
	const hw = buildDetectArgs("/v.mp4", resolveDetectOptions({ hwaccel: "videotoolbox" }));
	assert.ok(hw.includes("-hwaccel"));
	assert.ok(hw.includes("videotoolbox"));
	const i = hw.indexOf("-i");
	assert.ok(hw.indexOf("-hwaccel") < i, "hwaccel is an input option");
});
check("keyframeOnly prepends -skip_frame nokey before -i", () => {
	const o = resolveDetectOptions({ hwaccel: "software" });
	const args = buildDetectArgs("/v.mp4", o, { keyframeOnly: true });
	assert.strictEqual(args[0], "-skip_frame");
	assert.strictEqual(args[1], "nokey");
	assert.ok(args.indexOf("-skip_frame") < args.indexOf("-i"));
});

console.log("[detect] parseDetectStderr");
check("parses pts_time hits and last time= tick", () => {
	const stderr = `
[Parsed_showinfo_1 @ 0x1] n: 1 pts: 45000 pts_time:15   t: 15.00
[Parsed_showinfo_1 @ 0x1] n: 2 pts: 90000 pts_time:15.0 t: 15.00
[Parsed_showinfo_1 @ 0x1] n: 3 pts: 135000 pts_time:30  t: 30.00
frame=  100 fps= 50 q=-0.0 size=N/A time=00:01:24.50 bitrate=N/A
`;
	const r = parseDetectStderr(stderr);
	assert.deepStrictEqual(r.boundaries, [15, 30]);
	assert.strictEqual(r.duration, 84.5);
});

console.log("[detect] cache key + store");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-detect-cache-"));
check("same identity+config hits; size/mtime/config miss", () => {
	const filePath = path.join(tmp, "a.mp4");
	fs.writeFileSync(filePath, "xxxx");
	const ident = detectCache.fileIdentity(filePath);
	const configKey = detectConfigKey(resolveDetectOptions({ hwaccel: "software" }));
	const base = {
		filePath: path.resolve(filePath),
		...ident,
		configKey,
	};
	assert.ok(
		detectCache.setCachedDetect(tmp, base, {
			boundaries: [1, 2, 3],
			duration: 10,
			engine: "software",
		}),
	);
	const hit = detectCache.getCachedDetect(tmp, base);
	assert.ok(hit && hit.cached);
	assert.deepStrictEqual(hit.boundaries, [1, 2, 3]);
	const miss = detectCache.getCachedDetect(tmp, {
		...base,
		configKey: detectConfigKey(resolveDetectOptions({ height: 180 })),
	});
	assert.strictEqual(miss, null);
	const miss2 = detectCache.getCachedDetect(tmp, {
		...base,
		size: base.size + 1,
	});
	assert.strictEqual(miss2, null);
});
check("corrupt cache file is ignored", () => {
	const filePath = path.join(tmp, "b.mp4");
	fs.writeFileSync(filePath, "yyyy");
	const ident = detectCache.fileIdentity(filePath);
	const configKey = "k";
	const cachePath = detectCache.detectCachePath(tmp);
	fs.writeFileSync(cachePath, "{not json");
	assert.strictEqual(
		detectCache.getCachedDetect(tmp, {
			filePath: path.resolve(filePath),
			...ident,
			configKey,
		}),
		null,
	);
	detectCache.setCachedDetect(
		tmp,
		{ filePath: path.resolve(filePath), ...ident, configKey },
		{ boundaries: [9], duration: 1, engine: "software" },
	);
	const hit = detectCache.getCachedDetect(tmp, {
		filePath: path.resolve(filePath),
		...ident,
		configKey,
	});
	assert.deepStrictEqual(hit.boundaries, [9]);
});
check("mtime change invalidates", () => {
	const filePath = path.join(tmp, "c.mp4");
	fs.writeFileSync(filePath, "zzzz");
	const ident = detectCache.fileIdentity(filePath);
	const configKey = "k";
	detectCache.setCachedDetect(
		tmp,
		{ filePath: path.resolve(filePath), ...ident, configKey },
		{ boundaries: [1], duration: 1, engine: "software" },
	);
	const future = new Date(Date.now() + 5000);
	fs.utimesSync(filePath, future, future);
	const miss = detectCache.getCachedDetect(tmp, {
		filePath: path.resolve(filePath),
		...detectCache.fileIdentity(filePath),
		configKey,
	});
	assert.strictEqual(miss, null);
});

// restore env
for (const k of Object.keys(process.env)) {
	if (!(k in savedEnv)) delete process.env[k];
}
Object.assign(process.env, savedEnv);

console.log(`\n[detect] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
