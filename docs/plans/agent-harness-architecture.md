# Agent Harness Architecture — Portable Guide

> **Status:** shippable baseline (writer-room)  
> **Updated:** 2026-08-09  
> **Source projects:** dna-spy (pattern) → writer-room (this tree)  
> **Purpose:** Tài liệu **đủ để copy** harness agents/terminal/MCP sang project khác, gồm cả các lỗi đã fix thực tế.

---

## 0. One-line summary

```text
UI (Agents page + Terminal drawer)
  ↔ HTTP/SSE daemon (AgentManager + TeamWorkflow + MCP Team server)
  ↔ Tauri Rust PTY (portable-pty, Channel per-session)
  ↔ CLI agents (claude | codex | agy | grok)
```

**Luật:** Process authority ở **Rust PTY**. Workflow/MCP/state ở **daemon**. UI chỉ bridge.

---

## 1. Module map (writer-room)

| Layer | Path | Responsibility |
| --- | --- | --- |
| Contracts | `packages/shared/src/terminal.ts` | DTO: AgentDefinition, AgentLaunchSpec, TeamMessage, McpServerInfo, Terminal* |
| Defaults | `packages/daemon/src/agents/defaults.ts` | 4 agents seed + path repair (grok/agy binaries) |
| Config store | `packages/daemon/src/agents/config.ts` | `data/agents/team.json` + guards |
| Adapters | `packages/daemon/src/agents/adapters.ts` | Per-CLI interactive/headless argv + env (PATH-only like dna-spy) |
| AgentManager | `packages/daemon/src/agents/index.ts` | prepareLaunch, MCP wiring, worktree, readiness |
| PATH | `packages/daemon/src/exec.ts` | `AUGMENTED_ENV` — **user CLI bins before Homebrew** |
| Team store | `packages/daemon/src/team/store.ts` | SQLite messages/turns/assignments/audit |
| Workflow | `packages/daemon/src/team/workflow.ts` | requestTurn → spawnTurn, stall, interrupt |
| MCP team | `packages/daemon/src/team/mcp.ts` | HTTP loopback + bearer, tools `team_*` |
| Compose | `packages/daemon/src/harness.ts` | boot MCP + workflow + seed defaults |
| HTTP | `packages/daemon/src/http.ts` | `/api/agents/*`, `/api/team/*`, SSE events |
| UI Agents | `packages/web/src/pages/Agents.tsx` | CRUD + Launch preview → Approve & Launch |
| UI Terminal | `packages/web/src/components/terminal/*` | xterm drawer, launchTab, show/hide |
| Rust PTY | `src-tauri/src/terminal/{mod,ring}.rs` | create/write/resize/kill/snapshot/attach |
| ACL | `src-tauri/permissions/terminal.toml` + `capabilities/default.json` | `allow-terminal` + **remote** `http://127.0.0.1:*` |
| Persist | `writer-room-data/agents/team.json` | agent definitions (runtime data dir) |

### Related plans

| Doc | Role |
| --- | --- |
| [`copy-dna-spy-agent-terminal-architecture.md`](./copy-dna-spy-agent-terminal-architecture.md) | Original copy plan from dna-spy |
| [`deferred-agent-terminal-writer-loop.md`](./deferred-agent-terminal-writer-loop.md) | Still deferred: turnBridge inject, WriterLoop, E2E assign-auto |
| [`plan/deferred-agent-terminal-process.md`](../../plan/deferred-agent-terminal-process.md) | Board pointer |

---

## 2. Default agents (current)

| id | adapter | executable | Default args |
| --- | --- | --- | --- |
| `claude` | `claude-code` | `claude` | `--model sonnet` |
| `codex` | `codex` | `codex` | `--model gpt-5.6-terra high --dangerously-bypass-approvals-and-sandbox` |
| `agy` | `agy` | prefer `~/.local/bin/agy` | `--model "Gemini 3.5 Flash (High)" --mode accept-edits --dangerously-skip-permissions` (dna-spy board-agy) |
| `grok` | `grok` | **`~/.grok/bin/grok`** (absolute) | `[]` (fullscreen not forced) |

Seed / repair: `ensureDefaultAgents()` on harness boot and `GET /api/agents`.

---

## 3. Launch flow (manual Agents page)

```text
▶ Launch
  → POST /api/agents/prepare-launch { agentId }
      · write MCP config for adapter
      · build AgentLaunchSpec { executable, args, cwd, env }
  → modal preview (command string)
Approve & Launch
  → prepareLaunch again (fresh MCP token)
  → terminals.launchTab(spec)   // Tauri only
      · open drawer
      · terminal_create(cols≈viewport, rows≈drawer height)
      · xterm attach + fit + termResize
```

**Browser thuần:** CRUD/API OK; PTY **không** chạy → cần `bun run app:macos`.

---

## 4. MCP wiring per adapter

| Adapter | How MCP is attached | Config location |
| --- | --- | --- |
| `claude-code` | `--mcp-config <file>` | `data/agents/mcp-{id}.json` (type http + Bearer) |
| `codex` | `-c mcp_servers.team.url=…` + bearer env | env `WRITER_ROOM_MCP_TOKEN` |
| `agy` | **file only**, no CLI flag | `<cwd>/.agents/mcp_config.json` `{ serverUrl, headers }` |
| `gemini` | settings file | `<cwd>/.gemini/settings.json` |
| `grok` | **file only**, **no `--mcp-config`** | `<cwd>/.grok/config.toml` `[mcp_servers.team]` |

Team MCP server: `http://127.0.0.1:<random>/mcp` + bearer token per daemon run.

### Grok MCP TOML shape

```toml
[mcp_servers.team]
url = "http://127.0.0.1:PORT/mcp"
enabled = true

[mcp_servers.team.headers]
Authorization = "Bearer <token>"
```

Gitignore runtime secrets: `.agents/mcp_config.json`, `.grok/config.toml`.

---

## 5. Critical production bugs (must not reintroduce)

### 5.1 Wrong `grok` binary → fake “API key required”

**Symptom:**  
`API key required. Set GROK_API_KEY … user-settings.json`

**Cause:** Two different products share the name `grok`:

| Path | Product | Auth |
| --- | --- | --- |
| `~/.grok/bin/grok` | **xAI Grok Build** | `grok login` → `~/.grok/auth.json` |
| `/opt/homebrew/bin/grok` | **@vibe-kit/grok-cli** (npm) | `GROK_API_KEY` / apiKey in user-settings |

If PATH puts Homebrew first, agent launch hits vibe-kit → API key error even when user is logged into Grok Build.

**Fix (shipped):**

1. `AUGMENTED_ENV.PATH`: `~/.grok/bin` + `~/.local/bin` **before** `/opt/homebrew/bin`
2. Default agent executable = absolute `~/.grok/bin/grok` when present
3. `ensureDefaultAgents` repairs stored `grok` / homebrew path to preferred binary

**Port rule:** Always resolve “product binary”, never bare `which grok` against a Homebrew-first PATH.

---

### 5.2 `TERM=dumb` blanks TUI (agy / grok / codex)

**Symptom:** Terminal tab opens, process running, **screen blank**.

**Cause:** Daemon process often has `TERM=dumb`. If launch env forwards `TERM` into PTY, TUIs render empty.

**Fix (shipped):**

1. Adapter `baseSpec` env = **PATH only** (dna-spy parity) — do not copy daemon TERM/HOME blindly
2. Client `launchTab` forces `TERM=xterm-256color` if missing/dumb
3. Rust PTY rejects `TERM=dumb|unknown` and sets `xterm-256color`

**Port rule:** Never forward headless parent `TERM` into interactive agent PTY.

---

### 5.3 Claude-only flags on wrong CLIs

| Flag | Belongs to | Wrong on |
| --- | --- | --- |
| `--mcp-config` | Claude Code | **Grok** (hard error: unknown option) |
| `--print` / `-p` for interactive | headless modes | Agy interactive (wrong mode) |

**Fix:** Grok never gets `--mcp-config`; Agy interactive never gets `--print`.

---

### 5.4 Agy empty args vs dna-spy board profile

dna-spy **board-agy** always launches with:

```text
agy --model 'Gemini 3.5 Flash (High)' --mode accept-edits --dangerously-skip-permissions
```

Bare `agy` with `args: []` often looks “dead” in embedded PTY.

**Fix:** Default + repair empty Agy args to board profile (model name may need local adjust via Edit).

---

### 5.5 Terminal pane squeezed to the left

**Causes stacked:**

1. Legacy CSS `.term-pane { width: max-content }` (tmux page) fighting drawer
2. PTY created at 80×24 before drawer layout / fit fails

**Fix:**

1. Drawer host class `term-drawer-xterm` with `width/height: 100% !important`
2. Layout: CSS var `--term-height` so main content **shrinks + scrolls** (dna-spy), drawer fixed bottom
3. `launchTab`: open drawer first; initial cols/rows from viewport
4. Global nav button **🖥 Terminal** show/hide

---

### 5.6 Env shape (dna-spy baseSpec)

```ts
// Correct (dna-spy)
env = { PATH: augmentedPath }

// Dangerous
env = { ...process.env, TERM: process.env.TERM } // may be dumb
```

Tauri `portable-pty` starts from app base env then applies overrides; still never set TERM=dumb.

---

## 6. HTTP API surface (minimal portable contract)

```http
GET  /api/agents
PUT  /api/agents                    # body = AgentDefinition (or { agent })
DELETE /api/agents/:id
POST /api/agents/seed-defaults
POST /api/agents/detect             # { adapter, executable? }
POST /api/agents/launch-preview     # { agentId }  — no side effects preferred
POST /api/agents/prepare-launch     # { agentId, cwd? } — writes MCP files
POST /api/agents/readiness          # auth/trust probe

GET  /api/team/mcp
GET  /api/team/status
GET  /api/team/messages
POST /api/team/messages
POST /api/team/assign
POST /api/team/turn/complete
POST /api/team/turn/heartbeat
POST /api/team/interrupt
POST /api/team/stop-all
POST /api/team/reset
GET  /api/team/events               # SSE TeamEvent stream
```

---

## 7. Tauri requirements when UI is served from daemon URL

writer-room loads `http://127.0.0.1:4187` inside the webview.

Must have in `capabilities/default.json`:

```json
{
  "windows": ["main"],
  "remote": { "urls": ["http://127.0.0.1:*", "http://localhost:*"] },
  "permissions": [
    "core:default",
    "core:event:default",
    "core:event:allow-listen",
    "core:event:allow-emit",
    "allow-terminal"
  ]
}
```

And `permissions/terminal.toml` allowing:

`terminal_create`, `terminal_write`, `terminal_resize`, `terminal_kill`, `terminal_list`, `terminal_snapshot`, `terminal_attach`.

Without **remote**, invoke from daemon-served UI fails silently / unauthorized.

---

## 8. Porting checklist (new project)

### Phase A — Contracts + daemon

- [ ] Copy `packages/shared/src/terminal.ts` (or equivalent)
- [ ] Copy `agents/*`, `team/*`, `harness.ts`, wire HTTP routes
- [ ] Data dir: `{data}/agents/team.json`, `{data}/team.sqlite`
- [ ] `AUGMENTED_ENV` PATH order: **user CLI homes → then Homebrew**
- [ ] Seed defaults appropriate to the product (models/args)
- [ ] Unit tests: default agents, grok never `--mcp-config`, agy has model args, PATH-only env

### Phase B — Tauri PTY

- [ ] Copy `src-tauri/src/terminal/*`
- [ ] Register commands + `allow-terminal` permission
- [ ] If webview loads remote/loopback URL → `remote.urls`
- [ ] Guard `TERM=dumb` in Rust create

### Phase C — UI

- [ ] Agents page: list, seed, CRUD modal, prepareLaunch preview, Approve & Launch
- [ ] Terminal drawer: tabs, hide/show in **global nav**, `--term-height` content layout
- [ ] xterm host class isolated from any `width: max-content` legacy CSS
- [ ] Detect `isTauri()`; clear error if Launch from plain browser

### Phase D — Optional automation

- [ ] turnBridge: SSE `spawnTurn` → inject into interactive pane + heartbeat
- [ ] Domain loop orchestrator (Board/Writer style) using `requestTurn` + artifact resume

### Phase E — Smoke

1. `prepare-launch claude` → args contain sonnet; mcp file exists  
2. `prepare-launch codex` → `gpt-5.6-terra` + high  
3. `prepare-launch agy` → model + accept-edits + skip-permissions; `.agents/mcp_config.json`  
4. `prepare-launch grok` → executable is `~/.grok/bin/grok` (version xAI Build, not vibe-kit); no `--mcp-config`  
5. Approve & Launch each → TUI visible, full width, interactive  
6. Hide/show Terminal from nav; main content still scrollable  

---

## 9. Adapter reference (argv recipes)

### Claude Code (`claude-code`)

```bash
claude --model sonnet [--append-system-prompt …] --mcp-config data/agents/mcp-claude.json
```

### Codex

```bash
codex \
  -c 'mcp_servers.team.url="http://127.0.0.1:PORT/mcp"' \
  -c 'mcp_servers.team.bearer_token_env_var="WRITER_ROOM_MCP_TOKEN"' \
  --model gpt-5.6-terra high \
  --dangerously-bypass-approvals-and-sandbox
# env: WRITER_ROOM_MCP_TOKEN=<bearer>
```

### Antigravity (`agy`)

```bash
agy --model 'Gemini 3.5 Flash (High)' --mode accept-edits --dangerously-skip-permissions
# MCP: <cwd>/.agents/mcp_config.json
```

### Grok Build

```bash
# MUST be ~/.grok/bin/grok (or ~/.local/bin/grok symlink) — not Homebrew vibe-kit
~/.grok/bin/grok
# MCP: <cwd>/.grok/config.toml
# Auth: grok login → ~/.grok/auth.json (session); optional XAI_API_KEY fallback
```

---

## 10. Data & secrets layout

```text
{DATA_ROOT}/
  agents/
    team.json              # agent definitions
    mcp-{agentId}.json     # Claude-style MCP client config
  team.sqlite              # messages, turns, audit
  workspaces/              # optional overrideCwd roots
  worktrees/               # isolated-worktree mode

{projectRoot}/             # agent.projectRoot / cwd
  .agents/mcp_config.json  # Agy (gitignored)
  .grok/config.toml        # Grok MCP (gitignored; contains bearer)
  AGENTS.override.md       # optional prompt for codex/agy/grok
```

---

## 11. Status snapshot (writer-room 2026-08-09)

| Capability | Status |
| --- | --- |
| 4 default agents + CRUD UI | ✅ |
| prepareLaunch + MCP per adapter | ✅ |
| Tauri PTY + terminal drawer + nav toggle | ✅ |
| Layout: content vs drawer (`--term-height`) | ✅ |
| Fix: wrong grok binary | ✅ |
| Fix: TERM=dumb blank TUI | ✅ |
| Fix: Agy board args | ✅ |
| Fix: Grok no `--mcp-config` | ✅ |
| Fix: Claude sonnet / Codex 5.6 terra high defaults | ✅ |
| turnBridge (auto inject on spawnTurn) | ❌ deferred (P-DEF-1b) |
| WriterLoop artifact resume | ❌ deferred (P-DEF-2) |
| E2E assign → auto wake | ❌ deferred (P-DEF-3) |

---

## 12. Quick debug cheatsheet

| Symptom | Check |
| --- | --- |
| GROK_API_KEY / user-settings apiKey | Wrong binary: `prepare-launch` exe must be `~/.grok/bin/grok`; `grok --version` → `grok 1.0.0 (…)` not Node script |
| Blank Agy pane | Args include model+mode? TERM not dumb? PTY width full? |
| `unknown option --mcp-config` | Grok/agy must not receive Claude flags |
| Pane squeezed left | CSS `term-drawer-xterm` 100%; no global `max-content` |
| invoke fails in app | Capability `remote` + `allow-terminal` |
| Launch only works in shell | Running browser not Tauri app |

```bash
# Live inspect
curl -s -X POST http://127.0.0.1:4187/api/agents/prepare-launch \
  -H 'content-type: application/json' \
  -d '{"agentId":"grok"}' | jq '{exe:.executable, args:.args, path:(.env.PATH|split(":")[0:4])}'
```

---

*Document is the portable source of truth for the agent harness as implemented in writer-room. Prefer this over re-reading chat history when porting.*
