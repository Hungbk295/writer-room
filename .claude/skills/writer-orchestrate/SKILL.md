---
name: writer-orchestrate
description: >
  Chạy một run Writer v2 từ title tới DONE bằng tool MCP `writer_*` (server `writer-room-writer`),
  với writer/editor là các agent 1DevTool do skill này tự mở, mỗi stage một agent mới.
  Dùng skill này khi prompt có dạng `postId=<id>` hoặc `title + packId + channelId + generalPack + brief`,
  hoặc người dùng nói "orchestrate run này", "chạy writer ngoài app", "chạy post X qua 1devtool".
  Daemon vẫn là nơi chấm (validate, gate, sandbox, cap 45 phút); skill này CHỈ mở agent, chờ,
  và báo cáo kết quả về daemon. KHÔNG sửa `itemRunDir`, KHÔNG tự viết `out/result.json`,
  KHÔNG dùng lại một team 1DevTool cho hai stage.
---

# writer-orchestrate — chạy Writer v2 bằng agent ngoài qua 1DevTool

## Lệnh khởi động (copy nguyên)

```bash
printf '%s' "postId=<id>" | /Users/jc/.1devtool/bin/1devtool-agent-v9 run --to=claude --terminal \
  --shared-cwd --cwd=/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room \
  --flag=--mcp-config=/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room/writer-room-data/agents/mcp-orchestrator.json \
  --flag=--strict-mcp-config --skill=/writer-orchestrate --prompt-stdin
```

Thay `postId=<id>` bằng `title=...; packId=...; channelId=...; generalPack=...; brief=...` nếu chưa có post.
Thêm `hookStrategy: auto` nếu muốn skill tự chọn hook; thêm `styleId: <id>` nếu muốn restyle sau DONE.

**Kiểm MCP đã mount trước khi làm gì khác:** gọi tool `writer_health`. Nếu tool không có
hoặc lỗi transport, daemon chưa được mount vào phiên này. Lấy url và token rồi mount tay:

```bash
curl -s localhost:4187/api/writer/mcp
# → { "url": "http://127.0.0.1:<port>", "token": "<token>" }
claude mcp add --transport http writer <url> --header "Authorization: Bearer <token>"
```

File `writer-room-data/agents/mcp-orchestrator.json` được daemon ghi đè mỗi lần start (token đổi).
Nếu `curl` trả 404, daemon đang tắt Writer MCP hoặc chưa restart sau khi build: dừng, báo người.

## Vì sao

Daemon là settle machine duy nhất. Nó tạo `itemRunDir`, viết `prompt.md`, validate `out/result.json`,
chạy gate, kiểm sandbox, và tự cắt turn sau 45 phút. Skill này không chấm gì cả: nó chỉ hỏi daemon
"turn nào đang mở", mở đúng agent cho turn đó trong một tab 1DevTool, chờ agent xong, rồi nói với
daemon "xong rồi, exit code này". Mọi phán quyết đúng/sai là của daemon. Nhờ vậy app Tauri mở hay
đóng đều không ảnh hưởng, và mỗi stage là một context mới (WRITE không thấy pack, đúng luật hiện có).

## Bảng mã lỗi MCP

Mọi tool `writer_*` trả lỗi domain dưới dạng `isError: true` với body:

```json
{ "errorCode": "<CODE>", "reason": "<câu giải thích>" }
```

| errorCode | Nghĩa | Skill làm gì |
|---|---|---|
| `RUN_NOT_FOUND` | `runId`/`postId` không tồn tại trong store | Dừng, in lại id đã dùng, báo người |
| `TURN_NOT_OPEN` | `turnId` không còn mở: daemon đã cap 45 phút, hoặc turn đã complete, hoặc id sai | Ghi note bằng `writer_stage_progress` (không `turnId`), tiếp vòng lặp |
| `SUBSTRATE_NOT_EXTERNAL` | Run có `substrate: terminal`; daemon tự spawn pane trong app, không nhận complete từ ngoài | Dừng, báo người tạo post mới với `substrate: external`. Không đổi substrate của post đã chạy |
| khác (`AGENT_SCHEMA`, `AGENT_SANDBOX_VIOLATION`, `GATE_*`, ...) | Lỗi settle do daemon phát hiện, nằm trong `run.errorCode` | In `errorCode` + `reason`, xem mục Kết thúc |

Lỗi JSON-RPC (token sai → 401, tool không có) là lỗi mount, không phải lỗi domain: quay lại mục kiểm MCP.

## Stage và agent

| Stage (`turn.stage`) | Vai | `turn.agentId` lấy từ |
|---|---|---|
| `hook-clarify-v1`, `hook-suggest-v1` | writer | `run.agentId` |
| `study-v2`, `write-v2`, `repair-v2`, `restyle-v1` | writer | `run.agentId` |
| `edit-review-v2` | editor | `run.editorAgentId` |

Skill không cần tra bảng này: `writer_stage_next` đã trả đúng `agentId` cho từng turn.
`turn.agentId` là **template id** (`claude`, `codex`), đúng giá trị cho `--to=`; `turn.cloneId`
là clone daemon đã đặt turn lên (dạng `claude-96478d-…`), chỉ để đối chiếu log, không đưa vào `--to=`.
Luôn dùng `turn.agentId`, không tự chọn.

---

## 1. Đầu vào

Một trong hai:

- `postId=<id>`: post đã tạo trên app hoặc bằng MCP.
- `title + packId + channelId + generalPack + brief` (tuỳ chọn `audience`, `targetWords`, `agentId`, `editorAgentId`).

Tuỳ chọn: `hookStrategy: auto`, `styleId: <id>`.

Bước đầu tiên luôn là `writer_health`. Kết quả phải có `ok: true`. Nếu `spyMcp: false`, ghi nhớ để
báo trong report cuối (STUDY vẫn chạy được, nhưng agent không tra Spy được).

## 2. Chuẩn bị

- Chưa có post → `writer_post_create` với `substrate: "external"` và các field từ đầu vào.
  Lấy `id` từ projection trả về; đây vừa là `postId` vừa là `runId`.
- Đã có post → `writer_status { runId }`. Đọc `substrate`:
  - `external` → tiếp.
  - `terminal` và `status: DRAFT` → `writer_post_configure { postId, substrate: "external" }`, rồi tiếp.
  - `terminal` và không còn DRAFT → **dừng**, in id và status, báo người. Không đổi substrate của
    post đã chạy; không tìm cách complete turn của run terminal (daemon sẽ trả `SUBSTRATE_NOT_EXTERNAL`).
- `status` là `DONE`/`FAILED`/`FAILED_GATE` mà không có yêu cầu `styleId` hay continue → in trạng thái, dừng.

## 3. Hook

Hook đi hai lượt agent, rồi dừng chờ người chọn.

1. `writer_hook_clarify { postId }` → trả `{ generatingHook }`.
2. `writer_wait { runId, until: "turn", timeoutSec: 120 }` → `writer_stage_next { runId }`
   phải trả `turn.stage === "hook-clarify-v1"`. Mở agent theo mục 5, complete.
3. `writer_hook_candidates { postId }` → đọc `hookClarify` (danh sách câu hỏi). Nếu `hookError` có
   giá trị → in ra, dừng.
4. Trả lời từng câu hỏi dựa trên `brief` và `audience` của post. Ghi nguyên văn các câu trả lời bằng
   `writer_stage_progress { runId, text: "Trả lời hook-clarify: 1) ... 2) ..." }` để người xem trên app
   thấy skill đã quyết định gì.
5. `writer_hook_answer { postId, answers: [...] }` → cùng vòng chờ/spawn/complete cho `hook-suggest-v1`.
6. `writer_hook_candidates` lần nữa → in danh sách `hookCandidates` (id, type, text) ra màn hình.
7. **Dừng chờ người chọn trên app.** Lặp `writer_wait { runId, until: "phase", timeoutSec: 120 }` rồi
   `writer_hook_candidates`, tới khi `selectedHook` có giá trị. Mỗi vòng chờ in một dòng ngắn
   "đang chờ chọn hook trên app". Không tự gọi `writer_hook_select`.
8. Chỉ khi prompt ghi rõ `hookStrategy: auto`: gọi `writer_hook_select { postId, selectedId: <id candidate đầu> }`
   và ghi `writer_stage_progress` với text "hookStrategy auto: chọn candidate <id>". Daemon chưa có hàm chấm
   hook, nên "auto" nghĩa là lấy candidate đầu, không nghĩa là chọn hay nhất.

Nếu post đã có `selectedHook` từ trước (người chọn trên app trước khi gọi skill) → bỏ qua cả mục 3.

## 4. Run

`writer_run_start { postId }` → projection với `status: RUNNING`, `phase: STUDY`.

Vòng lặp chính:

```text
loop:
  writer_wait { runId, until: "turn", timeoutSec: 120 }
  r = writer_stage_next { runId }
  if r.turn == null:
     if r.status in (DONE, FAILED, FAILED_GATE): break   → mục 7
     else (RUNNING, gate hoặc settle đang chạy): tiếp loop
  else:
     mở agent cho r.turn theo mục 5, complete, tiếp loop
```

`writer_wait` trả `timedOut: true` là bình thường khi gate/settle chạy lâu; chỉ lặp lại.
Không có turn nào mở quá 45 phút: daemon tự cắt, nên vòng lặp không treo vô hạn.

## 5. Mở agent cho một stage

Mỗi stage là **một** lệnh `run --terminal` mới của 1DevTool, **không `--wait`**. Lý do đo được 2026-09-07:

- `--timeout` bị kẹp im lặng về 600 giây (`meta.json.timeoutSeconds = 600` dù truyền 2700), và
  `--wait` trả về ở trần đó, có khi với `done` exit 0. STUDY/WRITE mất 15–45 phút nên `--wait` vô dụng.
- Tab và agent sống độc lập với bản ghi run: run bị đánh dấu `interrupted` mà agent vẫn chạy hết
  một lệnh 660 giây và ghi file. Vậy chỉ cần mở tab rồi **chờ bằng `turn.resultPath`**.
- `--cwd` bị bỏ qua ở substrate terminal, agent luôn mở tại gốc repo, kể cả có `--shared-cwd`.
  Vì vậy **mọi đường dẫn trong assignment phải tuyệt đối**. Vẫn truyền `--cwd` phòng bản sau sửa.
- `team status` báo `Working` và `terminal status` báo `busy` **cả khi prompt chưa được submit**
  (Enter không được nhận). Tín hiệu thật duy nhất là `submittedAt` trong
  `~/.1devtool/orchestration/runs/<runId>/meta.json`.

```bash
ASSIGNMENT="$(cat <<'EOF'
<turn.assignmentText nguyên văn>
Working directory for this task: <turn.itemRunDir> (your terminal may have opened elsewhere; run `cd <turn.itemRunDir>` first).
Read <turn.promptPath>. Write only <turn.resultPath>. Do not write any other file. Exit when done.
EOF
)"
printf '%s' "$ASSIGNMENT" | /Users/jc/.1devtool/bin/1devtool-agent-v9 run \
  --to=<turn.agentId> --terminal --shared-cwd --cwd=<turn.itemRunDir> --prompt-stdin --json
# in ra runId + teamId ngay sau khi bàn giao; KHÔNG chờ agent xong
```

Sau khi lệnh trả về, vòng chờ cho stage:

```bash
META=~/.1devtool/orchestration/runs/<runId>/meta.json
# 1. Trong 90 giây đầu: meta.submittedAt phải khác null. Nếu vẫn null → prompt chưa được submit.
#    Kiểm `team status --team=<teamId>`: attentionKind "submit" → `confirm-submit --run=<memberRunId>`
#    (memberRunId = runId in ra, KHÔNG phải clientRequestId). Vẫn null sau 3 phút → coi stage exit -1.
# 2. Sau đó cứ 20 giây: test -f <turn.resultPath> → xong, exit 0.
# 3. Chưa có result.json mà meta.status là error/interrupted VÀ tab không còn live
#    (`terminal status --id=<terminalId>` → live false) → agent chết, exit -1.
#    meta.status done/interrupted mà tab còn live → agent vẫn làm, tiếp tục chờ.
# 4. Quá turn.deadlineAt → dừng chờ, exit -1 (daemon cũng tự cap ở mốc này).
```

Lỗi "Agent orchestration capacity is full (N/8 slots held)" khi mở run (nhận dạng bằng
`/capacity is full|\d+\/\d+\s*slots?\s*held/i`; trần 8 là mặc định của 1DevTool, file
`~/.1devtool/orchestration/config.json` không tồn tại trên máy này): rõ và tức thì, không phải agent chết.
Ghi `writer_stage_progress` rồi chờ và mở lại, backoff 20 → 60 giây, không đổi turn. **Có trần:** turn của
daemon đang mở và `deadlineAt` đang chạy, nên dừng chờ khi tổng chờ quá 10 phút HOẶC còn dưới 20 phút
tới `deadlineAt` (STUDY/WRITE cần chừng đó). Khi đó `writer_stage_complete exitCode -1` với note
"hết slot 1DevTool, đóng bớt Agent Team rồi continue", để daemon không treo tới 45 phút.

`$ASSIGNMENT` = `turn.assignmentText` + hai dòng trên với `itemRunDir`, `promptPath`, `resultPath`
lấy nguyên văn từ `writer_stage_next` (đều là đường dẫn tuyệt đối).
Không thêm gì khác vào assignment: không tóm tắt pack, không chép prompt.md, không gợi ý nội dung.

Trình tự cho mỗi turn:

1. **Trước khi mở:** `writer_stage_progress { runId, turnId: turn.turnId, text: "spawn <agentId> cho <stage> (attempt <attempt>)" }`.
2. Chạy lệnh trên. Đọc JSON stdout, lấy `runId` (của 1DevTool), `teamId`, `terminalId`. Ghi ngay
   `writer_stage_progress { runId, turnId, text: "đã mở tab", external: { runId, teamId, terminalId } }`
   để daemon và app biết tab nào đang làm turn này. Rồi chạy vòng chờ ở trên.
3. **Sau khi xong:** `writer_stage_progress { runId, turnId, text: "<agentId> xong <stage>, exit <mã>", external: { runId: <1devtool runId>, teamId, terminalId } }`.
   Nếu bước này trả `TURN_NOT_OPEN`, gọi lại không có `turnId` để note vẫn vào timeline.
4. Kiểm `turn.resultPath` tồn tại trên đĩa (`test -f`). Có → `writer_stage_complete { runId, turnId, exitCode: 0, external: {...} }`.
   Không có (agent chết, bị kill, không ghi file) → `exitCode: -1`.
   Không đọc, không sửa, không "vá" `out/result.json`; validate là việc của daemon.
5. `writer_stage_complete` trả `TURN_NOT_OPEN` → daemon đã cap 45 phút và tự settle rồi. Ghi
   `writer_stage_progress { runId, text: "complete <stage> bị TURN_NOT_OPEN, daemon đã cap" }`, quay lại vòng lặp.
6. Đóng tab:
   - `exitCode 0` và `writer_status` sau đó không phải `FAILED`/`FAILED_GATE` →
     `/Users/jc/.1devtool/bin/1devtool-agent-v9 stop --team=<teamId> --close-terminals`
   - `exitCode -1`, hoặc run chuyển `FAILED`/`FAILED_GATE` → **giữ tab** để người đọc transcript. In `terminalId`.

Lệnh `run --terminal` thoát mã khác 0 vì lỗi khác "capacity full" (1DevTool lỗi, không mở được tab)
→ coi như `exitCode -1`, ghi note kèm stderr rút gọn, vẫn gọi `writer_stage_complete` để daemon không
đợi tới 45 phút. Riêng "capacity full" thì chờ và thử lại như §5 đã ghi, không complete.

## 6. Không bao giờ

- Dùng lại một `teamId`/`memberId` cho hai stage. Mỗi stage một lệnh `run` mới, kể cả retry cùng stage.
- Sửa, tạo, xoá bất kỳ file nào trong `turn.itemRunDir`. Daemon kiểm sandbox và sẽ FAILED run với
  `AGENT_SANDBOX_VIOLATION`.
- Gọi `writer_stage_complete` khi chưa mở agent cho turn đó.
- Tự viết hay chỉnh `out/result.json`, kể cả để "cứu" một stage lỗi schema.
- Gọi `writer_hook_select` khi prompt không có `hookStrategy: auto`.
- Đổi `substrate` của post không còn DRAFT.
- Gọi `writer_continue` tự động sau FAILED. Continue là quyết định của người (trên app hoặc gọi lại skill với chỉ dẫn rõ).
- Bảo người dùng nhấp vào tab agent trong 1DevTool để "xem nó làm gì". Đo bên dna-spy 2026-09-07: chỉ một
  lần nhấp là tab bị đánh dấu "user took control", mọi lệnh tự động tới tab đó bị huỷ vĩnh viễn mà không
  báo lỗi. Muốn xem tiến độ thì nhìn `run.timeline` trên app; muốn đọc transcript thì đọc sau khi stage xong.

## 7. Kết thúc

**DONE** → `writer_get_script { runId, version: "final" }`. In `title`, `words`, 200 từ đầu của `script`,
và đường dẫn `writer-room-data/writer/runs-v2/<runId>.json`. Đóng tab còn mở của stage cuối.

Nếu prompt có `styleId` → `writer_restyle { runId, styleId }` (trả `{ restyling }`), rồi chạy lại đúng
vòng lặp mục 4 cho stage `restyle-v1` (spawn theo mục 5, complete, đóng tab). Xong →
`writer_get_script { runId, version: <restyling.version> }` và in như trên. `restyleError` có giá trị →
in `code` + `reason`; run gốc vẫn DONE, `finalScript` không đổi.

**FAILED / FAILED_GATE** → `writer_status`, in `errorCode`, `gateResults` (entry cuối, danh sách
`violations`), `timeline` 10 entry cuối, và `terminalId` của tab đang giữ. Dừng. Không tự continue.

Report cuối cho người gọi gồm: `runId`, `status`, `phase`, số stage đã mở, tab nào còn giữ, `spyMcp` lúc health.

## Checklist tự đọc lại trước khi chạy

- [ ] `writer_health` ok
- [ ] post `substrate: external`
- [ ] mỗi stage: progress → run → progress(external) → test -f resultPath → complete → stop/giữ tab
- [ ] hook: dừng chờ người, trừ khi `hookStrategy: auto`
- [ ] FAILED/FAILED_GATE: in errorCode + gateResults, giữ tab, dừng
