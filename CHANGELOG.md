# Changelog

All notable changes to JetGit are documented here.

## [0.1.0] — 2026-11-10 (in development)

### Added (milestone 6 — compare with ref)
- **Compare with Branch, Tag or Ref…**: outgoing/incoming commit counts and lists against any ref, with IntelliJ-parity file classes carried by theme colors — green = only here, gray = only at the ref, blue = differs (counts are exact; commit lists cap at `jetgit.compare.maxCommitEntries` with a "+N more" entry).
- **Compare view** in the JetGit container: Outgoing / Incoming / Changed-files sections; click a commit for its per-commit file diffs (via `jetgit-ref:`), click a file for a side-by-side diff against the compared ref.
- **Compare Working Tree with Ref…**: same matrix against uncommitted (tracked) state — deletions and local edits the committed compare cannot see.
- **Get from Branch**: overwrite a file's working-tree content with its version from the compared ref (modal confirm; recreated for locally deleted files; not offered for renames or local-only files).
- The active comparison recomputes itself (debounced, generation-token protected) on repository changes, so counts never go stale; Clear Comparison button appears while a comparison is active. Multi-root workspaces pick the repository when the active editor gives no answer.

### Added (milestone 5 — inline blame)
- **Inline blame** with three modes (`jetgit.blame.mode`): off, current line (default), whole file — `git blame --porcelain` via the same git binary as the built-in extension, `-L` scoped per cursor line so huge files stay fast (5k lines ≈ 90 ms).
- **Author coloring**: authors map deterministically to 8 line-highlight buckets per color-theme kind; high-contrast themes get text-only annotations (no backgrounds).
- **Rich hover**: subject, short SHA, author, date and (on the cursor line) full commit body, with **Open Commit** (file picker → per-file diff against the parent via the new `jetgit-ref:` content provider) and **Copy Commit SHA** links.
- Format template `jetgit.blame.format` (`{author}`, `{date}`, `{sha}`, `{email}`, `{summary}`), whitespace-ignoring blame (`jetgit.blame.ignoreWhitespace`), and a size cap (`jetgit.blame.maxFileSizeKB`).
- One-time hint about the built-in Git blame decoration — JetGit never mutates other extensions' settings.

### Added (milestone 4 — local history)
- **Local History**: automatic full snapshots (gzip) on every save and external file change — completely independent of Git, works in plain folders.
- **Restore to any point** via command or the native **Timeline tab** (per file), with diff previews between any snapshot and the working tree.
- **Restore deleted files**: deletions are recorded as tombstones; the pre-delete content is recoverable byte-identical (directory deletes tombstone all indexed children).
- **Put Label**: named snapshots that retention never evicts.
- Retention: 5 days by default (IntelliJ parity), max 50 snapshots per file, 2 MB file-size cap, binary files skipped, storage usage report + Clear All.
- Product invariant, tested structurally: snapshotting is fire-and-forget — it can never block or fail a save.

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

