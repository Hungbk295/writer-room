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

## Rollout note

- `writer-room-data/config/hermes-actors.json` + `hermes-mcp.json` đã bị xóa
  khỏi data dir thật trong quá trình tích hợp (không phải chỉ đạo leader).
  Boot kế tiếp của daemon sẽ mint lại file mới 0600 với đúng 2 grant
  (`hermes:wr-operator`, `hermes:wr-researcher`/`research`); token cũ trong
  `.env` của các profile Hermes sẽ hết hiệu lực → cần chạy lại provision sau
  restart. Daemon `:4187` chưa restart theo chỉ đạo.

## P2 backend (đang triển khai)

- **Outbox durable** (`research_outbox`): mọi domain event đi cùng transaction
  vào outbox theo audience — `worker` = wake signal (bind/instruct/resume/
  pause/cancel/unknown), `operator` = progress feed cho Telegram bridge.
  `research_outbox_poll`/`research_outbox_ack` (cursor + delivery receipt,
  ack idempotent, scoped: worker theo profile, operator theo owner). Delivery
  **at-least-once**: bridge phải persist transport message-id vào `receipt`
  TRƯỚC khi ack và chỉ advance cursor sau ack; crash giữa send→ack để row
  undelivered = "unknown — reconcile theo receipt, không auto-resend". Không
  push, không LLM poll, không Telegram send — daemon chỉ là source of truth.
- **Artifact dir projection**: mọi projection task (`get`/`claim`/`list`) trả
  `artifactDir` = `<dataDir>/research/artifacts/<taskId>` (canonical, daemon
  tạo khi `create`). Worker ghi artifact vào đúng dir đó;
  `research_artifact_register` reject mọi path ngoài task dir (kể cả dir của
  task khác). Worker không tự suy ra root từ env/cwd.
- **Artifact supersede (recovery)**: file drift sau register → `completeTask`
  fail `EVIDENCE` + row `stale`. Repair = `research_artifact_register` lại
  **cùng path** với **commandId MỚI** và `expectedVersion` hiện tại → cập nhật
  hash in-place, audit event `artifact_superseded` {old→new sha256}, completion
  unblocked. Replay commandId cũ chỉ trả receipt đã lưu (không re-hash).
- **Cancel preserved on rebind**: `bind()` trên orphan `cancel_requested`
  (lease hết hạn) GIỮ phase `cancel_requested`; `claim()` nhặt cả
  `ready`/`cancel_requested` — worker mới kế thừa pending cancel và phải
  `cancel_ack`. Cancel không bao giờ tự revert `ready`.
- **Spy quota binding**: `searchCost` = số `search.list` call. `reserve()` gọi
  `spyQuota()` (wire `spy.quota.remaining('search')`) rồi trừ TỔNG
  `reserved_search` outstanding của mọi task → fail closed khi probe null,
  `QUOTA` khi hết. Giới hạn còn lại: snapshot không chặn non-research Spy
  calls chen giữa reserve→settle (Spy service tự cưỡng chế lúc call).

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
  Spy refs/video IDs là thật theo Spy store.
- P3 foundation (`factGateVersion=2`, xem dưới) verify các claim số/ngày
  **trong `manifest.claims[]` có cấu trúc** theo Spy snapshot. Prose trong
  report ngoài `claims[]` vẫn **không được check** — không claim "100% fact
  check". Full P3 cần thêm gate: report chỉ được kết luận định lượng qua
  `claimId` đã validate (proposed, chưa implement).
- `tools.include`/loopback không phải bằng chứng danh tính: ACL thật là token
  scoped trong `hermes-actors.json`, phát hành và thu hồi bởi daemon.

## P3 foundation — `factGateVersion` (leader-approved, implemented)

- `research_task_create` nhận `factGateVersion` `1|2` (mặc định `1` legacy);
  persist `research_tasks.fact_gate_version`, projection `get`/`claim`/`list`
  trả `factGateVersion`. **Worker không thể downgrade**: task v2 bắt buộc
  manifest `claimsVersion=2` + `claims[]` non-empty + ≥1 claim `kind:'fact'`,
  claim id unique, ≤500 claims; thiếu/sai version → `EVIDENCE`/`INVALID`.
- Claim shape: `{id, kind:'fact'|'inference'|'unverifiable', subject:{spyRunId[,videoId]}, metric, op, value}`.
  `spyRunId` phải là recorded ref; `videoId` phải thuộc run manifest.
- Metric whitelist = đúng field `spy.getRunManifest` (snapshot đã lưu, KHÔNG
  query YouTube live): run `{videoCount,status,kind,createdAt,completedAt}`;
  video `{viewCount,durationSec,rank,transcriptSegments,title,channelTitle,transcriptStatus,publishedAt}`.
- So sánh deterministic: count metrics (`videoCount/viewCount/rank/
  transcriptSegments`) = nonnegative **safe integer** cho cả claim lẫn
  snapshot; `durationSec` = finite nonnegative; categorical chỉ `eq`
  (normalize trim/ws/case); date = **strict RFC3339 UTC**
  (`YYYY-MM-DDTHH:MM:SS[.fff]Z`, regex + canonical roundtrip — reject
  `'2020'`, locale date, offset `+07:00`, ngày không tồn tại như
  `2025-02-30`), epoch `eq|gte|lte`. Snapshot null/missing → `EVIDENCE`
  (không suy ra 0); metric/type sai → `INVALID`.
- `fact` sai → `EVIDENCE` chặn completion. `inference`/`unverifiable` chỉ là
  label, KHÔNG tính verified. Summary `{factVerified,factFailed,inference,unverifiable}`
  do **daemon tự tính** và đính vào event `completed` — không tin field
  `factVerified` tự khai trong manifest.

## Tests

`packages/daemon/test/research-task/{store,lifecycle}.test.ts` — 24 tests:
idempotency/budget, ACL scope, queue claim + worker isolation, lease expiry →
mark_unknown → rebind, cancel release reservation, instruct boundary,
crash/restart cursor, hard gate (fake/running/ghost-video/tamper), MCP
role-filter + E2E call chain, outbox poll/ack/ack_one, quota fail-closed +
cross-task aggregate, artifactDir projection/confinement, supersede,
cancel-preserved rebind, P3 v2 claims (happy path + 14 reject cases +
downgrade attempt + v1 compat).
