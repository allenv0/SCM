# Releasing SCM

Distribution is **Homebrew-only and manual**. Users install via:

```bash
brew tap allenv0/scm
brew trust allenv0/scm
brew install --cask allenv0/scm/scm
```

There are two repos involved:

| Repo | Role |
| ---- | ---- |
| `allenv0/SCM-dev` (private, this checkout) | Source of truth. The DMG is built here. |
| `allenv0/homebrew-scm` (public tap, local clone at `../homebrew-scm`) | Hosts the versioned DMG on its Releases page and the cask (`Casks/scm.rb`) that points at it. |

Direct-DMG distribution via `allenv0/scm-dmg` is retired — do not upload new
assets there. (Its old releases are stale; point its README at the tap if
you touch it.)

## Prerequisites

- Apple Silicon Mac with your Apple Development certificate in the keychain
  (electron-builder auto-discovers it; without one the build is unsigned —
  still installable via the tap since the cask strips quarantine, but
  signed is preferred).
- `gh` authenticated as `allenv0` with `repo` scope.
- `../homebrew-scm` clone present and on `main`.

## Release steps (example: 0.2.6)

1. **Bump + commit.** Set `"version": "0.2.6"` in `package.json`, commit on
   `SCM-dev` `main`.
2. **Build.** `bun run dist` → expect `dist-app/SCM-0.2.6-arm64.dmg`
   (~1.3 GB). Double-click smoke-launch it once from Finder.
   (`dist-app/` is gitignored — build artifacts never get committed.)
3. **Checksum.** `shasum -a 256 dist-app/SCM-0.2.6-arm64.dmg` → save the hash.
4. **Publish the DMG.** Keep the `v`-prefixed tag scheme this repo uses:
   ```bash
   gh release create v0.2.6 --repo allenv0/homebrew-scm \
     --title "SCM 0.2.6" --notes "<1-2 lines of user-facing changes>" \
     dist-app/SCM-0.2.6-arm64.dmg
   ```
5. **Bump the cask.** In `../homebrew-scm`, set `version "0.2.6"` and the new
   `sha256` in `Casks/scm.rb`, commit, push. Tap CI (`test-bot` tap-syntax,
   `audit --cask --online`, `style`) is the gate — watch it go green before
   announcing.
6. **Verify as a user.**
   ```bash
   brew update && brew upgrade --cask allenv0/scm/scm
   xattr -p com.apple.quarantine /Applications/SCM.app
   ```
   The `xattr` call must answer `No such xattr`, and the app must launch
   with no Gatekeeper dialog.

## Notes

- The cask's `postflight_steps` block clears `com.apple.quarantine` on every
  install/reinstall/upgrade. It uses the structured `*_steps` form because
  legacy `postflight do` is deprecated in Homebrew 7+. Only
  `com.apple.quarantine` is stripped; `com.apple.provenance` stays.
- Cask style rules that have bitten before: `depends_on arch:` sorts before
  `depends_on macos:`, and multi-line hash keys must align (`brew style
  --fix` autocorrects both).
- `brew audit --cask --online` downloads the full 1.3 GB DMG. On throttled
  connections this can take very long locally — rely on tap CI (fast
  runners) for the online gate; local `audit --cask` + `style` still catch
  everything else.
- Tag discipline: `homebrew-scm` releases use `v0.2.6` tags and
  `SCM-0.2.6-arm64.dmg` asset names; the cask `url` interpolates both from
  `version`, so keep all three in agreement.
- Website (`scm-website`) Download button opens the brew modal and both
  READMEs point at the tap — no per-release website changes needed.
- Phase 2 (when enrolled in the Apple Developer Program): sign with a
  Developer ID + notarize + staple, then delete the `postflight_steps`
  quarantine block from the cask — Gatekeeper will pass with quarantine
  intact.
