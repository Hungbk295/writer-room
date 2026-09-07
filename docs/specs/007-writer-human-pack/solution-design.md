# SDD 007 — Human pack: cử chỉ của người kể, tách khỏi mode pack

> Tạo 2026-09-07 · Nối tiếp SDD 006 · Chủ kênh quyết định "tách file human-pack riêng".

## 1. Vấn đề

Mode pack trả lời "một beat được chơi bằng hình thức nào". Nhưng thứ làm người nghe tin có một
người thật đang nói không nằm ở hình thức beat; nó nằm ở những câu chen vào bất kỳ đâu, lộ ra
người kể đang nghĩ lúc nói: tự sửa, thừa nhận không biết, tự thu hẹp lời mình, cho người nghe
đường lùi. Bốn move cũ (`channel-styles/human-moves.md`) đã bị gộp vào mode pack thành mode
`doi-y`, `zoom-chu`, `cuc-tri`, `phan-bac`; điều đó đúng cho ba cái sau (chúng là hình thức beat)
nhưng làm mất lớp "cử chỉ" xuyên bài. Research 2026-09-07 trên 30 transcript Hiếu TV tìm thêm
4 cử chỉ có ≥5 video làm chứng.

Ranh giới: cử chỉ chỉ là động tác. Hướng của động tác đến từ persona (stance). Human pack không
chứa lập trường, không chứa tiểu sử, không cấp quyền fact.

## 2. Quyết định

1. File mới `writer-room-data/writer/human-pack.md` (gitignored, `git add -f`), version 1.
2. Nội dung: **8 cử chỉ**, mỗi cử chỉ một heading `## Cử chỉ: <id> — Tên`, id cố định:
   `lech-chuan` (lập trường lệch chuẩn có chủ đích), `duong-may` (đường may lộ), `khong-biet`
   (nói ra chỗ mình không biết), `rao-pham-vi` (rào chắn phạm vi trước khi đi qua), `cua-lui`
   (mở cửa lùi cho người nghe), `guong-soi` (người quen giấu tên làm gương soi), `zoom-chu-cau`
   (zoom một chữ ở tầm câu, không phải beat), `cuc-tri-cau` (đẩy cực trị trong một câu).
   Hai cử chỉ cuối là bản "tầm câu" của hai mode; giữ để WRITE có thể dùng ngắn mà không đổi mode
   của beat. Mỗi cử chỉ: hiệu ứng, ≥2 quote nguyên văn từ ≥2 video, **Khi nào KHÔNG dùng**,
   và **Cần lập trường gì** (một dòng: cử chỉ này chỉ thật khi có điều kiện nào; ví dụ
   `khong-biet` cần ledger thật sự thiếu, `lech-chuan` cần một stance đã duyệt hoặc chuẩn chung
   có trong ledger/pack).
3. Luật dùng ghi ở đầu file và nhắc trong prompt WRITE: **tối đa 3 cử chỉ mỗi bài, mỗi cử chỉ
   tối đa 1 lần**, không dùng ở beat cuối trừ `cua-lui`, không dùng để chữa lập luận yếu.
4. Loader `packages/daemon/src/writer/human-pack.ts`: `getHumanPack(dataDir)` → `{markdown, hash}`
   hoặc `null`; `validateHumanPack(markdown)` fail-closed khi thiếu bất kỳ heading nào trong 8 id.
5. Staging: WRITE và REPAIR nhận `input/human-pack.md`, hash vào `inputHashes`, envelope thêm
   `humanPack: {path, hash}`. Thiếu file → **không fail run** (khác mode pack): ghi warning trong
   envelope `humanPack: null` và WRITE chạy không cử chỉ. Lý do: human pack là gia vị, mode pack là
   khung; thiếu khung thì bài hỏng, thiếu gia vị thì bài nhạt.
6. Prompt WRITE: mục `## Human pack` nói rõ luật ở mục 3 và yêu cầu khai trong `outlineChanges`
   cử chỉ nào đã dùng ở câu nào. Prompt REPAIR: giữ cử chỉ đã có nếu không phải nguyên nhân defect.
7. Editor checklist thêm mục 16: "Cử chỉ người kể có thật không: chỗ 'tôi không chắc' có đúng là
   ledger thiếu, chỗ 'không dành cho tất cả' có thu hẹp thật, hay chỉ là dáng khiêm tốn cho có?
   Giả khiêm tốn là MEDIUM, trích câu."
8. `channel-styles/human-moves.md` giữ nguyên cho skill restyle; ghi ở đầu file rằng nguồn chuẩn
   của cử chỉ giờ là `writer/human-pack.md`.

## 3. Nghiệm thu

- Test loader/validator; test staging WRITE có `input/human-pack.md` và hash; test WRITE vẫn chạy
  khi thiếu file (envelope `humanPack: null`).
- `bun test packages/daemon/test/writer/` xanh, typecheck sạch.
- File human pack: 8 heading, mọi quote grep đúng nguồn, tỷ lệ trích ≥ 50%.
- Một run thật sau restart daemon: `outlineChanges` khai cử chỉ đã dùng; editor mục 16 không HIGH.
