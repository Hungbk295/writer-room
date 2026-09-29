# Spy — Workflow data analyst, API, UI

Ngày: 2026-09-29 · Trạng thái: **ĐÃ DUYỆT phần nghiệp vụ (A–D); phần xây dựng (E–I) chờ duyệt**
Nguồn: hội thoại chốt từng bước với JC + 4 agent nghiên cứu + 2 agent tranh luận (2026-09-29).

---

## A. Mục tiêu

Mở 1 kênh faceless US/EN (POV story + số liệu thật). Chọn 1 trong 2–3 tệp khán giả.
**Tệp thắng = tệp mà kênh nhỏ (< 10K subs) có sàn view cao nhất.**

## B. Nghiệp vụ đã chốt

### B1. Ba loại lượt chạy

| Loại | Ai bấm | Làm gì | Không làm |
|---|---|---|---|
| **Theo dõi** | Máy, mỗi ngày | Cập nhật views video/kênh đã biết, quét video mới của kênh đang theo dõi | Search, comment, transcript |
| **Tìm mới** | Anh | Search keyword của một ngách; đo mọi kênh lạ tìm được | Comment, transcript |
| **Đào sâu** | Anh | Kéo comment + transcript cho các video anh chọn | Search mới |

### B2. Thẻ lượt chạy (mỗi lượt một thẻ)

Loại · Ngách · Ghi chú mục đích (tuỳ chọn; máy tự điền cho lượt tự động) · Ai bấm (anh/máy/agent) · Chạy trên gì · Thời gian + trạng thái · Tốn bao nhiêu · Kết quả (thấy bao nhiêu, mới bao nhiêu, kênh mới) · Bỏ qua gì + lý do.

Chi tiết bên trong: Theo dõi chỉ ghi tổng; Tìm mới ghi mỗi keyword một dòng; Đào sâu ghi mỗi video một dòng.

### B3. Chống trùng

| Việc | Luật |
|---|---|
| Search keyword | Đã search trong **3 ngày** → bỏ qua |
| Đo kênh lạ | Đã đo trong **14 ngày** → bỏ qua ✅ đã làm |
| Comment | Mỗi video kéo **1 lần** |
| Transcript | Đã có → bỏ qua |
| Views | Tối đa 1 lần/video/ngày (đã có) |
| Chạy chồng | Mỗi lúc 1 lượt tốn quota (đã có) |

Không có nút "chạy bất chấp". Mỗi lần bỏ qua ghi lý do lên thẻ.

### B4. Định nghĩa chỉ số (một chỗ duy nhất)

**Mức thường của kênh — 3 mức theo số video dài (≥ 5 phút) *khác* của kênh:**

| Số video dài khác | So với | Nhãn |
|---|---|---|
| ≥ 10 | Trung vị views các video khác của kênh (tối đa 30 video mới nhất) | ✅ Tin cậy |
| 3–9 | Trung vị views các video khác của kênh | ⚠️ Mẫu mỏng (n=…) |
| 0–2 | Sàn view kênh nhỏ của ngách | 🆕 Kênh quá mới — so với ngách |

"Khác" = bỏ chính video đang xét ra (quan trọng khi kênh ít video).

| Chỉ số | Định nghĩa |
|---|---|
| `outlier_x` | views ÷ mức thường (theo mức ở trên) |
| **Outlier** | `outlier_x` ≥ 3 **và** video ≥ 7 ngày tuổi **và** kênh không "chết" |
| Kênh chết | Có ≥ 3 video khác và trung vị < 500 views |
| **Đang lên** | Video < 7 ngày tuổi, xếp theo views tăng 24h |
| Kênh nhỏ | subs < 10K |
| Tuổi kênh | Ngày tạo kênh thật; bộ lọc "< 180 ngày", không loại cứng |
| **Sàn view kênh nhỏ** | Trung vị views video dài của kênh nhỏ trong ngách, **chỉ video lấy từ lượt quét uploads** (không từ kết quả search). Luôn kèm cỡ mẫu (n kênh, n video). **= Tiêu chí thắng** |
| **Độ lặp** | Số kênh nhỏ *khác nhau* có outlier trong 28 ngày, hiển thị tách ✅/⚠️/🆕. Gợi ý ≥ 3 |
| Tỉ lệ mới của keyword | Video chưa từng thấy ÷ tổng kết quả của lần search gần nhất |
| Kênh nhỏ đã đo | Số kênh nhỏ của ngách đã quét uploads — cỡ mẫu |

**Ngách của kênh/video:** ngách = `group_key` của keyword đầu tiên tìm ra kênh. Kênh đến từ setup/seed không có keyword → "chưa gán", anh gán tay.

Kênh toàn Shorts: không tính (khác định dạng).

### B5. Luật dừng (gợi ý, anh quyết)

Ngách "Đủ tin cậy" khi **≥ 20 kênh nhỏ đã đo** **và** thứ hạng các ngách theo sàn view **không đổi 2 tuần liên tiếp**. Chưa đủ → hiện "12/20 kênh".

### B6. Không làm

File báo cáo mỗi lượt chạy · ước tính doanh thu/RPM · search volume keyword · dự báo views · SQL tự do cho agent.

## C. Chuẩn tham chiếu (tóm tắt nghiên cứu)

- Công cụ YouTube (vidIQ, 1of10, ViewStats, Nexlev, OutlierKit, TubeBuddy): trụ cột là outlier = views ÷ mức thường của kênh, ngưỡng phổ biến 3x; không công cụ nào công bố công thức — Spy công bố.
- Nexlev: kênh < 50K subs, < 180 ngày tuổi; luật "outlier phải lặp ở nhiều kênh".
- Semrush/Ahrefs: khai báo tập theo dõi một lần → chụp định kỳ → chỉ hiện chênh lệch.
- dbt/Cube/Metabase MCP: chỉ số định nghĩa một lần; agent gọi hàm có tên, không SQL thô; mọi kết quả kèm thời điểm dữ liệu.
- Metabase/Few: mỗi màn một quyết định; số chính trên cùng → chia nhỏ → chi tiết; có nhãn độ tươi.
- Search YouTube xếp theo views → thiên về video thắng → sàn view chỉ từ quét uploads.

## D. Đã xong

| # | Việc | Trạng thái |
|---|---|---|
| D2 | Bước 2 (phần lõi) + bước 3: schema v16 (thẻ lượt chạy `type/note/group_key/triggered_by/n_new/n_skipped`, item `skipped_dedup` + lý do, `n_new` trên keyword_checks, `group_key` + `channel_published_at` trên kênh); luật 3 ngày; hit kênh ngoài cũng vào kho (để đếm "mới"); `spy/src/board/metrics.ts` (3 tier, bỏ video đang xét, luật 7 ngày, chết khi ≥3 video, sàn view, độ lặp) | ✅ Code + test xanh (spy 391, daemon 544) |
| D1 | Sửa lỗi lấy mẫu: sổ `measured_channels` (mọi kênh lạ đã quét, kể cả không outlier/chết/lottery), uploads ghi `outside_scan` tính baseline, đo lại sau 14 ngày, không outlier ở kênh chết. Setup cũng ghi kênh chết/lottery vào sổ | ✅ Code + test xanh (spy 376, daemon 542). **Chưa commit** |

Độ lệch còn lại, chấp nhận có ý thức: kênh nhỏ chỉ vào kho khi có ít nhất 1 video lọt top kết quả search. Mọi ngách chịu cùng độ lệch nên **so sánh giữa các ngách vẫn công bằng**. Khi khai báo ngách, thêm tay vài kênh nhỏ bình thường làm mốc.

---

## E. Kiến trúc xây dựng

```
                 ┌───────────────────────────────┐
  Loop/Run  ───▶ │ SQLite (spy.db)               │
  (ghi)          │  topic_videos, measured_...,  │
                 │  keyword_runs, ...            │
                 └──────────────┬────────────────┘
                                │ đọc
                 ┌──────────────▼────────────────┐
                 │ spy/src/board/  (MỘT chỗ)     │  ← định nghĩa chỉ số B4
                 │  metrics.ts  queries.ts       │
                 └──────┬───────────────┬────────┘
                        │               │
          HTTP /api/spy/board/*     MCP spy_board_*
                        │               │
                 Web: tab Board      Agent (Claude/Codex)
```

Luật: board và agent gọi **cùng một hàm** trong `spy/src/board/queries.ts` → luôn ra cùng số. Endpoint `/api/spy/dash/*` cũ giữ nguyên (không phá), board mới không dùng.

## F. API

### F1. Đọc — HTTP `GET /api/spy/board/*` và MCP tương ứng

Mọi response có khung chung:

```json
{ "data": [...], "dataAsOf": "2026-09-29T08:30:00Z", "runIds": ["..."],
  "sample": { "channels": 23, "videos": 410 }, "limit": 50, "truncated": false }
```

| HTTP | MCP | Tham số | Trả về (mỗi dòng) | Màn dùng |
|---|---|---|---|---|
| `GET /board/metrics` | `spy_board_metrics` | — | Bảng định nghĩa B4 (tên, công thức, ngưỡng hiện tại) | Tooltip mọi màn |
| `GET /board/scorecard` | `spy_board_scorecard` | `topic_id`, `history_days=28` | 1 dòng/ngách: sàn view kênh nhỏ, n kênh/n video, độ lặp (✅/⚠️/🆕), outlier 28d, kênh nhỏ đã đo, trạng thái luật dừng, chênh lệch so với 7 ngày trước; kèm chuỗi sàn view theo ngày | Màn 1 |
| `GET /board/videos` | `spy_board_videos` | `topic_id`, `niche`, `view=outliers\|rising\|all`, `small_only`, `channel_age_max_days`, `sort`, `limit` | video, thumbnail, kênh, subs, tuổi kênh, views, `outlier_x`, nhãn ✅/⚠️/🆕, tuổi video, views tăng 24h, keyword tìm ra | Màn 2 |
| `GET /board/channels` | `spy_board_channels` | `topic_id`, `niche`, `small_only`, `has_outlier`, `sort`, `limit` | kênh, subs, tuổi kênh, mức thường + nhãn, số outlier 28d, trạng thái (đang theo dõi / chờ duyệt / chỉ đo) | Màn 2 |
| `GET /board/keywords` | `spy_board_keywords` | `topic_id`, `niche` | keyword, trạng thái, lần chạy cuối, còn bị khoá 3 ngày không, số kết quả, tỉ lệ mới, số outlier tìm ra | Màn 3 |
| `GET /board/runs` | `spy_board_runs` | `topic_id`, `niche?`, `type?`, `limit` | thẻ lượt chạy (B2) | Màn 4 |
| `GET /board/runs/:id` | `spy_board_run_detail` | `run_id` | thẻ + từng dòng keyword/video, kể cả bỏ qua + lý do | Màn 4 |
| — | `spy_read_video_material` (đã có) | `video_id` | comment + transcript | Agent |

`limit` mặc định 50, tối đa 500. Agent chỉ đọc.

### F2. Ghi — HTTP (chỉ board gọi, người bấm)

| HTTP | Body | Việc |
|---|---|---|
| `POST /api/spy/keywords/run` (có, **sửa**) | + `note?`; `group` bắt buộc khi không truyền `termKeys` | Ghi thẻ đầy đủ; bỏ qua keyword đã search trong 3 ngày (`skipped_dedup`) |
| `POST /api/spy/deepdive` (**mới**) | `{topicId, videoIds[], note?}` | Tạo lượt Đào sâu; comment/transcript đã có → bỏ qua + lý do |
| `POST /api/spy/board/channels/niche` (**mới**) | `{topicId, channelIds[], niche}` | Gán ngách tay cho kênh "chưa gán" |
| `POST /api/spy/keywords/bulk`, `/decide` (có) | — | Giữ nguyên |
| Duyệt kênh theo dõi (có, `/api/spy/loop/decide`) | — | Giữ nguyên |

## G. UI — tab Board: thay 3 panel cũ bằng 4 màn

Thanh trên cùng mọi màn: chọn topic (đã có) · **nhãn độ tươi** ("Theo dõi: 15:30 hôm nay · Tìm mới gần nhất: 2 ngày trước") · điều hướng 4 màn.

**Màn 1 · Chọn tệp** — *tệp nào?*
- Mỗi ngách một thẻ cột: sàn view kênh nhỏ (số to) + mũi tên so với 7 ngày trước · cỡ mẫu · độ lặp "4 = 2✅ 1⚠️ 1🆕" · outlier 28d · trạng thái luật dừng ("Đủ tin cậy" / "12/20 kênh").
- Dưới: biểu đồ đường sàn view theo ngày, các ngách chồng lên nhau.
- Bấm thẻ ngách → Màn 2.

**Màn 2 · Ngách** — *học video/kênh nào, đào sâu gì?*
- Hàng trên: 4 số của ngách (như Màn 1).
- Tab con: **Outlier** | **Đang lên** | **Kênh nhỏ**.
- Outlier/Đang lên: lưới thẻ video (thumbnail, `4.2x` + nhãn, views, subs, tuổi video, tuổi kênh, keyword). Lọc: chỉ kênh nhỏ · kênh < 180 ngày. Tick chọn → nút **"Đào sâu N video"**.
- Kênh nhỏ: bảng kênh; nút **"Theo dõi"** (đưa vào danh sách chờ duyệt) và **"Gán ngách"**.
- Bấm video → biểu đồ views theo ngày (dùng lại `Sparkline`).

**Màn 3 · Keyword** — *keyword nào chạy tiếp?*
- Bảng keyword theo ngách: lần chạy cuối, khoá 3 ngày (🔒 còn 2 ngày), số kết quả, tỉ lệ mới, outlier tìm ra.
- Tick chọn → **"Tìm mới"**: ước tính số lượt search + quota còn → ô ghi chú mục đích → chạy → tiến độ từng keyword.
- Thêm keyword hàng loạt vào ngách.

**Màn 4 · Lượt chạy** — *có tốn quota vô ích không?*
- Danh sách thẻ lượt chạy, lọc theo loại/ngách. Bấm → chi tiết từng dòng + lý do bỏ qua.

Dùng lại: `KeywordHealth.tsx` + `RunLauncher.tsx` → Màn 3, `OutlierBoard.tsx` → Màn 2, `lib.tsx` (Sparkline, format). Tab Inbox/Follow/Reports giữ nguyên.

## H. Thứ tự triển khai

| Bước | Việc | Phụ thuộc | Nghiệm thu |
|---|---|---|---|
| **1** | Commit sửa lỗi lấy mẫu (D1); restart daemon + Cmd+R app | — | DB v15; lượt Tìm mới ghi `measured_channels` |
| **2 · Chỉ số** | Schema v16: `group_key` + `channel_published_at` trên `topic_channels`/`measured_channels`; lưu ngày tạo kênh (API đã trả, đang bị bỏ); `spy/src/board/metrics.ts`: 3 mức baseline (bỏ video đang xét), luật 7 ngày, chết khi ≥ 3 video, sàn view, độ lặp | 1 | Test bảng số: kênh 30/5/2 video ra đúng nhãn ✅/⚠️/🆕 và đúng `outlier_x`; sàn view khớp tính tay |
| **3 · Chống trùng + thẻ** | `keyword_runs` + `type`, `note`, `group_key`, `triggered_by`, `n_new`, `n_skipped`; `keyword_run_items` thêm trạng thái `skipped_dedup` + lý do (rebuild bảng); luật 3 ngày; `keyword_checks` + `n_new` | 1 | Chạy lại keyword trong 3 ngày → 0 lượt search, dòng ghi `skipped_dedup` kèm ngày search trước |
| **4 · API đọc** | `spy/src/board/queries.ts` (6 hàm) → HTTP `/api/spy/board/*` + MCP `spy_board_*` | 2, 3 | Cùng tham số → HTTP và MCP trả cùng `data`; mọi response có `dataAsOf`, `sample`; limit tối đa 500 |
| **5 · UI** | Tab Board 4 màn, dùng lại component cũ; `api.ts` thêm client `board*`; mock cho dev | 4 | Mỗi màn chỉ gọi endpoint của nó; số trên Màn 1 = `spy_board_scorecard`; không tràn ngang ở màn hẹp |
| **6 · Đào sâu** | `POST /api/spy/deepdive`, thẻ ghi vào sổ lượt chạy (I-1); nút ở Màn 2 | 4, 5 | Video đã có comment → không gọi API, ghi `skipped_dedup: comments_present` |
| **7 · Chạy thật** | Khai báo 2–3 ngách, mỗi ngách 10–30 keyword + vài kênh nhỏ bình thường làm mốc | 5 | Mỗi ngách đạt 20 kênh nhỏ đã đo; Màn 1 có trạng thái luật dừng |

Bước 2 và 3 độc lập, làm song song được.

## I. Cần JC quyết (phần xây dựng)

| # | Điểm | Đề xuất |
|---|---|---|
| I-1 | Lượt Đào sâu ghi thẻ ở đâu | Chung bảng `keyword_runs` với cột `type` — một sổ lượt chạy duy nhất, Màn 4 đọc một chỗ |
| I-2 | Kênh thuộc mấy ngách | 1 ngách (của keyword đầu tiên tìm ra), sửa tay được |
| I-3 | Agent có được bấm "Tìm mới"/"Đào sâu" không | Chưa — agent chỉ đọc; bấm là việc của anh |
| I-4 | Endpoint `/dash/*` cũ | Giữ (không phá), board mới không dùng; xoá sau pilot |
| I-5 | Panel cũ của tab Board | Thay hẳn bằng 4 màn (component dùng lại bên trong) |
