# Plan — Mode pack v2 và General pack v3

> Tạo 2026-09-06 · Nối tiếp SDD 006 · Quyết định của chủ kênh: "làm tròn và đầy đủ mode pack, general pack".
> Điều phối: Claude (lead); thực hiện: teammate Sonnet theo lane. Chỉ sửa file dữ liệu dưới
> `writer-room-data/` (gitignored, **`git add -f`**), không sửa code, không restart daemon.

## Vì sao

Sau SDD 006, hai file trả lời hai câu hỏi khác nhau:

| File | Câu hỏi | Ai đọc |
|---|---|---|
| `writer/mode-pack.md` | một beat được chơi bằng hình thức nào, cú lật nào | WRITE, REPAIR |
| `general-packs/hieu-tv.md` | kênh này là ai: khẩu vị, ranh giới, nhãn ví dụ | WRITE |

Mode pack v1 (`e3f3d0d`) còn mỏng: 30 quote, tỷ lệ trích 41%, `canh` và `doi-y` chỉ 2 lối, chỉ 7
transcript được dùng. General pack v2 có 469 dòng nhưng >80% là 5 entry mổ từng video theo
chuỗi hook → beat → payoff; đó là "chuỗi của nguồn" mà SDD 006 cấm chép, và nó nặng prompt WRITE.

## Lane E — Mode pack v2

Nguồn mở rộng: toàn bộ 30 transcript Hiếu TV (`spy/hieu-tv-transcripts/`), transcript Anh Ba
trong ndjson dna-spy (mọi row có transcript, không chỉ bài xe dịch vụ), 8 script DONE của kênh
trong `writer/runs-v2/*.json` (`finalScript`), hai bản restyle tay `exports/human-moves-ab-*.md`.

Việc:
1. Mỗi mode đủ **3 lối**, mỗi lối ≥ 1 quote, và ít nhất một lối lấy từ nguồn không phải Hiếu TV
   (Anh Ba hoặc script DONE của kênh) để mode không mang giọng một người.
2. Mỗi phép lật ≥ **2 quote** từ 2 video khác nhau.
3. Mỗi khuôn có mục "Cách chạy qua 5 beat" ngắn (một dòng mỗi beat, nói vật/sợi dây quay lại thế nào).
4. Ví dụ dở: thêm từ chính script DONE của kênh (bài `d638638b`, `9df94045` có bản restyle để so),
   không chỉ từ bản nháp dna-spy.
5. Tỷ lệ chữ trích ≥ 50% (đo bằng word count trong blockquote / tổng).
6. Giữ nguyên 15 heading id (parser `mode-pack.ts` phụ thuộc), bump `<!-- version: 2 -->`.
7. Grep-verify mọi quote là substring nguyên văn của nguồn ghi trong ngoặc.

## Lane F — General pack v3

Việc:
1. Giữ và làm rõ **Taste DNA** (7 điều), mỗi điều ≥ 2 quote từ ≥ 2 video; thêm điều thứ 8 nếu
   đọc 30 transcript thấy một bất biến chưa ghi (phải có ≥ 3 video làm chứng, nếu không thì không thêm).
2. Gộp 5 mục "Ranh giới" và 5 "Không làm" thành **một mục Ranh giới kênh** (điều kênh cố tình
   không làm), mỗi dòng có quote chứng minh.
3. Giữ **bảng nhãn nguồn gốc ví dụ** (8 tag) nguyên văn.
4. Thêm mục **Payoff kênh**: 3–4 dạng kết mà kênh dùng (hạ thành câu hỏi làm được, quay lại ẩn dụ,
   từ chối ép leo bậc...), mỗi dạng 1 quote.
5. **Bỏ** 5 entry theo video và mục "Còn thiếu 25 entry". Trước khi bỏ, kiểm mọi quote trong 5 entry
   đã có mặt ở mode pack v2 hoặc Taste DNA; quote hay chưa có chỗ thì đưa vào mode pack (báo lead,
   không tự sửa mode pack, ghi danh sách vào báo cáo).
6. Mục tiêu ≤ 150 dòng; bump `<!-- version: 3 -->`. Không đổi tên file (kênh pin `hieu-tv.md`).
7. Lưu bản v2 cũ thành `general-packs/_archive/hieu-tv-v2.md` để không mất entry.

## Phụ thuộc và thứ tự

E và F chạy song song, nhưng F bước 5 cần đọc mode pack v2 của E để biết quote nào đã có chỗ.
Cách làm: F soạn xong phần 1–4 trước, chờ E commit, rồi làm bước 5 và báo danh sách quote mồ côi.
Lead duyệt cả hai rồi `git add -f` và commit. Sau commit, run kế tiếp sẽ dùng v2/v3 (hash mới),
run post-006 đang chạy vẫn dùng bản đã stage.

## Lane G — Docs

Đồng bộ tài liệu Writer v2 với trạng thái thật sau SDD 006, chạy song song Lane E/F, chỉ sửa
markdown, không sửa code:

- `writer-v2-status.md` §0: cập nhật bảng "Bốn việc" (T1 xong, T3 baseline DONE, T4 chưa), thêm
  mục "T8 — SDD 006 đã land" liệt kê 4 commit và điều đổi ở luồng.
- `writer-v2-status.md` §2: thêm số liệu đo lại tại `04916e6` (writer 257 pass, daemon 434 pass,
  typecheck/ui:build sạch) và số liệu run baseline `798eeb53` (21 phút 10 giây, gate/editor/REPAIR).
- `writer-main-loop-plan.md` T5: đổi bảng 5 câu thành 3 cột baseline/post-006 để chủ kênh điền;
  ghi nhật ký run post-006 `b4deeb0f` đang chạy.
- `docs/specs/006-writer-beat-grammar/solution-design.md`: thêm §10 Trạng thái triển khai và
  quyết định bổ sung §2.7 về việc general pack thu gọn, entry theo video chuyển làm nguồn thô
  mode pack.
- `TODOS.md`: thêm khối phân loại hoãn/cắt cho TODO 1–10, 12–14 theo §0.

## Nghiệm thu

- `bun test packages/daemon/test/writer/mode-pack.test.ts` xanh với file thật.
- `bun -e` gọi `getGeneralPack('hieu-tv.md')` trả version 3, hash mới.
- Lead đọc tay: 3 quote ngẫu nhiên mỗi file grep đúng nguồn.
- Chủ kênh đọc Taste DNA và Ranh giới, xác nhận đúng khẩu vị kênh Sói Tài Chính đang mượn từ Hiếu TV.

## Nhật ký

| Ngày | Lane | Commit | Kết quả | Ghi chú |
|---|---|---|---|---|
| 2026-09-06 | plan | — | file này | |
| 2026-09-06 | G | — | Lane G soạn, chờ duyệt | docs only, chưa commit |
