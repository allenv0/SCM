#!/usr/bin/env bash
# Copy the curated dev tree into the public repo (see SYNCING.md).
#
# The two repos share no commit history, so this is a file copy, never a
# merge. Dry-run by default: prints the itemized change list computed with
# --checksum (macOS openrsync's quick check is size+mtime only, so a
# same-size same-second edit is otherwise invisible). Pass --apply to copy
# and run the leak + version assertions.
#
#   bash scripts/sync-public.sh            # review what would change
#   bash scripts/sync-public.sh --apply    # copy + verify
#
# Target defaults to ../SCM-public; override with SCM_PUBLIC_DIR=/path.
# The exclude list below IS the private/public boundary — edit it there and
# in SYNCING.md together.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${SCM_PUBLIC_DIR:-$ROOT/../SCM-public}"
APPLY=0

for arg in "$@"; do
	case "$arg" in
		--apply) APPLY=1 ;;
		-h | --help)
			sed -n '2,18p' "$0"
			exit 0
			;;
		*)
			echo "unknown argument: $arg" >&2
			exit 2
			;;
	esac
done

[ -d "$TARGET/.git" ] || {
	echo "not a git clone: $TARGET" >&2
	exit 1
}
TARGET="$(cd "$TARGET" && pwd)"

# Stays private: dev notes, internal docs, assets/fixtures, build outputs,
# local toolchains, and the public repo's hand-merged files (README,
# .gitignore, Asset/ — see SYNCING.md).
EXCLUDES=(
	--exclude 'MDs/'
	--exclude 'assets/'
	--exclude 'COMMANDS.md'
	--exclude '.DS_Store'
	--exclude 'eng.traineddata'
	--exclude 'review-screenshots/'
	--exclude 'RELEASING.md'
	--exclude 'SYNCING.md'
	--exclude 'AGENTS.md'
	--exclude 'docs/ts-migration.md'
	--exclude 'docs/dev-doc.md'
	--exclude 'docs/effect-adoption-report.md'
	--exclude 'dist/'
	--exclude 'dist-app/'
	--exclude 'dist-main/'
	--exclude '/*.gif'
	--exclude '/*.png'
	--exclude 'scripts/coreml/fixtures/images/'
	--exclude 'photokit/'
	--exclude 'scripts/mlx-sidecar/'
	--exclude 'scripts/sync-public.sh'
	--exclude '.tools/'
	--exclude '.git/'
	--exclude 'node_modules/'
	--exclude '.gitignore'
	--exclude 'README.md'
	--exclude 'Asset/'
)

RSYNC=(rsync -a --checksum --delete --itemize-changes "${EXCLUDES[@]}")

cd "$ROOT" || exit 1

echo "source: $ROOT"
echo "target: $TARGET"
echo "mode:   $([ "$APPLY" = 1 ] && echo apply || echo 'dry run (--apply to copy)')"
echo ""

# The itemized list is the review: only changed paths print. A bare
# "Transfer starting: N files" line is the count considered, not transfers.
if [ "$APPLY" = 1 ]; then
	"${RSYNC[@]}" ./ "$TARGET/" || {
		echo "rsync failed" >&2
		exit 1
	}
else
	"${RSYNC[@]}" --dry-run ./ "$TARGET/"
fi

echo ""
echo "== version parity"
dev_ver="$(node -p 'require("./package.json").version')"
pub_ver="$(node -p 'require(process.argv[1]).version' "$TARGET/package.json")"
echo "dev=$dev_ver public=$pub_ver"
if [ "$dev_ver" != "$pub_ver" ]; then
	if [ "$APPLY" = 1 ]; then
		echo "VERSION MISMATCH after copy — the sync is not releasable" >&2
		exit 1
	fi
	echo "(dry run: --apply would align this)"
fi

if [ "$APPLY" = 0 ]; then
	echo ""
	echo "Dry run only. Review the list above, then re-run with --apply."
	exit 0
fi

echo ""
echo "== leak assertions"
fail=0

PRIVATE_PATHS=(
	MDs AGENTS.md SYNCING.md RELEASING.md COMMANDS.md
	assets review-screenshots eng.traineddata .tools photokit
	docs/ts-migration.md docs/dev-doc.md docs/effect-adoption-report.md
	scripts/mlx-sidecar scripts/coreml/fixtures/images
	scripts/sync-public.sh
)
for p in "${PRIVATE_PATHS[@]}"; do
	# A directory only matters if it holds files: empty leftover dirs (a
	# local cache path someone mkdir'd) are harmless and git ignores them.
	if [ -d "$TARGET/$p" ]; then
		if [ -n "$(find "$TARGET/$p" -type f -print -quit 2>/dev/null)" ]; then
			echo "LEAK: $p/ is present in the public tree" >&2
			fail=1
		fi
	elif [ -e "$TARGET/$p" ]; then
		echo "LEAK: $p is present in the public tree" >&2
		fail=1
	fi
done

scan() {
	local label="$1"
	shift
	local hits
	hits="$(grep -rIl --exclude-dir=node_modules --exclude-dir=.git \
		--exclude-dir=dist --exclude-dir=dist-main --exclude-dir=dist-app \
		"$@" "$TARGET" 2>/dev/null || true)"
	if [ -n "$hits" ]; then
		echo "LEAK: $label" >&2
		echo "$hits" | sed "s|^$TARGET/||" >&2
		fail=1
	fi
}
scan "personal absolute paths" -e "/Users/Allen" -e "/home/[a-z]*/SCM"
scan "token-shaped strings" -E -e "ghp_[A-Za-z0-9]{20,}" -e "gho_[A-Za-z0-9]{20,}" \
	-e "github_pat_[A-Za-z0-9_]{20,}" -e "sk-[A-Za-z0-9]{24,}" -e "AKIA[0-9A-Z]{16}"

if [ "$fail" = 0 ]; then
	echo "OK — no private paths, personal paths, or token-shaped strings"
else
	echo "" >&2
	echo "Sync copied, but the leak assertions failed. Do NOT commit the" >&2
	echo "public tree until the paths above are resolved." >&2
	exit 1
fi

echo ""
echo "== next"
echo "cd $TARGET && bun install && bunx tsc --noEmit && bun test test/"
echo "then commit + push the public repo."
