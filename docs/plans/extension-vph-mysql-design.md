# Thiết kế: VPH hai nguồn trên MySQL 8.4 — lịch capture, bỏ rơi, ước lượng, đánh thức

Ngày: 2026-09-27 · Đi kèm `chrome-extension-yt-copilot-plan.md`
Tuân thủ: **ADR-M2** (MySQL 8.4 LTS / InnoDB), **ADR-M1** (desktop → HTTPS BFF
→ private MySQL), type policy §08 của `mysql-migration-plan.html`
Trạng thái: **DRAFT — chờ JC chốt §9**

---

## 0. Bốn quyết định cốt lõi

| # | Quyết định | Vì sao |
|---|---|---|
| **D1** | `video_observations` là **fact append-only, partition theo tháng**. Ước lượng **không bao giờ** được ghi vào đây. | Trộn số đo thật với số suy ra là hỏng vĩnh viễn — không có đường lùi |
| **D2** | `video_capture_state` là **cache mutable**, fact là sự thật. Điểm đến trễ → `needs_recompute=1`, job dựng lại. | UPSERT không thể vừa đúng vừa đơn giản khi dữ liệu đến sai thứ tự |
| **D3** | `next_capture_at` **luôn** dẫn xuất từ quan sát mới nhất, không bao giờ cộng dồn theo cron. | Đây chính là "sync theo kết quả mới nhất" JC yêu cầu |
| **D4** | "Bỏ rơi" = **hạ xuống probe 14 ngày**, không phải ngừng hẳn. | Ngừng hẳn thì mất khả năng phát hiện đột biến — mâu thuẫn với chính yêu cầu |

---

## 1. MySQL giải được đúng cái SQLite chặn

| Vấn đề ở SQLite | MySQL 8.4 |
|---|---|
| `CHECK(provider_used='ytdlp')` — **không ALTER được**, thêm nguồn phải rebuild bảng | `ENUM` thêm giá trị **ở cuối** = `ALTER ... ALGORITHM=INSTANT`. Đúng cái bẫy đã dính |
| Xoá dữ liệu cũ = `DELETE` hàng triệu dòng, khoá bảng, không trả lại đĩa | `PARTITION BY RANGE` → `DROP PARTITION`, gần như tức thì, trả đĩa ngay |
| Collation mặc định lẫn lộn hoa/thường | `ascii_bin` — **bắt buộc**: `dQw4w9WgXcQ` và `dqw4w9wgxcq` là **hai video khác nhau** |
| Không có kiểu số nguyên không dấu thật | `BIGINT UNSIGNED` |
| Không ép được kiểu cột sinh | `GENERATED ALWAYS AS (...) STORED` + index trên nó |

**Cảnh báo phải biết trước:** bảng InnoDB có **PARTITION thì không dùng được
FOREIGN KEY**. Fact table không đặt FK — ràng buộc toàn vẹn ép ở tầng BFF. Đây
là đánh đổi có ý thức: đổi FK lấy khả năng `DROP PARTITION`. Với bảng fact
append-only khối lượng lớn, đổi như vậy là đúng.

---

## 2. Fact 1 — `video_observations`

```sql
CREATE TABLE video_observations (
  video_id      CHAR(11)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observed_at   DATETIME(3) NOT NULL,                  -- UTC, luôn UTC
  source        ENUM('daily_scan','setup','weekly_search',
                     'ytdlp_watch','ext_watch','ext_feed','probe') NOT NULL,
  views         BIGINT UNSIGNED NULL,                  -- NULL khi không 'present'
  likes         BIGINT UNSIGNED NULL,
  comments      BIGINT UNSIGNED NULL,
  availability  ENUM('present','missing','private','error') NOT NULL,
  -- Cột sống còn: 'exact' = số nguyên thật; 'rounded' = text feed ("12K views")
  precision_    ENUM('exact','rounded') NOT NULL,
  obs_month     DATE GENERATED ALWAYS AS
                  (DATE_FORMAT(observed_at,'%Y-%m-01')) STORED NOT NULL,
  PRIMARY KEY (video_id, observed_at, source, obs_month),
  KEY ix_obs_month_video (obs_month, video_id)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  PARTITION BY RANGE COLUMNS (obs_month) (
    PARTITION p2026_09 VALUES LESS THAN ('2026-10-01'),
    PARTITION p2026_10 VALUES LESS THAN ('2026-11-01'),
    PARTITION pmax     VALUES LESS THAN (MAXVALUE)
  );
```

Bốn điểm cần giải thích:

- **PK clustered `(video_id, observed_at, …)`** — InnoDB gom dữ liệu vật lý
  theo PK. Truy vấn thống trị là *"đọc toàn bộ timeline của một video"*
  (tính VPH), nên gom theo `video_id` là đúng. Đánh đổi: insert rải rác gây
  tách trang. Chấp nhận — đây là bảng đọc nhiều hơn ghi.
- **`obs_month` phải nằm trong PK.** MySQL bắt mọi khoá UNIQUE/PRIMARY phải
  chứa cột phân vùng. Không phải thừa, là ràng buộc của engine.
- **`source` trong PK, cố ý.** `daily_scan` và `ext_watch` cùng một phút thì
  **giữ cả hai** — đó là điểm hiệu chuẩn chéo (§7), cách duy nhất tự phát hiện
  parser extension hỏng. Dedupe đi là mù.
- **`precision_` có gạch dưới** vì `PRECISION` là từ khoá MySQL. Không dùng
  backtick trong schema — đặt tên né hẳn.

---

## 3. Fact 2 — `suggestion_impressions`

```sql
CREATE TABLE suggestion_impressions (
  video_id     CHAR(11) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  antenna      VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observed_at  DATETIME(3) NOT NULL,
  surface      ENUM('home','watch_next','search','shorts') NOT NULL,
  position     SMALLINT UNSIGNED NOT NULL,
  channel_id   CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
  context      VARCHAR(128) CHARACTER SET utf8mb4 NULL,   -- seed videoId | query
  off_niche    TINYINT(1) NOT NULL DEFAULT 0,             -- server chấm, không tin client
  obs_month    DATE GENERATED ALWAYS AS
                 (DATE_FORMAT(observed_at,'%Y-%m-01')) STORED NOT NULL,
  PRIMARY KEY (video_id, antenna, observed_at, surface, obs_month),
  KEY ix_imp_channel_time (channel_id, observed_at),
  KEY ix_imp_time (observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  PARTITION BY RANGE COLUMNS (obs_month) (/* như trên */);
```

Bảng này nuôi phát hiện outlier sớm và xác minh thuật toán đẩy. **Không** bị
thưa dần như bảng số đo — giá trị của nó nằm ở chuỗi lịch sử dài, và nó nhỏ
hơn vài bậc.

---

## 4. Dimension — `video_capture_state` (bộ điều phối)

Một dòng một video. Đây là **hàng đợi lịch** và **bộ nhớ mô hình ước lượng**.

```sql
CREATE TABLE video_capture_state (
  video_id         CHAR(11) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  published_at     DATETIME(3) NULL,        -- chính xác tới giây, từ Data API
  state            ENUM('hot','warm','cold','dormant','archived') NOT NULL,

  -- ── Mốc quan sát mới nhất (mọi precision) ──
  last_observed_at DATETIME(3) NULL,
  last_views       BIGINT UNSIGNED NULL,

  -- ── Cặp điểm EXACT gần nhất — nguồn tính VPH, tách riêng có chủ đích ──
  last_exact_at    DATETIME(3) NULL,
  last_exact_views BIGINT UNSIGNED NULL,
  prev_exact_at    DATETIME(3) NULL,
  prev_exact_views BIGINT UNSIGNED NULL,

  vph_latest       DOUBLE NULL,
  vph_peak         DOUBLE NULL,
  vph_floor        DOUBLE NULL,             -- tốc độ đuôi bền vững
  decay_streak     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  exact_count      SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- ── Lịch: LUÔN dẫn xuất lại, không bao giờ cộng dồn (D3) ──
  next_capture_at  DATETIME(3) NOT NULL,
  policy_version   SMALLINT UNSIGNED NOT NULL,
  needs_recompute  TINYINT(1) NOT NULL DEFAULT 0,

  -- ── Mô hình ước lượng cho video đã bỏ rơi (§6) ──
  est_ref_at       DATETIME(3) NULL,
  est_ref_views    BIGINT UNSIGNED NULL,
  est_vph_ref      DOUBLE NULL,
  est_lambda       DOUBLE NULL,
  est_fitted_at    DATETIME(3) NULL,
  dormant_since    DATETIME(3) NULL,
  holdout          TINYINT(1) NOT NULL DEFAULT 0,   -- 2% đối chứng (§6.5)

  PRIMARY KEY (video_id),
  KEY ix_due (next_capture_at, state),
  KEY ix_recompute (needs_recompute)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Vì sao tách `last_exact_*` khỏi `last_*`:** một điểm `ext_feed` (rounded) đến
sau phải cập nhật "lần cuối thấy video", nhưng **tuyệt đối không** được trở
thành đầu mút của phép trừ VPH. Hai cặp cột riêng làm điều đó thành bất khả
thi về mặt cấu trúc, thay vì trông cậy vào kỷ luật của người viết truy vấn.

Và bảng nhật ký chuyển trạng thái — bắt buộc, vì luật bỏ rơi phải kiểm toán
được:

```sql
CREATE TABLE video_state_transitions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  video_id    CHAR(11) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  at          DATETIME(3) NOT NULL,
  from_state  ENUM('hot','warm','cold','dormant','archived') NULL,
  to_state    ENUM('hot','warm','cold','dormant','archived') NOT NULL,
  reason      ENUM('age','decay','abandon','wake_impression',
                   'wake_surprise','wake_manual','policy_change') NOT NULL,
  evidence    JSON NULL,       -- số liệu đã dẫn tới quyết định
  PRIMARY KEY (id),
  KEY ix_vst_video (video_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 5. Luật lịch capture — "luôn sync theo kết quả mới nhất"

### 5.1 Luật đơn điệu (đến trễ không được ghi đè)

Extension đẩy cơ hội, `daily_scan` chạy theo lịch → **chắc chắn có lúc một
quan sát cũ đến sau một quan sát mới**. Nếu UPSERT mù, state bị kéo lùi.

```sql
-- Fact: luôn ghi, bất kể thứ tự
INSERT INTO video_observations
  (video_id, observed_at, source, views, likes, comments, availability, precision_)
VALUES (?,?,?,?,?,?,?,?) AS new
ON DUPLICATE KEY UPDATE views = video_observations.views;   -- idempotent, no-op

-- State: chỉ tiến, không lùi
INSERT INTO video_capture_state
  (video_id, state, last_observed_at, last_views, next_capture_at, policy_version)
VALUES (?, 'warm', ?, ?, ?, ?) AS new
ON DUPLICATE KEY UPDATE
  last_views       = IF(new.last_observed_at > video_capture_state.last_observed_at,
                        new.last_views, video_capture_state.last_views),
  last_observed_at = GREATEST(video_capture_state.last_observed_at,
                              new.last_observed_at),
  needs_recompute  = IF(new.last_observed_at <= video_capture_state.last_observed_at,
                        1, video_capture_state.needs_recompute);
```

> Dùng cú pháp bí danh `AS new`. Hàm `VALUES()` đã **deprecated từ MySQL
> 8.0.20** — viết theo lối cũ là để lại nợ ngay lúc sinh.

**Luật D2:** quan sát đến đúng thứ tự thì cập nhật state ngay trong cùng
transaction. Đến trễ thì chỉ bật `needs_recompute=1`; một job dựng lại
`last_exact/prev_exact/vph_*` từ fact table. Không cố gói mọi trường hợp vào
một câu UPSERT — đó là chỗ đẻ ra lỗi âm thầm.

### 5.2 Hàm lịch — thuần, versioned

`next_capture_at = f(state, age, vph_latest, policy_version)`

| state | Điều kiện vào | Nhịp | Ghi chú |
|---|---|---|---|
| `hot` | tuổi < 48h, **hoặc** được đánh thức | **+3h** | giai đoạn quyết định |
| `warm` | tuổi < 7 ngày | **+24h** | |
| `cold` | tuổi < 30 ngày, đang suy giảm | **+72h** | |
| `dormant` | đạt luật §6.1 | **+14 ngày** | probe rẻ, batch 50/lời gọi |
| `archived` | tuổi > 180 ngày, vẫn dormant | **+90 ngày** | |

Hai quy tắc bổ sung:

- **Jitter tất định:** `+ INTERVAL (CRC32(video_id) MOD 37) MINUTE`. Tất định
  để tái lập được, không dùng `RAND()`.
- **`policy_version`:** đổi chính sách thì bump version, một job quét lại và
  tính lại `next_capture_at`. Không có cột này thì video cũ mắc kẹt ở lịch cũ
  vĩnh viễn và **không ai nhận ra**.

### 5.3 Hàng đợi scheduler

```sql
SELECT video_id, state FROM video_capture_state
WHERE next_capture_at <= UTC_TIMESTAMP(3)
ORDER BY next_capture_at
LIMIT 50
FOR UPDATE SKIP LOCKED;
```
`SKIP LOCKED` (MySQL 8.0+) cho nhiều worker rút cùng hàng đợi mà không giẫm
chân — thứ SQLite không có. Rút đúng 50 vì `videos.list` batch 50 = 1 unit.

---

## 6. Luật bỏ rơi, ước lượng, đánh thức

### 6.1 Điều kiện bỏ rơi — phải thoả **tất cả**

1. tuổi ≥ **14 ngày**
2. `exact_count ≥ 4`
3. `vph_latest ≤ 0.05 × vph_peak`
4. `vph_floor × 720 < 0.02 × last_exact_views` *(suy ra <2% tăng trưởng trong 30 ngày tới)*
5. `decay_streak ≥ 3` — ba segment liên tiếp không tăng

**Chặn tuyệt đối, dù đủ 5 điều trên:**
- có impression trong 7 ngày gần nhất → không bỏ rơi
- `est_lambda ≤ 0` (VPH đang **tăng**) → không bỏ rơi
- thuộc nhóm `holdout` (§6.5) → không bỏ rơi

Ghi một dòng `video_state_transitions(reason='abandon', evidence=…)` với đủ 5
con số. Quyết định không kiểm toán được thì không phải quyết định.

### 6.2 Mô hình ước lượng — suy giảm có sàn

Video hết giai đoạn đẩy **không** về 0. Nó rơi về một tốc độ nền thấp gần như
không đổi (traffic từ search/suggested). Mô hình chỉ-suy-giảm sẽ tiệm cận một
trần và **luôn ước thiếu**. Nên dùng dạng có sàn:

```
vph(t) = F + (V₀ − F) · e^(−λ·Δt)

V(t) = V_ref + F·Δt + ((V₀ − F)/λ)·(1 − e^(−λ·Δt))
```

- `F` = `vph_floor` — trung vị VPH của 3 segment gần nhất (trung vị, không
  phải min: min bắt trúng một ngày lỗi là hỏng cả mô hình)
- `V₀` = `est_vph_ref` — VPH tại `est_ref_at`
- `λ` = `est_lambda`, khớp từ hai segment cuối:
  `λ = ln((vph_a − F)/(vph_b − F)) / (t_b − t_a)`

Với video đã dormant, `Δt` lớn nên `e^(−λΔt) → 0`, trên thực tế:

```
V(t) ≈ V_dormant + F · Δt        và       vph_ước_lượng ≈ F
```

Đơn giản, trung thực, và **đúng như JC nói**: video đã hỏng thì không tăng đột
biến, nên một hằng số là đủ.

**Luật cứng:** giá trị ước lượng **không bao giờ** được ghi vào
`video_observations`. Chỉ lưu tham số mô hình trên `video_capture_state`. Đọc
ra qua view, luôn kèm cờ:

```sql
CREATE VIEW video_estimated_views AS
SELECT s.video_id,
       s.est_ref_views
         + s.vph_floor * TIMESTAMPDIFF(SECOND, s.est_ref_at, UTC_TIMESTAMP(3))/3600.0
         + ((s.est_vph_ref - s.vph_floor)/NULLIF(s.est_lambda,0))
           * (1 - EXP(-s.est_lambda
               * TIMESTAMPDIFF(SECOND, s.est_ref_at, UTC_TIMESTAMP(3))/3600.0))
         AS estimated_views,
       s.vph_floor AS estimated_vph,
       1 AS is_estimated,
       s.est_fitted_at
FROM video_capture_state s
WHERE s.state IN ('dormant','archived') AND s.est_lambda > 0;
```

### 6.3 Ba đường đánh thức, rẻ trước

| # | Kích hoạt | Chi phí | Độ trễ |
|---|---|---|---|
| **W1** | **Impression**: video dormant xuất hiện ở ≥2 ăng-ten trong 48h | **0 quota** | gần tức thì |
| **W2** | **Probe bất ngờ**: `views_thực / views_ước_lượng ≥ 1.15` **và** chênh tuyệt đối ≥ 500 view | 1/50 unit | ≤14 ngày |
| **W3** | **Cơ hội**: một điểm `ext_watch` tình cờ → cùng phép thử W2 | 0 | ngẫu nhiên |

**W1 chính là chỗ extension trả hết vốn đầu tư.** Nó bắt được cú đẩy **trước
khi** view kịp nhúc nhích — không API nào làm được, vì API chỉ biết view, còn
impression thì không ai bán.

Đánh thức → `state='hot'`, `next_capture_at=UTC_TIMESTAMP(3)`, xoá tham số
ước lượng, ghi `video_state_transitions(reason='wake_impression'|'wake_surprise')`.

### 6.4 Bất đẳng thức chi phí

Dormant probe: 10.000 video ÷ 50/lời gọi = 200 unit mỗi **14 ngày** ≈ **14
unit/ngày**. Bỏ rơi 10.000 video khỏi nhịp ngày tiết kiệm ~200 unit/ngày. Tỉ
lệ ~14:1 — luật bỏ rơi tự trả tiền cho nó, mà **vẫn giữ được đường đánh thức**.
Đây là lý do D4 chọn "hạ nhịp" thay vì "ngừng hẳn": ngừng hẳn tiết kiệm thêm
14 unit/ngày và đánh đổi bằng việc mù hoàn toàn.

### 6.5 Đo sai số của chính luật này — 2% đối chứng

Làm sao biết luật bỏ rơi không đang đánh rơi video sẽ bùng nổ? Đoán thì không
biết được. Nên: **2% video đủ điều kiện dormant được đánh dấu `holdout=1` và
giữ nguyên nhịp bình thường.**

Hàng tháng đối chiếu tăng trưởng thật của nhóm holdout với con số mô hình *đã
ước*. Ra hai chỉ số thật:
- **Sai số ước lượng** — MAPE của `estimated_views`
- **Tỉ lệ bỏ rơi nhầm** — % holdout lẽ ra phải được đánh thức mà W2 bỏ sót

Nếu tỉ lệ bỏ rơi nhầm > 2%, nới điều kiện §6.1. 2% quota đổi lấy việc biết
luật của mình sai bao nhiêu — rẻ.

---

## 7. View dẫn xuất

```sql
CREATE VIEW video_vph_segments AS
WITH pts AS (
  SELECT video_id, observed_at, views,
         LAG(views)       OVER w AS prev_views,
         LAG(observed_at) OVER w AS prev_at
  FROM video_observations
  WHERE availability = 'present'
    AND precision_   = 'exact'          -- LUẬT: rounded không vào phép trừ
    AND views IS NOT NULL
  WINDOW w AS (PARTITION BY video_id ORDER BY observed_at)
)
SELECT video_id, prev_at AS from_at, observed_at AS to_at,
       TIMESTAMPDIFF(SECOND, prev_at, observed_at)/3600.0 AS hours,
       CAST(views AS SIGNED) - CAST(prev_views AS SIGNED) AS delta_views,
       CASE
         WHEN views < prev_views THEN 'decreased'
         WHEN TIMESTAMPDIFF(SECOND, prev_at, observed_at) < 3600 THEN 'window_too_short'
         ELSE 'ok'
       END AS quality,
       CASE WHEN views >= prev_views
             AND TIMESTAMPDIFF(SECOND, prev_at, observed_at) >= 3600
         THEN (CAST(views AS SIGNED) - CAST(prev_views AS SIGNED))
              / (TIMESTAMPDIFF(SECOND, prev_at, observed_at)/3600.0)
       END AS vph
FROM pts WHERE prev_at IS NOT NULL;
```

`CAST(... AS SIGNED)` là bắt buộc: `BIGINT UNSIGNED − BIGINT UNSIGNED` khi âm
sẽ **tràn ngược** thành một số khổng lồ trong MySQL. YouTube **có** hạ view
count (lọc view giả), nên trường hợp âm chắc chắn xảy ra — không phải giả định.

Hiệu chuẩn chéo (chạy hàng ngày, cảnh báo nếu có dòng trả về):

```sql
SELECT a.video_id, a.views api_views, e.views ext_views
FROM video_observations a
JOIN video_observations e
  ON e.video_id = a.video_id
 AND e.source = 'ext_watch' AND a.source = 'daily_scan'
 AND ABS(TIMESTAMPDIFF(MINUTE, a.observed_at, e.observed_at)) < 30
WHERE a.precision_='exact' AND e.precision_='exact'
  AND ABS(CAST(a.views AS SIGNED) - CAST(e.views AS SIGNED)) > a.views * 0.01;
```

---

## 8. Vòng đời dữ liệu

| Bảng | Chính sách |
|---|---|
| `video_observations` | Giữ **13 tháng** ở nhịp đầy đủ. Tháng thứ 14 → job gom còn 1 điểm/tuần rồi `DROP PARTITION` tháng gốc. |
| `suggestion_impressions` | **Không thưa.** Nhỏ hơn vài bậc, giá trị nằm ở chuỗi dài. |
| `video_capture_state` | Một dòng/video, không bao giờ xoá. `archived` là trạng thái, không phải xoá. |
| `video_state_transitions` | Giữ vĩnh viễn — đây là bằng chứng kiểm toán luật bỏ rơi. |

Job `ADD PARTITION` chạy trước **60 ngày**. Nếu partition `pmax` bắt đầu nhận
dữ liệu, đó là sự cố vận hành — cần alert, vì không `DROP` được nữa.

---

## 9. Quyết định chờ JC

**Q1 — Ngưỡng bỏ rơi.** Đề xuất: 14 ngày / 5% peak / 3 segment giảm. Chặt hơn
= an toàn hơn nhưng tốn quota hơn. Có thể chỉnh sau bằng `policy_version`
không cần migration.

**Q2 — Nhịp probe dormant.** Đề xuất 14 ngày (≈14 unit/ngày cho 10k video).
7 ngày thì nhạy gấp đôi, tốn gấp đôi.

**Q3 — Có giữ 2% holdout không.** Khuyến nghị **có**. Đây là cách duy nhất
biết luật bỏ rơi đang sai bao nhiêu thay vì tin là nó đúng.

---

## 10. Kết luận

**CONDITIONAL PASS.**

MySQL không chỉ là đổi chỗ chứa — nó mở ra đúng bốn thứ bài toán này cần:
`ENUM` nới được (đúng cái bẫy `CHECK` đã dính), `DROP PARTITION` cho vòng đời
dữ liệu, `SKIP LOCKED` cho hàng đợi nhiều worker, và `ascii_bin` chặn va chạm
hoa/thường trên video ID.

Ba luật mới khoá vào nhau: lịch **luôn** dẫn xuất từ quan sát mới nhất (D3);
bỏ rơi là **hạ nhịp** chứ không phải mù (D4); và impression cho đường đánh
thức **0 quota, 0 độ trễ** mà không API nào bán được.

Điều kiện:
1. `precision_` và cặp `last_exact_*` tách riêng là **ràng buộc cấu trúc**,
   không phải quy ước — nếu lỏng ra, VPH sai dấu ở đúng video mới.
2. Ước lượng **không bao giờ** chạm `video_observations`.
3. Giữ 2% holdout, nếu không thì không ai biết luật bỏ rơi đang mất gì.
4. `CAST(... AS SIGNED)` ở mọi phép trừ view — tràn số không dấu là im lặng.

---

# PHẦN II — Kết hợp dữ liệu Extension × Spy local run

Chốt ngày 2026-09-28 sau trao đổi với JC. Bốn quyết định nền:
**(1)** 1 ăng-ten = 1 topic · **(2)** nâng cấp theo dõi = kênh active **hoặc**
video ≥2 ăng-ten/48h · **(3)** bộ lọc bóng đá/MV/ca nhạc là **filter key toàn
cục vĩnh viễn** cho mọi profile · **(4)** ăng-ten chính là tài khoản JC dùng
tay: cron chạy xong để live ~30 phút cho JC tự lướt.

---

## 11. Xương sống định danh — luật một khoá

### 11.1 Vết nứt đã có sẵn

`store.ts:2495` cho thấy `channels.channel_id` **không đảm bảo là UC id** — nó
có thể là định danh legacy kiểu `youtube:channel:/@name`, và `youtube_uc_id`
thì nullable. Đã phải viết logic hoà giải để một kênh không đẻ ra hai dòng.

Extension sẽ kích hoạt lỗi này hàng loạt vì card trên feed rất thường chỉ hiện
`@handle`. Hiện repo có **6 biểu diễn "một kênh"** (3 tên cột khác nhau) và
**5 biểu diễn "một video"** (`video_id` vs `source_video_id`).

### 11.2 Luật

> **UC id `CHAR(24) ascii_bin` là khoá kênh duy nhất vào spine. Video id
> `CHAR(11) ascii_bin`. Không có khoá thì không vào bảng chính.**

```sql
CREATE TABLE ext_identity_quarantine (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  observed_at  DATETIME(3) NOT NULL,
  antenna_id   VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  handle       VARCHAR(64) CHARACTER SET utf8mb4 NULL,   -- '@name'
  video_id     CHAR(11) CHARACTER SET ascii COLLATE ascii_bin NULL,
  raw_hint     JSON NULL,
  resolved_uc  CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
  resolve_state ENUM('pending','resolved','unresolvable') NOT NULL DEFAULT 'pending',
  expires_at   DATETIME(3) NOT NULL,                      -- TTL 7 ngày
  PRIMARY KEY (id),
  KEY ix_q_pending (resolve_state, expires_at),
  UNIQUE KEY uq_q_handle (handle, antenna_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Phân giải theo lô: một `video_id` bất kỳ của kênh đó → `videos.list` trả
`snippet.channelId` (UC) trong **cùng lời gọi đã tốn**, 0 unit thêm. Quá TTL
mà chưa phân giải được → `unresolvable`, xoá. Không bao giờ ghi handle vào
`topic_channels`.

*(Mẫu này không mới: `p0_corpus_memberships.identity_status
IN ('verified','needs_identity')` đã làm đúng vậy.)*

---

## 12. Mô hình ăng-ten

```sql
CREATE TABLE antennas (
  antenna_id     VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  topic_id       VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label          VARCHAR(64) CHARACTER SET utf8mb4 NOT NULL,
  branch         VARCHAR(64) CHARACTER SET utf8mb4 NULL,  -- nhánh ngách đang nuôi
  status         ENUM('active','resting','retired') NOT NULL DEFAULT 'active',
  profile_note   TEXT NULL,                                -- watch-profile khai báo
  created_at     DATETIME(3) NOT NULL,
  PRIMARY KEY (antenna_id),
  KEY ix_antenna_topic (topic_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Luật ingest:** client gửi `antenna_id`, **không bao giờ gửi `topic_id`**.
BFF tự suy topic từ `antennas`. Khớp ADR-M1 (không tin định danh do client
gửi) và loại bỏ luôn khả năng extension ghi nhầm ngách.

`antenna_id` lưu trong `chrome.storage.local` của từng Chrome profile, đặt một
lần lúc setup. Một Chrome profile ↔ một ăng-ten ↔ một topic.

### 12.1 ⚠️ Hệ quả phải biết trước: mỗi topic cần **≥2 ăng-ten**

Luật nâng cấp là *"video lạ được ≥2 ăng-ten độc lập thấy trong 48h"*. Nhưng
ăng-ten giờ thuộc về đúng một topic → **"≥2 ăng-ten" nghĩa là ≥2 ăng-ten của
cùng topic đó**. Topic chỉ có 1 ăng-ten thì luật này **không bao giờ kích hoạt**,
và topic đó mất hoàn toàn năng lực phát hiện outlier sớm — đúng thứ làm
extension khác vidIQ.

**Tối thiểu 2 ăng-ten/topic, khuyến nghị 3.** Đây là chi phí trực tiếp của
quyết định "1 ăng-ten = 1 topic": 3 ngách × 3 ăng-ten = 9 tài khoản.

### 12.2 Phiên — tách lướt máy khỏi lướt người

Vì JC dùng chính các tài khoản này để lướt tay sau khi cron xong:

```sql
CREATE TABLE antenna_sessions (
  session_id   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  antenna_id   VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind         ENUM('cron','manual') NOT NULL,
  started_at   DATETIME(3) NOT NULL,
  ended_at     DATETIME(3) NULL,
  PRIMARY KEY (session_id),
  KEY ix_sess_antenna (antenna_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Thêm `session_id CHAR(36)` vào `suggestion_impressions`.

**Vì sao bắt buộc tách:** phiên `cron` chạy theo watch-profile khai báo → là
quan sát **có kiểm soát**, dùng được để xác minh thuật toán (N3). Phiên
`manual` do JC click → feed bị chính JC lái → **không** dùng cho N3, nhưng
**rất tốt** cho discovery (N1) vì người lướt tự nhiên hơn script nhiều.

| Dùng cho | Nguồn phiên |
|---|---|
| Xác minh thuật toán đẩy (N3) | **chỉ `cron`** |
| Discovery kênh/keyword (N1) | `cron` + `manual` |
| Outlier sớm (N2) | `cron` + `manual` |
| Điểm VPH `ext_watch` | `cron` + `manual` |

### 12.3 Đính chính: tương tác **tay** không bị cấm

Bản trước tôi viết "ăng-ten cấm like/comment". **Sai phạm vi.** Cái vi phạm
điều khoản YouTube là **tự động hoá** like/comment, không phải việc JC tự tay
bấm. JC tự xem, tự like, tự subscribe trên tài khoản của mình là dùng YouTube
bình thường — và còn **làm persona tự nhiên hơn** script.

Luật đúng:
- **Cấm:** runner phát action ghi tự động. Chặn ở tầng runner, có test.
- **Cho phép, khuyến khích ghi log:** JC tương tác tay trong cửa sổ `manual`.

Ghi vào `persona_actions(antenna_id, session_id, kind, video_id, watch_sec, at)`
với `kind ENUM('watch','like','subscribe','comment','skip')`. Không phải để
kiểm soát JC — để khi feed trôi còn giải thích được **vì sao** nó trôi.

### 12.4 Kỷ luật vận hành — ràng buộc duy nhất không code được

> **Không lướt ngoài ngách trên tài khoản ăng-ten.** Muốn xem bóng đá giải trí
> thì dùng Chrome profile khác.

Một buổi tối xem bóng đá trên ăng-ten tài chính sẽ kéo feed lệch nhiều tuần, và
dữ liệu discovery của ăng-ten đó **hỏng mà không có cờ báo nào**. Không có
cách kỹ thuật nào chặn; chỉ có kỷ luật, và báo cáo drift hằng tuần (§12.5) để
phát hiện sau khi lỡ.

### 12.5 Drift — profile khai báo vs hành vi thật

Tuần một lần: đối chiếu `persona_actions` thật với `antennas.profile_note`.
Cảnh báo khi >30% thời lượng xem rơi ngoài ngách. Xử lý: cho ăng-ten
`resting` vài tuần, hoặc `retired` và nuôi cái mới.

---

## 13. Bộ lọc — hai tầng, hai vòng đời khác nhau

Theo chốt của JC: bộ lọc bóng đá / MV / ca nhạc là **filter key toàn cục, vĩnh
viễn, áp cho mọi profile** — không phải cấu hình theo từng topic.

```sql
CREATE TABLE global_exclusions (
  id         SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind       ENUM('category','term') NOT NULL,
  value      VARCHAR(128) CHARACTER SET utf8mb4 NOT NULL,
  note       VARCHAR(128) CHARACTER SET utf8mb4 NULL,
  active     TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_excl (kind, value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- category: '10' Music, '17' Sports, '20' Gaming  (snippet.categoryId)
-- term:     'official music video', 'highlights', 'full match', 'MV', ...
```

| Tầng | Phạm vi | Vòng đời | Áp ở đâu |
|---|---|---|---|
| **Toàn cục** (`global_exclusions`) | mọi topic, mọi ăng-ten | **vĩnh viễn** | client (giảm tải) → BFF (quyết định) → enrich (categoryId) |
| **Theo topic** (`anchorTerms` / `negativeKeywords` — đã có) | một topic | **hay chỉnh** | BFF |

### 13.1 Lưu trữ dòng bị lọc — suy luận từ chốt của JC

Vì bộ lọc toàn cục là **vĩnh viễn**, nó sẽ không cần chỉnh rồi chạy lại trên
dữ liệu cũ. Nên:

- Dính `global_exclusions` → **chỉ đếm, không lưu dòng**:
  `exclusion_daily(day, antenna_id, surface, reason, cnt)` — ~100 dòng/ngày
  thay vì ~50.000. Vẫn trả lời được *"YouTube đẩy bao nhiêu % rác vào feed
  ngách của tôi"* (một phát hiện N3 thật), mà không phình.
- Chỉ trượt **anchor theo topic** (không dính lọc toàn cục) → **giữ 30 ngày**
  trong partition riêng rồi `DROP PARTITION`. Vì anchor theo topic *có* được
  chỉnh, nên cần dữ liệu cũ để chạy lại.

> Đây là suy luận từ chữ "vĩnh viễn" của JC, không phải JC nói thẳng. Nếu JC
> muốn giữ cả dòng bị lọc toàn cục để sau còn truy vết, nói một tiếng — chỉ là
> đổi chính sách partition, không đổi schema.

---

## 14. Luật nâng cấp — Thấy → Theo dõi → Follow

| Tầng | Bảng | Tốn gì | Điều kiện vào |
|---|---|---|---|
| **Thấy** | `suggestion_impressions` | đĩa | qua lọc toàn cục; có `video_id` |
| **Theo dõi** | `video_capture_state` | **quota** | kênh `active` trong topic **HOẶC** ≥2 ăng-ten cùng topic thấy trong 48h |
| **Follow** | `topic_channels.status='active'` | **JC duyệt** | qua inbox HITL sẵn có |

```sql
-- Job hằng giờ: nâng "Thấy" → "Theo dõi"
INSERT INTO video_capture_state (video_id, state, next_capture_at, policy_version)
SELECT i.video_id, 'hot', UTC_TIMESTAMP(3), :pv
FROM suggestion_impressions i
JOIN antennas a       ON a.antenna_id = i.antenna_id
JOIN antenna_sessions s ON s.session_id = i.session_id
WHERE i.observed_at >= UTC_TIMESTAMP(3) - INTERVAL 48 HOUR
  AND i.off_niche = 0
GROUP BY i.video_id, a.topic_id
HAVING COUNT(DISTINCT i.antenna_id) >= 2
ON DUPLICATE KEY UPDATE video_id = video_capture_state.video_id;  -- no-op nếu đã có
```

**Luật cứng: một impression KHÔNG tự tạo `video_capture_state`.** Đây là cổng
duy nhất chặn quota. Bỏ nó là mở đường cho hàng chục nghìn video rác vào vòng
đo VPH.

Hạn mức an toàn: nâng tối đa **N video/topic/ngày** (đề xuất 50). Chạm trần →
xếp theo số ăng-ten rồi tới vị trí trung bình, phần dư để sang hôm sau. Không
có trần thì một ngày YouTube đổi thuật toán là quota bay sạch.

---

## 15. Phân vai sở hữu sự thật

| Sự thật | Chủ | Vì sao |
|---|---|---|
| Danh sách uploads của kênh | **Spy local run** | API liệt kê rẻ, đủ, ổn định |
| `published_at` chính xác tới giây | **Spy local run** | chỉ API có |
| Baseline / outlier / subscriber | **Spy local run** | cần toàn bộ lịch sử kênh |
| Transcript, comment | **Spy local run** | đắt, chỉ cho tier `core` |
| **YouTube hiển thị gì, ở đâu, cho ai** | **Extension** | không nguồn nào khác có |
| View chính xác giữa hai lần scan | **Extension** (`ext_watch`) | miễn phí, ăn theo hành vi xem |
| Kênh/keyword chưa ai biết | **Extension** | gợi ý vượt trí tưởng tượng keyword |

### 15.1 Ranh giới đóng cứng: **extension không bao giờ liệt kê**

Không quét trang `/videos` của kênh, không phân trang search để gom hết.
Extension **chỉ ghi lại thứ YouTube tự nguyện đưa ra**.

Lý do là kỹ thuật, không phải đạo đức: liệt kê bằng DOM là bản sao chậm, giòn,
tốn thời gian của thứ `daily_scan` làm tốt hơn với 1 unit cho 50 video. Cho
extension liệt kê là mở đúng cánh cửa "tràn lan" mà JC muốn đóng.

---

## 16. Bảng đối chiếu: mỗi luồng nối vào đâu

| Extension đẻ ra | Nối vào | Khoá | Cổng chặn |
|---|---|---|---|
| impression | `suggestion_impressions` | `(video_id, antenna_id, observed_at, surface)` | lọc toàn cục §13 |
| ứng viên kênh | `topic_channels` | `(topic_id, channel_id)` | **phải có UC** §11 + topic suy từ ăng-ten §12 |
| keyword mới | `topic_keywords` | `(topic_id, term_key)` | topic suy từ ăng-ten; `relation='yt_suggest'` |
| view chính xác | `video_observations` | `(video_id, observed_at, source)` | `precision_='exact'` |
| view làm tròn | `video_observations` | như trên | `precision_='rounded'`, cấm vào VPH |
| tương tác tay của JC | `persona_actions` | `(antenna_id, session_id, at)` | chỉ phiên `manual` |

---

## 17. Còn mở

- **Q4 — Trần nâng cấp/ngày/topic.** Đề xuất 50. Chốt sau khi có số thật từ M0.
- **Q5 — Giữ hay bỏ dòng dính lọc toàn cục.** §13.1 đang chọn *chỉ đếm*, suy từ
  chữ "vĩnh viễn". JC xác nhận hoặc đổi.
- **Q6 — Số ăng-ten/topic.** Tối thiểu 2 (nếu không thì mất N2 hoàn toàn),
  khuyến nghị 3. JC chốt trước khi lập tài khoản.
