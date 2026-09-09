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

---

## 4. Bổ sung 2026-09-08 — gộp persona pack vào human pack

Chủ kênh quyết: quy về một mối. Human pack v2 là file duy nhất về người kể, persona pack về hưu.

**Vì sao.** Giữ hai file nghĩa là giữ hai cơ chế duyệt, hai loader, hai mục prompt cho cùng một
thứ: người kể. Persona 16 mục mà 0 mục được duyệt, và mục 3 (từ vựng cá nhân) trùng đúng ba cử chỉ
`rao-pham-vi`, `cua-lui`, `lech-chuan` của human pack.

**Cấu trúc file `writer/human-pack.md` v2 — ba vùng.**

| Vùng | Nội dung | Duyệt | Quyền cấp nguồn |
|---|---|---|---|
| Phần A — Cử chỉ | 8 cử chỉ, giữ nguyên văn v1 | Không cần | **Không**. Cử chỉ là động tác, không phải khẳng định |
| Phần B — Lập trường kênh | 8 stance chuyển từ persona `### 1.1–1.8` | `[ĐÃ DUYỆT]` | Có, khi đã duyệt |
| Phần C — Trải nghiệm phóng tác | 8 archetype chuyển từ persona `### A1–A8` | `[ĐÃ DUYỆT]` | Có, khi đã duyệt |

Mục 3 của persona bị cắt. File `writer/persona-pack.md` giữ trên đĩa, có dòng đầu ghi đã về hưu.

**Thay đổi code.**

1. `assertion-boundary.ts`: `filterApprovedPersonaMarkdown` → `filterApprovedNarratorMarkdown`, trả
   `FilteredNarratorPack` và **không bao giờ trả `null`**. Thêm khái niệm **craft region**: mọi thứ
   trước `## Phần B` luôn được nạp nguyên văn vào `markdown`, không parse thành entry, không bao giờ
   vào `citableText`. Đây là chỗ dễ hỏng nhất: để nguyên bộ lọc cũ thì 8 cử chỉ bị lọc mất vì không
   có marker duyệt.
2. `human-pack.ts`: thêm `getApprovedHumanPack` → `{path, hash, markdown, citableText,
   approvedStanceCount}`. `hash` lấy của bản đã lọc. `null` vẫn chỉ có nghĩa "không có file hoặc file
   rỗng" — **khác persona**, nơi 0 entry duyệt bị gộp vào nghĩa vắng mặt. Ở đây nửa craft là thật và
   vô điều kiện, nên 0 stance duyệt vẫn là một pack hợp lệ, chỉ là không trích được gì.
3. `writer-run-v2.ts`: xoá `persona-pack.ts`, bỏ `personaPackHash`, một mục prompt `## Human pack`
   thay hai mục, `repairRuleOneLines(hasApprovedStance)` truy về Phần B/C.
4. `deterministic-gate.ts`: `GateInput.personaCitableText` → `narratorCitableText`.
5. Editor: mục 16 tách làm hai — cử chỉ có làm việc thật không, và lập trường có cam kết một lựa chọn
   cụ thể không hay chỉ là câu rào hai mặt đội lốt lập trường. `EDIT_REVIEW_PROMPT_VERSION` lên v5.

**Hai bảo đảm có test ở tầng gate** (`deterministic-gate.test.ts`), vì sau khi gộp thì chính file
này vừa nuôi prompt vừa nuôi gate:

- số chỉ xuất hiện trong một entry **chưa duyệt** vẫn là `NUMBER_UNSOURCED`;
- số chỉ xuất hiện trong **quote ví dụ của một cử chỉ** vẫn là `NUMBER_UNSOURCED`.

**Nghiệm thu:** `bun test packages/daemon` 475 pass / 0 fail, typecheck sạch, 2026-09-08.
Còn nợ: chủ kênh duyệt vài stance ở Phần B thì nhóm cử chỉ cần lập trường mới mở khoá.
