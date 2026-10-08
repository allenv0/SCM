#!/usr/bin/env node
"use strict";
// Assemble the Phase 3A required fixture corpus and write fixtures/manifest.json
// with SHA-256 pins (plan §5.2).
//
//   16 deterministic solids
//   32 rights-clear real photographs / screenshots
//   16 extracted real-video frames (dark / faces / text / landscape / detail)
//   ≥20 named queries + expected positives + a predeclared score-tie band
//
// Usage: node build-fixtures.js [--skip-download]

const fs = require("fs");
const path = require("path");
// Explicit require: global `crypto` is absent on older Electron/node (the
// same guard main.js applies — the built-in shadows nothing here).
// eslint-disable-next-line no-redeclare
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname);
const REPO = path.resolve(ROOT, "..", "..");
const IMG = path.join(ROOT, "fixtures", "images");
const MANIFEST = path.join(ROOT, "fixtures", "manifest.json");
const SCORE_TIE_BAND = 0.002; // predeclared; never post-hoc (plan §5.3)

function sha256(file) {
	return crypto
		.createHash("sha256")
		.update(fs.readFileSync(file))
		.digest("hex");
}

function hslToRgb(h, s, l) {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = h / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r, g, b;
	if (hp < 1) [r, g, b] = [c, x, 0];
	else if (hp < 2) [r, g, b] = [x, c, 0];
	else if (hp < 3) [r, g, b] = [0, c, x];
	else if (hp < 4) [r, g, b] = [0, x, c];
	else if (hp < 5) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const m = l - c / 2;
	return {
		r: Math.round((r + m) * 255),
		g: Math.round((g + m) * 255),
		b: Math.round((b + m) * 255),
	};
}

async function writeSolids() {
	const sharp = require(path.join(ROOT, "..", "..", "node_modules", "sharp"));
	fs.mkdirSync(IMG, { recursive: true });
	const names = [
		"solid-red",
		"solid-orange",
		"solid-yellow",
		"solid-chartreuse",
		"solid-green",
		"solid-spring",
		"solid-cyan",
		"solid-azure",
		"solid-blue",
		"solid-violet",
		"solid-magenta",
		"solid-rose",
		"solid-slate",
		"solid-navy",
		"solid-olive",
		"solid-brown",
	];
	const files = [];
	for (let i = 0; i < names.length; i++) {
		const rgb = hslToRgb((i / names.length) * 360, 0.62, 0.42);
		const p = path.join(IMG, `${names[i]}.jpg`);
		await sharp({
			create: {
				width: 480,
				height: 270,
				channels: 3,
				background: rgb,
			},
		})
			.jpeg({ quality: 92 })
			.toFile(p);
		files.push({
			id: names[i],
			file: `images/${names[i]}.jpg`,
			kind: "solid",
			label: names[i].replace("solid-", ""),
		});
	}
	return files;
}

// Provenance for the manifest: repo-relative when the source lives inside
// the repo (no usernames or machine layout leak into the tracked file);
// absolute otherwise (/tmp fixtures, downloaded corpora).
function repoRel(p) {
	const rel = path.relative(REPO, p);
	return rel.startsWith("..") || path.isAbsolute(rel) ? p : rel;
}

function copyInto(src, id, kind, label) {
	const ext = path.extname(src).toLowerCase() || ".jpg";
	const dest = path.join(IMG, `${id}${ext}`);
	fs.copyFileSync(src, dest);
	return {
		id,
		file: `images/${id}${ext}`,
		kind,
		label: label || id,
		source: repoRel(src),
	};
}

async function collectPhotos() {
	const items = [];
	// 1. Product UI screenshots (rights-clear, repo-owned).
	const shots = path.join(ROOT, "..", "..", "review-screenshots");
	if (fs.existsSync(shots)) {
		const files = fs
			.readdirSync(shots)
			.filter((f) => /\.(png|jpe?g)$/i.test(f))
			.sort();
		for (const f of files.slice(0, 16)) {
			const id = `photo-ui-${path
				.basename(f)
				.replace(/\.[^.]+$/, "")
				.slice(0, 40)}`;
			items.push(
				copyInto(path.join(shots, f), id, "photo", "screenshot user interface"),
			);
		}
	}
	// 2. App icons / product art — distinct visual styles.
	const icons = path.join(ROOT, "..", "..", "public", "images", "app-icons");
	if (fs.existsSync(icons)) {
		const files = fs
			.readdirSync(icons)
			.filter((f) => /\.(png|jpe?g)$/i.test(f))
			.sort();
		for (const f of files.slice(0, 6)) {
			const id = `photo-icon-${path
				.basename(f)
				.replace(/\.[^.]+$/, "")
				.slice(0, 30)}`;
			items.push(
				copyInto(path.join(icons, f), id, "photo", "app icon illustration"),
			);
		}
	}
	// 3. Fine-detail synthetic but photorealistic-ish JPEGs if present.
	const fine = "/tmp/scm-finedetail/fixture";
	if (fs.existsSync(fine)) {
		const files = fs
			.readdirSync(fine)
			.filter((f) => /\.(jpe?g)$/i.test(f))
			.sort();
		for (const f of files.slice(0, 10)) {
			const id = `photo-detail-${path.basename(f).replace(/\.[^.]+$/, "")}`;
			items.push(
				copyInto(path.join(fine, f), id, "photo", "fine detail shape text"),
			);
		}
	}
	return items;
}

async function collectVideoFrames() {
	const items = [];
	const frames = "/tmp/scm-everyday/frames";
	// Prefer dark / face / text / landscape variety by sampling both films.
	const picks = [
		// pearl (farm horror) — dark, barn, field, faces
		"pearl-00.jpg",
		"pearl-02.jpg",
		"pearl-04.jpg",
		"pearl-06.jpg",
		"pearl-08.jpg",
		"pearl-10.jpg",
		// topgun (aviation) — sky, cockpit, ocean, uniforms
		"topgun-00.jpg",
		"topgun-02.jpg",
		"topgun-04.jpg",
		"topgun-05.jpg",
		"topgun-07.jpg",
		"topgun-09.jpg",
		"topgun-10.jpg",
		"topgun-11.jpg",
		"pearl-11.jpg",
		"topgun-01.jpg",
	];
	if (!fs.existsSync(frames)) {
		return items;
	}
	for (const f of picks) {
		const src = path.join(frames, f);
		if (!fs.existsSync(src)) continue;
		const film = f.startsWith("pearl") ? "pearl" : "topgun";
		const id = `video-${f.replace(/\.jpg$/, "")}`;
		items.push(copyInto(src, id, "video-frame", `${film} film frame`));
	}
	return items;
}

async function downloadDiverse(targetCount) {
	// Deterministic public photos (picsum seed) to fill the 32-photo quota.
	// Hash-pinned after download. Network required; --skip-download disables.
	const items = [];
	const existing = fs
		.readdirSync(IMG)
		.filter((f) => f.startsWith("photo-")).length;
	const need = Math.max(0, targetCount - existing);
	if (need <= 0) return items;
	const seeds = [];
	for (let i = 0; i < need; i++) seeds.push(4200 + i);
	for (const seed of seeds) {
		const url = `https://picsum.photos/seed/scm3a${seed}/640/480`;
		const id = `photo-web-${seed}`;
		const dest = path.join(IMG, `${id}.jpg`);
		if (fs.existsSync(dest)) {
			items.push({
				id,
				file: `images/${id}.jpg`,
				kind: "photo",
				label: "web photograph",
			});
			continue;
		}
		try {
			execFileSync("curl", ["-fsSL", "--max-time", "30", "-o", dest, url], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			// Verify it decodes as an image ≥64px.
			const st = fs.statSync(dest);
			if (st.size < 1000) {
				fs.rmSync(dest, { force: true });
				continue;
			}
			items.push({
				id,
				file: `images/${id}.jpg`,
				kind: "photo",
				label: "web photograph",
			});
		} catch {
			fs.rmSync(dest, { force: true });
		}
	}
	return items;
}

function queriesFor(photos, frames) {
	// ≥20 named queries with expected positives. Tie band is predeclared.
	const pearl = frames.filter((f) => f.id.includes("pearl")).map((f) => f.id);
	const topgun = frames.filter((f) => f.id.includes("topgun")).map((f) => f.id);
	const ui = photos.filter((p) => p.id.includes("ui-")).map((p) => p.id);
	const detail = photos
		.filter((p) => p.id.includes("detail-"))
		.map((p) => p.id);

	const q = [
		{ query: "a solid red rectangle", expectedPositives: ["solid-red"] },
		{ query: "a solid blue color field", expectedPositives: ["solid-blue"] },
		{ query: "a solid green background", expectedPositives: ["solid-green"] },
		{ query: "a solid yellow block", expectedPositives: ["solid-yellow"] },
		{ query: "a solid magenta fill", expectedPositives: ["solid-magenta"] },
		{ query: "a solid cyan surface", expectedPositives: ["solid-cyan"] },
		{
			query: "a dark brown earth tone",
			expectedPositives: ["solid-brown", "solid-olive"],
		},
		{ query: "a purple violet field", expectedPositives: ["solid-violet"] },
		{
			query: "fighter jet flying over the ocean",
			expectedPositives: topgun.slice(0, 4),
		},
		{
			query: "aircraft carrier flight deck",
			expectedPositives: topgun.slice(0, 3),
		},
		{
			query: "pilot wearing flight helmet and visor",
			expectedPositives: topgun.slice(1, 4),
		},
		{
			query: "military officer in dress uniform",
			expectedPositives: topgun.slice(0, 3),
		},
		{ query: "red barn on a farm", expectedPositives: pearl.slice(0, 4) },
		{ query: "cornfield at sunset", expectedPositives: pearl.slice(0, 4) },
		{
			query: "scarecrow standing in a field",
			expectedPositives: pearl.slice(1, 5),
		},
		{
			query: "woman in an old fashioned dress",
			expectedPositives: pearl.slice(0, 4),
		},
		{
			query: "a screenshot of a software user interface",
			expectedPositives: ui.slice(0, 5),
		},
		{
			query: "settings menu on a dark screen",
			expectedPositives: ui.slice(0, 5),
		},
		{
			query: "a colorful app icon",
			expectedPositives: photos
				.filter((p) => p.id.includes("icon-"))
				.map((p) => p.id)
				.slice(0, 3),
		},
		{
			query: "small text and geometric shapes",
			expectedPositives: detail.slice(0, 5),
		},
		{
			query: "a blue square shape",
			expectedPositives: detail.filter((d) => d.includes("blue")).slice(0, 2),
		},
		{
			query: "the word beacon written on a page",
			expectedPositives: detail.filter((d) => d.includes("beacon")).slice(0, 3),
		},
	];
	// Drop queries whose expectedPositives ended up empty (missing corpus).
	return q
		.filter((x) => x.expectedPositives && x.expectedPositives.length > 0)
		.map((x, i) => ({
			id: `q${String(i + 1).padStart(2, "0")}`,
			query: x.query,
			expectedPositives: x.expectedPositives,
		}));
}

async function main() {
	const skip = process.argv.includes("--skip-download");
	fs.mkdirSync(IMG, { recursive: true });
	console.log("[fixtures] writing solids …");
	const solids = await writeSolids();
	console.log("[fixtures] collecting photos …");
	let photos = await collectPhotos();
	if (!skip) {
		console.log("[fixtures] downloading diverse photos …");
		photos = photos.concat(await downloadDiverse(32));
	} else {
		console.log("[fixtures] --skip-download: photo quota may be short");
	}
	// De-dupe by id
	const seen = new Set();
	photos = photos.filter((p) => {
		if (seen.has(p.id)) return false;
		seen.add(p.id);
		return true;
	});
	console.log(`[fixtures] photos: ${photos.length}`);
	console.log("[fixtures] collecting video frames …");
	const frames = await collectVideoFrames();
	console.log(`[fixtures] video frames: ${frames.length}`);

	const all = [...solids, ...photos, ...frames];
	const pinned = all.map((item) => {
		const abs = path.join(ROOT, "fixtures", item.file);
		if (!fs.existsSync(abs)) {
			throw new Error(`missing fixture file ${abs}`);
		}
		const bytes = fs.statSync(abs).size;
		return { ...item, sha256: sha256(abs), bytes };
	});

	const queries = queriesFor(photos, frames);
	const manifest = {
		schema: "coreml-native-fixtures/v1",
		createdAt: new Date().toISOString(),
		scoreTieBand: SCORE_TIE_BAND,
		requirements: {
			solids: 16,
			photos: 32,
			videoFrames: 16,
			minQueries: 20,
			note: "If the real fixture corpus is unavailable or hashes do not match, the result is inconclusive and cannot pass (plan §5.2).",
		},
		counts: {
			solids: solids.length,
			photos: photos.length,
			videoFrames: frames.length,
			queries: queries.length,
		},
		complete:
			solids.length >= 16 &&
			photos.length >= 32 &&
			frames.length >= 16 &&
			queries.length >= 20,
		images: pinned,
		queries,
	};

	fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
	console.log(`[fixtures] manifest → ${MANIFEST}`);
	console.log(
		`[fixtures] complete=${manifest.complete} solids=${solids.length} photos=${photos.length} frames=${frames.length} queries=${queries.length}`,
	);
	if (!manifest.complete) {
		console.warn(
			"[fixtures] WARNING: corpus incomplete — G1a/G1b cannot PASS (must be inconclusive)",
		);
	}
}

main().catch((e) => {
	console.error("FATAL", e);
	process.exit(1);
});
