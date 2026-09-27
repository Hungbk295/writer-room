# Hermes điều khiển research agent trong Writer Room

Trạng thái: đề xuất ngày 27/9/2026, chưa triển khai. Đối chiếu code hiện tại;
đã nhận đối chiếu từ Devin qua linked terminal. Phản hồi làm rõ có receipt queued,
chưa coi là Devin đã acknowledgment. Không mở Team hoặc agent mới trong cuộc trao đổi này.

## Outcome

Từ Telegram, chủ giao một nhiệm vụ niche research cho agent, nhận tiến độ từng
vòng, xem báo cáo và tiếp tục cùng context. Hermes dùng gpt-6-sol low để diễn
giải chỉ dẫn; Writer Room giữ nhiệm vụ, quyền, turns, checkpoints và kết quả.
Không hồi sinh hermes-workspace và không đặt vòng research trong chat Hermes.

```text
Chủ trong Telegram
  ↕ chỉ dẫn / tiến độ / cần quyết định / báo cáo
Hermes: model điều phối + application MCP client
  ↕ authenticated research-control MCP
Writer Room: ResearchTask + scheduler + quota + event/artifact store
  ↕ executor adapter: task / accepted / progress / result / interrupt
Research leader: Devin hoặc runtime đã được hỗ trợ
  ↕ Writer Room Spy MCP, skill niche-strategy-loop
Nguồn YouTube + round summaries + report.md / report.html
```

## Nền tảng đã có, và giới hạn

| Thành phần | Có trong code | Chưa đủ |
|---|---|---|
| Agent registry | /api/agents, readiness, prepare-launch | Chưa có Devin adapter |
| Assignment | /api/team/assign | Chưa có MCP controller tạo/giao task research |
| Chat worker | team_send/read/ack_messages | Có token nhưng caller tự đưa senderAgentId; chưa phải hierarchy ACL |
| Turn | TeamWorkflow.requestTurn, team_turn_complete | Chưa gắn ResearchTask có round/checkpoint/verified artifact |
| Continuity | persistentInteractive, resumeSessionRef | Session ref theo agent; cần isolate theo task, tránh context task khác |
| Theo dõi | /api/team/status và /api/team/events | SSE chưa cursor replay; không đủ khôi phục sau ngắt |
| Dừng | /api/team/interrupt | Event cần executor tiêu thụ; chưa có pause/resume research contract |
| Executor | Tauri turnBridge chạy PTY | Daemon một mình không bảo đảm worker đã chạy; có gap reconnect/launch |
| Research skill | .agents/skills/niche-strategy-loop | Skill ≠ service; cần runner/capability/budget binding |

Code kiểm tra: agents/config.ts; agents/adapters.ts; team/workflow.ts;
team/mcp.ts; http.ts; web/features/turn-bridge/client.ts.

Default adapters hiện hỗ trợ claude-code/codex/agy/gemini/grok. Đặt executable
thành devin trong một adapter Claude không phải tích hợp Devin hợp lệ.
Writer pipeline chỉ chấp nhận default agent IDs và hạn chế Bash/Task/Skill ở
staged turns: không dùng stage WRITE để chạy niche loop tự do.

## Hierarchy và acknowledgment

Chủ → Hermes (operator) → research leader → worker slices nếu skill cho phép.
Writer Room là runtime thực thi/kiểm tra; Hermes không thay scheduler của app.
Nếu gắn terminal nằm trong hierarchy 1DevTool, role card/đường route do 1DevTool
cấp có hiệu lực. Không tự đổi manager hoặc tạo skip-level link để tiện điều phối.

Khi attach/create executor, gửi assignment có taskId, assignmentVersion,
scope, repo, skill, budget, manager route và output contract. Executor phải ack
đúng version, capabilities và session binding trước khi đánh dấu ready.
Ack vai trò không chứng minh research đã chạy hoặc task hoàn tất.

API không cho caller tự xưng senderAgentId=human/manager. Client identity phải
được binding qua token/subject/ACL. Worker token chỉ đọc task của mình và gửi
event/artifact/complete cho task/turn được giao; không tự settle turn khác.

## Hai đường thực thi

**Attach Devin đang mở (v1 có thể thử):** Writer có executor bridge gọi đúng
1DevTool link đã được cho phép, giữ terminalId. delivered chỉ chứng minh terminal
ack message; cần task acknowledgment và artifacts/events riêng để chứng minh
tiến độ/kết quả. delivery-unconfirmed không resend tự động; queued xử lý đúng
receipt. Không đọc terminal để suy ra kết quả, không thay bằng run --to=devin.
Bridge phải có danh tính terminal/seat được 1DevTool chấp nhận; tiến trình Hermes
không tự thừa hưởng link quyền của terminal Codex này.

**Create Devin do app quản lý (sau đó):** thêm adapter Devin thật, xác minh CLI
launch/resume/status/interrupt/auth/MCP/skills, rồi Writer tạo worker có task
binding. Chỉ dùng CLI flags đã kiểm; không giả định Devin giống Claude.
Không tuyên bố có thể tạo agent Devin native trước khi adapter pass acceptance.

Khuyến nghị: nghiệm thu attach một agent bằng một task nhỏ trước; tiếp theo
native create khi adapter chứng minh được continuity. Không làm cả hai cùng lúc.

## MCP controller đề xuất (CHƯA CÓ)

| Tool dự kiến | Công việc |
|---|---|
| research_executor_catalog | Agent/runtime/capability/readiness được phép dùng |
| research_task_create | Validate input/budget/executor, tạo task; chưa chạy |
| research_task_start | Dispatch idempotent; trả acceptance + current turn |
| research_task_status | Phase/round/budget/heartbeat/error/pending instructions |
| research_task_events | Đọc event bền sau cursor, bounded result |
| research_task_result | Report/artifact refs + verification/coverage |
| research_task_instruct | Ghi lệnh tiếp có commandId/version; trả delivery/application ack |
| research_task_pause | Pause tại checkpoint; trả pause_requested hoặc paused |
| research_task_continue | Tiếp cùng task từ checkpoint hoặc mở turn mới sau completed |
| research_task_cancel | Ngắt executor, settle khi xác nhận; không gọi cancelled sớm |

Các tool bọc app handlers/store hiện có và research task module; không proxy toàn
bộ /api/agents hoặc mọi Bash cho Hermes. Bắt đầu với một workflow niche-strategy.

## IDs, events và artifacts

Giữ taskId nghiệp vụ ổn định; tách agentId, executor terminalId/native sessionRef,
turnId của một lượt giao việc, roundIndex của research, commandId chống gửi lặp,
eventCursor để reconnect, artifactId/hash cho report. Một turn có thể chứa nhiều
round: số lượt chat không đồng nghĩa số vòng research.

State gợi ý:
```text
created → validating → starting → running → completed
                              ↘ blocked / failed
running → pause_requested → paused → running
running → cancel_requested → cancelled
completed + chỉ dẫn mới → preparing continuation → running (turn mới)
```

State transitions và command order phải do app cưỡng chế, không giao hết cho
prompt. task_completed cần artifact validate, coverage/budget report và worker
completion, không chỉ text "done". Quá trình verification nội dung vẫn cần
leader đối chiếu số với Spy evidence; exit code 0 không chứng minh đúng dữ kiện.

Checkpoint: round-n/plan.md, dispatched, evidence outputs, summary.md, video-ID
budget ledger, report.md/report.html. Khôi phục từ files đã kiểm khi mất CLI
session; session mới đọc checkpoint, không tự lặp mutations hoặc search đã xong.
Writer store giữ manifest/IDs/counters; không cần database điều phối ngoài app.

## Điều khiển khi đang chạy

Hermes gửi "focus thuê nhà, bỏ vàng" → research_task_instruct → command queued
→ leader ack → áp dụng ở checkpoint trước round tiếp → event instruction_applied.
Không nhét instruction vào output stream khi CLI đang generate.

Nếu muốn ngắt ngay, dùng cancel/interrupt riêng và đợi executor ack. Pause mặc
định tại ranh giới round. Nếu permission prompt đang chờ, trả blocked với yêu
cầu cụ thể; không tự chấp thuận quyền shell/provider bằng một tin nhắn vague.

Skill niche-strategy-loop hiện tự chạy sau setup và cho phép người dùng steer
giữa chừng. Giữ trần 13 vòng, 1300 video duy nhất, quota và Spy-only. Budget thấp
hơn của chủ có hiệu lực. Continue không tự reset counters của cùng research run;
muốn ngân sách mới phải tạo run mới có lineage/chỉ dẫn rõ ràng.

Skill hiện yêu cầu Sonnet subagents trong một số vòng. Devin phải chứng minh có
capability đó hoặc dùng một skill biến thể được chủ chốt rõ; không ngầm nói đã
chạy đúng skill trong khi thay subagent/runtime. Bản một leader chỉ được dùng ở
phạm vi skill cho phép leader tự làm; không mở Team mới trong lần trao đổi này.

## Theo dõi trên Telegram mà không giữ một lượt LLM sống mãi

MCP status/events cho Hermes xem theo yêu cầu. Muốn tự nhắn khi round xong cần
gateway connector/watcher đọc event cursor, lọc round_completed/blocked/failed/
task_completed và gửi chat riêng đã binding. MCP không tự đẩy một tin nhắn chat.
Watcher transport không làm research hoặc giữ state machine thứ hai; app là
nguồn sự thật, gateway chỉ giữ delivered cursor/receipt và retry giao tin.

Không gọi gpt-6-sol mỗi vài giây chỉ để poll. Progress summary từ artifact của
worker; Hermes dùng model khi có chỉ dẫn mới, cần quyết định hoặc cần tóm tắt.
Không spam heartbeat lên Telegram; mỗi round một báo cáo ngắn và một link artifact.
Scope đăng channel công khai tách khỏi scope tiến độ private.

## Ví dụ vận hành

1. "Giao Devin research finance VN: tiền thuê nhà, mua nhà; tối đa 3 vòng và
   100 video, dùng niche loop."
2. Hermes hỏi một lần các đầu vào còn thiếu, validate executor/budget rồi start;
   trả taskId và chỉ báo đã khởi chạy khi executor ack.
3. "Task đó tới đâu?" → status + summary nguồn Spy, quota/video/round counters.
4. "Vòng tiếp chỉ tập trung người đi làm 25–35 tuổi" → instruct; báo queued rồi applied.
5. "Tạm dừng sau vòng này" → pause_requested rồi paused có checkpoint.
6. "Tiếp tục, đào sâu comment của 3 kênh tốt nhất" → cùng task, turn/session binding
   đúng; kiểm tra ngân sách còn lại. Chạm budget thì báo cần một run mới.
7. "Lấy báo cáo cuối" → artifact refs đã kiểm; không tự chuyển thành bài Writer.
8. "Viết bài từ đề tài thứ hai" → một Writer post mới, liên kết research evidence,
   đi qua hook/gates/signoff của pipeline viết bài.

## Nghiệm thu tối thiểu

- Task create không launch; start retry không tạo worker/task thứ hai.
- Nhận exact assignment acknowledgment và đúng manager route.
- Hai turn liên tiếp nối đúng checkpoint/context; không lẫn task khác.
- Steer khi running: có queued/ack/applied; không báo applied sớm.
- Pause/continue/cancel có executor acknowledgment và trạng thái thật.
- Restart gateway/daemon: replay event không mất báo cáo hoặc dispatch lặp.
- Spy references và số báo cáo kiểm được; budget giữ qua continuation.
- Task proof/worker outputs không chứa credentials; caller không giả sender.
- Không Team/worker fallback cho Devin linked terminal nếu link send không được xác nhận.


## MVP sau đối chiếu với Devin

Có thể giảm phạm vi bằng executor terminal bền của 1DevTool cho research tự do,
không cần đưa Devin vào native TeamWorkflow ngay. Giữ Writer pipeline qua Writer
MCP và daemon gates. Đây là phương án đề xuất, chưa có transport trong Hermes.

Hermes hiện tắt terminal/delegation. Vì vậy cần một cầu nối MCP giới hạn:
create/start, instruct, status/result, pause/continue/cancel. Cầu nối giữ mapping
jobId → terminalId/teamId/runDir/session, chỉ điều khiển worker do nó sở hữu và
đọc artifacts trong runDir đã đăng ký. Không mở shell tùy ý cho model. Cầu nối
có thể là integration nhỏ; không nhất thiết thêm native Devin adapter vào app.

`terminal submit --prompt-stdin` đã có submissionId receipt. Help mô tả exit 0
là ghi vào composer sẵn sàng, exit 3 là ghi khi có vẻ đang busy. Cả hai chưa
chứng minh worker đã áp dụng chỉ dẫn. Thêm commandId/assignmentVersion vào prompt
và status/events để phân biệt accepted, applied, completed; queue chỉ dẫn khi
worker bận và không resend khi receipt không rõ.

Worker ghi status.json atomically mỗi vòng và khi đổi phase, với jobId, round,
turnId, assignmentVersion, lastAppliedCommandId, phase, heartbeatAt, budgetUsed,
question, reportPath. Hermes lưu event cursor/checkpoint để khôi phục sau restart.
Tiếp tục giữ ngân sách đã dùng; một vòng có thể gồm nhiều model turns.

Skill niche-strategy-loop có yêu cầu Claude Task/Sonnet. Devin run_subagent
không mặc nhiên tương đương model đó: khai báo adaptation/capabilities trước
khi chạy. Sau setup tự chạy các vòng theo skill; chỉ chờ human ở điểm runtime,
permission hoặc quyết định cần người, không hỏi lại từng vòng.

HTTP Spy decide ghi actor human theo route, nhưng loopback không tự chứng minh
Telegram owner đã duyệt. Nếu relay quyết định, dùng broker xác thực owner, lưu
request/message evidence và chỉ cấp quyền quyết định cho operator; worker không
được tự decide. Không dùng route này để đổi follow/keyword trong niche research.

Nghiệm thu: tạo một worker thử, nhận task acknowledgment, chạy một vòng có
artifact thật, đưa lệnh tiếp theo vào cùng session, khôi phục khi Hermes restart,
và kiểm chứng pause/cancel. Chưa chạy các nghiệm thu này.


## Review bổ sung: daemon bridge-runner (Devin)

Chấp nhận có điều kiện hướng daemon sở hữu bridge-runner, Hermes gọi MCP hẹp,
1DevTool sở hữu terminal/session. Đây vẫn là đề xuất chưa triển khai. Không cần
native Devin adapter ngay, nhưng không được giả định thêm agentId devin-bridge
sẽ tự bypass validation/getAdapter. Phải có đường dispatch research riêng hoặc
substrate được kiểm chứng, và bảo đảm Tauri bridge không spawn trùng.

Các điều kiện nghiệm thu bổ sung:
- Pause phải có pause_requested → checkpoint acknowledgment → paused. Không
  gửi prompt tiếp không dừng loop đang tự chạy. Hard stop không đồng nghĩa pause.
- Exit 3 của submit không bảo đảm queue/apply; giữ commandId và applied ack.
- Process exit/run --wait không chứng minh research thành công. Settle phải
  kiểm status done, task binding và artifacts hợp lệ.
- Một assignment nhiều vòng cần timeout/heartbeat/budget policy riêng; không
  tự gia hạn vô hạn hoặc mặc định vừa watchdog hiện tại.
- Restart phải verify executor ownership/liveness, reconcile orphan và chống
  dispatch trùng trước reattach. Terminal còn sống chưa đủ chứng minh đúng job.
- Kết quả lấy từ status/events/artifacts; screen tail chỉ là chẩn đoán nếu được
  phép. Không dùng screen output làm completion proof.
- Prompt cấm decide không thay ACL. Worker không có quyền gọi human decision
  route; operator broker chỉ relay quyết định đã xác thực từ Telegram owner.

Chưa triển khai bridge-runner, chưa tạo worker, chưa chạy niche research.


## MVP sửa sau review attribution của Devin

Review mới thay phương án run --terminal/team bằng terminal interactive thường:
bridge ngoài PTY chỉ dùng tập unattributed đã được Devin đối chiếu help: run,
list, terminal *. Không dựa vào stop/resolve/collect có attribution. Lệnh dự kiến
run --to=devin --interactive cần nghiệm thu output terminalId và terminal close
trước khi chốt executor. Không tạo terminal để kiểm thử trong cuộc trao đổi này.

MCP hẹp: research_spawn/send/status/result/cancel, scope research.control;
registry bền kiểm ownership, agent allowlist và cwd cố định. Không cần đụng
TeamWorkflow cho MVP này. Pause/continue vẫn phải có checkpoint contract riêng,
không suy ra từ terminal idle hoặc việc chưa gửi lệnh.

Chỉ dispatch instruction khi worker xác nhận đang chờ lệnh và terminal sẵn sàng.
Heartbeat quá hạn là trạng thái chưa rõ, không phải giấy phép submit. Exit 3
không chứng minh queue/apply. Quá deadline chuyển unknown/needs_reconciliation,
không tự retry; worker echo commandId không tự tạo được de-dup nếu chưa có ledger
kiểm command đã áp dụng trước side effect.

Scope quyết định Spy, nếu triển khai, tách khỏi research.control và không cấp
worker. Token Hermes xác thực operator service; một quyết định human còn phải
binding với owner Telegram và message cụ thể được broker kiểm chứng. Provenance
client tự ghi vào reason không thay identity verification. Route HTTP hiện có
không nên được trao cho worker như đường thay thế scope.

Nghiệm thu bắt buộc: interactive spawn trả ID đáng tin, đóng đúng terminal do
bridge sở hữu, ack/apply command, busy gate, durable restart reconciliation,
artifact validation và budget continuity. Chưa nghiệm thu, chưa triển khai.


## Review externalTurn bổ sung

Devin báo đã đối chiếu externalTurn bỏ build spec nhưng vẫn agents.get/buildInjectLine,
watchdog hiện tại 15 phút, và /api/team/assign chưa forward external. Nếu chọn tích
hợp TeamWorkflow cần kiểm toàn bộ config validation, inject line, dispatch và
persistence; một adapter kind mới ở type-level chưa đủ. Đây là option sau MVP
bridge độc lập, không phải cả hai kiến trúc đều đã được chốt triển khai.

Hai vấn đề chưa được giải quyết trong đề xuất mới:
- Retry cùng commandId không an toàn chỉ nhờ worker echo; yêu cầu durable command
  ledger và kiểm duplicate trước side effect. Chưa có thì không tự resend.
- Gửi PAUSE chỉ khi terminal idle không dừng được loop đang tự chạy dài. Dùng
  mailbox chỉ dẫn mà worker kiểm tại checkpoint, hoặc transport interrupt đã
  nghiệm thu; chỉ báo paused sau acknowledgment. MCP cần continue/resume rõ ràng.

Không dùng cwd runDir nếu làm mất repo skill/MCP config discovery: executor cwd
repo, output runDir riêng, hoặc nghiệm thu discovery trước khi thay cwd.
Timeout phải cấu hình và đo theo budget workload; chưa có bằng chứng mọi job
13 vòng đều vượt 15 phút, cũng chưa chốt cap 4 giờ. Scope Spy phải đủ các operation
research skill thực sự dùng, gồm tạo/poll job nếu cần; tách khỏi human decide.


## Chốt review kiến trúc

Devin xác nhận không có blocker kiến trúc mới; đóng vòng trao đổi. MVP chọn
independent research bridge, không TeamWorkflow. Chưa triển khai. Hai kiểm chứng
CLI trước triển khai: interactive spawn trả terminalId; terminal close đóng được
interactive seat. Đây không thay các acceptance tests về command handling,
pause/resume, restart, ownership, budget và artifact completion đã nêu.

Durable command record cần phân biệt reserved/in_progress/completed/unknown:
ghi trước side effect không tự bảo đảm exactly-once khi crash giữa thao tác và
completion. Command in_progress sau crash phải reconcile, không chỉ re-ack rồi
coi completed. Dùng trạng thái terminal đúng CLI thực tế (help trước là idle,
busy, unknown, closed), không tự đặt enum ready.


## Bổ sung cuối: mailbox và Spy capabilities

Pause mailbox trong runDir được bootstrap/skill quy định: worker kiểm đầu mỗi
round boundary, gặp yêu cầu pause có commandId/version thì ghi checkpoint và
phase paused kèm acknowledgment. Không dừng ngay giữa round. Resume phải có
wake-up transport đã nghiệm thu (prompt khi sẵn sàng hoặc runner poll mailbox);
file RESUME một mình không tự đánh thức model đã kết thúc turn. Chống flag cũ
bằng sequence/version và acknowledgment, bridge ghi mailbox atomically.

Worker cần Spy read và các capability start mà skill thực sự dùng (Devin nêu
channel_start/video_start/global_video_search/news_pull). Đối chiếu requiredScopes
và tên tool thực tế khi triển khai; không mặc định toàn bộ là read-only. Không
cấp loop.write/human-decide. Review đóng, chưa triển khai hay nghiệm thu.
