---
title: "Spy MCP — đối chiếu năng lực với vidIQ MCP"
status: P0 done · P1 chờ chọn
date: 2026-08-10
owner: Claude
scope: packages/spy (MCP tools), không đụng Team MCP
---

# Spy MCP vs vidIQ MCP — bản đồ năng lực & lộ trình

Tài liệu này trả lời một câu hỏi: **trong 49 tool của vidIQ, cái nào spy làm được ngay, cái nào cần hạ tầng mới, cái nào không nên đụng vào.**

Phương pháp: 3 teammate chạy song song — 2 agent load schema thật của cả 49 tool vidIQ (gọi thật 6 tool miễn phí để xem payload), 1 agent đọc toàn bộ 39 file `packages/spy/src/**`. Các claim về code spy đã được verify lại bằng grep trực tiếp.

---

## 0. Kết luận trước, chi tiết sau

**Moat thật của vidIQ chỉ nằm ở 3 chỗ**, và cả 3 đều là "kho dữ liệu quy mô toàn cầu", không phải thuật toán:

1. **Keyword search volume** — YouTube không public con số này. vidIQ ước lượng từ autocomplete + clickstream + crawl. Không clone được.
2. **Index video/kênh toàn cầu có gán nhãn ML** — niche, faceless, breakout, trend-category, embedding title/thumbnail của hàng chục triệu video. Không clone được ở quy mô đó.
3. **Time-series view của mọi video** — phải poll liên tục hàng triệu video. **Clone được ở phạm vi hẹp** (chỉ các kênh bạn theo dõi) và đây là cơ hội lớn nhất của spy.

Mọi thứ còn lại của vidIQ hoặc là (a) wrapper YouTube Data API mà spy tự gọi được, (b) tính toán suy ra được, (c) proxy có markup lên ElevenLabs/Sora/model ảnh, hoặc (d) proxy YouTube Analytics API — mà bạn OAuth thẳng thì có số liệu thật, miễn phí.

**Bức tranh tổng:** trên 49 tool vidIQ — spy đã có tương đương **6**, làm được ngay **13**, cần hạ tầng mới nhưng khả thi **11**, chỉ làm được một phần **7**, không nên clone **12**.

Một điểm cần nói thẳng: **spy hiện có 23 tool nhưng 6 trong số đó đang trả rác** (chi tiết §5). Sửa 6 chỗ đó cho ~1.5 ngày công còn tăng giá trị nhanh hơn việc thêm 10 tool mới.

---

## 1. Bốn tầng nguồn dữ liệu

Mọi tool vidIQ đều rơi vào một trong bốn tầng này. Biết tầng là biết ngay spy có làm được không.

| Tầng | Là gì | vidIQ | spy làm được? |
|---|---|---|---|
| **(a) YouTube Data API công khai** | videos.list, channels.list, search.list, commentThreads.list, caption | 5 tool | ✅ Có key, adapter đã chạy. Chỉ là viết thêm hàm |
| **(b) Kho dữ liệu độc quyền** | keyword volume, index kênh/video toàn cầu, embedding thumbnail, time-series view toàn cầu, trend taxonomy | 11 tool | ❌ toàn cầu / ⚠️ được trong phạm vi corpus của mình |
| **(c) Suy ra bằng tính toán** | VPH, outlier score, earnings estimate, title/thumbnail score | 5 tool | ✅ Toán học công khai, spy đã có sẵn phần lớn |
| **(d) OAuth chủ kênh** | retention, traffic source, demographics, revenue thật | 5 tool | ✅ Miễn phí, chỉ cần làm OAuth flow |
| **(gen) Model sinh nội dung** | video, ảnh, nhạc, TTS, render | 15 tool | ✅ Gọi thẳng provider, rẻ hơn vidIQ / ⚠️ nhưng thuộc lane khác |

Con số đáng chú ý về credit vidIQ: tài khoản của bạn còn **1203 credit**, reset 04/09. Hầu hết tool research = 5 credit → còn ~240 lần gọi. `video_watch` = 25 credit. Nếu spy tự làm được nhóm (a) và (c), bạn tiết kiệm được phần lớn quota đó cho đúng 3 thứ vidIQ độc quyền.

---

## 2. Bản đồ 49 tool vidIQ → spy

Ký hiệu: **✅ ĐÃ CÓ** · **🟢 LÀM NGAY** (≤1 ngày, không cần hạ tầng mới) · **🟡 PHASE SAU** (cần hạ tầng: poller / OAuth / LLM thật / embedding) · **🟠 MỘT PHẦN** (làm được bản hẹp, không bằng vidIQ) · **🔴 KHÔNG NÊN**

### 2.1 Metadata công khai — wrapper YouTube Data API

| vidIQ | Tương đương spy | Trạng thái | Ghi chú |
|---|---|---|---|
| `video_transcript` | `spy_transcript_fetch` + `spy_get_transcript` + `spy_transcript_search` | ✅ **spy mạnh hơn** | spy ưu tiên manual > auto, chọn `<lang>-orig`, de-dup rolling caption (`overlapLength`), có FTS5 search, lưu DB. vidIQ chỉ trả text và tính 5 credit |
| `get_videos_by_ids` | `data-api.fetchVideoStatistics` | 🟢 | Hàm đã tồn tại, batch 50 id/call, 1 quota unit. Chỉ thiếu lớp MCP tool. **~1 giờ** |
| `get_channels_by_ids` | `data-api.fetchChannelStatistics` | 🟢 | Y hệt trên. **~1 giờ** |
| `video_comments` | — | 🟢 | Thêm `commentThreads.list` vào adapter. 1 unit/call. **~3 giờ.** Đáng làm: comment là nguồn "khán giả tự nói ra điều họ muốn xem tiếp" — cực hợp lane writer |
| `youtube_search` | — | 🟢 | `search.list`. ⚠️ **100 quota unit/call** — đắt gấp 100 lần các call khác. Bắt buộc kèm cache + đếm quota, nếu không 1 ngày chỉ được 100 lần search |

### 2.2 Chỉ số suy ra — spy đã có nền toán

| vidIQ | Tương đương spy | Trạng thái | Ghi chú |
|---|---|---|---|
| `channel_videos` (VPH, breakout score) | `spy_channel_videos` | ✅ ~85% | spy đã có `velocity` (= views/tuổi) và `engagement`. VPH chỉ là velocity đổi đơn vị giờ |
| `outliers` (trong 1 kênh) | `spy_channel_outliers` | ✅ nhưng **ĐANG HỎNG** | spy dùng **modified z-score theo age cohort** (`(v−median)/(1.4826×MAD)`) — về mặt thống kê chuẩn hơn cách so với "trung bình kênh". Nhưng tool đang so object với số → luôn trả `[]`. **Sửa 1 dòng** |
| `score_title` | `metrics/title.ts` | 🟢 | Đã có 13 title feature + `computeTokenLift` + `computeFeatureLift`. Ghép lại thành điểm 0-100. **Điểm khác biệt: spy chấm so với baseline CHÍNH kênh đó**, còn vidIQ chấm so với global — với kênh niche hẹp, baseline riêng đúng hơn |
| `earnings_calculate` / `video_earnings_estimate` | — | 🟠 | Chỉ là `views × RPM(category, country)`. Bảng RPM phải tự nhập tay từ nguồn public → sai số lớn. **Làm được trong 1 ngày, nhưng giá trị thấp** |
| `channel_stats` (snapshot) | `channels` table | ✅ | Đã lưu sub/view/videoCount |
| `channel_stats` (growth từ→đến) | — | 🟡 | Cần time-series → xem §3 |

### 2.3 Time-series — **cơ hội lớn nhất**

| vidIQ | Trạng thái spy | Ghi chú |
|---|---|---|
| `video_stats` (hourly/daily/monthly history) | 🟡 **Phase 1** | vidIQ có vì poll toàn cầu. Bạn chỉ cần poll ~vài trăm kênh mình theo dõi |
| `channel_performance_trends` (đường cong view tích lũy sau publish) | 🟡 **Phase 1** | Cùng hạ tầng. Đây là chỉ số quyết định "video này 24h đầu có on-track không" |
| `trending_videos` (VPH realtime toàn cầu) | 🟠 | Bản hẹp: `videos.list?chart=mostPopular&regionCode=VN` — 1 unit, nhưng chỉ ~200 video/quốc gia, không filter được như vidIQ |

**Tại sao khả thi:** quota Data API mặc định 10.000 unit/ngày. Poll 2.000 video mỗi giờ = 40 call `videos.list` (batch 50) = 40 unit/giờ = **960 unit/ngày, chưa tới 10% quota**. Dữ liệu vật lý **đã tồn tại ngầm** trong spy — mỗi `spy_channel_start` tạo một `spy_runs` mới với `video_snapshots` mang `created_at` + `view_count` riêng. Chỉ là chưa ai đọc nó theo trục thời gian (`getLatestMetrics` luôn `LIMIT 1`).

Cần: bảng `video_stat_points(source_video_id, sampled_at, views, likes, comments)` + một cron poller + 3 tool đọc. Ước ~3-4 ngày. Sau đó spy có thứ mà vidIQ **không có**: đường cong view độ phân giải cao cho đúng tập kênh bạn quan tâm, lưu vĩnh viễn, không tốn credit.

### 2.4 Khám phá / index toàn cầu

| vidIQ | Trạng thái | Ghi chú |
|---|---|---|
| `keyword_research` (volume, competition, rising) | 🔴 | Không clone được. Thay thế gần nhất: YouTube autocomplete (`suggestqueries`) cho ra **gợi ý keyword** nhưng **không có volume**. Đây là lý do duy nhất đáng giữ subscription vidIQ |
| `trend_categories` (90 format taxonomy) | 🟡 **đáng làm** | vidIQ tự định nghĩa taxonomy rồi gán nhãn bằng ML. Bạn làm y hệt được ở quy mô nhỏ: tự viết ~30 format hợp niche storytelling của mình, gán nhãn bằng LLM trên corpus đã spy. **Chất lượng có thể cao hơn** vì taxonomy khớp đúng lĩnh vực của bạn thay vì 90 slug chung chung |
| `channel_search` (semantic + filter niche/faceless/breakout) | 🔴 toàn cầu / 🟠 nội bộ | Cần index kênh toàn cầu. Bản hẹp: index các kênh đã spy + kênh phát hiện qua comment/collab |
| `similar_channels` | 🔴 / 🟠 | Như trên |
| `similar_videos` (fuse title + thumbnail) | 🟠 **corpus nội bộ** | spy **đã tải và lưu thumbnail** (content-addressed artifact) + có transcript. Embedding trong corpus của mình là làm được. So với toàn cầu thì không |
| `similar_thumbnails` (CLIP visual) | 🟠 corpus nội bộ | Như trên. Hiện spy có dHash nhưng chỉ dùng để loại frame trùng, chưa từng đem so thumbnail |
| `outliers` cross-channel toàn cầu | 🔴 / 🟠 | Trong corpus của mình thì được, và với niche hẹp thì đó có khi là đủ |

### 2.5 OAuth — số liệu thật của kênh bạn

| vidIQ | Trạng thái | Ghi chú |
|---|---|---|
| `channel_analytics` (retention, traffic source, demographics, revenue) | 🟡 **Phase 2, giá trị rất cao** | vidIQ chỉ là **proxy** YouTube Analytics API và tính 5 credit/call. Bạn OAuth thẳng → số liệu **giống hệt, miễn phí, không giới hạn**. Đây là dữ liệu duy nhất trong toàn bộ danh sách vừa chính xác tuyệt đối vừa không ai độc quyền được |
| `user_channels` | 🟢 sau khi có OAuth | Trivial |
| `list_competitors` / `update_competitors` | 🟢 | Chỉ là một bảng DB. **~2 giờ**. Không cần OAuth nếu bạn tự quản danh sách |
| `subscriber_insights` — best time to post | 🟡 | Làm được từ Analytics API |
| `subscriber_insights` — audience overlap | 🔴 | Phần này vidIQ lấy từ crawl subscription công khai, không có trong Analytics API |

### 2.6 Sinh nội dung — phần lớn không thuộc spy

| vidIQ | Trạng thái | Ghi chú |
|---|---|---|
| `video_watch` (AI xem video, mô tả từng cảnh, 25 credit) | 🟡 **đáng làm, rẻ hơn nhiều** | spy **đã có `FfmpegAdapter.extractFrames` hoàn chỉnh nhưng là code chết** (không caller nào, `frameStatus` luôn `'skipped'`). Hồi sinh nó + đẩy frame vào Gemini/Claude vision = có `video_watch` với giá vài cent thay vì 25 credit |
| `watch_shortform_content` | 🟡 | Cùng hạ tầng |
| `generate_titles` | 🟢 | LLM + context từ `title_patterns` và `voice_profile` của spy. **Có thể hơn vidIQ** vì có voice profile của đúng kênh |
| `score_thumbnail` | 🟠 | Không có benchmark CTR. Bản thay thế: chấm heuristic + so với thumbnail của các outlier trong chính niche mình |
| `generate_script` | 🔴 (trùng lặp) | writer-room đã có lane Writer/Training. Đừng làm trong spy |
| `generate_thumbnail` / `refine_thumbnail` | 🔴 với spy | Gọi model ảnh trực tiếp thì rẻ hơn 22 credit — nhưng thuộc lane production |
| `voiceover_generate` / `list_voices` | 🔴 với spy | **Backend vidIQ chính là ElevenLabs** (verify được: voiceId `EXAVITQu4vr4xnSDxMaL` = Sarah, preview URL trỏ `api.us.elevenlabs.io`). vidIQ tính 14 credit/1000 ký tự = markup thuần. Gọi ElevenLabs trực tiếp |
| `generate_video` / `generate_music` / `generate_clips` / `generate_broll` | 🔴 với spy | Lane production |
| `compose` / `motion_graphics` / `edit_media` | 🔴 với spy | Lane production. Ghi chú: cả 3 chỉ là **ffmpeg-as-a-service** — spy đã có `FfmpegAdapter`, chạy local thì miễn phí và không hết hạn signed URL |
| `job_poll` / `jobs_list` | ✅ | `spy_get_status` / `spy_wait` / `operations` table đã tương đương |
| `balance` / `submit_feedback` | 🔴 | Không áp dụng |
| 5 tool Instagram / TikTok | 🔴 | Cần crawl 2 nền tảng mới. Dự án riêng |

---

## 3. Lộ trình đề xuất

### P0 — Sửa nợ + hái quả thấp · ✅ XONG 2026-08-10
Không thêm năng lực mới, chỉ làm cho cái đã có chạy thật.

- [x] `spy_channel_outliers` — đọc `MetricValue.value` thay vì so object với số; thêm `unscored` để mục không chấm được không bị lọc im lặng
- [x] `spy_wait` — bỏ clamp 60s, thêm hằng `MAX_WAIT_MS = 600_000` khớp với trần tool khai báo
- [x] `ProfileService` ghi vào bảng `profiles` (hooks/topics/voice/structure/outlier); `spy_channel_profile` thêm `voice`, `profileModel`, `missingProfiles`
- [x] `spy_compare` áp dụng `dimensions` thật + bảng so ngang min/max/spread/ratio + cờ `missing`; `spy_channel_diff` trả delta/ratio từng field, `topDivergence`, và token tiêu đề riêng mỗi bên
- [x] `config.concurrency` nối vào `HarvestService` (default schema 1 → 3 để giữ nguyên hành vi cũ)
- [x] 5 tool mới: `spy_videos_by_ids`, `spy_channels_by_ids`, `spy_video_comments` (`commentThreads.list` mới trong adapter), `spy_competitors_list`, `spy_competitors_update` (bảng `competitors`, schema v2 → v3)
- [x] Thiếu API key giờ báo `capability_missing` thay vì trả rỗng im lặng

**Kiểm chứng:** `packages/spy/test/p0-fixes.test.ts` — 16 test, **fail toàn bộ trên code cũ, pass toàn bộ sau khi sửa**. Tổng suite spy: 51 pass / 0 fail. `tsc --noEmit` sạch.
Chạy trong container cloud (bun 1.3.13) — hãy chạy lại `bun test packages/spy` trên máy để xác nhận.

**Phát hiện thêm khi viết test:** `defaultConfigPath()` ghi config vào **thư mục cha** của `dataRoot`. Đúng trong production (`<data>/spy` → `<data>/config`), nhưng test truyền thẳng một temp dir sẽ làm config rò ra `/tmp/config/spy.json` và lây giữa các test.

### P1 — Time-series riêng · ~4 ngày · **ưu tiên cao nhất**
Thứ duy nhất trong nhóm (b) mà bạn clone được, và nó là nền cho mọi phân tích tăng trưởng về sau.

- [ ] Bảng `video_stat_points` + cron poller (~960 quota unit/ngày cho 2.000 video/giờ)
- [ ] `spy_video_stats` — chuỗi view/like/comment + VPH theo giờ/ngày
- [ ] `spy_channel_performance_trends` — đường cong view tích lũy sau publish, có percentile
- [ ] `spy_channel_stats(from, to)` — growth thật thay vì snapshot
- [ ] Cảnh báo "video này đang dưới/trên đường cong chuẩn của kênh"

### P2 — LLM thật + trí tuệ trên corpus · ~1 tuần
Hiện `DeterministicStubLlm` trả template cứng (`persona: 'clear'`, đúng 1 topic cluster tên `'General topics'`) → **4 tool phân tích của spy đang vô dụng**.

- [ ] Adapter LLM thật (`analyzeHooks`, `analyzeVoice`, `analyzeStructure`, `analyzeTopics`, `analyzeOutlier`) — hạ tầng chống bịa `validateEvidenceRefs` **đã có sẵn và làm rất tốt**, chỉ thiếu model
- [ ] Trend taxonomy riêng cho niche của bạn (~30 format) + gán nhãn corpus bằng LLM
- [ ] Hồi sinh `FfmpegAdapter.extractFrames` (code chết) → `spy_video_watch` bằng VLM
- [ ] Embedding corpus nội bộ → `spy_similar_videos` / `spy_similar_thumbnails` trong phạm vi kênh đã spy
- [ ] `spy_score_title` (chấm theo baseline chính kênh đó)

### P3 — OAuth Analytics · ~4 ngày
- [ ] OAuth flow + `spy_channel_analytics` (retention, traffic source, demographics, revenue thật)
- [ ] `spy_best_time_to_post`

### Không làm
`keyword_research` (volume), `channel_search`/`similar_channels` toàn cầu, `audience_overlap`, toàn bộ IG/TikTok, toàn bộ nhóm generate media (thuộc lane production, không thuộc spy).

---

## 4. Nếu chỉ chọn một

**P1 (time-series).** Lý do: nó là năng lực duy nhất vừa nằm trong nhóm "độc quyền" của vidIQ vừa clone được ở phạm vi bạn cần, chi phí quota gần như bằng 0, và một khi có chuỗi thời gian thì outlier score, growth, breakout detection, cảnh báo — tất cả đều trở nên chính xác hơn hẳn so với việc chỉ có một điểm tĩnh `views/tuổi`.

Nhưng **P0 phải làm trước** dù chọn gì, vì 6 tool đang trả rác sẽ làm nhiễu mọi thứ xây bên trên.

---

## 5. Nợ kỹ thuật đã verify (grep trực tiếp, không suy đoán)

| # | Vấn đề | Vị trí | Hệ quả |
|---|---|---|---|
| 1 | `outlierScore` là `MetricValue<{value, method}>` nhưng bị so sánh như số | `index.ts:295` vs `metrics/performance.ts:146,159` | `spy_channel_outliers` **luôn trả `[]`** |
| 2 | `wait` kẹp `Math.min(timeoutMs, 60_000)` | `operations.ts:121` | Tool khai báo trần 600s nhưng thực tế 60s |
| 3 | `saveProfile()` không có caller nào | `store.ts:895` | Bảng `profiles` luôn rỗng → `spy_channel_profile` trả `hooks: null, topics: null` |
| 4 | `dimensions` bị bỏ qua hoàn toàn | `index.ts:333-342` | `spy_compare` chỉ echo lại tham số |
| 5 | `extractFrames` không có caller, `frameStatus` luôn `'skipped'` | `acquisition.ts:40` | Bảng `frame_samples` rỗng → `VideoMetrics.visual` **luôn `null`** |
| 6 | `config.concurrency` không được dùng ở đâu | `schema.ts:323` vs `harvest.ts:147` | Cấu hình giả; acquisition chạy tuần tự hoàn toàn |
| 7 | `DeterministicStubLlm` là implementation duy nhất | `adapters/llm.ts` | `spy_hook_taxonomy`, `spy_video_structure`, `spy_topic_clusters`, `spy_voice_profile` trả template |
| 8 | Không có quota tracking / retry cho Data API | `adapters/data-api.ts:141` | Đánh dấu `retryable` nhưng không nơi nào retry. Nguy hiểm khi thêm `search.list` (100 unit/call) |

---

## 6. Điểm spy đang làm tốt hơn vidIQ (đừng đánh mất khi refactor)

- **Evidence validation** — `validateEvidenceRefs` bắt mọi claim của LLM phải neo vào `segmentId`/`frameId`/`quote` có thật trong run, ném `insufficient_evidence` nếu không. vidIQ không có gì tương đương.
- **Sample gates** — `MIN_VIDEOS_FOR_DISTRIBUTION = 8`, `MIN_VIDEOS_FOR_CORRELATION = 12`, kiểu `MetricValue{method: deterministic|proxy|insufficient_sample}` → spy **từ chối trả số khi mẫu quá nhỏ** thay vì bịa. vidIQ trả số trong mọi trường hợp.
- **Transcript pipeline** — ưu tiên manual > auto, chọn `<lang>-orig`, de-dup rolling caption. vidIQ chỉ trả text thô.
- **Artifact store** — content-addressed, ghi atomic, chống path traversal, verify sha256 khi đọc.
- **Source Pack gắn nhãn UNTRUSTED** + cảnh báo prompt injection.
- **Outlier score theo age cohort với modified z-score** — đúng thống kê hơn "so với trung bình kênh".

Không có cái nào trong 6 điểm này xuất hiện ở vidIQ. Nếu mục tiêu là "spy y hệt vidIQ" thì cần nói rõ: về **độ trung thực của số liệu**, spy đang ở trên.
