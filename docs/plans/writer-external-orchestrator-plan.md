# Writer v2 — Plan: Writer MCP + agent ngoài chạy qua 1DevTool, app chỉ xem tiến độ

> Tạo 2026-09-07 · Đối chiếu source `780eafc` · Baseline test `bun test packages/daemon/test/writer/` 274 pass / 0 fail.
> Chủ kênh duyệt tóm tắt ngày 2026-09-07. Design gốc: `docs/plans/writer-orchestrator-mcp-multiagent-design.md` (§8.3 substrate adapter).
> Luồng biên tập (2 agent, 8 lượt) nằm ở `docs/writer-flow-and-packs.md`, plan này **không** đổi luồng đó; chỉ đổi nơi chạy agent.

## 0. Mục tiêu và quyết định đã chốt

**Mục tiêu:** một agent ngoài (orchestrator, chạy trên 1DevTool) đi được từ title tới DONE chỉ bằng
tool MCP; writer và editor do orchestrator mở bằng `1devtool-agent`; app Tauri mở hay đóng đều
không ảnh hưởng, và khi mở thì thấy stage nào đang chạy, trên đâu, bao lâu, note gần nhất.

| # | Quyết định | Hệ quả |
|---|---|---|
| 1 | Nút Run trong app, bridge spawn pane, harness mount MCP nội bộ **giữ nguyên** | Run tạo từ app mặc định `substrate: terminal`, hành vi y hệt hôm nay |
| 2 | `substrate` đặt trên post lúc tạo, chỉ sửa khi còn DRAFT | Không có run nào nửa terminal nửa external |
| 3 | Daemon vẫn là settle machine duy nhất | Stage file, validator, gate, sandbox check, hard cap 45 phút không đổi |
| 4 | Với `external`, daemon **không phát `spawnTurn`**; phát `externalTurn` chỉ để thông báo | Bridge trong app không có gì để mở pane |
| 5 | Chọn hook: orchestrator dừng ở HOOK_READY chờ người chọn trên app | `hookStrategy: auto` để đợt sau, chưa có hàm chấm điểm hook trong daemon |
| 6 | Tab 1DevTool: đóng khi stage xong, giữ khi stage FAILED | Ghi trong skill orchestrator |
| 7 | Tiến độ đợt này: phase + turn hiện tại + timeline note. Pane attach read-only để đợt sau | UI chỉ đọc run JSON, không cần SSE mới |
| 8 | Mỗi stage là một agent 1DevTool mới | Giữ luật context mới; WRITE không thấy pack |

## 1. Kiến trúc

```text
Người / agent khác
   │  1devtool-agent run --to=claude --terminal --shared-cwd --cwd=<repo>
   │     --flag=--mcp-config=<dataDir>/agents/mcp-orchestrator.json --flag=--strict-mcp-config
   │     --skill=/writer-orchestrate --prompt-stdin   ("postId=… hoặc title+packId")
   ▼
ORCHESTRATOR (skill .claude/skills/writer-orchestrate)
   │ writer_* (MCP `writer-room-writer`)          │ mỗi stage: 1devtool-agent run --to=<agentId>
   ▼                                             │   --terminal --wait --shared-cwd --cwd=<itemRunDir>
Daemon                                           ▼
   McpWriterServer ─► hàm writer-run-v2 / hook-board / external-turn
   LaneScheduler.dispatchItem(substrate: external) → TeamWorkflow: turn RUNNING, KHÔNG spawnTurn
   writer_stage_complete → workflow.turnComplete → validate → gate → phase kế
   run.timeline[] ◄─ writer_stage_progress
   withWriterV2Progress(run, openTurns) → currentTurn ─► App poll GET run → hiển thị
```

Hợp đồng stage không đổi: agent đọc `<itemRunDir>/prompt.md`, chỉ ghi `<itemRunDir>/out/result.json`.

## 2. Gói B — substrate external trong daemon (làm trước)

### B1. Model

| File | Việc |
|---|---|
| `packages/daemon/src/writer/writer-run-v2.ts` | `export type WriterSubstrate = 'terminal' \| 'external'`. `WriterRunV2` thêm `substrate: WriterSubstrate` (đọc run cũ thiếu field → coi là `terminal`), `timeline?: WriterTimelineEntry[]` (tối đa 50, cắt đầu). `WriterTimelineEntry = { at: string; turnId?: number; stage?: string; kind: 'note' \| 'external' \| 'system'; text: string; external?: ExternalRef }`. `ExternalRef = { runId?: string; teamId?: string; memberId?: string; terminalId?: string }`. `WriterV2PostConfigInput` thêm `substrate?`. `createWriterPostV2` mặc định `'terminal'`. `updateWriterPostV2` nhận `substrate`, chỉ khi DRAFT (guard sẵn có). |
| `packages/daemon/src/writer/run-store-v2.ts` | `WriterRunV2Summary` thêm `substrate`, `summarize()` copy field. |
| `packages/daemon/src/writer/writer-run-v2.ts` `withWriterV2Progress` | Thêm tham số tuỳ chọn `openTurns?: OpenTurn[]`; trả thêm `currentTurn: { turnId, stage, attempt, agentId, itemRunDir, startedAt, deadlineAt, external? } \| null` (external lấy từ entry timeline `kind: 'external'` mới nhất có cùng `turnId`). |
| `packages/daemon/src/http.ts` | PUT `/posts/:id` (2069–2085), POST `/runs` (2121–2131), POST `/rooms` (2169–2179) nhận `substrate`, validate ∈ {terminal, external}. Mọi GET run/post đơn lẻ gọi `withWriterV2Progress(run, scheduler.listOpenTurns(run.id))`. |

### B2. Luồng dispatch

| File | Việc |
|---|---|
| `packages/daemon/src/pipeline/lane-scheduler.ts` | `DispatchItemParams.substrate?: 'terminal' \| 'external'` (mặc định terminal). Trong `dispatchItemInternal` (337): truyền `external: params.substrate === 'external'` vào job `requestTurn` (394–419); lưu vào `turnRegistry` entry thêm `stage, attempt, templateId, itemRunDir, startedAt, deadlineAt (= startedAt + timeoutMs), assignmentText (= taskNote đã build), external: boolean`. Thêm `listOpenTurns(batchId): OpenTurn[]` đọc từ `turnRegistry` các turn còn RUNNING của batch đó. Export `OpenTurn`. |
| `packages/daemon/src/team/workflow.ts` | `TurnJob.external?: boolean`. Trong `dispatchNext` (269–359): nếu `job.external` thì **không** emit `spawnTurn`; emit `{ kind: 'externalTurn', turnId, agentId, cwd: job.overrideCwd, injectText }`. Watchdog vẫn `armTurnWatchdog` như cũ (hard cap giữ). Thêm member `externalTurn` vào `TeamEvent`. `turnComplete` không đổi. |
| `packages/daemon/src/writer/study-orchestrator.ts` (409–448), `writer-run-v2.ts` WRITE 1620 / EDIT 1915 / REPAIR 2015 / RESTYLE 2491 / POSTMORTEM 2647, `hook-board.ts` 136 / 218 | Mỗi `dispatchItem` thêm `substrate: run.substrate ?? 'terminal'`. STUDY đi qua `LegacyStudyDispatchInput`: thêm field `substrate` vào allowlist đó. |

### B3. Hàm cho caller ngoài (HTTP trước, MCP bọc sau)

File mới `packages/daemon/src/writer/external-turn.ts`, deps `{ scheduler: LaneScheduler; workflow: TeamWorkflow; dataDir }`:

| Hàm | Hành vi | Lỗi |
|---|---|---|
| `getOpenWriterTurn(deps, runId)` | Run phải tồn tại. Trả `OpenTurn` đầu tiên của `listOpenTurns(runId)` kèm `promptPath = <itemRunDir>/prompt.md`, `resultPath = <itemRunDir>/out/result.json`; `null` nếu không có turn mở | `RUN_NOT_FOUND` |
| `noteWriterTurnProgress(deps, runId, { turnId?, text, external? })` | Append `timeline` entry `kind: external ? 'external' : 'note'`, lưu run. `turnId` nếu có phải đang mở | `RUN_NOT_FOUND`, `TURN_NOT_OPEN` |
| `completeWriterTurn(deps, runId, { turnId, exitCode, external? })` | Run phải `substrate: external`; turn phải thuộc `batchId === runId` và đang mở; nếu `external` có thì append timeline trước; gọi `workflow.turnComplete(turnId, { exitCode })`. Trả `{ ok: true, turnId }`. Việc validate `out/result.json`, sandbox, gate vẫn do settle path hiện có làm | `RUN_NOT_FOUND`, `SUBSTRATE_NOT_EXTERNAL`, `TURN_NOT_OPEN` |

HTTP trong `http.ts`, đặt cạnh nhóm `/runs/:id/continue`:

```text
GET  /api/writer/v2/runs/:id/turn                    → { turn: OpenTurn|null, phase, status }
POST /api/writer/v2/runs/:id/turn/:turnId/progress   { text, external? }
POST /api/writer/v2/runs/:id/turn/:turnId/complete   { exitCode, external? }
```

`harness.workflow` đã có trên `harness` (http.ts 528); truyền vào deps.

### B4. Test (bắt buộc xanh)

- `packages/daemon/test/pipeline/lane-scheduler.test.ts`: job `substrate: 'external'` → bắt được `externalTurn`, **không** có `spawnTurn`; `listOpenTurns` trả đúng 1 entry với `itemRunDir`, `deadlineAt`; sau `turnComplete` thì rỗng.
- `packages/daemon/test/writer/writer-run-v2.test.ts`: helper mới `completeExternalStage(runId, stage, result)` = chờ ledger row + ghi `out/result.json` + `completeWriterTurn`. Test: post `substrate: 'external'` chạy STUDY → WRITE → gate pass → DONE mà `turnLaunches` rỗng; `completeWriterTurn` với turnId lạ → `TURN_NOT_OPEN`; với run terminal → `SUBSTRATE_NOT_EXTERNAL`; artifact ghi ngoài thư mục stage → run FAILED `AGENT_SANDBOX_VIOLATION` như cũ; `timeline` có entry sau `noteWriterTurnProgress`; run JSON cũ không có `substrate` vẫn load và dispatch như terminal.
- `bun run typecheck` sạch.

## 3. Gói A — Writer MCP (sau B)

### A1. Server

File mới `packages/daemon/src/writer-mcp.ts`, class `McpWriterServer`, **copy khung transport** từ `spy-mcp.ts` (285–408: token random, listen 127.0.0.1:0, `handle`, `dispatch`, `tools/list`, `tools/call`, mã lỗi JSON-RPC). Không sửa `spy-mcp.ts` và `general-pack-mcp.ts` vì terminal khác đang sửa hai file đó.

Constructor deps: `{ scheduler, workflow, dataDir, health: () => {...} }`. `serverInfo.name = 'writer-room-writer'`. Mỗi tool trả JSON text; lỗi domain trả `isError: true` với `{ errorCode, reason }`, không ném.

### A2. Tool catalog (tên cố định, skill C dùng đúng tên này)

| Tool | Input | Gọi | Output |
|---|---|---|---|
| `writer_health` | — | `/api/health` nội bộ | `{ ok, agents, spyMcp: bool }` |
| `writer_packs_list` | — | `listWriterPacks` | summary list |
| `writer_post_create` | `channelId, brief, packId, generalPack, title?, audience?, targetWords?, agentId?='claude', editorAgentId?='codex', substrate?='external'` | `createWriterPostV2` | run projection |
| `writer_post_configure` | `postId` + các field như PUT | `updateWriterPostV2` | run projection |
| `writer_hook_clarify` | `postId` | `startHookClarify` | `{ generatingHook }` |
| `writer_hook_answer` | `postId, answers: string[]` | `startHookSuggest` | `{ generatingHook }` |
| `writer_hook_candidates` | `postId` | `getWriterRunV2` | `{ hookClarify, hookCandidates, selectedHook, generatingHook, hookError }` |
| `writer_hook_select` | `postId, selectedId` | `selectHook` | `{ selectedHook }` |
| `writer_run_start` | `postId` | `runWriterRoomV2` | run projection |
| `writer_status` | `runId` | `getWriterRunV2` + `withWriterV2Progress(run, listOpenTurns)` | projection gồm `currentTurn`, `timeline` 10 entry cuối, `progressPercent` |
| `writer_wait` | `runId, until: 'turn' \| 'phase' \| 'terminal', timeoutSec ≤ 600, fromPhase?` | poll nội bộ mỗi 2 giây | snapshot như `writer_status` + `{ timedOut }` |
| `writer_continue` | `runId` | `continueWriterRunV2` | run projection |
| `writer_stage_next` | `runId` | `getOpenWriterTurn` | `{ turn: { turnId, stage, attempt, agentId, itemRunDir, promptPath, resultPath, assignmentText, startedAt, deadlineAt } \| null, phase, status }` |
| `writer_stage_progress` | `runId, turnId?, text, external?` | `noteWriterTurnProgress` | `{ ok }` |
| `writer_stage_complete` | `runId, turnId, exitCode, external?` | `completeWriterTurn` | `{ ok, turnId }` |
| `writer_restyle` | `runId, styleId` | `startRestyle` | `{ restyling }` |
| `writer_get_script` | `runId, version?: 'final' \| number` | `getWriterRunV2` / `readStyledVersion` | `{ title, script, words }` |

`writer_wait` chỉ đọc store và `listOpenTurns`; không giữ lock; timeout mặc định 120.

### A3. Wiring

| File | Việc |
|---|---|
| `packages/daemon/src/http.ts` | Construct sau harness (cần `harness.pipeline.scheduler`, `harness.workflow`) tại vùng 528–535; field `writerMcp` trên `HttpApp`; `GET /api/writer/mcp` → `{ url, token }` (404 khi tắt); `/api/health` thêm `writerMcp: { url }`; stop khi shutdown (2887). **Không** thêm vào `appMcpProvision` (giữ agent trong app y nguyên). |
| `packages/daemon/src/http.ts` | Sau khi start: ghi `<dataDir>/agents/mcp-orchestrator.json` dạng `{ mcpServers: { writer: {type:'http', url, headers:{Authorization}}, writer_room: <spy info nếu bật> } }` (cùng format `writeMcpConfig` ở `agents/index.ts:193`). Ghi đè mỗi lần daemon start vì token đổi. |
| `docs/mcp-inventory.md` | Thêm mục Writer MCP: mount name `writer`, discovery, 17 tool. (File đang có sửa chưa commit từ terminal khác: chỉ **append** một mục ở cuối, không sửa phần trên.) |

### A4. Test

`packages/daemon/test/writer-mcp.test.ts`, helper `callMcp` giống `spy-mcp.test.ts:23`: `tools/list` đủ 17 tên; `writer_post_create` với fixture pack/general pack như `writer-run-v2.test.ts` beforeEach; `writer_stage_next` trả `null` khi DRAFT; vòng đủ: `hook_select` (ghi thẳng candidate vào run bằng store để khỏi chạy hook agent) → `run_start` → `stage_next` trả STUDY với `itemRunDir` tồn tại và `prompt.md` có → ghi `out/result.json` → `stage_complete` → `status.phase === 'WRITE'`; `stage_complete` sai turn → `isError` + `TURN_NOT_OPEN`; token sai → 401.

## 4. Gói C — skill orchestrator (song song B)

File mới `.claude/skills/writer-orchestrate/SKILL.md` (Claude Code skill, dự án). Nội dung bắt buộc:

1. **Đầu vào:** `postId` có sẵn, hoặc `title + packId + channelId + generalPack + brief`. Kiểm `writer_health` trước.
2. **Chuẩn bị:** nếu chưa có post → `writer_post_create` với `substrate: external`. Nếu post đang `terminal` → dừng, báo người; không đổi substrate của post đã chạy.
3. **Hook:** `writer_hook_clarify` → `writer_wait until:turn` → stage `hook-clarify-v1` xuất hiện qua `writer_stage_next` → mở agent như bước 5 → complete → `writer_hook_candidates` để lấy câu hỏi → trả lời theo brief và audience (ghi rõ câu trả lời vào `writer_stage_progress`) → `writer_hook_answer` → cùng vòng cho `hook-suggest-v1` → **dừng**, in danh sách candidate, chờ người chọn trên app (poll `writer_wait until:phase` mỗi 120 giây tới khi `selectedHook` có). Tự chọn chỉ khi người gọi ghi rõ `hookStrategy: auto` trong prompt, khi đó chọn candidate đầu và ghi note.
4. **Run:** `writer_run_start` rồi lặp: `writer_wait until:turn` → `writer_stage_next` → nếu `turn` null và status terminal → thoát; nếu null và RUNNING → chờ tiếp (gate đang chạy).
5. **Mở agent cho một stage:**
   ```bash
   printf '%s' "$ASSIGNMENT" | /Users/jc/.1devtool/bin/1devtool-agent-v9 run \
     --to=<turn.agentId> --terminal --wait --shared-cwd --cwd=<turn.itemRunDir> --prompt-stdin --json
   ```
   `$ASSIGNMENT` = `turn.assignmentText` + dòng "Read prompt.md in this directory; write only out/result.json; exit when done." Ghi `writer_stage_progress` trước khi mở (text "spawn <agentId> cho <stage>") và sau khi xong kèm `external: { runId, teamId, terminalId }` lấy từ JSON của 1devtool.
   Xong: nếu `resultPath` tồn tại → `writer_stage_complete exitCode 0`, ngược lại `exitCode -1`. Nếu complete trả `TURN_NOT_OPEN` (daemon đã cap 45 phút) → ghi note, tiếp vòng.
   Sau complete: `stop --team=<teamId> --close-terminals` khi stage xong; giữ tab khi exitCode ≠ 0 hoặc run FAILED.
6. **Không bao giờ:** dùng lại một team/member cho hai stage; sửa file trong `itemRunDir`; gọi `writer_stage_complete` khi chưa mở agent; tự sửa `out/result.json`.
7. **Kết thúc:** DONE → in `writer_get_script` 200 từ đầu + đường dẫn; nếu prompt có `styleId` → `writer_restyle` và lặp cùng vòng cho stage `restyle-v1`. FAILED/FAILED_GATE → in `errorCode`, `gateResults`, dừng.
8. **Lệnh khởi động** (ghi ở đầu skill để người copy):
   ```bash
   printf '%s' "postId=<id>" | /Users/jc/.1devtool/bin/1devtool-agent-v9 run --to=claude --terminal \
     --shared-cwd --cwd=/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room \
     --flag=--mcp-config=/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room/writer-room-data/agents/mcp-orchestrator.json \
     --flag=--strict-mcp-config --skill=/writer-orchestrate --prompt-stdin
   ```
   Kèm cách kiểm MCP đã mount: tool `writer_health` phải gọi được; nếu không, chạy `claude mcp add --transport http writer <url> --header "Authorization: Bearer <token>"` với giá trị từ `GET /api/writer/mcp`.

Kèm đoạn "Vì sao" ngắn ở đầu skill (daemon chấm, orchestrator chỉ mở agent) và bảng mã lỗi MCP.

## 5. Gói D — app hiển thị (song song B)

| File | Việc |
|---|---|
| `packages/web/src/api.ts` | `WriterRunV2` (544) và `WriterRunV2Summary` (611) thêm `substrate?: 'terminal' \| 'external'`, `timeline?`, `currentTurn?` đúng shape B1. `updateWriterPostV2` body (1769) và `createWriterPostV2`, `startWriterRunV2`, `createWriterRoomV2` thêm `substrate?`. |
| `packages/web/src/pages/WriterV2.tsx` | State `substrate` (mặc định `'terminal'`), hydrate từ run (458), dirty-check (485), save body (593), duplicate (611) và rerun (530) copy field. Select thứ 4 trong `form-grid-3` (952–972): nhãn "Chạy agent", option "Trong app (pane)" / "Agent ngoài (1DevTool)", disabled khi không DRAFT. Dòng 741 thêm chip `substrate`. Dưới `WriterProgressBar` (743): nếu `currentTurn` → dòng "Đang chạy: <stage> · <agentId> · <substrate> · <phút kể từ startedAt> · hạn <deadlineAt>", kèm `external.terminalId` nếu có. Danh sách `timeline` 10 entry cuối (giờ, stage, text), ẩn khi rỗng. List-row (116–136) thêm chip nhỏ khi `substrate === 'external'`. |
| `packages/web/src/features/turn-bridge/client.ts` | Nếu client có union kiểu sự kiện, thêm `externalTurn` và bỏ qua rõ ràng (không launch, không heartbeat). Nếu bridge chỉ so `kind === 'spawnTurn'` thì chỉ thêm comment nói vì sao external không có pane. |

Kiểm: typecheck của `packages/web` (tìm script trong `packages/web/package.json`; nếu chỉ có `vite build` thì chạy build). Không có test UI tự động; ghi vào nhật ký ảnh chụp hoặc mô tả đã mở trang với run mock.

## 6. Thứ tự, người làm, luật chung

| Đợt | Gói | File độc quyền | Điều kiện xong |
|---|---|---|---|
| 1 | B | `packages/daemon/src/{writer/*,pipeline/lane-scheduler.ts,team/workflow.ts,http.ts}`, test tương ứng | B4 xanh, typecheck sạch |
| 1 | C | `.claude/skills/writer-orchestrate/SKILL.md` | Đọc lại thấy đủ 8 mục §4 |
| 1 | D | `packages/web/src/**` | Web typecheck/build sạch |
| 2 | A | `packages/daemon/src/writer-mcp.ts`, `http.ts` (vùng MCP), `test/writer-mcp.test.ts`, `docs/mcp-inventory.md` (append) | A4 xanh, `bun test packages/daemon` xanh, typecheck sạch |
| 3 | Tích hợp | — | `bun test packages/daemon` + `bun run typecheck` xanh; restart daemon; chạy thử một run thật theo §7 |

Luật cho mọi người làm:

- **Không commit, không push.** Chủ kênh commit sau khi đọc diff.
- **Không sửa** `spy-mcp.ts`, `general-pack-mcp.ts`, `docs/writer-flow-and-packs.md`, `docs/plans/writer-v2-status.md`: terminal khác đang sửa dở.
- Không sửa test cũ cho xanh; đỏ thì ghi tên test và log vào nhật ký.
- Không đổi prompt của stage nào, không đổi schema artifact.
- Mỗi gói xong ghi một dòng vào nhật ký §8 (file này), kèm số test.

## 7. Nghiệm thu bằng run thật (chủ kênh + orchestrator)

1. Restart daemon (theo checklist T2 trong `writer-main-loop-plan.md`); `curl localhost:4187/api/writer/mcp` trả url và token; file `writer-room-data/agents/mcp-orchestrator.json` có.
2. 1DevTool đang mở. Chạy lệnh khởi động ở §4.8 với `postId` của một post `external` tạo trên app (pack "10 nghề lãi cao", hook chọn trên app).
3. App mở suốt: thấy phase đổi, dòng "Đang chạy", timeline có note của orchestrator; **không** có pane nào tự mở trong app.
4. Run tới DONE hoặc FAILED_GATE đúng luật; so artifact với baseline `798eeb53` (số beat, ledger, gate).
5. Lặp lại với app đóng: kết quả không đổi.
6. Kill agent giữa WRITE trong 1DevTool: orchestrator complete `-1`, run FAILED có `errorCode`, bấm continue trên app hoặc `writer_continue` chạy tiếp từ STUDY.

## 8. Nhật ký

| Ngày | Gói | Commit / run ID | Kết quả | Ghi chú |
|---|---|---|---|---|
| 2026-09-07 | Plan | `780eafc` + working tree | baseline 274 pass / 0 fail | plan này được duyệt ở mức tóm tắt |
| 2026-09-07 | C | working tree (chưa commit) | `.claude/skills/writer-orchestrate/SKILL.md` đủ 8 mục §4 + "Vì sao" + bảng mã lỗi; không có test (skill là prose) | Tab giữ khi exitCode -1 hoặc FAILED; hook chờ người trừ `hookStrategy: auto`; restyle lặp cùng vòng cho `restyle-v1` |
| 2026-09-07 | D | working tree (chưa commit) | `tsc -p packages/web/tsconfig.json --noEmit` sạch; `vite build` xanh (54 modules); không có test UI | `api.ts` thêm `WriterSubstrate`/`WriterTimelineEntry`/`WriterCurrentTurn`, body `substrate` cho posts/runs/rooms; `WriterV2.tsx` select "Chạy agent" (khoá khi không DRAFT), chip substrate ở header + list-row, dòng "Đang chạy" dưới progress bar khi `currentTurn`, timeline 10 entry cuối; turn-bridge bỏ qua `externalTurn` bằng so chuỗi vì `TeamEvent` trong shared chưa có member đó. Chưa mở app với run mock (không có run external nào trên disk) |
| 2026-09-07 | B | working tree (chưa commit) | `bun test packages/daemon` 460 pass / 0 fail (test/writer 281 pass, +7 mới; lane-scheduler +2); `bun run typecheck` sạch | B1–B4 xong: `WriterSubstrate`, `timeline`, `currentTurn`; `externalTurn` thay `spawnTurn`; `listOpenTurns`/`OpenTurn`; `writer/external-turn.ts` + 3 route `/runs/:id/turn`. Flake có sẵn, không do B: test `SDD 006: neither STUDY nor WRITE envelope carries a formula key` / `WRITE stages persona-pack.md…` thỉnh thoảng ENOENT `write-v2/prompt.md` vì đọc file ngay sau khi phase=WRITE mà `dispatchWrite` chưa kịp stage (race trong test, ~1/10 lần khi máy bận) |
| 2026-09-07 | A | working tree (chưa commit) | `bun test packages/daemon` 472 pass / 0 fail (`test/writer-mcp.test.ts` +12, real harness); `bun run typecheck` sạch | A1–A4 xong: `packages/daemon/src/writer-mcp.ts` (`McpWriterServer`, serverInfo `writer-room-writer`, 17 tool đúng tên §3 A2, lỗi domain trả `isError` + `{ errorCode, reason }`); `http.ts` construct sau harness, `GET /api/writer/mcp`, `/api/health.writerMcp`, stop khi shutdown, ghi `<dataDir>/agents/mcp-orchestrator.json` (`writer` + `writer_room` nếu Spy bật), KHÔNG vào `appMcpProvision`; `docs/mcp-inventory.md` append mục 10. Khác plan: `writer_post_configure` giữ giá trị hiện tại cho field bỏ qua (PUT HTTP thay toàn bộ); `errorCode` ngoài 3 mã của external-turn còn `NOT_FOUND`/`INVALID_INPUT`/`INVALID_STATE`. Không gặp flake `write-v2/prompt.md` lần chạy này |
| 2026-09-07 | Tích hợp (lead) | working tree (chưa commit) | `bun test packages/daemon` 472 pass / 0 fail; `bun run typecheck` sạch; web `tsc --noEmit` sạch | Sửa sau review: `writer_stage_next.turn.agentId` trước trả clone id (`claude-96478d-…`), skill lại đưa vào `--to=`; giờ `agentId` = template id (`claude`/`codex`), thêm `cloneId`; `currentTurn` thêm `templateId`, app hiển thị template. B đã bổ sung `externalTurn` vào union `packages/shared/src/terminal.ts`. Đo flake: `writer-run-v2.test.ts` chạy 6 lần trên working tree → 1 lần đỏ (2 test khác nhau), HEAD `780eafc` 3/3 xanh; nguyên nhân là thứ tự có sẵn ở `handleWriterV2Settle` (lưu `phase = 'WRITE'` rồi mới `dispatchWrite`), 20 test poll phase rồi đọc file ngay. Không sửa test; đề xuất sau: helper chờ `prompt.md` của stage kế tồn tại. Chưa chạy thử run thật (§7) vì cần restart daemon và 1DevTool mở, việc của chủ kênh |
| 2026-09-07 16:56 | Giao lưu mcp-dna-agent | 1devtool run `74b89ee1` | **`--cwd` bị bỏ qua ở substrate terminal**, kể cả với `--shared-cwd`: agent `pwd` trả gốc repo, file tương đối rơi vào gốc repo | Do mcp-dna-agent cảnh báo, đã tự đo lại. `assignmentText` của scheduler vốn tuyệt đối nên chỉ sửa dòng skill thêm vào (§5 skill: cd + đường dẫn tuyệt đối). Rủi ro mới ghi nhận: sandbox tree-diff không bắt được ghi lạc ra gốc repo; "user took control" làm tab 1DevTool hỏng vĩnh viễn, không báo lỗi → không bảo người nhấp vào tab agent; `terminal submit --json` in thêm rác sau JSON, exit 3 không phải lỗi. Câu hỏi mở chung hai bên: phân biệt agent đang nghĩ với agent chết khi chưa có `result.json`; đề xuất ghi `.tmp` rồi rename và cần tín hiệu process sống từ 1DevTool |
| 2026-09-07 17:10 | Giao lưu mcp-dna-agent, lượt 2 | run probe `74b89ee1` | `~/.1devtool/orchestration/runs/<runId>/meta.json` có `status` (running/done) và `exitCode` thật; `terminal list` không có PID, `status` của nó không tin được | **Việc sau lần chạy thử đầu:** (1) daemon đọc `meta.json` cho turn external (runId lấy từ `timeline[].external.runId`) để phân biệt đang nghĩ / đã chết, cap 45 phút chỉ là lưới; (2) agent ghi `out/result.json.tmp` rồi rename, `.tmp` trong cùng `itemRunDir`, ghi vào `STANDING_POINTER`; (3) kill daemon giữa từng loại stage (STUDY, WRITE, EDIT_REVIEW, REPAIR, terminal và external) để kiểm `recoverInterrupted*` từng nhánh. **Câu hỏi mở, đang chờ họ trả lời:** `meta.json.timeoutSeconds = 600` dù truyền `--timeout=170`; nếu 600 giây là trần thật của `run --terminal` thì STUDY/WRITE 15–45 phút bị cắt và phải đổi sang `team start` với timeout trong manifest |
| 2026-09-07 17:08 | Đo trần 1DevTool | runs `01ce0658`/`56e826f0` (PONG), long-probe | **`--timeout=2700` được nhận nhưng `meta.json.timeoutSeconds` = 600** ở cả run client và member: trần 600 giây là thật, kẹp im lặng. Lượt PONG kẹt `readiness-test` với `attentionKind: submit` (lượt `run --terminal` thứ hai từ cùng host terminal cần `confirm-submit --run=<memberRunId>`), sau confirm ra `error` exit 1 sau 321 giây. Lượt dài 660 giây: "Agent orchestration capacity is full (8/8 slots held)" fail ngay, đang thử lại | **Hệ quả:** mô hình `run --terminal --wait` một stage một run KHÔNG đủ cho STUDY/WRITE 15–45 phút. Skill §5 phải đổi sang một trong hai: (a) `team start` + `terminal submit`, chờ bằng `result.json`; (b) `run --terminal` không `--wait`, orchestrator poll `result.json` + `meta.json`, rồi `stop --team`. Quyết định sau khi có kết quả lượt dài (tab có sống quá 600 giây không). Skill cũng phải poll `team status` để bắt `attentionKind: submit` và xử lý lỗi capacity. **Chưa được chạy thử STUDY thật bằng skill cho tới khi chốt.** |
| 2026-09-07 17:26 | Lượt dài 660 giây | 1devtool run `230b98da` | **Tab và agent sống độc lập với bản ghi run:** run bị `interrupted` 17:14:42 (chủ kênh bấm Enter vì prompt nằm trong composer chưa submit, `meta.submittedAt = null` dù team status `Working`/terminal `busy`), agent vẫn chạy hết `sleep 660` và ghi `long.txt` lúc 17:25:53. `terminal status` báo `idle` suốt lúc agent đang chạy | **Chốt hướng (b):** skill §5 đổi sang `run --terminal` KHÔNG `--wait`; kiểm `meta.submittedAt` trong 90 giây đầu; chờ bằng `test -f resultPath` mỗi 20 giây; agent chết = chưa có result.json + tab `live: false`; quá `deadlineAt` thì dừng; capacity full thì chờ 60 giây thử lại. Chưa đo trực tiếp ca cap 600 giây (lượt này bị đóng do user took control trước mốc 600); sẽ đo bằng STUDY thật sau restart daemon |
| 2026-09-07 17:40 | Hẹn với mcp-dna-agent | — | Sau lần STUDY thật: gửi họ `meta.json` của run mở bằng `run --terminal` không `--wait`, và một lượt đối chứng cùng prompt bằng `team start --manifest-stdin`, để biết trần 600 giây có áp lên `team start` không; mỗi meta gửi đủ status, exitCode, durationSeconds, submittedAt, kèm mốc tab còn `live` sau khi run đóng | Skill §5 đã thêm trần chờ slot: quá 10 phút hoặc còn dưới 20 phút tới `deadlineAt` thì complete -1 |
| 2026-09-07 17:55 | Log trước chạy thử | working tree, daemon PID 87600 | 478 pass / 0 fail; typecheck sạch | Thêm `writer/mcp-calls.jsonl` (mỗi `tools/call` một dòng: at, tool, runId, args rút gọn, ms, ok, errorCode) và bản sao `meta.json` của 1DevTool vào `writer/external-meta/<runId>/<stage>-turn<id>.json` khi `writer_stage_complete` có `external.runId` (`ONEDEVTOOL_RUNS_DIR` để test). Daemon restart lần 2 hôm nay, `mcp-orchestrator.json` ghi lại 17:55. Chủ kênh sẽ tự chạy cả luồng qua MCP |
