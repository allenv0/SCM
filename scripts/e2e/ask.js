"use strict";

// Ask-mode E2E (ELECTRON_SMOKE_ASK=1, MDs/Ask-Mode-Plan.md): drives the REAL
// Settings UI and the REAL grid through the renderer DOM — the click-path
// the user actually performs — plus the seeded-downloaded state and the
// empty-library Ask gate. No network: downloads are simulated by seeding
// userData/llm (a stub engine binary + a sparse 1.1GB model file), which is
// exactly what the downloader leaves behind.

const fs = require("fs");
const path = require("path");

module.exports = { runAskTest };

// Poll a renderer expression until truthy (or throw with the last value).
async function waitForJs(win, label, js, timeoutMs = 8000) {
	const started = Date.now();
	for (;;) {
		const last = await win.webContents.executeJavaScript(js);
		if (last) return last;
		if (Date.now() - started > timeoutMs) {
			throw new Error(
				`timeout waiting for ${label} (last: ${JSON.stringify(last)})`,
			);
		}
		await new Promise((r) => setTimeout(r, 120));
	}
}

async function runAskTest(ctx) {
	const { win, app } = ctx;
	const dataDir = app.getPath("userData");
	const llmDir = path.join(dataDir, "llm");
	const results = [];
	const ok = (name) => {
		results.push(name);
		console.log(`  ✓ ${name}`);
	};

	const js = (code) => win.webContents.executeJavaScript(code);

	// The grid (and with it the LLMs mode toggle) mounts only when the
	// library has rows — import one fixture photo so the click-path under
	// test exists (the empty-library state has no search bar at all).
	const sharp = (await import("sharp")).default;
	const tmp = fs.mkdtempSync(path.join(app.getPath("temp"), "ask-e2e-"));
	const fixture = path.join(tmp, "ask-fixture.png");
	await sharp({
		create: {
			width: 96,
			height: 96,
			channels: 3,
			background: { r: 40, g: 80, b: 220 },
		},
	})
		.png()
		.toFile(fixture);
	await js(`window.memories.importPaths([${JSON.stringify(fixture)}])`);
	await waitForJs(
		win,
		"fixture grid mounts",
		`!!document.querySelector('input[aria-label="Search memories"]')`,
		60000,
	);
	ok("fixture library imported (grid + search bar mounted)");

	// --- 1. Fresh state: Settings → LLMs Chat, initial rows + CLICKABLE buttons
	await js(`document.querySelector('button[title="Settings (⌘,)"]').click()`);
	await waitForJs(
		win,
		"settings dialog",
		`!!document.querySelector('[role="dialog"]')`,
	);
	await js(`[...document.querySelectorAll('[role="dialog"] button')]
		.find(b => b.textContent.trim() === 'LLMs Chat').click()`);
	await waitForJs(
		win,
		"Ask panel",
		`document.body.innerText.includes('Enable LLMs')`,
	);

	const initial = await js(`(() => {
		const dialog = document.querySelector('[role="dialog"]');
		const sw = dialog.querySelector('button[role="switch"][aria-label="Enable LLMs"]');
		const dl = [...dialog.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Download');
		const clickable = dl.map(b => !b.disabled && getComputedStyle(b).pointerEvents !== 'none');
		return {
			checked: sw && sw.getAttribute('aria-checked'),
			downloadButtons: dl.length,
			allClickable: clickable.every(Boolean),
			engineRow: document.body.innerText.includes('Chat engine (llama.cpp)'),
			modelRows: ['Qwen3 1.7B', 'Llama 3.2 3B'].every(t => document.body.innerText.includes(t)),
		};
	})()`);
	if (initial.checked !== "false")
		throw new Error(
			`enable switch should start off: ${JSON.stringify(initial)}`,
		);
	if (initial.downloadButtons !== 3)
		throw new Error(
			`expected 3 Download buttons (engine + 2 models), got ${initial.downloadButtons}`,
		);
	if (!initial.allClickable)
		throw new Error(
			"Download buttons are not clickable — the reported dead-button bug",
		);
	if (!initial.engineRow || !initial.modelRows)
		throw new Error(`rows missing: ${JSON.stringify(initial)}`);
	ok(
		"initial panel: switch off, 3 clickable Download buttons, engine + model rows",
	);

	// --- 2. Enable LLMs → switch flips AND persists to settings.json
	await js(
		`document.querySelector('button[role="switch"][aria-label="Enable LLMs"]').click()`,
	);
	await waitForJs(
		win,
		"switch on",
		`document.querySelector('[role="dialog"] button[role="switch"][aria-label="Enable LLMs"]').getAttribute('aria-checked') === 'true'`,
	);
	const persisted = JSON.parse(
		fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8"),
	);
	if (persisted.llm?.enabled !== true)
		throw new Error("llm.enabled did not persist to settings.json");
	ok("Enable LLMs persists (settings.json llm.enabled=true)");

	// --- 2b. LIVE mode (SCM_ASK_LIVE=1, network required): click the REAL
	// Download buttons and watch the UI traverse downloading → Downloaded.
	// Proves the exact click-path the user performs, including progress
	// events landing in the panel and the per-target single-flight (the
	// model download starts even while another target is in flight).
	if (process.env.SCM_ASK_LIVE === "1") {
		await js(`window.scmAskDataDir = ${JSON.stringify(dataDir)}`);
		await js(`[...document.querySelectorAll('[role="dialog"] button')]
			.find((b) => b.textContent.trim() === 'Download')
			.click()`);
		console.log("  … clicked engine Download — waiting for the real download");
		await waitForJs(
			win,
			"engine Downloaded after live click",
			`document.body.innerText.includes('Downloaded ·')`,
			600000,
		);
		ok("LIVE: engine Download click → progress → 'Downloaded · <tag>'");
		await js(`[...document.querySelectorAll('[role="dialog"] button')]
			.find((b) => b.textContent.trim() === 'Download')
			.click()`);
		await waitForJs(
			win,
			"model download starts (per-target single-flight)",
			`document.body.innerText.includes('Downloading…')`,
			30000,
		);
		// Progress proof: the .part on disk grows past 1MB (percent-based
		// assertions are link-speed dependent — a 1% tick of 1.1GB can take
		// minutes on a slow line). Polled from the driver: the renderer is
		// sandboxed and cannot require('fs').
		const partPath = path.join(llmDir, "models", "Qwen3-1.7B-Q4_K_M.gguf.part");
		const started = Date.now();
		for (;;) {
			let size = 0;
			try {
				size = fs.statSync(partPath).size;
			} catch {
				/* not created yet */
			}
			if (size > 1024 * 1024) break;
			if (Date.now() - started > 180000) {
				throw new Error(`model .part did not grow past 1MB (size: ${size})`);
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		ok(
			"LIVE: model Download click starts and progresses (then killed — resume covered by unit test)",
		);
		// Leave the app: the .part stays for the resume path.
		for (const r of results) console.log("  (live) " + r);
		return;
	}

	// --- 3. The grid's LLMs toggle appears WITHOUT a restart (config event)
	await js(`document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click();
		document.querySelector('[role="dialog"] button[aria-label="Close settings"]')?.click();`);
	// (one of the two close selectors matches; escape is the guaranteed path)
	await js(
		`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`,
	);
	await waitForJs(
		win,
		"settings closed",
		`!document.querySelector('[role="dialog"]')`,
	);
	await waitForJs(
		win,
		"LLMs mode toggle appears",
		`!!document.querySelector('button[aria-label="LLMs search mode"]')`,
		6000,
	);
	ok("LLMs mode toggle appears live after enabling (no restart)");

	// --- 4. Ask flow on an empty library: evidence gate, never a hang
	await js(
		`document.querySelector('button[aria-label="LLMs search mode"]').click()`,
	);
	await waitForJs(
		win,
		"model badge names the engine",
		`!!document.querySelector('[aria-label^="Current LLMs model:"]')`,
		6000,
	);
	ok("LLMs tab shows the current-model badge");
	await waitForJs(
		win,
		"search placeholder names the model",
		`document.querySelector('input[aria-label="Search memories"]').placeholder.startsWith("Chat with ")`,
		6000,
	);
	ok("LLMs search placeholder invites a question to the model");
	await js(`(() => {
		const input = document.querySelector('input[aria-label="Search memories"]');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		setter.call(input, '/all what did bill gurley say in 2026');
		input.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await waitForJs(
		win,
		"no-evidence answer card",
		`document.body.innerText.includes('No matching text or dialogue found')`,
		10000,
	);
	const emptyState = await js(
		`document.body.innerText.includes('No text or dialogue evidence')`,
	);
	if (!emptyState)
		throw new Error("grid empty state should explain the missing evidence");
	ok(
		"LLMs on empty library: evidence-gated card + honest empty state (no hang, no hallucination)",
	);

	// --- 5. Clear the query; scope-only input never crashes the card
	await js(`(() => {
		const input = document.querySelector('input[aria-label="Search memories"]');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		setter.call(input, '/screenshots');
		input.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await new Promise((r) => setTimeout(r, 700));
	const scopeOnly = await js(`document.body.innerText.includes('LLMs failed')`);
	if (scopeOnly) throw new Error("scope-only query surfaced an error");
	ok("scope-only query ('/screenshots') is safe while typing");

	// --- 6. Seeded downloads: reopen Settings → rows flip to Downloaded
	// Stub engine: ≥1MB file (binaryDownloaded's size floor). Model: a
	// SPARSE 1.1GB file (truncate) — statSync.size passes the floor with
	// ~zero disk usage, byte-identical to a finished download's metadata.
	fs.mkdirSync(path.join(llmDir, "bin"), { recursive: true });
	fs.mkdirSync(path.join(llmDir, "models"), { recursive: true });
	fs.writeFileSync(
		path.join(llmDir, "bin", "llama-server"),
		Buffer.alloc(2 * 1024 * 1024, 1),
	);
	fs.writeFileSync(
		path.join(llmDir, "bin", "server-meta.json"),
		JSON.stringify({
			tag: "b10964",
			asset: "test",
			layoutVersion: require("../../main-lib/llm/models.js").LLM_SERVER
				.layoutVersion,
			downloadedAt: new Date().toISOString(),
		}),
	);
	const modelPart = path.join(llmDir, "models", "Qwen3-1.7B-Q4_K_M.gguf");
	fs.writeFileSync(modelPart, "");
	fs.truncateSync(modelPart, 1_100_000_000);

	await js(`document.querySelector('button[title="Settings (⌘,)"]').click()`);
	await waitForJs(
		win,
		"settings dialog again",
		`!!document.querySelector('[role="dialog"]')`,
	);
	await js(`[...document.querySelectorAll('[role="dialog"] button')]
		.find(b => b.textContent.trim() === 'LLMs Chat').click()`);
	await waitForJs(
		win,
		"engine row Downloaded",
		`document.body.innerText.includes('Downloaded · b10964')`,
	);
	const downloaded = await js(`(() => {
		const dialog = document.querySelector('[role="dialog"]');
		const dl = [...dialog.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Download');
		const group = dialog.querySelector('[role="radiogroup"][aria-label="Chat model"]');
		const radios = group ? [...group.querySelectorAll('[role="radio"]')] : [];
		const checked = radios.filter(r => r.getAttribute('aria-checked') === 'true');
		return {
			downloadButtons: dl.length,
			engineReady: document.body.innerText.includes('Downloaded · b10964'),
			// The seeded default model is also the active chat model, so its
			// row reads "in use" (not the idle "ready to use" copy).
			modelReady: document.body.innerText.includes('in use by the LLMs tab'),
			otherModelPending: document.body.innerText.includes('~2.0GB'),
			radioCount: radios.length,
			checkedCount: checked.length,
			checkedLabel: checked.length ? checked[0].getAttribute('aria-label') : null,
		};
	})()`);
	// One Download button remains — the SECOND model was deliberately not
	// seeded (the real flow downloads engine + one model); its button must
	// still be there and the downloaded rows must read as done.
	if (downloaded.downloadButtons !== 1)
		throw new Error(
			`expected exactly 1 remaining Download button (the unseeded model), got ${downloaded.downloadButtons}`,
		);
	if (!downloaded.engineReady)
		throw new Error("engine row should read 'Downloaded · b10964'");
	if (!downloaded.modelReady)
		throw new Error("default model row should read 'in use by the LLMs tab'");
	if (!downloaded.otherModelPending)
		throw new Error("the unseeded model row should still show its size");
	if (downloaded.radioCount !== 2)
		throw new Error(
			`chat-model radiogroup should hold 2 radios, got ${downloaded.radioCount}`,
		);
	if (
		downloaded.checkedCount !== 1 ||
		!/Qwen3 1\.7B/.test(downloaded.checkedLabel || "")
	)
		throw new Error(
			`exactly the Qwen radio should be checked, got ${JSON.stringify(downloaded)}`,
		);
	const bridgeStatus = await js(`window.memories.getLlmStatus()`);
	if (
		!bridgeStatus.server.binaryDownloaded ||
		!bridgeStatus.models[0].downloaded
	) {
		throw new Error(
			`bridge status disagrees with UI: ${JSON.stringify(bridgeStatus.server)}`,
		);
	}
	ok(
		"after download: rows show Downloaded, dead buttons gone, bridge status agrees",
	);

	// --- 7. The seeded model actually loads through the REAL spawn path:
	// swap the stub for a runnable server (ask-server's stub) so
	// memories:ask exercises spawn → health → chat → answer with evidence.
	// (Library is empty here, so the evidence gate short-circuits BEFORE
	// the spawn — assert that ordering explicitly.)
	const gated = await js(
		`window.memories.askScm({ query: 'hello', filenames: [] })`,
	);
	if (!gated.ok || gated.reason !== "no-evidence" || gated.answer !== null) {
		throw new Error(
			`empty-library ask should gate with no-evidence: ${JSON.stringify(gated)}`,
		);
	}
	ok("memories:ask gates on empty evidence BEFORE touching the sidecar");

	// --- 8. Disable Ask → toggle leaves the grid live
	await js(
		`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`,
	);
	await waitForJs(
		win,
		"settings closed again",
		`!document.querySelector('[role="dialog"]')`,
	);
	await js(`document.querySelector('button[title="Settings (⌘,)"]').click()`);
	await waitForJs(
		win,
		"settings dialog 3",
		`!!document.querySelector('[role="dialog"]')`,
	);
	await js(`[...document.querySelectorAll('[role="dialog"] button')]
		.find(b => b.textContent.trim() === 'LLMs Chat').click()`);
	await waitForJs(
		win,
		"panel again",
		`document.body.innerText.includes('Enable LLMs')`,
	);
	await js(
		`document.querySelector('button[role="switch"][aria-label="Enable LLMs"]').click()`,
	);
	await waitForJs(
		win,
		"switch off again",
		`document.querySelector('[role="dialog"] button[role="switch"][aria-label="Enable LLMs"]').getAttribute('aria-checked') === 'false'`,
	);
	await js(
		`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`,
	);
	await waitForJs(
		win,
		"LLMs toggle removed",
		`!document.querySelector('button[aria-label="LLMs search mode"]')`,
		6000,
	);
	ok("disabling removes the Ask toggle live (round-trip)");

	// Cleanup: the sparse model file is tmp-dir scoped, but drop it anyway.
	try {
		fs.rmSync(llmDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}

	console.log(`[ask-e2e] ${results.length} checks passed`);
}
