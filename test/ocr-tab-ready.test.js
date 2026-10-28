"use strict";

// ---------------------------------------------------------------------------
// OCR-tab search readiness — the /all/ocr "No images with matching text"
// regression.
//
// The OCR tab ranks synchronously in the renderer against ocrTextsRef
// (useMemorySearch). Every library-updated invalidation wipes that ref to
// null and the next index commit refills it. A query typed in that window
// ranked against null and returned [] — and nothing re-ran it, because the
// search effect's deps never change on a commit. The grid then claimed "no
// matching text" for text that exists (10 real rows contain "compute").
//
// The fix has three parts, all pinned here:
//   1. readiness signal: searchStatus.isReady flips false on invalidate and
//      true on commit — MasonryGrid passes it into useGridSearch
//   2. re-run: useGridSearch re-ranks the OCR query when readiness flips
//      true, and stays a NO-OP on false (stale results survive the refill
//      window instead of flashing empty on every OCR/enrichment tick)
//   3. honesty + self-heal: the empty state distinguishes "index loading"
//      from a genuine no-match, and searchOcr kicks the idempotent loader
//      when the texts are missing so a failed load recovers on the next
//      keystroke instead of staying dead for the session
//
// Deterministic source+wiring assertions; the matcher's alignment guard is
// behavior-tested in test/search-metadata.test.ts. Any failure throws.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const hook = read("src/hooks/useMemorySearch.ts");
const gridSearch = read("src/hooks/useGridSearch.ts");
const masonry = read("src/components/MasonryGrid.tsx");
const searchStatus = read("src/lib/searchStatus.ts");

// --- 1. Readiness signal: one source of truth -----------------------------

// The reducer owns the lifecycle: wiped on invalidate, committed on ready.
// The fix leans on these exact transitions — a parallel state would drift.
assert.equal(
	searchStatus.match(/isReady: false/)?.length >= 1,
	true,
	"searchStatus must start isReady: false",
);
assert.ok(
	/index\/invalidate/.test(searchStatus) && /isReady: false/.test(searchStatus),
	"index/invalidate must clear isReady",
);
assert.ok(
	/index\/ready/.test(searchStatus) && /isReady: true/.test(searchStatus),
	"index/ready must set isReady",
);

// MasonryGrid consumes the hook's isReady (aliased indexReady) and passes it
// into the grid-search source object.
assert.ok(
	/isReady: indexReady/.test(masonry),
	"MasonryGrid must destructure isReady as indexReady from useMemorySearch",
);
assert.ok(
	/searchOcr,\s*\n\s*indexReady,/.test(masonry),
	"MasonryGrid must pass indexReady into the useGridSearch source",
);

// --- 2. Re-run on commit, no-op on invalidate ------------------------------

assert.ok(
	/indexReady: boolean;/.test(gridSearch),
	"GridSearchSource must declare indexReady: boolean",
);
assert.ok(
	/searchOcr,\s*\n\s*indexReady,/.test(gridSearch),
	"useGridSearch must destructure indexReady from its source",
);

// The re-run effect: readiness guard FIRST (no-op on false — stale results
// survive the wipe→refill window), then OCR-mode + query guards, then the
// same dispatch the typing path uses.
const rerun = gridSearch.match(
	/if \(!indexReady\) return;[\s\S]*?setSearchResults\(searchOcr\(trimmed, searchTopK\)\);/,
);
assert.ok(
	rerun,
	"useGridSearch must re-run the OCR search when indexReady flips true",
);
assert.ok(
	/if \(!ocrMode \|\| !trimmed\) return;/.test(rerun[0]),
	"the OCR re-run must be scoped to OCR mode with a non-empty query",
);
assert.ok(
	/searchSeqRef\.current\+\+/.test(rerun[0]),
	"the OCR re-run must bump the search sequence (late replies drop)",
);

// --- 3. Honest empty state --------------------------------------------------

// While the index is loading the tab must NOT claim "no matching text" —
// that message is reserved for an aligned index with a genuine zero-hit.
assert.ok(
	/!indexReady\s*\?\s*"The text index is still loading/.test(masonry),
	"OCR empty state must show the loading message while !indexReady",
);
assert.ok(
	/No images with matching text/.test(masonry),
	"OCR empty state must keep the genuine no-match message",
);
// Ordering pin: the loading tier sits between the drain-busy tier and the
// no-match tier, so a loading index can never fall through to "no match".
const busyIdx = masonry.indexOf("Text is still being read in the background");
const loadingIdx = masonry.indexOf("The text index is still loading");
const noMatchIdx = masonry.indexOf("No images with matching text");
assert.ok(
	busyIdx !== -1 && busyIdx < loadingIdx && loadingIdx < noMatchIdx,
	"OCR empty-state tiers must order: drain-busy → index-loading → no-match",
);

// --- 4. searchOcr self-heal + observability --------------------------------

// Missing/misaligned texts: kick the idempotent loader (recovers a failed
// load on the next keystroke) and warn once (the [] is silent by contract).
const searchOcrBlock = hook.match(
	/const searchOcr = useCallback\([\s\S]*?\n\t\);/,
);
assert.ok(searchOcrBlock, "useMemorySearch must export searchOcr");
assert.ok(
	/void loadIndexData\(\);/.test(searchOcrBlock[0]),
	"searchOcr must kick the idempotent index loader when texts are missing",
);
assert.ok(
	/ocrTextsMissingWarnedRef/.test(hook),
	"the missing-OCR-texts warning must be one-shot per session",
);
assert.ok(
	/\[ocr-search\]/.test(hook),
	"the warning must carry the [ocr-search] tag for observability",
);
// Identity stability: searchOcr deps only on the stable loader, so the main
// search effect's deps (which include searchOcr) never re-fire from this.
assert.ok(
	/\[loadIndexData\],?\s*\n\s*\);/.test(searchOcrBlock[0]),
	"searchOcr must depend only on the stable loadIndexData",
);

// --- 5. index reload live-lock (2026-10-28) ---------------------------------
// The reload debounce was re-armed on EVERY reloadIndex call, and the count
// self-heal fired per render (filenames is a fresh array identity each
// time) — the burst deferred the 150 ms load forever: one deep-smoke
// session logged 52k invalidates and ZERO commits, leaving ocrTextsRef null
// and isReady false all session (the OCR tab's "still loading" freeze).

// reloadIndex coalesces: a scheduled reload must never be re-armed.
const reloadBlock = hook.match(
	/const reloadIndex = useCallback\(async \(\) => \{[\s\S]*?\n\t\}, \[invalidateIndex, loadIndexData\]\);/,
);
assert.ok(reloadBlock, "useMemorySearch must export reloadIndex");
assert.ok(
	/if \(reloadTimerRef\.current\) return;/.test(reloadBlock[0]),
	"reloadIndex must early-return while a reload is already scheduled (debounce starvation)",
);
assert.ok(
	!/clearTimeout\(reloadTimerRef\.current\)/.test(reloadBlock[0]),
	"reloadIndex must never clear a pending reload timer",
);

// The loader releases its dedupe slot when an attempt settles — commit,
// stale-discard, or error — so a later kick starts a REAL fetch instead of
// returning a settled promise (one settled promise wedged the loader for
// whole sessions).
const loaderBlock = hook.match(
	/const loadIndexData = useCallback\(\(\): Promise<void> => \{[\s\S]*?\n\t\}, \[\]\);/,
);
assert.ok(loaderBlock, "useMemorySearch must export loadIndexData");
assert.ok(
	/loadPromiseRef\.current === promise/.test(loaderBlock[0]),
	"loadIndexData must release its dedupe slot on settle (identity-checked)",
);
assert.ok(
	/promise\.finally\(/.test(loaderBlock[0]),
	"loadIndexData must release the slot via .finally (covers stale-discards too)",
);

// The self-heal fires on a COUNT CHANGE, not per render — an unconditional
// reload here fed the starvation loop above.
assert.ok(
	/lastSeenFilenamesCountRef\.current = filenames\.length/.test(hook),
	"the count self-heal must only fire when the filenames count changes",
);

console.log("ocr-tab-ready: all wiring assertions passed");
