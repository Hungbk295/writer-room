> **Agent:** any (feature-driven)  
> **Status:** deferred  
> **Owns:** (when assigned) packages/web terminal+turnBridge; packages/daemon/src/writer; e2e wire  
> **Does not touch:** packages/spy (unless feature says so)  
> **Depends on:** harness baseline already in tree (agents/team/MCP/PTY)

# Deferred — phần còn lại (nối khi làm chức năng)

Canonical architecture (port guide + bugbook):  
[`docs/plans/agent-harness-architecture.md`](../docs/plans/agent-harness-architecture.md)

Deferred detail: [`docs/plans/deferred-agent-terminal-writer-loop.md`](../docs/plans/deferred-agent-terminal-writer-loop.md)

| ID | Phần | Trigger (khi nào làm) | Depends |
|----|------|------------------------|---------|
| **P-DEF-1a** | Terminal drawer + Launch | — | **shipped** |
| **P-DEF-1b** | turnBridge inject/heartbeat | Assign/loop auto-wake | Harness ✅ |
| **P-DEF-2** | WriterLoop (artifact resume) | Writer multi-step pipeline | P-DEF-1a (+1b) |
| **P-DEF-3** | E2E Assign/Start → inject → settle | Ship automation | P-DEF-1b (+2) |

## Đã ship (không làm lại)

- 4 agents + model defaults (claude sonnet, codex 5.6 terra high, agy board, grok Build binary)
- TeamWorkflow + MCP + SSE
- Agents CRUD + Launch → PTY drawer + nav toggle
- Fixes: wrong grok, TERM=dumb, Agy args, etc. (see architecture §5)

## Rule

Khi assign feature chạm agent loop: **nối vào harness**, không viết orchestrator/MCP/terminal stack thứ hai. Khi port project khác: đọc **agent-harness-architecture.md** trước.
