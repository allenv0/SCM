#!/usr/bin/env bash
# Super-ultra-deep verification battery: the core fail/pass smoke modes, each
# isolated in its own temp data dir (model cache symlinked in; OCR traineddata
# seeded only when the host has any — the first OCR downloads it, and the deep
# smoke then asserts it was actually cached). Every suite runs; the script
# exits non-zero if any failed (per-suite tails stay visible in the log).
#
#   unit:    full bun:test suite (test/) + curated node-style harnesses
#   smoke:   indexer worker (default CLIP ViT-L/14@336 embeds)
#   electron: e2e import + ranking (warm), then cold-restart persistence
#   electron: phase4 — scene pipeline + OCR + migration backfill + trays
#   electron: deep — the full-feature battery (33-file library, every UI)
#   electron: scenenoise — gibberish queries on a movie-heavy library
#   electron: model migration round-trip + preload-all
#   electron: re-import skip semantics
#   electron: watched-folder auto-watch (persist + live sync + launch sync)
#   electron: failure cache (poison file retried 3×, then skipped until changed)
#   electron: rename dedupe (renamed file skipped by content hash)
#   electron: youtube (offline fixtures: merge, info-lookup, backfill, silent repair)
#   electron: reveal-target resolution (source → library copy → null)
#   electron: cto — Week-1 fixes (prune guard, bin quarantine, atomic saves, sandbox, CSP, rank perf)
#   electron: grid — 50k-row virtualization
#   electron: llms — Settings click-path (self-skips while parked)
#
# Manual probes deliberately NOT in this battery (they need a real-library
# copy, or are benchmarks / screenshot reviews — see package.json smoke:*):
#   ELECTRON_SMOKE_OCR_HIGHLIGHT   scripts/e2e/ocr-highlight.js
#   ELECTRON_SMOKE_SEARCH_MATRIX   scripts/e2e/search-matrix.js
#   ELECTRON_SMOKE_UI_REVIEW       scripts/e2e/ui-review.js  (smoke:ui-review)
#   ELECTRON_SMOKE_PERF            test/perf-test.js         (smoke:perf)
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODELS="$HOME/Library/Application Support/scm/models"
OCR_DATA="$HOME/Library/Application Support/scm/ocr-data"
LOG=/tmp/scm-battery.log
: >"$LOG"

FAILED=0
STEP_NAME=""
step() { STEP_NAME="$1"; echo ""; echo "=== $1 ===" | tee -a "$LOG"; }
note() { echo "    $1" | tee -a "$LOG"; }

# Scratch-dir tracking (file-based: setup_tmp/new_dir run inside command
# substitution subshells, so a shell variable would not survive). On a green
# run every dir is removed; a failed run keeps them all for post-mortem.
TMP_LIST="$(mktemp /tmp/scm-battery-dirs-XXXX)"
trap 'rm -f "$TMP_LIST"' EXIT
new_dir() {
	local d
	d="$(mktemp -d "/tmp/${1}-XXXX")"
	echo "$d" >>"$TMP_LIST"
	echo "$d"
}

# Fresh temp data dir with the model cache symlinked in (created on demand —
# a cold machine would otherwise get a dangling symlink). OCR traineddata is
# seeded ONLY when the host has files: pre-creating an empty ocr-data/ would
# mask the app's own cache-dir setup, which the deep smoke asserts.
setup_tmp() {
	local prefix="$1"
	local tmp
	tmp="$(new_dir "$prefix")"
	[ -d "$MODELS" ] || mkdir -p "$MODELS"
	ln -s "$MODELS" "$tmp/models"
	for f in "$OCR_DATA"/*.traineddata; do
		[ -e "$f" ] || continue
		[ -d "$tmp/ocr-data" ] || mkdir -p "$tmp/ocr-data"
		ln -s "$f" "$tmp/ocr-data/"
	done
	echo "$tmp"
}

# One Electron launch: MEMORIES_DATA_DIR + whatever env flags are passed.
# (node_modules/.bin — npm adds it to PATH, a bare bash script does not.)
# "$@" carries NAME=value env pairs; env(1) applies them because stock macOS
# bash 3.2 mis-parses multiple EXPANDED assignment words — with
# MEMORIES_DATA_DIR="$tmp" "$@" "electron" ., bash would take the second
# expanded pair (ELECTRON_SMOKE=1) as the command and fail with "command not
# found".
electron_run() {
	local tmp="$1"
	shift
	env MEMORIES_DATA_DIR="$tmp" "$@" "$ROOT/node_modules/.bin/electron" . >>"$LOG" 2>&1
	local ok=$?
	# Per-step exit code: a suite can pass every assertion and still exit
	# non-zero (a late quit-drain error) — make that visible per step.
	echo "    [exit $ok] $STEP_NAME" >>"$LOG"
	tail -6 "$LOG"
	return $ok
}

step "build: renderer bundle (smokes run electron ., which serves dist/)"
bun run build >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: full bun:test suite (test/ — node-style harnesses included)"
bun test test/ >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: scene-planning math"
bun run test:planning >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: watched-folder import chronology"
bun run test:import-order >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: image MIME sniffing (wrong-decoder crash guard)"
bun run test:mime-sniff >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: packaged-files guard (asar ships every prod require)"
bun run test:packaged-files >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: main-load harness (headless require of main.js, stubbed electron)"
bun run test:main-load >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: IPC bridge drift (table ↔ preload ↔ registration ↔ MemoriesBridge)"
bun run test:ipc-bridge >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: All/File media chronology"
bun run test:media-order >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: pumpEnrichment multi-chunk segment accumulation"
bun run test:pump-enrichment >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: pumpTranscription multi-chunk transcript accumulation"
bun run test:pump-transcription >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: transcript-fusion speech index (chunking, store, fusion, worker, contracts)"
bun run test:transcript-fusion >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: transcript-deep (clone proof, commit path, paging, stress, real speech)"
bun run test:transcript-deep >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: transcript-dialogue-rank (literal matrix, boost/gate, compact, backfill, real tower)"
bun run test:transcript-dialogue-rank >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: dialogue-exact v3 (stem keys, tiers, snippet/seek, caps, wiring)"
bun run test:dialogue-exact >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: transcribe-audio-probe (silent vs audio fixtures, stub repair)"
bun run test:transcribe-audio-probe >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: whisper-model ladder (parse, timeouts, worker, stamp, picker)"
bun run test:whisper-model >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: Ask mode (LLM registry, evidence retrieval, sidecar lifecycle, scope parse)"
bun run test:ask >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "electron: llms — Settings UI click-path, downloaded states, evidence gate (self-skips while parked)"
TMP13=$(new_dir scm-ask-e2e)
electron_run "$TMP13" ELECTRON_SMOKE_ASK=1 || FAILED=1

step "unit: OCR CJK languages (worker filter/join, settings, langs wiring)"
bun run test/ocr-cjk.test.js >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }
bun run test/ocr-email-glue.test.js >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }
bun test test/cjk-tokens.test.ts >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }
bun test test/token-parity.test.ts >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }
bun test test/ipc-error.test.ts >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "smoke: indexer worker (default CLIP ViT-L/14@336 model)"
TRANSFORMERS_CACHE="$MODELS" bun run smoke:indexer >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "electron: e2e import + semantic ranking (warm)"
TMP1=$(setup_tmp scm-e2e)
electron_run "$TMP1" ELECTRON_SMOKE=1 ELECTRON_SMOKE_E2E=1 || FAILED=1

step "electron: e2e cold-restart persistence (same data dir)"
electron_run "$TMP1" ELECTRON_SMOKE=1 ELECTRON_SMOKE_E2E=1 ELECTRON_SMOKE_COLD=1 || FAILED=1

step "electron: phase4 — scene pipeline + OCR + backfill + trays"
TMP2=$(setup_tmp scm-phase4)
electron_run "$TMP2" ELECTRON_SMOKE=1 ELECTRON_SMOKE_PHASE4=1 || FAILED=1

step "electron: deep — full-feature battery (33-file library, every UI path)"
TMP3=$(setup_tmp scm-deep)
electron_run "$TMP3" ELECTRON_SMOKE=1 ELECTRON_SMOKE_DEEP=1 || FAILED=1

step "electron: scenenoise — gibberish queries get no scene matches on a movie-heavy library"
TMP7=$(setup_tmp scm-scenenoise)
electron_run "$TMP7" ELECTRON_SMOKE=1 ELECTRON_SMOKE_SCENENOISE=1 || FAILED=1

step "electron: model migration round-trip + preload-all"
TMP4=$(setup_tmp scm-migrate)
electron_run "$TMP4" ELECTRON_SMOKE_MIGRATE=1 || FAILED=1

step "electron: re-import skip semantics"
TMP5=$(setup_tmp scm-reimport)
REIMPORT_TEST_DIR="$(new_dir scm-reimport-src)"
electron_run "$TMP5" ELECTRON_SMOKE_REIMPORT=1 REIMPORT_TEST_DIR="$REIMPORT_TEST_DIR" || FAILED=1

step "electron: watched-folder — import a folder, auto-watch it, live-sync"
TMP8=$(setup_tmp scm-watched)
WATCH_TEST_DIR="$(new_dir scm-watch-src)"
electron_run "$TMP8" ELECTRON_SMOKE_WATCHED=import WATCH_TEST_DIR="$WATCH_TEST_DIR" || FAILED=1

step "electron: watched-folder — launch sync imports the new file (same data dir)"
electron_run "$TMP8" ELECTRON_SMOKE_WATCHED=sync WATCH_TEST_DIR="$WATCH_TEST_DIR" || FAILED=1

step "electron: failure cache — poison file retried 3×, then skipped until changed"
TMP9=$(setup_tmp scm-failcache)
FAILCACHE_TEST_DIR="$(new_dir scm-failcache-src)"
electron_run "$TMP9" ELECTRON_SMOKE=1 ELECTRON_SMOKE_FAILCACHE=1 FAILCACHE_TEST_DIR="$FAILCACHE_TEST_DIR" || FAILED=1

step "electron: rename dedupe — renamed file skipped by content hash"
TMP10=$(setup_tmp scm-renamededupe)
RENAMEDEDUPE_TEST_DIR="$(new_dir scm-renamededupe-src)"
electron_run "$TMP10" ELECTRON_SMOKE=1 ELECTRON_SMOKE_RENAMEDEDUPE=1 RENAMEDEDUPE_TEST_DIR="$RENAMEDEDUPE_TEST_DIR" || FAILED=1

step "electron: youtube — merge, info-lookup, backfill, silent-repair, archive-clear (offline fixtures)"
TMP14=$(setup_tmp scm-youtube)
electron_run "$TMP14" ELECTRON_SMOKE=1 ELECTRON_SMOKE_YOUTUBE=1 || FAILED=1

step "electron: reveal-target resolution (source → copy → null)"
TMP6=$(setup_tmp scm-reveal)
REVEAL_DIR="$(new_dir scm-reveal-src)"
electron_run "$TMP6" ELECTRON_SMOKE_REVEAL=import REVEAL_TEST_DIR="$REVEAL_DIR" || FAILED=1
mv "$REVEAL_DIR/source/fallback-test.jpg" "$REVEAL_DIR/source/moved-away.jpg"
electron_run "$TMP6" ELECTRON_SMOKE_REVEAL=verify REVEAL_TEST_DIR="$REVEAL_DIR" || FAILED=1

step "electron: cto — Week-1 fixes (prune guard, bin quarantine, atomic saves, sandbox, CSP, rank perf)"
TMP11=$(setup_tmp scm-cto)
electron_run "$TMP11" ELECTRON_SMOKE=1 ELECTRON_SMOKE_CTO=1 || FAILED=1

step "electron: grid — 50k-row virtualization (bounded tiles, reachable ends, stable span)"
TMP12=$(setup_tmp scm-grid)
MEMORIES_DATA_DIR="$TMP12" node "$ROOT/scripts/perf-grid-fixture.js" >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }
electron_run "$TMP12" ELECTRON_SMOKE=1 ELECTRON_SMOKE_GRID=1 || FAILED=1

echo "" | tee -a "$LOG"
if [ "$FAILED" -eq 0 ]; then
	echo "ALL SMOKES PASSED — full log: $LOG" | tee -a "$LOG"
	# Green run: leave nothing behind. A failed run keeps every scratch dir
	# (each electron_run tails its step into the log before we get here).
	while read -r d; do
		[ -n "$d" ] && rm -rf "$d"
	done <"$TMP_LIST"
else
	echo "SOME SMOKES FAILED — full log: $LOG" | tee -a "$LOG"
	echo "scratch dirs kept for debugging:" | tee -a "$LOG"
	cat "$TMP_LIST" | tee -a "$LOG"
	exit 1
fi
