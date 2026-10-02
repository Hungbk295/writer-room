# Pipeline Spy — Formula-Centric (đầy đủ)

Ngày: 2026-10-01 · Nguồn: hỏi đáp chốt mục tiêu + run verify `4146d0ae` (topic `finance-us`).
Bản này ghi **mọi bước**, **điểm quyết định + rẽ nhánh**, **format output từng bước**.
Đặc tả output chuẩn chi tiết: `spy-flow-spec.md` §2a.

## 0. Bản chất pipeline

- Keyword **không phải tài sản** — chỉ là que thăm. Tài sản = **công thức title đang sống**
  (skeleton lặp được ở nhiều kênh nhỏ độc lập).
- 2 lớp keyword:
  - **Core** (ít, bền): neo ngách — "side hustle", "debt payoff". Giữ trong registry, re-check xoay.
  - **Satellite** (nhiều, bốc hơi): biến thể theo trigger/slot đang chạy. Có hạn — chết nếu không tái xác nhận.
- Insight/tệp khán giả: định nghĩa **1 lần** khi chọn ngách — neo bền, không spy lại.
- Phần chạy liên tục: **trigger** (thời sự) → điền vào slot xoay của công thức bền.

## 1. Setup (1 lần/topic)

| Bước | Lệnh | Output |
|---|---|---|
| Daemon | `bun run daemon` → :4187 | `writer-room-data/spy/spy.sqlite` (auto, SCHEMA_VERSION 17) |
| Topic | `POST /api/spy/topics {topicId, label, market, language, facelessRequired, dailySearchBudget, status}` | dòng topic trong DB |
| API keys | `config/spy.json`: `youtubeDataApiKey` + `youtubeDataApiKeys[]` | rotate tự động, quota ledger |

## 2. Khảo sát tệp (khảo sát ban đầu — 1 lần/ngách)

| Bước | Input | Output |
|---|---|---|
| Chọn 2–3 tệp candidate | mục tiêu kênh (US/EN, hybrid POV+số liệu) | list tệp |
| Mine comment/n-gram → derive keyword | video/comment có sẵn | ~10–15 keyword/tệp → `POST /api/spy/keywords/bulk` |
| Chạy probe | `POST /api/spy/keywords/run {publishedAfterDays, maxResults, scanChannelsCap}` | `topic_videos`, `topic_channels`, `keyword_run_items` |

**Output bước:** DB tables — `topic_videos` (video + keyword nguồn + first_seen), `topic_channels` (subs, baseline), `keyword_checks` (median, n_results, n_new mỗi lần check).

**Quyết định — chọn tệp:** đọc scorecard → `floor_<10K` (median views video của kênh <10K subs) + `% outlier từ kênh nhỏ` + supply.
- Rẽ: tệp floor cao + kênh nhỏ lặp → **chọn**; floor thấp hoặc chỉ kênh lớn ăn → **loại** (như `invest-explainer`: 47 outliers, 0 kênh <10K → DROP).

## 3. Vòng phát hiện công thức (lặp)

```
outlier video (kênh <10K, ≤7d) → tách slot → cụm skeleton → verify → thư viện
```

### 3a. Phát hiện (discovery probe)

| Bước | Input | Output |
|---|---|---|
| Sinh keyword satellite | skeleton nghi ngờ, n-gram outlier, suggest | `POST /api/spy/keywords/bulk` (idempotent theo term_key) |
| Run | `POST /api/spy/keywords/run {termKeys?\|group?, publishedAfterDays 1–365, maxResults 1–50, scanChannelsCap 0–50, dryRun?}` | video mới vào `topic_videos` (source='keyword_run'), kênh lạ quét baseline → `topic_channels` (verdict proposed/rejected) |

- Run bị **dedup-lock**: keyword đã search trong `KEYWORD_RESEARCH_DAYS` bị skip.
- Global lock `acquireChargeableWork` — chỉ 1 run tốn quota chạy tại 1 thời điểm.
- Quan sát run: `GET /api/spy/keywords/runs` (+`/:id`).

### 3b. Tách slot (hiện: tay; mục tiêu: agent pass)

Mỗi title outlier → parse theo khung:
**TRIGGER → VISIBLE BEHAVIOR → ECONOMIC CONTRADICTION → MONEY MECHANISM → TITLE**

Output bước: skeleton + giá trị slot (nhóm, tài sản, con số) — hàng phân tích, chưa ghi DB.

### 3c. Cụm skeleton + đếm độ lặp

- Match title theo skeleton regex → group by `channel_id` → tra subs (`channels.list`, 2 unit/50 kênh).
- Đếm kênh **độc lập** lặp skeleton, tách tier: `<10K` / `10–50K` / `>50K`.

**Quyết định — verdict công thức (luật verify):**

| Kết quả | Điều kiện | Rẽ nhánh |
|---|---|---|
| `live` | ≥3 kênh độc lập lặp, ≥1 kênh <10K | → thư viện công thức, sẵn sàng điền trigger |
| `weak` | 1–2 kênh nhỏ lặp, hoặc lặp nhưng mechanism lệch | → theo dõi, verify lại sau với biến thể khác |
| `rejected` | chỉ kênh >50K/>140K ăn, hoặc match là clip/meme | → loại khỏi thư viện; vẫn giữ làm satellite phrase nếu là phrase phụ |

**Rẽ phụ — genre pollution:** n-gram skeleton bị thể loại khác chiếm (vd "secretly living" → Airrack 19.4M entertainment) → lọc theo **thể loại kênh**, không chỉ n-gram; skeleton finance chỉ tính kênh finance.
**Rẽ phụ — 1 kênh chiếm:** skeleton chỉ lặp trong 1 kênh (kể cả to) → đó là *tệp của họ*, không phải công thức → loại hoặc để vào `modelChannels` học format.

### 3d. Bóc slot xoay/bền

- `rotating: true` = slot đổi theo thời sự (trigger, con số, nhóm) → **chờ điền từ trigger pool**.
- `rotating: false` = lõi bền (contradiction, mechanism) → giữ nguyên.

## 4. Output chuẩn — `formula_verify` (schema v1)

Một verify-run ghi `spy-runs/<topic>/<date>-formula-verify.json` (+ `.md` cùng nội dung):

```
{ reportType: "formula_verify", schemaVersion: 1,
  meta: { topicId, runId, date, params, cost, yield, verifyRule },
  formulas: [ { id, skeleton, verdict, repeatability{channels_lt10k,10_50k,gt50k,proof},
                packaging[], slots{trigger,visible_behavior,contradiction,mechanism,title_render},
                reject_reason?, evidence[]{channel,subs,videos,topViews,note,lastSeen} } ],
  keywordHealth: [ {term, medianViews, note} ],
  modelChannels: [ {channel, subs, why} ],
  nextActions: [ {type: title_draft|build|follow_channel|..., from?, title?|item?} ] }
```

- `slots.*.rotating` → UI tô màu slot chờ điền trigger.
- Board màn "4 · Công thức" đọc file mới nhất qua `GET /api/spy/board/formulas`.

**Rẽ — keyword chết:** `keywordHealth` median tụt + n_results phình clone → họ keyword cạn → công thức sống trên đó vẫn giữ nhưng probe đổi sang satellite khác.

## 5. Trigger pool → điền slot → title (lặp hằng ngày/tuần)

| Bước | Nguồn trigger | Output |
|---|---|---|
| Pool tươi | (a) satellite/n-gram chưa từng thấy trong video ≤72h; (b) News Radar (yt-dlp, 0 quota); (c) lịch chu kì/vĩ mô (tax season, FOMC, jobs report, back-to-school, holiday-debt); (d) painpoint mới từ comment | list trigger có ngày |
| Slot binding | công thức `live` + trigger tươi → agent đề xuất pairing | title nháp theo `title_render` |
| Verify pairing | pairing → satellite keyword → probe `search.list` | bằng chứng |

**Quyết định — pairing:**

| Kết quả | Ý nghĩa | Rẽ nhánh |
|---|---|---|
| Probe thấy kênh nhỏ khác chạy cùng skeleton + trigger đó | pairing xác nhận | → viết, độ lặp↑ |
| Probe rỗng | first-mover HOẶC không có demand | → đánh dấu, viết thăm dò (mạo hiểm nhẹ) hoặc bỏ |
| Probe toàn kênh lớn | tệp kênh to đã chiếm pairing | → đổi giá trị slot khác |

## 6. 3 lane content gắn vào pipeline

| Lane | Cách pipeline phục vụ | Tỉ trọng gợi ý (trong 3–5 vid/tuần) |
|---|---|---|
| Hot (sóng) | công thức lặp nhiều nhất 7d + bắt sớm qua re-check | 1–2 slot |
| Chu kì | trigger theo lịch điền sẵn vào slot xoay đúng cửa sổ | xoay theo lịch |
| News | News Radar → trigger tức thời → điền skeleton bền → viết nhanh | 1–2 slot phản ứng |

## 7. Bảo trì keyword (xoay liên tục)

- Daily: snapshot uploads + refresh `videos.list` toàn bộ `topic_videos` (rẻ, đo trend) + re-check một phần keyword (xoay phủ danh sách) → `daily_reports.summary_json.nicheScoreboard`.
- Dedup registry: video đã spy **không kéo lại** comment/baseline/transcript; chỉ views refresh.
- **Quyết định — keyword sống/chết:** `n_checks` cao + `new_rate` tụt + `outliers_found` = 0 → `decide` pause (`POST /api/spy/keywords/decide`); skeleton vẫn sống → sinh satellite mới thay.
- Deep dive (HITL, đắt): chọn video outlier → kéo comment + transcript + baseline đầy đủ → export `.md`.

## 8. Tóm tắt output theo bước

| Bước | Output | Nơi xem |
|---|---|---|
| Probe run | `topic_videos`, `topic_channels`, `keyword_run_items`, `keyword_checks` | DB / board màn 2,3,5 |
| Verify run | `spy-runs/<topic>/<date>-formula-verify.json` + `.md` | file + board màn "4 · Công thức" |
| Daily | `daily_reports` (summary_json.nicheScoreboard + md) | Báo cáo tab / file |
| Deep dive | comment + transcript + export `.md` | file |
| Title nháp | `nextActions[].title_draft` trong JSON | board màn 4 |

## 9. Việc còn thiếu (chưa build)

- Skeleton match + slot parse + ghi JSON **tự động cuối run** (bước 3b–4 hiện làm tay).
- Bảng `title_formulas` (skeleton, slots, evidence_ids, độ lặp, first/last_seen) để công thức sống trong DB thay vì chỉ file.
- Trigger pool tự nạp + màn slot binding trên board.
