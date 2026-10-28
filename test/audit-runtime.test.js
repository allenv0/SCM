"use strict";

// The audit gate must never confuse "the audit service is down" with "the
// audit found nothing". These tests pin the split: a parseable report is
// authoritative even when `bun audit` exits non-zero (its advisories-found
// code), while missing/malformed output is an infrastructure failure that is
// retried and then fails closed. Dependency classification is also fail
// closed: if `bun pm why` cannot prove dev-only, the package gates.

const assert = require("node:assert/strict");
const { test } = require("bun:test");
const core = require("../scripts/audit-runtime-core.js");

function auditResult(overrides = {}) {
	return {
		status: 0,
		signal: null,
		error: null,
		stdout: "",
		stderr: "",
		...overrides,
	};
}

test("audit retries infrastructure failures and succeeds on a later attempt", () => {
	const attempts = [
		auditResult({ status: 1, stdout: "", stderr: "network unreachable" }),
		auditResult({ status: null, signal: "SIGTERM", stdout: "" }),
		auditResult({
			status: 1,
			stdout: '{"sharp":[{"severity":"high","title":"bad"}]}',
		}),
	];
	let calls = 0;
	const sleeps = [];
	const outcome = core.runAuditWithRetries({
		runBun: () => attempts[calls++],
		sleepSync: (ms) => sleeps.push(ms),
	});
	assert.equal(calls, 3);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.attempts, 3);
	assert.deepEqual(sleeps, core.AUDIT_BACKOFF_MS);
});

test("a parseable advisory report is not retried despite its non-zero exit", () => {
	let calls = 0;
	const outcome = core.runAuditWithRetries({
		runBun: () => {
			calls++;
			return auditResult({
				status: 1,
				stdout: '{"prod":[{"severity":"critical","title":"bad"}]}',
			});
		},
		sleepSync: () => {
			throw new Error("advisory results must not sleep/retry");
		},
	});
	assert.equal(calls, 1);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.report.prod[0].severity, "critical");
});

test("audit fails closed after repeated malformed output", () => {
	let calls = 0;
	const sleeps = [];
	const outcome = core.runAuditWithRetries({
		runBun: () => {
			calls++;
			return auditResult({ status: 0, stdout: "registry exploded" });
		},
		sleepSync: (ms) => sleeps.push(ms),
	});
	assert.equal(calls, core.AUDIT_ATTEMPTS);
	assert.equal(outcome.ok, false);
	assert.equal(outcome.errors.length, core.AUDIT_ATTEMPTS);
	assert.match(outcome.errors[0].reason, /non-JSON/);
	assert.deepEqual(sleeps, core.AUDIT_BACKOFF_MS);
});

test("audit report shape is validated before it is trusted", () => {
	assert.match(core.validateAuditReport([]), /not a JSON object/);
	assert.match(core.validateAuditReport({ sharp: {} }), /not an array/);
	assert.match(core.validateAuditReport({ sharp: [{ id: 1 }] }), /no severity/);
	assert.equal(core.validateAuditReport({}), null);
	assert.equal(
		core.validateAuditReport({ sharp: [{ severity: "high" }] }),
		null,
	);
});

test("only production high/critical advisories gate", () => {
	const report = {
		prod: [
			{ severity: "HIGH", title: "prod high" },
			{ severity: "low", title: "prod low" },
		],
		dev: [{ severity: "critical", title: "dev critical" }],
	};
	const failures = core.classifyFailures(report, (pkg) => pkg === "prod");
	assert.equal(failures.length, 1);
	assert.equal(failures[0].pkg, "prod");
	assert.equal(failures[0].severity, "HIGH");
	assert.equal(failures[0].title, "prod high");
});

test("dependency classification is fail closed", () => {
	const roots = new Set(["memories"]);
	const runBun = (args) => {
		const pkg = args[args.length - 1];
		if (pkg === "prod-pkg") {
			return auditResult({ stdout: "  ├─ memories (requires 1.0.0)\n" });
		}
		if (pkg === "dev-pkg") {
			return auditResult({
				// Real `pm why` output can nest the root behind tree characters;
				// the classifier must not depend on tree depth.
				stdout: "        │  └─ dev memories (requires ^1.0.0)\n",
			});
		}
		// A future `pm why` format this gate does not understand.
		return auditResult({ stdout: "unrecognized output\n" });
	};
	assert.equal(
		core.isProductionDependency("prod-pkg", { runBun, rootNames: roots }),
		true,
	);
	assert.equal(
		core.isProductionDependency("dev-pkg", { runBun, rootNames: roots }),
		false,
	);
	assert.equal(
		core.isProductionDependency("unknown-format", { runBun, rootNames: roots }),
		true,
		"unclassifiable output must gate, not disappear",
	);
	assert.equal(
		core.isProductionDependency("electron", {
			runBun: () => {
				throw new Error("runtime-always packages need no pm why");
			},
			rootNames: roots,
		}),
		true,
	);
});

test("the lockfile workspace name is a recognized dependency root", () => {
	assert.ok(core.readRootNames().has("memories"));
});
