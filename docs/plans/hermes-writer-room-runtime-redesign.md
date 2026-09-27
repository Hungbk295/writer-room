# Hermes làm agent runtime cho Writer Room — kế hoạch triển khai

Trạng thái: **CONDITIONAL PASS cho kiến trúc đích; chưa đủ điều kiện cắt bridge hoặc chuyển Writer stage**. Ngày 28/9/2026. Đây là kế hoạch, chưa triển khai.

## 1. Kết quả cần đạt và ranh giới

Từ Telegram, chủ tạo và điều chỉnh một ResearchTask, xem tiến độ từng vòng và báo cáo có bằng chứng Spy; sau đó tạo bài viết, duyệt các điểm cần người, chạy gate và nhận artifact. Hermes phụ trách tương tác, lập kế hoạch và thực thi agent. Writer Room sở hữu trạng thái nghiệp vụ, quota, bằng chứng, gate, signoff và quyết định xuất bản. Không có đường điều khiển Devin/1DevTool terminal trong kiến trúc đích.

```text
Telegram → Hermes Operator → Research / Writer profile
                              │        │
                              └── MCP hẹp ──→ Writer Room daemon
                                               ├─ ResearchTask + ledger + artifact store
                                               ├─ Writer run + deterministic gate + signoff
                                               └─ Spy service / MCP
```

Profile cùng máy/repo không đồng nghĩa cùng process. `terminal.cwd` chỉ đặt thư mục làm việc; nó không cấp ownership cho Writer Room state. Mọi mutation nghiệp vụ đi qua API của daemon. Hermes session chỉ là context có thể thay thế.

## 2. Hiện trạng và khoảng cách

| Mảng | Hiện có | Phải thêm hoặc thay |
| --- | --- | --- |
| Hermes | Repo `../hermes` đã có profile `content-production`, direct Writer/Spy MCP, Telegram gateway và cấu hình tắt terminal/delegation. Chưa chứng minh E2E Telegram → worker. | Operator/Research/Writer profile; kiểm tra cross-profile handoff thực tế, quyền và restart. Không coi `delegate_task` mặc nhiên là chuyển profile. |
| Research | `niche-strategy-loop` là skill chạy trên agent, có trần 13 vòng, 1.300 video, Spy-only, file checkpoint. Plan ResearchTask/bridge còn ở mức đề xuất. | Domain ResearchTask, ledger giao dịch, tool control, artifact validation và resume contract. Chuyển luật skill thành server-side gate ở những chỗ có side effect. |
| Writer | Writer MCP có 17 tool; daemon vẫn spawn agent theo `substrate: terminal` hoặc nhận external turn. Gate và repair nằm trong `writer-run-v2.ts`. | Phase đầu giữ daemon chạy Writer. Muốn Hermes Writer thay agent stage phải thiết kế substrate/turn adapter riêng, không dùng `writer_post_create` như bằng chứng rằng Hermes đã là Writer runtime. |
| Spy | Spy MCP hoạt động; vài tool có side effect và scope `spy.start`. | Đóng gói quyền theo profile; gắn các Spy run ID/video ID vào ledger ResearchTask, không dựa vào prompt để tự đếm budget. |
| Publish | `writer_publish` trong sơ đồ ý tưởng chưa có trong Writer MCP catalog. | Định nghĩa signoff/publish workflow riêng sau khi xác định đích xuất bản và quyền owner. Không expose publish sớm. |

Các tên `research_task_*`, `research_round_*`, `writer_run_gate`, `writer_publish` dưới đây là **contract đề xuất**, không phải tool hiện có. Docs `mcp-inventory.md` có vài thông tin transport/token cũ; dùng code `http.ts`/`paths.ts` và live discovery để chốt cấu hình.

## 3. Quyết định kiến trúc

1. **Daemon là source of truth.** Hermes giữ hội thoại, không giữ phase/round/budget/status cuối cùng. Mỗi quyết định chuyển trạng thái là giao dịch bền ở Writer Room.
2. **Không thêm research bridge.** Không dùng terminalId, parse CLI stdout, Devin receipt hay reattach terminal. Bỏ code bridge chỉ sau khi ResearchTask E2E và rollback đã qua gate.
3. **Ba vai trò, quyền riêng.** Operator chỉ có tool tạo/điều khiển task, xem status và chuyển quyết định đã xác thực. Research chỉ có task được giao + Spy capability cần thiết + artifact submit. Writer chỉ có WriterTask/stage được giao; không có human signoff/publish. Hermes tool `include` là giảm tool nhìn thấy, **không phải ACL server-side**.
4. **Triển khai ban đầu một host gateway multiplex nếu bản Hermes cài đặt hỗ trợ.** Profile vẫn có config, secret, memory, session riêng; gateway chung là một failure domain. Nếu cần cách ly process thật, triển khai service riêng sau khi xác minh chế độ Hermes hỗ trợ và chi phí vận hành; không ghi mặc định “mỗi profile một service”.
5. **Handoff cross-profile là gate P0.** Đo chính xác Hermes Operator giao task sang Research/Writer profile nào, tool/secret/session nào được dùng, kết quả trả về sau restart. Nếu native delegation chỉ tạo subagent cùng profile, dùng profile-targeted API/queue có định danh và receipt, hoặc trì hoãn tách profile; không cấp union quyền cho Operator để lách.

## 4. Contract ResearchTask v1

`ResearchTask` tối thiểu: `taskId`, `ownerId`, `mode`, `input`, `region`, `language`, `topic`, `phase`, `roundIndex`, `version`, `budget{maxRounds,maxUniqueVideos,maxSearchCost,spent,reserved}`, `spyRunRefs[]`, `artifactRefs[]`, `pendingInstruction{commandId,version}`, `workerBinding{profile,sessionRef,leaseUntil}`, `createdAt`, `updatedAt`, `lastError`.

Tách bảng/record: `ResearchRound(taskId,roundIndex,planHash,phase,reservation,startedAt,completedAt)`, `ResearchEvent(cursor,taskId,type,payloadHash,at)`, `ResearchCommand(commandId,taskId,expectedVersion,state)`, `ResearchArtifact(artifactId,taskId,roundIndex,type,path,sha256,validationState)`, `ResearchVideo(taskId,videoId,sourceSpyRunId)`. Video unique tính bằng `(taskId, videoId)`; không cộng tổng số dòng do agent báo. Search quota lấy từ Spy service thực tế; ngân sách dự kiến được reserve trước dispatch và settle/release khi kết quả về. Mọi write dùng atomic transaction và optimistic version.

State: `created → ready → running → completed`; `running → pause_requested → paused → running`; `running → cancel_requested → cancelled`; mọi trạng thái chạy có thể thành `blocked` hoặc `failed`. `unknown` là trạng thái vận hành khi mất worker/ack, không tự coi là completed hay retry side effect. `completed` đòi manifest, report, ledger, Spy refs, validation pass và worker completion; text “done” không đủ.

Tool control v1: `research_task_create`, `research_task_start`, `research_task_get`, `research_task_events(afterCursor,limit)`, `research_task_instruct(commandId,expectedVersion)`, `research_task_pause`, `research_task_resume`, `research_task_cancel`, `research_round_reserve`, `research_round_checkpoint`, `research_round_complete`, `research_task_complete`. Tách tool Operator và worker bằng token/subject ở server; worker chỉ mutate task được bind. Mọi mutation có idempotency key, expected version và response mô tả `accepted`/`applied`/`settled`, không gộp chúng.

Chỉ dẫn giữa lúc chạy được ghi bền, áp dụng ở ranh giới vòng tiếp theo, trả `instruction_applied` event. Pause chỉ là `paused` sau checkpoint ack. Resume phải có cơ chế đánh thức worker đã nghiệm thu; ghi file cờ đơn lẻ không đủ. Sau crash, daemon đọc event/ledger và xác minh worker binding trước dispatch tiếp; trạng thái chưa rõ cần reconcile thủ công hoặc protocol worker có de-dup trước side effect.

Artifact theo run directory do daemon cấp, đường dẫn được canonicalize và giới hạn trong root; ghi tệp tạm rồi rename, đăng ký hash/size/type. `round_complete` đối chiếu video ID, số search, Spy run refs và nguồn trước khi settle budget. Báo cáo phân biệt fact đã đối chiếu, suy luận và lỗ hổng; ASR/tựa/comment là dữ liệu không tin cậy. Gate cuối kiểm 100% con số dùng trong kết luận với Spy cache/manifest theo luật skill.

## 5. Writer migration

**Bước W1:** Hermes Operator dùng Writer MCP sẵn có với `substrate: terminal`; daemon tiếp tục quản lý stage, critic, gate, repair. Chứng minh Telegram → hook selection → DONE/FAILED_GATE, restart và artifact. Đây là orchestration qua Hermes, chưa phải Hermes Writer runtime.

**Bước W2:** Chuẩn hóa `WriterTask`/turn assignment: `runId`, `turnId`, `stage`, `attempt`, `input artifact hashes`, `output schema`, `deadline`, `worker profile/session binding`. Xây adapter nhận kết quả Hermes Writer, lưu result qua đường settle hiện có, giữ deterministic gate/critic/repair trong daemon. Không cho worker gọi `writer_stage_complete` cho turn không thuộc mình; không cho result tùy ý tự đặt DONE. So sánh output/gate giữa terminal và Hermes trên cùng fixture.

**Bước W3:** Chuyển từng stage được phép sang Hermes Writer bằng feature flag, bắt đầu ở stage ít rủi ro, giữ rollback về terminal. Review, gate và signoff không chuyển sang prompt. Chỉ sau khi mọi stage, timeout, retry, restart và quyền đều đạt mới bỏ đường spawn agent cũ nếu không còn consumer khác.

Publish là phase riêng: định nghĩa đích, draft/approval token gắn owner và artifact hash, kiểm lại gate tại lúc publish, ghi receipt/idempotency. Không có tool publish cho Research/Writer.

## 6. Triển khai và nghiệm thu theo phase

| Phase | Deliverable | Gate bắt buộc |
| --- | --- | --- |
| P0 — proof Hermes (1–2 ngày) | Pin version Hermes; cấu hình 3 profile thử; kiểm Telegram routing, profile-targeted handoff, MCP allowlist, terminal.cwd, secret isolation, restart. | Trace chứng minh task chạy dưới Research profile và không thấy Writer/publish tool; nếu không có cross-profile delegation, chốt transport thay thế trước P1. |
| P1 — ResearchTask core (3–5 ngày) | Store/migration, transaction ledger, event cursor, ACL, MCP schemas, artifact registry. | Concurrent reserve không vượt 13/1.300/quota; duplicate command/round không tăng budget; worker token không impersonate owner. |
| P2 — một vertical slice (3–5 ngày) | Research worker chạy 1 vòng qua Spy, checkpoint, report, status Telegram; Hermes skill dùng API mới. | Spy run/video IDs kiểm được; restart gateway/daemon rồi tiếp tục không lặp search đã settle; pause/resume/cancel có ack thật. |
| P3 — full niche loop (3–5 ngày) | Adapt skill và scripts, 13-round cap, progress event, report validator, coverage. | Chạy một run thật hoặc fixture Spy replay đủ nhiều vòng; con số báo cáo đối chiếu; quota exhaustion tạo partial report có nhãn. |
| P4 — Writer integration (2–4 ngày cho W1; W2/W3 estimate sau proof) | Operator orchestration W1, sau đó Writer stage adapter theo W2/W3. | Gate đỏ không thành DONE; worker khác không settle turn; restart/timeout không tạo hai stage result. |
| P5 — cutover (1–2 ngày) | Feature flags, rollback runbook, bỏ bridge chỉ sau khi không còn task active; cập nhật docs/diagram. | Một task Telegram E2E Research → Writer → signoff thử, audit đủ ID/hash/receipt; rollback không mất task. |

Thời lượng chỉ là ước tính triển khai, phụ thuộc P0 và phạm vi Writer W2/W3. Không dùng nó làm cam kết trước khi đo Hermes cross-profile transport.

## 7. Bảo mật, vận hành và rollback

- Tách credential theo actor tại **Writer Room server**; token MCP chung hiện tại phải được thay hoặc bọc bằng scoped token trước khi cho research worker gọi mutation. Loopback và `tools.include` không chứng minh danh tính. Owner decision từ Telegram cần binding numeric user/chat/message và audit; agent không tự signoff.
- Spy MCP gồm tool start/mutation nhẹ, nên allowlist chính xác theo workflow, tránh nói toàn bộ Spy là read-only. Không cấp human decide, loop write hoặc Writer stage settlement cho Research.
- Gateway multiplex có một process chung: chết gateway thì cả ba profile mất tương tác, nhưng task bền ở daemon; watcher/outbox gửi progress theo event cursor, chống gửi trùng theo delivery receipt. Không poll bằng LLM liên tục.
- Theo dõi `taskId`, `roundIndex`, `commandId`, `workerSession`, `spyRunId`, `artifactHash` xuyên log. Alert cho worker lease quá hạn, budget mismatch, failed gate và event delivery backlog; không log token/transcript nhạy cảm.
- Cutover qua feature flag theo task mới; task cũ chạy đến checkpoint hoặc kết thúc. Backup store/artifacts, chạy migration có forward/backward plan. Rollback cấu hình profile và route về executor cũ; không xóa bridge/state cũ trước khi reconciliation sạch.

## 8. Quyết định còn mở

1. Hermes version được pin và kết quả proof cross-profile handoff. Đây là blocker P1 integration, không phải lý do trì hoãn thiết kế domain store.
2. Chọn SQLite trong daemon hay store hiện có cho ResearchTask sau khi kiểm tra transaction/backup pattern; yêu cầu invariant và migration ở §4 không đổi.
3. Scope đích: chỉ research + Writer Room, hay bao gồm DNA Spy/cook và publish ngoài app. Plan này chưa gộp DNA Spy vì cần contract và owner riêng.
4. Writer W2/W3 có thực sự cần thay daemon-managed Claude stage hay chỉ cần Hermes làm Operator/Research. Quyết định này xác định phần việc lớn nhất sau P3.

## Nguồn đối chiếu

- Code: `packages/daemon/src/writer-mcp.ts`, `writer/writer-run-v2.ts`, `http.ts`, `paths.ts`; `.agents/skills/niche-strategy-loop/SKILL.md`; `../hermes/README.md` và config.
- Hermes upstream: profiles, multi-profile gateways, MCP config và delegation patterns (kiểm ngày 28/9/2026). Pin release và chạy P0 vì tài liệu các mode gateway có thể khác version cài đặt.
