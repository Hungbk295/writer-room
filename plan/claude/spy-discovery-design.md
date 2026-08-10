---
title: "Spy Discovery — tìm kênh & video cùng niche ở quy mô lớn"
status: spec → đang implement
date: 2026-08-10
owner: Claude
supersedes: phần P1 (time-series) trong spy-mcp-vidiq-parity.md — xem §0
---

# Spy Discovery

Mục tiêu: research **rất nhiều** kênh đối thủ để tìm hướng đi nội dung. Chiến lược kênh của mình cố định trong một file, ít thay đổi. Hai đơn vị làm việc: **kênh** và **video**. Hoãn OAuth và sinh nội dung.

---

## 0. Sự thật đã đổi: quota phân tách từ 01/06/2026

Đây là lý do bản plan trước (ưu tiên time-series) không còn đúng thứ tự.

> *"Projects that enable the YouTube Data API have a default quota allocation of 100 `search.list` calls, 100 `videos.insert` calls, and **10,000 units per day combined for all other endpoints**."*
> — [determine_quota_cost](https://developers.google.com/youtube/v3/determine_quota_cost)

`search.list` **không còn tốn 100 unit** — nó có bucket riêng, 1 unit/call, **trần cứng 100 call/ngày**. Toàn bộ 10.000 unit giờ dành cho endpoint tra theo ID.

| Việc | Chi phí | Sức chứa/ngày |
|---|---|---|
| Quét toàn bộ kênh 500 video | ~21 unit | **~476 kênh** |
| `channelSections.list` → featured channels | 1 unit | ~10.000 kênh |
| `subscriptions.list` (nếu public) | 1 unit | ~10.000 kênh |
| `channels.list` / `videos.list` (batch 50) | 1 unit | ~500.000 bản ghi |
| **`search.list` — tìm cái CHƯA BIẾT** | 1 call | **100 call, ≤50 kết quả/call** |

**Hệ quả kiến trúc:** đào sâu gần như miễn phí; chỉ *gieo hạt* mới khan hiếm. Toàn bộ thiết kế xoay quanh việc **tiêu 100 search/ngày cho thật đáng** rồi chuyển ngay sang mở rộng đồ thị bằng endpoint 1 unit.

### Ba ràng buộc cứng (đã verify trực tiếp trên docs Google)

1. **`relatedToVideoId` đã gỡ hẳn 07/08/2023.** Không có API "video liên quan". Không có API keyword volume, autocomplete, hay "kênh tương tự". Đây đúng là thứ vidIQ bán và không tái tạo được qua API chính thức.
2. **Một app = một API project.** *"you must create exactly one (1) API Project for that API Client"* — không xoay vòng key để lách quota.
3. **Lưu trữ:** statistics (view/sub/số video) được lưu **vĩnh viễn**; mọi metadata văn bản khác *"not longer than 30 calendar days"* rồi phải refresh. → schema cần `refreshed_at` + job làm mới; time-series số liệu thì hợp lệ hoàn toàn.

Thêm: `mostPopular` chart từ 21/07/2025 chỉ còn Music/Movies/Gaming (YouTube bỏ trang Trending) → không xây feature Trending trên đó. View Shorts đổi cách đếm từ 31/03/2025 → không so viewCount thô giữa Shorts và video dài qua mốc đó.

---

## 1. Hai tầng tìm kiếm

**Tầng ngoài — khan hiếm (100 search/ngày).** Chỉ để phát hiện cái chưa biết. Từ `niche.json` sinh ma trận truy vấn, chạy `search.list`, thu channelId/videoId ứng viên.

**Tầng trong — miễn phí, không giới hạn.** Khi kênh đã nằm trong `spy.sqlite`, mọi lọc/xếp hạng/so sánh xuyên kênh đều không tốn quota. Đây mới là nơi làm việc thật sự. Hiện `spy_channel_videos` chỉ lọc trong **một** run — cần tìm kiếm xuyên toàn corpus.

**Cầu nối — đồ thị.** `channelSections.list` (featured channels) và `subscriptions.list` biến 1 kênh đã biết thành N kênh ứng viên với giá 1 unit. Đây là đường duy nhất còn lại để tìm kênh cùng niche, và nó rẻ tới mức có thể chạy BFS nhiều tầng.

```
niche.json ──► ma trận query ──► search.list (100/ngày) ──┐
                                                          ├─► candidate_channels ──► chấm fit ──► shortlist ──► quét sâu ──► corpus
kênh đã biết ──► channelSections + subscriptions (1 unit) ─┘                                                                    │
                              ▲                                                                                                 │
                              └─────────────────── BFS: kênh mới lại làm hạt giống ──────────────────────────────────────────────┘
```

---

## 2. `niche.json` — file chiến lược

Đặt tại `<data>/config/niche.json`. JSON strict cho filter cứng và sinh query (chạy được ngay, không cần LLM) + trường `notes` dạng prose cho bước chấm fit bằng LLM sau này.

Hai thị trường tách riêng: mỗi market có `relevanceLanguage` + `regionCode` + bộ seed keyword riêng, kết quả gắn nhãn market và **không trộn khi xếp hạng** — một kênh 50k sub ở thị trường Việt không so trực tiếp với 50k sub ở thị trường Anh ngữ.

```jsonc
{
  "version": 1,
  "markets": [
    { "id": "vi", "label": "Việt Nam", "relevanceLanguage": "vi", "regionCode": "VN",
      "seedKeywords": ["câu hỏi hiện sinh", "vũ trụ giải thích", "..."] },
    { "id": "en", "label": "Global EN", "relevanceLanguage": "en", "regionCode": "US",
      "seedKeywords": ["existential questions", "big science explained", "..."] }
  ],
  "negativeKeywords": ["reaction", "gameplay", "..."],
  "format": { "videoDuration": "medium", "minDurationSec": 300, "maxDurationSec": 3600 },
  "channelFilter": { "minSubscribers": 1000, "maxSubscribers": 5000000, "minVideos": 10 },
  "excludeChannelIds": [],
  "scoring": { "keywordOverlap": 40, "subscriberBand": 20, "uploadRecency": 15,
               "avgViewsPerVideo": 15, "languageMatch": 10 },
  "notes": "Prose mô tả chiến lược: khán giả, giọng điệu, thứ KHÔNG làm..."
}
```

Chấm fit v1 **hoàn toàn xác định**, không LLM: overlap n-gram giữa title/description kênh với seedKeywords, trừ điểm cho negativeKeywords, dải subscriber, độ tươi của lần đăng gần nhất, view trung bình mỗi video, khớp ngôn ngữ. Trả điểm 0–100 kèm `reasons[]` để biết vì sao. LLM chỉ vào ở P2 khi cần đọc `notes`.

---

## 3. Quota ledger — bắt buộc, làm trước mọi thứ

Bảng `api_quota_usage(bucket, quota_day, units, calls, updated_at)`. Hai bucket độc lập: `search` (trần 100) và `general` (trần 10.000). Ngày reset tính theo **America/Los_Angeles** (≈14:00–15:00 giờ VN), theo quy tắc chung của Google Cloud quota.

Mọi lời gọi Data API đi qua `QuotaLedger.consume(bucket, units, op)`; hết quota thì ném `quota_exceeded` **trước khi** gửi request. Mỗi tool discovery khai báo trước chi phí ước tính và hỗ trợ `dry_run` để xem sẽ tiêu bao nhiêu mà không tiêu thật.

> Đây là bộ đếm **ước lượng phía mình**, không phải bộ đếm thật của Google. Nếu có client khác dùng chung API key thì số sẽ lệch. `spy_quota_status` nói rõ điều này thay vì giả vờ chính xác.

---

## 4. Tool mới

| Tool | Bucket | Chi phí | Việc |
|---|---|---|---|
| `spy_quota_status` | — | 0 | Còn bao nhiêu search / unit, khi nào reset |
| `spy_niche_get` / `spy_niche_set` | — | 0 | Đọc/ghi `niche.json`, validate schema |
| `spy_discover_channels` | search | 1/query | Ma trận query → search.list → ứng viên, chấm fit, lưu `candidate_channels` |
| `spy_discover_videos` | search | 1/query | Tìm video theo từ khoá + filter format; kênh của chúng cũng thành ứng viên |
| `spy_expand_graph` | general | 1–2/kênh | BFS featured channels + subscriptions từ kênh đã biết |
| `spy_candidates_list` | — | 0 | Lọc/xếp hạng ứng viên theo fit, market, trạng thái |
| `spy_candidates_decide` | — | 0 | shortlist / reject / reset một hoặc nhiều ứng viên |
| `spy_scan_candidates` | general | ~21/kênh | Quét sâu hàng loạt kênh đã shortlist, có ngân sách quota |
| `spy_corpus_videos` | — | 0 | **Tìm video xuyên toàn corpus** — lọc theo title, transcript FTS, outlier, thời lượng, ngày, kênh |
| `spy_corpus_channels` | — | 0 | Tìm kênh trong corpus theo sub, nhịp đăng, view trung vị, fit |

`spy_corpus_videos` là tool sẽ dùng nhiều nhất và tốn 0 quota — mọi thứ khác chỉ phục vụ việc nạp dữ liệu cho nó.

### Bảng mới

`candidate_channels(channel_id UNIQUE, title, handle, market, discovered_via, discovered_from, subscriber_count, video_count, view_count, country, published_at, last_video_at, fit_score, fit_reasons_json, status, first_seen_at, refreshed_at)`
`status ∈ new | shortlisted | rejected | scanned`

`api_quota_usage(bucket, quota_day, units, calls, updated_at)` — PK `(bucket, quota_day)`

Cả hai vào schema v4.

---

## 5. Vì sao cách này ăn đứt vidIQ cho đúng nhu cầu này

vidIQ tính **5 credit mỗi lần tra cứu**; 1203 credit còn lại của bạn ≈ 240 lần gọi, hết là dừng. Ở đây chi phí là quota chứ không phải tiền: **~476 kênh quét sâu mỗi ngày**, và tìm kiếm trong corpus đã quét thì miễn phí vô hạn. Sau một tuần bạn có corpus vài nghìn kênh — quy mô mà mô hình credit của vidIQ không với tới.

Chỗ vidIQ vẫn hơn: cú "tìm kênh cùng niche" đầu tiên bằng semantic search trên index toàn cầu. Ta thay bằng ma trận từ khoá + BFS đồ thị + xếp hạng lại tại chỗ. Kém tinh vi hơn ở bước gieo hạt, nhưng không giới hạn ở bước khai thác — mà khai thác mới là phần bạn cần.

---

## 6. Ngoài phạm vi lần này

Time-series (P1 cũ) — vẫn đáng làm, nhưng sau khi có corpus để mà theo dõi. OAuth Analytics và toàn bộ nhóm sinh nội dung: hoãn theo yêu cầu. Chấm fit bằng LLM đọc `notes`: P2. Cron nền: bật sau khi bạn đã kiểm chứng chất lượng ứng viên bằng tool chạy tay.
