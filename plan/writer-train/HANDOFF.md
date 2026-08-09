> **Agent:** writer-train
> **Status:** planned
> **Owns:** `packages/pipeline-core`, `packages/training-core`, `packages/daemon/src/pipeline/**`, `packages/daemon/src/training/**`, `packages/daemon/test/{pipeline,training}/**`, `packages/web/src/features/{turn-bridge,datasets,batches,training}/**`
> **Does not touch:** `packages/spy/**`, `packages/daemon/src/team/**`, `packages/daemon/src/agents/**` (trừ 1 dòng ở §Ranh giới), `src-tauri/**` (PTY đã ship — chỉ gọi qua `terminalApi`), Writer lane (`writer-core`, `daemon/src/writer`), `docs/**` (chỉ đọc)
> **Depends on:** [`docs/specs/002-writer-agent-mvp/solution-design.md`](../../docs/specs/002-writer-agent-mvp/solution-design.md) v0.4 · P-DEF-1b trong [`../deferred-agent-terminal-process.md`](../deferred-agent-terminal-process.md) — **ADR-10 phải được user xác nhận trước M0.5**

# Handoff — writer-train

## 1. Bạn đang nhận gì

Lane **Training** của SDD 002: từ N video → mỗi video một item phân tích độc lập →
tổng hợp thành `TRIAL` Formula. Kèm theo là **execution layer dùng chung** cho cả
Writer lane sau này.

SDD là nguồn sự thật duy nhất, **không copy nó vào folder này**
(quy ước `plan/README.md`). Handoff này chỉ nói: đọc gì, làm theo thứ tự nào,
đâu là ranh giới, xong là xong khi nào.

| Cần gì | Đọc mục nào của SDD 002 |
|---|---|
| Toàn cảnh lỗ hổng + bằng chứng file:line | §0 Flow Interruption Audit |
| turnBridge, I/O contract, lane, ledger, fencing | §5.1 → §5.7 |
| Trạng thái batch/item, stop/pause | §6.2, §6.4 |
| Bảng mã lỗi + câu chữ UI | §6.5 |
| Màn hình + state bắt buộc | §7.1 → §7.7 |
| Milestone và exit condition | §12 |
| Test plan | §Test Plan |

## 2. Sự thật quan trọng nhất (đọc trước khi viết dòng code đầu tiên)

**Harness chưa chạy được turn nào vì `turnBridge` (P-DEF-1b) còn deferred.** Rust PTY
đã ship và đã thread sẵn `turn_id` xuyên suốt (`src-tauri/src/terminal/mod.rs:44` →
`:87` → `:385`); daemon đã emit `spawnTurn`. Thiếu đúng đoạn nối: SSE → `launchTab` →
`terminal://exit` → `POST /api/team/turn/complete`, cộng heartbeat từ ring buffer.

Luật kiến trúc đã chốt (`docs/plans/agent-harness-architecture.md:19`): **process
authority ở Rust PTY, workflow/state ở daemon, UI chỉ bridge**. Không viết
orchestrator/PTY stack thứ hai ở daemon.

Vì vậy nhiệm vụ #1 của bạn không phải domain Training, mà là **hoàn tất turnBridge**.
Nếu bắt đầu bằng Formula/prompt, bạn sẽ debug 15 phút mỗi lần chỉ để phát hiện turn
chết vì watchdog.

Mở 5 file sau và đọc đúng những dòng này trước:

| File:line | Điều phải nắm |
|---|---|
| `packages/daemon/src/team/workflow.ts:331` | `spawnTurn` được emit — chưa ai nhận (P-DEF-1b) |
| `packages/daemon/src/team/workflow.ts:339` | `forceHeadless` / `interactiveRequired` — 2 đường đã lường sẵn; pipeline luôn rơi vào headless |
| `src-tauri/src/terminal/mod.rs:44,87,385` | PTY nhận `turn_id` và trả lại trong `terminal://exit` — bridge chỉ cần dùng |
| `packages/web/src/components/terminal/TerminalDrawer.tsx:17` | đang chỉ `markExit` local — chưa gọi `turn/complete` |
| `packages/daemon/src/team/workflow.ts:243` | dedup: `requestTurn` thứ 2 **trả về turn cũ** và ghi đè `taskNote` → 2 item trộn vào 1 turn. Luôn `exclusive: true` |
| `packages/daemon/src/team/workflow.ts:271` | 1 turn chạy / 1 agent id → song song bằng cách **clone agent theo từng turn** (ADR-9) |
| `packages/daemon/src/agents/config.ts:29` | id clone phải khớp `^[a-z0-9][a-z0-9-]{0,40}$` — không dùng `claude#1` |
| `packages/daemon/src/agents/index.ts:118-126` | ⚠ `delete()` xoá `<projectRoot>/AGENTS.override.md` → clone **không** được trỏ projectRoot vào repo root |
| `packages/daemon/src/team/workflow.ts:200-229` | thứ tự guard; `maxDurationMinutes` tính từ lúc daemon boot |
| `packages/daemon/src/team/workflow.ts:374-385` | `orchestrated: true` = settle 1 lần, **không auto-retry** → retry là việc của pipeline |
| `packages/daemon/src/agents/adapters.ts:102` | prompt đi vào argv → transcript sẽ vỡ `execve` (E2BIG). Prompt phải là **file** |
| `packages/daemon/src/agents/index.ts:375-382` | cwd allowlist = `<data>/workspaces` → thư mục run của item phải nằm dưới đó |
| `packages/daemon/src/team/store.ts` `reconcileStale()` | reboot đánh dấu mọi turn dở dang là `stale`; job/budget in-memory mất sạch |

## 3. Ranh giới

**Được thêm/sửa**

- `packages/pipeline-core/**` — contract generic (dataset, batch, item, attempt, ledger, event, reducer). **Không** được biết gì về Formula hay Writer.
- `packages/training-core/**` — contract + validator riêng Training.
- `packages/daemon/src/pipeline/**` — lane-scheduler, ledger, workspace, events, preflight.
- `packages/web/src/features/turn-bridge/**` — P-DEF-1b, consumer **duy nhất** của `spawnTurn`.
- `packages/daemon/src/training/**` — orchestrator + aggregator.
- `packages/daemon/src/http.ts` — **chỉ thêm route mới**, không sửa route sẵn có.
- `packages/web/src/features/{datasets,batches,training}/**`, `packages/web/src/router.ts`, `packages/web/src/api.ts` — chỉ thêm.
- Root `package.json`, `tsconfig.base.json` — đăng ký package mới vào workspace + typecheck + test (SDD §Project Commands).

**Không được đụng**

- `packages/daemon/src/team/**` — harness state machine. Nếu thấy cần sửa: **dừng lại, báo user**, đừng tự sửa.
- `packages/spy/**` — chỉ gọi qua API/service có sẵn.
- `packages/daemon/src/agents/**` — **ngoại lệ duy nhất**: thêm run-root vào `workspaceRoots` ở `harness.ts:70` (SDD §5.8 mục 2). Đúng một thay đổi đó, commit riêng.
- `src-tauri/**` — PTY đã ship và đủ dùng. Nếu thấy cần sửa Rust: dừng, báo user.
- Writer lane (`writer-core`, `daemon/src/writer`, `web/src/features/writer`) — của agent khác. Bạn chỉ định nghĩa contract chung ở `pipeline-core` sao cho lane đó cắm vào được mà không phải sửa bạn.
- `docs/**` — chỉ đọc. Phát hiện SDD sai thì ghi vào §Notes của `STATUS.md`, đừng tự sửa SDD.

## 4. Thứ tự làm (bám milestone SDD §12)

Mỗi bước là một commit độc lập, xanh test trước khi qua bước sau.

### M0 — Pipeline Core + stub agent

- Contract: `DatasetRevision`, `BatchRun`, `ItemRun` (đủ 10 status ở SDD §Application Data Models), `Attempt`, `StageLedgerRow`, `PipelineEvent`.
- Reducer thuần: item states → batch status theo **đúng bảng SDD §6.2**, kể cả `NEEDS_ATTENTION`.
- `turn_key = sha256(batchId|itemId|stage|attempt|sorted(inputHashes)|promptVersion)`.
- Workspace store: ghi artifact → fsync → rename manifest (SDD §5.2 commit rule).
- **Stub agent adapter**: một binary giả (script bun) đọc `prompt.md`, ghi `out/result.json`, có mode `exit-nonzero`, `no-output`, `bad-schema`, `write-outside`, `hang`. Đây là thứ cho phép test toàn bộ pipeline mà không tốn token.
- DoD: `bun test packages/pipeline-core` xanh, phủ mọi dòng bảng §6.2 và cả 6 nhánh commit rule.

### M0.5 — Walking skeleton (⚠ chốt chặn thật sự)

ADR-8 và ADR-10 đã được user xác nhận 2026-08-09 — không còn gì chặn bước này.

- `web/src/features/turn-bridge/`: mount 1 lần ở app root (không nằm trong drawer), `EventSource('/api/team/events')` có reconnect + re-sync qua `/api/team/status`; claim `turnId` cục bộ để **không bao giờ** launch trùng; `spawnTurn` + `forceHeadless` → `terminals.launchTab({...spec, turnId, readOnly: true})`; poll ring-buffer sequence 10s → `POST /api/team/turn/heartbeat`; `terminal://exit` → `POST /api/team/turn/complete` + snapshot ring buffer vào `stdout.log`; `interrupt` → `termKill`; `beforeunload` → interrupt mọi turn đang claim.
- `agent-pool.ts`: clone agent template theo từng turn (`{template}-{batch}-{item}-a{attempt}`, `ephemeral: true`, projectRoot = run dir), reap sau khi settle/stop/boot-recovery. Lọc ephemeral khỏi `GET /api/agents`.
- `lane-scheduler.ts`: chủ sở hữu duy nhất của `requestTurn`; dispatch lên clone id; giữ `maxParallel` (default 3); luôn `exclusive: true`, `orchestrated: true`, `skipWorktree: true`, `budget` scoped theo `batchId`, `allowedTools: ['Read','Write','Glob']` (**không** `mcp__team`), `overrideCwd` = run dir dưới `workspaces/`.
- Guard bị từ chối = **backpressure**, item ở `WAITING_LANE`, **không phải** `FAILED`.
- DoD: **một turn Claude thật** đọc `prompt.md`, ghi `out/result.json`, app validate + commit artifact; pane hiện read-only trong drawer; đóng app giữa chừng → mở lại → item `INTERRUPTED` → attempt mới, không commit trùng. Đây là bằng chứng GAP-1/2/3 đã đóng.

### M1 — Formula Discovery, 1 video

- Preflight (SDD §7.2): binary detect, transcript có/không, channel resolve từ Spy snapshot (**không** để agent tự đoán), ước tính lượt + thời gian.
- Stage `PREPARE → ANALYZE → (REVIEW) → DONE` theo bảng SDD §6.1.
- Validator: mọi rule phải có `evidence[{locator, quote}]` trỏ vào transcript đã pin, nếu không → `AGENT_UNGROUNDED`.
- Aggregator: 1 item → `TRIAL` Formula có provenance đầy đủ. Assert cứng: `VALIDATED` không thể được gán trong MVP.
- DoD: chạy 1 video thật ra 1 Formula xem được, mở lại được, hash khớp.

### M2 — Batch + multi-channel

- N item, lane queueing, `PARTIAL_SUCCESS`, retry đúng 1 item (attempt+1, epoch+1), skip, `Continue with successes`.
- Scope bắt buộc khi dataset nhiều channel (`SCOPE_REQUIRED`), cảnh báo `LOW_SAMPLE`.
- Aggregation kiểm tra lại hash trước khi tổng hợp → `AGGREGATION_STALE`.
- UI dashboard SDD §7.4: cột trạng thái **luôn kèm lý do**, hiển thị lane, filter `Cần xử lý`, SSE có cursor + replay, banner mất kết nối.
- DoD: test e2e 3 video / 2 channel theo SDD §Test Plan.

### M3 — Resilience

- Boot recovery SDD §5.6: kill orphan theo pid trong `turn.json`, item → `INTERRUPTED` → attempt mới, re-seed scoped budget từ ledger.
- Fencing: attempt cũ ghi muộn **không bao giờ** được commit.
- Stop/pause đúng SDD §6.4 — **tuyệt đối không gọi `workflow.stopAll()`**.
- DoD: giết daemon giữa batch, giết process agent, mất mạng → mọi item về trạng thái đúng, không commit trùng, không process mồ côi.

Sau M3, bàn giao contract `pipeline-core` cho agent Writer lane (M4 trong SDD).

## 5. Xong là xong khi nào

- [ ] `bun test packages/spy packages/daemon packages/pipeline-core packages/training-core` xanh
- [ ] `bun run typecheck` xanh; package mới có trong workspace + 2 lệnh trên
- [ ] `bun run ui:build` xanh
- [ ] M0.5 chứng minh bằng 1 run thật, log đính trong progress file
- [ ] Mọi acceptance criteria nhóm **Execution layer**, **Training and Formula**, **Batch and recovery** trong SDD tick được
- [ ] Không có file nào ngoài §Ranh giới bị sửa (`git diff --stat` tự kiểm)
- [ ] `STATUS.md` cập nhật; báo user **"check"** để sync agent ghi `SYNC.md`

## 6. Bẫy đã biết (đừng học lại bằng cách mất 1 ngày)

- exit code 0 **không** phải là thành công. Artifact hợp lệ mới là (SDD §5.2).
- `store.setAssignment` chỉ có 1 row/agent → **không bao giờ** dùng nó để mang task riêng của item.
- `stopAll()` là global + dính, phải `reset()` mới chạy lại được → không dùng cho batch.
- Transcript không được đi vào argv (E2BIG) và **không** được đi vào team message: `handleNewMessage` quét `@id` trong body và spawn turn thật (`workflow.ts:187`) — transcript chứa "@codex" sẽ tự kích hoạt agent.
- Codex headless không có MCP và chạy `--dangerously-bypass-approvals-and-sandbox` → không confine được; vi phạm ghi ngoài `out/` chỉ **phát hiện sau** bằng diff cây thư mục, đừng viết doc/comment như thể đã sandbox.
- Cost chỉ lấy được cho Claude (parse đuôi `stream-json` trong ring buffer của pane). UI phải ghi "ước tính (chỉ Claude)".
- `HUMAN_WAIT` phải **reap clone** ngay, nếu không batch tự khoá.
- Clone rò rỉ = leak: crash giữa chừng phải dọn clone lúc boot, nếu không `team.json` phình ra vô hạn.
- `cooldownSeconds` phải là 0 cho turn pipeline; để mặc định 15s thì turn nằm `queued` và mới có nguy cơ chạm `maxQueueDepth`.
- Item run dir phải nằm dưới `<data>/workspaces/` nếu không muốn debug interactive bị chặn bởi allowlist.
- **Daemon không tự restart khi tắt/mở lại app Tauri** (chủ đích — `src-tauri/src/lib.rs`: "closing the window does not kill the daemon"; Tauri chỉ `spawn_daemon` nếu health-check thất bại lúc mở app). Sửa code daemon xong, tắt/mở app không nạp code mới — phải tự `kill` process `bun packages/daemon/src/index.ts` cũ rồi chạy lại tay.

## 7. Câu hỏi phải hỏi user, không được tự quyết

1. ADR-8 — ✅ đã chốt 2026-08-09: hoàn tất turnBridge phía client, **không** xây runner ở daemon. Đóng app = batch tạm dừng, chấp nhận đánh đổi này (CON-13).
2. ADR-10 — ✅ đã chốt 2026-08-09: trao đổi kết quả qua file.
3. ADR-9 — ✅ đã chốt: clone agent theo turn, `maxParallel` là setting của user.
4. ADR-2 — filesystem là nguồn sự thật + SQLite index dẫn xuất. Chặn M0.
5. ADR-5 — multi-channel bắt buộc chọn scope. Chặn M2.

ADR-7 và ADR-12 thuộc Writer lane, không chặn bạn.
