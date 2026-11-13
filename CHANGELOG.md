# Changelog

All notable changes to JetGit are documented here.

## [0.1.0] — 2026-11-10 (in development)

### Added (milestone 6.8 — merge conflict experience)
- **Merge-in-progress banner** in the Changelists view: a "Merge / Cherry-pick / Revert / Revert in progress" node with the live conflict count sits above your changelists while any git operation is running; with every conflict resolved it flips to "Conflicts resolved — ready to commit". When nothing is in progress the view is exactly as before.
- **Accept Yours / Accept Theirs** per conflicted file (multi-select works): one click resolves a conflict the familiar way — the winning side is checked out into the working tree and STAGED, the losing side removed. Every unmerged code gets the right plan, including modify/delete conflicts (deleted-elsewhere files resolve by staging or by `git rm`, never by accident). During a rebase the file tooltip explains that the sides swap.
- **Open Merge Editor** on a conflicted file routes to the native VS Code 3-way merge editor (per-conflict Accept Current/Incoming, rename-aware); "Open File" opens the raw conflicted content.
- **Complete Merge…** commits the finished operation with a pre-filled message (git's own MERGE_MSG, cursor at the end), refuses politely while conflicts remain, and concludes rebases with `rebase --continue` (editor guard included so nothing hangs). **Abort** (merge / cherry-pick / revert / rebase) restores the repository to its pre-operation state after a modal confirm.
- The probe is event-driven and read-only: operation markers are checked on the absolute git dir (worktree-safe) and the conflict set comes from one `git status --porcelain=v1 -z`, so conflicted paths never pollute changelists and resolving a file lands it in the staged changes (where it walks into the merge commit naturally).

### Added (milestone 6.7 — hunk-level commit inclusion)
- **Commit checkboxes per change hunk in the diff editor**: the change review diff now shows a clickable "include/exclude in commit" lens on every changed hunk plus a "N differences, M included in commit" counter (VS Code has no interactive gutter checkboxes — CodeLens is the checkbox; a gutter mark keeps the state visible).
- **Partial commits**: commit exactly the marked hunks of a file — one fix inside a big edit — built through a throwaway index (`GIT_INDEX_FILE` + read-tree/hash-object/commit) so the WORKTREE is never touched and the user's real index only syncs after success; pre-commit hooks run against exactly what is committed; failures are atomic. Whole-file-only commits keep the proven `--only` path.
- **Files now start UNCHECKED** in the Changelists view (IntelliJ parity): you mark what joins. A file with included hunks shows "i/n hunks" in its description and joins the commit with just those lines; partial state survives closing the diff and line shifts above a hunk (content signatures, not line numbers).
- Inclusion state is pruned on reconcile, folded back to plain checked/unchecked when it reaches all/none, and cleared on commit. Staged deltas consumed by a partial commit are reported, never silent. `jetgit.changes.maxFileSizeKB` and binary guards apply.

### Added (milestone 6.6 — commit selection & action menu)
- **Commit checkboxes** in the Changelists view: every file carries a checkbox that decides whether it joins the next commit (IntelliJ parity) — new files start checked; the changelist checkbox checks/unchecks all its files. One VS Code limitation, compensated: the checkbox has no visual "partially checked" state, so it shows checked only when every file is included.
- **Commit Changelist… commits the checked subset** (leaving the unchecked files in the working tree); **Commit Files…** on a multi-selection commits those files directly, overriding checkboxes — IntelliJ semantics.
- **Refresh** button in the view title forces a status reconcile across repositories.
- File context menu reordered to match the familiar flow: Commit Files…, Rollback File to HEAD, Move to Changelist…, Open Change Diff, Open File.

### Added (milestone 6.5 — commit review + partial rollback)
- **Open Change Diff**: clicking a changelist file now opens a side-by-side diff of HEAD ↔ the live working file — the right pane is a real editor, so you review AND edit in the same tab (the plain file stays on the context menu under "Open File").
- **Rollback Selected Lines to HEAD**: select lines in EITHER pane of the diff (editor title button or context menu) and revert only the hunks under the selection — the rest of the file keeps its local edits. One `WorkspaceEdit`, one modal confirm (`jetgit.changes.confirmRollback`), undoable with Ctrl+Z, buffer stays dirty per your autosave settings.
- **Staged work is safe by design**: the rollback base is always HEAD, never the index; the index is never touched, so staged content survives any rollback operation (staged-vs-worktree deltas remain visible afterwards, as intended).
- **Rollback File to HEAD**: whole-file rollback (worktree ← index version, IntelliJ parity) with a modal confirm; untracked files are deleted after an explicit confirm; locally deleted tracked files are restored; a dirty open editor is warned about and reloaded so a later save can't silently undo the rollback.
- Precision guarantees, integration-tested: byte-exact round-trips including trailing-newline transitions in both directions, deletions restored via left-pane selection, CRLF files without `\r` doubling, repo-scoped isolation in multi-root workspaces; `jetgit.changes.maxFileSizeKB` (default 2048) and binary/non-UTF-8 guards keep the feature text-only.

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

