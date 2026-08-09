> **Agent:** any (feature-driven)  
> **Status:** deferred  
> **Owns:** (when assigned) packages/web terminal+turnBridge; packages/daemon/src/writer; e2e wire  
> **Does not touch:** packages/spy (unless feature says so)  
> **Depends on:** harness baseline already in tree (agents/team/MCP/PTY)

# Deferred — 3 phần còn lại (nối khi làm chức năng)

Canonical detail: [`docs/plans/deferred-agent-terminal-writer-loop.md`](../docs/plans/deferred-agent-terminal-writer-loop.md)

| ID | Phần | Trigger (khi nào làm) | Depends |
|----|------|------------------------|---------|
| **P-DEF-1** | Terminal drawer + turnBridge | Feature cần CLI pane trong app / Assign thật | Harness ✅ |
| **P-DEF-2** | WriterLoop (artifact resume) | Feature Writer multi-step pipeline | P-DEF-1 (khuyến nghị) |
| **P-DEF-3** | E2E wire Assign/Start → inject → settle | Ship P-DEF-1 và/hoặc P-DEF-2 | P-DEF-1 (+2 nếu loop) |

## Đã ship (không làm lại)

- 4 agents: `claude`, `codex`, `agy`, `grok`
- TeamWorkflow + MCP + SSE `/api/team/events`
- HTTP `/api/agents/*`, `/api/team/*`
- Rust PTY commands
- Agents page (chưa inject pane)

## Rule

Khi assign feature chạm agent loop: **nối vào harness**, không viết orchestrator/MCP/terminal stack thứ hai. Tick checkbox trong doc canonical khi xong.
