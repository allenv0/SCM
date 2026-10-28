// Phase 2 (store/bins): pure move from main-lib/library-store.js — bin
// read/write/encode, bin caches, norms + cosine. Paths, init, and the
// generation counter ride the index-core namespace; persistence + embed
// metadata ride persist/model-state. All sibling access is call-time
// only (cycle-safe).

import fs from "node:fs";
import * as indexCore from "./index-core.ts";
import * as persist from "./persist.ts";
import * as modelState from "./model-state.ts";

export function readLibraryBins(
	modelId: string,
	count: number,
	dim: number,
): [Float32Array[], Float32Array[]] {
	const primary = readBin(indexCore.embedFileFor(modelId), count, dim);
	const phrase = readBin(indexCore.phraseFileFor(modelId), count, dim);
	if (primary.length === count && phrase.length === count) {
		return [primary, phrase];
	}
	const legacyEmb = readBin(indexCore.LEGACY_EMBED_FILE, count, dim);
	const legacyPhr = readBin(indexCore.LEGACY_PHRASE_FILE, count, dim);
	if (legacyEmb.length === count) {
		if (primary.length !== count)
			console.warn(
				`[memories] no ${modelId} bin yet; using legacy bin as its pair`,
			);
		return [legacyEmb, legacyPhr.length === count ? legacyPhr : []];
	}
	return [
		primary.length === count ? primary : [],
		phrase.length === count ? phrase : [],
	];
}

// Header-only probe for load-time metadata: avoids paging a multi-hundred-
// megabyte bin into memory just to learn whether a phrase table is aligned.
export function readBinHeader(
	file: string,
): { count: number; dim: number } | null {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(8);
			if (fs.readSync(fd, buf, 0, 8, 0) !== 8) return null;
			const count = buf.readInt32LE(0);
			const dim = buf.readInt32LE(4);
			if (
				!Number.isInteger(count) ||
				count < 0 ||
				count >= 1_000_000 ||
				(count > 0 && (!Number.isInteger(dim) || dim <= 0 || dim >= 8192))
			) {
				return null;
			}
			// A valid header is not enough: a crash/partial copy can leave a
			// truncated tail. Only report the dimension when the file holds
			// every declared row, or libraryIndex would advertise a phrase
			// table that the first real read will discard. Trailing bytes are
			// tolerated, matching decodeBinRows.
			if (fs.fstatSync(fd).size < 8 + count * dim * 4) return null;
			return { count, dim };
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return null;
	}
}

export function readBin(
	file: string,
	count: number,
	dim: number,
): Float32Array[] {
	const rows = readBinPartial(file, dim, { quarantine: true, file });
	// Mismatch with the requested count: a normal "this bin is for
	// a different library/model" signal, not corruption.
	if (rows.length !== count) return [];
	return rows;
}

// Length-tolerant bin read: every row the file holds (validated the same
// way as readBin), regardless of the caller's row count. The delta-switch
// planner uses this to reuse cached rows by identity when the library has

interface BinDecode {
	rows?: Float32Array[];
	corrupt?: boolean;
	bytes?: number;
	header?: number[];
}

export function readBinPartial(
	file: string,
	dim: number,
	opts: { quarantine?: boolean; file?: string } = {},
): Float32Array[] {
	try {
		const buf = fs.readFileSync(file);
		const decoded = decodeBinRows(buf, dim);
		if (!decoded) return [];
		if (decoded.corrupt && opts.quarantine) {
			console.warn(
				`[memories] bin corrupt (bytes=${decoded.bytes} header=[${decoded.header}]) — quarantining ${opts.file || file}`,
			);
			try {
				fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.warn(`[memories] could not quarantine corrupt bin: ${msg}`);
			}
			return [];
		}
		if (decoded.corrupt) return [];
		return decoded.rows || [];
	} catch {
		return [];
	}
}

// Structural validation + decode shared by readBin/readBinPartial. Returns
// { rows } on success, { corrupt, bytes, header } when the file is
// internally inconsistent (truncated — quarantined by the caller, C-02), or
// null when the bin is merely for a different vector space (dim mismatch —

function decodeBinRows(buf: Buffer, dim: number): BinDecode | null {
	try {
		// A file shorter than the 8-byte header is not a "different vector
		// space" — it is a truncated/foreign write (C-02): corrupt, so the
		// caller quarantines it. The Int32Array construction below throws on
		// a short buffer, and the catch would misclassify that as null.
		if (buf.length < 8) {
			return { corrupt: true, bytes: buf.length, header: [] };
		}
		const header = new Int32Array(buf.buffer, buf.byteOffset, 2);
		// Both slots are present: the length guard above proved 8 bytes.
		const hCount = header[0] as number;
		const hDim = header[1] as number;
		// Structural check: is the FILE internally consistent? A bin that
		// declares more rows than its bytes can hold is truncated/corrupt.
		// A count=0 bin is the app's own "empty" representation (e.g.
		// phrases before the text model loads) — it is NOT corrupt, only
		// the 8-byte header.
		const structurallyValid =
			Number.isInteger(hCount) &&
			hCount >= 0 &&
			hCount < 1_000_000 &&
			(hCount === 0
				? buf.length >= 8
				: Number.isInteger(hDim) &&
					hDim > 0 &&
					hDim < 8192 &&
					buf.length >= 8 + hCount * hDim * 4);
		if (!structurallyValid) {
			return { corrupt: true, bytes: buf.length, header: [hCount, hDim] };
		}
		if (hDim !== dim) return null;
		const rows: Float32Array[] = [];
		for (let i = 0; i < hCount; i++) {
			rows.push(
				new Float32Array(buf.buffer, buf.byteOffset + 8 + i * dim * 4, dim),
			);
		}
		return { rows };
	} catch {
		return null;
	}
}

export function encodeBin(
	vectors: Array<Float32Array | null>,
	dim: number,
): Buffer {
	// Defensive: never write nulls (an empty vector keeps 1:1 alignment).
	const body = Buffer.concat(
		vectors.map((v) =>
			Buffer.from(
				v
					? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)
					: new ArrayBuffer(dim * 4),
			),
		),
	);
	const header = Buffer.alloc(8);
	header.writeInt32LE(vectors.length, 0);
	header.writeInt32LE(dim, 4);
	return Buffer.concat([header, body]);
}

let libraryBinCache: {
	key: string | null;
	embeddings: Buffer | null;
	phrases: Buffer | null;
} = { key: null, embeddings: null, phrases: null };

// Checkpoint encodes can fail repeatedly under sustained memory pressure
// (one attempt per checkpoint), so the warn is throttled — the first
// failure is reported, the rest stay quiet until memory frees.
let lastEncodeWarnAt = 0;
function warnEncodeThrottled(modelId: string, msg: string): void {
	const now = Date.now();
	if (now - lastEncodeWarnAt > 30000) {
		lastEncodeWarnAt = now;
		console.warn(
			`[memories] bin encode failed for ${modelId}: ${msg} (skipping this write; in-memory rows stay authoritative)`,
		);
	}
}

export function cachedLibraryBins(): {
	key: string | null;
	embeddings: Buffer | null;
	phrases: Buffer | null;
} {
	const l = indexCore.loadLibrary();
	const phraseDim = l.phrases.length === l.filenames.length ? l.dim : 0;
	const key = `${l.modelId}|${l.filenames.length}|${l.dim}|${phraseDim}`;
	if (libraryBinCache.key !== key) {
		libraryBinCache = {
			key,
			embeddings: encodeBin(l.embeddings, l.dim),
			phrases: encodeBin(l.phrases, phraseDim),
		};
	}
	return libraryBinCache;
}

// Total by design: never throws and never rejects. Both the encode phase
// (Buffer.concat can throw RangeError under memory pressure on huge
// libraries) and the persist phase (caught below) degrade to a warning so
// best-effort callers — migration checkpoints via fire-and-forget `void`
// calls — can never surface an unhandled rejection. The in-memory rows
// stay authoritative and the next write retries.
export function writeBins(
	modelId: string,
	embeddings: Array<Float32Array | null>,
	phrases: Array<Float32Array | null>,
	dim: number,
	phraseDim: number,
	opts: { filenames?: string[]; incomplete?: boolean } = {},
): Promise<void> {
	fs.mkdirSync(indexCore.DATA_DIR, { recursive: true });
	let embBuf;
	let phrBuf;
	try {
		embBuf = encodeBin(embeddings, dim);
		phrBuf = encodeBin(phrases, phraseDim);
	} catch (err) {
		warnEncodeThrottled(
			modelId,
			err instanceof Error ? err.message : String(err),
		);
		return Promise.resolve();
	}
	const filenames = Array.isArray(opts.filenames) ? [...opts.filenames] : null;
	const metaJson = filenames
		? JSON.stringify({
				version: 1,
				codeVersion: modelState.EMBED_CODE_VERSION,
				modelId,
				dim,
				count: filenames.length,
				incomplete: opts.incomplete === true,
				filenames,
				writtenAt: new Date().toISOString(),
			})
		: null;
	return persist
		.enqueuePersist(() =>
			Promise.all([
				persist.writeFileAtomic(indexCore.embedFileFor(modelId), embBuf),
				persist.writeFileAtomic(indexCore.phraseFileFor(modelId), phrBuf),
				...(metaJson
					? [
							persist.writeFileAtomic(
								modelState.embedMetaFileFor(modelId),
								metaJson,
							),
						]
					: []),
			]),
		)
		.then(() => {
			indexCore.bumpLibraryGeneration();
		})
		.catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[memories] bin write failed for ${modelId}: ${msg}`);
		});
}

let libraryNormCache: { key: string | null; norms: Float32Array | null } = {
	key: null,
	norms: null,
};

export function libraryNorms(): Float32Array | null {
	const l = indexCore.loadLibrary();
	const key = `${l.embeddings.length}|${l.dim}`;
	if (libraryNormCache.key !== key) {
		const dim = l.dim;
		const norms = new Float32Array(l.embeddings.length);
		for (let i = 0; i < l.embeddings.length; i++) {
			const v = l.embeddings[i];
			let s = 0;
			// Bounds-proven reads (k < dim): rows are always dim-length.
			if (v)
				for (let k = 0; k < dim; k++) s += (v[k] as number) * (v[k] as number);
			norms[i] = s > 0 ? Math.sqrt(s) : 0;
		}
		libraryNormCache = { key, norms };
	}
	return libraryNormCache.norms;
}

// Dot-only helper (callers hold precomputed norms; see rank-search for the
// normalized form).
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let dot = 0;
	// Bounds-proven reads (i < a.length): see rank-search.js cosineSim.
	for (let i = 0; i < a.length; i++) {
		dot += (a[i] as number) * (b[i] as number);
	}
	return dot;
}

// Reset the bin/norm caches (called by index-core's resetLibraryCaches;
// same initializers, same order as the verbatim block it replaces).
export function resetBinCaches(): void {
	libraryBinCache = { key: null, embeddings: null, phrases: null };
	libraryNormCache = { key: null, norms: null };
}
