"use strict";

// Ask-mode prompt construction (MDs/Ask-Mode-Plan.md): evidence-gated
// answering with mandatory citations. Pure and testable — no model, no IO.
//
// The evidence gate lives upstream (retrieve.js returns empty evidence for a
// query with no textual hits, and the caller skips the LLM entirely); the
// prompt is the second line of defense: the model is told to answer ONLY
// from the numbered excerpts and to say so when they don't contain the
// answer — a fabricated quote is the failure class this bans.

// Numbered evidence block, one line per row. Dialogue rows carry a
// timecode; OCR rows carry the extracted text; keyword rows only prove the
// filename exists.
function formatAskEvidence(evidenceRows) {
	const lines = [];
	let i = 0;
	for (const row of evidenceRows || []) {
		i++;
		if (row.kind === "dialogue") {
			const at = Number.isFinite(row.t) ? formatTimecode(row.t) : "??:??";
			lines.push(
				`[${i}] Spoken in "${row.filename}" at ${at}: "${row.snippet || row.text || ""}"`,
			);
		} else if (row.kind === "ocr") {
			lines.push(`[${i}] Text on "${row.filename}": "${row.text || ""}"`);
		} else {
			lines.push(`[${i}] File named "${row.filename}"`);
		}
	}
	return lines.join("\n");
}

function formatTimecode(t) {
	const total = Math.max(0, Math.floor(Number(t) || 0));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// The chat messages for /v1/chat/completions. Deterministic inputs: the
// same evidence always produces the same prompt (decompose-style
// reproducibility for tests).
function buildAskMessages({ query, evidenceRows, scopeLabel }) {
	const scope =
		scopeLabel && scopeLabel !== "all"
			? ` (searching only: ${scopeLabel})`
			: "";
	const system = [
		"You answer questions about the user's personal photo and video library.",
		"Answer ONLY from the numbered evidence excerpts below.",
		"Cite the excerpt number in brackets, like [2], for every claim.",
		"For spoken excerpts, mention the video and the timecode when useful.",
		"If the evidence does not contain the answer, say plainly that you could not find it in the library — never invent names, quotes, or dates.",
		"Be concise: 1-4 sentences.",
	].join(" ");
	const user = [
		`Question: ${String(query || "").trim()}${scope}`,
		"",
		"Evidence:",
		formatAskEvidence(evidenceRows) || "(none)",
	].join("\n");
	return [
		{ role: "system", content: system },
		{ role: "user", content: user },
	];
}

module.exports = { buildAskMessages, formatAskEvidence, formatTimecode };
