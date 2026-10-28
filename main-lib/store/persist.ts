// Phase 2 (store/persist): pure move from main-lib/library-store.js —
// persist queue, atomic writes, full save. Index reads ride index-core;
// bin encode/write rides bins; embed metadata rides model-state. All
// sibling access is call-time only (cycle-safe).

import fs from "node:fs";
import * as indexCore from "./index-core.ts";
import * as bins from "./bins.ts";
import * as modelState from "./model-state.ts";

let persistQueue: Promise<unknown> = Promise.resolve();
let persistSeq = 0;
let warnedLazyBins = false;
let warnedLazyDrift = false;

export function enqueuePersist<T>(fn: () => T | Promise<T>): Promise<T> {
	const run = persistQueue.then(fn);
	persistQueue = run.catch(() => {});
	return run;
}

// Write one file atomically: unique temp name (concurrent writers can't
// collide on a shared temp), fsync for durability, then rename over the
// destination. The fsync makes the bytes durable across power loss BEFORE
// the atomic rename lands (APFS rename is atomic but not durable without a

export async function writeFileAtomic(
	file: string,
	data: string | Buffer,
): Promise<void> {
	const tmp = `${file}.tmp-${process.pid}-${++persistSeq}`;
	const fd = await fs.promises.open(tmp, "w");
	let wrote = false;
	try {
		// One branch per FileHandle.write overload: node does not accept a
		// string | Buffer union in a single call signature.
		if (typeof data === "string") await fd.write(data);
		else await fd.write(data);
		await fd.sync();
		await fd.close();
		await fs.promises.rename(tmp, file);
		wrote = true;
	} finally {
		if (!wrote) {
			try {
				await fd.close();
			} catch {
				/* already closed */
			}
			// Never litter zero-byte temps on a failed write (fd.write
			// throws first under memory pressure): sweeps and the M-04
			// no-leftovers guard assume a tmp means a write in flight.
			try {
				await fs.promises.unlink(tmp);
			} catch {
				/* already gone */
			}
		}
	}
}

// The encoded bin payloads are served to the renderer on every reload; the
// underlying rows only change when the library is saved, so the encoded
// Buffer is memoized and rebuilt only when (model, row count, dim) moves.
// Keyed on the LIVE in-memory state so the served bytes always match the
// index the renderer just fetched — and migration checkpoints (which write
// partial TARGET-model bins through writeBins) can never pollute it. The
// cache is dropped in saveLibrary: a same-size mutation (a healed phrase

export async function saveLibrary(): Promise<void> {
	const l = indexCore.loadLibrary();
	// A retired/unknown model's rows are deliberately withheld while main
	// builds a replacement index. Startup maintenance (timestamps, stale-row
	// pruning, OCR, etc.) may call saveLibrary before that async migration
	// begins; letting one of those writes through would replace the only
	// recoverable old index with an empty target-model bin. The migration
	// clears this guard immediately before its final atomic save.
	if (l.pendingModelMigration) return;
	// A lazy library whose filenames no longer match the index it was loaded
	// from is mid-mutation. Writing that index now would pair new filenames
	// with the old bin row count; let the mutation finish (it materializes
	// the bins) and retry on the next save.
	if (!indexCore.libraryBinsLoaded() && l.filenames.length !== l.diskRowCount) {
		if (!warnedLazyDrift) {
			warnedLazyDrift = true;
			console.warn(
				`[memories] library save deferred: ${l.filenames.length} filenames vs ${l.diskRowCount} on-disk rows while bins are lazy`,
			);
		}
		return;
	}
	// A metadata-only save must never overwrite healthy on-disk vectors with
	// the empty arrays a failed/misaligned bin read leaves in memory. This is
	// the failure mode that turns one bad read into permanent data loss:
	// loadLibrary sets embeddings=[] and the next timestamp/OCR save encodes
	// that empty table over the only copy. Keep the old bins and persist only
	// index metadata; the next successful embed/rebuild owns the bin write.
	const rowsLoaded = indexCore.libraryBinsLoaded();
	const binsReady =
		rowsLoaded &&
		(l.filenames.length === 0 ||
			(l.dim > 0 && l.embeddings.length === l.filenames.length));
	if (!binsReady) {
		if (rowsLoaded) {
			console.warn(
				`[memories] library save preserved on-disk bins (${l.embeddings.length}/${l.filenames.length} rows, dim ${l.dim}); writing metadata only`,
			);
		} else if (!warnedLazyBins) {
			warnedLazyBins = true;
			console.warn(
				`[memories] library save kept bins lazy (${l.filenames.length} rows, dim ${l.dim}); writing metadata only`,
			);
		}
		try {
			const indexJson = JSON.stringify(indexCore.libraryIndex());
			await enqueuePersist(async () => {
				await writeFileAtomic(indexCore.INDEX_FILE, indexJson);
				indexCore.bumpLibraryGeneration();
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[memories] metadata-only library save failed: ${msg}`);
		}
		return;
	}
	let indexJson;
	let embBuf;
	let phrBuf;
	let metaJson;
	try {
		fs.mkdirSync(indexCore.DATA_DIR, { recursive: true });
		indexJson = JSON.stringify(indexCore.libraryIndex());
		const phraseDim = l.phrases.length === l.filenames.length ? l.dim : 0;
		embBuf = bins.encodeBin(l.embeddings, l.dim);
		phrBuf = bins.encodeBin(l.phrases, phraseDim);
		// Row-identity snapshot for the delta-switch planner, captured at the
		// same moment as the bins above so the pair can never diverge (see
		// writeBins). A background fill in progress stamps incomplete:true via
		// setEmbedIncomplete, so a crash resumes the tail on next launch.
		metaJson = JSON.stringify({
			version: 1,
			codeVersion: modelState.EMBED_CODE_VERSION,
			modelId: l.modelId,
			dim: l.dim,
			count: l.filenames.length,
			incomplete: modelState.embedIncompleteByModel.get(l.modelId) === true,
			filenames: [...l.filenames],
			writtenAt: new Date().toISOString(),
		});
	} catch (err) {
		// Same contract as the persist catch below: the sync prefix can throw
		// (encodeBin allocates under memory pressure on huge libraries), and
		// fire-and-forget `void saveLibrary()` callers must never surface an
		// unhandled rejection. In-memory state stays consistent; next save
		// retries.
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[memories] library save skipped: ${msg}`);
		return;
	}
	// Rows changed under this key (e.g. a healed phrase row keeps the same
	// count/dim) — drop the memoized payload so the next fetch re-encodes.
	bins.resetBinCaches();
	try {
		await enqueuePersist(async () => {
			// Bins first, index last: a crash between renames leaves either
			// the old index (consistent with the old bins) or a new index
			// whose bins already landed — never a new index pointing at
			// bins that haven't been written yet. The load-time count check
			// self-heals either way, but this keeps the on-disk pair
			// consistent and avoids a full re-embed.
			await Promise.all([
				writeFileAtomic(indexCore.embedFileFor(l.modelId), embBuf),
				writeFileAtomic(indexCore.phraseFileFor(l.modelId), phrBuf),
				writeFileAtomic(modelState.embedMetaFileFor(l.modelId), metaJson),
			]);
			await writeFileAtomic(indexCore.INDEX_FILE, indexJson);
			indexCore.bumpLibraryGeneration();
		});
	} catch (err) {
		// Persistence failure must not crash the flow that triggered it: the
		// in-memory library (what the renderer reads) is still consistent,
		// and the next save retries the disk write.
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[memories] library save failed: ${msg}`);
	}
}

// The first release with sourceMtimes must repair libraries that already had
// arbitrary fs.readdir order baked into `images`. Read the source file when
// possible; an app-managed copy's mtime is a useful import-time fallback when
// its original was moved or deleted. This deliberately changes metadata only
