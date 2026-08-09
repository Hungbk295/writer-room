> **Agent:** any (port / feature)  
> **Status:** done (baseline) + deferred automation  
> **Owns:** packages/shared terminal contracts; packages/daemon agents+team; packages/web Agents+terminal; src-tauri terminal  
> **Does not touch:** packages/spy domain  
> **Depends on:** none  

# Agent harness — plan pointer

## Canonical docs (read these when porting)

1. **Architecture + bugbook (complete):**  
   [`docs/plans/agent-harness-architecture.md`](../docs/plans/agent-harness-architecture.md)

2. **Original dna-spy copy plan:**  
   [`docs/plans/copy-dna-spy-agent-terminal-architecture.md`](../docs/plans/copy-dna-spy-agent-terminal-architecture.md)

3. **Still deferred (turnBridge / WriterLoop / E2E):**  
   [`docs/plans/deferred-agent-terminal-writer-loop.md`](../docs/plans/deferred-agent-terminal-writer-loop.md)

## Shipped baseline

- 4 agents: `claude` (sonnet), `codex` (gpt-5.6-terra high), `agy` (board profile), `grok` (`~/.grok/bin/grok`)
- Team MCP + workflow + Agents CRUD UI + Launch → Tauri PTY drawer
- Critical fixes: wrong grok binary, TERM=dumb, Agy empty args, Claude-only flags on Grok, terminal layout

## When porting to another project

Open **agent-harness-architecture.md** §8 Porting checklist and §5 bugs — do not re-discover.
