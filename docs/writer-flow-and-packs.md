# Writer v2 — Luồng và các pack

> Bản chuẩn đọc nhanh · 2026-09-07 · Source `375d530` · Daemon đang chạy `04916e6`, chưa nạp 11 commit mới.
> Mỗi pack trả lời đúng một câu hỏi. Pack nào trả lời câu của pack khác là lỗi thiết kế.

## 1. Luồng

```text
Người chọn hook ─────────────────────────────── đọc: Hook library
   │
   ▼
STUDY   (1 call)                                đọc: Topic pack; bảng định nghĩa Mode pack
        nguồn → ledger quote nguyên văn + outline (khuôn, mỗi beat có mode + phép lật + vật quen)
        viết kết trước rồi đi ngược; không chép chuỗi mode của nguồn
   │
   ▼
WRITE   (1 call)                                đọc: outline + ledger, Mode pack, General pack,
        script + khai lối mode và cử chỉ đã dùng        Human pack, Sổ tay biên tập (+ Persona nếu duyệt)
   │
   ▼
CHECK   gate (code): số / tên / tiền phải có trong ledger; số tự tính phải đánh dấu giả định
        editor (agent khác, context mới): 16 mục, gồm câu mở, đúng mode, hai beat cùng nhịp,
        cử chỉ có thật hay giả khiêm tốn
   │
   ├─ sạch ────────────────────────────────► DONE
   ├─ lỗi nhỏ, chưa sửa ────────────────► REPAIR 1 lần (đọc Mode pack, Human pack) → CHECK lại
   └─ bịa / ngữ nghĩa / sửa vẫn lỗi ────► DỪNG, trả note cho người
   │
   ▼ (tuỳ chọn, người bấm sau DONE)
CHANNEL STYLE  (stage `restyle-v1`)             đọc: Channel style file
        viết lại lần cuối theo đặc trưng kênh, không đổi fact, không có gate
```

Tối đa 5 model call một run, 6 nếu có REPAIR. Hook clarify và suggest là 2 call riêng trước run.
Không có retry ẩn (`maxContentRetries: 0` ở cả 4 stage).

Người vận hành có ba việc: chọn hook, chờ, đọc script. Cửa sổ app phải mở và ở foreground trong
lúc run, vì app mới là thứ mở pane cho agent; restart daemon thì phải Cmd+R app.

## 2. Các pack đi vào run

| # | Pack | File | Trả lời câu hỏi | Stage đọc | Thiếu thì | Trạng thái |
|---|---|---|---|---|---|---|
| 1 | Topic pack | do Spy tạo, chọn qua UI | **Sự thật là gì.** Nguồn duy nhất của ledger và của gate | STUDY | Không chạy được | Có 7 pack, mỗi pack 4–5 video, là transcript ASR |
| 2 | Hook library | `hook-libraries/anh-ba-ong-chu.md` | **Mở bài kiểu gì.** 6 kiểu hook, tần suất theo chủ đề, chưng từ ~200 kịch bản đối thủ | Hook suggest | Không gợi ý được hook | v1, 68 dòng |
| 3 | Mode pack | `writer/mode-pack.md` | **Một beat được chơi bằng hình thức nào.** 6 mode, 6 phép lật, 3 khuôn; 77 quote nguyên văn từ Hiếu TV, Anh Ba, script kênh; ví dụ dở từ bản nháp AI | STUDY thấy bảng định nghĩa; WRITE, REPAIR đọc cả file | Fail run | v2, 936 dòng, `dfcc945` |
| 4 | General pack | `general-packs/hieu-tv.md` | **Kênh này là ai.** 7 Taste DNA, Ranh giới kênh, bảng 8 nhãn ví dụ, 4 dạng payoff | WRITE | Post không READY | v3, 122 dòng, `2a32b5a`. Mượn từ Hiếu TV, dự kiến về hưu ở SDD 008 |
| 5 | Human pack | `writer/human-pack.md` | **Người kể lộ mình đang nghĩ bằng cử chỉ nào.** 8 cử chỉ, mỗi cái có quote, khi không dùng, cần lập trường gì; tối đa 3 mỗi bài | WRITE, REPAIR | Run vẫn chạy, không cử chỉ | v1, 273 dòng, `f85459e` + loader `b0de17b` |
| 6 | Persona pack | `writer/persona-pack.md` | **Người kể tin gì, đã trải gì.** 8 stance, 8 experience | WRITE, gate | Run chạy không persona | 0/16 duyệt nên đang tắt; mục 3 trùng human pack, sẽ cắt |
| 7 | Sổ tay biên tập | `channels/soi-tai-chinh/editorial.md` | **Kênh đã học được gì.** KEEP / AVOID / TRY do chủ kênh duyệt từ postmortem | WRITE, postmortem | Không READY | 14 dòng, của kênh |

Ngoài run:

| Pack | File | Vai trò | Ghi chú |
|---|---|---|---|
| Channel style | `channel-styles/soi-tai-chinh.md`, `nhan-vat-xuyen-suot.md`, `human-moves.md` | Restyle lần cuối sau DONE, do người bấm | Đang dày 130–156 dòng, lấn sang mode và human pack; sẽ làm mỏng còn xưng hô, số viết chữ, disclaimer, câu chào/kết, từ cấm |
| Formula | `training/formulas/*.json` | Đã bỏ khỏi Writer (`04916e6`) | Còn dùng ở Training Lab |

## 3. Cách nhớ vai

Từ trái sang phải là từ **đúng** tới **người**:

```
Topic pack ─ Hook library ─ Mode pack ─ General pack ─ Human pack ─ Persona pack ─ Channel style
 sự thật      mở bài        hình thức    khẩu vị        cử chỉ       lập trường     đặc trưng kênh
```

- Fact chỉ đến từ Topic pack qua ledger. Không pack nào khác cấp quyền nêu số hay tên.
- Hình thức đến từ Mode pack. Cử chỉ đến từ Human pack. Cử chỉ chỉ thật khi có lập trường
  (Persona) hoặc giới hạn thật (ledger thiếu) đứng sau. Không có hai thứ đó thì WRITE không được
  dùng cử chỉ.
- Khẩu vị và đặc trưng kênh: General pack đang mượn của Hiếu TV, Channel style và Sổ tay là của
  kênh. Khi Persona có stance được duyệt, bản sắc kênh chuyển hẳn về Persona + Sổ tay + Channel
  style, General pack về hưu.

## 4. Chuỗi bảo đảm chống bịa (đã kiểm bằng run T4 ngày 2026-09-07)

1. Hook agent không nêu số không có trong pack.
2. STUDY không đưa vào ledger thứ không có trong pack.
3. WRITE chỉ được dùng số trong ledger; số tự tính phải có phép tính lộ ra và marker giả định.
4. Gate so từng số, tên, tiền với ledger; hiểu "26 ph" của ASR là 26%.
5. Editor tính lại mọi phép tính và bắt suy diễn nhân quả, lệch đơn vị.

Run T4 nhét "Đại học Fulbright 2025, 73%" vào title và brief: không câu nào lọt tới script.

## 5. Trạng thái và việc kế tiếp

| Việc | Trạng thái |
|---|---|
| Luồng chính chạy end-to-end | Đạt: 3 run đi hết luồng (baseline DONE, post-006 và T4 FAILED_GATE đúng luật) |
| Bộ pack đủ vai | Đạt về file; chưa có run DONE nào trên bộ đầy đủ |
| Restart daemon + Cmd+R app để nạp 11 commit | **Chờ chủ kênh** |
| Run lại post-006 trên bộ đầy đủ, so với baseline `798eeb53` | Sau restart |
| Chủ kênh đọc và trả lời 5 câu T5 | Sau run |
| Chủ kênh duyệt 3 stance persona | Điều kiện để bản sắc kênh không còn mượn |
| SDD 008: cắt persona mục 3, channel style mỏng, general pack về hưu | Sau T5 |

Chi tiết: `docs/plans/writer-main-loop-plan.md` (việc và nhật ký),
`docs/specs/006-writer-beat-grammar/`, `docs/specs/007-writer-human-pack/`,
`docs/plans/writer-packs-v2-plan.md`. Bãi đỗ và quyết định cắt: `docs/plans/writer-v2-status.md` §0.
