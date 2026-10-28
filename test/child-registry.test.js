"use strict";

// Tracked main-process children (architecture audit 2026-10-19).
//
// Asserts the registry owns what it says it owns: a tracked child dies with
// the sweep, a child that exits on its own is released instead of leaking an
// entry, one child can be killed without touching the others, and a child
// that was already dead is never registered. This is the 2026-09-28
// ffmpeg-orphan lesson, applied to the main process's own children.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const {
	trackChild,
	untrackChild,
	killTrackedChild,
	killTrackedChildren,
	trackedChildCount,
	trackedChildLabels,
} = require("../main-lib/child-registry.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Safety net: `bun test <file>` abandons a node-style file's async work, so
// this file can be imported and dropped mid-run. Without the exit sweep the
// spawned sleepers would outlive the test process.
process.on("exit", () => {
	killTrackedChildren("test-exit");
});

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// Await a child's own exit event instead of polling alive(): a SIGKILLed
// child stays a zombie — and answers kill(pid, 0) — until Node reaps it, so
// under the directory run's loaded event loop a wall-clock poll can expire
// before the reap (the 2026-10-27 CI flake, and the 2026-10-28 battery
// repeat on the sweep assertion). The kill → listener-attach window below
// holds no await, so the exit macrotask cannot slip past the listener.
function exitWithin(child, label, ms = 15000) {
	const exit = new Promise((resolve) => child.once("exit", resolve));
	return Promise.race([
		exit,
		sleep(ms).then(() => {
			throw new Error(`${label} did not exit within ${ms} ms`);
		}),
	]);
}

// A child that stays alive until it is killed.
function spawnSleeper() {
	return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
	});
}

(async () => {
	assert.equal(trackedChildCount(), 0, "registry starts empty");

	// A live child is tracked...
	const first = spawnSleeper();
	const firstId = trackChild(first, "first");
	assert.ok(firstId !== null, "a live child is tracked");
	assert.equal(trackedChildCount(), 1);
	assert.deepEqual(trackedChildLabels(), ["first"]);

	// ...and the sweep kills it.
	assert.equal(killTrackedChildren("test"), 1);
	assert.equal(trackedChildCount(), 0, "the sweep empties the registry");
	await exitWithin(first, "the tracked child");

	// A child that exits on its own is released (no registry leak). Await the
	// child's own exit event via exitWithin (the directory run shares one
	// process with every other file — see the helper note above).
	const second = spawnSleeper();
	trackChild(second, "second");
	assert.equal(trackedChildCount(), 1);
	second.kill("SIGKILL");
	await exitWithin(second, "a self-exiting child");
	assert.equal(trackedChildCount(), 0, "a self-exiting child is untracked");

	// One child can be killed without touching the others.
	const a = spawnSleeper();
	const b = spawnSleeper();
	const aId = trackChild(a, "a");
	trackChild(b, "b");
	assert.equal(trackedChildCount(), 2);
	assert.equal(killTrackedChild(aId), true);
	assert.equal(trackedChildCount(), 1);
	assert.deepEqual(trackedChildLabels(), ["b"]);
	await exitWithin(a, "the targeted child");
	assert.equal(alive(b.pid), true, "the other child is untouched");
	assert.equal(killTrackedChildren("test"), 1);
	await exitWithin(b, "the swept child");

	// An already-dead child is never registered (its exit event already
	// fired, so the registry would have leaked the entry).
	const dead = spawnSleeper();
	dead.kill("SIGKILL");
	await sleep(250);
	assert.equal(trackChild(dead, "dead"), null, "a dead child is not tracked");
	assert.equal(trackedChildCount(), 0, "no entry leaked");

	// Untracking is idempotent and never throws.
	untrackChild(123456);
	assert.equal(killTrackedChild(null), false);
	assert.equal(killTrackedChild(123456), false);
	assert.equal(trackedChildCount(), 0);

	console.log("child-registry: all assertions passed");
})().catch((err) => {
	console.error(err);
	// exitCode, not exit: bun directory mode dies on any process.exit
	process.exitCode = 1;
	// Thrown so bun's directory run counts the failure (it ignores exitCode).
	throw err;
});
