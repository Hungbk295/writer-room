# Progress — spy-only-tauri

> **Plan:** [`spy-only-tauri.md`](./spy-only-tauri.md)  
> **Agent:** Grok  
> **Started:** 2026-08-09  
> **Finished:** 2026-08-09

## Status

| Phase | Description | Status |
|-------|-------------|--------|
| 0–1 | Delete core/forge/Writer modules, non-spy pages, prompt/scratch/data | **done** |
| 2 | Slim daemon Spy-only HTTP | **done** |
| 3 | Slim web UI Spy/Deep only | **done** |
| 4 | Tauri branding + root scripts | **done** |
| 5 | README optimized + this progress file | **done** |
| 6 | Verify | **done** |

## Verify results

| Check | Result |
|-------|--------|
| `bun install` | ok |
| `bun test packages/spy` | 35 pass / 0 fail |
| `bun run typecheck` | ok (spy + daemon) |
| `bun run ui:build` | ok (~25 kB JS) |
| `GET /api/health` | `{"ok":true,"spy":true,...}` |
| `GET /api/spy/runs` | lists existing channel runs |

## What was removed

- Packages: `core`, `forge`
- Daemon: orchestrator, runs store, library, events, agent team, interactive/MCP agent, training, terminal, transport
- Web: Writer, Training*, Terminal, Agents pages; xterm deps; “Đưa sang Writer”
- Misc: `prompt/`, `scratch/`, `gate.png`, `plan/auth-multiuser.md`
- Data: forge.sqlite*, train/, runs/, writer exports, agents.json

## What remains

```
packages/spy/      # domain + CLI
packages/daemon/   # thin HTTP: /api/health + /api/spy/* + static UI
packages/web/      # Home + Spy + SpyRun + Deep
src-tauri/         # desktop shell → daemon
README.md          # Spy-only docs
```

## Scripts (root)

- `bun run spy` — CLI
- `bun run daemon` — engine
- `bun run ui:build` — UI dist
- `bun run app:macos` — Tauri dev
- `bun test` / `bun run typecheck`

## Notes

- Daemon left running locally after smoke test (pid may vary).
- Dead CSS for Terminal/Agents still in `styles.css` (harmless); can prune later.
- Product display name: **Spy**; package identifier still `com.dacthao.writerroom` to avoid reinstall break.
