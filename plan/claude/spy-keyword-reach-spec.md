---
title: "Auto research reach/keyword theo chủ đề — spec thực thi cho Writer Room"
status: proposal → chờ chốt ADR
date: 2026-08-20
owner: Claude
audience: codex (owner của plan/codex/spy-intelligence-learning-roadmap.md)
scope: packages/spy (term layer, SERP snapshot, metrics), packages/daemon (MCP + jobs). Không đụng Writer generation.
amends: plan/codex/spy-intelligence-learning-roadmap.md §3 + ADR-SI-4; plan/claude/spy-discovery-design.md §3–§4; plan/claude/spy-mcp-vidiq-parity.md §2.4
---

# Auto research "reach keyword theo chủ đề" — spec

## 0. Kết luận trước

**Business outcome:** Writer Room cần biết *chủ đề nào đáng viết* với bằng chứng mở lại được, không cần một con số search volume giả.

**Quyết định cốt lõi:** bỏ khái niệm "reach" như một con số. Tách thành **bốn tín hiệu độc lập, mỗi cái có nguồn riêng và nhãn riêng**:

| Trục | Câu hỏi | Nguồn duy nhất hợp lệ | Loại tín hiệu |
|---|---|---|---|
| **Demand** | Người ta có tìm không? | YouTube Analytics OAuth — search terms dẫn view về kênh **của mình** | `observed_first_party` |
| **Supply** | Ai đang phục vụ nhu cầu đó? | `search.list` SERP snapshot theo term | `observed_public` |
| **Realized reach** | Chủ đề đó thực tế đem về bao nhiêu view? | Corpus đã Spy: view/VPH của video mang term | `derived_corpus` |
| **Fit** | Mình có cửa thắng không? | `niche.json` fit score + baseline chính kênh mình | `derived_corpus` |

Ba trục sau **hoàn toàn tự làm được, hợp pháp, và trong quota hiện có**. Trục Demand chỉ có một nguồn thật duy nhất là OAuth Analytics — và đó là lý do §7 đề nghị **kéo M4 lên sớm**.

**Điều KHÔNG làm:** search volume toàn YouTube, competition score, "reach" toàn cầu, clone index, xoay key, scrape ngoài endpoint tài liệu hoá.

**Thay đổi kiến trúc quan trọng nhất (§6.1):** hợp nhất `search.list` của Discovery và của Keyword thành **một call ghi hai bảng**. Nếu không làm, hai feature sẽ tranh nhau đúng 100 call/ngày và cả hai cùng đói.

---

## 1. Kiểm kê tín hiệu — cái gì thu được, cái gì không

### 1.1 Bảng phân loại nguồn (chuẩn hoá thành enum `sourceKind`)

`observed_first_party` | `observed_public` | `derived_corpus` | `estimated_external` | `unavailable`

Mọi số trong hệ thống **bắt buộc** mang một trong 5 nhãn này. Không có số "trần".

### 1.2 Nguồn hợp lệ, theo thứ tự độ tin cậy giảm dần

**A. YouTube Analytics API (OAuth kênh sở hữu) — `observed_first_party`. Độ tin: cao nhất, miễn phí.**

- Report với `dimensions=insightTrafficSourceDetail`, `filters=insightTrafficSourceType==YT_SEARCH` → **danh sách từ khoá người xem đã gõ và click vào video của mình**, kèm `views`, `estimatedMinutesWatched`.
- Đây là **dữ liệu demand thật duy nhất** lấy được hợp pháp. Không phải ước lượng, không phải proxy.
- Giới hạn phải nói rõ trong output: chỉ phủ *các term đã dẫn view về kênh mình* (không phải toàn thị trường); YouTube trả top-N và cắt đuôi dài; số nhỏ có thể bị giữ lại vì ngưỡng riêng tư.
- Bổ sung hữu ích cùng lane: `insightTrafficSourceType` (BROWSE / SUGGESTED_VIDEO / YT_SEARCH tỉ trọng), `sharingService`.
- **Cần verify tại thời điểm build:** metric `impressions` / `impressionsClickThroughRate` có sẵn qua Reports API cho scope của mình hay không. Nếu không có → ghi `unavailable`, tuyệt đối không thay bằng heuristic CTR.

**B. YouTube Data API `search.list` — `observed_public`. 1 unit/call, trần cứng 100 call/ngày.**

Hợp lệ để suy ra:
- **API result occupancy**: video/kênh nào xuất hiện trong kết quả `search.list` cho term X, tại thời điểm T, ở market M, với `order` đã ghim. Đây là *quan sát*, không phải ước lượng.
- **Position drift**: so hai snapshot cùng `order` + market → ai vào/ra top-10 **của kết quả API**.

> **Đặt tên bắt buộc — `api_result_position`, KHÔNG phải "SERP rank".** `search.list` trả thứ tự relevance của API; nó không hứa trùng với trang kết quả YouTube mà người dùng thật nhìn thấy (personalized, có ads, ranking khác). Gọi là "rank" là hứa một thứ ta không quan sát được. Mọi so sánh hai snapshot chỉ hợp lệ khi **cùng `order`, cùng `market`, cùng `maxResults`**.
- **Ranker profile**: sau khi enrich bằng `videos.list`/`channels.list` (bucket general, gần như vô hạn) → tuổi video, sub của kênh ranking, view hiện tại, thời lượng, Shorts/long-form.

**KHÔNG hợp lệ:**
- `pageInfo.totalResults` — Google mô tả là số **xấp xỉ** *(codex verify trên docs `search.list` 2026-08-20 → G2 đứng vững)*, dao động giữa các lần gọi và bị cắt khi phân trang. **Cấm dùng làm metric, cấm hiển thị.** Xem G2.
- Thứ hạng ≠ độ phổ biến của term. Không suy ra volume từ SERP.

**C. Corpus đã Spy — `derived_corpus`. 0 quota, không giới hạn.**

Đây là tài sản mạnh nhất và đang bị bỏ phí:
- n-gram title/description/tag của toàn corpus (`transcript_fts` đã có FTS5 cho transcript).
- Câu hỏi khán giả tự nói ra trong comment (`spy_video_comments` đã có) — nguồn "term theo ngôn ngữ người xem", không phải ngôn ngữ marketer.
- **Term Performance Index (TPI)** — §3.3: gắn term vào video corpus rồi đo *kết quả thật* của các video đó. Đây là bản thay thế trung thực cho "search volume": thay vì "term này 40k tìm/tháng", ta nói *"trong corpus 1.200 video, 23 video mang term này ở title; median view 30 ngày = 41k so với median cohort cùng tuổi = 12k; 6/23 là outlier; nhịp đăng term này tăng 3 tháng liên tiếp."*

**D. YouTube autocomplete (`suggestqueries`) — `observed_public` nhưng ENDPOINT KHÔNG CHÍNH THỨC.**

- Cho *hình dạng truy vấn* (query shape), **không cho volume**, và **thứ tự gợi ý không phải thứ tự phổ biến** — Google không công bố cơ sở xếp hạng.
- Rủi ro pháp lý/ToS: không nằm trong API tài liệu hoá; poll quy mô lớn vi phạm ToS.
- **Khuyến nghị: tắt mặc định**, đặt sau feature flag, rate-limit cứng, nhãn `unofficial_source`, chỉ lưu "term có xuất hiện trong tập gợi ý tại thời điểm T". → **ADR-SI-6, chủ dự án chốt.**

**E. Google Ads Keyword Planner API — `estimated_external`. Hợp pháp, có API chính thức.**

- `KeywordPlanIdeaService.GenerateKeywordIdeas` cho volume **của Google Search**, KHÔNG phải YouTube.
- Dùng được như nguồn *gieo hạt có hướng*, với nhãn bắt buộc `estimated.external.google_search_volume`. **Cấm đổi nhãn thành YouTube.**
- Yêu cầu: tài khoản Ads + developer token. **Cần verify** khả năng tách network YouTube trước khi tin bất kỳ con số nào. → **ADR-SI-7.**

**F. Provider ngoài (vidIQ / TubeBuddy / Ahrefs …) — `estimated_external`.**

- Chỉ qua API trả phí được cấp phép. Lưu kèm `vendor`, `as_of`, `credit_cost`, `license_note`.
- **Không được gộp vào cùng một điểm số với số observed.** Hiển thị ở khối riêng, có chữ "ước lượng bởi <vendor>".
- Không tái xuất bản/redistribute. Fail-closed khi thiếu thông tin license.

### 1.3 Không có nguồn — ghi `unavailable`, không thay bằng heuristic

Search volume YouTube · competition score · CTR benchmark ngành · "global trend" · audience overlap. Không có nguồn → tool trả `unavailable` kèm lý do, không trả số.

---

## 2. Schema (spy.sqlite v4 → v5)

```sql
-- Chủ đề: đơn vị người dùng làm việc
topics(topic_id PK, market, label, status, brief_md, created_at, updated_at)
  -- status ∈ draft | active | paused | archived

-- Term đã chuẩn hoá
terms(term_id PK, term_key, market, display_term, status, first_seen_at, last_seen_at)
  UNIQUE(term_key, market)
  -- status ∈ candidate | watch | active | archived

topic_terms(topic_id, term_id, relation, weight, added_by, added_at)
  -- relation ∈ seed | corpus_ngram | comment_mined | graph | autocomplete | external | llm_cluster

-- Provenance: NHIỀU dòng cho một term, không ghi đè
term_sources(term_id, source_kind, source_name, observed_at, raw_ref, license_note)

-- SERP quan sát
term_serp_snapshots(snapshot_id PK, term_id, market, captured_at, quota_op,
                    search_order, max_results,           -- ghim để hai snapshot so được với nhau
                    complete BOOLEAN, result_count, api_approx_total_results)
term_serp_items(snapshot_id, api_result_position, video_id, channel_id, published_at,
                view_count_at_capture, stat_refreshed_at, stat_purged BOOLEAN)
  -- api_result_position: vị trí trong kết quả API, KHÔNG phải rank trên UI YouTube
  -- view_count_at_capture: public statistic → chịu trần 30 ngày, xem §4.6

-- Gắn term vào corpus (0 quota)
video_term_hits(video_id, term_id, field, hit_count, matched_at)
  -- field ∈ title | description | tags | transcript

-- MỌI số đi qua đây, không có số trần ở nơi khác
term_metrics(term_id, market, metric, value, unit, method, source_kind,
             window_start, window_end, sample_count, computed_at)
  -- method ∈ deterministic | proxy | insufficient_sample | unavailable

-- First-party (M4a)
first_party_search_terms(channel_id, term_raw, date_start, date_end,
                         views, watch_minutes, fetched_at)

-- Ngoài
external_keyword_estimates(term_id, vendor, metric, value, unit, as_of,
                           credit_cost, license_note)

-- Alert có dedupe cứng
keyword_alerts(alert_id PK, rule, term_id, market, window_start,
               payload_json, dedupe_key UNIQUE, created_at)

-- Ngân sách quota theo feature (§6.1)
quota_budgets(feature, bucket, daily_units, priority, updated_at)
```

**Sửa bảng có sẵn:** `api_quota_usage` hiện PK `(bucket, quota_day)` — **thêm cột `feature`**, PK thành `(bucket, quota_day, feature)`. Không có chiều này thì không quy trách nhiệm được ai tiêu hết 100 search call.

---

## 3. Workflow tự động theo chủ đề

### 3.1 Chuỗi 8 bước

```
topic brief ─► seed expansion ─► query matrix ─► SERP capture ─► enrich
                    ▲                                  │            │
                    │                                  ▼            ▼
              corpus relabel ◄──────────────── candidate_channels  term_metrics
                    │                                                │
                    └────────► TPI + reach card ────────► alerts ────► Writer handoff
```

**Bước 0 — Topic brief.** Chủ đề do người dùng đặt, hoặc sinh từ `niche.json` (mỗi `seedKeywords` cluster = 1 topic nháp). Mỗi topic buộc gắn đúng một `market` — VI và EN **không trộn khi xếp hạng** (kế thừa nguyên tắc §2 spy-discovery-design).

**Bước 1 — Seed expansion, ưu tiên nguồn 0 quota.** Thứ tự: (a) `niche.json` seedKeywords → (b) n-gram title/description corpus lọc theo topic → (c) comment mining (câu hỏi, "video về X ở đâu") → (d) *tuỳ chọn* autocomplete nếu ADR-SI-6 cho phép → (e) *tuỳ chọn* external nếu ADR-SI-7 cho phép. Mỗi term ghi một dòng `term_sources`; term đến từ nhiều nguồn thì có nhiều dòng.

**Bước 2 — Chuẩn hoá & dedupe.** `term_key` = NFC → lowercase → **giữ nguyên dấu tiếng Việt** → gộp khoảng trắng → bỏ dấu câu biên. Lọc `negativeKeywords` từ `niche.json`. Bỏ term < 2 token trừ khi có trong seed. Dedupe theo `(term_key, market)`.

**Bước 3 — Query matrix + xin ngân sách.** Sinh danh sách term cần snapshot, sắp theo priority = `topic.priority × term.status × độ cũ của snapshot gần nhất`. **`dry_run` là mặc định** — tool trả kế hoạch và chi phí trước khi tiêu.

**Bước 4 — SERP capture.** Mỗi term = **1** `search.list` call, `maxResults=50`, kèm `relevanceLanguage`/`regionCode` của market. Ghi `term_serp_snapshots` + `term_serp_items`. **Đồng thời** ghi channelId lạ vào `candidate_channels` (§6.1). Snapshot bị cắt do hết quota → `complete=0` và **bị loại khỏi scoring** (G9).

**Bước 5 — Enrich (bucket general, ~1 unit/50 bản ghi).** `videos.list` cho 50 videoId của snapshot; `channels.list` cho các kênh mới. Chi phí không đáng kể so với trần 10.000.

**Bước 6 — Corpus relabel (0 quota, chạy đêm).** Khớp term ↔ corpus qua title/description/tags/FTS transcript → `video_term_hits`.

**Bước 7 — Scoring.** §3.3. Tất cả tính bằng code, không LLM.

**Bước 8 — Refresh, alert, handoff.** §3.4, §3.5, §3.6.

### 3.2 Nhịp refresh theo tầng

| Tầng term | Nhịp SERP | Lý do |
|---|---|---|
| `active` (đang viết / đã publish) | 2–3 ngày | Theo dõi position drift của chính mình |
| `watch` | 7 ngày | Phát hiện đối thủ mới vào top |
| `candidate` | 1 lần, rồi quyết định | Chỉ để chấm điểm ban đầu |
| `archived` | không | — |

**Metadata refresh 30 ngày (bắt buộc theo ToS, đã nêu §0 spy-discovery-design):** job riêng `keyword.metadata_refresh` làm mới title/description đã cache; quá 30 ngày mà không refresh được → **xoá phần text**, giữ ID + số liệu thống kê.

### 3.3 Chấm điểm — Reach Card, 4 điểm riêng, không có điểm tổng bịa

Mỗi trục là một `term_metrics` row có `method` + `sample_count`. **Không cộng chéo nhóm nhãn.**

**(1) Demand — chỉ tồn tại khi có M4a.** `firstPartySearchViews`, `firstPartySearchShare`. Chưa có OAuth → `unavailable`, và Reach Card **nói thẳng là trục Demand đang trống**, không mượn trục khác lấp vào.

**(2) Supply / SERP.**
- `apiResultMedianSubs`, `apiResultMedianAgeDays`, `apiResultTop10NewEntrants7d`, `apiResultShortsShare`, `apiResultOurPosition` (nếu kênh mình có mặt).
- Gate: cần ≥ 1 snapshot `complete=1` trong 14 ngày; position drift cần ≥ 2 snapshot **cùng `search_order` + `market`**.

**(3) Realized reach — TPI, đây là số mạnh nhất ta sở hữu.**
- Cohort: các video corpus có `video_term_hits` cho term, so với **median cohort cùng độ tuổi** (tái dùng modified z-score theo age cohort đã có trong `metrics/performance.ts`).
- `tpiLift` = median view của cohort term ÷ median view của cohort tuổi tương ứng.
- `tpiOutlierRate` = tỉ lệ video mang term đạt outlier.
- `tpiSupplyTrend` = số video mang term đăng mới theo quý.
- **Gate cứng:** `sample_count ≥ 8` (tái dùng `MIN_VIDEOS_FOR_DISTRIBUTION`), nếu không → `insufficient_sample`, **không trả số**.
- **Ràng buộc retention (§4.6):** TPI đọc view count *hiện hành* của video corpus, nên nó phụ thuộc job refresh 30 ngày. Video corpus nào lỡ cửa sổ refresh → bị purge số liệu → **rơi khỏi cohort** và `sample_count` giảm. Đây là lý do `keyword.metadata_refresh` là job bắt buộc, không phải job tuỳ chọn.

**(4) Fit.** Tái dùng `scoreChannelFit`/`niche.json` scoring, cộng thêm khớp format (`videoDuration`, `minDurationSec`) và khoảng cách so với baseline chính kênh mình.

**Reach Card** hiển thị 4 khối tách biệt + khối `estimated_external` riêng (nếu có) + dòng `scope: corpus N video, market M, snapshot lúc T`.

### 3.4 Alert

| Rule | Điều kiện | Dedupe key |
|---|---|---|
| `api_result_new_entrant` | Kênh chưa từng thấy vào top-10 **kết quả API** của term watch | `(rule, term_id, market, channel_id, window_start)` |
| `api_result_position_drop` | Video của mình rớt ≥ 5 bậc trong kết quả API (cùng `order`) | `(rule, term_id, market, video_id, window_start)` |
| `term_supply_surge` | Số upload mang term tăng ≥ 2× so với quý trước | `(rule, term_id, market, quarter)` |
| `term_emerging` | Term mới xuất hiện ≥ 3 video corpus trong 30 ngày | `(rule, term_id, market, month)` |

`window_start` chuẩn hoá về đầu window (UTC) để một lần scan lặp không sinh alert mới. `dedupe_key` là UNIQUE ở DB, không chỉ ở code.

### 3.5 Ngân sách quota

Bucket search 100 call/ngày là **ràng buộc duy nhất có thật**. Phép tính để chốt kỳ vọng:

| Phân bổ search/ngày | Watchlist tối đa @ nhịp 7 ngày | Ghi chú |
|---|---|---|
| 30 call | 210 term | Còn 70 cho Discovery + dự phòng |
| 40 call | 280 term | Khuyến nghị khởi điểm |
| 60 call | 420 term | Chỉ khi Discovery đã bão hoà |

Bucket general: 40 term/ngày ≈ 40 unit enrich video + ~20 unit enrich channel = **~60/10.000**. Không phải ràng buộc.

**Chính sách:** `quota_budgets` khai báo `daily_units` + `priority` theo feature. Ledger từ chối **trước khi gửi request** khi feature vượt ngân sách riêng, kể cả khi bucket tổng còn dư. `spy_quota_status` trả cả tổng lẫn theo feature, và giữ nguyên cảnh báo "đây là bộ đếm ước lượng phía client".

### 3.6 Bàn giao sang Writer

Reach Card → **snapshot immutable** khi import (giống nguyên tắc M3). Writer đọc snapshot, không đọc state mutable của Spy. Mọi con số vào topic pack phải qua được ledger verbatim-quote hiện có (`factsLedger` trong `writer-run-v2.ts`); số nào không có evidence ref mở lại được thì **bị loại ở bước import**, không phải ở bước review.

---

## 4. Tool surface (MCP) và jobs

### 4.1 Read-only, 0 quota (theo ADR-SI-1)

`spy_topic_list` · `spy_topic_terms` · `spy_term_metrics` · `spy_term_serp` · `spy_term_corpus_evidence` · `spy_reach_cards`

### 4.2 Mutation — tool riêng, cần xác nhận

`spy_topic_upsert` · `spy_terms_add` · `spy_terms_decide` (watch/archive) · `spy_terms_expand_from_corpus` (0 quota) · `spy_term_snapshot_run` (**bucket search, `dry_run: true` mặc định**) · `spy_term_external_import` (bắt buộc `vendor` + `license_ack`)

### 4.3 Sửa tool có sẵn

`spy_quota_status` → thêm chiều `feature` và ngân sách còn lại theo feature.

### 4.4 Tên bị cấm tồn tại

`spy_keyword_volume`, `spy_competition_score`, `spy_global_reach`, và mọi field tên `searchVolume` / `competition` / `reach` không kèm `sourceKind`. Test phải assert danh sách cấm này.

### 4.5 Jobs

| Job | Nhịp | Quota | Yêu cầu |
|---|---|---|---|
| `keyword.serp_refresh` | ngày | search, theo `quota_budgets` | checkpoint từng term, backoff, idempotent theo `(term_id, quota_day)` |
| `keyword.enrich` | sau mỗi snapshot | general | batch 50 |
| `keyword.corpus_relabel` | đêm | 0 | full rescan an toàn để chạy lại |
| `keyword.metrics_recompute` | đêm | 0 | thuần hàm, không side effect |
| `keyword.metadata_refresh` | ngày | general | ép tuân thủ trần 30 ngày |
| `keyword.alerts_scan` | sau recompute | 0 | dedupe ở DB |
| `keyword.retention_purge` | ngày | 0 | §4.6 |
| `analytics.authorization_recheck` | ≤ 30 ngày | 0 (chỉ OAuth) | Verify token/scope/quyền + trạng thái video; hỏng → purge cascade + audit log (G13). Chỉ có từ K3 |

### 4.6 Retention

> **Đã sửa 2026-08-20 sau review của codex.** Bản đầu của spec này ghi "public statistics giữ vĩnh viễn", kế thừa từ `spy-discovery-design.md` §0 điểm 3. **Claim đó sai.** Policy hiện hành không cho giữ vô thời hạn dữ liệu Data API của kênh/video **không thuộc quyền uỷ quyền**: view/like/comment count, vị trí kết quả và snapshot đều phải **refresh hoặc purge trong 30 ngày**, y như metadata văn bản. Chỉ dữ liệu qua OAuth của kênh mình mới nằm ngoài trần này.

| Dữ liệu | Giữ | Căn cứ |
|---|---|---|
| view/like/comment count của video **không sở hữu** | **≤ 30 ngày**, refresh hoặc purge | Policy Data API — không có ngoại lệ cho statistics |
| `api_result_position`, `term_serp_items` | **≤ 30 ngày**, refresh hoặc purge | Cùng chế độ; snapshot cũ hết hạn thì xoá phần số, giữ được ID + `captured_at` |
| chuỗi thời gian view của video không sở hữu | **cửa sổ trượt 30 ngày**, không phải kho vĩnh viễn | Hệ quả trực tiếp của dòng trên — xem cảnh báo §6.4 |
| view/watch-time của kênh **mình** (OAuth) | Giữ được **lâu hơn 30 ngày**, nhưng **có điều kiện** — xem ô dưới | Authorized Data, chế độ khác với public |
| title/description/tags cache | ≤ 30 ngày, refresh hoặc xoá text | Policy Data API |

> **"Lâu hơn 30 ngày" KHÔNG có nghĩa là "vĩnh viễn, khỏi kiểm".** *(bổ sung 2026-08-20 theo repair của codex)* Analytics Authorized Data được phép giữ dài hạn, nhưng vẫn phải **kiểm lại định kỳ ≤ 30 ngày** rằng:
> 1. **Authorization còn hiệu lực** — token chưa bị thu hồi, chưa hết hạn, scope chưa bị thu hẹp, kênh chưa rời khỏi quyền quản lý của người đã cấp;
> 2. **Đối tượng dữ liệu còn hợp lệ** — video/kênh chưa bị xoá, chưa chuyển private, chưa bị takedown.
>
> Hỏng bất kỳ điều kiện nào → **purge phần dữ liệu tương ứng**, không chỉ dừng ghi mới. Nói cách khác: public chịu trần *làm mới nội dung*; first-party chịu trần *làm mới quyền*. Cả hai đều là chu kỳ 30 ngày, không có nhánh nào "để yên mãi".
| chuỗi autocomplete thô | ≤ 30 ngày, sau đó chỉ giữ aggregate | giảm rủi ro ToS |
| số liệu vendor ngoài | theo license, mặc định 30 ngày, không tái xuất bản | license |
| first-party analytics | Giữ lâu hơn được, **kèm gate xác minh 30 ngày**; tách khỏi dữ liệu public | ADR-SI-5 + G13 |

---

## 5. Hard gates chống bịa

| # | Gate | Cách ép |
|---|---|---|
| **G1** | Không có số trần. Mọi metric là `MetricValue{value, unit, method, sourceKind, window, sampleCount, computedAt}` | Validator ở biên tool; test reject payload thiếu field |
| **G2** | `pageInfo.totalResults` **cấm** vào scoring và cấm hiển thị | Lưu riêng cột `api_approx_total_results` gắn cờ `not_a_metric`; test grep output |
| **G3** | Thứ tự autocomplete **không** được đổi thành thứ hạng/score | Chỉ lưu quan hệ "xuất hiện tại T"; không có cột position |
| **G4** | Số vendor ngoài không trộn với observed | Khối render riêng; test cấm cùng một `term_metrics.metric` có hai `source_kind` bị cộng |
| **G5** | Sample gate | TPI cần ≥8 video; position drift cần ≥2 snapshot `complete=1` cùng `search_order`; thiếu → `insufficient_sample` |
| **G6** | LLM **không sinh số** | LLM chỉ cluster/label term; mọi số tính bằng code; tái dùng `validateEvidenceRefs` |
| **G7** | Không tuyên bố global | Mọi output mang `scope: corpus`, kèm N video + market + thời điểm; lint danh sách từ cấm ("toàn YouTube", "search volume", "realtime VPH", "global") trong test |
| **G8** | Biên Writer | Số vào topic pack phải qua ledger verbatim; không có evidence ref → loại ở import |
| **G9** | Fail-closed theo quota | Snapshot `complete=0` không được scoring, không sinh alert |
| **G10** | Không lách | Một API project; không rotate key; không gọi ngoài endpoint đã tài liệu hoá (trừ autocomplete nếu ADR-SI-6 duyệt, và chỉ dưới rate-limit khai báo) |
| **G11** | **Trần 30 ngày áp cho CẢ statistics của kênh không sở hữu** | Mọi hàng mang số liệu public có `stat_refreshed_at`; job purge chạy hằng ngày; **test assert không tồn tại hàng nào `stat_refreshed_at` quá 30 ngày mà chưa purge**. Dữ liệu OAuth first-party tách bảng riêng và dùng **đường purge riêng theo G13**, không phải miễn purge |
| **G13** | **First-party không phải miễn kiểm** — giữ lâu hơn 30 ngày chỉ hợp lệ khi authorization và đối tượng dữ liệu còn hiệu lực | Job `analytics.authorization_recheck` chạy ≤ 30 ngày/lần: verify token + scope + quyền trên channelId, và trạng thái video/kênh. Mỗi hàng first-party mang `authorization_verified_at`. Hỏng điều kiện → **purge theo cascade**, ghi audit log. **Test assert không tồn tại hàng first-party nào có `authorization_verified_at` quá 30 ngày**, và test revoke-token → dữ liệu bị purge |
| **G12** | Không gọi `api_result_position` là "rank" hay "SERP" | Tên cột, tên metric, tên alert và chuỗi hiển thị đều dùng `api_result_position`; thêm "rank", "SERP", "thứ hạng" vào danh sách từ cấm của G7 |

---

## 6. Hoà vào M1–M5

### 6.1 Thay đổi kiến trúc bắt buộc: một `search.list` ghi hai bảng

**Hiện trạng:** `DiscoveryService.discoverChannels` tiêu search bucket để tìm kênh. Keyword cũng cần đúng bucket đó. Với trần 100 call/ngày, hai feature chạy riêng = cả hai cùng đói.

**Đề xuất:** mỗi `search.list` call là một **SERP snapshot của một term**, và **đồng thời** feed `candidate_channels`. Discovery không còn "query matrix" riêng — nó *tiêu thụ* term layer. Kết quả: cùng 100 call phục vụ cả hai mục tiêu, không tranh chấp, và mỗi call sinh nhiều giá trị hơn hẳn.

→ Đây là chỗ **`spy-discovery-design.md` §1 và §4 cần sửa**, không phải bổ sung.

### 6.2 Milestone K, gắn vào M

| Mốc | Nội dung | Phụ thuộc | Vị trí trong roadmap |
|---|---|---|---|
| **K0** | Term layer trên corpus (schema v5, seed expansion, relabel, TPI). **0 quota mới.** | M0 | Chạy song song M1 |
| **K1** | SERP snapshot dual-write + `quota_budgets` + `feature` trong ledger | K0 | **Gộp vào M1** |
| **K2** | Reach Card v1 (4 trục, trục Demand ghi `unavailable`) + alerts | K0, K1 | Trước M3 |
| **K3** | **M4a** — OAuth chỉ đọc traffic source + search terms → trục Demand có số thật | M4 (rút gọn) | **Kéo lên trước M3** |
| **K4** | Adapter external estimates (tuỳ ADR-SI-7) | K0 | Bất kỳ lúc nào, tuỳ chọn |
| **K5** | Cluster term bằng embedding | M5 | Sau M5 |

**Kiến nghị thứ tự có tranh luận:** roadmap hiện đặt M4 gần cuối. Với mục tiêu *keyword/reach*, đó là thứ tự sai — first-party search terms là **nguồn demand thật duy nhất**, miễn phí, không tốn quota, và không phụ thuộc corpus size. Đề nghị tách **M4a (read-only: traffic source + search terms, không revenue)** và đưa lên ngay sau M2. Phần revenue/demographics giữ nguyên ở M4 đầy đủ.

### 6.3 Chỗ plan hiện tại nên sửa/thay thế

| File | Mục | Sửa gì |
|---|---|---|
| `plan/codex/spy-intelligence-learning-roadmap.md` | §3, dòng "Keyword Research → Không clone search volume" | **Thay** bằng phân rã 4 trục + TPI. Câu hiện tại đúng về mặt phòng thủ nhưng đóng luôn một năng lực làm được |
| cùng file | ADR-SI-4 | **Viết lại**: không phải "giữ vidIQ cho global demand" mà là "taxonomy `sourceKind` 5 giá trị; external chỉ là một nhãn trong đó" |
| cùng file | §6 | **Thêm** ADR-SI-6 (autocomplete ToS), ADR-SI-7 (Ads/vendor license), ADR-SI-8 (phân bổ quota search giữa Discovery và Keyword), **ADR-SI-9 (trần 30 ngày cho public statistics — xem §6.4)** |
| cùng file | §4 **M2** | **Sửa premise**: `video_stat_points` không thể là kho vĩnh viễn cho video không sở hữu. Xem §6.4 |
| `plan/claude/spy-discovery-design.md` | §0 điểm 3 | **Đã sửa 2026-08-20** — claim "statistics lưu vĩnh viễn" là sai |
| `plan/claude/spy-mcp-vidiq-parity.md` | §2.3 + §4 | **Đã sửa 2026-08-20** — lý do chọn P1 ("lưu vĩnh viễn") không còn đứng nguyên |
| cùng file | §4, M4 | **Tách** M4a read-only và đưa lên sớm (§6.2) |
| `plan/claude/spy-discovery-design.md` | §1, §4 | **Thay** query matrix riêng của Discovery bằng term layer dùng chung; `spy_discover_channels` trở thành consumer của `terms` |
| cùng file | §3 quota ledger | **Sửa schema**: thêm `feature` vào `api_quota_usage`, thêm bảng `quota_budgets` |
| `plan/claude/spy-mcp-vidiq-parity.md` | §2.4 `keyword_research` 🔴 | **Đổi thành 🟠** với bản thay thế trung thực (TPI + SERP occupancy) và ghi rõ autocomplete không có volume + rủi ro ToS |
| `AGENTS.md` | Mandatory Spy policy | **Mở rộng**: câu hỏi keyword/reach cũng phải qua Spy trước; vidIQ chỉ sau khi được duyệt và kết quả phải mang nhãn `estimated_external` |

### 6.4 Hệ quả lan sang M2 — cần owner quyết, spec này KHÔNG tự quyết

Trần 30 ngày ở §4.6 không chỉ chạm keyword layer. Nó chạm **premise của M2** trong roadmap của codex và của P1 trong `spy-mcp-vidiq-parity.md`:

- **Cái vẫn còn:** cửa sổ trượt 30 ngày là **đủ** cho VPH 1h/24h/7d, cho performance curve 30 ngày đầu sau publish (vốn là đoạn có giá trị nhất), và cho alert on/off-track. Không mốc nào trong K0–K2 chết vì điều này.
- **Cái mất:** "đường cong view lưu vĩnh viễn cho corpus" — điểm bán chính của P1 trong `spy-mcp-vidiq-parity.md` §2.3/§4 — **không còn đứng được** với video không sở hữu. Không thể giữ một điểm đo của 6 tháng trước.
- **Vùng xám, KHÔNG tự quyết:** số liệu *phái sinh* đã tổng hợp (ví dụ "views tại mốc 24h sau publish = 41k", "median lift của cohort term") có phải là bản sao của resource API hay là thống kê phái sinh — đây là câu hỏi policy/pháp lý, **không phải quyết định kỹ thuật**. Spec này ghi nhận là mở, không giả định là được phép. → **ADR-SI-9.**
- **Tăng trọng số cho D5:** dữ liệu OAuth kênh mình là **nguồn duy nhất giữ được lịch sử dài hạn hợp pháp** — nhưng "dài hạn" ở đây là *có điều kiện*, ràng buộc bởi gate xác minh authorization 30 ngày ở G13, không phải lưu trữ vô điều kiện. Trước đây D5 chỉ là "trục Demand có số thật"; giờ nó còn là "chuỗi thời gian dài hạn duy nhất ta được phép có".

---

## 7. Acceptance criteria

**K0**
- Schema v5 migrate được từ v4 trên DB thật, không mất dữ liệu; rollback có kịch bản.
- **Job purge 30 ngày chạy được; test assert không tồn tại hàng public statistic nào có `stat_refreshed_at` quá 30 ngày mà chưa purge (G11).**
- `spy_terms_expand_from_corpus` chạy 0 quota — test assert `api_quota_usage` không đổi.
- Term dedupe: hai biến thể chỉ khác hoa/thường/khoảng trắng → cùng `term_id`; dấu tiếng Việt khác nhau → **khác** `term_id`.
- TPI với cohort < 8 video trả `insufficient_sample`, không trả `value`.
- Mọi row `term_metrics` có đủ `method` + `source_kind` + `sample_count`.

**K1**
- Một `search.list` call ghi cả `term_serp_snapshots` và `candidate_channels`; test assert đúng 1 lần consume ledger.
- `search_order` + `max_results` ghim vào snapshot; hai snapshot khác `order`/`market` **không được** đem so position (G12).
- `dry_run` mặc định true; gọi không có `confirm` không tiêu quota.
- Vượt `quota_budgets.daily_units` của feature → ném `quota_exceeded` **trước** khi gửi request, kể cả khi bucket tổng còn dư.
- Snapshot bị cắt → `complete=0` và không xuất hiện trong bất kỳ metric nào.
- `spy_quota_status` trả breakdown theo feature và vẫn nêu rõ là bộ đếm ước lượng.

**K2**
- Reach Card có ≥1 evidence ref mở lại được cho mỗi trục có số; trục không có nguồn hiển thị `unavailable` kèm lý do.
- Không card nào chứa chuỗi trong danh sách từ cấm (test lint).
- Chạy `keyword.alerts_scan` hai lần liên tiếp → 0 alert mới.
- Import vào Writer tạo snapshot immutable; sửa Spy sau đó không đổi nội dung đã import.

**K3 (M4a)**
- Token mã hoá tại rest; scope tối thiểu (readonly analytics); không truy cập được channel ngoài uỷ quyền.
- **Job `analytics.authorization_recheck` chạy được ở chu kỳ ≤ 30 ngày; mọi hàng first-party có `authorization_verified_at`; test assert không tồn tại hàng nào quá 30 ngày chưa verify (G13).**
- **Test thu hồi quyền: revoke token → lần recheck kế tiếp purge dữ liệu của channel đó theo cascade và ghi audit log; không còn đọc được qua bất kỳ tool nào.**
- **Test đối tượng hết hợp lệ: video chuyển private/bị xoá → dữ liệu first-party của video đó bị purge ở lần recheck kế tiếp.**
- Output search terms nêu rõ date range, kênh, và giới hạn "chỉ phủ term đã dẫn view về kênh này".
- Không có revenue trong K3.

**K4**
- Không import được nếu thiếu `vendor` hoặc `license_ack`.
- Số vendor render ở khối riêng, có vendor + `as_of`; test assert không bị gộp vào điểm observed.

---

## 8. Quyết định & rủi ro chủ dự án phải chốt

| # | Quyết định | Khuyến nghị | Ảnh hưởng nếu chốt khác |
|---|---|---|---|
| **D1** | Có dùng autocomplete không? | **Không**, mặc định tắt. Giá trị là query-shape, đổi lại rủi ro ToS | Bật thì phải có rate-limit khai báo + nhãn `unofficial_source` |
| **D2** | Có tài khoản Google Ads + developer token? | Nếu có thì bật K4 với nhãn Google-Search | Không có thì trục Demand phụ thuộc hoàn toàn vào K3 |
| **D3** | Giữ vidIQ làm nguồn external có nhãn? Ngân sách credit? | Giữ ở mức thấp, chỉ cho term shortlist | Bỏ hẳn thì chấp nhận không có bất kỳ ước lượng demand thị trường nào |
| **D4** | Phân bổ 100 search call/ngày | 40 keyword / 50 discovery / 10 dự phòng, xem lại sau 2 tuần | Quyết định này trực tiếp định cỡ watchlist (§3.5) |
| **D5** | Kéo M4a lên trước M3? | **Có** — đây là kiến nghị mạnh nhất của spec này | Không kéo thì trục Demand trống ít nhất tới hết M3 |
| **D6** | Kênh nào là kênh sở hữu cho OAuth? Revenue có trong scope không? | Chốt danh sách channelId; revenue **ngoài** scope K3 | — |
| **D7** | Làm cả VI và EN ngay, hay VI trước? | **VI trước** — giảm một nửa query matrix, tăng gấp đôi nhịp refresh | Làm cả hai thì watchlist mỗi market giảm một nửa |
| **D8** | *(mới, sau review codex)* Số liệu **phái sinh/tổng hợp** từ public stats có được giữ quá 30 ngày không? | **Không giả định là được.** Cần owner (và có thể ý kiến pháp lý) chốt trước khi thiết kế bất kỳ kho lịch sử dài hạn nào | Nếu "không" → M2 chỉ còn cửa sổ trượt 30 ngày cho video không sở hữu, và lý do chọn P1 trong parity plan phải viết lại |

### Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| 100 search call/ngày là trần cứng → watchlist không thể lớn | **Cao** | Dual-write (§6.1); phân tầng nhịp refresh; nói rõ cỡ watchlist tối đa với người dùng thay vì hứa suông |
| Người dùng vẫn đọc TPI như "search volume" | **Cao** | G1/G7 + đặt tên UI là "hiệu quả term trong corpus", không dùng chữ "volume" ở bất kỳ đâu |
| Video corpus lỡ cửa sổ refresh 30 ngày → bị purge → rơi khỏi cohort, `sample_count` tụt bất ngờ | **Cao** | `keyword.metadata_refresh` là job bắt buộc; alert khi tỉ lệ purge vượt ngưỡng; hiển thị `sample_count` kèm `stat_refreshed_at` cũ nhất |
| Corpus quá nhỏ → TPI toàn `insufficient_sample` ở giai đoạn đầu | Trung bình | K0 chạy song song M1 để corpus lớn dần; hiển thị `sample_count` để người dùng thấy tiến độ |
| Trần 30 ngày với metadata bị bỏ quên | Trung bình | Job `keyword.metadata_refresh` + test assert không tồn tại text quá 30 ngày chưa refresh |
| Ledger lệch vì key dùng chung nhiều tiến trình | Thấp–Trung bình | Đã có cảnh báo trong `quota.ts`; thêm chiều `feature` để dò lệch nhanh hơn |
| Vendor đổi ToS/giá | Thấp | Adapter tách rời, fail-closed, không có dữ liệu vendor nào là đầu vào bắt buộc của scoring |

---

## 9. Không làm

Clone index toàn cầu · search volume YouTube · competition score · xoay API key hoặc nhiều project · scrape ngoài endpoint tài liệu hoá · để LLM sinh bất kỳ con số nào · tự động áp reach card thành script.

---

**Status đề nghị:** `CONDITIONAL PASS` cho hướng đi — với điều kiện chốt D1, D4, D5 trước khi mở bất kỳ ticket implement nào, vì cả ba đều đổi phạm vi và thứ tự công việc.
