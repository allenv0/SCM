// OCR worker. Runs under Electron's utilityProcess (plain Node — same
// environment as the indexer worker). OCR is model-independent and CPU-heavy
// (tesseract spawns its own worker threads), so it lives in a DEDICATED
// process rather than inside the CLIP indexer worker, where it would contend
// with onnxruntime for the single-threaded inference queue. Answers:
//   { type: "ocr-photo", path, id } →
//   { type: "ocr-done", id, ok, text, words, error }
// The model is irrelevant here: any image the library holds (jpg/png/webp/
// heic/…) is decoded with sharp to a PNG buffer, then recognized by
// tesseract.js with the LSTM models named by OCR_LANGS (default
// "eng+chi_sim+chi_tra+jpn+kor", ~17MB total). Each *.traineddata downloads
// once into OCR_DATA_DIR (passed by main.js) and is reused offline from
// there. English is always on; CJK toggles come from settings.json via main.
//
// Requests are serialized (tesseract's node worker handles one recognition
// at a time; a FIFO lane keeps the process predictable). Also usable
// standalone: `node indexer/ocr-worker.js --smoke <imagePath> [--langs ...]`
// prints the recognized text and exits.

import fs from "node:fs";
import { createWorker } from "tesseract.js";
import { assertNever } from "../main-lib/assert-never.ts";

// Pixel box as tesseract reports it (and as this worker passes it around).
export interface OcrBBox {
	x0: number;
	y0: number;
	y1: number;
	x1: number;
}

// A tesseract word record as consumed by the gluing/filtering helpers.
// Every field is read defensively — output shapes vary across tesseract
// versions and passes, so all of them are optional here.
export interface OcrWord {
	text?: string;
	confidence?: number;
	bbox?: OcrBBox;
}

// The tesseract worker plus the language string stamped on it at creation
// (write-only today; kept so the create path stays exactly as shipped).
type OcrTesseractWorker = import("tesseract.js").Worker & {
	_ocrLangs?: string;
};

let worker: OcrTesseractWorker | null = null; // the tesseract.js worker, created lazily on first request
const pending: import("../shared/worker-messages.ts").OcrInbound[] = []; // FIFO of inbound messages
let busy = false;

function post(message: import("../shared/worker-messages.ts").OcrOutbound) {
	if (process.parentPort) {
		process.parentPort.postMessage(message);
	}
}

// Drop words tesseract itself is unsure about. A photo of a person yields
// plenty of "recognitions" at 10–60% confidence that are pure noise; real
// poster/screenshot text (the whole point of OCR search) clears 70%+
// comfortably — measured on this very pipeline: a poster fixture at 92–96,
// a 16px-font screenshot at 70+, a celebrity photo's junk at ≤60. The
// quality filter additionally rejects symbol soup and 1-char fragments.
const WORD_CONFIDENCE_MIN = 70;

// CJK support (Han / Hiragana / Katakana / Hangul) comes from the shared
// spec (shared/cjk-tokens.ts); the word-worth-indexing policy below stays
// local. CJK_PUNCT_RE is this worker's strip policy: CJK punctuation /
// symbols removed before the length check (、。、「」『』…！？ etc.), while
// the word-character marks (ー・々〻ゝゞｰ) survive.
import {
	CJK_CHAR_RE,
	CJK_RUNE_SOURCE,
	glueCjkSpaces,
} from "../shared/cjk-tokens.ts";
const CJK_PUNCT_RE = new RegExp(`[^${CJK_RUNE_SOURCE}a-zA-Z0-9]+`, "gu");

// Tesseract language allowlist. English is always on (locked); every other
// entry is a settings toggle. Canonical order (from the shared table) keeps
// the worker string stable ("eng+chi_sim+...") so a settings reorder never
// restarts work. The table lives in indexer/ocr-lang-list.ts — the single
// source of truth shared with settings.ts and main.ts.
import {
	OCR_LANG_IDS as OCR_TOGGLE_LANGS,
	DEFAULT_OCR_LANGS as DEFAULT_TOGGLE_LANGS,
} from "./ocr-lang-list.ts";
const DEFAULT_OCR_LANGS = `eng+${DEFAULT_TOGGLE_LANGS.join("+")}`;

// Parse OCR_LANGS env (or a --langs override) into a tesseract language
// string. Unknown entries are dropped; empty/invalid falls back to the
// default so a hand-edited settings.json can never break the OCR queue.
export function resolveOcrLangs(raw: unknown) {
	const parts =
		typeof raw === "string"
			? raw
					.split("+")
					.map((s) => s.trim())
					.filter(Boolean)
			: [];
	const enabled = OCR_TOGGLE_LANGS.filter((id) => parts.includes(id));
	// "eng" alone (or garbage) still resolves to eng + all CJK when nothing
	// valid was named? No — an explicit non-empty selection is honored as-is
	// (minus unknowns), so a user can run eng-only. Only a missing/empty
	// value takes the default.
	if (parts.length === 0) return DEFAULT_OCR_LANGS;
	return ["eng", ...enabled].join("+");
}

export function currentOcrLangs() {
	return resolveOcrLangs(process.env.OCR_LANGS);
}

// A "word" worth indexing: the Latin rule (at least 2 alphanumerics including
// a letter — filters symbol soup and lone characters) OR any CJK content: a
// single Han/Hangul/Kana char is a searchable unit (駅, 酒), unlike English
// "a"/"i". CJK punctuation is stripped first so "「東京」" counts as 東京.
// The letter test is Unicode-aware (\p{L}) so Cyrillic, Greek, Arabic, Hebrew
// and Devanagari words pass exactly like Latin ones — "Привет" keeps its
// letters through the strip (old [a-zA-Z]-only code erased them to "").
export function isRealWord(text: string): boolean {
	const raw = text || "";
	CJK_CHAR_RE.lastIndex = 0;
	if (CJK_CHAR_RE.test(raw)) {
		CJK_PUNCT_RE.lastIndex = 0;
		const stripped = raw.replace(CJK_PUNCT_RE, "");
		CJK_CHAR_RE.lastIndex = 0;
		if (stripped.length >= 1 && CJK_CHAR_RE.test(stripped)) return true;
		// Fall through to the Unicode rule for mixed strings like "A1東京"
		// whose CJK stripped form might be empty — handled below.
	}
	const clean = raw.replace(/[^\p{L}\p{N}]/gu, "");
	return clean.length >= 2 && /\p{L}/u.test(clean);
}

// Join word texts CJK-aware: no space is inserted between two CJK runs, so
// "東京" + "駅" stays "東京駅" (bigram search needs contiguous runs). Latin
// keeps space separation. Implemented as join-with-space then glue CJK gaps
// so mixed text ("Photo 東京駅 2024") stays readable.
export function joinOcrWords(texts: string[]) {
	const joined = texts.join(" ").replace(/\s+/g, " ").trim();
	// Glue spaces that sit between two CJK chars ("東 京" → "東京") via the
	// shared rune class.
	return glueCjkSpaces(joined).replace(/\s+/g, " ").trim();
}

// Email-fragment gluing (Email-tab recall). Tesseract often fractures one
// address into adjacent tokens ("jordan" + "parkes9@example" + "com") and scores
// the pieces just under WORD_CONFIDENCE_MIN — the filter then keeps a stray
// fragment ("jordan") while the address itself never reaches the index, so
// the Email tab misses a photo whose address a human plainly sees. This pass
// runs on the RAW word list (pre-filter) and re-assembles runs that form a
// strict email shape, so the normal confidence filter and detector see one
// token ("jordan.parkes9@example.com") instead of three dead fragments.
//
// Conservative by construction:
// - The anchor must contain "@" glued to alphanumerics on BOTH sides
//   (/[A-Za-z0-9]@[A-Za-z0-9]/). A lone "@" or "@handle" never glues, so
//   prose like "contact me @ work. today" (which the detector deliberately
//   rejects) can never be manufactured here.
// - Bare "at"/"dot" separator words are never consumed as fragments (they
//   are prepositions/dictation boundaries, not address content) —
//   expansion stops at them. Dictated shapes stay the detector's job.
// - Only runs validating against the strict shape below are replaced;
//   anything else passes through untouched (failed glues keep originals).
// - The glued token carries max(part confidences): the address is kept when
//   its best-evidenced piece clears the bar, and shape validation is the
//   real gate — random junk cannot validate.
const EMAIL_GLUE_SHAPE_RE =
	/^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const EMAIL_GLUE_ANCHOR_RE = /[A-Za-z0-9]@[A-Za-z0-9]/;
// Bare content fragments (no "@", no whitespace). Separator words are
// excluded separately — see EMAIL_GLUE_SEPARATOR_RE.
const EMAIL_GLUE_LEFT_RE = /^[A-Za-z0-9._%+-]+$/;
const EMAIL_GLUE_RIGHT_DOT_RE = /^\.[A-Za-z0-9-]+$/;
const EMAIL_GLUE_RIGHT_TLD_RE = /^[A-Za-z]{2,}$/;
// Whole-word "at"/"dot" (plus obfuscated bracket forms): never address
// content — expansion stops at these instead of consuming them.
const EMAIL_GLUE_SEPARATOR_RE =
	/^(?:\[at\]|\(at\)|\{at\}|<at>|\bat\b|\[dots?\]|\(dots?\)|\{dots?\}|<dots?>|\bdots?\b)$/i;
const EMAIL_GLUE_ANCHOR_MIN = 55;
const EMAIL_GLUE_PART_MIN = 50;
const EMAIL_GLUE_MAX_PARTS = 5;

// Relative-coordinate proximity: two fragments of one address share a line
// and sit close together (overlap allowed — Tesseract emits overlapping
// boxes for connected text like "jordan" / "parkes9@example"). Thresholds are
// fractions of image size so any normalized scale behaves the same.
function emailGlueAdjacent(
	left: { bbox?: OcrBBox } | null | undefined,
	right: { bbox?: OcrBBox } | null | undefined,
	W: number,
	H: number,
) {
	if (!left || !right || !left.bbox || !right.bbox) return false;
	const cyL = (left.bbox.y0 + left.bbox.y1) / 2 / H;
	const cyR = (right.bbox.y0 + right.bbox.y1) / 2 / H;
	const hL = Math.max(1, left.bbox.y1 - left.bbox.y0) / H;
	const hR = Math.max(1, right.bbox.y1 - right.bbox.y0) / H;
	if (Math.abs(cyL - cyR) > 0.6 * Math.max(hL, hR)) return false;
	const gap = (right.bbox.x0 - left.bbox.x1) / W;
	return gap < 0.03;
}

function emailGlueJoin(left: string, right: string) {
	if (left.endsWith(".") || right.startsWith(".") || right.startsWith("@"))
		return left + right;
	return left + "." + right;
}

// Try to grow an email run around words[i] (must be the "@" anchor).
// Returns { word, next } (the glued token + first unconsumed index) or null
// (originals untouched — the caller keeps words[i] as-is).
function tryGlueEmailAt(words: OcrWord[], i: number, W: number, H: number) {
	const anchor = words[i];
	if (!anchor) return null;
	const atext = (anchor.text ? String(anchor.text) : "").trim();
	if (!atext || !EMAIL_GLUE_ANCHOR_RE.test(atext)) return null;
	if ((anchor.confidence ?? 0) < EMAIL_GLUE_ANCHOR_MIN) return null;
	let text = atext;
	let conf = anchor.confidence ?? 0;
	let x0 = anchor.bbox ? anchor.bbox.x0 : 0;
	let y0 = anchor.bbox ? anchor.bbox.y0 : 0;
	let x1 = anchor.bbox ? anchor.bbox.x1 : 0;
	let y1 = anchor.bbox ? anchor.bbox.y1 : 0;
	let from = i;
	let to = i;
	let parts = 1;
	const valid = () => EMAIL_GLUE_SHAPE_RE.test(text);
	// Expand left over bare fragments — but never past a separator word,
	// and never once the run already validates (a preceding "at" is a
	// preposition, e.g. "reach me at jordan.parkes9@example com", not local text).
	while (!valid() && parts < EMAIL_GLUE_MAX_PARTS && from - 1 >= 0) {
		const w = words[from - 1];
		if (!w || !w.bbox) break;
		const t = (w.text ? String(w.text) : "").trim();
		if (!t || EMAIL_GLUE_SEPARATOR_RE.test(t)) break;
		if (!EMAIL_GLUE_LEFT_RE.test(t)) break;
		if ((w.confidence ?? 0) < EMAIL_GLUE_PART_MIN) break;
		if (
			!emailGlueAdjacent({ bbox: w.bbox }, { bbox: { x0, y0, x1, y1 } }, W, H)
		)
			break;
		text = emailGlueJoin(t, text);
		conf = Math.max(conf, w.confidence ?? 0);
		x0 = Math.min(x0, w.bbox.x0);
		y0 = Math.min(y0, w.bbox.y0);
		x1 = Math.max(x1, w.bbox.x1);
		y1 = Math.max(y1, w.bbox.y1);
		from -= 1;
		parts += 1;
	}
	// Expand right over dot-led (".com") or bare-TLD ("com") pieces. Once
	// the run validates, only dot-led pieces continue (a following bare word
	// like "or" in "...co.uk or ..." is prose, not a tail).
	while (parts < EMAIL_GLUE_MAX_PARTS && to + 1 < words.length) {
		const w = words[to + 1];
		if (!w || !w.bbox) break;
		const t = (w.text ? String(w.text) : "").trim();
		if (!t || EMAIL_GLUE_SEPARATOR_RE.test(t)) break;
		let piece;
		if (EMAIL_GLUE_RIGHT_DOT_RE.test(t)) piece = t;
		else if (!valid() && EMAIL_GLUE_RIGHT_TLD_RE.test(t)) piece = "." + t;
		else break;
		if ((w.confidence ?? 0) < EMAIL_GLUE_PART_MIN) break;
		if (
			!emailGlueAdjacent({ bbox: { x0, y0, x1, y1 } }, { bbox: w.bbox }, W, H)
		)
			break;
		text = emailGlueJoin(text, piece);
		conf = Math.max(conf, w.confidence ?? 0);
		x0 = Math.min(x0, w.bbox.x0);
		y0 = Math.min(y0, w.bbox.y0);
		x1 = Math.max(x1, w.bbox.x1);
		y1 = Math.max(y1, w.bbox.y1);
		to += 1;
		parts += 1;
	}
	if (!valid()) return null;
	return {
		word: { text, confidence: conf, bbox: { x0, y0, x1, y1 } },
		from,
		next: to + 1,
	};
}

// Re-assemble fractured email addresses in a raw tesseract word list.
// Same order, same length-or-shorter: non-email words (and failed glues)
// pass through by reference. Pure — unit-testable without a worker.
export function glueEmailFragments(words: OcrWord[], W: number, H: number) {
	if (!Array.isArray(words) || words.length === 0) return words || [];
	const width = Number(W) > 0 ? Number(W) : 1;
	const height = Number(H) > 0 ? Number(H) : 1;
	const out: OcrWord[] = [];
	let i = 0;
	while (i < words.length) {
		const g = tryGlueEmailAt(words, i, width, height);
		if (g) {
			// Left expansion may have consumed words already emitted (from
			// < i): retract them so the run replaces its fragments exactly.
			if (g.from < i) out.splice(out.length - (i - g.from), i - g.from);
			out.push(g.word);
			i = g.next;
		} else {
			const w = words[i];
			if (w) out.push(w);
			i += 1;
		}
	}
	return out;
}

// Clean tesseract output into searchable text: keep only confident real
// words (Latin + CJK), join CJK-aware (no spaces inside CJK runs), collapse
// whitespace, trim, cap length. The joined string is what the keyword ranker
// tokenizes against (with CJK bigram expansion on the query side).
export function cleanText(raw: string | undefined, words?: OcrWord[]) {
	if (words && words.length > 0) {
		return joinOcrWords(
			words
				.filter(
					(w) =>
						w &&
						w.text &&
						(w.confidence ?? 0) >= WORD_CONFIDENCE_MIN &&
						isRealWord(w.text),
				)
				.map((w) => String(w.text ?? "").trim())
				.filter(Boolean),
		).slice(0, 2000);
	}
	if (!raw) return "";
	return raw
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 2000);
}

// Tesseract reports pixels in the normalized PNG passed to recognize(). Store
// relative coordinates instead: thumbnails and lightbox images can draw the
// same OCR hit box at any size without another image-size lookup.
export function normalizeWords(
	words: OcrWord[],
	width: number,
	height: number,
) {
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return [];
	}
	return words
		.filter(
			(w) =>
				w &&
				w.text &&
				(w.confidence ?? 0) >= WORD_CONFIDENCE_MIN &&
				isRealWord(w.text) &&
				w.bbox,
		)
		.map((w) => {
			// The filter above guarantees a bbox; the cast records that
			// contract for tsc (filter results do not narrow into map).
			const bbox = w.bbox as OcrBBox;
			const x0 = Math.max(0, Math.min(width, Number(bbox.x0)));
			const y0 = Math.max(0, Math.min(height, Number(bbox.y0)));
			const x1 = Math.max(x0, Math.min(width, Number(bbox.x1)));
			const y1 = Math.max(y0, Math.min(height, Number(bbox.y1)));
			return {
				text: String(w.text ?? "").trim(),
				x: x0 / width,
				y: y0 / height,
				w: (x1 - x0) / width,
				h: (y1 - y0) / height,
			};
		})
		.filter((word) => word.text && word.w > 0 && word.h > 0);
}

async function ensureWorker() {
	if (worker) return worker;
	const langs = currentOcrLangs();
	// Defense in depth: the pump mkdirs OCR_DATA_DIR before forking us, but
	// the standalone `--smoke` path (and any future spawner) must not lose
	// the cache either — tesseract's cache write is a bare fs.writeFile,
	// which neither creates the dir nor surfaces the failure.
	if (process.env.OCR_DATA_DIR) {
		fs.mkdirSync(process.env.OCR_DATA_DIR, { recursive: true });
	}
	worker = (await createWorker(langs, 1, {
		// *.traineddata lands here once (first OCR ever); every later run
		// reads it from disk — fully offline after the first download.
		// ~17MB for the full eng+chi_sim+chi_tra+jpn+kor default.
		cachePath: process.env.OCR_DATA_DIR || undefined,
		cacheMethod: "write",
		logger: () => {},
	} as Parameters<typeof createWorker>[2])) as OcrTesseractWorker;
	worker._ocrLangs = langs;
	return worker;
}

// Eager sharp promise (module load, unchanged): the first ocrPhoto awaits it.
const sharpP = import("sharp");

export async function ocrPhoto(filePath: string) {
	const sharp = (await sharpP).default;
	// Decode ANY library format (heic/webp included) to a PNG buffer — the
	// tesseract worker cannot read those containers itself. Resize huge
	// images down so a 12MP photo doesn't blow up recognition time; text
	// stays readable at ≤2400px.
	// { data, info } — sharp's resolveWithObject shape.
	let normalized: { data: Buffer; info: import("sharp").OutputInfo };
	try {
		normalized = await sharp(filePath)
			.resize({
				width: 2400,
				height: 2400,
				fit: "inside",
				withoutEnlargement: true,
			})
			.png()
			.toBuffer({ resolveWithObject: true });
	} catch {
		// Not decodable by sharp (corrupt/unsupported) — no text to find.
		return { text: "", words: [] };
	}
	const w = await ensureWorker();
	// blocks: true gives per-word confidence so noise can be filtered before
	// the text ever reaches the index (a photo of a person yields confident-
	// looking junk that would pollute keyword search).
	const recognize = () => w.recognize(normalized.data, {}, { blocks: true });
	let { data } = await recognize();
	// Tesseract occasionally returns text with NO block structure (seen as a
	// small fraction of passes; likely an engine hiccup). A text-only answer
	// is poison: cleanText's fallback keeps UNFILTERED raw text while the
	// word list stays empty, so the row becomes searchable-but-never-
	// highlightable. One retry resolves it; only give up after that.
	if ((data.blocks || []).length === 0 && (data.text || "").trim()) {
		console.warn(`[ocr] empty blocks with text for ${filePath}, retrying once`);
		({ data } = await recognize());
	}
	const words: OcrWord[] = [];
	for (const b of data.blocks || []) {
		for (const p of b.paragraphs || []) {
			for (const l of p.lines || []) {
				for (const word of l.words || []) words.push(word);
			}
		}
	}
	// Re-assemble email addresses Tesseract fractured into adjacent tokens
	// ("jordan" + "parkes9@example" + "com") before confidence filtering drops
	// sub-threshold pieces — the glued token carries max part confidence so
	// the normal filter judges the address, not its fragments.
	const emailGlued = glueEmailFragments(
		words as OcrWord[],
		normalized.info.width,
		normalized.info.height,
	);
	return {
		text: cleanText(data.text, emailGlued),
		words: normalizeWords(
			emailGlued,
			normalized.info.width,
			normalized.info.height,
		),
	};
}

// Inbound dispatch (protocol: shared/worker-messages.ts OcrInbound).
async function handleMessage(
	message: import("../shared/worker-messages.ts").OcrInbound,
): Promise<void> {
	// id comes off the ocr-photo request; keep it for the failure reply below
	// (a shutdown cannot fail, so there it stays undefined — as before).
	const id = message.type === "ocr-photo" ? message.id : undefined;
	try {
		if (message.type === "ocr-photo") {
			const result = await ocrPhoto(message.path);
			post({ type: "ocr-done", id, ok: true, ...result });
			return;
		}
		if (message.type === "shutdown") {
			try {
				if (worker) await worker.terminate();
			} catch {
				/* best-effort */
			}
			process.exit(0);
		}
		// Exhaustiveness (Tier 4): a new OcrInbound variant must be handled
		// above, never silently dropped.
		assertNever(message);
	} catch (err) {
		const e = err as { message?: string } | null;
		post({
			type: "ocr-done",
			id,
			ok: false,
			error: (e && e.message) || String(err),
		});
	}
}

function pump() {
	if (busy) return;
	const job = pending.shift();
	if (!job) return;
	busy = true;
	Promise.resolve()
		.then(() => handleMessage(job))
		.catch((err) =>
			console.error(
				`[ocr] handler error: ${(err as { message?: string }).message}`,
			),
		)
		.finally(() => {
			busy = false;
			pump();
		});
}

if (process.parentPort) {
	process.parentPort.on("message", (event) => {
		pending.push(
			event.data as import("../shared/worker-messages.ts").OcrInbound,
		);
		pump();
	});
}

// Standalone self-test: `node indexer/ocr-worker.js --smoke <imagePath> [--langs eng+chi_tra+jpn+kor]`
async function runSmoke(imagePath: string) {
	const langsFlagIndex = process.argv.indexOf("--langs");
	if (langsFlagIndex !== -1 && process.argv[langsFlagIndex + 1]) {
		process.env.OCR_LANGS = process.argv[langsFlagIndex + 1];
	}
	console.log(`[ocr] langs: ${currentOcrLangs()}`);
	console.log(`[ocr] recognizing ${imagePath}…`);
	const result = await ocrPhoto(imagePath);
	console.log(`[ocr] text: ${JSON.stringify(result.text)}`);
	console.log(
		`[ocr] words: ${result.words.length} (text length ${result.text.length})`,
	);
	console.log("[ocr] OK");
}

if (require.main === module && process.argv.includes("--smoke")) {
	const imagePath = process.argv[process.argv.indexOf("--smoke") + 1];
	if (!imagePath) {
		console.error("usage: node indexer/ocr-worker.js --smoke <imagePath>");
		process.exit(2);
	}
	runSmoke(imagePath)
		.then(async () => {
			try {
				if (worker) await worker.terminate();
			} catch {
				/* ignore */
			}
		})
		.catch((err) => {
			console.error("[ocr] FAILED:", err);
			process.exit(1);
		});
}

export { DEFAULT_OCR_LANGS };
