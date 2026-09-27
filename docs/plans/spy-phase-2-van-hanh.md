# Spy Phase 2 — Kế hoạch vận hành vòng lặp

**Ngày:** 2026-09-19 · **Trạng thái:** đã chạy được, chờ lần chạy thứ hai
**Tiền đề:** [Báo cáo Spy POV Finance](../../writer-room-data/spy-sheet/bao-cao-pov-finance.md) · [Cơ chế vòng lặp](../../writer-room-data/spy-sheet/ke-hoach-vong-lap.md)
**Liên quan:** [spy-autoloop-plan.html](./spy-autoloop-plan.html) — bản thiết kế P0 cho Auto-Loop *trong sản phẩm*. Tài liệu này là phần **vận hành tạm thời bên ngoài**, chạy bằng script trên các tool MCP đang expose. Khi `spy_loop_tick` / `spy_loop_decide` được mở ra MCP và có topic thị trường Mỹ, vòng lặp này nên chuyển vào sản phẩm.

---

## Mục tiêu duy nhất

> Tìm ra **title nào đang có view ngay bây giờ**.

Mọi thành phần khác — danh sách kênh, keyword, phân tích tiêu đề, hook — chỉ phục vụ mục tiêu đó.

---

## 1 · Hiện trạng đã đo

| | |
|---|---|
| `follow_list` | 18 kênh — **11 active · 7 watch** |
| `snapshots` | 414 dòng (nền đã đặt) |
| `board_moving` | **0 dòng — chờ lần chạy thứ hai** |
| Chi phí mỗi lần chạy nhánh A | **~50 đơn vị general** = 0,17% ngân sách ngày |
| Quota còn | search 299/300 · general 29.978/30.000 |

Hệ thống đã chạy được. Thứ duy nhất còn thiếu là **thời gian trôi qua** — không gì thay thế được.

---

## 2 · Vì sao phải lặp

Vòng 1 và 2 chỉ có một snapshot, nên mọi chỉ số tốc độ là `view / tuổi` — trung bình luỹ kế. Nó trả lời *"đã tích được bao nhiêu"*, không trả lời *"đang chạy bao nhanh"*.

```
velocity_real = (view lần này − view lần trước) / số ngày giữa hai lần
heat          = velocity_real / (median_view_kênh / 30)
```

`heat = 5` → video đang chạy gấp 5 lần nhịp thường ngày của chính kênh đó.
**Chỉ tồn tại từ lần chạy thứ hai trở đi.**

---

## 3 · Hai nhánh

### Nhánh A — kênh đã follow · hằng ngày

```bash
python3 writer-room-data/spy-sheet/loop/run.py daily
```

Quét thẳng, không qua keyword. Mỗi kênh lấy 20 video mới nhất (`scan_limit=60`, `top_n=20`, đọc qua `spy_run_manifest`). Video cũ không còn tích view đáng kể nên không cần làm tươi.

### Nhánh B — keyword bắt kênh vãng lai · hằng tuần

```bash
python3 writer-room-data/spy-sheet/loop/run.py weekly
```

Dùng `spy_global_video_search` với `language=en`, `region=US` — **tool duy nhất ép được thị trường Mỹ**, né bug cấu hình market `vi` của daemon.

Tần suất thấp có lý do đo được: **hiệu suất đường keyword là 3,4%** (4 kênh dùng được / 117 kênh tìm ra). Chạy hằng ngày là lãng phí công duyệt.

---

## 4 · Ba giai đoạn triển khai

### Giai đoạn 1 — ngày mai · lần chạy thứ hai

Một lệnh `daily`. Board đầu tiên xuất hiện. Đây là khoảnh khắc hệ thống bắt đầu có giá trị.

### Giai đoạn 2 — tuần 1 · nhánh B lần đầu

Ra `inbox_channels.tsv`, duyệt theo luật thăng ở mục 5.

⚠️ **Lỗ đã biết:** `spy_global_video_search` **không trả `channelId`**. Đường vòng đã dựng: đoán handle từ tên kênh (`Old Money Luxury` → `@OldMoneyLuxury`) rồi `spy_channel_start` xác nhận. Tỉ lệ thành công đo được **3/4** — `Alastair` thất bại vì tên quá chung. Bước duyệt inbox vẫn cần người xác nhận handle.

Vì vậy `follow_list` khoá theo cột **`url`**, không phải `channel_id`.

### Giai đoạn 3 — tuần 2 trở đi · vòng kín

```
kênh follow → keyword → kênh mới → keyword mới → ...
```

Hằng tháng rút lại keyword từ tiêu đề kênh follow. Danh sách đổi thì keyword phải đổi theo, nếu không vài tháng nữa sẽ đi tìm bằng từ khoá của những kênh đã chết.

---

## 4b · Ràng buộc cứng: chỉ nhận tiếng Anh

Nghiên cứu nhắm thị trường Mỹ. **Mọi nội dung không phải tiếng Anh bị chặn tại tầng thu thập**,
không phải lọc ở tầng đọc — lọc tầng đọc thì lần refresh sau nó lại lọt vào.

Cài tại `writer-room-data/spy-sheet/langgate.py`, gắn vào **cả hai nhánh**:

```
Nhánh A — bỏ video trước khi ghi snapshot, in số bị chặn mỗi kênh
Nhánh B — bỏ video ngay khi nhận kết quả search, trước khi vào inbox
```

Bộ dò **không** dùng toàn bộ ký tự có dấu. `Bacardí`, `Spain's`, `Café` là tiếng Anh hợp lệ.
Chỉ dùng tập dấu chỉ có trong tiếng Việt (`ă ơ ư đ` + dấu hỏi/ngã/nặng dưới nguyên âm),
cộng danh sách từ tiếng Việt không dấu. Kiểm thử 9/9.

Dòng bị chặn vào `_quarantine_nonenglish.tsv` — **giữ lại, không xoá**, để đo được tỉ lệ ô nhiễm
của từng đường thu thập. Đã dọn 74 dòng từ vòng 2 (71 vi, 3 non-Latin).

**Keyword cũng phải qua cổng.** Cụm một từ chung chung (`has`, `really`, `everyone`, `started`)
tuy đạt ngưỡng ≥4 kênh nhưng đem đi search ra rác và tiêu phí slot. `weekly()` loại chúng trước
khi gọi API.

---

## 5 · Luật thăng và giáng

Đây là phần vòng 1–2 thiếu, và là lý do 7/15 kênh trong danh sách đã qua đỉnh mà không ai gỡ.

**Thăng** — đủ cả ba: ≥2 video long-form trong kết quả search · là faceless hoặc kể chuyện (không phải creator lộ mặt đã thành danh, không phải tin tức) · có ít nhất một video ≥3× median của chính kênh đó.

**Giáng:**

| Điều kiện | Hành động |
|---|---|
| Đứt gãy chế độ **xuống** (Pettitt, `break_ratio < 1`) | `active` → `watch` |
| Ở `watch` 30 ngày mà median không hồi | `watch` → `archive` |
| Không đăng video mới 60 ngày | `active` → `watch` |

Kênh `archive` **không xoá** — giữ nhãn để lần sau không tìm lại từ đầu.

---

## 6 · Lịch chạy

| Tần suất | Việc | Chi phí |
|---|---|---|
| Hằng ngày | nhánh A + dựng board | ~50 đơn vị |
| Hằng tuần | nhánh B, gom kênh mới | ~0 bucket search |
| Hằng tuần | duyệt inbox, áp luật thăng/giáng | 0 (người) |
| Hằng tháng | rút lại keyword từ tiêu đề kênh follow | 0 |
| Hằng quý | chạy lại phân tích title/hook trên corpus mới | ~700 đơn vị |

---

## 7 · Ba quyết định cần chủ dự án

**1. Ai chạy nhánh A hằng ngày?** Cron là đơn giản nhất, nhưng **daemon writer-room phải đang chạy** — daemon tắt thì job fail im lặng. Cần kiểm `spy_quota_status` trước, thất bại thì báo. Hoặc để một agent chạy `/loop`.

**2. 7 kênh `watch` có quét không?** Hiện không. Nhưng chúng vẫn ra video, và mục tiêu là *tìm title đang có view* — kênh đang suy vẫn có thể ra một video bùng. Chi phí chỉ ~5 đơn vị/kênh. **Đề xuất: vẫn quét, nhưng đánh dấu.**

**3. Cửa sổ đo bao lâu?** 1 lần/ngày → cửa sổ 24h. Chi phí rẻ tới mức 3 lần/ngày cũng chỉ 0,5% quota, và cửa sổ 8h bắt video bùng sớm hơn — đổi lại nhiễu nhiều hơn.

---

## 8 · Chưa làm — nói rõ để không tưởng là đã có

**Luật giáng chưa tự động.** Mới gắn nhãn thủ công một lần lúc bootstrap. `run.py` chưa có code tự chuyển `active` → `watch` khi 60 ngày không đăng, hay `watch` → `archive` sau 30 ngày không hồi. Cần vài tuần lịch sử thì luật đó mới có nghĩa, nhưng code thì chưa viết.

**Board chưa gắn đặc trưng tiêu đề.** Chưa nối `dollar_amount`, `second_person_you`, `retire_word` vào từng dòng board. Gắn vào thì mỗi dòng sẽ tự nói *"video này đang bùng, và nó có 2/3 đặc trưng đã chứng minh"* — đó mới là mặt ra quyết định hoàn chỉnh.

---

## 9 · Ba cái bẫy khi đọc board

1. **Lần chạy đầu không có board.** Cần ≥2 snapshot ở hai ngày khác nhau.
2. **Video 1–2 ngày tuổi có `heat` ảo cao** — đang trong launch spike chưa suy giảm. Đọc board phải kèm cột `age_days`; cân nhắc lọc `age_days >= 3` khi ra quyết định sản xuất.
3. **`top_n` bị chặn 1..20.** `scan_limit` là số video *quét*, `top_n` là số *trả về qua manifest*. Muốn hơn 20 video/kênh/lần phải gọi nhiều lần với `published_before` khác nhau.

---

## 10 · Đường nâng cấp vào sản phẩm

Repo đã có `spy_loop_tick`, `spy_loop_decide`, `spy_loop_inbox`, `spy_loop_report` và bảng `topics` với `daily_search_budget` — đúng tính năng này, theo thiết kế ở [spy-autoloop-plan.html](./spy-autoloop-plan.html).

Hai chỗ chặn:

1. `spy_loop_tick` và `spy_loop_decide` **không expose qua HTTP MCP** (chỉ 31/56 tool được expose)
2. Chưa có topic cho thị trường Mỹ — topic duy nhất là `bay-tra-gop` (tiếng Việt), và `spy_loop_status` trả `null` nghĩa là loop chưa từng chạy

Mở hai tool đó và tạo topic `pov-finance-us` với `market=en` thì vòng lặp nên chuyển vào sản phẩm: sẵn ngân sách quota, inbox duyệt kênh, báo cáo ngày.

**Kèm theo, ba bug cấu hình phải sửa trước khi tin bất kỳ điểm số nào của Spy cho thị trường Mỹ:**

| | Vị trí | Hậu quả |
|---|---|---|
| 1 | `ytdlp.ts:172` — `SUBTITLE_LANGUAGE_PREFERENCE = ['vi','en']` | transcript kênh Mỹ là bản dịch máy, WPM tăng ảo 44–48% |
| 2 | `niche.ts:209` — cộng +10 khi country khớp regionCode; daemon chạy market `vi` | kênh tài chính Mỹ bị chấm 0 điểm hợp niche |
| 3 | `spy_title_patterns` trộn hai nền chế độ | `old money` cho 143x, số đúng là 2,34x |

Sửa đúng cách là biến chúng thành **tham số theo topic**, không hardcode — repo còn phục vụ topic tiếng Việt `bay-tra-gop` nên không được đảo cứng thành `['en','vi']`.

---

## Tệp liên quan

```
writer-room-data/spy-sheet/
├── loop/run.py              daily | weekly | board
├── loop/snapshots.tsv       lịch sử view — nền của mọi phép vận tốc, chỉ ghi thêm
├── loop/board_moving.tsv    ĐẦU RA CHÍNH — title đang có view, xếp theo heat
├── loop/follow_list.tsv     18 kênh + status, tự thăng/giáng
├── loop/inbox_channels.tsv  kênh mới chờ duyệt từ nhánh B
├── bao-cao-pov-finance.md   kết luận vòng 1–2
└── ke-hoach-vong-lap.md     chi tiết cơ chế
```

Sheet: [POV-UPDATE](https://docs.google.com/spreadsheets/d/1rI6mhh_-_dCwNSpTNqRZAJv7Y36BrrebR3nN95MM59Q) — 16 tab
