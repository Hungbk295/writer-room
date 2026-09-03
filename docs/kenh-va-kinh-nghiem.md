# Kênh & kinh nghiệm trong Writer Room

## Goal — mục tiêu cần đạt

Người dùng là writer cho nhiều **kênh xuất bản**, chẳng hạn kênh tài chính và kênh lịch sử.
Mỗi kênh phải có identity, kinh nghiệm biên tập và quy trình riêng để bài sau dùng lại được,
nhưng không được trộn khẩu vị giữa các kênh.

Mục tiêu cụ thể:

1. Trước mỗi lượt viết, người dùng chọn rõ kênh xuất bản đang làm.
2. Mỗi kênh có một nơi ngắn gọn để lưu quyết định biên tập đã được con người xác nhận.
3. Sau một bài hoàn chỉnh, agent có thể rút kinh nghiệm nhưng không được tự biến đề xuất
   thành luật của kênh.
4. Một workflow tốt có thể được lưu thành `SKILL.md` và dùng lại ở các bài sau.
5. Kinh nghiệm và quy trình phải nằm trong Writer Room để Codex, Claude, Grok hoặc Agy do
   Writer Room chạy đều sử dụng được; không phụ thuộc Hermes.
6. Evidence, transcript, Source Pack và claim vẫn thuộc pipeline research hiện có. Sổ tay
   biên tập không được dùng để hợp thức hóa dữ kiện.
7. Thiết kế phải file-first, dễ sao lưu/chuyển máy và không tạo Writer database hay memory
   platform mới.

Luồng đích:

```text
Hồ sơ kênh
  → Sổ tay biên tập được pin khi Save bài
  → WRITE đọc sổ tay + quy trình mặc định
  → Bài DONE có thể chạy Tổng kết sau bài
  → Người viết duyệt hoặc bỏ qua từng đề xuất
```

## Implementation — phần đã triển khai

### 1. Hồ sơ kênh

- Thêm màn hình **Kênh & kinh nghiệm** và route `/channels`.
- Cho phép tạo/sửa Hồ sơ kênh thủ công, gồm mã kênh, tên, chủ đề, khán giả, YouTube ID của
  chính mình và các mặc định General Pack, Formula, style restyle, quy trình.
- Cài mới với 0 hồ sơ là hợp lệ. App không tự lấy style, topic Spy hoặc kênh đối thủ để tạo
  Hồ sơ kênh.
- Writer v2 mới bắt buộc có `channelId` khi Save configuration và khi tạo run/room.
- Chọn Hồ sơ kênh trong Writer v2 sẽ điền các giá trị mặc định tương ứng.

### 2. Sổ tay biên tập

- Mỗi Hồ sơ kênh có `editorial.md`, chỉnh sửa trực tiếp trong giao diện.
- Khi Save configuration, Writer pin `editorialHash` vào run.
- Nội dung sổ tay chỉ được stage vào bước WRITE, không xuất hiện trong STUDY và không được
  coi là nguồn facts.
- Nếu sổ tay bị sửa giữa run, pipeline dừng với `EDITORIAL_CHANGED` thay vì âm thầm dùng
  phiên bản mới.
- Lưu sổ tay dùng optimistic hash để tránh một cửa sổ cũ ghi đè thay đổi mới hơn.

### 3. Tổng kết sau bài

- Thêm nút **Tổng kết sau bài** cho run ở trạng thái `DONE`.
- Editor agent đọc bài hoàn chỉnh, gate, defect và sổ tay hiện tại để đề xuất 1–3 bài học:
  `KEEP`, `AVOID` hoặc `TRY`.
- Kết quả được lưu trong lịch sử run và append vào `inbox.md`; agent không có đường ghi trực
  tiếp vào `editorial.md`.
- Trong màn hình **Kênh & kinh nghiệm**, người dùng có thể **Duyệt vào sổ tay** hoặc
  **Bỏ qua** từng đề xuất.
- Có recovery cho lượt tổng kết bị gián đoạn khi daemon khởi động lại.

### 4. Quy trình dùng lại

- Thêm giao diện tạo/sửa quy trình gồm mã, mô tả kích hoạt và hướng dẫn Markdown.
- Mỗi quy trình được lưu theo hình dạng native Codex skill tại
  `.agents/skills/<procedureId>/SKILL.md`.
- Hồ sơ kênh có thể chọn một quy trình mặc định.
- Writer pin `procedureHash` và chỉ stage quy trình được chọn vào WRITE.
- Nếu skill đổi giữa run, pipeline dừng với `PROCEDURE_CHANGED`.

### 5. API và tích hợp Writer v2

Đã bổ sung API cho:

- danh sách/tạo/sửa Hồ sơ kênh;
- đọc/lưu Sổ tay biên tập;
- thêm, duyệt và bỏ qua kinh nghiệm chờ;
- danh sách/tạo/sửa Quy trình dùng lại;
- khởi chạy Tổng kết sau bài cho Writer v2.

Run JSON mới lưu `channelId`, các hash đã pin, trạng thái tổng kết, kết quả tổng kết và lỗi
nếu có. Run lịch sử cũ vẫn đọc được để giữ tương thích ngược.

### 6. Ranh giới với Hermes và MCP

- Hermes không được thêm vào luồng viết và không phải dependency của bốn tính năng này.
- Codex/Claude/Grok/Agy do Writer Room launch tiếp tục gọi Spy, Team và General Pack MCP
  trực tiếp như trước.
- Không thêm MCP mới, không gộp proxy với workspace MCP và không thay đổi topology hiện có.
- Hermes workspace vẫn chỉ dành cho saga cross-app nếu sau này thực sự cần điều phối
  Writer Room sang DNA/Cook.

### 7. Kiểm chứng đã chạy

- Daemon: 391 test pass.
- Web: 19 test pass.
- TypeScript typecheck: pass.
- Production web build: pass.
- `SKILL.md` sinh ra đã qua validator chuẩn Codex.

## Hướng dẫn sử dụng

### 1. Hồ sơ kênh

Vào **Kênh & kinh nghiệm → Tạo Hồ sơ kênh**. Mỗi kênh nằm tại:

```text
writer-room-data/channels/<channelId>/
  channel.json
  editorial.md
  inbox.md
```

`channelId` là slug ổn định, ví dụ `tai-chinh` hoặc `lich-su`. Đây là identity của kênh
đang xuất bản, không phải `topicId` của Spy, YouTube channel ID của đối thủ hay tên file
style. Cài mới với 0 hồ sơ là trạng thái hợp lệ; app không tự biến style/kênh đối thủ thành
kênh của người dùng.

Hồ sơ có thể đặt mặc định cho audience, General Pack, Formula, style restyle và một quy
trình dùng lại. Bài Writer v2 mới phải chọn Hồ sơ kênh trước khi Save/Run.

### 2. Sổ tay biên tập

`editorial.md` là source of truth do người viết duyệt. Nó chứa quyết định bền vững như:

- khán giả, lập trường và ưu tiên của kênh;
- cách xử lý claim, ví dụ và lời kêu gọi hành động;
- điều cấm và bài học đã chứng minh qua nhiều bài.

Writer chỉ đọc sổ tay ở **WRITE**, không đưa nó vào STUDY và không coi nó là nguồn dữ kiện.
Khi Save configuration, run pin `editorialHash`. Nếu file đổi trước WRITE, run dừng với
`EDITORIAL_CHANGED`; hãy tạo/Save lại bài để dùng bản mới.

### 3. Tổng kết sau bài

Khi run đã `DONE`, bấm **Tổng kết sau bài**. Editor agent đọc bài hoàn chỉnh, kết quả gate,
defect và sổ tay hiện tại rồi đề xuất tối đa ba điều:

- `KEEP` — nên giữ;
- `AVOID` — nên tránh;
- `TRY` — nên thử ở bài sau.

Đề xuất được lưu trong lịch sử run và append vào `inbox.md`. Agent không sửa `editorial.md`.
Vào **Kênh & kinh nghiệm**, đọc từng đề xuất rồi bấm **Duyệt vào sổ tay** nếu nó thực sự bền
vững, hoặc **Bỏ qua** để dọn đề xuất không phù hợp. Đây là human gate duy nhất của vòng học.

### 4. Quy trình dùng lại

Quy trình được lưu theo đúng hình dạng Codex skill:

```text
writer-room-data/.agents/skills/<procedureId>/SKILL.md
```

Mỗi skill có `name`, `description` nói rõ khi nào dùng và phần hướng dẫn Markdown. Tạo/sửa
trực tiếp trong **Kênh & kinh nghiệm → Quy trình dùng lại**, rồi chọn nó làm quy trình mặc
định trong Hồ sơ kênh. Run sẽ pin `procedureHash` và stage nội dung vào WRITE; thay đổi giữa
run bị từ chối tương tự sổ tay.

Theo [Codex Skills](https://developers.openai.com/codex/skills/), `.agents/skills` là vị trí
project-scope chuẩn và mỗi skill là một thư mục có `SKILL.md`. Writer Room còn stage skill
được chọn vào input WRITE để pipeline chạy ổn định cả khi data root nằm ngoài source repo.

## Ranh giới dữ liệu

| Dữ liệu | Nơi lưu | Vai trò |
|---|---|---|
| Kênh xuất bản | `channels/<id>/channel.json` | Identity + defaults |
| Kinh nghiệm đã duyệt | `channels/<id>/editorial.md` | Chính sách editorial cho bài sau |
| Kinh nghiệm chờ duyệt | `channels/<id>/inbox.md` | Proposal, chưa có hiệu lực |
| Quy trình | `.agents/skills/<id>/SKILL.md` | Cách làm có thể dùng lại |
| Dữ kiện | Source Pack / facts ledger | Nguồn duy nhất của claim |
| Giọng kênh | `channel-styles/*.md` | Restyle ngoài pipeline |
| Lịch sử bài | `writer/runs-v2/*.json` | Run, gate, defect, tổng kết |

Hermes không tham gia luồng này. Codex/Claude/Grok/Agy do Writer Room launch vẫn gọi MCP
trực tiếp như trước; bốn tính năng trên không thêm MCP và không đổi topology hiện tại.
