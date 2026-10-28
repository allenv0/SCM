"use strict";

// CLI wrapper for the production-only audit gate. The retry/report-shape/
// classification rules live in ./audit-runtime-core.js (unit-tested); this
// file only wires them to Bun and maps the outcome to an exit code.
//
// `bun audit` exits non-zero when it *finds* advisories, so a non-zero status
// is not by itself an infrastructure failure. The core treats only missing or
// malformed JSON as an audit-service failure, retries it, and fails closed
// when the service stays unavailable.

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const core = require("./audit-runtime-core.js");

const ROOT = path.join(__dirname, "..");
const MAX_BUFFER = 32 * 1024 * 1024;

// The gate runs through `bun run` in dev and CI. If someone invokes it with
// plain node, fall back to the Bun on PATH rather than asking node to run
// Bun's `audit` subcommand.
function bunBinary() {
	return process.versions.bun ? process.execPath : "bun";
}

function runBun(args) {
	return spawnSync(bunBinary(), args, {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		timeout: core.AUDIT_TIMEOUT_MS,
	});
}

function main() {
	const outcome = core.runAuditWithRetries({ runBun });
	if (!outcome.ok) {
		for (const [index, error] of outcome.errors.entries()) {
			console.error(
				`[audit-runtime] attempt ${index + 1}/${outcome.attempts}: ${error.reason}` +
					(error.detail ? ` (${error.detail})` : ""),
			);
		}
		console.error(
			"[audit-runtime] audit service unavailable after retries — failing closed",
		);
		process.exitCode = 1;
		return;
	}

	const rootNames = core.readRootNames();
	const failures = core.classifyFailures(outcome.report, (pkg) =>
		core.isProductionDependency(pkg, { runBun, rootNames }),
	);

	if (failures.length === 0) {
		console.log(
			"[audit-runtime] OK — no high/critical advisories in runtime deps",
		);
		return;
	}

	for (const failure of failures) {
		console.error(
			`[audit-runtime] ${failure.severity} ${failure.pkg}: ${failure.title}` +
				(failure.url ? ` (${failure.url})` : ""),
		);
	}
	process.exitCode = 1;
}

main();
