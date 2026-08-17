# Plan — Embed assignment vào interactive inject line

> **Status:** ready to implement — scope đã thu hẹp theo runtime hiện tại
> **Liên quan:** [`agent-harness-architecture.md`](./agent-harness-architecture.md) §4/§5, [`deferred-agent-terminal-writer-loop.md`](./deferred-agent-terminal-writer-loop.md) Phần 1
> **Scope:** persistent interactive **orchestrated assignment** của Writer pipeline. Không đổi `TeamEvent`/SSE schema; không sửa routing mention trong thay đổi này.

---

## 1. Quyết định và problem

Writer v2 dispatch một `TurnJob` có `persistentInteractive: true`, `orchestrated: true` và
`taskNote` chứa các path workspace cần thực hiện. Khi `spawnTurn` được emit, pane live hiện chỉ
nhận wake-up line yêu cầu gọi `team_get_assignment`. Nếu MCP không khả dụng, agent thức dậy nhưng
không biết nhiệm vụ.

Thay đổi này đưa **bản biểu diễn PTY-safe của `taskNote`** vào inject text. Agent vẫn có thể gọi
`team_get_assignment` để đối chiếu hoặc lấy bản đầy đủ khi text đã bị truncate, nhưng không còn
phụ thuộc MCP để biết mục tiêu và các path chính của Writer pipeline.

`team_get_assignment` chỉ trả assignment đã lưu; các path `prompt.md`, `input/envelope.json`,
`input/*` và `out/result.json` đến từ `assignmentTaskNote` trong lane scheduler, không phải một
contract path riêng của MCP.

## 2. Scope và non-goals

| In scope | Out of scope / deferred |
|---|---|
| Writer pipeline `orchestrated && persistentInteractive` có `taskNote` | Mention thông thường (`reason: 'mention'`) |
| Embed task + completion instruction của đúng `turnId` | Đưa `recentMessages` vào live pane |
| Giới hạn kích thước, normalize control chars, deterministic truncate | Thay đổi `TeamEvent.spawnTurn` schema hay SSE contract |
| Fail-safe khi interactive orchestrated turn thiếu task | Thay đổi `turnBridge`/`terminalApi` transport |

**Lý do defer mention:** `handleNewMessage()` hiện tạo turn mention không kèm `TurnJob`, nên
không có `persistentInteractive`; client chỉ inject khi event có `interactiveRequired`. Vì vậy
AC “mention interactive” không đạt được chỉ bằng thay formatter. Một plan riêng phải định nghĩa
pane ownership, routing, completion semantics và fallback nếu chưa có live pane.

## 3. Thiết kế

### 3.1 `packages/daemon/src/agents/index.ts` — `buildInjectLine`

Giữ nguyên các positional parameter hiện hữu để không làm regress các turn non-orchestrated.
Chỉ thêm `taskNote?: string` ở **cuối** chữ ký:

```ts
buildInjectLine(
  agent,
  reason,
  messageCursor,
  hasAssignment,
  orchestrated = false,
  interactiveTurnId?,
  taskNote?,
)
```

Branch table:

| Điều kiện | Inject text |
|---|---|
| `orchestrated && interactiveTurnId !== undefined && taskNote.trim()` | Header orchestrator + task đã chuẩn hoá + instruction chỉ làm task + `team_turn_complete` cho đúng turn ID. Không `team_read_messages`, `team_send_message` hay mention. |
| `orchestrated` nhưng task rỗng | Không được tạo inject text; workflow fail turn trước khi emit `spawnTurn`. |
| Không orchestrated + `hasAssignment` | **Giữ nguyên** fallback `team_get_assignment`. |
| Không orchestrated + không assignment | **Giữ nguyên** fallback `team_read_messages`. |

Payload phải là **một physical input line**, không dùng raw multiline paste. Format mục tiêu:

```text
[writer-room orchestrator · assignment] NHIỆM VỤ: <safe taskNote>. Chỉ làm nhiệm vụ trên; không đọc chat cũ, không team_send_message, không mention agent khác. Khi xong, gọi team_turn_complete (agentId "…", turnId …, status "done"); nếu không thể hoàn tất thì status "failed".
```

#### PTY-safe task representation

Tạo helper thuần, ví dụ `toSafeInteractiveText(value: string): string`, với các quy tắc cố định:

1. Chuẩn hoá CRLF/CR/LF và tab thành một space; collapse whitespace liên tiếp.
2. Thay mọi C0/C1 control character (bao gồm ESC, NUL, CR) bằng space trước khi ghi PTY.
3. Giới hạn **8 KiB UTF-8** cho phần `taskNote` và **12 KiB UTF-8** cho toàn bộ `injectText`.
4. Cắt theo UTF-8 boundary và nối marker: `… [task truncated; call team_get_assignment for the full assignment]`.

Do đó “embed” nghĩa là bảo toàn nội dung nhiệm vụ có thể đọc được trong giới hạn an toàn, không
phải gửi byte nguyên văn vào terminal. `submitPtyLine` vẫn ghi text rồi gửi đúng một Enter như
hiện tại; không cần thay client hoặc event contract.

### 3.2 `packages/daemon/src/team/workflow.ts` — `dispatchNext`

Sau khi tính `taskNote` và `persistentInteractive`, thêm hard gate trước khi build spec:

```ts
if (persistentInteractive && job?.orchestrated === true && !taskNote?.trim()) {
  // mark failed, audit lý do thiếu taskNote, publish settled; không emit spawnTurn
}
```

Khi gọi `buildInjectLine`, truyền `taskNote` ở parameter mới cuối cùng. Không di chuyển hoặc
đọc `recentMessages`: nhánh headless giữ nguyên inline `store.read(...)` và hành vi hiện có.

### 3.3 Contract không đổi

- `TeamEvent.spawnTurn.injectText` vẫn là `string`.
- `turnBridge`, `terminalApi` và `submitPtyLine` không đổi.
- `writer-run-v2.ts` chỉ chọn interactive mode; `lane-scheduler.ts` tiếp tục là nơi tạo
  `taskNote` có các path chuẩn.

## 4. Rủi ro và xử lý

| Rủi ro | Xử lý / kết quả mong đợi |
|---|---|
| Task có CR, ESC hoặc control byte làm PTY submit/cancel ngoài ý muốn | Normalize trước khi gọi terminal writer; test chứng minh inject output không chứa C0/C1/CR/LF. |
| Task quá dài làm TUI chậm hoặc mất Enter | Cap 8 KiB task / 12 KiB inject, marker deterministic, và MCP fallback cho bản đầy đủ. |
| Orchestrated turn đọc chat khi thiếu task | Fail-safe trước `spawnTurn`; không fallback sang `team_read_messages`. |
| Ack message bị thay đổi | Embed assignment không tự ACK và không đổi `messageCursor` của turn. Agent chỉ ACK khi chính nó gọi MCP; Writer orchestrated instruction vẫn không yêu cầu ACK. |
| Non-orchestrated assignment regress | Giữ `hasAssignment` và toàn bộ fallback hiện hữu; thay đổi mới chỉ kích hoạt cho persistent interactive orchestrated turn. |

## 5. Test

### Unit — `buildInjectLine` / safe-text helper

1. Persistent interactive orchestrated task bình thường: inject chứa task, completion có đúng
   `turnId`, và không chứa team chat/send/mention instruction.
2. Task có `\r`, `\n`, tab, ESC, NUL và C1: output chỉ là một physical line, không còn control
   character; semantic text còn đọc được.
3. Task vượt 8 KiB: output không vượt cap tổng, có marker truncate, không cắt vỡ UTF-8.
4. Non-orchestrated assignment và non-assignment giữ nguyên strings fallback hiện tại.

### Integration — `TeamWorkflow`

1. Persistent orchestrated job với task: `spawnTurn.injectText` chứa safe task, event có
   `interactiveRequired: true`, và instruction completion dùng đúng `turnId`.
2. Persistent orchestrated job thiếu task: không có `spawnTurn`; turn kết thúc `failed` và audit
   nêu rõ thiếu `taskNote`.
3. Headless mention/assignment: prompt và event behavior hiện tại không đổi; đọc messages chỉ
   còn ở headless path.

Chạy tối thiểu:

```sh
bun test packages/daemon/test
bun run typecheck
```

## 6. Acceptance criteria

1. Writer v2 interactive assignment có `taskNote` hợp lệ: pane nhận một inject text chứa task
   representation, `prompt.md`/`envelope.json`/`out/result.json` paths, và đúng `turnId`.
2. Không byte C0/C1, CR hay LF từ `taskNote` đi vào PTY; toàn bộ injection có đúng một Enter do
   `submitPtyLine` gửi sau text.
3. Payload luôn nằm trong cap; payload bị truncate nêu rõ MCP fallback.
4. Interactive orchestrated job thiếu task fail an toàn, không đọc/leak team chat.
5. Non-orchestrated fallback và headless behavior không đổi.
6. `injectText` vẫn là một `string`; không đổi event/SSE/client contract.

## 7. Smoke test thủ công

1. Restart daemon và mở app Tauri.
2. Chạy một Writer v2 run interactive. Xác nhận author pane nhận đúng một command/prompt, hiển thị
   các path `prompt.md`, `input/envelope.json` và `out/result.json`, sau đó bắt đầu làm việc.
3. Chạy task fixture chứa newline và ESC; xác nhận không có submit sớm, cancel hay ký tự điều
   khiển tác động pane.
4. Chạy fixture task lớn hơn 8 KiB; xác nhận marker truncate xuất hiện và agent có thể lấy bản
   đầy đủ qua `team_get_assignment`.
5. Agent hoàn thành: `out/result.json` hợp lệ và run advance như cũ.

## 8. Follow-up riêng: interactive mention delivery

Không implement trong plan này. Trước khi làm, cần ADR cho: điều kiện một agent sở hữu live pane,
ai tạo/reuse pane khi mention đến, completion/ACK semantics, payload boundary cho
`recentMessages`, và fallback headless khi pane không tồn tại.
