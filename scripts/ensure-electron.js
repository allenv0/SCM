"use strict";

// Bun can update the electron package without running its postinstall in an
// existing node_modules tree, leaving `electron/dist` absent. The build then
// fails at electron-builder's `electronDist` check. Make the install step
// self-healing: only download when the runtime is actually missing.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const electronDir = path.join(__dirname, "..", "node_modules", "electron");
const dist = path.join(electronDir, "dist");
const pathFile = path.join(electronDir, "path.txt");
const installer = path.join(electronDir, "install.js");

if (fs.existsSync(dist) && fs.existsSync(pathFile)) {
	process.exit(0);
}
if (!fs.existsSync(electronDir)) {
	// Production-only installs omit devDependencies; nothing to prepare.
	process.exit(0);
}
if (!fs.existsSync(installer)) {
	console.error(
		"[ensure-electron] electron package is incomplete; run `bun install` first",
	);
	process.exit(1);
}
console.log("[ensure-electron] electron/dist missing; downloading runtime…");
const result = spawnSync(process.execPath, [installer], { stdio: "inherit" });
process.exit(result.status ?? 1);
