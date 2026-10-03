#!/usr/bin/env bash
# Super-ultra-deep verification battery: every smoke mode in the repo, each
# isolated in its own temp data dir (model cache + OCR traineddata symlinked
# for offline reuse). Fail-fast on any suite.
#
#   unit:    scene-planning math
#   smoke:   indexer worker (real SigLIP-2 embeds)
#   electron: e2e import + ranking (warm), then cold-restart persistence
#   electron: phase4 — scene pipeline + OCR + migration backfill + trays
#   electron: deep — the full-feature battery (33-file library, every UI)
#   electron: model migration round-trip + preload-all
#   electron: re-import skip semantics
#   electron: watched-folder auto-watch (persist + live sync + launch sync)
#   electron: failure cache (poison file retried 3×, then skipped until changed)
#   electron: rename dedupe (renamed file skipped by content hash)
#   electron: reveal-target resolution (source → library copy → null)
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODELS="$HOME/Library/Application Support/scm/models"
OCR_DATA="$HOME/Library/Application Support/scm/ocr-data"
LOG=/tmp/scm-battery.log
: >"$LOG"

FAILED=0
step() { echo ""; echo "=== $1 ===" | tee -a "$LOG"; }
note() { echo "    $1" | tee -a "$LOG"; }

# Fresh temp data dir with the model cache + OCR traineddata symlinked in.
# Whatever language files are present land in the scratch dir (eng + CJK at
# minimum); anything missing downloads on demand inside the smoke.
setup_tmp() {
	local prefix="$1"
	local tmp
	tmp="$(mktemp -d "/tmp/${prefix}-XXXX")"
	ln -s "$MODELS" "$tmp/models"
	mkdir -p "$tmp/ocr-data"
	for f in "$OCR_DATA"/*.traineddata; do
		[ -e "$f" ] || continue
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
	tail -6 "$LOG"
	return $ok
}

step "build: renderer bundle (smokes run electron ., which serves dist/)"
bun run build >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: scene-planning math"
bun run test:planning >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: watched-folder import chronology"
bun run test:import-order >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: image MIME sniffing (wrong-decoder crash guard)"
bun run test:mime-sniff >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: packaged-files guard (asar ships every prod require)"
bun run test:packaged-files >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

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

step "electron: llms — Settings UI click-path, downloaded states, evidence gate"
TMP13=$(mktemp -d "/tmp/scm-ask-e2e-XXXX")
ELECTRON_SMOKE_ASK=1 MEMORIES_DATA_DIR="$TMP13" "$ROOT/node_modules/.bin/electron" . >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "unit: OCR CJK languages (worker filter/join, settings, langs wiring)"
node test/ocr-cjk.test.js >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }
node test/ocr-email-glue.test.js >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }
bun test test/cjk-tokens.test.ts >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

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
REIMPORT_TEST_DIR="$(mktemp -d /tmp/scm-reimport-src-XXXX)"
electron_run "$TMP5" ELECTRON_SMOKE_REIMPORT=1 REIMPORT_TEST_DIR="$REIMPORT_TEST_DIR" || FAILED=1

step "electron: watched-folder — import a folder, auto-watch it, live-sync"
TMP8=$(setup_tmp scm-watched)
WATCH_TEST_DIR="$(mktemp -d /tmp/scm-watch-src-XXXX)"
electron_run "$TMP8" ELECTRON_SMOKE_WATCHED=import WATCH_TEST_DIR="$WATCH_TEST_DIR" || FAILED=1

step "electron: watched-folder — launch sync imports the new file (same data dir)"
electron_run "$TMP8" ELECTRON_SMOKE_WATCHED=sync WATCH_TEST_DIR="$WATCH_TEST_DIR" || FAILED=1

step "electron: failure cache — poison file retried 3×, then skipped until changed"
TMP9=$(setup_tmp scm-failcache)
FAILCACHE_TEST_DIR="$(mktemp -d /tmp/scm-failcache-src-XXXX)"
electron_run "$TMP9" ELECTRON_SMOKE=1 ELECTRON_SMOKE_FAILCACHE=1 FAILCACHE_TEST_DIR="$FAILCACHE_TEST_DIR" || FAILED=1

step "electron: rename dedupe — renamed file skipped by content hash"
TMP10=$(setup_tmp scm-renamededupe)
RENAMEDEDUPE_TEST_DIR="$(mktemp -d /tmp/scm-renamededupe-src-XXXX)"
electron_run "$TMP10" ELECTRON_SMOKE=1 ELECTRON_SMOKE_RENAMEDEDUPE=1 RENAMEDEDUPE_TEST_DIR="$RENAMEDEDUPE_TEST_DIR" || FAILED=1

step "electron: reveal-target resolution (source → copy → null)"
TMP6=$(setup_tmp scm-reveal)
REVEAL_DIR="$(mktemp -d /tmp/scm-reveal-src-XXXX)"
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
else
	echo "SOME SMOKES FAILED — full log: $LOG" | tee -a "$LOG"
	exit 1
fi
