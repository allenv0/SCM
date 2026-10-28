# Working with your agent

Standing prompt conventions for this repo. Say one of these and the agent
executes — no re-planning needed.

| Prompt | What runs |
| ------ | --------- |
| `go sync` | Full ship: public sync (`SYNCING.md`) + brew release (`RELEASING.md`) + user-side verification (`brew upgrade` + quarantine check). |
| `go sync 0.2.6` | Same as `go sync`, pinned to the named version. |
| `go sync --skip-public` | Brew-only rebuild: skip the `SCM-public` sync, cut the release from the current private tree. |
| `go` (bare) | Execute whatever plan was just discussed. |

Order is always public sync first, brew release second — a version users can
update to only exists once both are done. Details live in `SYNCING.md` (how
code goes public) and `RELEASING.md` (how the DMG reaches users).
