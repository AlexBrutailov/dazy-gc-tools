# DAZY GC Process Tools

GitHub Pages package for GetCourse process tools.

## Files

- `process-tools/safety-guard/v0.1.0/DAZY-GC-Process-Safety-Guard.js`
- `process-tools/fast-editor/v1.4.0/DAZY-GC-Process-Fast-Editor.js`
- `process-tools/minimap/v0.5.0/DAZY-GC-Process-Minimap.js`
- `launcher-examples/smart/DAZY-GC-Process-Tools-Launcher.js`

## GitHub Pages

1. Create a public repository named `dazy-gc-tools`.
2. Upload the contents of this archive to the repository root.
3. GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**.
4. Branch: `main`, folder: `/(root)`, Save.
5. Wait until Pages publishes `https://YOUR_USERNAME.github.io/dazy-gc-tools/`.
6. In the SMART launcher replace only `REPLACE_WITH_GITHUB_USERNAME`.
7. In GetCourse keep only the launcher file. Remove Fast Editor and Minimap from theme additional files after GitHub loading is verified.

## Safety design

- Launcher owns project-specific account/user/process allowlists.
- Safety Guard is loaded first.
- A persistent full-process baseline is stored in browser localStorage and survives F5/browser restart.
- More than 16 selected blocks are blocked by default. The exact selected group can be allowed once for 60 seconds. Before the permitted movement, its coordinates are persisted.
- Baseline and movement restores compare current server coordinates first and only restore blocks that differ.
- Fast Editor and Minimap are universal; they read project restrictions from `window.DAZY_PROCESS_TOOLS_CONFIG`.
- Minimap has no `setMatrix` path.
