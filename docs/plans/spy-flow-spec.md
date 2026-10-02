# Đặc tả luồng Spy — Data Analyst Edition

Ngày: 2026-09-27 · Nguồn: hỏi đáp chốt mục tiêu với owner.

## 0. Mục tiêu đã chốt

- Mở **1 kênh mới US/EN**, format **hybrid** (cốt truyện POV + số liệu thật kiểm chứng được).
- Chọn **1 trong 2–3 tệp khán giả** bằng spy — quyết định trên bằng chứng, không chọn trước.
- **Tiêu chí thắng:** tệp nào cho kênh nhỏ (<10K subs) sàn view cao nhất — "file chấp nhận người mới".
- Cadence sản xuất: 3–5 video/tuần, ~8 video probe/ngách trước khi chốt.
- Quota: không giới hạn cứng — owner thêm API key để rotate (`youtubeDataApiKeys` đã hỗ trợ multi-key).

## 1. Nhịp chạy

### Daily (mỗi ngày, tự động)
| Bước | Nội dung | Chi phí |
|---|---|---|
| D-snapshot | Quét uploads kênh active + refresh `videos.list` cho toàn bộ `topic_videos` đã lưu → `video_daily_views` | Rẻ (batch 50/call) |
| D-recheck | Re-check một vòng keyword xoay `last_checked_at` — mỗi ngày một phần danh sách, phủ hết keyword sau N ngày | Search |
| D-derive | Recompute baseline/outlier/gained24h, gợi ý pause_silent | 0 |
| D-report | Ghi `daily_reports` (summary_json + markdown) | 0 |

### Deep dive (thủ công — HITL)
Người chọn keyword/ngách trên board → bấm run. Một lần đào sâu gồm:
1. **Search mở rộng**: keyword gốc + biến thể (từ n-gram/suggest).
2. **Baseline kênh lạ**: quét ≤N kênh mới xuất hiện trong kết quả (logic W3).
3. **Comment mining**: ~100 comment/outlier video → lọc spam → quotes theo painpoint.
4. **Full metadata**: duration, thumbnail URL, title pattern của toàn bộ video trong kết quả.

### Dedup (registry trong DB)
- `video_id` + `keyword` + `first_seen` lưu DB; video đã spy **không kéo lại** tác vụ nặng (comment, baseline kênh, transcript).
- Views vẫn refresh hằng ngày (rẻ) để đo trend/gained24h.

## 2. Format lưu

- **DB = registry + dedup** (`topic_videos`, `video_daily_views`, `keyword_checks`, `topic_channels` — schema v14 đủ, không cần bảng mới cho bản này).
- **Export = file theo run**, lưu `writer-room-data/spy-runs/<topic>/<date>-<kind>.{json,md}`:
  - `.json` là **output chuẩn** (§2a) — UI đọc trực tiếp;
  - `.md` là bản đọc-người cùng nội dung (không excel).
- Board web đọc DB qua `/api/spy/dash/*` + đọc file báo cáo qua `/api/spy/board/formulas` (file mới nhất của topic).

## 2a. Định dạng output chuẩn — `reportType: "formula_verify"`, schema v1

Mọi output của một quá trình pipeline ghi **1 file JSON** vào `spy-runs/<topic>/` theo dạng:

```
{ reportType, schemaVersion: 1,
  meta: { topicId, runId, date, params, cost, yield, verifyRule },
  formulas: [...], keywordHealth: [...], modelChannels: [...], nextActions: [...] }
```

`formulas[]` — mỗi công thức title phân rã theo khung 5 slot **TRIGGER → VISIBLE BEHAVIOR → ECONOMIC CONTRADICTION → MONEY MECHANISM → TITLE**:

```
{ id: "F-A", skeleton: "How Are [GROUP] Affording [$ASSET] on [$INCOME]?",
  verdict: "live | weak | rejected",          // luật verify: ≥3 kênh độc lập, ≥1 kênh <10K subs
  repeatability: { channels_lt10k, channels_10_50k, channels_gt50k, proof },
  packaging: [ "các dạng title quan sát được" ],
  slots: {
    trigger:          { rotating: true,  desc, examples },   // điền từ trigger pool
    visible_behavior: { rotating, desc, examples },
    contradiction:    { rotating, desc, examples },
    mechanism:        { rotating: false, desc, examples },   // LÕI bền
    title_render:     "chuỗi render" | { desc, ... }
  },
  reject_reason: "vì sao loại (khi rejected)",
  evidence: [ { channel, subs, videos, topViews, note, lastSeen } ] }
```

Kèm: `keywordHealth[]` {term, medianViews, note} · `modelChannels[]` {channel, subs, why} · `nextActions[]` {type, from?, title?|item?}.

Các `reportType` khác (niche_verify, wave, ...) theo sau cũng dùng vỏ `{reportType, schemaVersion, meta}` chung này — phần thân thay theo loại. Board màn "4 · Công thức" render `formulas[]` trực tiếp từ JSON (slot xoay tô màu = chờ điền trigger).

## 3. Các cắt data bắt buộc (trong export & báo cáo)

| Cắt | Nội dung |
|---|---|
| Theo ngách | Mọi video + chỉ số trong 1 `group_key`: floor_<10K, supply (videos_found), outlier count |
| Theo kênh | Hồ sơ kênh: subs, baseline_median, video list, tỉ lệ outlier — so sánh tệp |
| Theo sóng | Video mới ≤7d vs nền cũ — hit mới & motif đang trỗi |
| Scorecard tệp | Bảng ngang 2–3 tệp: floor_<10K, % outlier từ kênh nhỏ, outliers_7d/28d, videos_found, kênh mới 30d |

Không bắt buộc (cắt để sau): theo keyword riêng lẻ, comment quotes (comment vẫn thu, nạp vào phân tích nội bộ).

## 4. Scorecard trong daily report (thay cho dashboard panel — panel làm sau)

Mỗi `group_key` một hàng trong `summary_json.nicheScoreboard` + section markdown:

- `floor_lt10k`: median `latest_views` của video thuộc kênh <10K subs (+ cỡ mẫu `n_small`)
- `pct_outliers_small`: % video outlier (≥ outlierMultiple) thuộc kênh <10K
- `outliers_7d` / `outliers_28d`: số outlier video publish trong 7/28 ngày
- `videos_found`: tổng video tìm qua keyword của ngách
- `new_channels_30d`: kênh của ngách `first_seen_at` trong 30 ngày
- Trend: diff `floor_lt10k`, `outliers_28d` vs daily report gần nhất trước đó

## 5. Quyết định phụ thuộc (chưa chốt — default kèm theo)

| # | Điểm | Default đề xuất |
|---|---|---|
| 1 | Số keyword re-check/ngày | Xoay hết danh sách active; size batch = ceil(active/7) để phủ trong 1 tuần |
| 2 | Biến thể keyword trong deep-dive | Tự sinh từ n-gram của outlier titles (logic weekly đã có) |
| 3 | Ngưỡng "kênh mới 30d" | `first_seen_at` trong 30 ngày quota-day |
| 4 | File export nằm ở | `writer-room-data/spy-runs/<topic>/<date>-<group>.md` |
| 5 | Kênh <10K subs xác định qua | `subscriber_count` từ `topic_channels`, fallback bảng `channels` cache |
