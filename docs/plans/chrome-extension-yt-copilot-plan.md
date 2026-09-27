# Kế hoạch: Extension "YT Antenna" + thiết kế DB quan sát hai nguồn

Ngày: 2026-09-27 · Bản v4 (mở rộng phạm vi + đặc tả database)
Trạng thái: **DRAFT — chờ JC chốt §12**

---

## 1. Phạm vi — bốn năng lực

| # | Năng lực | Đầu ra |
|---|---|---|
| **N1** | **Discovery tự nhiên** — YouTube tự gợi ý kênh/keyword mới, extension bắt lại | nuôi Follow List + Keyword List, 0 search budget |
| **N2** | **Phát hiện outlier sớm** — video được đẩy mạnh **trước khi** view kịp tăng | tín hiệu dẫn trước, vidIQ không có |
| **N3** | **Xác minh thuật toán đẩy** — đo YouTube đẩy gì, vị trí nào, cho ăng-ten nào, theo thời gian | bằng chứng, không phải cảm tính |
| **N4** | **Lọc lạc ngách tại chỗ** — VPH + keyword filter loại MV ca nhạc, bóng đá… | feed sạch, DB không rác |

N1–N3 đều ăn từ **một bảng sự kiện hiển thị**. N4 là bộ lọc áp ở hai đầu.
Toàn bộ chỉ thêm **2 bảng fact + 2 cột** vào schema.

---

## 2. Năm nguyên tắc thiết kế DB

Mọi quyết định dưới đây suy ra từ năm nguyên tắc này. Nếu sau này phải cãi
nhau về schema, cãi ở tầng nguyên tắc.

1. **Một sự thật, một nơi.** View count là sự thật về **video**, không phải về
   topic. Không nhân bản theo topic.
2. **Fact append-only, dimension mutable.** Bảng quan sát chỉ thêm, không sửa.
   Mọi thứ suy ra được thì là VIEW, không phải cột.
3. **Độ chính xác là dữ liệu, không phải giả định.** Mỗi điểm quan sát phải tự
   khai nó chính xác hay đã làm tròn. Đây là điều kiện sống còn của VPH hai
   nguồn (§5).
4. **Quyết định của người ≠ cường độ quan sát.** `status` là HITL có audit
   trail; `tier` là vận hành, máy đổi được. Không trộn.
5. **Dữ liệu cũ mất giá nhanh.** VPH chỉ đáng giá lúc video còn trẻ. Có chính
   sách thưa dần ngay từ ngày đầu, không đợi DB phình rồi mới sửa (§9).

---

## 3. Hiện trạng — hai stack quan sát rời nhau, cả hai đều chặn

Repo đang có **hai** đường lưu view count, không biết nhau:

**Stack A — loop (topic-scoped), từ Data API**
```sql
video_daily_views(topic_id, video_id, day, views, likes, comments, captured_at)
PRIMARY KEY (topic_id, video_id, day)        -- store.ts:742
```
**Chặn ở đâu:** PK có `day` → **tối đa 1 dòng/video/ngày**. Extension lấy mẫu
nhiều lần trong ngày thì không có chỗ ghi. Và `topic_id` trong PK → cùng một
video theo dõi ở 2 topic thì lưu 2 dòng y hệt — đúng loại "data thừa" JC muốn
tránh.

**Stack B — channel watch (C1/C3), từ yt-dlp**
```sql
video_stat_points(id, observation_run_id, source_video_id, sampled_at,
  view_count, ..., availability, view_quality, provider_used, inspect_used)
provider_used TEXT NOT NULL CHECK(provider_used='ytdlp')     -- store.ts:856
observation_run_id REFERENCES competitor_observation_runs(id)
```
**Chặn ở đâu:** hai chỗ.
- `CHECK(provider_used='ytdlp')` — **SQLite không ALTER được CHECK.** Muốn thêm
  nguồn `extension` thì **bắt buộc phải rebuild bảng** (12 bước copy). Đây là
  lập luận quyết định: mở rộng bảng này *đắt bằng* việc gộp về một bảng mới,
  mà lại được ít hơn.
- Mọi điểm phải thuộc một `observation_run` khoá theo
  `(owner_channel, competitor_channel, plan_kind, local_date)`. Extension bắt
  cơ hội, không theo kế hoạch per-competitor → không nhét vào được.

**Kết luận:** không mở rộng cái nào cả. Gộp về **một bảng fact duy nhất**, và
hai bảng cũ trở thành nguồn backfill (§10).

Phần đã dùng được, giữ nguyên: `topic_channels` / `topic_keywords` (Follow List
+ Keyword List, có status HITL), `decisions` (audit trail), `topic_videos`
(denormalize cho dashboard), `anchorTerms` / `negativeKeywords` trong
`topics.settings_json`.

---

## 4. Thiết kế — 2 bảng fact, 2 cột tier

### 4.1 `video_observations` — sự thật về số đo

```sql
CREATE TABLE video_observations (
  video_id     TEXT NOT NULL,
  observed_at  TEXT NOT NULL,          -- ISO giây, UTC. KHÔNG phải ngày.
  source       TEXT NOT NULL,          -- 'daily_scan'|'setup'|'weekly_search'
                                       -- |'ytdlp_watch'|'ext_watch'|'ext_feed'
  views        INTEGER,                -- NULL khi availability<>'present'
  likes        INTEGER,
  comments     INTEGER,
  availability TEXT NOT NULL
    CHECK(availability IN ('present','missing','private','error')),
  -- NGUYÊN TẮC 3. 'exact' = số nguyên thật (Data API, yt-dlp, trang watch).
  -- 'rounded' = text feed đã làm tròn ("12K views").
  precision    TEXT NOT NULL CHECK(precision IN ('exact','rounded')),
  PRIMARY KEY (video_id, observed_at, source)
) WITHOUT ROWID;

CREATE INDEX idx_vobs_video_time ON video_observations(video_id, observed_at);
```

Bốn quyết định cần giải thích:

- **Không có `topic_id`.** Quan hệ video↔topic đã nằm ở `topic_videos`
  (PK `topic_id, video_id`). Nhét vào đây là nhân bản. *(Nguyên tắc 1)*
- **`observed_at` giây, không phải `day`.** Gộp được cả hai nhịp lấy mẫu vào
  một bảng. Tổng hợp theo ngày là `date(observed_at)` — một truy vấn, không
  phải một schema.
- **`source` nằm trong PK, cố ý.** Nếu `daily_scan` và `ext_watch` cùng báo
  trong một phút, **giữ cả hai**. Đó không phải trùng lặp — đó là **điểm hiệu
  chuẩn chéo**: hai nguồn lệch nhau nghĩa là parser extension hỏng. Dedupe đi
  là vứt mất cách duy nhất để tự phát hiện lỗi (§6.3).
- **Không lưu `view_quality`.** `decreased_vs_prior` phụ thuộc hàng xóm; chèn
  bổ sung một điểm cũ là cột đó sai. Dẫn xuất lúc đọc. *(Nguyên tắc 2)*

### 4.2 `suggestion_impressions` — sự thật về hiển thị

```sql
CREATE TABLE suggestion_impressions (
  observed_at   TEXT NOT NULL,         -- ISO giây
  antenna       TEXT NOT NULL,         -- nhãn tài khoản ăng-ten
  surface       TEXT NOT NULL
    CHECK(surface IN ('home','watch_next','search','shorts')),
  position      INTEGER NOT NULL,      -- 1-based
  video_id      TEXT NOT NULL,
  channel_id    TEXT,
  context       TEXT,                  -- seed video_id (watch_next) | query (search)
  -- server tính, client KHÔNG được tin: lệch anchor/dính negative keyword.
  off_niche     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (video_id, antenna, observed_at, surface)
) WITHOUT ROWID;

CREATE INDEX idx_imp_time     ON suggestion_impressions(observed_at);
CREATE INDEX idx_imp_channel  ON suggestion_impressions(channel_id, observed_at);
```

Đây là bảng nuôi N2 + N3. Cố ý **tách khỏi** `video_observations` vì khác hạt:
một bên là "YouTube cho tôi thấy cái này", một bên là "video này có ngần này
view". Trộn vào nhau sẽ buộc mỗi impression mang theo cột số đo rỗng.

`off_niche` giữ lại thay vì vứt: việc YouTube cứ đẩy bóng đá vào feed ngách tài
chính **chính là một phát hiện** của N3. Vứt lúc nhập thì không đo được nhiễu.

### 4.3 Hai cột `tier` — phân tầng JC yêu cầu

```sql
ALTER TABLE topic_channels ADD COLUMN tier TEXT NOT NULL DEFAULT 'pool';
ALTER TABLE topic_keywords ADD COLUMN tier TEXT NOT NULL DEFAULT 'pool';
-- giá trị: 'core' | 'pool'   (CHECK áp ở tầng code, vì SQLite không ALTER CHECK)
```

| | `core` — follow chặt | `pool` — ngách sẵn sàng |
|---|---|---|
| **Kênh: nhịp quan sát** | hàng ngày, quét hết uploads mới | hàng tuần, chỉ video mới |
| **Kênh: xử lý** | baseline + outlier + transcript/comment khi cần | chỉ view/like/comment |
| **Kênh: quota** | ~2–3 unit/ngày | ~0.4 unit/ngày |
| **Keyword: hành vi** | vào lịch `weekly_search` | không tiêu search budget; chỉ dùng để lọc, ngram, đối chiếu |
| **Dùng để** | quyết định làm video gì | biết thị trường đang có gì, so sánh, phát hiện dịch chuyển |

**Vì sao `tier` phải tách khỏi `status`** *(nguyên tắc 4)*: `decisions` đang ép
`to_status IN (active,rejected,paused)` phải có `actor='human'`. Nếu nhét
cường độ quan sát vào `status` thì mỗi lần máy hạ một kênh từ daily xuống
weekly vì hết quota, nó phải ghi một dòng quyết định giả danh người — hỏng audit
trail. Tách ra: người quyết **có theo hay không** (`status`), máy điều tiết
**theo dày hay thưa** (`tier`).

---

## 5. Quy tắc VPH hai nguồn — phần quan trọng nhất

### 5.1 Luật bất di bất dịch

> **VPH chỉ được tính giữa hai điểm `precision='exact'`. Điểm `rounded` không
> bao giờ được vào phép trừ.**

Vì sao: feed cho `"12K views"`. Giá trị thật nằm đâu đó trong 11.500–12.499.
Điểm exact sau đó là 12.437. Lấy hiệu ra `+437` — trong khi sự thật có thể là
`−63`. Sai số không chỉ lớn, nó **sai dấu**. Một VPH âm giả sẽ đi thẳng vào
dashboard trông như một video đang chết.

`rounded` vẫn lưu, và vẫn có ích: xếp hạng tương đối trên feed, phát hiện video
lạ chưa từng thấy. Nó chỉ bị cấm ở đúng một phép toán.

### 5.2 Ba nguồn, ba mức chính xác

| `source` | Lấy từ | `precision` | Nhịp |
|---|---|---|---|
| `daily_scan` | Data API `videos.list` | `exact` | 1×/ngày (tier core) |
| `ytdlp_watch` | yt-dlp (stack C1 cũ) | `exact` | theo lịch watch |
| `ext_watch` | `ytInitialPlayerResponse.videoDetails.viewCount` ở trang watch | `exact` | cơ hội, khi ăng-ten xem |
| `ext_feed` | `viewCountText` trên feed/search | `rounded` | cơ hội, mỗi lần lướt |

`ext_watch` là món hời: ăng-ten **dù sao cũng phải xem video** để nuôi persona,
mà trang watch cho số nguyên chính xác. Nuôi và đo là cùng một hành vi, thêm
điểm quan sát giữa hai lần scan ngày mà không tốn quota.

### 5.3 Segment VPH — VIEW, không phải bảng

```sql
CREATE VIEW video_vph_segments AS
WITH pts AS (
  SELECT video_id, observed_at, views,
         LAG(views)       OVER w AS prev_views,
         LAG(observed_at) OVER w AS prev_at
  FROM video_observations
  WHERE availability = 'present'
    AND precision   = 'exact'          -- §5.1
    AND views IS NOT NULL
  WINDOW w AS (PARTITION BY video_id ORDER BY observed_at)
)
SELECT
  video_id,
  prev_at     AS from_at,
  observed_at AS to_at,
  (julianday(observed_at) - julianday(prev_at)) * 24.0 AS hours,
  views - prev_views                                   AS delta_views,
  CASE
    WHEN views < prev_views                                      THEN 'decreased'
    WHEN (julianday(observed_at)-julianday(prev_at))*24.0 < 1.0  THEN 'window_too_short'
    ELSE 'ok'
  END AS quality,
  CASE
    WHEN views >= prev_views
     AND (julianday(observed_at)-julianday(prev_at))*24.0 >= 1.0
    THEN (views - prev_views)
         / ((julianday(observed_at) - julianday(prev_at)) * 24.0)
  END AS vph
FROM pts
WHERE prev_at IS NOT NULL;
```

- `vph` **NULL** khi segment không đủ tư cách, kèm `quality` nói lý do — khớp
  ngữ nghĩa `gates.ts` đã có (`deterministic` / `insufficientSample` /
  `unavailable`), không bịa số 0.
- Cửa sổ tối thiểu 1 giờ chặn luôn trường hợp hai nguồn cùng dấu thời gian
  (`hours = 0`).
- YouTube **có** hạ view count (lọc view giả) → `decreased` là chuyện bình
  thường, phải đánh dấu chứ không được để ra VPH âm.

### 5.4 VPH kiểu vidIQ chỉ cho 24h đầu

Video chưa có điểm quan sát thứ hai thì không có delta. Lúc đó mới dùng công
thức vidIQ, và phải gọi đúng tên khác:

```sql
CREATE VIEW video_vph_snapshot AS
SELECT o.video_id, o.observed_at, o.views,
       o.views / ((julianday(o.observed_at) - julianday(v.published_at)) * 24.0) AS vph_snapshot
FROM video_observations o
JOIN topic_videos v USING (video_id)
WHERE o.precision = 'exact' AND o.availability = 'present'
  AND v.published_at IS NOT NULL
  AND (julianday(o.observed_at) - julianday(v.published_at)) * 24.0 BETWEEN 0.5 AND 24.0;
```

Chặn dưới 0.5h vì tuổi ở **mẫu số**: video 15 phút tuổi mà `published_at` sai
vài phút là VPH nhảy vài lần. `published_at` phải lấy chính xác tới giây từ
Data API (`snippet.publishedAt`, 1 unit cho 50 id, cache vĩnh viễn vì không bao
giờ đổi) — **không** dùng `"3 hours ago"` của feed, cũng không dùng nhánh
date-only của `ytdlp.ts:117`.

---

## 6. Ba tín hiệu dẫn xuất

### 6.1 N2 — outlier sớm: đẩy trước khi view kịp lên

```sql
CREATE VIEW push_before_views AS
SELECT i.video_id,
       COUNT(DISTINCT i.antenna)          AS antennas_reached,
       MIN(i.position)                    AS best_position,
       MIN(i.observed_at)                 AS first_pushed_at,
       tv.published_at, tv.latest_views
FROM suggestion_impressions i
JOIN topic_videos tv USING (video_id)
WHERE i.off_niche = 0
  AND i.observed_at >= datetime('now','-48 hours')
GROUP BY i.video_id
HAVING antennas_reached >= 2;
```

Đọc là: *video được YouTube đẩy tới ≥2 ăng-ten độc lập trong 48h*. Đối chiếu
với `latest_views` sau 24h → tách được "đang được đẩy" khỏi "đã nổi rồi".
Đây là thứ vidIQ không làm được vì vidIQ không có ăng-ten trong ngách của JC.

### 6.2 N3 — xác minh thuật toán đẩy

Từ `suggestion_impressions` trả lời được, có bằng chứng:
- kênh nào chiếm bao nhiêu % số lần hiển thị, theo tuần, theo surface;
- vị trí trung bình theo kênh — YouTube đẩy lên đầu hay nhét cuối;
- `home` và `watch_next` có đẩy khác nhau không;
- một kênh mới nổi mất bao lâu từ lần xuất hiện đầu tới khi thường trú.

### 6.3 Hiệu chuẩn chéo — tự phát hiện parser hỏng

```sql
SELECT a.video_id, a.views AS api_views, e.views AS ext_views,
       ABS(a.views - e.views) AS diff
FROM video_observations a
JOIN video_observations e
  ON a.video_id = e.video_id
 AND e.source = 'ext_watch' AND a.source = 'daily_scan'
 AND ABS(julianday(a.observed_at) - julianday(e.observed_at)) * 24 < 0.5
WHERE a.precision = 'exact' AND e.precision = 'exact'
  AND ABS(a.views - e.views) > a.views * 0.01;
```

Chạy hàng ngày. Có dòng trả về = extension đang đọc sai field → cảnh báo, tự
hạ extension xuống chế độ chỉ-discovery cho tới khi sửa. Đây là lý do §4.1 giữ
`source` trong PK.

---

## 7. N4 — lọc lạc ngách, áp ở hai đầu

Cơ chế **đã có sẵn** trong `topics.settings_json`: `anchorTerms` (phải đồng
xuất hiện ≥1 term) và `negativeKeywords` (dính thì phạt fit score).

- **Đầu client (extension)** — lọc trước khi gửi, để giảm lưu lượng và giữ UI
  sạch. Title khớp `negativeKeywords` hoặc không chạm `anchorTerms` → vẫn ghi
  impression (cần cho N3) nhưng **không** tạo candidate.
- **Đầu server** — chấm lại `off_niche`, không tin client. Client chạy trong
  trang YouTube, dữ liệu nó gửi là dữ liệu chưa tin cậy.
- **Đầu enrich** — `videos.list` trả `snippet.categoryId` trong **cùng lời gọi
  đã tốn** (0 unit thêm): category 10 = Music, 17 = Sports, 20 = Gaming. Đây là
  bộ lọc cứng rẻ nhất cho đúng ví dụ JC nêu (MV ca nhạc, bóng đá).
- **Ngưỡng VPH** trên feed chỉ dùng để **sắp xếp**, không dùng để loại — vì trên
  feed nó là `rounded` (§5.1).

---

## 8. Dashboard đọc gì

Không thêm bảng nào cho dashboard. Đường đọc:

| Màn | Nguồn |
|---|---|
| VPH video theo thời gian | `video_vph_segments` |
| Bảng xếp hạng outlier | `topic_videos.outlier_score` (đã có) + `push_before_views` |
| Sức khoẻ ăng-ten | `suggestion_impressions` — kênh mới/ngày, tỉ lệ trùng giữa ăng-ten |
| Hiệu quả nguồn discovery | `topic_channels.discovered_via` × tỉ lệ được duyệt |
| Thị phần hiển thị | `suggestion_impressions` gom theo `channel_id` |
| Sức khoẻ keyword | `topic_keywords.yield_channels` / `last_median_views` (đã có) |

`topic_videos.latest_views/latest_at/views_gained_24h` giữ nguyên vai trò cache
đọc nhanh — trùng lặp **có chủ đích, một chủ sở hữu duy nhất**: cập nhật trong
cùng transaction với insert observation. Đây là ngoại lệ duy nhất của nguyên
tắc 2, và nó có lý do: dashboard không nên chạy window function trên vài triệu
dòng để vẽ một danh sách.

---

## 9. Chính sách thưa dần — "tránh data thừa" theo nghĩa vận hành

Không có bước này, bảng fact phình tuyến tính mãi mãi.

| Tuổi video | Giữ lại |
|---|---|
| < 7 ngày | mọi điểm quan sát |
| 7–30 ngày | 1 điểm/ngày (giữ điểm `exact` sớm nhất mỗi ngày) |
| 30–180 ngày | 1 điểm/tuần |
| > 180 ngày | 1 điểm/tháng |

Job dọn chạy hàng đêm, **chỉ xoá `video_observations`**, không đụng
`suggestion_impressions` (nhỏ hơn nhiều bậc và là dữ liệu lịch sử thuật toán —
giá trị của nó nằm ở chuỗi dài).

Ước tính bậc độ lớn để chốt trần: 300 kênh core × ~150 video đang hoạt động =
45k video quét ngày; 1.500 kênh pool × ~50 video = 75k video quét tuần;
extension thêm ~2k điểm/ngày. Thô ≈ 58k dòng/ngày ≈ 21 triệu/năm. Sau khi thưa
dần, trạng thái dừng còn cỡ **4–6 triệu dòng (~400 MB)** — SQLite chịu tốt.
*(Con số cần M0 đo lại trên ngách thật; ở đây chỉ để chốt rằng có chính sách
thưa dần thì bài toán nằm trong tầm, không có thì không.)*

---

## 10. Migration

1. Tạo `video_observations`, `suggestion_impressions`; `ALTER ADD COLUMN tier`
   (2 bảng). Bump `schema_version`.
2. Backfill `video_daily_views` → `(source='daily_scan', precision='exact',
   observed_at=captured_at)`.
3. Backfill `video_stat_points` → `(source='ytdlp_watch', precision='exact',
   observed_at=sampled_at)`, mang theo `availability`. Bỏ `view_quality` (dẫn
   xuất lại ở §5.3).
4. `tier`: kênh `status='active'` → `core`; còn lại giữ mặc định `pool`. JC
   chỉnh tay sau.
5. **Giai đoạn song song:** `daily_scan` ghi **cả hai** (bảng cũ + bảng mới)
   trong ≥2 tuần. Có test đối chiếu hai bên khớp nhau.
6. Chuyển `deriveVphSegment` / `getPublicChannelVph` sang đọc
   `video_vph_segments`. Giữ nguyên hình dạng API để web client không đổi.
7. Sau khi khớp, ngừng ghi bảng cũ. **Chưa xoá** — giữ thêm một chu kỳ.

Rủi ro migration thấp vì bước 5 không phá gì; sai thì dừng ở bước 6.

---

## 11. Lộ trình

### M0 — Spike (1 ngày) · **GATE**
- **AC0.1** Trích được từ `ytInitialData`: `videoId`, `channelId`, vị trí trên
  `home` và `watch_next`. Và `videoDetails.viewCount` chính xác ở trang watch.
- **AC0.2** **Số quyết định dự án:** một phiên lướt 30 phút trên tài khoản đã
  nuôi ngách đẻ ra **bao nhiêu kênh chưa có trong topic**? < 3 → đòn bẩy quá
  yếu, dừng, chỉ cần tăng `dailySearchBudget`.
- **AC0.3** Đo quota thực `daily_scan`/kênh/ngày → chốt trần số kênh core+pool.
- **AC0.4** Ước lại dòng/ngày với ngách thật → chốt bảng thưa dần §9.

### M1 — Schema + migration (2–3 ngày)
- **AC1.1** Hai bảng + hai cột `tier` + backfill; `schema_version` bump.
- **AC1.2** `video_vph_segments`, `video_vph_snapshot`, `push_before_views`.
- **AC1.3** Test: điểm `rounded` **không bao giờ** xuất hiện trong
  `video_vph_segments` — kể cả khi nó là điểm duy nhất của video.
- **AC1.4** Test: `views` giảm → `quality='decreased'`, `vph IS NULL`.
- **AC1.5** Test: hai nguồn cùng dấu thời gian → 0 segment, 2 dòng fact.
- **AC1.6** Ghi song song bật; test đối chiếu cũ/mới khớp.

### M2 — Extension thu, lướt tay (2–3 ngày)
- **AC2.1** Content script ghi `suggestion_impressions` + `ext_feed`/`ext_watch`.
- **AC2.2** `POST /api/spy/observations` idempotent theo PK; chỉ whitelist
  field; server tự chấm `off_niche`, không tin client.
- **AC2.3** Kênh mới → `topic_channels` status `new`, tier `pool`,
  `discovered_via='browser_suggest'`; keyword mới → `pending`,
  `relation='yt_suggest'` *(enum đã có sẵn)*. Hiện trong `/loop/inbox` sẵn có,
  **không dựng UI mới**.
- **AC2.4** Contract test parse ≥95% trên fixture home/search/watch đã commit;
  < 90% lúc chạy → tự tắt, không đẩy rác.

### M3 — Overlay lọc tại chỗ (2 ngày) — N4
- **AC3.1** Badge VPH (nhãn đúng theo `precision`), điểm liên quan keyword.
- **AC3.2** Ẩn/làm mờ item `off_niche`. Bật/tắt được.
- **AC3.3** Thiếu dữ liệu → hiện `—` + tooltip lý do, không đoán.

### M4 — Ăng-ten tự động + hiệu chuẩn (3–4 ngày)
- **AC4.1** 3 tài khoản, 3 nhánh watch-profile, phiên hàng ngày, log
  `persona_actions`.
- **AC4.2** Ăng-ten **không thể** phát action ghi — chặn ở tầng runner, có test.
- **AC4.3** Hiệu chuẩn chéo §6.3 chạy hàng ngày; lệch >1% → cảnh báo + tự hạ
  extension xuống chế độ chỉ-discovery.
- **AC4.4** Job thưa dần §9 + test giữ đúng số điểm theo từng bậc tuổi.
- **AC4.5** Báo cáo 7 ngày: kênh mới/ngày, tỉ lệ duyệt, tỉ lệ trùng ăng-ten.

### M5 — Dashboard (2 ngày)
- **AC5.1** Sáu màn §8, đọc thẳng từ view, không thêm bảng.
- **AC5.2** Mọi số VPH hiện kèm nhãn nguồn + `precision` + cỡ mẫu.

### M6 — *(tách riêng)* like/comment — xem §13 R1.

---

## 12. Quyết định chờ JC

**Q1 — Trần `core` và `pool`.** Đề xuất khởi điểm 300 core / 1.500 pool, chốt
lại sau AC0.3. JC muốn khác thì nói ngay, nó quyết chính sách thưa dần.

**Q2 — Ngách + 3 nhánh watch-profile.** Cần để nuôi ăng-ten; M0–M1 chạy được
trước khi có.

**Q3 — Có bật like/comment không.** Khuyến nghị tách hẳn khỏi luồng này.

---

## 13. Rủi ro

**R1 — Automation like/comment vi phạm điều khoản YouTube.** Xếp vào spam/
engagement giả; hậu quả: comment bị gỡ âm thầm, kênh dính strike, khoá tài
khoản. Kế hoạch này không bao gồm phần né phát hiện. Nếu bật: tài khoản riêng,
không bao giờ là tài khoản ăng-ten — trộn vào là hỏng cả hai.

**R2 — Trộn nhầm `rounded` vào VPH.** Hậu quả nặng vì **sai dấu**, không chỉ
sai số. Chặn bằng AC1.3, và bằng việc `precision` là cột NOT NULL chứ không
phải quy ước.

**R3 — Bão hoà gợi ý.** Sau vài tuần YouTube quanh quẩn cùng nhóm kênh → kênh
mới/ngày về 0. Khả năng cao nhất. Theo dõi bằng AC4.5; ăng-ten là vật tư tiêu
hao, cần kế hoạch xoay vòng từ đầu.

**R4 — `ytInitialData` đổi cấu trúc.** Chắc chắn xảy ra. Contract test +
self-check + hiệu chuẩn chéo §6.3.

**R5 — Bảng fact phình.** Chặn bằng §9. Không có job thưa dần thì đây là rủi
ro chắc chắn xảy ra, chỉ là chậm.

**R6 — Rò dữ liệu phiên.** Chỉ whitelist field; tuân nguyên tắc
`normalizedEvidence` đã có trong codebase.

---

## 14. Kết luận

**CONDITIONAL PASS.**

Điểm cốt lõi của thiết kế DB: **một bảng fact số đo + một bảng fact hiển thị**,
thay vì mở rộng hai stack rời nhau đang có. Lập luận quyết định là kỹ thuật,
không phải thẩm mỹ: `video_stat_points` có `CHECK(provider_used='ytdlp')` mà
SQLite không ALTER được CHECK → thêm một nguồn **bắt buộc rebuild bảng**, đắt
ngang việc gộp mà được ít hơn. Còn `video_daily_views` có `day` trong PK nên
về nguyên lý không chứa nổi lấy mẫu nhiều lần/ngày.

Cột `precision` là thứ làm cho VPH hai nguồn đúng được. Không có nó thì mọi
thứ vẫn chạy, dashboard vẫn ra số, và số đó sai dấu ở đúng những video JC quan
tâm nhất — video mới.

Điều kiện:
1. **AC0.2 là gate thật.** < 3 kênh mới/phiên thì dừng, đừng xây tiếp.
2. Bật ghi song song ≥2 tuần trước khi chuyển đọc sang bảng mới.
3. Job thưa dần làm ngay ở M4, không để nợ.
4. Ăng-ten tách hẳn khỏi mọi automation ghi.
