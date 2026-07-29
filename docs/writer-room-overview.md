# Writer Room — Tổng quan mục tiêu, workflow và kiến trúc

Ngày ghi nhận: 2026-07-29

## 1. Writer Room đang được xây để làm gì

Writer Room là một ứng dụng local-first giúp phát triển kịch bản YouTube bằng
một quy trình biên tập có phân quyền rõ ràng giữa con người và AI.

Đây không phải là công cụ “AI tự viết rồi tự chấm đến khi đạt điểm cao”. Mục
tiêu là tạo một phòng biên tập trong đó:

- Claude giữ quyền tác giả và chịu trách nhiệm viết.
- Codex là reviewer độc lập, chỉ chẩn đoán và đưa phương án.
- Người dùng quyết định định hướng, cung cấp trải nghiệm thật và chọn điểm dừng.
- Chất lượng được bảo vệ bằng các Hard Gate tối thiểu, không bằng target score.
- Mỗi đầu vào, bản nháp, review và quyết định đều được lưu để kiểm tra lại.

Giá trị cốt lõi của Writer Room là bảo vệ giọng riêng, tính tự nhiên và quyền
quyết định của người viết, đồng thời ngăn các lỗi nghiêm trọng về lời hứa tiêu
đề, dữ kiện, logic và khả năng gây hiểu nhầm.

## 2. Triết lý biên tập

### Claude là tác giả

Claude xây Backbone, viết Draft và sửa Draft. Codex không được thay Claude viết
lại kịch bản.

Khi nhận gợi ý từ Codex, Claude phải quyết định riêng cho từng gợi ý:

- `accepted`: chấp nhận phương án.
- `adapted`: biến đổi phương án cho phù hợp với bài.
- `rejected`: từ chối vì chi phí lớn hơn lợi ích.
- `countered`: phản biện và giải quyết vấn đề theo cách khác.

### Codex là reviewer và adviser

Codex phải:

- Trích bằng chứng cụ thể từ Draft.
- Chỉ ra ảnh hưởng đối với người nghe.
- Đưa từ một đến ba phương án có trade-off.
- Nêu phần cần bảo vệ khi sửa.
- Không trả về một kịch bản thay thế.
- Không biến sở thích thẩm mỹ thành lỗi bắt buộc.

### Người dùng giữ quyền định hướng và điểm dừng

Người dùng tham gia ở hai thời điểm có đòn bẩy cao:

1. Duyệt Backbone trước khi Claude viết full Draft.
2. Sau khi Draft đã vượt Hard Gate, chọn Stop & Lock hoặc Continue.

Người dùng không bị buộc phải chạy thêm vòng chỉ vì vẫn còn một phương án có
thể cải thiện.

### Không tối ưu theo công thức cứng

Writer Room không bắt buộc:

- Một số lượng hook cố định.
- Nhân vật xuyên suốt.
- Cấu trúc ba hồi.
- CTA.
- Tỷ lệ storytelling.
- Nhịp cảm xúc theo công thức.
- Target score 9/10 hoặc 9.5/10.

Emotion và information được đánh giá như một sàn chất lượng, không phải một
trần điểm cần liên tục tối ưu.

## 3. Workflow chính

```text
Title + Source Pack
  → Claude xây Backbone
  → Human duyệt direction
      - chọn angle
      - chọn hoặc tự viết hook
      - bổ sung audience insight, trải nghiệm thật và voice boundary
  → Claude viết Draft 1
  → Codex Review
      ├─ Có Hard Gate fail/unclear
      │    → Level 1: phương án sửa tối thiểu
      │    → Claude tự chọn cách xử lý
      │    → Claude sửa Draft
      │    → Codex review lại
      │
      └─ Tất cả Hard Gate pass
           → Level 2: phương án nâng trải nghiệm
           → Chờ người dùng
                ├─ Stop & Lock
                │    → khóa bản passing
                │    → publish vào Article Library
                │
                └─ Continue
                     → người dùng có thể thêm focus note
                     → Claude quyết định từng gợi ý
                     → Codex review lại
```

Level 1 được phép chạy tự động trong giới hạn số vòng sửa đã cấu hình. Level 2
không tự chạy: nó luôn chờ người dùng quyết định.

## 4. Backbone và Human Gate

Claude chưa được viết full Draft ở bước Backbone. Backbone cần mô tả:

- Lời hứa chính của title.
- Central question.
- Viewer before và viewer after.
- Main takeaway.
- Content mode.
- Ý đồ cảm xúc.
- Ý đồ thông tin.
- Các yếu tố phải bảo vệ.
- Evidence Ledger.
- Insight statements.
- Các angle/outline thực sự khác nhau.
- Các hook có evidence, promise, open loop và payoff beat.
- Tối đa ba câu hỏi mà AI không thể tự suy ra an toàn.

Mỗi angle và hook phải dẫn về evidence trong Source Pack hoặc một claim được
đánh dấu rõ mức độ tin cậy. Hook có truth risk cao không đủ điều kiện để được
đưa cho người dùng chọn.

Human Gate không phải một nút “Approve” chung chung. Đây là nơi người dùng khóa
góc nhìn, hook, trải nghiệm sống và giới hạn giọng văn trước khi Claude bắt đầu
viết toàn bài.

## 5. Sáu Hard Gate

Codex phải đánh giá đúng sáu Gate:

1. `title_promise_completed`
   - Kịch bản hoàn thành lời hứa cốt lõi của tiêu đề.
2. `no_major_factual_error`
   - Không có lỗi fact lớn, nguồn giả hoặc phát biểu vượt bằng chứng.
3. `no_major_logical_contradiction`
   - Luận điểm chính không tự mâu thuẫn.
4. `no_unsupported_core_conclusion`
   - Kết luận cốt lõi có đủ nền tảng.
5. `no_unresolved_primary_open_loop`
   - Open loop chính đã được payoff.
6. `no_serious_audience_misleading`
   - Không tạo kỳ vọng sai hoặc gây hiểu nhầm nghiêm trọng.

Mỗi Gate có trạng thái `pass`, `fail` hoặc `unclear`. `unclear` không được tính
là đạt. Một Gate chưa đạt phải có `passCondition` mô tả điều kiện tối thiểu để
vượt qua.

Nếu còn Gate chưa đạt, mọi gợi ý phải là Level 1 và phải bao phủ tất cả Gate
đang unresolved. Nếu tất cả Gate đạt, mọi gợi ý phải là Level 2.

## 6. Passing baseline

Khi một Draft vượt cả sáu Hard Gate, Writer Room lưu nó làm
`lastPassingRound`.

Nếu người dùng yêu cầu một vòng nâng trải nghiệm và bản mới bị regression:

- Bản passing trước đó vẫn được giữ.
- Hệ thống không ghi đè bằng candidate kém hơn.
- Nếu các vòng tự sửa tiếp theo không thành công, người dùng vẫn có thể khóa
  passing baseline gần nhất.

Đây là cơ chế bảo vệ để thử nghiệm biên tập không làm mất phiên bản an toàn.

## 7. Kiến trúc runtime

### Giao diện

Frontend dùng HTML, CSS và JavaScript thuần. Giao diện chính gồm:

- Run/Article rail.
- Version ribbon.
- Document canvas.
- Contextual Inspector.
- Hai-agent console drawer.
- Room, Library và Agents tabs.

Người dùng có thể xem riêng Backbone, Human Brief, từng Draft, từng Codex
Review và từng Claude suggestion decision. Compare mode giới hạn ở hai phiên
bản để tránh nhiều vùng cuộn lồng nhau.

### Bun/TypeScript engine

Engine là authority duy nhất được phép:

- Chuyển stage.
- Sinh prompt.
- Gọi agent.
- Parse và validate JSON artifact.
- Xác định Level 1 hay Level 2.
- Quản lý retry và recovery.
- Publish bản được chấp nhận vào Library.

Model không được tự tuyên bố rằng nó đã đạt Gate. Branch được engine suy ra từ
sáu kết quả Hard Gate đã qua schema validation.

### Agent runner

Mỗi provider attempt có:

- Logical job key ổn định.
- Input hash.
- Immutable descriptor.
- Prompt snapshot.
- Heartbeat.
- Result envelope.
- STDOUT/STDERR log.
- Retry classification.

Claude mặc định chạy ở print mode, không có tools và không giữ session. Codex
mặc định chạy bằng `codex exec` trong sandbox read-only và ephemeral mode.

Source Pack được coi là dữ liệu tham khảo không đáng tin. Prompt yêu cầu agent
không làm theo instruction nằm bên trong Source Pack.

### Desktop shell

Ứng dụng desktop dùng Tauri v2:

- TypeScript engine và runner được compile thành Bun sidecar.
- Rust shell giao tiếp với engine bằng JSON-lines RPC.
- macOS/Linux dùng native PTY.
- Windows dùng direct pipes cho print-mode agent để tránh lỗi ConPTY
  `STATUS_DLL_INIT_FAILED`.
- Khi Cancel hoặc đóng app, Rust shell dừng toàn bộ process tree liên quan.

Tmux chỉ là adapter phát triển tùy chọn, không phải dependency của bản desktop
phát hành.

## 8. Dữ liệu và quyền sở hữu

Trong development:

```text
writer-room/
├── runs/<run-id>/
│   ├── input/
│   ├── artifacts/
│   ├── jobs/
│   └── logs/
├── library.sqlite
├── exports/
└── backups/
```

Các workspace trong `runs/` là evidence gốc và gần như append-only:

- Instruction snapshots.
- Source Pack.
- Backbone.
- Human Brief.
- Drafts.
- Reviews.
- Claude decisions.
- Retry records.
- Process trace.

`library.sqlite` chỉ là projection có thể tìm kiếm của những bản đã được người
dùng Stop & Lock. Library dùng WAL và FTS5, lưu accepted Markdown, hash, Gate
status và đường dẫn tương đối về source run.

Writer Room không mở hoặc ghi vào `data/dna-spy.sqlite`.

## 9. Quá trình phát triển

### Phiên bản ban đầu

Workflow ban đầu có ba agent:

```text
Writer → Editor weighted score → SEO
```

Đặc điểm của bản cũ:

- Agent 1 tạo cả Draft sơ bộ ngay ở bước init.
- Agent 2 chấm theo target score.
- Loop tiếp tục cho đến khi đạt điểm hoặc hết vòng.
- Agent 3 chạy SEO sau khi bài được chấp nhận.

### Phiên bản hiện tại

Schema v3 chuyển sang hai vai trò:

```text
Claude Author → Codex Hard-Gate Reviewer → Human decision
```

Thay đổi quan trọng:

- Bỏ target score.
- Bỏ SEO agent khỏi active writing loop.
- Backbone không còn chứa full Draft.
- Tách lỗi bắt buộc và cơ hội nâng trải nghiệm thành Level 1/Level 2.
- Codex luôn là adviser, không phải đồng tác giả.
- Người dùng quyết định mọi vòng optional sau khi đã có bản passing.

## 10. Trạng thái implementation được quan sát

Tại thời điểm ghi tài liệu:

- Worktree đang chứa implementation schema v3 hai-agent.
- Phần implementation này đang nằm trong các thay đổi chưa commit so với
  `writer-room` Git HEAD.
- `config/agents.json` trên disk vẫn là schema v1 với ba agent, nhưng
  `AgentSettingsStore` tự bỏ slot SEO cũ khi load và sẽ lưu schema v2 hai-agent
  ở lần save tiếp theo.
- Run development duy nhất trong `runs/` là một run schema v1 chưa hoàn thành,
  còn dùng target score và ba agent. Nó là legacy evidence, không phải ví dụ
  cho workflow schema v3.
- Compatibility hiện tập trung vào việc giữ các completed run schema v2 có thể
  đọc được. Một incomplete run schema v1 không phải đường migration chính.
- Harness đã ghi nhận proof cho schema v3 gồm domain validation, Level 1/Level
  2 loop, Continue/Stop, Library publish, recovery, profile migration, mock
  browser flow, TypeScript/build và Tauri check.
- Error Knowledge Base xuyên nhiều run đã được thiết kế nhưng chủ động hoãn.
  Hiện tại hệ thống giữ một `logs/process.log` nhẹ cho từng run.

## 11. Các ràng buộc đáng chú ý

- Draft phải nằm trong khoảng ±20% length target. Với đơn vị phút, engine quy
  đổi khoảng 150 từ/phút.
- Backbone hỗ trợ 1–5 angle, 1–3 hook cho mỗi angle, 1–8 insight và tối đa ba
  interview question.
- Codex phải đưa ít nhất một Level 2 opportunity sau khi tất cả Gate đạt, nhưng
  không được bịa lỗi để tạo gợi ý.
- Level 1 editorial repair và provider retry là hai khái niệm khác nhau:
  - Editorial repair là Claude sửa Draft theo review.
  - Provider retry là engine chạy lại một job lỗi JSON, timeout hoặc process.
- Artifact đã tồn tại không được âm thầm ghi đè bằng nội dung khác.
- Library chỉ publish một Draft đã được người dùng chấp nhận và có đủ sáu Gate
  `pass`.

## 12. Hàm ý khi tạo skill cho Writer Room

Một skill liên quan đến Writer Room cần xác định rõ nó đại diện cho vai trò nào:

1. **Claude Author skill**
   - Xây Backbone, viết Draft, bảo vệ voice và quyết định từng gợi ý.
2. **Codex Reviewer skill**
   - Kiểm sáu Hard Gate, đánh giá quality floor và đưa phương án có trade-off.
3. **Writer Room Orchestration skill**
   - Điều phối toàn bộ state machine, artifacts, Level 1/Level 2 và Human Gate.
4. **Writer Room Development skill**
   - Hướng dẫn Codex phân tích, sửa và kiểm thử chính ứng dụng Writer Room.

Không nên gộp các vai trò tác giả và reviewer vào một prompt không có ranh giới,
vì điều đó làm mất tính độc lập của review và phá triết lý sản phẩm.

## 13. Các file nguồn quan trọng

- `../README.md`: mô tả ngắn gọn workflow hiện tại.
- `../prompt/kich ban youtube.txt`: nguyên tắc dành cho Claude Author.
- `../prompt/các tiêu chí kịch bản.txt`: nguyên tắc dành cho Codex Reviewer.
- `../src/domain.ts`: schema và validation.
- `../src/prompts.ts`: prompt compiler.
- `../src/orchestrator.ts`: state machine và agent loop.
- `../src/store.ts`: run workspace và artifact persistence.
- `../src/library.ts`: accepted Article Library.
- `../src/pane-runner.ts`: provider process runner.
- `../src-tauri/src/lib.rs`: engine bridge của desktop shell.
- `../src-tauri/src/terminal.rs`: PTY/direct-pipe process boundary.
- `../../docs/product/writer-room.md`: product contract.
- `../../docs/decisions/0040-writer-room-two-agent-hard-gate-loop.md`: quyết
  định chuyển sang workflow hai-agent.
