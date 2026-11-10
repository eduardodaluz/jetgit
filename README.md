# JetGit

Changelists, shelves, local history, inline blame and branch compare for Git — a calmer, more capable source control workflow for VS Code and VSCodium.

JetGit's interaction model is inspired by IntelliJ's VCS UX (the behavior — not the code — informed the design): named **changelists** that receive your new changes, **shelves** you can apply any number of times, a **Local History** that works even without any Git repository, author-colored **inline blame**, and a **Compare** view against any branch, tag or ref.

- **Zero telemetry. Zero accounts. Zero AI.** No network calls, ever.
- **MIT licensed.** No feature gates, no paywalls, no private-repo limits.
- **Sidecar architecture.** JetGit never replaces or fights the built-in Git integration: the native commit button, input box and merge editor keep working exactly as before. JetGit adds its own views and commands on top.

## Features (in development — milestone status)

| Feature | Status | Notes |
|---|---|---|
| Changelists | milestone 2 | Named groups of modified files; new changes join the active changelist; per-changelist commit that preserves your index |
| Shelves | milestone 3 | Patch-based shelves (not stashes): apply any number of times, "Save to Shelf" without reverting, soft-delete + restore |
| Local History | milestone 4 | Automatic snapshots on save and external change; restore deleted files; labels; works with no Git repo |
| Inline blame | milestone 5 | Current-line by default (zero-config), author-based coloring, rich hover |
| Compare with ref | milestone 6 | Incoming/outgoing commits + color-coded changed-file matrix; "Get from Branch" |

## Coexistence with the built-in Git

JetGit ships inline blame alongside the built-in one. If you prefer only one blame annotation, the built-in decorations are controlled by `git.blame.editorDecoration.enabled` and `git.blame.statusBar.enabled` — JetGit never touches your settings for you.

## Building from source

```bash
npm ci
npm run check-types   # tsc --noEmit
npm test              # unit (vitest) + integration (@vscode/test-electron on fixture repos)
npm run package       # vsce package → jetgit-<version>.vsix
```

Requires Node 20+ and git ≥ 2.31. F5 in this workspace launches the Extension Development Host.

## Requirements

- VS Code or VSCodium ≥ 1.145
- The built-in Git extension enabled (except for Local History, which also works in plain folders)
- git CLI on PATH, version ≥ 2.31

## License

MIT — see [LICENSE](LICENSE).
