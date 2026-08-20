> **Agent:** codex
> **Status:** planned — M0 complete; M1–M5 await selection
> **Owns:** Roadmap và acceptance criteria cho Spy intelligence / Writer Spy MCP.
> **Does not touch:** Writer generation, media production, global crawling, hoặc triển khai ngay trong plan này.
> **Depends on:** `plan/claude/spy-discovery-design.md`, `packages/spy/**`, `packages/daemon/src/spy-mcp.ts`.

# Spy Intelligence — roadmap học từ vidIQ, làm theo corpus của mình

**Ngày khảo sát:** 2026-08-19  
**Mục tiêu:** Chọn từng năng lực vidIQ có giá trị cho Writer Room, xây bản hẹp trên dữ liệu Spy sở hữu, và không biến Spy thành bản sao của một nền tảng dữ liệu toàn cầu.

## 1. Kết luận quyết định

vidIQ có ba lợi thế khó sao chép ở quy mô toàn cầu: ước lượng keyword demand, index kênh/video/thumbnail khổng lồ, và time-series view được thu liên tục. Spy không cần bắt chước quy mô đó.

Hướng đúng là **Spy Intelligence for our corpus**:

1. Thu thập và giữ transcript/evidence của các kênh đã chọn.
2. Tích luỹ snapshot chỉ số cho corpus đó.
3. Tìm outlier, pattern nội dung, đối thủ và cơ hội viết có evidence.
4. Chỉ đưa các kết quả đã có provenance sang Writer Room.

Với keyword volume toàn YouTube hoặc similar search trên toàn thị trường, duy trì vidIQ như nguồn bên ngoài khi thật sự cần; không gắn nhãn kết quả thay thế là “volume” hay “global”.

## 2. Baseline đã xác nhận

| Vùng năng lực | Core Spy | Writer Spy MCP đang expose | Nhận định |
| --- | --- | --- | --- |
| Channel/video acquisition, transcript, run manifest | Có | Có | Dùng được ngay |
| Channel videos, profile, outlier, title/hook/voice, comments | Có | Chưa expose | Khoảng cách product gần nhất cần giải quyết |
| Discovery, corpus search, competitor watchlist, momentum | Có | Chưa expose | Phải tuân theo plan Discovery hiện có |
| VPH theo cửa sổ và lịch sử video | Chưa có | Chưa có | `velocity` hiện chỉ là views/ngày trung bình |
| Retention, traffic, revenue, audience của kênh sở hữu | Chưa có OAuth | Chưa có | Chỉ làm qua YouTube Analytics OAuth |
| Thumbnail similarity/CTR benchmark toàn cầu | Không | Không | Chỉ cân nhắc trong corpus nội bộ |

**Hard gate:** Không công bố “VPH realtime”, “search volume”, “CTR prediction” hay “global trend” khi không có nguồn dữ liệu tương ứng. Output phải chỉ rõ method, khoảng thời gian và nguồn.

## 3. Bản đồ học từ vidIQ

| Nhóm vidIQ | Bản Spy nên học | Quyết định |
| --- | --- | --- |
| Channel Audit / Scorecard | Một báo cáo evidence-first: top/bottom, cadence, metadata gaps, outlier, transcript coverage | Làm sau khi MCP read parity có mặt |
| Outliers / Competitors | Baseline theo age cohort, tracked watchlist, new-upload/change alert | Ưu tiên cao |
| Historical stats / Trend Alerts / real-time views | Poll snapshot + VPH 1h/24h/7d + threshold alert | Ưu tiên cao, nhưng sau Discovery corpus |
| Daily Ideas | “Opportunity cards” từ outlier + format/topic/title + transcript evidence + niche fit | Làm cho Writer, không làm chatbot idea chung chung |
| Keyword Research | Autocomplete/corpus title/query signals nếu cần | Không clone search volume/competition toàn cầu |
| Similar videos / thumbnails | Search/embedding trong corpus đã Spy | Thử nghiệm sau khi corpus đủ lớn |
| Channel Analytics / Best time to post | YouTube Analytics OAuth của kênh sở hữu | Phase sau, số liệu thật |
| Script, thumbnail, voice, video, music, clip generation | Writer/production lane | Không đưa vào Spy |

Nguồn khảo sát ngoài: [vidIQ Features](https://vidiq.com/features/), [Keyword Research](https://vidiq.com/features/keyword-tools/), [Outliers](https://vidiq.com/features/outliers/), [Trend Alerts](https://vidiq.com/features/trend-alerts/), [Channel Audit Help](https://support.vidiq.com/en/articles/10141815-channel-audit).

## 4. Backlog lựa chọn — triển khai từng lát

### M0 — Đưa intelligence đã có ra đúng Writer Spy MCP *(complete 2026-08-19)*

**Mục tiêu:** Agent và UI đọc được analysis hiện hữu mà không cần truy cập Spy SQLite trực tiếp.

**Scope:** Mở rộng allowlist MCP theo read-first cho `spy_channel_videos`, `spy_channel_outliers`, `spy_channel_profile`, `spy_video_metrics`, `spy_title_patterns`, `spy_video_comments`, `spy_corpus_videos`, `spy_corpus_channels`, `spy_channel_momentum`, `spy_competitors_list`.

**Không gồm:** mutation discovery/watchlist, OAuth, poller hoặc tính metric mới.

**Acceptance criteria:**

- MCP `tools/list` hiển thị các tool read-only được duyệt, schema input đầy đủ và không lộ credential.
- Mọi response có `spyRunId`/video snapshot ID hoặc corpus provenance phù hợp.
- Query corpus không gọi YouTube API và không tiêu quota.
- Tool có dữ liệu không đủ trả `insufficient_sample`/`unavailable`, không trả số phỏng đoán như số thật.

**Completion proof:** `packages/daemon/src/spy-mcp.ts` now exposes the 10 approved read tools only; `packages/daemon/test/spy-mcp.test.ts` asserts the allowlist, mutation denylist, schemas and read routing. `bun test packages/daemon/test/spy-mcp.test.ts` and `bun run typecheck` pass.

### M1 — Competitor & corpus intelligence

**Mục tiêu:** Biến kênh đã Spy thành danh sách quan sát có thể ra quyết định nội dung.

**Scope:** Read/write watchlist có xác nhận người dùng; report về video mới, cadence, view/sub, velocity trung bình, outlier theo cohort; bảng “What changed since last scan”.

**Dependency:** Hoàn tất hoặc kế thừa đúng schema/quota contract của `spy-discovery-design.md`; không tạo candidate/index song song.

**Acceptance criteria:**

- Mỗi insight nêu run/snapshot cũ và mới, window thời gian, method.
- Không gọi metric `velocity` là VPH.
- Alert được dedupe bằng channel/video/rule/window; một lần scan không gửi lặp.

### M2 — Time-series, VPH thật và trend alert

**Mục tiêu:** Theo dõi đà tăng trưởng trong corpus, không dựa vào một snapshot.

**Scope:**

- Bảng immutable `video_stat_points(source_video_id, sampled_at, view_count, like_count, comment_count)`.
- Poller có quota budget, idempotency, retry/backoff, checkpoint và retention policy.
- `spy_video_stats` trả samples + VPH cửa sổ 1h/24h/7d, cùng `sampleCount` và độ phủ thời gian.
- Performance curve theo tuổi video và alert vượt/nghịch threshold.

**Không gồm:** VPH toàn YouTube hoặc kết luận trend toàn thị trường.

**Acceptance criteria:**

- VPH = `(views cuối − views đầu) / elapsed hours` và không được tính khi cửa sổ thiếu hai sample hợp lệ.
- Mỗi output khai báo timezone, time window, last sampled time và status data freshness.
- Job restart không tạo điểm trùng hoặc alert trùng.
- Shorts/long-form tách benchmark; không so raw views qua các quy tắc đếm khác nhau.

### M3 — Writer opportunity cards

**Mục tiêu:** Chuyển Spy evidence thành đầu vào hữu ích cho Writer, không tự động copy đối thủ.

**Scope:** Card gồm: opportunity statement, cơ sở outlier/momentum, 2–5 evidence refs transcript/metadata, format/title pattern, novelty constraint và lý do fit với niche.

**Dependency:** M0 + M1; M2 chỉ nâng điểm ưu tiên, không là điều kiện bắt buộc.

**Acceptance criteria:**

- Card không được tạo nếu thiếu evidence ref có thể mở lại.
- Mỗi recommendation nêu rõ “signal quan sát” khác “fact cần kiểm chứng”.
- Import vào Writer tạo Source Pack/snapshot immutable, không đọc Spy mutable state ở bước viết.

### M4 — First-party Analytics OAuth

**Mục tiêu:** Lấy dữ liệu chủ kênh chính xác: retention, traffic source, audience, revenue và best time to post.

**Scope:** OAuth consent, encrypted token store, minimum scopes, reporting adapter và UI/MCP read surface cho đúng channel đã uỷ quyền.

**Acceptance criteria:**

- Không có token/analytics data vượt workspace/channel authorization.
- Revenue chỉ hiển thị khi quyền và monetization cho phép.
- Các report chỉ rõ date range và dimension; rate-limit/API errors là recoverable.

### M5 — Similarity nội bộ (chỉ khi corpus đủ lớn)

**Mục tiêu:** Tìm video/thumbnail tương tự trong corpus đã thu để nghiên cứu packaging.

**Scope:** Embedding transcript-title + thumbnail; kết quả nêu matched signals và giới hạn corpus.

**Gate vào phase:** đủ corpus đa dạng, có đánh giá relevance thủ công, và không dùng kết quả để khẳng định “similar trên toàn YouTube”.

## 5. Thứ tự nên chọn

1. **M0** — giá trị nhanh nhất; biến code đã có thành capability dùng được.
2. **M1** — tạo workflow theo dõi đối thủ/corpus trước khi đầu tư metric mới.
3. **M2** — nền cho VPH, trend alert và performance curve đáng tin.
4. **M3** — chỉ bắt đầu khi evidence surface ổn định.
5. **M4**, sau đó **M5** — cần authority/data maturity cao hơn.

`spy-discovery-design.md` là source of truth cho discovery, quota ledger và corpus ingestion. Roadmap này không thay thế nó; M1/M2 chỉ được bắt đầu sau khi kiểm tra contract không chồng lấn.

## 6. ADRs chờ chọn trước khi build

- [ ] **ADR-SI-1 — MCP surface:** M0 expose read-only intelligence theo allowlist; mọi mutation (watchlist/discovery) cần tool riêng, scope riêng và confirmation.
- [ ] **ADR-SI-2 — Time-series boundary:** Chỉ poll video/kênh trong tracked corpus; không xây crawler/index toàn YouTube.
- [ ] **ADR-SI-3 — Writer boundary:** Spy tạo evidence/opportunity card; Writer quyết định angle và script, không nhận lệnh “copy” từ insight.
- [ ] **ADR-SI-4 — Keyword boundary:** Giữ vidIQ/external provider cho estimated global demand; Spy chỉ phát hành corpus/autocomplete signal với nhãn rõ ràng.
- [ ] **ADR-SI-5 — Analytics boundary:** First-party analytics chỉ qua OAuth kênh được uỷ quyền và tách khỏi public competitor data.

## 7. Không làm

- Clone toàn bộ vidIQ MCP hay index toàn cầu.
- Keyword volume/competition giả mạo từ dữ liệu không có.
- Poll không quota budget hoặc không có dedupe/retention.
- Media generation, voice, thumbnail creation, script writing trong Spy.
- Tự động áp dụng recommendation vào kênh hoặc Writer output.
