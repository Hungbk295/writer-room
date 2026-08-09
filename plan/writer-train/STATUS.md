# writer-train — STATUS

| Field | Value |
|-------|-------|
| Agent | writer-train |
| Status | active |
| Current plan | [`HANDOFF.md`](./HANDOFF.md) |
| Last commit | — |
| Last sync check | — |
| Updated | 2026-08-09 |

## Active work

Lane Training của SDD 002 + execution layer dùng chung (M0 → M3).

| Milestone | Trạng thái |
|---|---|
| M0 — Pipeline Core + stub agent | **done** — `packages/pipeline-core` created 2026-08-09, `bun test` 33/33 green, typecheck clean |
| M0.5 — Walking skeleton (turnBridge P-DEF-1b) | **done 2026-08-09** — E2E thật xác nhận: turn Claude thật qua turnBridge, `out/result.json` commit thành artifact có hash, clone reaped |
| M1 — Formula Discovery 1 video | **done 2026-08-09** — full flow demo Claude(sonnet)→Codex(terra high) chạy thật thành công, xem "Demo full flow" bên dưới |
| M2 — Batch + multi-channel | user nói chưa cần quan tâm — sẽ mô tả luồng nhiều video/channel sau. Chờ ADR-5 khi tới lúc. |
| M3 — Resilience | chưa bắt đầu |

## Notes / blockers

- ADR-2, ADR-8, ADR-9, ADR-10 đã được user xác nhận 2026-08-09.
- **ADR-8 quyết định cuối:** hoàn tất `turnBridge` (P-DEF-1b) phía Tauri client, dùng lại Rust PTY sẵn có. **Không xây daemon-side Turn Runner** — user đã bỏ hẳn hướng này, không giữ làm phương án dự phòng. Đóng app Tauri = batch tạm dừng (CON-13), chấp nhận đánh đổi.
- ADR-5 (multi-channel scope) vẫn `Pending`, chặn M2.
- Ranh giới tôn trọng: không sửa `packages/daemon/src/team/**`, `src-tauri/**`, `packages/daemon/src/agents/**` (chỉ gọi API sẵn có).

### M0.5 đã build gì (2026-08-09)

- **Client** `packages/web/src/features/turn-bridge/` — nghe SSE `/api/team/events`, gọi `terminals.launchTab` (Tauri PTY sẵn có) cho mỗi `spawnTurn`, báo `turn/complete` khi pane thoát, heartbeat 10s. Verify được: typecheck sạch, `vite build` xanh. **Không verify được**: chưa chạy Tauri thật, không có tool điều khiển desktop app native.
- **Daemon** `packages/daemon/src/pipeline/` (`ledger.ts`, `agent-pool.ts`, `lane-scheduler.ts`) — clone/reap agent theo turn, `dispatchItem` (idempotent turn_key → ghi input/prompt.md/out rỗng → admit lane → dispatch), commit rule 5/6 nhánh (bỏ nhánh 4 AGENT_UNGROUNDED — thuộc M1). 2 route mới: `POST /api/pipeline/items/dispatch`, `GET /api/pipeline/health`. Verify được: `bun test` 85/85 xanh (12 test pipeline mới, dùng fake bridge — gọi thẳng `runStubAgent` + `workflow.turnComplete`, không tốn token thật), typecheck sạch.
- Đã bỏ qua có chủ đích (ghi rõ trong code, không phải thiếu sót): M3's orphan-pid kill khi boot (chỉ mark `INTERRUPTED`, chưa kill process thật), SQLite ledger index (JSONL đủ cho M0.5, index là optimization derived theo ADR-2), reconnect replay `spawnTurn` đã miss (backend chưa có `?cursor=` trên `/api/team/events`).

### M0.5 smoke test thật (2026-08-09, xác nhận GAP-1/2/3 đã đóng)

`POST /api/pipeline/items/dispatch` với `batchId:"m05-smoke", itemId:"item-1", stage:"smoke", templateId:"claude"` → turn Claude thật chạy qua turnBridge/PTY → `out/result.json` đúng nội dung yêu cầu → ledger `COMMITTED` với `artifactHash`, `artifacts/smoke-v1.json` + `item-manifest.json` ghi đúng dưới `writer-room-data/workspaces/pipeline/m05-smoke/item-1/attempts/1/smoke/` → clone `claude-7b9c23-59908d-a1` reaped, `liveClones` về 0. Toàn bộ chuỗi §5.1→§5.3→§5.5 đã chạy thật, không phải mô phỏng.

**Bẫy phát hiện lúc test — ghi vào §6 HANDOFF cho lần sau:** daemon **không** tự restart khi tắt/mở lại app Tauri (by design — comment trong `src-tauri/src/lib.rs`: "closing the window does not kill the daemon — harvest jobs can outlive the UI"; Tauri chỉ `spawn_daemon` nếu health-check thất bại lúc `setup()`). Sau khi sửa code daemon, phải tự kill process `bun packages/daemon/src/index.ts` cũ rồi chạy lại (hoặc mở app khi chưa có daemon nào sống) — restart riêng app Tauri không đủ.

**Đã giải quyết 2026-08-09:** SDD từng có hai thiết kế mâu thuẫn cho M0.5 (turnBridge/PTY ở §5.1 vs "daemon Turn Runner" ở ADR-8 cũ). User chốt: **chỉ dùng PTY qua turnBridge, bỏ hẳn Turn Runner.** ADR-8 trong SDD đã được viết lại khớp hướng này và đánh dấu confirmed.

### M1 — Formula Discovery, xây gì (2026-08-09)

- Package mới `packages/training-core` — `AnalysisArtifact`/`FormulaArtifact` contract, `validateAnalysis()` (grounding gate: quote phải là substring nguyên văn của đúng segment được cite → nếu không, `AGENT_UNGROUNDED`), `formulaFromSingleAnalysis()` (ADR-6: hard-code `status: 'TRIAL'`, không có tham số nào tạo được `VALIDATED`).
- `packages/daemon/src/pipeline/lane-scheduler.ts` được nới thêm 1 hook `validateContent` — lấp đúng vị trí Branch 4 (AGENT_UNGROUNDED) mà M0.5 bỏ trống, không phá M0.5 test nào (85/85 vẫn xanh khi test lại).
- `packages/daemon/src/training/` — `preflight.ts` (§7.2: channel/transcript/agent-binary check), `orchestrator.ts` (PREPARE→ANALYZE→DONE, bỏ REVIEW/Codex — optional, có ghi chú chỗ nối sau này), `aggregator.ts` (nghe `onItemSettled`, re-hash chống stale, build Formula), `storage.ts` (JSON-per-file, giống `writer-packs.ts`). 4 route mới: `POST /api/training/preflight`, `POST /api/training/formula-discovery`, `GET /api/training/formulas`, `GET /api/training/formulas/:id`.
- Test: `bun test` tổng 99/99 xanh (8 test training mới, dùng fake bridge), typecheck sạch.

### M1 smoke test thật (2026-08-09)

Video thật kênh "Sói Tài Chính" (`93fe5c36-546c-4163-b733-ddd5a421df85`, 436 đoạn transcript) → preflight `ready:true` → dispatch ANALYZE → Claude thật đọc transcript, trích 7 rule kèm evidence tiếng Việt đúng nguyên văn → commit → `TRIAL` Formula lưu được, đọc lại được qua API, hash artifact khớp file trên đĩa (`shasum -a 256` xác nhận tay).

### UI luồng 1 video (2026-08-09) — chờ user xác nhận trong app thật

Trang Spy Run (video có `transcriptStatus: ok`) giờ có nút **🧪 Tìm Formula** ngay cạnh "Xem trên YouTube": bấm → preflight → chạy → poll trạng thái → xong thì hiện link **Xem Formula →**. Trang mới `#/training/formulas` (danh sách, badge TRIAL/DRAFT/VALIDATED luôn hiện theo SDD §7.7) và `#/training/formulas/:id` (chi tiết: rule + evidence + provenance). Nav "Formula" thêm vào TopNav.

Backend thêm 1 route: `GET /api/training/formula-discovery/status?batchId=&videoSnapshotId=` để UI poll. `FormulaArtifact` thêm field `sourceBatchId` (optional, để UI khớp Formula vừa tạo với lần dispatch).

Verify được: `bun test` 99/99 xanh, typecheck sạch, `vite build` xanh. **Chưa verify được**: chưa click thật trong Tauri app — cần user tự thử (mở Spy → chọn video có transcript → bấm Tìm Formula → xem có ra Formula không). Nhớ **restart daemon** trước khi thử (xem bẫy daemon-restart ở HANDOFF §6).

**Sự cố gặp phải khi test, chưa kết luận được nguyên nhân gốc:** 2 lần dispatch đầu (turn 2, 3) đều bị watchdog `stall` giết đúng ~180.000s — quá đều để là do model "nghĩ lâu" (nếu vậy thời điểm chết sẽ lệch theo lượng heartbeat thực nhận được), nhiều khả năng là `turnBridge`'s heartbeat (`packages/web/src/features/turn-bridge/client.ts`) không gửi được lần nào trong 2 lần đó. Lần thứ 3 (turn 4) thành công trong 84s — nhanh hơn nhiều so với 180s cũ, nên có thể là sự cố thoáng qua (không loại trừ: daemon vừa restart, MCP server vừa khởi động lại, hoặc cold-start clone lần đầu). Đã tăng `STALL_MS` từ 180_000 → 600_000 trong `lane-scheduler.ts` làm biên an toàn, **chưa xác nhận được root cause** — nếu gặp lại stall ở batch lớn hơn (M2), cần bật DevTools console trong Tauri xem `[turnBridge]` log, hoặc thêm log phía server mỗi lần `workflow.heartbeat()` được gọi để đối chiếu.

### Demo full flow: Claude(sonnet) trích xuất → Codex(terra high) viết bài (2026-08-09, theo yêu cầu user)

Dùng lại đúng hạ tầng generic của M0.5 (`POST /api/pipeline/items/dispatch`, không xây riêng "Writer lane" — đó là scope M4 lớn, có citation gate/thesis/brief/architecture riêng theo SDD §6.3, §8.3, chưa làm). Formula TRIAL (7 rule, kênh "Sói Tài Chính") từ bước M1 → làm input cho 1 turn `codex` viết script mới áp dụng các rule.

**Phát hiện + sửa 1 bug thật ngoài lane của tôi (đã xin phép trước khi sửa — user chính là người yêu cầu chạy demo với codex terra high):** turn Codex đầu tiên (turnId 5) chết ngay lập tức (`AGENT_EXIT`, <1s, không ghi gì). Root cause xác nhận bằng tay: agent `codex` trong `agents/team.json` có `args: ["--model","gpt-5.6-terra","high","--dangerously-bypass-approvals-and-sandbox"]` — `"high"` bị đưa vào như một positional prompt thay vì flag reasoning-effort; `codex exec` chỉ nhận đúng 1 positional `[PROMPT]`, nên khi turn prompt thật được thêm vào, `exec` báo `unexpected argument`. Cú pháp đúng: `-c model_reasoning_effort=high`. Test tay bằng `codex exec` trực tiếp xác nhận trước khi sửa.

Đã sửa qua `PUT /api/agents` (chỉnh data trong `agents/team.json`, **không sửa code nguồn** — tôn trọng ranh giới không đụng `packages/daemon/src/agents/**`). Turn thứ 2 (turnId 6) chạy thành công trong 46s, Codex áp dụng đủ cả 7 rule, viết script ~450 từ tiếng Việt đúng phong cách Formula (mở bằng câu chuyện cụ thể có số liệu, đặt tên khái niệm riêng "Phí Trôi Dạt" lặp lại như nhãn phần, chia 3 "Phần", nhân vật phụ đối lập (Mai), chốt bằng khung 3 khái niệm).

**Đã sửa tận gốc (2026-08-09, user cho phép đụng ngoài ranh giới lần này):** `packages/daemon/src/agents/defaults.ts` — `CODEX_DEFAULT_ARGS` đổi sang `-c model_reasoning_effort=high`; thêm nhánh repair trong `ensureDefaultAgents()` nhận diện đúng shape args cũ bị lỗi (`BROKEN_CODEX_ARGS_V1`) và tự vá cho mọi instance/agent session khác từng seed bản cũ (không đụng args nếu user đã tự tùy biến). Thêm 2 test regression guard trong `packages/daemon/test/agents-defaults.test.ts`. `bun test` 101/101 xanh, typecheck sạch. Đây là lần duy nhất tôi đụng `packages/daemon/src/agents/**` ngoài ngoại lệ workspaceRoots đã định — có xin phép trước.
