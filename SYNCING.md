# Syncing to the public repo

Feature work happens in this repo (`allenv0/SCM-dev`, private). The public
repo (`allenv0/SCM`, local clone at `../SCM-public`) is a **curated subset**
of this one — dev notes, fixtures, review shots, and release tooling stay
private.

The two repos share **no commit history**, so sync is file-copy based.
Never `git merge`, `cherry-pick`, or open a PR between them — those commands
require common ancestors that don't exist.

## Exclude list (stays private)

Do not copy these to the public repo:

- `MDs/` — design docs, bench reports, plans
- `COMMANDS.md` — agent working conventions (dev-only notes)
- `AGENTS.md` — agent working notes, long-form sibling of `COMMANDS.md`
- `docs/ts-migration.md` — internal TS-migration plan and status notes
- `docs/dev-doc.md` — long-form development guide (private notes)
- `docs/effect-adoption-report.md` — internal architecture evaluation
- `.DS_Store` files — macOS Finder metadata (untracked junk, never curated)
- `assets/` — private asset sources
- `eng.traineddata` — raw OCR data kept out of the public tree
- `review-screenshots/` — review captures
- `RELEASING.md` — this repo's release runbook (public releases ship via the
  Homebrew tap; see that file)
- `dist/`, `dist-app/`, `dist-main/` — build outputs (gitignored anyway)
- Root `*.gif` / `*.png` (e.g. `1.gif`, `tabs.png`) — public equivalents live
  under `Asset/` with different names
- `scripts/coreml/fixtures/images/` — benchmark fixtures
- `photokit/`, `scripts/mlx-sidecar/`, `.tools/` — untracked local
  build/cache/toolchain outputs
- `scripts/sync-public.sh` — the sync tool itself (this file's executable
  twin; it only makes sense beside a private `../SCM-public` clone)
- `.gitignore`, `README.md`, `Asset/` paths — merge by hand; the public
  versions are adapted (different tagline/images, Homebrew Download section)

When in doubt, leave it out — anything with secrets, tokens, personal paths,
or PII must never cross into the public tree (that's the reason for the
split; see the "Public-push hygiene" history).

## Sync procedure (per feature or per release)

1. **Dry run.** From this repo root:
   ```bash
   bash scripts/sync-public.sh
   ```
   The script holds the exclude list (below), uses `--checksum` (macOS ships
   openrsync, whose quick check is size+mtime only — a same-size,
   same-second edit is otherwise invisible), and prints only changed paths,
   so the itemized list is the review.
   (`README.md`, `.gitignore`, and `Asset/` are excluded from the blind copy
   and merged by hand per the notes above.)
2. **Copy.** Re-run with `--apply` once the list is approved. It copies,
   then hard-fails on a version mismatch, any private path present in the
   public tree, personal absolute paths, or token-shaped strings — do not
   commit a tree that fails those assertions.
3. **Align version.** `--apply` copies `package.json`, so the two repos
   advertise the same version; the script prints both and fails on drift.
4. **Test the pruned tree.** In `../SCM-public`: `bun install`, `bunx tsc
   --noEmit`, and the unit suites. The public tree must stand alone without
   the excluded paths.
5. **Commit + push public.** Commit in `../SCM-public` with a message naming
   the feature (e.g. `Sync dialogue tiering + 0.2.6 version alignment`),
   push to `allenv0/SCM` `main`.
