// Import-result toast copy (the App result pill): maps an ImportResult to
// the message + tone the toast renders. Pure, so the wording — which
// filenames show, which reasons append, how the watch-note suffix reads —
// is unit-testable without React. Moved verbatim out of App.tsx except for
// the reason suffix: the toast used to render only filenames, so a batch
// refused whole (a concurrent import, a model switch) read as a mystery —
// the backend reason rides every errors entry and now renders with it.
import type { ImportResult } from "../types";

export type ToastTone = "default" | "success" | "warning" | "error";

/** Reasons are backend verbatims (ffmpeg/sharp/ENOENT can run long) —
// the pill truncates, so cap each one; the full text rides the title attr. */
const MAX_REASON_CHARS = 140;

export function shortName(name: string, max = 30): string {
	if (name.length <= max) return name;
	return `${name.slice(0, max - 1)}…`;
}

function shortReason(reason: string): string {
	const clean = reason.trim();
	if (clean.length <= MAX_REASON_CHARS) return clean;
	return `${clean.slice(0, MAX_REASON_CHARS - 1)}…`;
}

export function resultSummary(res: ImportResult | null): string | null {
	if (!res) return null;
	const parts = [];
	if (res.added.length > 0) parts.push("Photos added");
	if (res.skipped.length > 0)
		parts.push(`${res.skipped.length} already imported`);
	if (parts.length === 0) return null;
	return parts.join(" · ");
}

// Import results map to the semantic toast tones — the same STATE hues as
// the engine LED (globals.css --ai-* tokens): a clean batch is success
// (emerald), a partial batch warning (amber), a total failure error (rose).
export function importResultToast(res: ImportResult): {
	message: string;
	tone: ToastTone;
} {
	// Imported folders are auto-watched (new files import on launch and as
	// they appear) — say so once, so the behavior isn't a surprise.
	const watchNote =
		res.watched.length > 0
			? ` · Watching ${res.watched.map((w) => shortName(w)).join(", ")} for new photos`
			: "";
	if (res.errors.length === 0) {
		return {
			message: `${resultSummary(res) ?? "Nothing to import"}${watchNote}`,
			tone: res.added.length > 0 ? "success" : "default",
		};
	}
	const prefix = res.added.length > 0 ? "Photos added · " : "";
	const names = res.errors
		.slice(0, 2)
		.map((e) => e.file)
		.join(", ");
	const more = res.errors.length > 2 ? ", …" : "";
	// The why, not just the what: a bare folder name (a refused batch names
	// the folder, never a file) is meaningless without its reason.
	const reasons: string[] = [];
	for (const e of res.errors) {
		const r = shortReason(e.error ?? "");
		if (r && !reasons.includes(r)) reasons.push(r);
		if (reasons.length === 2) break;
	}
	const reasonNote = reasons.length > 0 ? ` — ${reasons.join(" · ")}` : "";
	return {
		message: `${prefix}Some files failed AI indexing: ${names}${more}${reasonNote}${watchNote}`,
		tone: res.added.length > 0 ? "warning" : "error",
	};
}
