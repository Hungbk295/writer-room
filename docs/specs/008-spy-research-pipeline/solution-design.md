# 008 · Spy Research Pipeline v2 — Bootstrap / Daily / Weekly

**Ngày:** 2026-09-23 · **Trạng thái:** DRAFT — chờ xác nhận ADR
**Kế thừa:** [spy-phan-lop-niche](../../plans/spy-phan-lop-niche.md) · [spy-pipeline-audience-insight](../../plans/spy-pipeline-audience-insight.md) · [spy-phase-2-van-hanh](../../plans/spy-phase-2-van-hanh.md) · [spy-daily-research-plan](../../plans/spy-daily-research-plan.md) · [004 solution-design](../004-spy-channel-intelligence/solution-design.md)
**Sơ đồ:** xem mục 10 (link Excalidraw)

---

## 0 · Kết luận điều hành

**Quyết định cần đưa ra:** hợp nhất quy trình research Spy thành **một pipeline, ba chế độ chạy** (`bootstrap` · `daily` · `weekly`), nuôi **ba sổ đăng ký** duy nhất — *Keyword Index*, *Audience Insight DB*, *Follow List* — và chuyển ba sổ đó từ TSV/Google Sheet vào **một schema trong `spy.sqlite`** của daemon.

**Vì sao phải làm lại thay vì tiếp tục vá:**

| Hiện trạng | Khoảng trống | Tác động nghiệp vụ |
|---|---|---|
| Ba sổ đăng ký sống ở `writer-room-data/spy-sheet/**.tsv` + Sheet 16 tab, do 6 script Python ghi | Daemon có bảng song song (`topic_keywords`, `topic_channels`, `candidate_channels`, `video_stat_points`) nhưng **không được dùng**; hai nguồn sự thật | Số trên Sheet và số trong DB có thể lệch mà không ai phát hiện (đã xảy ra: locale `vi_VN` biến `74.68` thành `746830645091782`) |
| Tầng insight (VoC → JTBD → Cluster → Micro-niche → Backtest) mới có VoC (TSV) | **Không có bảng nào** cho JTBD, cluster, micro-niche, insight, backtest, hypothesis | Insight không tích luỹ được; mỗi phiên agent làm lại từ đầu; không backtest được nên không phân biệt được insight thật với insight bịa |
| Chế độ kênh (regime), baseline_tier, luật thăng/giáng tồn tại trong **tài liệu và đầu người** | Không có bảng regime; luật giáng chưa tự động; 7/15 kênh qua đỉnh không ai gỡ | Follow list mục nát âm thầm → board `heat` tính trên nền sai |
| Cổng ngôn ngữ, cách ly, nhật ký quyết định là **file rời** | Không truy nguyên được vì sao một kênh/keyword bị loại | Không đo được tỉ lệ ô nhiễm theo từng đường thu thập |
| Ba bug cấu hình (`ytdlp.ts:172`, `niche.ts:209`, `spy_title_patterns` trộn regime) | Tham số ngôn ngữ/thị trường hardcode | **Mọi điểm số Spy cho topic nhắm Mỹ vô hiệu** cho tới khi sửa |

**Kết quả kỳ vọng sau khi triển khai:** mỗi sáng writer mở một board `heat` đúng nền kênh; mỗi keyword trong index có `origin` truy nguyên và điểm kiểm hằng ngày; mỗi insight có verdict do code phán định trên toàn corpus; follow list tự thăng/giáng; mọi thay đổi trạng thái đều có dòng trong `rs_decisions`.

---

## 1 · Nguyên tắc thiết kế — rút từ dữ liệu, không thương lượng

Mười luật này đã được **chứng minh bằng dữ liệu thật** trong các vòng 1–2; thiết kế bên dưới bắt buộc hiện thực hoá từng luật thành **cột, ràng buộc hoặc cổng chặn**, không để ở dạng ghi chú.

| # | Luật | Bằng chứng | Hiện thực hoá trong thiết kế |
|---|---|---|---|
| L1 | Keyword **không do LLM nghĩ ra**; phải có `origin` là dữ liệu thật và được kiểm bằng search | 243 keyword, 191 chờ kiểm | `topic_keywords.origin NOT NULL` + `rs_keyword_scores` append-only |
| L2 | Insight **không do agent tuyên bố**; agent chỉ đề xuất *mẫu khớp*, code phán định bằng backtest | INS-001 lift 1,30 đứng vững; 4 insight khác LOW | `rs_insights.match_pattern` + `rs_insight_backtests` (code ghi) → `status` derived |
| L3 | Cổng ngôn ngữ **tại tầng thu thập**, dòng bị chặn vào **cách ly**, không xoá | 74 dòng tiếng Việt lọt vào nghiên cứu Mỹ | `rs_quarantine` + `rs_videos.lang_gate` |
| L4 | Phát hiện **đứt gãy chế độ** trước, baseline **theo từng chế độ** | POV Finance 726 → 53.419 (73,6x, p=6,6e-11) | `rs_channel_regimes`; mọi `outlier_score`/`heat` tham chiếu `regime_id` |
| L5 | `baseline_tier` dead/thin/proven; kênh `dead` không bao giờ lên shortlist | Kênh median 91 view có video 70.357 → 773x | `topic_channels.baseline_tier` + luật thăng kiểm tier |
| L6 | Trend claim **chỉ hợp lệ từ snapshot kép**; không dựng chuỗi thời gian bằng số luỹ kế | Lỗi *phantom decay* Bille Finance | `rs_video_observations` append-only; `rs_heat_board` chỉ tính khi ≥2 observation |
| L7 | Biến trội là **kênh**, không phải video; **sàn** (median) quyết định, không phải đỉnh; `max/median > 50` là xổ số | Cùng transcript: 111.133 / 205 / 0 view | `topic_channels.max_over_median` là điều kiện loại trong luật thăng |
| L8 | Đơn vị phân lớp là **luồng content**, do người gom một lần; tự gom cụm đã thất bại | Cụm tự sinh nuốt 73% corpus | `rs_streams.created_by='human'`; không có bước auto-cluster |
| L9 | Phải **chẩn đoán phân mảnh** cho mỗi niche mới, không giả định | POV Finance overlap 67–100% → tệp hợp nhất | `rs_niche_diagnostics` → `topics.niche_type` rẽ nhánh chiến lược |
| L10 | Đường keyword hiệu suất **3,4%** → chạy hằng tuần, không hằng ngày | 4/117 kênh dùng được | `weekly` là chế độ duy nhất gọi search để bắt kênh mới |

Cộng hai luật vận hành: **mọi điểm số phải kèm `reasons` + `method`** (kế thừa 004 §7) và **mọi thay đổi trạng thái đều ghi `rs_decisions`** với `actor ∈ {human, loop, agent}`.

---

## 2 · Ba sổ đăng ký × ba chế độ

Pipeline chỉ có **ba đầu ra**. Mọi bước khác là đường đi tới đó.

| Sổ đăng ký | Trả lời câu hỏi | `bootstrap` (một lần / topic) | `daily` | `weekly` |
|---|---|---|---|---|
| **Follow List** (`topic_channels` + `rs_channel_regimes`) | Kênh nào đáng theo, đang ở chế độ nào | **Tạo**: discover → scan → chẩn đoán → người duyệt lần đầu | **Bảo trì**: scan video mới, re-check regime, **giáng tự động** | **Mở rộng**: search keyword → kênh outlier vãng lai → chẩn đoán nhanh → người duyệt → thăng |
| **Keyword Index** (`topic_keywords` + `rs_keyword_scores` + `rs_streams`) | Cụm từ nào là ngách cần tập trung, thuộc luồng nào, đang lên hay xuống | **Tạo**: n-gram từ ≥800 title → kiểm bằng search → người gom 6–10 luồng → gap_score | **Làm giàu**: chấm lại theo vòng quay, rút ứng viên từ title mới | **Làm giàu**: rút keyword từ kênh mới thăng; tính lại gap_score/adjacency |
| **Audience Insight DB** (`rs_voc` → `rs_jtbd` → `rs_audience_clusters` → `rs_micro_niches` → `rs_insights`) | Khán giả mục tiêu là ai, đang kẹt ở đâu, muốn gì | **Tạo**: comment của video outlier → VoC → JTBD → cluster → micro-niche → insight + backtest | **Làm giàu**: comment của video `heat` cao hôm nay → cùng chuỗi → re-backtest | **Làm giàu**: comment của video outlier ở kênh mới → cùng chuỗi |

Đầu ra phụ (derived, không phải sổ): `rs_heat_board` (title đang có view), `rs_hypotheses` (đề tài đề xuất), `daily_reports`.

---

## 3 · Chế độ BOOTSTRAP — chạy một lần cho mỗi topic

**Mục tiêu:** từ một brief (thị trường + ngôn ngữ + 3–5 hạt giống) ra được ba sổ đăng ký đủ dùng và một verdict về kiểu niche. **Thời gian mục tiêu ~2–3 giờ, trong đó ≤1,5 giờ cần người.**

Ký hiệu node: `CODE` (script/daemon, phán định bằng ngưỡng) · `AGENT` (LLM, chỉ đề xuất/trích) · `HUMAN` (quyết định) · `GATE` (cổng chặn cứng).

| # | Node | Bước | Công cụ / phương pháp | Ghi vào | Điều kiện dừng / cổng |
|---|---|---|---|---|---|
| B0 | HUMAN | Brief topic: `market`, `language`, 3–5 seed keyword **hoặc** 3–5 seed channel, ngưỡng mặc định | — | `topics` (`thresholds_json`, `lang_gate_json`) | Không có seed → không chạy |
| B1 | CODE | Discover kênh ứng viên | `spy_global_video_search(language, region)` cho seed kw · `spy_discover_channels` · `spy_expand_graph` từ seed channel | `topic_channels(status=new, discovered_via, discovered_from)` | **GATE L3**: title/kênh không đúng ngôn ngữ → `rs_quarantine` |
| B2 | CODE | Scan corpus | `spy_channel_start(scan_limit≥120, depth=metadata)`; kênh chạm trần → `scan_limit=500` | `rs_videos` (upsert) · `rs_video_observations` (snapshot #1) | Dừng khi **≥800 title** hoặc hết ngân sách bootstrap (~400 unit) |
| B3 | CODE | Chẩn đoán kênh | Pettitt → regime; median **theo regime**; `baseline_tier`; `max_over_median`; `cadence_days`; `faceless_hint` | `rs_channel_regimes` · cột metric trên `topic_channels` | `baseline_video_count<10` → tier=`dead` bất kể median |
| B4 | CODE → HUMAN | Follow list lần đầu | CODE auto-shortlist theo **luật thăng** (§7); HUMAN duyệt inbox **có thumbnail** | `topic_channels.status ∈ {active, watch, rejected}` · `rs_decisions` | Tier `dead` hoặc `max_over_median>50` → không vào shortlist, giữ dòng |
| B5 | CODE | Keyword harvest | n-gram 1–3 từ title; hiệu suất chuẩn hoá theo regime; **giữ ≥4 kênh**; loại danh sách generic | `topic_keywords(status=pending, origin=title_ngram, origin_evidence_json)` | Ra ~200 cụm |
| B6 | CODE | Keyword verify | Search từng cụm (limit 20–25, language/region); `pct_in_niche` = % kết quả thuộc kênh corpus **hoặc** khớp stream pattern; `median_view_top20` | `rs_keyword_scores` (append) · `topic_keywords.status/pct/trend` | `pct≥70%` **và** là khái niệm nghiệp vụ → `active`; ngân sách bucket search |
| B7 | HUMAN | Gom luồng (~15 phút, **một lần**) | Đọc ~200 cụm → 6–10 luồng: `name`, `match_pattern`, `audience_hypothesis`, `confidence` | `rs_streams(created_by=human)` | Không tự gom cụm (L8) |
| B8 | CODE | Chẩn đoán phân mảnh + kích thước luồng | `overlap_matrix`, `engagement_spread`, `duration_spread`, `perf_spread` → `niche_type`; `gap_score`, `adjacency` | `rs_niche_diagnostics` · `topics.niche_type` · `rs_streams.*` · `rs_stream_adjacency` · gán `stream_id` cho `rs_videos`/`topic_keywords` | 0 quota; **bắt buộc** trước khi lên chiến lược |
| B9 | CODE | Comment harvest | Chọn video `outlier_score≥3` trong regime hiện tại của kênh `active` & tier≠dead (≤N video) → `spy_video_comments` → lọc nhiễu | `video_comments` · `rs_comment_triage` (ghi **tỉ lệ nhiễu**) | Noise rate/video ghi lại, không xoá dòng nhiễu |
| B10 | AGENT | VoC → JTBD → Cluster → Micro-niche | Trích 6 trường VoC; JTBD `WHEN/I WANT/SO I CAN/BUT` + `job_type`; gom theo **situation + barrier** (không theo chủ đề); micro-niche 4 thành phần | `rs_voc` · `rs_jtbd` · `rs_audience_clusters` · `rs_micro_niches` | **Gate 6**: micro-niche là chủ đề (`Investing`, `Saving`) → `gate6_pass=0`, không dùng |
| B11 | AGENT → CODE | Insight + backtest | AGENT đề xuất `statement` + `match_pattern` + 6 phần evidence; CODE backtest trên toàn `rs_videos` → `lift`, `n_videos`, `n_channels` | `rs_insights` · `rs_insight_backtests` (append) | Verdict **chỉ do code** theo ngưỡng §7 |
| B12 | CODE | Báo cáo bootstrap | Ba sổ + `niche_type` + top luồng theo gap_score + danh sách `LOW/INSUFFICIENT` + tỉ lệ cách ly theo nguồn | `daily_reports(mode=bootstrap)` · `topics.bootstrap_status=done` | — |

**Rẽ nhánh sau B8 (L9):**
- `unified` (overlap>60%, engagement/duration phẳng) → **xếp hạng luồng**, không phân lớp khán giả; một kênh phục vụ cả niche.
- `fragmented` (overlap<40%, engagement hoặc duration chênh >1,5x) → chọn mảnh `gap_score` cao nhất, kênh riêng cho mảnh.
- `semi` → 2–3 cụm luồng; đánh một cụm.

---

## 4 · Chế độ DAILY — làm giàu ba sổ

**Mục tiêu:** board `heat` đúng nền; follow list tự bảo trì; keyword có xu hướng; insight có verdict mới khi có dữ liệu mới. **Chi phí mục tiêu ≤150 unit general + ≤10 search call/ngày.**

| # | Node | Bước | Phương pháp | Ghi vào | Cổng |
|---|---|---|---|---|---|
| D1 | CODE | Pre-flight | `spy_quota_status`; daemon sống; mở `loop_ticks(mode=daily)` | `loop_ticks` | Fail → **báo Telegram**, không chạy im lặng |
| D2 | CODE | Scan kênh `active` **và** `watch` (đánh dấu) | `spy_channel_start(scan_limit=60, selection=latest, depth=metadata)` → `spy_run_manifest` | `rs_video_observations` (append, `quota_day`) · upsert `rs_videos` (video mới: gán `stream_id`, `outlier_score` theo regime hiện tại) | **GATE L3** → `rs_quarantine` |
| D3 | CODE | Heat board | Với video có ≥2 observation: `velocity_real = Δview/Δngày`; `heat = velocity_real / (regime_median/30)`; `age_days`; cờ `launch_spike` khi `age<3` | `rs_heat_board(as_of=today)` — **materialize**, giữ lịch sử | Không có snapshot kép → board rỗng, ghi rõ |
| D4 | CODE | Regime re-check + **giáng tự động** | Kênh có ≥k video mới kể từ regime cuối → chạy lại Pettitt; áp luật giáng §7 | `rs_channel_regimes` · `topic_channels.status` · `rs_decisions(actor=loop)` | — |
| D5 | CODE | Keyword re-score theo vòng quay | Mỗi ngày chấm `k` keyword `active` cũ nhất theo `last_scored_at` trong ngân sách search; `trend` so với điểm trước | `rs_keyword_scores` · `topic_keywords.trend/last_scored_at` | `pct<50%` 3 lần liên tiếp → `exhausted` |
| D6 | AGENT | Ứng viên keyword mới | Từ title video mới trong 7 ngày: cụm xuất hiện ở **≥2 kênh** → ứng viên | `topic_keywords(status=pending, origin=title_ngram_daily)` | Không đủ 2 kênh → không ghi |
| D7 | CODE → AGENT → CODE | Insight từ video nóng | Video `heat≥3` & `age≥3` → `spy_video_comments` → triage → VoC/JTBD (AGENT) → đề xuất mẫu (AGENT) → **backtest (CODE)**; insight cũ re-backtest khi corpus tăng ≥10% | `rs_comment_triage` · `rs_voc` · `rs_jtbd` · `rs_insights` · `rs_insight_backtests` | Verdict chỉ do code |
| D8 | CODE | Daily report | Board top 10 (lọc `age≥3`), kênh đổi trạng thái, keyword đổi trend, insight đổi verdict, tỉ lệ nhiễu, quota | `daily_reports(mode=daily)` → Telegram (`report-telegram.ts` đã có) | — |

---

## 5 · Chế độ WEEKLY — làm giàu bằng kênh outlier

**Mục tiêu:** bắt kênh vãng lai đang nổ mà follow list chưa có; nuôi keyword từ kênh mới; tính lại bản đồ luồng. **Chi phí mục tiêu ≤15 search call + scan nhanh ≤10 kênh mới.**

| # | Node | Bước | Phương pháp | Ghi vào | Cổng |
|---|---|---|---|---|---|
| W1 | CODE | Search keyword | Top 12 `active` theo `median_view_top20`/`rel_performance`, đã qua lọc generic → `spy_global_video_search(language, region, limit=25)`; loại `duration<300s` | `rs_keyword_scores` (tận dụng kết quả) | **GATE L3** |
| W2 | CODE | Gom kênh outlier ngoài follow | Nguồn 1: gom kết quả theo kênh, chưa có trong `topic_channels`, **≥2 video hit**. Nguồn 2: `spy_expand_graph` từ kênh `active` có `heat` cao nhất tuần | `topic_channels(status=new, discovered_via ∈ {keyword_search, graph_expand}, discovered_from)` | — |
| W3 | CODE | Resolve `channelId` | `spy_global_video_search` không trả `channelId` → đoán handle từ tên → `spy_channel_start(scan_limit=60)` xác nhận | `topic_channels.channel_id` · cờ `needs_human_handle` khi thất bại | Tỉ lệ đo được 3/4 |
| W4 | CODE | Chẩn đoán nhanh (B3 rút gọn) | regime, tier, `max_over_median`, `faceless_hint`, `cadence` → auto-shortlist theo luật thăng | `rs_channel_regimes` · `topic_channels.status ∈ {shortlisted, rejected}` | Tier `dead` → `rejected(reason=dead_baseline)`, **giữ dòng** |
| W5 | HUMAN | Duyệt inbox | Xem `shortlisted` **có thumbnail** → `active/watch/rejected`; kênh `active` mới → scan sâu (`scan_limit=120`) + snapshot #1 | `topic_channels` · `rs_decisions(actor=human)` | Duyệt bằng tên không thumbnail = duyệt mù |
| W6 | CODE | Làm giàu keyword + bản đồ luồng | B5 trên tập kênh mới thăng → `pending`; recompute `supply/total_views/gap_score/adjacency`; chạy lại `rs_niche_diagnostics` | `topic_keywords` · `rs_streams` · `rs_stream_adjacency` · `rs_niche_diagnostics` | `niche_type` đổi → cảnh báo trong report |
| W7 | CODE | Weekly report | Inbox yield (%) theo `discovered_via`, kênh thăng/giáng, top luồng gap_score, keyword mới, insight đổi verdict trong tuần, tỉ lệ cách ly theo nguồn | `daily_reports(mode=weekly)` | — |

**Định kỳ dài hơn (không phải chế độ riêng, là job trong weekly tick):** *hằng tháng* re-harvest keyword trên toàn corpus kênh follow (danh sách kênh đổi thì keyword phải đổi theo); *hằng quý* chạy lại title/hook analysis **theo regime** (`spy_title_patterns` hiện trộn regime — bug #3).

---

## 6 · Thiết kế database

### 6.1 Năm lớp

```
Lớp 0  RAW EVIDENCE   (đã có, giữ nguyên)   operations · spy_runs · channels · video_snapshots ·
                                             video_transcripts · transcript_segments · video_comments · api_quota_*
Lớp 1  REGISTERS      (mở rộng + mới)        topics · topic_channels · rs_channel_regimes ·
                                             topic_keywords · rs_keyword_scores · rs_streams · rs_stream_adjacency · rs_niche_diagnostics
Lớp 2  TIME-SERIES    (mới)                  rs_videos · rs_video_observations · rs_heat_board
Lớp 3  INSIGHT        (mới)                  rs_comment_triage · rs_voc · rs_jtbd · rs_audience_clusters ·
                                             rs_micro_niches · rs_insights · rs_insight_backtests · rs_hypotheses
Lớp 4  OPS            (mở rộng + mới)        loop_ticks · daily_reports · rs_decisions · rs_quarantine
```

Quy ước: bảng mới mang tiền tố `rs_` (research). Bảng cũ được mở rộng bằng cột, không tạo bảng song song. Mọi bảng lớp 1–4 có `topic_id` — một topic là một thị trường nghiên cứu độc lập.

### 6.2 Bảng cũ — mở rộng

**`topics`** — thêm:

```sql
niche_type        TEXT CHECK(niche_type IN ('unknown','unified','fragmented','semi')) DEFAULT 'unknown',
bootstrap_status  TEXT CHECK(bootstrap_status IN ('none','running','done')) DEFAULT 'none',
bootstrapped_at   TEXT,
region            TEXT,                        -- 'US' — tách khỏi market để ép search
lang_gate_json    TEXT NOT NULL DEFAULT '{}',  -- {subtitlePref:['en'], regionBonus:0, blockScripts:[...]}  (sửa bug ytdlp.ts:172 / niche.ts:209)
thresholds_json   TEXT NOT NULL DEFAULT '{}'   -- §7, hiệu chỉnh theo vòng, không hardcode
```

**`topic_channels`** — trở thành **Follow List**. Enum `status` mở rộng thành một vòng đời duy nhất:

```
new → shortlisted → active ⇄ watch → archive
                  ↘ rejected            own (kênh của mình)
```

Thêm cột:

```sql
discovered_via        TEXT,   -- seed | keyword_search | graph_expand | user
discovered_from       TEXT,   -- term_key hoặc channel_id nguồn
current_regime_id     TEXT REFERENCES rs_channel_regimes(regime_id),
baseline_median       INTEGER,   -- median của regime hiện tại
baseline_video_count  INTEGER,
baseline_tier         TEXT CHECK(baseline_tier IN ('dead','thin','proven')),
max_over_median       REAL,      -- L7: >50 = xổ số
break_ratio           REAL,      -- median_regime_mới / median_regime_cũ
cadence_days          REAL,
last_published_at     TEXT,
last_scanned_at       TEXT,
needs_human_handle    INTEGER NOT NULL DEFAULT 0,
promoted_at           TEXT,
demoted_at            TEXT
```

**`topic_keywords`** — trở thành **Keyword Index**:

```sql
origin               TEXT NOT NULL,   -- title_ngram | title_ngram_daily | comment_phrase | user   (L1)
origin_evidence_json TEXT NOT NULL DEFAULT '{}',  -- {n_channels, rel_performance, video_ids[]}
stream_id            TEXT REFERENCES rs_streams(stream_id),
pct_in_niche         REAL,
median_view_top20    INTEGER,
trend                TEXT CHECK(trend IN ('up','flat','down','unknown')) DEFAULT 'unknown',
last_scored_at       TEXT,
consecutive_fail     INTEGER NOT NULL DEFAULT 0
-- status enum: pending | active | exhausted | rejected  ('searched' bỏ — lịch sử nằm ở rs_keyword_scores)
```

**`loop_ticks`** — thêm `mode TEXT CHECK(mode IN ('bootstrap','daily','weekly'))`, `steps_json` (bước nào xong/fail), `counts_json`.
**`daily_reports`** — thêm `mode`.

### 6.3 Bảng mới — DDL

```sql
-- Lớp 1 · Chế độ kênh (L4). Mỗi kênh có ≥1 regime; regime hiện tại là dòng end_at IS NULL.
CREATE TABLE rs_channel_regimes (
  regime_id     TEXT PRIMARY KEY,
  topic_id      TEXT NOT NULL REFERENCES topics(topic_id),
  channel_id    TEXT NOT NULL,
  regime_index  INTEGER NOT NULL,          -- 0,1,2… theo thời gian
  start_at      TEXT NOT NULL,
  end_at        TEXT,
  median_view   INTEGER NOT NULL,
  n_videos      INTEGER NOT NULL,
  break_ratio   REAL,                      -- so với regime trước; NULL cho regime 0
  p_value       REAL,
  method        TEXT NOT NULL DEFAULT 'pettitt',
  computed_at   TEXT NOT NULL,
  UNIQUE(topic_id, channel_id, regime_index)
);

-- Lớp 1 · Lịch sử chấm keyword (L1). Append-only.
CREATE TABLE rs_keyword_scores (
  id                 TEXT PRIMARY KEY,
  topic_id           TEXT NOT NULL,
  term_key           TEXT NOT NULL,
  scored_at          TEXT NOT NULL,
  quota_day          TEXT NOT NULL,
  provider           TEXT NOT NULL,        -- youtube_data_api | ytdlp_fallback
  n_results          INTEGER NOT NULL,
  n_in_niche         INTEGER NOT NULL,
  pct_in_niche       REAL NOT NULL,
  median_view_top20  INTEGER,
  verdict            TEXT NOT NULL,        -- active | pending | exhausted
  FOREIGN KEY (topic_id, term_key) REFERENCES topic_keywords(topic_id, term_key)
);
CREATE INDEX idx_rs_kw_scores ON rs_keyword_scores(topic_id, term_key, scored_at DESC);

-- Lớp 1 · Luồng content (L8). created_by luôn 'human'.
CREATE TABLE rs_streams (
  stream_id            TEXT PRIMARY KEY,
  topic_id             TEXT NOT NULL REFERENCES topics(topic_id),
  name                 TEXT NOT NULL,
  match_pattern        TEXT NOT NULL,      -- regex gom video
  audience_hypothesis  TEXT,               -- SUY RA, không đo
  confidence           TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
  rationale            TEXT,
  supply_videos        INTEGER, supply_channels INTEGER, total_views INTEGER,
  rel_performance      REAL,               -- median hiệu suất chuẩn hoá theo regime
  gap_score            REAL,               -- (total_views × rel_performance) / supply_videos
  created_by           TEXT NOT NULL DEFAULT 'human' CHECK(created_by='human'),
  created_at           TEXT NOT NULL, computed_at TEXT
);

CREATE TABLE rs_stream_adjacency (
  topic_id TEXT NOT NULL, stream_a TEXT NOT NULL, stream_b TEXT NOT NULL,
  shared_channels INTEGER NOT NULL, adjacency REAL NOT NULL,  -- shared / channels(stream_a)
  computed_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, stream_a, stream_b)
);

-- Lớp 1 · Chẩn đoán phân mảnh (L9). Append-only; dòng mới nhất quyết định topics.niche_type.
CREATE TABLE rs_niche_diagnostics (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, computed_at TEXT NOT NULL,
  n_videos INTEGER, n_channels INTEGER, n_streams INTEGER,
  overlap_min REAL, overlap_max REAL, engagement_spread REAL, duration_spread REAL, perf_spread REAL,
  niche_type TEXT NOT NULL CHECK(niche_type IN ('unified','fragmented','semi')),
  reasons_json TEXT NOT NULL
);

-- Lớp 2 · Fact video (một dòng / video / topic). Thay spy_fact_video (Sheet).
CREATE TABLE rs_videos (
  topic_id         TEXT NOT NULL,
  source_video_id  TEXT NOT NULL,
  channel_id       TEXT,                    -- NULL = chưa attribute (không đoán — luật 004)
  title            TEXT NOT NULL,
  published_at     TEXT,
  duration_sec     REAL,
  lang_detected    TEXT,
  lang_gate        TEXT NOT NULL CHECK(lang_gate IN ('pass','quarantined')),
  stream_id        TEXT REFERENCES rs_streams(stream_id),
  regime_id        TEXT REFERENCES rs_channel_regimes(regime_id),
  outlier_score    REAL,                    -- latest_view / regime.median_view
  first_seen_at    TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  first_source     TEXT NOT NULL,           -- spy_run_manifest | search | expand
  PRIMARY KEY (topic_id, source_video_id)
);
CREATE INDEX idx_rs_videos_channel ON rs_videos(topic_id, channel_id, published_at DESC);

-- Lớp 2 · Snapshot view (L6). Append-only, một dòng / video / quota_day / source.
CREATE TABLE rs_video_observations (
  id               TEXT PRIMARY KEY,
  topic_id         TEXT NOT NULL,
  source_video_id  TEXT NOT NULL,
  channel_id       TEXT,
  observed_at      TEXT NOT NULL,
  quota_day        TEXT NOT NULL,
  view_count       INTEGER NOT NULL,
  like_count       INTEGER, comment_count INTEGER,
  source           TEXT NOT NULL,           -- spy_run_manifest | search | ytdlp
  spy_run_id       TEXT REFERENCES spy_runs(id),
  UNIQUE(topic_id, source_video_id, quota_day, source)
);
CREATE INDEX idx_rs_obs_video ON rs_video_observations(topic_id, source_video_id, observed_at);

-- Lớp 2 · Board vận tốc thật — materialize mỗi ngày để giữ lịch sử (ADR-4).
CREATE TABLE rs_heat_board (
  topic_id TEXT NOT NULL, as_of TEXT NOT NULL, source_video_id TEXT NOT NULL,
  channel_id TEXT, regime_id TEXT,
  view_count INTEGER NOT NULL, views_gained INTEGER NOT NULL,
  window_days INTEGER NOT NULL, velocity_real REAL NOT NULL,
  regime_median INTEGER NOT NULL, heat REAL NOT NULL,   -- velocity_real / (regime_median/30)
  age_days INTEGER, launch_spike INTEGER NOT NULL DEFAULT 0,  -- age<3
  stream_id TEXT, rank INTEGER NOT NULL,
  PRIMARY KEY (topic_id, as_of, source_video_id)
);

-- Lớp 3 · Lọc nhiễu comment. Không xoá — đo tỉ lệ nhiễu.
CREATE TABLE rs_comment_triage (
  comment_id   TEXT PRIMARY KEY REFERENCES video_comments(id),
  topic_id     TEXT NOT NULL,
  verdict      TEXT NOT NULL CHECK(verdict IN ('signal','noise')),
  noise_reason TEXT,                         -- spam | emoji_only | off_topic | too_short | ...
  signal_score REAL,
  method       TEXT NOT NULL,                -- filter_comments.py@v
  triaged_at   TEXT NOT NULL
);

-- Lớp 3 · Voice of Customer, 6 trường SOP.
CREATE TABLE rs_voc (
  voc_id               TEXT PRIMARY KEY,
  topic_id             TEXT NOT NULL,
  comment_id           TEXT NOT NULL REFERENCES video_comments(id),
  source_video_id      TEXT NOT NULL,
  insight_types_json   TEXT NOT NULL,        -- 9 loại SOP
  life_stage           TEXT, current_state TEXT, emotion TEXT,
  underlying_question  TEXT NOT NULL,        -- hạt giống JTBD
  desired_outcome      TEXT,
  language_phrases_json TEXT NOT NULL DEFAULT '[]',
  signal_score         REAL, like_count INTEGER,
  extracted_by         TEXT NOT NULL,        -- model id
  extracted_at         TEXT NOT NULL
);

CREATE TABLE rs_jtbd (
  jtbd_id       TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
  when_         TEXT NOT NULL, i_want_to TEXT NOT NULL, so_i_can TEXT NOT NULL, but_ TEXT NOT NULL,
  job_type      TEXT NOT NULL CHECK(job_type IN ('functional','emotional','social')),
  evidence_voc_ids_json TEXT NOT NULL,       -- rs_voc.voc_id[]
  n_comment     INTEGER NOT NULL,
  confidence    TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
  created_by    TEXT NOT NULL, created_at TEXT NOT NULL
);

-- Gom theo situation + barrier, KHÔNG theo chủ đề (đo: 2,64x vs 1,78x).
CREATE TABLE rs_audience_clusters (
  cluster_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
  name TEXT NOT NULL, situation TEXT NOT NULL, barrier TEXT NOT NULL,
  jtbd_ids_json TEXT NOT NULL, n_evidence INTEGER NOT NULL,
  language_markers_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- Bốn thành phần bắt buộc. gate6_pass=0 khi thực chất là chủ đề.
CREATE TABLE rs_micro_niches (
  niche_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
  cluster_id TEXT REFERENCES rs_audience_clusters(cluster_id),
  audience TEXT NOT NULL, situation TEXT NOT NULL, problem TEXT NOT NULL, desired_transformation TEXT NOT NULL,
  gate6_pass INTEGER NOT NULL DEFAULT 0, gate6_reason TEXT,
  created_at TEXT NOT NULL
);

-- Insight: agent đề xuất, code phán định (L2). status là DERIVED từ backtest mới nhất.
CREATE TABLE rs_insights (
  insight_id       TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
  statement        TEXT NOT NULL,
  observation TEXT, pattern TEXT, interpretation TEXT, alternative TEXT,   -- 6 phần evidence
  evidence_json    TEXT NOT NULL DEFAULT '{}',
  confidence       TEXT NOT NULL CHECK(confidence IN ('high','medium','low','insufficient')),
  match_pattern    TEXT NOT NULL,            -- regex/rule cho backtest — agent đề xuất
  source_jtbd_id   TEXT REFERENCES rs_jtbd(jtbd_id),
  source_niche_id  TEXT REFERENCES rs_micro_niches(niche_id),
  status           TEXT NOT NULL DEFAULT 'candidate'
                   CHECK(status IN ('candidate','strengthening','flat','weakening','insufficient')),
  proposed_by      TEXT NOT NULL, created_at TEXT NOT NULL, last_backtest_at TEXT
);

CREATE TABLE rs_insight_backtests (
  id TEXT PRIMARY KEY, insight_id TEXT NOT NULL REFERENCES rs_insights(insight_id),
  run_at TEXT NOT NULL, corpus_size INTEGER NOT NULL,
  n_videos INTEGER NOT NULL, n_channels INTEGER NOT NULL, lift REAL,
  verdict TEXT NOT NULL CHECK(verdict IN ('strengthening','flat','weakening','insufficient')),
  method TEXT NOT NULL                      -- backtest_insight.py@v
);

CREATE TABLE rs_hypotheses (
  hypothesis_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
  niche_id TEXT REFERENCES rs_micro_niches(niche_id),
  insight_id TEXT REFERENCES rs_insights(insight_id),
  stream_id TEXT REFERENCES rs_streams(stream_id),
  audience TEXT, tension TEXT, promise TEXT, angle TEXT,
  title_proposed TEXT NOT NULL,
  duplicate_of TEXT,                        -- bước 35 kiểm trùng
  opportunity_score REAL, score_reasons_json TEXT,
  decision TEXT CHECK(decision IN ('priority_test','backlog','rejected')),
  created_at TEXT NOT NULL
);

-- Lớp 4 · Nhật ký quyết định — mọi đổi trạng thái đều qua đây.
CREATE TABLE rs_decisions (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN ('human','loop','agent')),
  entity_type TEXT NOT NULL,                -- channel | keyword | stream | insight | hypothesis
  entity_id TEXT NOT NULL,
  from_status TEXT, to_status TEXT NOT NULL,
  reason TEXT NOT NULL, evidence_ref TEXT,   -- tick_id / run_id / backtest id
  tick_id TEXT REFERENCES loop_ticks(tick_id)
);
CREATE INDEX idx_rs_decisions_entity ON rs_decisions(topic_id, entity_type, entity_id, at DESC);

-- Lớp 4 · Cách ly (L3). Giữ để đo tỉ lệ ô nhiễm theo nguồn.
CREATE TABLE rs_quarantine (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('video','channel','keyword','comment')),
  entity_id TEXT NOT NULL,
  reason TEXT NOT NULL,                     -- non_target_language | off_market | generic_term | short_form
  source TEXT NOT NULL,                     -- đường thu thập nào để lọt
  payload_json TEXT NOT NULL, quarantined_at TEXT NOT NULL, tick_id TEXT
);
CREATE INDEX idx_rs_quarantine_source ON rs_quarantine(topic_id, source, quarantined_at DESC);
```

### 6.4 Quan hệ chính

```
topics 1─∞ topic_channels 1─∞ rs_channel_regimes
topics 1─∞ rs_streams 1─∞ topic_keywords ; rs_streams ∞─∞ rs_streams (rs_stream_adjacency)
topic_channels 1─∞ rs_videos 1─∞ rs_video_observations ; rs_videos ∞─1 rs_channel_regimes, rs_streams
rs_videos 1─∞ rs_heat_board (theo as_of)
video_comments 1─1 rs_comment_triage 1─0..1 rs_voc ∞─∞ rs_jtbd ∞─∞ rs_audience_clusters 1─∞ rs_micro_niches
rs_jtbd / rs_micro_niches 1─∞ rs_insights 1─∞ rs_insight_backtests
rs_insights, rs_micro_niches, rs_streams 1─∞ rs_hypotheses
loop_ticks 1─∞ rs_decisions, rs_quarantine, daily_reports
```

### 6.5 Ánh xạ di trú từ TSV/Sheet

| Nguồn hiện tại | Đích | Ghi chú |
|---|---|---|
| `loop/follow_list.tsv` (18) | `topic_channels` | `status` map active/watch; `regime`, `break_ratio` → `rs_channel_regimes` |
| `loop/inbox_channels.tsv` (101) | `topic_channels(status=new/rejected)` | `keyword_trigger` → `discovered_from`; thiếu `channel_id` → `needs_human_handle=1` |
| `loop/snapshots.tsv` (214) | `rs_video_observations` | `snapshot_date` → `quota_day`; `source` giữ |
| Sheet `spy_fact_video` (1.486) | `rs_videos` | `stream_id` gán lại bằng `match_pattern` |
| `state/keyword_index.tsv` (243) | `topic_keywords` | `trang_thai` map; `origin` bắt buộc — dòng thiếu origin → `rejected(reason=no_origin)` |
| `state/keyword_history.tsv` | `rs_keyword_scores` | append |
| `voc/voc_batch*.tsv` (200) | `rs_voc` | cần `comment_id` — join lại `video_comments` bằng `video_id + text hash` |
| `state/insight_db.tsv` (5) | `rs_insights` + 1 dòng `rs_insight_backtests` | INS-001 → `strengthening` |
| `strategy/chien_luoc_voc.tsv` | `rs_jtbd` (nháp) | `underlying_question` là hạt giống |
| Mẫu luồng viết tay (8 luồng) | `rs_streams` | `created_by=human`, `confidence` theo §5 plan phân lớp |
| `_decisions.tsv`, `_quarantine_nonenglish.tsv` | `rs_decisions`, `rs_quarantine` | — |

Sau di trú: **đối chiếu ngược** — đọc lại từ DB, diff với TSV nguồn theo giá trị thô (luật kế thừa từ sự cố locale).

---

## 7 · Ngưỡng phán định — lưu trong `topics.thresholds_json`, mặc định

| Nhóm | Ngưỡng | Mặc định |
|---|---|---|
| Corpus | tối thiểu title để thống kê | 800 |
| Keyword | `pct_in_niche` để `active` | ≥ 0,70 |
| Keyword | số kênh tối thiểu cho n-gram | ≥ 4 |
| Keyword | `exhausted` khi pct < 0,50 liên tiếp | 3 lần |
| Kênh | `baseline_tier` | dead < 500 · thin 500–4999 · proven ≥ 5000 · `n<10` ⇒ dead |
| Kênh | xổ số | `max_over_median` > 50 |
| Kênh | thăng | ≥2 long-form (≥300s) **và** faceless/kể chuyện **và** ≥1 video ≥3× median regime **và** tier ≠ dead **và** không xổ số |
| Kênh | giáng | `break_ratio<1` → watch · 60 ngày không đăng → watch · watch 30 ngày không hồi → archive |
| Board | `heat` đáng chú ý | ≥ 3, `age_days` ≥ 3 |
| Insight | mẫu tối thiểu | n ≥ 15 video **và** ≥ 3 kênh, else `insufficient` |
| Insight | verdict | lift ≥ 1,20 strengthening · ≤ 0,85 weakening · còn lại flat |
| Niche | `unified` | overlap > 0,60 và engagement/duration spread < 1,5 |
| Niche | `fragmented` | overlap < 0,40 và (engagement hoặc duration spread > 1,5) |
| Opportunity | `priority_test` | **heuristic**, khởi điểm 8,0 — hiệu chỉnh mỗi vòng, ghi vào `score_reasons_json` |

---

## 8 · Architecture Decision Records — chờ xác nhận

- [ ] **ADR-1 · Vị trí dữ liệu: mở rộng `spy.sqlite` của daemon (migration v13), không tạo `research.sqlite` riêng.**
  - Rationale: lớp 0 (raw evidence) đã ở đó; FK trực tiếp tới `spy_runs`, `video_comments`; expose qua MCP `spy_*` không cần cầu nối; một nguồn sự thật.
  - Trade-off: daemon phải sống để ghi (đã là ràng buộc hiện tại của mọi tool Spy); script Python trở thành adapter mỏng gọi MCP thay vì ghi TSV.
  - Alternative bị loại: giữ TSV + Sheet (hai nguồn sự thật, đã gây lỗi); `research.sqlite` riêng (mất FK, phải sync id).
  - User confirmed: _Pending_

- [ ] **ADR-2 · `topic_channels` là Follow List — mở rộng enum `status` thành một vòng đời, không tạo bảng mới.**
  - Rationale: inbox → shortlisted → active → watch → archive là **một** vòng đời của cùng thực thể; hai bảng sẽ lặp lại lỗi "sổ song song".
  - Trade-off: SQLite phải rebuild bảng để đổi CHECK; `studied` cũ map sang `active`.
  - User confirmed: _Pending_

- [ ] **ADR-3 · Snapshot view dùng bảng mới `rs_video_observations`, không tái dụng `video_stat_points`.**
  - Rationale: `video_stat_points` gắn cứng `provider_used='ytdlp'` và `competitor_observation_runs` (owner/competitor), sai grain cho topic research. Backfill từ cả `video_snapshots` và `video_stat_points`.
  - User confirmed: _Pending_

- [ ] **ADR-4 · `rs_heat_board` materialize theo ngày, không dùng VIEW.**
  - Rationale: cần lịch sử board để kiểm chứng ngược trend claim (L6) và để so "hôm nay vs hôm qua" trong report.
  - Trade-off: thêm ~20 dòng/kênh/ngày; chấp nhận.
  - User confirmed: _Pending_

- [ ] **ADR-5 · Luồng content do người gom, một lần; không có bước auto-cluster.**
  - Rationale: đã đo auto-cluster thất bại (cụm 1.087/1.486). `rs_streams.created_by CHECK='human'` là ràng buộc cứng.
  - User confirmed: _Pending_

- [ ] **ADR-6 · Insight status là derived từ backtest mới nhất; agent không có quyền ghi `status`.**
  - Rationale: L2. Chỉ CODE ghi `rs_insight_backtests`; trigger/job cập nhật `rs_insights.status`.
  - User confirmed: _Pending_

- [ ] **ADR-7 · Tham số ngôn ngữ/thị trường theo topic (`lang_gate_json`, `region`), sửa ba bug hardcode.**
  - Rationale: repo còn phục vụ `bay-tra-gop` (vi) — không được đảo cứng `['en','vi']`.
  - Dependency: sửa `ytdlp.ts:172`, `niche.ts:209`, `spy_title_patterns` đọc regime. **Chặn mọi điểm số Spy cho topic Mỹ cho tới khi xong.**
  - User confirmed: _Pending_

- [ ] **ADR-8 · Điều phối: `spy_loop_tick(mode)` trong daemon, expose qua HTTP MCP; script Python hiện tại là adapter tạm.**
  - Rationale: `spy_loop_tick`/`spy_loop_decide` đã có nhưng chưa expose (31/56 tool). Thêm `mode ∈ {bootstrap, daily, weekly}`; bước HUMAN (B4, B7, W5) là `spy_loop_decide`/`spy_loop_inbox`.
  - Trade-off: bước AGENT (B10, B11, D6, D7) vẫn chạy ngoài daemon (skill `comment-insight`, `niche-market-map`) và ghi kết quả qua tool mới `spy_research_write(entity, payload)` có validate schema.
  - User confirmed: _Pending_

---

## 9 · Tiêu chí chấp nhận

**Bootstrap (một topic mới):**
- [ ] Sau khi chạy, `topics.niche_type ≠ 'unknown'` và `rs_niche_diagnostics` có ≥1 dòng với đủ 4 chỉ số.
- [ ] `rs_videos` ≥ 800 dòng `lang_gate='pass'`; tỉ lệ `rs_quarantine`/tổng theo `source` có trong báo cáo.
- [ ] 100% kênh `status='active'` có `current_regime_id`, `baseline_tier ≠ 'dead'`, `max_over_median ≤ 50`.
- [ ] 100% `topic_keywords` có `origin`; mọi `active` có ≥1 dòng `rs_keyword_scores` với `pct_in_niche ≥ 0,70`.
- [ ] `rs_streams` 6–10 dòng, `created_by='human'`, mỗi dòng có `gap_score` và `confidence`.
- [ ] Mọi `rs_insights.status ≠ 'candidate'` có ≥1 dòng `rs_insight_backtests`; không có insight nào `strengthening` với `n_channels < 3`.
- [ ] Mọi `rs_micro_niches` dùng trong `rs_hypotheses` có `gate6_pass=1`.

**Daily:**
- [ ] Tick ghi `loop_ticks(mode=daily)` với `steps_json` đầy đủ; pre-flight fail → có thông báo, không có dòng dữ liệu mới.
- [ ] `rs_heat_board(as_of=today)` chỉ chứa video có ≥2 observation; `launch_spike` đúng với `age_days<3`.
- [ ] Mọi đổi `topic_channels.status` do luật giáng có dòng `rs_decisions(actor='loop')` kèm `reason`.
- [ ] Chi phí ≤150 unit general + ≤10 search call (đo từ `loop_ticks`).

**Weekly:**
- [ ] Mọi kênh mới có `discovered_via` + `discovered_from`; kênh không resolve được `channel_id` có `needs_human_handle=1`.
- [ ] Kênh tier `dead` không xuất hiện trong inbox `shortlisted` nhưng vẫn tồn tại dòng `rejected(reason=dead_baseline)`.
- [ ] Báo cáo tuần có inbox yield theo `discovered_via` (baseline 3,4%).
- [ ] `rs_stream_adjacency` và `rs_streams.gap_score` có `computed_at` trong tuần.

**Di trú:**
- [ ] Đối chiếu ngược: đếm dòng + checksum cột số giữa TSV nguồn và bảng đích khớp 100%; sai lệch ghi vào `rs_decisions(reason='migration_diff')`.

---

## 10 · Sơ đồ

- Pipeline ba chế độ: `scratch/diagrams-008/diagram1-pipeline.excalidraw.json` — mở bằng excalidraw.com → Open (kéo thả file)
- ERD năm lớp: `scratch/diagrams-008/diagram2-db.excalidraw.json` — mở bằng excalidraw.com → Open (kéo thả file)

---

## 11 · Thứ tự triển khai đề xuất

| # | Việc | Chặn gì | Node |
|---|---|---|---|
| 1 | ADR-7: tham số ngôn ngữ/thị trường theo topic + sửa 3 bug | Mọi điểm số cho topic Mỹ | CODE |
| 2 | Migration v13: mở rộng 4 bảng cũ + 16 bảng `rs_*` | Mọi thứ phía sau | CODE |
| 3 | Di trú TSV/Sheet → DB + đối chiếu ngược | Daily tick | CODE |
| 4 | `spy_loop_tick(mode=daily)` D1–D5, D8; expose MCP | Board hằng ngày | CODE |
| 5 | Luật giáng tự động (D4) | Follow list tự sạch | CODE |
| 6 | `mode=weekly` W1–W4, W6, W7 + inbox `spy_loop_inbox`/`spy_loop_decide` | Kênh outlier | CODE + HUMAN |
| 7 | `spy_research_write` cho tầng AGENT + nối skill `comment-insight` vào D7/B9–B11 | Insight DB tích luỹ | CODE + AGENT |
| 8 | `mode=bootstrap` B1–B12 trọn gói cho topic mới | Topic thứ hai | CODE + HUMAN |
| 9 | Backtest insight tồn kho (5 insight, 316 comment chưa trích) | Insight DB có verdict | AGENT + CODE |

Bước 1–3 không phụ thuộc quyết định nghiệp vụ nào ngoài ADR-1/2/3/7. Bước 4 là lúc hệ thống bắt đầu có giá trị hằng ngày.
