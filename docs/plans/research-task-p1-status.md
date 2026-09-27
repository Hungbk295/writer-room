# ResearchTask P1 — trạng thái triển khai

Ngày 28/9/2026. Bổ sung cho `hermes-writer-room-runtime-redesign.md` §4/§6-P1.

## Đã có (daemon source of truth)

- Store SQLite WAL + transaction + optimistic `version` + idempotent `commandId`
  receipt (`research_commands`): `packages/daemon/src/research-task/store.ts`.
- Luồng duy nhất `create → bind → ready`, worker `research_task_claim` chuyển
  `ready → running` atomic (bind subject + lease). Không có `research_task_start`.
- Lease/heartbeat; lease hết hạn khóa worker mutation; operator `mark_unknown`
  → `bind` lại (mở queue nếu bỏ `workerSubject`).
- Budget: reserve trước dispatch, settle/release trong transaction của
  `round_complete`; `cancel_ack`/`fail` giải phóng reservation treo. Unique
  video đếm theo `(taskId, videoId)` — không tin số agent tự báo.
- `instruct` durable, áp dụng ở reserve boundary (`instruction_applied` event).
- Event log bền `research_events` với cursor (`research_task_events`).
- MCP `/api/research/mcp`: Bearer token → actor qua
  `config/hermes-actors.json` (daemon là sole writer, 0600). `tools/list` lọc
  theo role; `tools/call` re-check — token lạ 401, sai role `-32602`.
  Actors: `hermes:wr-operator` (operator), `hermes:wr-researcher`
  (worker, profile/queue `research` — canonical `RESEARCH_QUEUE` khớp
  `../hermes/scripts/wr-runtime.py:55`). `hermes:wr-writer` **không có grant**
  trên Research MCP trong P1/W1 (Writer dùng shared Writer MCP token) — grant
  legacy (worker/viewer) bị `revokeSubject()` khi boot, có audit log, token
  resolve → null → 401. `ensure()` heal profile/role drift in-place, giữ
  token, audit-log mỗi correction.

## P2 backend (đang triển khai)

- **Outbox durable** (`research_outbox`): mọi domain event đi cùng transaction
  vào outbox theo audience — `worker` = wake signal (bind/instruct/resume/
  pause/cancel/unknown), `operator` = progress feed cho Telegram bridge.
  `research_outbox_poll`/`research_outbox_ack` (cursor + delivery receipt,
  ack idempotent, scoped: worker theo profile, operator theo owner). Không
  push, không LLM poll, không Telegram send — daemon chỉ là source of truth.
- **Spy quota binding**: `searchCost` = số `search.list` call. `reserve()` gọi
  `spyQuota()` (wire `spy.quota.remaining('search')`): probe null → fail
  closed `QUOTA`; remaining < cost → `QUOTA` reject để worker settle partial
  report. Reservation (task budget) và actual usage (Spy ledger) tách biệt.

## Hard gate completion (structural/integrity — đã verify)

`research_task_complete` chỉ `completed` khi: mọi round `completed`, không
reservation treo; ≥1 manifest + ≥1 report artifact; rehash mọi artifact khớp
sha256 đăng ký (drift → `validation_state='stale'` + EVIDENCE); mọi
`spy_run_id` tồn tại trong Spy source-of-truth và `status='completed'`
(`spy.getRunManifest`); manifest là JSON có `spyRunIds[]` bao phủ toàn bộ refs;
report non-empty. `research_round_complete` đồng thời đối chiếu từng `videoId`
với `manifest.videos[].youtubeVideoId` của Spy run tương ứng.

## Giới hạn đã biết — KHÔNG phải factual validation hoàn chỉnh

- Gate trên là **structural + integrity**: chứng minh artifact không bị sửa,
  Spy refs/video IDs là thật theo Spy store. Nó **không** chứng minh từng con
  số/claim trong report khớp số liệu Spy (đối chiếu nội dung số → luật skill /
  gate P3, chưa implement).
- `resume` chỉ đổi phase phía daemon; cơ chế đánh thức worker (wake/outbox)
  chưa có — P2.
- Chưa có event→Telegram outbox theo delivery receipt — P2.
- `maxSearchCost` do operator set lúc create; chưa wire quota thật từ Spy
  service — P2.
- `tools.include`/loopback không phải bằng chứng danh tính: ACL thật là token
  scoped trong `hermes-actors.json`, phát hành và thu hồi bởi daemon.

## Tests

`packages/daemon/test/research-task/{store,lifecycle}.test.ts` — 9 tests:
idempotency/budget, ACL scope, queue claim + worker isolation, lease expiry →
mark_unknown → rebind, cancel release reservation, instruct boundary,
crash/restart cursor, hard gate (fake/running/ghost-video/tamper), MCP
role-filter + E2E call chain.
