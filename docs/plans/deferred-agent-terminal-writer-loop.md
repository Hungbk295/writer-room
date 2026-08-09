# Deferred process — 3 phần còn lại (nối khi làm chức năng)

> **Status:** deferred / parked (partial — 1a shipped)  
> **Parent plan:** [`copy-dna-spy-agent-terminal-architecture.md`](./copy-dna-spy-agent-terminal-architecture.md)  
> **Portable architecture (canonical):** [`agent-harness-architecture.md`](./agent-harness-architecture.md)  
> **Harness baseline (đã ship):** 4 agents + TeamWorkflow + MCP + HTTP/SSE + Rust PTY + Agents CRUD + Launch + terminal drawer  
> **Quy ước:** Phần còn lại nối vào harness đã có; không viết orchestrator/terminal thứ hai. Chi tiết bug/fix agents: **agent-harness-architecture.md §5**.

---

## Snapshot hiện trạng (đã có sẵn để nối)

| Layer | Path / API | Ghi chú |
| --- | --- | --- |
| Contracts | `packages/shared/src/terminal.ts` | PTY DTO, AgentDefinition, TeamEvent-compatible shapes |
| Agents | `packages/daemon/src/agents/*` | claude / codex / agy / grok; prepareLaunch, readiness |
| Team | `packages/daemon/src/team/*` | store, workflow (`requestTurn` → `spawnTurn`), MCP tools |
| Harness | `packages/daemon/src/harness.ts` | compose + SSE fan-out |
| HTTP | `packages/daemon/src/http.ts` | `/api/agents/*`, `/api/team/*`, `GET /api/team/events` |
| UI Agents | `packages/web/src/pages/Agents.tsx` | CRUD (＋/Edit/Delete), Launch preview → **Approve & Launch** opens PTY tab |
| Terminal drawer | `packages/web/src/components/terminal/*` | xterm + tabs; `terminals.launchTab` via Tauri invoke |
| Rust PTY | `src-tauri/src/terminal/*` + `permissions/terminal.toml` + capability **remote** `127.0.0.1` | web loads daemon URL and may call PTY |
| Agent config file | `writer-room-data/agents/team.json` | seeded on daemon boot + `GET /api/agents` + `POST /api/agents/seed-defaults` |

**Default agents (không đổi id khi nối):** `claude`, `codex`, `agy`, `grok`.

### Agent config UX (đã ship 2026-08-09 — dna-spy parity partial)

| Action | UI | API |
| --- | --- | --- |
| List 4 defaults | Agents page grid | `GET /api/agents` (re-seeds if empty) |
| Seed again | button “Seed 4 defaults” | `POST /api/agents/seed-defaults` |
| Add / edit | modal form (adapter, exe, prompt, projectRoot…) | `PUT /api/agents` body = agent object |
| Delete | card Delete | `DELETE /api/agents/:id` |
| Detect CLI | Detect | `POST /api/agents/detect` |

**Shipped (P-DEF-1a):** Launch → PTY drawer. **Vẫn deferred (P-DEF-1b):** auto inject on `spawnTurn` (turnBridge).

---

## Phần 1 — Terminal drawer + turnBridge

### Mục tiêu
UI tự mở / tái dùng pane interactive, inject wake line khi daemon emit `spawnTurn`, heartbeat ring, settle turn.

### Khi nào làm
Bất kỳ feature nào cần **nhìn CLI agent chạy trong app** hoặc **Assign/Start loop thật** (không chỉ preview).

### Nguồn copy (dna-spy)
| Việc | Source |
| --- | --- |
| PTY invoke + Channel | `dna-spy/client/src/components/terminal/terminalApi.ts` |
| Tabs/store | `dna-spy/client/src/components/terminal/terminalStore.ts` |
| xterm pane | `dna-spy/client/src/components/terminal/*` |
| Auto-open + inject | `dna-spy/client/src/components/agents/turnBridge.ts` (`ensureBoardAgentTabs`, `initTurnBridge`) |

### Dest (writer-room)
```text
packages/web/src/components/terminal/   # api, store, pane, drawer
packages/web/src/components/agents/turnBridge.ts
packages/web/src/components/agents/agentApi.ts   # thin over /api/team/*
# wire initTurnBridge() trong main.tsx khi chạy trong Tauri
```

### Hook daemon đã sẵn (chỉ consume)
```text
SSE  GET /api/team/events
  → kind: spawnTurn | turnSettled | turnTimeout | interrupt | …

POST /api/team/turn/complete   { turnId, exitCode, resumeSessionRef? }
POST /api/team/turn/heartbeat  { turnId }
POST /api/agents/prepare-launch { agentId, cwd? }
```

### Tauri đã sẵn
```text
terminal_create | write | resize | kill | list | snapshot | attach
event: terminal://exit
```

### Acceptance khi nối
1. `ensureWriterAgentTabs(['claude','codex','agy','grok'], cwd?)` mở 4 pane MCP-wired  
2. `spawnTurn` + `interactiveRequired` → inject vào pane live; `restartInteractive` → kill + relaunch  
3. Heartbeat 10s khi ring sequence đổi  
4. Không silent fallback headless khi `interactiveRequired`  
5. 1 automation pane / agentId (retry không nhân tab)

### Không làm trong phần này
Writer domain artifacts, hard gates, Spy tools.

---

## Phần 2 — WriterLoop orchestrator (artifact resume)

### Mục tiêu
Orchestrator kiểu Board loop: inspect workspace → `nextAction` → `requestTurn` → validate/rollback → advance; Start/Stop/Retry/resume từ disk.

### Khi nào làm
Feature **Writer pipeline / run script / multi-step agent room** (không phải Spy harvest).

### Nguồn pattern (dna-spy — copy shape, không copy storyboard)
| Việc | Source |
| --- | --- |
| Pure resume FSM | `shared/src/board-authoring-resume.ts` → `writer-authoring-resume.ts` |
| Loop engine | `sidecar/src/cook/board-loop.ts` start/stop/retry/advance/dispatchFor/onTurnSettled |
| Agent set (optional) | `board-agent-set.ts` nếu cần clone per run |
| Narrative | `docs/product/board-loop-pipeline.md` |

### Dest (writer-room)
```text
packages/shared/src/writer-authoring-resume.ts
packages/daemon/src/writer/
  writer-loop.ts
  writer-workspace.ts      # prepare context + app-owned validate script
  writer-agent-set.ts      # optional
HTTP: POST /api/writer/loop/{start,status,stop,retry}
      POST /api/writer/workspace/prepare
UI: WriterRun page (Start / Stop / Retry + status.error)
```

### Role mapping (mặc định — chỉnh khi implement feature)
| Writer stage | Agent id | Ghi chú |
| --- | --- | --- |
| contract / analyst | `grok` | role analyst |
| draft / author | `claude` | role author |
| review / hard gates | `codex` | role editor |
| polish (optional) | `agy` | role polish |

### Dispatch flags (bắt buộc giữ y harness)
```ts
workflow.requestTurn(agentId, 'assignment', undefined, {
  taskNote,
  overrideCwd: run.dir,          // workspace dưới data/workspaces/
  skipWorktree: true,
  allowedTools: ['Read', 'Edit', 'Write'],
  orchestrated: true,
  persistentInteractive: true,   // cần Phần 1
  freshContext: true,
  exclusive: true,
  timeoutMs: 30 * 60_000,
  stallMs: 7 * 60_000,
  budget: { scope: `writer:${id}`, maxTurns, maxDurationMinutes: 240 },
});
```

### Artifact resume (pure) — skeleton
```text
PREPARED → AUTHOR_CONTRACT → AUTHOR_DRAFT → RUN_REVIEW
  → AUTHOR_REPAIR? → PUBLISH_READY | BLOCKED
```
State sống trên disk (`output/*.json`, checkpoints, hashes). Upstream fail thắng downstream.

### Acceptance khi nối
1. Crash giữa turn → Retry tiếp đúng `nextAction`  
2. Validate fail → rollback preimage + attempt ≤3 / semantic key  
3. Cycle detect → halt + human Retry  
4. `dispatch-log.jsonl` + `status.error` codes  
5. Stop → interruptTurn + restore transaction  

### Depends on
- Harness baseline ✅  
- Phần 1 (persistent interactive panes) — **mạnh khuyến nghị trước hoặc cùng PR**

---

## Phần 3 — End-to-end wire (Assign → terminal → agent → settle)

### Mục tiêu
Một luồng operator đầy đủ, không “API-only”:

```text
UI action (Assign hoặc WriterLoop Start)
  → ensure*AgentTabs / panes live
  → daemon requestTurn / loop.dispatch
  → SSE spawnTurn
  → turnBridge inject
  → agent MCP team_get_assignment → ghi file → team_turn_complete
  → workflow settle → (loop advance | UI status)
```

### Khi nào làm
Ngay sau Phần 1 (smoke Assign) và/hoặc khi ship Phần 2 (full Writer run).

### Checklist nối
| Bước | Owner | Đã có? |
| --- | --- | --- |
| Seed 4 agents | daemon harness | ✅ |
| MCP team URL+token | `/api/team/mcp` | ✅ |
| prepareLaunch writes MCP config | AgentManager | ✅ |
| SSE spawnTurn | `/api/team/events` | ✅ |
| Terminal create/write/snapshot | Rust | ✅ (web chưa gọi) |
| turnBridge subscribe SSE | web | ❌ Phần 1 |
| Heartbeat → stall | web + workflow | workflow ✅, web ❌ |
| team_turn_complete path | MCP + `/api/team/turn/complete` | ✅ |
| WriterLoop afterTurn | daemon | ❌ Phần 2 |
| Status surface trong UI | Agents / WriterRun | partial |

### Smoke script (khi nối xong)
1. Restart daemon (đảm bảo port 4187 chạy bản harness mới)  
2. Mở app Tauri (cần PTY invoke; browser thuần không đủ cho pane)  
3. `#/agents` → Assign `claude` task ngắn  
4. Pane mở + inject wake line  
5. Agent (hoặc mock) gọi `team_turn_complete` → audit `turn_completed`  
6. (Sau Phần 2) Prepare workspace → Start loop → 1 stage artifact xuất hiện  

### Ops note
Daemon cũ trên `:4187` **không** có `/api/agents` — restart trước khi demo:

```bash
# kill process cũ nếu cần, rồi:
bun packages/daemon/src/index.ts
```

---

## Process khi user assign feature

```text
1. Đọc harness baseline (bảng Snapshot)
2. Chọn phần deferred cần thiết:
   - Chỉ chat/assign visible CLI  → Phần 1 (+ 3 smoke)
   - Writer multi-step pipeline   → Phần 1 + 2 + 3
3. Không fork TeamWorkflow / MCP thứ hai
4. Không đổi agent id mặc định trừ khi migration có chủ đích
5. Cập nhật checkbox dưới đây + parent plan progress khi ship
```

### Status checkboxes

- [x] **P-DEF-1a** Terminal drawer + Launch from Agents (Approve & Launch → PTY) — shipped 2026-08-09  
- [ ] **P-DEF-1b** turnBridge (SSE spawnTurn → inject wake line / heartbeat)  
- [ ] **P-DEF-2** WriterLoop + writer-authoring-resume + prepare workspace  
- [ ] **P-DEF-3** E2E wire Assign/Start → pane → settle (+ Writer advance)  

---

## Out of scope (vẫn deferred / khác plan)

- Training / MySQL SDD 001  
- Board storyboard Continuity/Polish domain  
- Legacy `dna-spy/writer-room` tmux orchestrator  
- Multi-user / remote MCP  

---

## Liên kết

| Doc | Vai trò |
| --- | --- |
| [`copy-dna-spy-agent-terminal-architecture.md`](./copy-dna-spy-agent-terminal-architecture.md) | Kiến trúc đầy đủ + progress harness |
| [`plan/deferred-agent-terminal-process.md`](../../plan/deferred-agent-terminal-process.md) | Pointer ngắn cho multi-agent board |
| dna-spy `turnBridge.ts` / `board-loop.ts` | Source of truth implementation |

*Parked 2026-08-09 — implement only when feature work requires connection.*
