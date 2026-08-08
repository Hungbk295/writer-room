> **File:** `plan/grok/spy-only-tauri.md`  
> **Agent:** grok  
> **Status:** done  
> **Owns:** packages/spy, packages/daemon, packages/web, src-tauri, README.md, root package.json  
> **Does not touch:** docs/specs (giữ nguyên theo user)  
> **Depends on:** none  
> **Progress:** [`spy-only-tauri-progress.md`](./spy-only-tauri-progress.md)

# Plan: Spy-only + Tauri + README

**Done 2026-08-09.** Nội dung bên dưới là historical scope (đã implement).

## Goal

Cắt monorepo còn Spy + Tauri; README Spy-only.

## Scope đã làm

### Xoá

- `packages/core`, `packages/forge`
- Daemon Writer: orchestrator, store, library, events, agents, mcp-*, training, terminal/, transport/
- Web: Writer, Training*, Terminal, Agents + xterm
- `prompt/`, `scratch/`, `gate.png`, `plan/auth-multiuser.md`
- Data non-spy: forge.sqlite*, train/, runs/, exports/, agents.json

### Slim / rewrite

1. **README** — Spy-only, CLI + Tauri + scripts
2. **Daemon** — `/api/health`, `/api/spy/*`, static UI; deps chỉ `@writer-room/spy`
3. **Web** — Home + Spy + SpyRun + Deep
4. **Root + Tauri** — productName Spy; scripts `spy`, `daemon`, `ui:build`, `app:macos`, `test`, `typecheck`

## Tiêu chí xong

- [x] README mô tả đúng Spy + Tauri
- [x] Daemon/web build & typecheck sạch
- [x] CLI spy; UI chỉ Spy/Deep
- [x] Progress file done

## Verify

Xem [`spy-only-tauri-progress.md`](./spy-only-tauri-progress.md).
