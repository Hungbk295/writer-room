---
title: "Spy Auto-Loop — agent tự tìm kênh đối thủ theo chủ đề, mở rộng, chấm điểm, báo cáo hàng ngày"
status: v3 — bỏ detector local (vision sẽ do agent, thiết kế sau) và bỏ hoàn toàn vidIQ (mục tiêu là THAY THẾ vidIQ). Build P0 đang chạy.
date: 2026-08-21 (v3; v2 20-08)
owner: Claude
builds on: spy-discovery-design.md (tool + schema đã code), spy-keyword-reach-spec.md (term layer), codex/spy-intelligence-learning-roadmap.md (M1)
---

# Spy Auto-Loop

## 0. Kết luận trước

**Mục tiêu nghiệp vụ:** mỗi sáng mở dashboard (hoặc Telegram) thấy: *"hôm qua tìm được N kênh faceless mới cùng chủ đề X, đây là 5 kênh đáng học nhất + vì sao, đây là 12 keyword mới nở ra"*. Người dùng chỉ làm một việc: **duyệt / loại rác**. Hệ thống tự dùng quyết định đó để loop tiếp.

**Hiện trạng đã verify (2026-08-20):**

| Thành phần | Trạng thái |
|---|---|
| `niche.json` schema, `buildQueryMatrix`, `scoreChannelFit` | **đã code** (`packages/spy/src/niche.ts`) |
| `spy_discover_channels / videos`, `spy_expand_graph`, `spy_candidates_*`, `spy_scan_candidates`, `spy_quota_status`, `spy_competitors_*` | **đã code**, expose qua MCP |
| Bảng `candidate_channels`, `api_quota_usage`, `competitors` | **có schema, 0 dòng** — chưa từng chạy |
| API key YouTube Data | `config/spy.json.youtubeDataApiKey = ""` → chưa chạy được |
| Corpus | 20 kênh đã spy thủ công |
| Scheduler / cron trong daemon | **không có** |
| Telegram / report | **không có** (`notifications.ts` chỉ là in-app job-done) |
| Phân biệt "faceless" | **không có** — `scoreChannelFit` không chấm trục này |
| Khái niệm "chủ đề" (topic) | chỉ có `market`; `topics` table mới ở spec keyword-reach, chưa build |

**Research v2 đã đổi 6 điểm so với v1** (chi tiết: `spy-autoloop-research/*.md`):

| # | v1 giả định | Thực tế verify | Hệ quả |
|---|---|---|---|
| 1 | Thêm `loop`/`telegram` vào `config/spy.json` | `spyConfigSchema` là `.strict()`, `loadConfig` nuốt lỗi → **key lạ làm mất API key** | Dùng file riêng `config/spy-loop.json` |
| 2 | Quota ledger đã đếm đủ | `acquisition.ts` (scan), `videosByIds`, `channelsByIds`, `comments` **không** `consume` | Bắt buộc decorator `QuotaCountingDataApi` trước khi bật loop |
| 3 | Search bằng `spy_discover_channels` | Nó chỉ đọc `niche.json`; primitive đúng là `discoverVideos({query})` = 1 call/keyword | Loop search **video-first** rồi gom `channelId` (nhiều tín hiệu hơn `type=channel`) |
| 4 | Browser lấy "Up next" ở P2 | Vi phạm YouTube ToS (automated access); `relatedToVideoId` đã gỡ 2023 | Bỏ scrape. "Kênh tương tự" **tự suy ra từ dữ liệu của mình** (§6), không mua từ provider |
| 5 | Face detector chạy local | **Đã loại khỏi P0 (21-08 — user quyết)**: vision sẽ do **agent** chấm, thiết kế sau | P0 chỉ có `faceless_hint` từ văn bản, **không phải verdict**; để sẵn seam `FacelessVerdictPort` |
| 6 | `relevanceLanguage` lọc ngôn ngữ | Chỉ **bias** | Post-filter bằng `defaultAudioLanguage` + langdetect local trên title |

Thêm: **`videos.batchGetStats`** (mới 06/2026, 1 unit) → refresh chỉ số hàng ngày rẻ.

> **Quyết định 21-08 (user):** hệ thống này **thay thế vidIQ**, nên không có bước nào phụ thuộc vidIQ hay provider ngoài — kể cả để gieo hạt. Mọi tín hiệu phải tự thu từ Data API + corpus của mình. Cold start dùng **kênh user tự biết** (`seedChannelIds`) + **20 kênh đã spy sẵn trong corpus** + graph expansion, đều 0 hoặc gần 0 quota. Bảng `term_external_estimates` và relation `seed_external` bị gỡ khỏi schema.

→ **Việc cần làm là 4 lớp mới bọc quanh tool đã có**, không viết lại discovery:

1. **Topic layer** — đơn vị lưu trữ + chấm điểm theo chủ đề (vd. `finance-vi` cho kênh Sói Tài Chính).
2. **Loop runner** — scheduler trong daemon, chạy 1 "tick" mỗi ngày theo ngân sách quota, có checkpoint.
3. **Faceless classifier** — trục chấm mới để lọc đúng loại kênh.
4. **Report + review surface** — dashboard `/spy/loop`, MCP `spy_loop_report`, Telegram push.

Năng lực "kênh tương tự" **tự dựng từ dữ liệu của mình** — graph (P0), SERP co-occupancy (P1), corpus embedding (P2). Không provider ngoài, không scrape browser (§6).

---

## 1. Mô hình dữ liệu: Topic là trục chính

Mọi thứ (kênh ứng viên, keyword, competitor, báo cáo) **gắn vào một topic**. Một kênh có thể thuộc nhiều topic với điểm khác nhau.

```
topics ──< topic_channels >── candidate_channels / channels
   │
   ├──< topic_keywords          (keyword đã thu thập, nguồn, trạng thái, lần dùng search cuối)
   ├──< loop_ticks              (mỗi lần chạy: ngân sách, kết quả, lỗi)
   └──< daily_reports           (snapshot báo cáo, immutable, có md + json)
```

### 1.1 Schema (spy.sqlite v4 → v5; `SCHEMA_VERSION` ở `store.ts:19`, DDL `IF NOT EXISTS`)

Bảng `terms` của keyword-reach-spec **chưa tồn tại** → P0 dùng `term_text` + `term_key` (unaccented) trực tiếp trong `topic_keywords`; khi keyword-reach build `terms` thì migrate FK sau.

```sql
topics(topic_id PK, label, market, language, status,      -- status ∈ active | paused | archived
       own_channel_ids_json,                               -- kênh của mình trong chủ đề này (vd Sói Tài Chính) → baseline
       brief_md,                                           -- prose: khán giả, giọng, format, thứ KHÔNG làm (LLM đọc ở P1)
       faceless_required BOOLEAN DEFAULT 1,
       daily_search_budget INT DEFAULT 20,                 -- chia 100 search/ngày giữa các topic
       created_at, updated_at)

topic_keywords(topic_id, term_key,                         -- term_key = unaccented lowercase; display_term riêng
       display_term,
       relation,        -- seed | harvested_title | harvested_tag | comment_mined | graph | yt_suggest | llm_expand
       evidence_json,   -- {df_chan, df_vid, sample_videos[:5]}
       status,          -- pending | searched | exhausted | rejected
       yield_channels INT DEFAULT 0,                       -- search term này đã đem về bao nhiêu kênh mới → ưu tiên
       last_searched_at, added_at, added_by)               -- added_by ∈ user | loop | agent
   PK(topic_id, term_key)

topic_channel_sources(topic_id, channel_id, relation, term_key NULL, from_channel_id NULL, seen_at)
   -- vì upsertCandidate KHÔNG đè discovered_from → provenance "ra từ keyword nào" ghi ở đây

topic_channels(topic_id, channel_id,
       fit_score, fit_reasons_json,                        -- từ scoreChannelFit + topic overlap (KHÔNG gồm faceless)
       faceless_score, faceless_signals_json,              -- CHỈ ghi khi có verdict thật; P0 luôn NULL (§3)
       faceless_hint, faceless_hint_reasons_json,          -- text-only, là PHỎNG ĐOÁN — không dùng để reject
       style_match_score, style_notes,                     -- DEFERRED cùng vòng agent vision (§3). Cột để sẵn, P0/P1 không ghi.
       learn_value_score,                                  -- §4 — "đáng học" ≠ "giống"
       status,          -- new | shortlisted | studied | rejected | own   (CandidateStatus gốc không có studied → map scanned→studied ở đây)
       decided_by, decided_at,                             -- user | loop_auto
       spy_run_id,                                         -- lưu từ scanCandidates.started (resolveRun theo sourceIdentity lowercase không match UC-id)
       lang_detected, lang_confidence,                     -- post-filter ngôn ngữ (§2.1 bước 3)
       first_seen_at, last_scored_at)
   PK(topic_id, channel_id)

-- candidate_channels.discovered_via — enum ĐÓNG, không có giá trị tự do (§8c):
--   search_video | search_channel   Data API, tự lực
--   featured | subscription         graph, chính chủ kênh khai
--   corpus_import                   từ corpus đã spy — đối chiếu được với bảng channels
--   seed_config                     từ seedChannelIds trong file topic
--   manual_user                     dán qua dashboard — LỜI KHAI, dòng duy nhất cần soi khi truy nguồn.
--                                   Đường hệ thống KHÔNG BAO GIỜ được ghi giá trị này.

-- thêm cột cho bảng cũ (ALTER theo mẫu v1→v2 store.ts:449): candidate_channels.uploads_playlist_id

loop_ticks(tick_id PK, topic_id, quota_day, started_at, finished_at, status,  -- running | done | failed | skipped_quota
       step,                                               -- checkpoint: expand|search|enrich|triage|scan|harvest|report
       UNIQUE(topic_id, quota_day),                        -- idempotency 1 tick/topic/quota-day
       search_calls_used, general_units_used,
       keywords_searched_json, new_candidates, new_shortlisted_auto, scanned_channels,
       keywords_harvested, error)

daily_reports(report_id PK, report_date, topic_id NULL,    -- NULL = báo cáo tổng
       summary_json, markdown, created_at, delivered_json)  -- delivered: {telegram: ts, mcp_read: ts}
```

`candidate_channels` giữ nguyên vai trò bảng thô toàn cục; `topic_channels` là góc nhìn theo chủ đề. Một kênh bị reject ở `finance-vi` vẫn có thể shortlisted ở `psychology-vi`.

### 1.2 Seed cho topic đầu tiên

```jsonc
// writer-room-data/config/topics/finance-vi.json  (file = source of truth, import vào DB khi boot)
{
  "topicId": "finance-vi", "label": "Tài chính cá nhân VI", "market": "vi", "language": "vi",
  "ownChannelIds": ["UC3pBgNay1YGUCvQmYMW6-lw"],          // xác nhận lại qua handle @soitaichinh247
  "seedChannelIds": [],                                   // kênh đối thủ user tự biết — cold start, thay cho provider ngoài
  "seedKeywords": ["tự do tài chính", "tài chính cá nhân", "quản lý tài chính cá nhân", "tư duy tài chính", "thu nhập thụ động",
                   "tư duy làm giàu", "kiến thức tài chính", "quản lý tiền bạc", "lãi kép", "tiết kiệm tiền", "đầu tư cho người mới",
                   "tu do tai chinh", "..."],
  "anchorTerms": ["tiền", "tài chính", "đầu tư", "tiết kiệm", "lãi", "nợ", "giàu", "thu nhập", "chi tiêu"],
  "negativeKeywords": ["chứng khoán livestream", "phím hàng", "forex signal", "phát triển bản thân", "bí quyết thành công"],
  "facelessRequired": true,                               // KHÔNG có tác dụng ở P0 — chỉ kích hoạt khi có verdict vision (§3)
  "preferLongform": true,
  "dailySearchBudget": 20,
  "brief": "Kênh giải thích tài chính cá nhân bằng giọng kể chuyện, không lộ mặt, ... KHÔNG làm: call kèo, crypto pump."
}
```

`anchorTerms` = chốt chống trôi chủ đề (§2.3); `preferLongform` → `videoDuration=medium|long` khi search (thị trường Shorts-nặng: id, hi, es-MX, pt-BR). `facelessRequired` để sẵn cho vòng vision — **ở P0 nó không lọc gì cả**, đừng trông đợi nó chặn kênh có host.

Các thứ tiếng khác = topic khác — **không trộn xếp hạng giữa market**. Seed nháp 15 từ/thị trường cho en/es/pt-BR/id/hi/ja đã có trong `spy-autoloop-research/seeding.md`; thứ tự mở: **en → id** (động lực faceless-explainer gần nhất), hi cần chạy nửa seed với `relevanceLanguage=en` (Hinglish), **ja cần tokenizer hình thái (kuromoji) trước khi bật**.

**Cold start không dùng provider ngoài** — ba đường, tất cả 0 hoặc gần 0 quota:
1. `seedChannelIds` trong topic JSON + nút "Nhập kênh thủ công" trên dashboard (dán URL / `@handle` / `UC…`) → resolve bằng `channels.list` (1 unit/50 kênh).
2. Nút "Nạp kênh đã spy" — 20 kênh sẵn trong bảng `channels` của corpus vào thẳng topic làm hạt giống, **0 quota**.
3. `spy_expand_graph` từ chính kênh của mình + các hạt giống trên (featured channels + public subscriptions, 1–2 unit/kênh).

Ngày 1 vì vậy vẫn có Inbox mà không tốn call search nào, và không phụ thuộc bên thứ ba.

---

## 2. Loop runner — một tick/ngày/topic

Đặt trong `packages/daemon/src/spy/loop-runner.ts`, khởi động từ `harness.ts` cùng `LaneScheduler`. Không dùng cron hệ điều hành — daemon đã chạy nền sẵn.

### 2.1 Thứ tự trong một tick (ngân sách tính trước, fail-closed)

```
0. Kiểm tra quota ledger; nếu search còn < budget → giảm budget, không bỏ tick.
1. EXPAND (0–2 unit/kênh, bucket general — gần như miễn phí)
   └ với mỗi kênh shortlisted/studied chưa expand trong 7 ngày: spy_expand_graph
     → kênh mới vào candidate_channels + topic_channels(status=new)
2. SEARCH (bucket search — khan hiếm; primitive = spy.discoverVideos({query}) — video-first, type=video,
   videoDuration theo preferLongform, order xen kẽ relevance/viewCount, publishedAfter 18 tháng)
   └ thứ tự keyword: seed pending → comment_mined pending → harvested theo df_chan giảm dần
     → re-search top-yield đã searched (≤20% budget). Bỏ exhausted/rejected. K = daily_search_budget.
   └ ghi topic_channel_sources(term_key) cho mọi channelId gom được; P1 ghi thêm term_serp_snapshots
3. ENRICH + SCORE (bucket general, 1 unit/50 kênh)
   └ channels.list batch (snippet,statistics,topicDetails,brandingSettings) → sub, video_count, country,
     topicCategories, uploads_playlist_id; playlistItems + videos.list cho 12 video mới nhất (2 unit/kênh)
     → thumbnail URL, defaultAudioLanguage, tags
   └ LANGUAGE post-filter — ngưỡng tường minh, chỉ một cách hiểu:
       · CHỈ reject khi ≥50% trong 12 video mới nhất CÓ defaultAudioLanguage/defaultLanguage
         và ngôn ngữ chiếm đa số ≠ topic.language → rejected(lang_mismatch)
       · Trường trống/thưa (<50% video có): chạy langdetect trên title chỉ để GHI
         lang_detected + lang_confidence. confidence < 0.8 hoặc <6 title → KHÔNG reject, để user duyệt
       · TUYỆT ĐỐI không reject dựa trên snippet.country hay relevanceLanguage — cả hai chỉ là prior yếu
         (relevanceLanguage chỉ nghiêng kết quả, không lọc — §0 dòng 6)
   └ scoreChannelFit + scoreFacelessHint (§3 — text-only, ghi vào faceless_hint; faceless_score để NULL) + learnValue (§4) → topic_channels
4. AUTO-TRIAGE (0 quota)
   └ fit ≥ 70 && learn_value ≥ 50 → shortlisted (decided_by=loop_auto)
   └ fit < 30 hoặc lang_mismatch → rejected (loop_auto)   ← ẩn khỏi review, vẫn truy vấn được
   └ faceless_hint KHÔNG được dùng để auto-reject (chỉ là phỏng đoán từ chữ) — chỉ dùng để sắp xếp Inbox
   └ còn lại → new (chờ người duyệt)
5. SCAN (bucket general, ~21 unit/kênh, trần cấu hình vd 15 kênh/tick)
   └ spy_scan_candidates cho shortlisted chưa scanned, ưu tiên learn_value cao
   └ sau scan: spy_channel_profile / title_patterns / topic_clusters (đã có) → style evidence
6. HARVEST KEYWORD (0 quota)
   └ từ kênh vừa scan: n-gram title/tag có tần suất ≥ 3 và không trùng term hiện có → topic_keywords(relation=harvested_title, status=pending)
   └ comment top (spy_video_comments) → comment_mined  (P1)
7. REPORT → daily_reports; push Telegram; ghi loop_ticks.
```

Bước 1 trước bước 2 vì graph rẻ hơn search 100 lần; search chỉ để gieo hạt **cho keyword chưa có kênh nào**.

### 2.2 Lịch & an toàn

- **Daemon hiện KHÔNG chạy 24/7** (không launchd, pm2 trống; Tauri spawn khi mở app). Vì vậy scheduler phải **catch-up-on-boot**: `LoopScheduler` trong `packages/daemon/src/spy/loop-scheduler.ts`, start từ `createHttpApp` (spy không nằm trong `harness.ts`), `setTimeout` tới 15:30 Asia/Ho_Chi_Minh nhưng **cap 1h** và re-evaluate (Mac ngủ → timer bắn trễ); khi bắn **và khi start()**: nếu `max(loop_ticks.quota_day) < quotaDay(now)` và đã qua giờ due → chạy. Mở app lúc 21:00 vẫn có tick hôm đó. launchd KeepAlive = P2 tuỳ chọn.
- Tick chạy **sau reset quota** (America/Los_Angeles 00:00 ≈ 14:00–15:00 VN) → mặc định 15:30 VN; report Telegram lúc đó và "digest" 08:00 VN sáng hôm sau (đọc lại DB, không tốn quota, idempotent qua `delivered_json.telegram_digest`).
- Mỗi bước là checkpoint (`loop_ticks.step`); restart giữa chừng → resume, không search lại keyword có `last_searched_at` trong quota-day hiện tại. `UNIQUE(topic_id, quota_day)` chặn tick đôi.
- Lock theo topic = in-memory `Set<topicId>` (daemon đã single-instance qua `.daemon.lock`; `lock.ts` là lock toàn daemon, không theo topic). Không ôm `store.transaction()` qua `await` (BEGIN IMMEDIATE giữ khoá ghi).
- SCAN là op async (`scanCandidates` set `scanned` ngay, trả `operationId`/`spyRunId`) → HARVEST chờ `spy.wait(operationId)` hoặc để tick sau; lưu `spy_run_id` vào `topic_channels`.
- `assertDataApi()` trước mọi `consume` — adapter không key trả rỗng im lặng, sẽ đốt ledger vô ích.
- `dry_run=true` in ra kế hoạch + chi phí ước tính, không gọi API. **Tick đầu tiên bắt buộc chạy dry-run và người dùng xem.**
- Kill-switch: `topics.status=paused`, hoặc `config/spy-loop.json.enabled=false` (**file riêng**, không đụng `spy.json`).
- **Tiền đề bắt buộc:** `adapters/quota-counting-data-api.ts` bọc `YouTubeDataApiPort` gọi `quota.consume` đúng op cho mọi endpoint — hiện scan/by-ids/comments không ghi sổ, loop sẽ tưởng còn quota rồi ăn 403 thật.

### 2.3 Quy tắc "loop theo list keyword thu thập được" — chống trôi chủ đề

Keyword harvest rất dễ kéo loop đi lạc (finance → crypto → gaming). Chặn bằng:
- Keyword harvested chỉ được **search** nếu `df_chan ≥ 2` (xuất hiện ở ≥ 2 kênh `shortlisted`/`studied`, không tính `new`) **và** `drift_ok`: đồng xuất hiện với ít nhất một `anchorTerms` trong cùng một title của corpus. Thuật toán harvest đầy đủ (syllable n-gram 2–4 tiếng Việt, edge-stopword, trọng số title×3/tag×2/desc×1/chapter×2, score = 40·df_chan/5 + 25·specificity + 20·TPI + 15·novelty, n-gram dài thắng khi dedupe) và starter stopword VI: `spy-autoloop-research/seeding.md` Part B.
- Kênh tìm được từ keyword harvested phải vượt **cùng ngưỡng fit** với seed; nếu 1 keyword sinh ra ≥ 80% kênh bị reject → `exhausted`, báo trong report để người dùng xem.
- Người dùng reject keyword trong dashboard → `rejected`, thêm vào `negativeKeywords` nếu đánh dấu.

---

## 3. Faceless — P0 chỉ có *phỏng đoán*, verdict để agent vision chấm sau

**Quyết định 21-08 (user):** bỏ toàn bộ detector chạy local (Apple Vision CLI / YuNet / ONNX). Việc "kênh này có mặt người không" sẽ do **agent vision** làm, thiết kế trong một vòng riêng.

Hệ quả cho P0 — hai thứ tách bạch, không được lẫn:

| | `faceless_hint` (có ở P0) | `faceless_score` (chưa có) |
|---|---|---|
| Nguồn | Regex trên title/description/transcript, vi + en | Agent vision đọc thumbnail/frame |
| Ý nghĩa | **Phỏng đoán**, sai lệch cao | Verdict, có evidence ref |
| Được dùng để | Sắp xếp Inbox, hiển thị kèm chữ "đoán từ chữ" | Auto-triage, gate `facelessRequired` |
| **KHÔNG** được dùng để | Auto-reject, khoe như kết luận | — |

`scoreFacelessHint()` giữ nguyên hai bộ tín hiệu văn bản đã soạn (chi tiết `spy-autoloop-research/faceless.md`, phần regex vẫn còn giá trị):

- **HOST** (đẩy về phía *có mặt*): vi `vlog|một ngày của mình|tâm sự|podcast|reaction|đập hộp|talkshow|lộ mặt…`, en `vlog|day in my life|grwm|storytime|reaction|podcast|face reveal…`; ngôi thứ nhất **chỉ tính khi kèm deixis** ("như bạn thấy", "trên tay", "as you can see") — kênh kể chuyện VN dùng "mình" rất nhiều mà vẫn faceless.
- **FACELESS-EXPLAINER**: vi `giải thích|giải mã|sự thật về|tại sao|top N|thuyết minh|đọc truyện|doodle|giọng đọc…`, en `explained|what if|documentary|narrated|no commentary…`; boilerplate mô tả (`storyblocks|pexels|elevenlabs|vbee|fair use`) là tín hiệu mạnh.

`hint = clamp(0.5 + 0.5·text_faceless − 0.5·text_host)`, kèm `reasons[]` typed và `method: 'text_only' | 'insufficient_sample'`.

**Seam để cắm agent vào sau:** `FacelessVerdictPort { judge(input): Promise<{score, label, evidence[]}> }` khai báo trong `loop/types.ts`, **không implement ở P0**; `LoopRunner` nhận `facelessJudge?` và bỏ qua khi undefined. Khi vòng thiết kế vision xong, chỉ cần implement port này — không phải sửa runner, schema hay UI.

"Giống style" (narration / doodle / stock / AI slideshow / talking head…) cũng thuộc vòng vision đó, không phải P0.

---

## 4. "Đáng học" — learn_value, tách khỏi "giống"

Kênh giống mình nhưng yếu thì không đáng học. `learn_value` (0–100, deterministic, 0 quota sau enrich):

- **Outperform baseline** (40): median view/video của kênh so với **kênh của mình** trong topic (`own_channel_ids`) và với cohort cùng dải sub. Dùng `spy_channel_outliers` sample gates đã có.
- **Momentum** (25): upload 90 ngày gần nhất có view/ngày cao hơn median cả kênh (`spy_channel_momentum`); khi M2 có `video_stat_points` thì thay bằng VPH thật.
- **Còn trẻ mà đã lớn** (20): sub / tuổi kênh (tháng) — kênh 1 năm 200k sub đáng học hơn kênh 10 năm 200k.
- **Nhịp đăng đều** (15): cadence.

Report luôn nêu **method + sample** ("14 video, median 30 ngày"), theo hard gate của roadmap codex.

---

## 5. Bề mặt review & báo cáo

### 5.1 Dashboard `/spy/loop` (web, React — cùng pattern `SpyRun.tsx`)

Stack thật: Preact + Vite, hash router (`router.ts:26` parse `#/spy/<x>` thành spy-run → **phải thêm nhánh `spy-loop` trước dòng đó**), `api` object trong `src/api.ts`, UI kit `Stack/Row/Panel/Chip/Button/Field/Input/CustomSelect`, polling bằng setTimeout trong `hooks.ts`, markdown hiển thị bằng `<pre class="pre">`. Hiện **chưa có UI candidates nào** → Inbox là mới hoàn toàn. Cây component + JSON shape từng endpoint: `spy-autoloop-research/delivery.md` §3.

- **Hàng đầu — KPI theo topic:** quota còn lại, kênh new/shortlisted/studied, keyword pending, tick cuối (status + lỗi).
- **Inbox duyệt** (việc hàng ngày): danh sách `status=new` sắp theo fit×learn_value; mỗi dòng: thumbnail grid 6 video, sub, median view, badge faceless-hint (kèm chữ "đoán") + reasons, fit reasons; nút **Shortlist / Reject / Reject+negative keyword**; phím tắt `j/k/s/r`. Hành động đi qua **`POST /api/spy/loop/decide` → `spy.loop.decide()`**, ghi `topic_channels.decided_by=user`. **Không gọi `spy_candidates_decide`** — đó là trạng thái candidate toàn cục, dùng nó ở đây sẽ dựng hai hệ duyệt song song (codex chỉ ra 22-08).
- **Keyword board:** cột pending / searched (kèm yield) / exhausted / rejected; thêm tay, kéo sang rejected.
- **Studied:** kênh đã scan — link sang `SpyRun` hiện có; tóm tắt title patterns, topic clusters, outliers.
- **Report archive:** danh sách `daily_reports`, render markdown.
- **Nút "Chạy tick ngay (dry-run)"** và "Chạy thật".

HTTP: `GET/POST /api/spy/topics`, `GET /api/spy/loop/inbox?topic=`, `POST /api/spy/loop/decide`, `POST /api/spy/loop/tick?dry_run=`, `GET /api/spy/loop/reports`.

### 5.2 MCP (cho agent khác connect lấy)

Thêm vào `EXPOSED_TOOL_NAMES` (`spy-mcp.ts:15`) + `inputSchemas`: `spy_topics_list`, `spy_loop_status`, `spy_loop_inbox` (URL thumbnail, không ảnh, outputLimit 64k), `spy_loop_report(topic_id?, date?)` (trả `markdown` + `summary`, đóng dấu `delivered_json.mcp_read`). **Lưu ý:** `SCOPES` của MCP đã chứa `spy.start` nên scope không chặn mutation — allowlist là gate duy nhất. Mutation (`spy_loop_decide`, `spy_loop_tick`) đặt `requiredScopes:['spy.loop.write']`, **không** thêm vào SCOPES/allowlist; người dùng mutate qua HTTP/dashboard. Test `spy-mcp.test.ts:71-82` assert danh sách sorted chính xác → thêm 4 tên read và 2 tên mutation vào negative list.

### 5.3 Telegram

`packages/daemon/src/spy/report-telegram.ts` (~40 dòng fetch; skill `telegram-bot` local chỉ là prose, không tái dùng được): `sendMessage` parse_mode **HTML** (MarkdownV2 phải escape 18 ký tự, vỡ với số/URL tiếng Việt), chunk ~4000 ký tự theo đoạn, escape `& < >`, retry 1 lần khi 429 theo `retry_after`, ≤ 1 msg/s/chat. Token + chat_id trong **`config/spy-loop.json`** (ngoài git; hiện chưa có token nào trong repo/env — user tạo bot qua BotFather, lấy chat_id qua `getUpdates`). Idempotent theo `report_id` (`delivered_json.telegram`). Link dashboard phải có `#/` vì hash router: `http://127.0.0.1:4187/#/spy/loop?topic=finance-vi`. Nội dung:

```
📊 Spy Loop — finance-vi — 2026-08-21
Quota: 28/30 search · 612/10000 unit
Kênh mới: 41 → auto-shortlist 6 · chờ duyệt 19 · auto-reject 16
⭐ Đáng học nhất
1. <Tên kênh> — 84k sub, 11 tháng, median 120k view (3.1× Sói Tài Chính) · faceless? 0.9 (đoán từ chữ) · keyword: "lãi kép"
   → https://youtube.com/channel/…
...
🔑 Keyword mới (7): "bẫy tiêu dùng", "nợ tốt nợ xấu", …
⚠ Keyword exhausted: "kiếm tiền online" (92% reject)
🔄 So với hôm qua: kênh mới 23 → 41 · Inbox 31 → 43 (bạn đã duyệt 4 shortlist / 9 reject) · Keyword pending 9 → 14
👉 Duyệt: http://127.0.0.1:4187/#/spy/loop?topic=finance-vi
```

`summary_json` (schema v1 đầy đủ: `spy-autoloop-research/delivery.md` §5 — tick, quota, funnel, topLearn[], newKeywords[], exhaustedKeywords[], scannedChannels[], **delta** so với report trước, warnings[], links) là **immutable**; `renderReport(summary, {mode:'tick'|'digest'})` là một hàm duy nhất cho DB/Telegram/MCP/web `<pre>`.

---

## 6. "Kênh tương tự" — tự suy ra, không mua

Đây chính là thứ vidIQ bán và là lý do dự án tồn tại. Không scrape YouTube (vi phạm ToS), không gọi provider ngoài. Ba đường tự lực, xếp theo thứ tự làm:

1. **Graph expansion** (đã có, P0) — `channelSections` featured + `subscriptions` public, 1–2 unit/kênh. Thưa nhưng chính xác tuyệt đối: chính chủ kênh khai ai liên quan.
2. **SERP co-occupancy** (P1) — mỗi lần search một term ta đã có ảnh chụp kết quả. Hai kênh cùng xuất hiện cho **≥ N term chung** trong cửa sổ 30 ngày là tín hiệu "tương tự" **do mình quan sát được**, không phải ước lượng của ai khác. Ma trận kênh × term dựng từ `topic_channel_sources` — 0 quota, càng chạy càng dày.
3. **Corpus embedding** (P2, ứng với M5 của roadmap codex) — embed title + transcript trong corpus đã spy → `spy_similar_videos` / `spy_similar_channels` **trong phạm vi corpus của mình**, nói rõ giới hạn đó thay vì giả vờ phủ toàn YouTube.

~~Autocomplete `suggestqueries`~~ — đã probe 21-08 và còn chạy, nhưng **không đưa vào P0/P1**: nó là endpoint không tài liệu hoá, dùng nó là mở lại đúng cái cửa nguồn-ngoài mà C1 vừa đóng. Treo ở ADR-AL-7 chờ user quyết riêng.

---

## 7. Lộ trình

| Phase | Nội dung | Kết quả nhìn thấy |
|---|---|---|
| **P0 (tuần 1)** | Nhập API key; `QuotaCountingDataApi`; `config/spy-loop.json`; `topics/finance-vi.json` + `seedChannelIds` + nạp corpus sẵn có; schema v5; `loop-runner` bước 0–4 + 7 (chưa scan) với language post-filter; `faceless_hint` text-only + seam `FacelessVerdictPort`; learn_value v1; `daily_reports` + `renderReport` + Telegram; scheduler catch-up-on-boot; trang `/spy/loop` Inbox + Keyword board + Reports; 4 MCP read tool | Ngày 1 Inbox có sẵn kênh từ corpus + graph (0 quota); từ ngày 2 thêm 20–40 kênh/ngày, duyệt 5 phút |
| **P1 (tuần 2–3)** | Bước 5–6 (scan + harvest keyword, chống trôi §2.3); **vòng thiết kế agent vision** → implement `FacelessVerdictPort` + style-match; SERP co-occupancy (§6.2); learn_value đầy đủ; thêm topic EN/ID | Loop tự mở rộng theo keyword, corpus > 200 kênh/topic |
| **P2** | Corpus embedding → similar trong corpus (§6.3); M2 time-series để learn_value dùng VPH thật; opportunity cards (M3) nối sang Writer | Tự có năng lực "kênh tương tự" mà không cần provider |

**Acceptance P0:**
- Tick dry-run in kế hoạch + chi phí; tick thật không vượt `daily_search_budget`; `api_quota_usage` khớp số call **kể cả scan/by-ids** (qua decorator).
- Thêm key lạ vào `spy.json` không xảy ra; loop config ở file riêng; `youtubeDataApiKey` còn nguyên sau khi bật loop.
- Kênh sai ngôn ngữ (defaultAudioLanguage ≠ topic) bị reject với lý do `lang_mismatch`, không vào Inbox.
- Không còn dòng code nào gọi provider ngoài hay detector local; `faceless_score` luôn null ở P0 và UI không hiển thị hint như verdict.
- Restart daemon giữa tick → resume, không search lặp keyword trong ngày.
- Kênh auto-reject không xuất hiện ở Inbox nhưng query được với filter.
- Report Telegram gửi đúng 1 lần/report; nội dung trùng với `spy_loop_report` qua MCP.
- Mọi điểm số có `reasons[]`/`method`; không có số nào không nhãn nguồn.

---

## 8. ADR — khuyến nghị sau research, chờ user chốt

| ADR | Khuyến nghị | Còn cần từ user |
|---|---|---|
| **AL-1 Topic đầu & seed** | `finance-vi`, `ownChannelIds=[UC3pBgNay1YGUCvQmYMW6-lw]`, seed keyword = §1.2, cold start = `seedChannelIds` + nạp 20 kênh corpus + graph. P1: en → id. | **Xác nhận seed list + dán vài kênh đối thủ bạn đã biết** |
| **AL-2 Vision** | ~~Detector local~~ → **CHỐT 21-08: agent vision, thiết kế vòng riêng.** P0 chỉ có `faceless_hint` text-only + seam `FacelessVerdictPort`. | Lịch cho vòng thiết kế vision |
| **AL-3 Auto-triage** | Loop tự **shortlist** (fit ≥ 70, learn ≥ 50) và tự **reject** (fit < 30 hoặc lang_mismatch). Không reject theo hint. **SCAN** (21 unit/kênh) chỉ cho kênh auto-shortlist ≥ 80 điểm hoặc user shortlist; trần 15 kênh/tick. | Đồng ý ngưỡng hay muốn mọi scan chờ duyệt |
| **AL-4 Kênh report** | Dashboard + MCP ngay P0; Telegram cũng P0 (40 dòng) nhưng cần token. | **Bot token + chat_id** (tạo qua BotFather) — hoặc nói "để sau" |
| **AL-5 Chia 100 search/ngày** | finance-vi **20**/ngày (corpus + graph đã lấp Inbox miễn phí), 20 cho SERP keyword-reach, 10 tay, 50 dự trữ cho topic #2. Tự nâng khi keyword pending có `df_chan ≥ 2` vượt budget 3 tick liên tiếp. | Đồng ý |
| **AL-6 Nguồn ngoài** | **CHỐT 21-08: không dùng provider ngoài nào** (vidIQ đã gỡ khỏi plan + code) — dự án tồn tại để thay thế chúng. **Bổ sung 22-08: lệnh cấm áp cho cả TOOL CALL của agent, không chỉ code.** Agent nào có `vidiq_*` MCP trong phiên thì không được gọi, kể cả để "tham khảo cho nhanh" lúc cold start thiếu hạt giống — đó chính là lúc cám dỗ nhất. Không Playwright scrape YouTube. **Autocomplete `suggestqueries` cũng KHÔNG bật** — codex chỉ ra 22-08 rằng nó là endpoint không tài liệu hoá, mở lại đúng cái cửa C1 vừa đóng. Chuyển thành ADR-AL-7 chờ user quyết riêng, không có flag, không có code. | Đã chốt |
| **AL-7 Autocomplete** (mới, treo) | Mặc định **không làm**. Chỉ mở lại nếu user quyết tường minh, và khi đó phải có nhãn `unofficial_source` + rate-limit cứng + fail im lặng. | Cần user quyết nếu muốn |

**Input chặn build P0:** (1) **API key YouTube Data** vào Settings (`PUT /api/settings/spy`) — không có thì mọi discovery trả rỗng; (2) xác nhận seed keyword + dán vài kênh đối thủ đã biết (AL-1); (3) Telegram token hoặc "để sau".

## 8b. Phân công build P0 (3 seat `agy`, tôi review/tích hợp)

| Seat | Lane | File chính | Test |
|---|---|---|---|
| **agy-1 — core spy** | `QuotaCountingDataApi` decorator; schema v5 + store CRUD; `topic.ts` (zod + import file + bridge sang `scoreChannelFit`); `faceless.ts` (hint text-only) + seam `FacelessVerdictPort`; `learn-value.ts`; `loop/planner.ts` (pure) + `loop/runner.ts` (bước 0–4, 7, checkpoint) ; `loop/report.ts` (`buildDailyReport` + `renderReport`) | `packages/spy/src/**` | `spy/test/loop.test.ts` với `FakeDataApi` (quota đúng, resume, triage, lang filter), `store.test.ts` v5, `faceless.test.ts` (hint text-only) |
| **agy-2 — daemon** | `config/spy-loop.json` loader; `spy/loop-scheduler.ts` (catch-up-on-boot, cap 1h, digest 08:00); `spy/report-telegram.ts`; routes `/api/spy/topics`, `/api/spy/loop/*`; `spy-mcp.ts` + `mcp-tools.ts` 4 read tool; endpoint cold-start tự lực: `candidates/manual` + `import-corpus` | `packages/daemon/src/**`, `packages/spy/src/mcp-tools.ts` | `daemon/test/spy-mcp.test.ts` cập nhật allowlist; `loop-scheduler.test.ts` (fake clock); telegram sender với fetch mock |
| **agy-3 — web** | router `spy-loop` trước spy-run; `api.ts` types; `pages/SpyLoop.tsx` + `features/spy-loop/*` (KPI, TickActions + DryRunPlanModal, InboxTab j/k/s/r/x/u + optimistic, KeywordBoardTab, StudiedTab, ReportsTab + DeltaStrip); Home badge | `packages/web/src/**` | typecheck + smoke qua `browse` skill |

Thứ tự phụ thuộc: agy-1 chốt interface (`LoopRunner`, `ReportSummaryJson`, `InboxItem`) trong 1 commit đầu → agy-2/agy-3 code song song trên interface đó. Tôi gộp, chạy `bun test` + `bun run typecheck`, chạy dry-run tick đầu tiên cùng user.

## 8c. Lỗ hổng C1 mà grep KHÔNG bắt được — kiểm soát bằng chính sách

core-spy nêu 22-08, và đây là điểm đúng cần ghi lại thay vì giả vờ đã kín:

`rg -i vidiq` chỉ quét **source**. Một agent gọi `vidiq_similar_channels` rồi dán kết quả vào `seedChannelIds`, vào `topic_keywords`, hoặc vào corpus sẽ tạo ra dữ liệu phụ thuộc provider ngoài **mà không để lại một ký tự "vidiq" nào trong repo**. Preflight xanh, C1 vẫn thủng, và không truy được về sau vì dữ liệu không mang nhãn nguồn.

**Tách phần kiểm được ra khỏi phần không kiểm được** (khung của codex 22-08, đúng hơn cách viết đầu tiên của tôi — tôi đã kết luận "không kiểm được" rồi dừng, tức đầu hàng sớm):

*Không kiểm được:* lịch sử nguồn của một datum. Một dòng đã nằm trong DB thì không chứng minh được nó từng đi qua provider nào.

*Kiểm được — và bắt buộc:* hàng do **hệ thống** tạo phải mang provenance thuộc danh sách đóng, không có nguồn tự động vô danh. Enum `discovered_via` tách rõ:
- `search_video` / `search_channel` / `featured` / `subscription` — Data API, tự lực
- `corpus_import` — từ corpus đã spy, đối chiếu được với bảng `channels`
- `seed_config` — từ `seedChannelIds` trong file topic
- `manual_user` — dán qua dashboard. **Đây là lời khai, và là dòng duy nhất cần soi khi truy nguồn.** Đường hệ thống không bao giờ được ghi giá trị này.

Bảo chứng mạnh hơn cần allowlist/audit ở **tầng môi trường** (chặn tool provider khỏi phiên agent), nằm ngoài phạm vi repo — xem §8d.

Phần còn lại là **kiểm soát bằng chính sách**, và phải được nói ra đúng như thế:

1. Mọi agent làm việc trong repo này: **không gọi `vidiq_*` hay tool provider tương đương**, kể cả read-only, kể cả "chỉ để tham khảo".
2. Khi cold start thiếu hạt giống, đường đúng là hỏi user, dùng corpus sẵn có, hoặc mở rộng đồ thị — **không** mượn provider rồi rửa nguồn qua ô nhập tay.
3. Hard gate **không được tuyên bố đã kiểm mục này**. PASS chỉ chứng nhận *code và runtime path đã review* không phụ thuộc provider — **không** chứng nhận lịch sử nguồn của mọi datum `manual_user`.

---

## 8d. Việc thuộc tầng môi trường, không phải tầng repo

Điều duy nhất thật sự đóng được lỗ §8c là **không cho tool provider xuất hiện trong phiên agent làm việc trên repo này**. Hiện tại nhiều phiên được nạp sẵn bộ `vidiq_*` mà không ai chọn.

Đề nghị user cân nhắc: gỡ hoặc chặn nhóm MCP đó ở cấu hình phiên khi làm việc trong repo này. Đây là việc của user, không phải của code, và plan này không giả vờ thay thế được nó.

---

## 8e. Ràng buộc đồng thời — ĐỪNG GỠ nếu chưa đọc hết mục này

Phát hiện trong vòng hard gate 22-08. Ghi ở đây vì đây là loại ràng buộc mà người sau rất dễ gỡ với thiện chí "tối ưu".

**Vấn đề:** `LoopRunner` tính quota đã tiêu bằng **hiệu số sổ toàn cục** (`charged()` = sổ hiện tại − mốc lúc bắt đầu tick). Cách này chỉ đúng khi **không có việc tiêu quota nào khác xảy ra xen giữa**. Ban đầu code khoá theo `topicId` và giả định "P0 chạy tuần tự nên không sao" — **giả định đó sai**: route và scheduler cho phép hai topic chạy đồng thời, và mỗi tick khi đó nuốt cả phần của tick kia (2 call thật → mỗi tick báo 2, tổng báo 4).

**Ràng buộc P0:** mọi việc tiêu quota phải đi qua **một coordinator duy nhất** (lease), sở hữu bởi `SpyService` và dùng chung bởi cả runner, route, scheduler. Phủ **toàn bộ** entrypoint chargeable, không chỉ tick: `channelSpy`/acquisition, discover/expand, `videosByIds`, `channelsByIds`/handle, comments, manual resolve. Một tra cứu trực tiếp chen vào giữa mốc và báo cáo cũng làm nhiễu, dù hai tick không hề song song.

**Reentrancy phải theo CHỦ SỞ HỮU, không theo cờ "đang khoá".** `runTick` bên trong nó gọi lại các entrypoint chargeable, nên coordinator không reentrant sẽ khiến tick tự deadlock — và deadlock ở đây biểu hiện thành **tick treo im lặng**, không ném lỗi. Nhưng cài kiểu "thấy `isLocked` thì cho qua" thì ai cũng bypass được, và tra cứu trực tiếp lách vào đúng lúc tick giữ lease: khoá trông như có mà thủng đúng lúc quan trọng nhất. Phải là owner token tường minh (hoặc async-context **kèm test chứng minh propagation**), và caller khác chủ **luôn** xếp hàng.

**Điều kiện để bật đa topic song song:** thay hiệu-số-sổ bằng **charge event mang `tick_id`**. Chỉ khi đó mới được gỡ lease toàn cục. **Gỡ lease mà không làm việc này trước = tái tạo lại đúng lỗi trên**, và nó sẽ không lộ ra dưới dạng test đỏ — nó lộ ra dưới dạng báo cáo quota sai lặng lẽ.

---

## 8f. Một lớp lỗi lặp lại — hai phạm vi trông giống nhau

Bốn lỗi độc lập trong nhánh này cùng một hình dạng: **hai đại lượng trông như nhau nằm cạnh nhau, không có gì buộc người viết chọn đúng.**

| Lỗi | Hai phạm vi bị lẫn |
|---|---|
| T1 (3 chỗ) | ngày UTC ↔ ngày quota Pacific |
| F2 | ước lượng rời rạc ↔ sổ thật |
| H2 | delta toàn cục ↔ phần của một tick |
| H3 | số của một tick ↔ số của cả ngày |

Cách chữa không phải là "nhớ chọn đúng" mà là làm cho **cái sai không diễn đạt được**: mọi field quota/report mang `semantic scope` (`tick` | `topic allocation` | `global day`), và tử số / mẫu số / phần-còn-lại **bắt buộc cùng scope**. Tương tự, mọi so sánh ngày đi qua `quotaDay()`, không tự cắt chuỗi ISO.

---

## 8g. Ba lần "test xanh nhưng vô giá trị"

Ghi lại vì nó là rủi ro lớn nhất của cả dự án này — nguy hiểm hơn bug, vì nó **tạo bằng chứng giả**.

1. Bộ test cũ khẳng định con số quota đúng, nhưng cho **một đường code production không đi qua** (test inject adapter thô, production đi qua decorator). Hai lỗi triệt tiêu nhau đúng bằng nhau nên số vẫn khớp.
2. Fixture hard gate **tự xưng test phân trang** — đặt `nextPageToken` rồi chỉ gọi một lần và assert 1 request.
3. Test lease kiểu "không bị treo" **xanh với cả cài đặt bypass sai**, vì nó không phân biệt "reenter đúng chủ" với "ai cũng qua được".

Hình dạng chung: **test đo một thứ dễ hơn thứ nó tuyên bố đo.** Khi review test, câu hỏi đúng không phải "test này có xanh không" mà **"nếu tính năng này hỏng theo cách tệ nhất, test này có đỏ không?"**

---

## 9. Không làm

- **Không phụ thuộc vidIQ hay bất kỳ provider dữ liệu ngoài nào** — mục tiêu của dự án là thay thế chúng.
- Không detector mặt người chạy local trong P0; vision là việc của agent, thiết kế riêng.
- Không xoay API key / nhiều project để lách quota. Không scrape YouTube nền liên tục.
- Không gọi `faceless_hint` là kết luận — nó là phỏng đoán từ chữ; người dùng là gate cuối.
- Không tự đưa kênh đối thủ vào Writer; chỉ qua opportunity card (M3) có evidence.
- Không hiển thị `totalResults`, "search volume", "VPH realtime" khi chưa có nguồn.
