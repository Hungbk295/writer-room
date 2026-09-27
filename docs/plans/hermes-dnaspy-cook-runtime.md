# Hermes làm agent runtime cho DNA Spy — Cook pipeline và handoff liền mạch từ Writer Room

Trạng thái: **đề xuất ngày 28/9/2026, chưa triển khai**. Mở rộng
[`hermes-writer-room-runtime-redesign.md`](./hermes-writer-room-runtime-redesign.md)
— quyết định mở số 3 ở đó (scope có gồm DNA Spy không) được chốt tại đây: **có**.
Mục tiêu của chủ: sau khi Writer viết xong bài, Hermes điều chuyển bài sang
DNA Spy để cook ngay, và Hermes là agent chính bên trong DNA Spy.

## 1. Kết quả cần đạt và ranh giới

Từ Telegram, một lệnh viết bài chạy liền mạch tới video: Writer run → DONE +
signoff → CookTask được tạo trong DNA Spy → Hermes Cook profile thực hiện các
stage cần agent (makeup, board) → app chạy stage deterministic (images, tts,
render) → chủ duyệt video trên Telegram và xem artifact trong DNA Spy.

```text
Telegram → Hermes Operator → Research / Writer / Cook profile
                              │        │         │
                              └── MCP hẹp ──→ Writer Room daemon
                              │               (research, writer, spy)
                              └── MCP hẹp ──→ DNA Spy sidecar control bridge
                                              ├─ CookTask + stage ledger + artifact store
                                              ├─ CookJobManager (images/tts/render)
                                              └─ cookStore (cook_projects, stage state)
```

Ran ranh giới giữ nguyên như plan gốc: app sở hữu trạng thái nghiệp vụ, quota,
gate, signoff; Hermes giữ hội thoại và thực thi agent; session Hermes là context
thay thế được. DNA Spy có thêm một luật cứng của riêng nó (`AGENTS.md`): **DB
`data/dna-spy.sqlite` là app-owned — mọi ghi phải qua code store của app đang
chạy, không process ngoài nào mở DB để sửa.** Sự cố project #87 là bằng chứng
cho hậu quả khi phá luật này.

## 2. Hiện trạng DNA Spy và khoảng cách

| Mảng | Hiện có trong `Hungbk295/DNASPY` | Phải thêm hoặc thay |
| --- | --- | --- |
| Cook domain | `cook_projects` + `CookStore` (stage: `research/script/script-writer/board/images/tts/render/done`); `saveScript` tự advance sang `board`; `advanceStageToRender` idempotent bằng conditional SQL | Domain `CookTask` + ledger stage/attempt + event cursor + artifact registry; giữ nguyên luật `saveBoard` → `normalizeBoardScenes` |
| Agentic stage | `cook.prepare` tạo workspace `_agent/cook-<id>-<stage>-<ts>` (prompt.md + context + config.json: hostMode/lens/frameRange/secPerFrame); `cook.importStage` nhập `output/*.json` với reconcile scenes/audios; board hiện **chỉ semi-auto** (`cook.run board` bị chặn: "Mở Workspace → Agy") | Turn contract giao cho Hermes Cook profile: assignment có input hash, allowed write paths, output schema, deadline; settle bằng artifact validation server-side. Bỏ phụ thuộc người bấm "Mở Workspace" |
| Deterministic stage | `CookJobManager` chạy `images`, `tts` (có `PARALLEL_SAFE images|tts`), `render`; abort qua AbortController; progress event; render ghi `render_path` + manifest | Expose qua bridge với idempotency + runId binding; report đối chiếu frame/audio counters thay vì tin text progress |
| MCP hiện có | `hermes/server.ts` (stdio): tool read-only + `prepare_workspace` / `run_claude_workspace` / `workspace_status` / `import_results` / `pipeline_status` | **Thay thế, không mở rộng.** Ba vấn đề: (a) process riêng mở cùng SQLite và ghi qua CookStore → race với app đang mở, vượt qua state in-memory của CookJobManager/activeWorkspaces — đúng dạng lỗi plan gốc D1 muốn tránh; (b) `run_claude_workspace` hardcode `/Users/jc/.local/bin/claude` và spawn CLI rời, không binding; (c) `runningProcesses`/`workspace_status` là RAM — restart mất sạch |
| Transport | Sidecar chỉ nhận JSON-RPC qua stdin từ Tauri; không có HTTP listener | Control bridge HTTP loopback `127.0.0.1` + token (đề xuất D1 trong `hermes-orchestrator-plan.md`), nâng cấp thành scoped token theo profile + idempotency key + expected version |
| Handoff | Chưa có gì; diagram `03-write-and-transfer.mmd` mô tả ý tưởng `/chuyen` thủ công qua `cook.create` + `cook.saveScript` | Contract handoff bền (§5): tạo CookTask từ Writer artifact có hash, dedupe theo `writerRunId`, auto-dispatch sau signoff |

## 3. Quyết định kiến trúc

1. **DNA Spy sidecar là source of truth cho cook.** Mọi mutation đi qua control
   bridge vào `cookStore`/`CookJobManager` của app đang chạy. `hermes/server.ts`
   (stdio, mở DB trực tiếp) chỉ còn vai trò read-only đối chiếu, hoặc bỏ hẳn —
   không để hai process cùng ghi `dna-spy.sqlite`.
2. **Hermes Cook là agent chính cho stage có ngữ nghĩa.** `makeup`, `board`,
   `board-edit` (và các `script-*` nếu sau này cần) là workspace turn do Cook
   profile thực hiện, thay cho Claude Code/Agy spawn rời. `images`, `tts`,
   `render` tuyệt đối giữ deterministic trong `CookJobManager` — agent không
   gọi engine ảnh/TTS/render bằng prompt.
3. **Handoff là giao dịch dữ liệu, không phải copy prompt.** Writer Room giao
   `sentences[]` + `scriptSha256` + `writerRunId` + DNA binding; DNA Spy tạo
   project qua `cook.create`/`cook.saveScript` bên trong `cook_task_create`
   idempotent. Không đường "đọc script rồi tự gõ lại" nào được chấp nhận.
4. **Bốn vai trò, quyền riêng** — thêm Cook vào bộ ba plan gốc. Cook worker chỉ
   thấy `cook_turn_*` cho turn được bind và write trong workspace dir được cấp;
   không có `cook_task_*` mutation, không có human decision, không có quyền
   `cook.run` deterministic stages.
5. **Lint/gate ở server trước khi tốn tiền.** `cook.lint` (read-only:
   `validateBoardIntegrity`, `varietyReport`, `boardDetailAudit`,
   `sentencesNeedingAnchor`) chạy sau import board và trước `images`; fail →
   repair turn có budget, không cho agent tự đánh dấu pass.
6. **Luật AGENTS.md của DNA Spy giữ nguyên trong prompt contract.** Cook worker
   không được viết script sinh `board.json` thay suy luận (cấm procedural
   generation), phải đọc ảnh/frame thật khi phân tích visual, không ép 1
   frame/câu — frame count theo scene level. Vi phạm = artifact validation fail.

## 4. Contract CookTask v1

`CookTask` tối thiểu: `taskId`, `projectId`, `writerRef{runId,postId,scriptSha256}`,
`ownerId`, `phase`, `currentStage`, `version`, `dnaBinding{myDnaId|channelId}`,
`lens{frameRange,secPerFrame,hostMode,visualProfileId}`, `budget{maxTurnsPerStage,
maxImageRetries,maxWallMinutes,spent}`, `workerBinding{profile,sessionRef,leaseUntil}`,
`pendingCommand{commandId,version}`, `signoff{required,grantedBy,grantedAt}`,
`createdAt`, `updatedAt`, `lastError`.

Tách record: `CookStageAttempt(taskId,stage,attempt,inputHash,workspaceDir,
status,startedAt,settledAt)`, `CookEvent(cursor,taskId,type,payloadHash,at)`,
`CookCommand(commandId,taskId,expectedVersion,state)` (states:
`reserved/in_progress/completed/unknown` như phân tích trong
`hermes-research-agent-control.md`), `CookArtifact(artifactId,taskId,stage,
path,sha256,validationState)`. Attempt key = hash input (script/scene snapshot),
không chỉ tên stage — cùng luật với Board/Writer loop.

State machine theo stage thật của app:

```text
created → queued → makeup → board → lint → images ⇄ tts → render → done
bất kỳ stage chạy nào → blocked | failed | cancel_requested → cancelled
done vẫn cho phép command retry_frames / retry_tts_chunks / board_edit → quay lại đúng stage
```

`images` và `tts` song song được (app đã cho phép), mỗi stage một attempt record
riêng; `render` chỉ vào khi cả hai settle `ok`. `cook.done` đòi `render_path` +
manifest + counters đối chiếu, không phải text "xong".

Tool control v1 (bridge, scope `cook.control` cho Operator):

`cook_task_create` (nhận Writer payload, dedupe `writerRunId`), `cook_task_start`,
`cook_task_get`, `cook_task_events(afterCursor,limit)`, `cook_task_instruct`
(`commandId`, typed: `retry_frames{frameIdx[]}`, `retry_tts_chunks{from,to}`,
`edit_scene_prompt{sceneIdx}`, `note`), `cook_task_pause`, `cook_task_resume`,
`cook_task_cancel`, `cook_task_report` (renderPath, durationSec,
frames ok/error, audio ok, cost counters).

Tool worker (scope `cook.worker`, bind `taskId+turnId`):
`cook_turn_get_assignment`, `cook_turn_heartbeat`, `cook_stage_submit`
(đăng ký artifact + hash; server validate → `accepted`/`rejected` với lý do),
`cook_turn_complete`. Worker **không** gọi `cook.importStage` trực tiếp —
import là hành vi server khi settle được chấp nhận.

Mọi mutation: idempotency key + expected version + response phân biệt
`accepted/applied/settled`. Mid-run instruction áp dụng ở ranh giới batch/frame
tiếp theo qua mailbox trong workspace/runDir có sequence, không nhét vào output
stream. Pause = `pause_requested → checkpoint ack → paused`; resume cần wake-up
đã nghiệm thu.

## 5. Handoff liền mạch Writer → Cook

```text
writer_wait(until:terminal) → status DONE + signoff OK
  → writer_get_script → {sentences, scriptSha256}
  → cook_task_create{writerRunId, postId, title, scriptSha256, sentences,
                     dnaBinding, lens, targetMinutes}        # idempotent
    ├─ dedupe: writerRunId đã có task → trả task hiện có, KHÔNG tạo project 2
    ├─ cook.create + cook.saveScript qua bridge → projectId, stage='board'
    └─ dispatch Hermes Cook profile (assignment đầu tiên)
  → makeup turn → cook_stage_submit → validate → import
  → board turn → submit → renumberScenes/normalize → import → lint gate
  → images ∥ tts (CookJobManager, không qua agent)
  → render → manifest → cook_task_report → Telegram card cho chủ
```

- **Auto-dispatch mặc định bật** theo yêu cầu "cook luôn": không cần `/chuyen`.
  Flag `handoff.requireApproval` (per channel) cho phép chủ chặn lại ở bước duyệt
  script trước khi tốn chi phí images/tts — vẫn liền mạch nhưng có điểm dừng tiền.
- Signoff của Writer là điều kiện trước: `DONE` chưa signoff thì CookTask chờ
  `queued`, không tự chạy.
- Hermes lưu **sổ job** `(jobId → writerRunId, cookTaskId, projectId,
  telegramChatId)`; mọi trạng thái đọc lại từ hai app. Telegram binding
  user/chat/message cho mọi quyết định của chủ (duyệt, retry frame, hủy).
- DNA binding phải được Operator hỏi/resolve trước `cook_task_create`
  (`myDnaId` hoặc `channelId` — `cook.create` bắt buộc một trong hai); thiếu thì
  handoff blocked, không đoán.
- Restart giữa chừng: daemon/bridge đọc ledger + artifacts; task `in_progress`
  khi mất worker → `unknown`, reconcile trước khi dispatch lại — không tự coi
  stage đã xong vì file tồn tại.

## 6. Triển khai và nghiệm thu theo phase

| Phase | Deliverable | Gate bắt buộc |
| --- | --- | --- |
| C0 — proof + bridge (1–2 ngày, sau P0 của plan gốc) | Control bridge trong sidecar: HTTP loopback, token file `_control.json`, scoped tokens Operator/Cook, allowlist `cook.list/get/create/saveScript/prepare/importStage/lint/run/cancel`; xóa `run_claude_workspace` path cũ | Request thiếu token/lệnh ngoài allowlist bị từ chối; app không mở → báo lỗi rõ, DB không bị đụng; restart sidecar → rediscover workspace theo disk-scan hiện có |
| C1 — CookTask core (2–4 ngày) | Table/record + transaction + event cursor + artifact registry trong app (migration qua code store); MCP/bridge tools §4 | Dedupe `writerRunId` không tạo project thứ hai; duplicate command không retry side effect; worker token không settle turn của task khác |
| C2 — vertical slice (3–5 ngày) | Hermes Cook chạy `makeup` + `board` qua workspace turn: prepare → assignment → write output → submit → validate → import → lint | Board import qua `normalizeBoardScenes` giữ `frameIdx/imageStatus` (không lặp lỗi #87); lint fail → repair turn ≤ budget; restart giữa turn resume đúng attempt |
| C3 — deterministic + lệnh sửa (2–3 ngày) | `cook.run images ∥ tts` → `render` qua bridge; typed commands `retry_frames`/`retry_tts_chunks`/`edit_scene_prompt`; `cook_task_report` | Cancel giữa images dừng sạch (AbortController); retry_frames chỉ regen frame được chỉ định; counters báo cáo khớp DB |
| C4 — handoff E2E (2–3 ngày) | Watcher/subscriber trên Writer events → `cook_task_create` auto; Telegram card duyệt video; sổ job Hermes | Một run Telegram: `/viet` → DONE → cook → video → `ok`/`làm lại frame N`/`hủy` đều đúng; audit đủ `writerRunId→cookTaskId→projectId→artifactHash` |
| C5 — cutover (1 ngày) | Feature flag `cookAgent=hermes|claude|agy`; retire hoặc giới hạn `hermes/server.ts` còn read-only; docs/diagram | Task mới qua flag; task cũ chạy xong; rollback chỉ đổi flag + route, không xóa bridge |

Thời lượng là ước tính triển khai, phụ thuộc P0 (cross-profile handoff) ở plan
gốc — Cook profile không chứng minh được gì nếu Hermes chưa giao task đúng
profile được.

## 7. Bảo mật, vận hành và rollback (delta DNA Spy)

- Khóa provider (ElevenLabs/GenMax/image engine, ffmpeg path) **không rời app**:
  Cook worker không thấy `settings` secrets; `cook.run` do bridge gọi với quyền
  server-side, Hermes chỉ nhận runId + progress cursor.
- Workspace của Cook worker: giới hạn write trong dir do `cook.prepare` cấp
  (canonicalize path, chặn symlink ra ngoài `spyRoot/_agent`); đọc context nhưng
  không đọc `data/dna-spy.sqlite` — hỏi app qua tool, không mở DB.
- `query_db` (SELECT tùy ý) không cấp cho Cook worker; nếu giữ cho Operator thì
  redact cột secrets và log mọi query.
- Quan sát: trace `taskId, projectId, stage, attempt, turnId, runId,
  artifactHash` xuyên cả hai app; alert cho lease quá hạn, lint fail lặp,
  budget mismatch, frame error rate cao.
- Rollback: flag `cookAgent` về `agy` workspace thủ công; artifacts đã import
  giữ nguyên; không xóa CookTask ledger trước khi reconcile sạch. Bridge tắt =
  tháo `_control.json`, task sang `paused`, không mất dữ liệu.

## 8. Quyết định còn mở

1. Store CookTask: bảng mới trong `dna-spy.sqlite` qua migration của app
   (khuyến nghị — đúng "app-owned") hay file ledger riêng; quyết ở C1.
2. Thứ tự `makeup`/`board`: diagram hiện vẽ makeup → board trong cùng một
   workspace pass; `runMakeup` đọc được ⟦cảnh⟧ nếu board có trước. Chốt theo
   chất lượng thực tế ở C2 — contract không đổi, chỉ đổi thứ tự turn.
3. Cook profile có cover luôn `script-*` sub-stages (doctor/revise/sections)
   hay chỉ `makeup`+`board` trong v1 — script từ Writer Room nên v1 chỉ cần
   makeup+board.
4. Khi nào bỏ hẳn `hermes/server.ts`: sau C5 nếu dashboard/read-only vẫn cần
   thì giữ bản read-only không-mutation.
5. `cook.run board` bị chặn trong `CookJobManager` — với Hermes Cook thì board
   đi qua turn path, nhưng nếu giữ phương án board deterministic sau này phải
   gỡ chặn có chủ đích (không gỡ ngầm).

## Nguồn đối chiếu

- DNA Spy: `hermes/server.ts` (toàn bộ orchestration tools), `sidecar/src/main.ts`
  (`cook.create` ~467, `cook.run` ~1150, `cook.saveScript` ~1163, `cook.lint`
  ~1392, `cook.prepare` ~1839, `cook.importStage` ~2175),
  `sidecar/src/cookjob.ts`, `sidecar/src/cookstore.ts`,
  `sidecar/src/cook/{makeup,board,images,tts,render}.ts`, `shared/src/types.ts`
  (`CookStage` ~717), `AGENTS.md` (luật DB/board), `shared/src/lenses.ts`.
- Writer Room: `docs/plans/hermes-writer-room-runtime-redesign.md`,
  `hermes-research-agent-control.md`, `hermes-orchestrator-plan.md` (D1–D6);
  `diagrams/hermes/03-write-and-transfer.mmd`, `04-auto-cook-and-approval.mmd`;
  `packages/daemon/src/writer-mcp.ts` (17 tool writer_*).
