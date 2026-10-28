"use strict";

// Core for the production audit gate (scripts/audit-runtime.js), split out so
// the retry/report-shape/production-classification rules are unit-testable
// without touching the audit service.
//
// `bun audit` exits non-zero whenever it *reports* advisories, so exit status
// alone cannot distinguish "vulnerabilities found" from "audit unavailable".
// The contract used here is deliberately strict:
//   * a parseable report is the authoritative audit result, even when the
//     command exited non-zero (that is the advisories-found exit code);
//   * empty / non-JSON / malformed output is an infrastructure failure and is
//     retried, then fails closed;
//   * if `bun pm why` cannot prove a gated package is dev-only, the package
//     is treated as production (fail closed), never silently ignored.

const fs = require("node:fs");
const path = require("node:path");

// Total attempts, then ~0.5s + ~1.5s of backoff. Long enough to survive a
// brief registry hiccup, short enough not to turn a dead endpoint into a
// multi-minute CI hang.
const AUDIT_ATTEMPTS = 3;
const AUDIT_BACKOFF_MS = [500, 1500];
const AUDIT_TIMEOUT_MS = 45_000;
// These ship as runtime binaries even though npm labels them devDependencies:
// Electron is the app runtime, and ffmpeg-static's binary is copied to
// Contents/Resources/ffmpeg by build.extraResources.
const RUNTIME_ALWAYS = new Set(["electron", "ffmpeg-static"]);
const GATE_SEVERITIES = new Set(["high", "critical"]);
const ROOT = path.join(__dirname, "..");

// Synchronous sleep for a synchronous CLI. Atomics.wait is the portable way
// to pause without spawning a helper process.
function sleepSync(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return;
	const signal = new Int32Array(new SharedArrayBuffer(4));
	try {
		Atomics.wait(signal, 0, 0, ms);
	} catch {
		// Some embedding hosts refuse Atomics.wait. A bounded busy wait is the
		// last-resort fallback; this path is not expected in CLI/CI runs.
		const end = Date.now() + ms;
		while (Date.now() < end) {
			/* spin */
		}
	}
}

// Collapse command output to one bounded, ANSI-free line for error context.
function oneLineDetail(value, max = 240) {
	if (!value) return "";
	return (
		String(value)
			// eslint-disable-next-line no-control-regex -- the purpose is stripping ANSI escapes
			.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.join(" | ")
			.slice(0, max)
	);
}

function spawnFailureDetail(result) {
	const parts = [];
	if (result.error) parts.push(`spawn failed: ${result.error.message}`);
	else if (result.signal) parts.push(`terminated by ${result.signal}`);
	else parts.push(`exit ${result.status}`);
	const stderr = oneLineDetail(result.stderr);
	if (stderr) parts.push(stderr);
	return parts.join("; ");
}

// Strict report shape: a package-keyed object of advisory arrays. Future Bun
// versions may add fields; missing *known* fields is fine, but a report we
// cannot understand is an infrastructure failure, not a clean audit.
function validateAuditReport(report) {
	if (!report || typeof report !== "object" || Array.isArray(report)) {
		return "report is not a JSON object";
	}
	for (const [pkg, advisories] of Object.entries(report)) {
		if (!Array.isArray(advisories)) {
			return `${pkg}: advisories value is not an array`;
		}
		for (let i = 0; i < advisories.length; i++) {
			const advisory = advisories[i];
			if (
				!advisory ||
				typeof advisory !== "object" ||
				Array.isArray(advisory)
			) {
				return `${pkg}[${i}]: advisory is not an object`;
			}
			if (typeof advisory.severity !== "string") {
				return `${pkg}[${i}]: advisory has no severity`;
			}
		}
	}
	return null;
}

function runAuditAttempt(runBun) {
	const result = runBun(["audit", "--json"]);
	const raw = typeof result.stdout === "string" ? result.stdout.trim() : "";
	if (!raw) {
		return {
			ok: false,
			reason: "bun audit produced no JSON output",
			detail: spawnFailureDetail(result),
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return {
			ok: false,
			reason: "bun audit emitted non-JSON output",
			detail: `JSON.parse: ${oneLineDetail(err?.message)}`,
		};
	}
	const shapeError = validateAuditReport(parsed);
	if (shapeError) {
		return {
			ok: false,
			reason: "bun audit emitted an unexpected report shape",
			detail: shapeError,
		};
	}
	return { ok: true, report: parsed };
}

// Retries only infrastructure failures. A parseable report returns on the
// first attempt regardless of exit status — that is how Bun signals
// advisories found, and retrying it would just repeat the same answer.
function runAuditWithRetries({
	runBun,
	attempts = AUDIT_ATTEMPTS,
	backoffMs = AUDIT_BACKOFF_MS,
	sleepSync: sleep = sleepSync,
} = {}) {
	const total =
		Number.isInteger(attempts) && attempts >= 1 ? attempts : AUDIT_ATTEMPTS;
	const errors = [];
	for (let attempt = 1; attempt <= total; attempt++) {
		const result = runAuditAttempt(runBun);
		if (result.ok)
			return { ok: true, report: result.report, attempts: attempt };
		errors.push(result);
		if (attempt < total) {
			const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
			sleep(delay);
		}
	}
	return { ok: false, attempts: total, errors };
}

function classifyFailures(report, isProductionDependency) {
	const failures = [];
	for (const [pkg, advisories] of Object.entries(report)) {
		if (!Array.isArray(advisories)) continue;
		const gated = advisories.filter((advisory) =>
			GATE_SEVERITIES.has(String(advisory?.severity || "").toLowerCase()),
		);
		if (gated.length === 0 || !isProductionDependency(pkg)) continue;
		for (const advisory of gated) {
			failures.push({
				pkg,
				severity: advisory.severity,
				title:
					typeof advisory.title === "string" ? advisory.title : "unspecified",
				url: typeof advisory.url === "string" ? advisory.url : "",
			});
		}
	}
	return failures;
}

// `bun pm why` labels the dependency root with the lockfile workspace name,
// which is not necessarily package.json's current name. Accept both so a
// rename cannot turn every production package into "unclassified".
function readRootNames({ root = ROOT } = {}) {
	const names = new Set();
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		);
		if (typeof pkg.name === "string" && pkg.name) names.add(pkg.name);
	} catch {
		/* package.json is optional for classification */
	}
	try {
		// bun.lock is JSONC (trailing commas), so extract the root workspace's
		// name instead of parsing the whole file.
		const raw = fs.readFileSync(path.join(root, "bun.lock"), "utf8");
		const match = raw.match(
			/"workspaces"\s*:\s*\{[\s\S]{0,500}?"name"\s*:\s*"([^"]+)"/,
		);
		if (match?.[1]) names.add(match[1]);
	} catch {
		/* bun.lock is optional for classification */
	}
	return names;
}

function isProductionDependency(
	pkg,
	{ runBun, rootNames = readRootNames(), runtimeAlways = RUNTIME_ALWAYS } = {},
) {
	if (runtimeAlways.has(pkg)) return true;
	const result = runBun(["pm", "why", pkg]);
	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	if (!stdout.trim()) return true; // cannot prove dev-only — fail closed
	let sawRoot = false;
	for (const line of stdout.split(/\r?\n/)) {
		const marker = line.indexOf(" (requires");
		if (marker === -1) continue;
		// `pm why` nests roots behind box-drawing characters. Strip those
		// rather than matching tree shapes, which change with tree depth.
		const label = line
			.slice(0, marker)
			.trim()
			.replace(/^[│├└─\s]+/, "");
		const isDev = label.startsWith("dev ");
		const name = isDev ? label.slice(4).trim() : label;
		if (!rootNames.has(name)) continue;
		if (isDev) {
			sawRoot = true;
		} else {
			return true;
		}
	}
	// A recognizable dev-only root is the only safe "not production" answer.
	// No recognizable root at all is a format change we do not trust.
	return !sawRoot;
}

module.exports = {
	AUDIT_ATTEMPTS,
	AUDIT_BACKOFF_MS,
	AUDIT_TIMEOUT_MS,
	GATE_SEVERITIES,
	RUNTIME_ALWAYS,
	classifyFailures,
	isProductionDependency,
	readRootNames,
	runAuditAttempt,
	runAuditWithRetries,
	sleepSync,
	validateAuditReport,
};
