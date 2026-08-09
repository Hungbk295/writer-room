# Plan board — multi-agent sync

Nhạc trưởng (sync agent) theo dõi kế hoạch và tiến độ từng agent.

## Product truth

Canonical product hiện tại: **Spy-only** — xem root [`README.md`](../README.md).

| Layer | Path | Vai trò |
|-------|------|---------|
| Runtime / how-to | `README.md` | Product đang chạy được gì |
| Agent work | `plan/<agent>/` | Plan + progress sprint |
| Design memory | `docs/` | SDD / BA (dài hạn; **không** sửa trong pass sync plan này) |

## Board

| Agent | Folder | Status | Active plan |
|-------|--------|--------|-------------|
| Codex | [`codex/`](./codex/) | idle | — |
| Claude | [`claude/`](./claude/) | idle | — |
| Grok | [`grok/`](./grok/) | done → idle after ship | [`spy-only-tauri`](./grok/spy-only-tauri.md) |
| writer-train | [`writer-train/`](./writer-train/) | active — M0/M0.5/M1 done (E2E xác nhận), bắt đầu M2 | [`HANDOFF.md`](./writer-train/HANDOFF.md) — lane Training + execution layer, SDD 002 M0→M3 |

## Agent harness (portable)

| Doc | Role |
|-----|------|
| [`agent-harness.md`](./agent-harness.md) | Pointer |
| [`docs/plans/agent-harness-architecture.md`](../docs/plans/agent-harness-architecture.md) | **Canonical** — architecture, bugbook, port checklist |

## Deferred (feature-driven — không active)

| ID | Plan | Khi nào kéo |
|----|------|-------------|
| P-DEF-1b…3 | [`deferred-agent-terminal-process.md`](./deferred-agent-terminal-process.md) · detail [`docs/plans/deferred-agent-terminal-writer-loop.md`](../docs/plans/deferred-agent-terminal-writer-loop.md) | turnBridge inject / WriterLoop / E2E assign — **nối harness** |

Log check gần nhất: [`SYNC.md`](./SYNC.md).

## Quy ước

1. Mỗi agent giữ plan/progress trong `plan/<agent>/`.
2. Plan shared (cross-agent) có thể nằm ở root `plan/` nếu cần.
3. Sau mỗi nhóm feature: commit → bảo sync agent **check**.
4. Sync agent:
   - Đọc STATUS + plan active
   - So khớp code vs plan
   - Báo **CONFLICT** / **DRIFT** (kể cả docs latent)
   - Ghi `SYNC.md`; cập nhật STATUS khi cần

### `STATUS.md` vocabulary

| Status | Nghĩa |
|--------|--------|
| `idle` | Không active plan |
| `active` | Đang implement |
| `blocked` | Chờ user / agent khác / conflict |
| `done` | Feature xong, chờ assign mới |

### Plan file header (bắt buộc)

```markdown
> **Agent:** grok
> **Status:** planned | in_progress | done | cancelled | superseded
> **Owns:** packages/spy, ...
> **Does not touch:** ...
> **Depends on:** none | plan/...
```

### Ranh giới

- **Không** nhét SDD full vào folder agent.
- **Không** dùng `docs/specs/` làm todo sprint.
- STATUS = `done` thì plan file không được mô tả state "build vỡ" như hiện tại.

## Workflow

```
assign → agent plan trong plan/<agent>/
      → implement + commit
      → user: "check"
      → sync: conflict matrix + SYNC.md
```
