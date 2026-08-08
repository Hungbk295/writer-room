# Sync log

Nhạc trưởng ghi mỗi lần user bảo **check** (hoặc baseline).

---

## 2026-08-09 — baseline (plan hygiene only)

### Scope

- Chuẩn hoá `plan/` only (user: **giữ nguyên `docs/`**).
- Không commit code product trong pass này.

### Agent board

| Agent | Status | Plan | Notes |
|-------|--------|------|-------|
| codex | idle | — | OK |
| claude | idle | — | OK |
| grok | done | spy-only-tauri | Code verify pass; plan file đã sửa header done |

### Verify (product — re-check gần nhất trước baseline)

| Check | Result |
|-------|--------|
| `bun test packages/spy packages/daemon` | 35 pass |
| `bun run typecheck` | ok |
| `bun run ui:build` | ok |
| `/api/health` | ok (daemon local) |

### Conflicts

```
OK       | no multi-agent path overlap (chỉ grok active/done)
OK       | plan-vs-code spy-only (sau khi sửa plan header)
DRIFT    | latent | docs/specs/001-greenfield-training-writer-room vẫn mô tả full Writer Room/Training
           trong khi product = Spy-only. User chọn giữ nguyên docs — agent khác không nên
           implement theo SDD 001 trừ khi user reopen.
DRIFT    | latent | docs/plans/training-writer-room-ba-plan.html cùng family stale
```

### Staging note (commit hygiene, ngoài plan/)

Index git từng có staged delete v1 + untracked v2 — **cần `git add -A` có review** trước commit ship Spy-only. Không thuộc pass plan hygiene.

### Follow-ups (không làm trong baseline)

- [ ] User ship commit Spy-only monorepo
- [ ] (Later) supersede/archive docs 001 khi user muốn
- [ ] Grok STATUS → `idle` sau khi commit lên main
