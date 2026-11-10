# Changelog

All notable changes to JetGit are documented here.

## [0.1.0] — 2026-11-10 (in development)

### Added (milestone 3 — shelves)
- **Shelves**: named patches (IntelliJ semantics — not stashes). Apply any number of times; "Save to Shelf" copies without reverting; soft-delete with restorable trash.
- **Shelve Changes** reverts working files (tracked → index version, untracked → removed); **Apply** lands per file with `--3way`, so one conflicted file shows merge-conflict markers without blocking the rest.
- Shelve straight from a changelist's context menu, or pick a scope via QuickPick.
- Binary files and deleted files supported byte-exact (`git diff --binary`); CRLF handled by git itself (repo-config driven).
- Repository state changes now detected via a per-repo signature poller — the public vscode.git API v1 does not expose repository change events on all builds (fixes "failed to attach to repository" on VSCodium).

### Added (milestone 2 — changelists)
- **Changelists**: named groups of uncommitted files with one active changelist receiving new changes (IntelliJ-style auto-assign).
- **Commit a changelist** via `git commit --only`: commits exactly the member files while preserving your existing index (non-member staged files stay staged); untracked members are added and rolled back exactly on failure; hard-block during merge/revert/cherry-pick; commit message pre-filled from the changelist comment.
- Changelists TreeView in the JetGit container with drag-and-drop between changelists, "Move to Changelist…" quick pick (multi-select), active-changelist emphasis, and per-changelist comments shown as descriptions.
- Persistence at `<gitDir>/jetgit/changelists.json` — per-clone IDE metadata that survives workspace-data clearing and stays isolated per worktree in linked worktrees.
- Graceful degradation when the built-in Git extension is disabled (views show a hint; no activation errors).
- Integration tests against real git: partial-commit index preservation, hook-failure rollback, worktree isolation; Windows-tolerant test cleanup (git loose objects are read-only on Windows).

### Added (milestone 1 — scaffold)
- Extension scaffold: activity-bar container with Changelists, Shelves and Compare views (Changelists real since M2; Shelves/Compare placeholders).
- vscode.git bridge with graceful degradation when the built-in Git extension is disabled.
- Unit test harness (vitest) and integration harness (@vscode/test-electron on generated git fixture repos, with stale-instance cleanup so failed runs never accumulate test windows).
- CI matrix (Windows + Linux): type check, unit, integration, VSIX packaging.
- Raw git CLI execution module with Windows-safe discipline (args arrays, NUL pathspec files, no optional locks).

