# Spy Channel Intelligence — Goal và trạng thái triển khai

**Cập nhật:** 2026-09-03  
**Phạm vi hiện tại:** Saved research, theo dõi kênh đối thủ public, observation theo video và VPH  
**Trạng thái:** C1 và phần chính của C3 đã triển khai; Channel DNA, burst sampling và dữ liệu “Kênh của tôi” chưa triển khai

Tài liệu này mô tả trạng thái code thực tế. Thiết kế đầy đủ và các quyết định dài hạn nằm trong [solution-design.md](./solution-design.md).

## 1. Goal đang hướng tới

### 1.1 Mục tiêu sản phẩm hiện tại

Biến Spy từ một danh sách các lần chạy rời rạc thành một thư viện nghiên cứu kênh đối thủ có thể theo dõi theo thời gian.

Luồng mong muốn:

1. Người dùng Spy một channel và resolve được YouTube channel ID ổn định dạng `UC…`.
2. Người dùng có thể **Star** để lưu kênh vào Saved research. Star chỉ là bookmark local.
3. Người dùng chủ động **Follow** một kênh để đưa vào public competitor watchlist.
4. Daemon thu thập định kỳ public metrics của các video gần đây bằng yt-dlp.
5. Hệ thống giữ nhiều observation theo thời gian cho cùng một video.
6. Từ hai observation hợp lệ, hệ thống tính VPH và trình bày bằng bảng/chart để phát hiện video đang tăng trưởng nhanh.
7. Dữ liệu này sẽ là evidence đầu vào cho Channel DNA và phân tích đối thủ ở các phase sau.

### 1.2 Chỉ số trọng tâm: VPH

VPH là tốc độ tăng view thực tế giữa hai lần quan sát:

```text
VPH = (view ở lần quan sát sau − view ở lần quan sát trước)
      / số giờ thực tế giữa hai lần quan sát
```

Các nguyên tắc bắt buộc:

- VPH phải được tính từ ít nhất hai observation của cùng một video.
- Lifetime views/day hoặc `views / tuổi video` không được gọi là VPH.
- View bị thiếu phải giữ là `null`, không chuyển thành `0`.
- Khoảng thời gian thực tế phải được trả về cùng kết quả.
- Missing/private/error tạo khoảng trống và không được bắc cầu để tạo VPH.
- View counter giảm vẫn được lưu như raw fact nhưng không tạo VPH âm hoặc ép về `0`.
- Mọi số liệu phải ghi rõ public source, provider, completeness và phiên bản công thức.

### 1.3 Mục tiêu giao diện

Khu vực Spy được chia thành:

- **Saved research:** các channel được Star để quay lại nghiên cứu.
- **Followed competitors:** các channel đang nằm trong public watchlist.
- **Channel workspace:** trạng thái theo dõi, public observations, VPH và drilldown theo video.

VPH được trình bày qua:

- Leader table theo video.
- Heatmap video × ngày.
- Scatter VPH theo tuổi video.
- Cohort theo nhóm tuổi video.
- Raw video drilldown để kiểm tra các observation gốc.

### 1.4 Ranh giới kiến trúc

- Competitor watch chỉ dùng **yt-dlp**; không fallback YouTube Data API.
- Daily/manual collection không chạy agent, PTY, Gemini hoặc LLM.
- Collection không tải transcript, frame hoặc media.
- Watch scheduler độc lập với Spy Loop/P0.
- Star không tạo operation, follow relation hoặc provider call.
- Dữ liệu public được lưu append-only để có thể tính lại VPH khi công thức thay đổi.
- “Kênh của tôi” sẽ dùng Chrome extension → pool trong một thiết kế riêng; không dùng OAuth trong milestone này.

## 2. Những phần đã implement

### 2.1 C1 — Saved research và competitor watchlist

Đã triển khai:

- Migration schema v7 bổ sung stable `youtube_uc_id`, handle, Saved research và trạng thái theo dõi.
- Star/Unstar channel theo UC ID đã resolve.
- Follow, Pause, Follow lại và Unfollow trong watchlist `local-desktop`.
- Giữ nguyên bảng `competitors` và semantics MCP legacy.
- Star là storage-only; không gọi provider hoặc tạo background operation.
- Channel summary đọc được cả trạng thái Saved và Followed.
- Follow list trả thêm:
  - Observation status gần nhất.
  - Completeness gần nhất.
  - Số video có VPH 24h comparable.
  - Median VPH 24h khi đủ mẫu.

### 2.2 C3a — Public observation theo video

Đã triển khai schema v8 với hai ledger:

- `competitor_observation_runs`: một lần collection có idempotency, provider, status, completeness và số video inspect.
- `video_stat_points`: raw metrics append-only của từng video tại từng thời điểm.

Collector hiện tại:

1. Dùng yt-dlp flat channel listing để tìm video ID.
2. Flat-list chỉ dùng làm inventory; không tin view count từ listing.
3. Inspect riêng từng video trong giới hạn cấu hình để lấy metric public.
4. Lưu view, like, comment, duration, published time và availability khi có.
5. Metric bị thiếu giữ là `null`.
6. yt-dlp lỗi hoặc không khả dụng được ghi thành `partial` hoặc `unavailable`; không fallback provider khác.

Các trạng thái video được lưu:

- `present`
- `missing`
- `private`
- `error`

Chất lượng view được phân biệt:

- `known`
- `unknown`
- `decreased_vs_prior`

### 2.3 Daily watch scheduler

Đã có scheduler riêng cho competitor watch:

- Config nằm trong `config/channel-intelligence.json`, không dùng `spy-loop.json`.
- Mặc định `enabled=false`.
- Có timezone và giờ chạy hàng ngày.
- IANA timezone sai bị từ chối fail-closed.
- Chỉ xử lý relation có `watchStatus=followed` và `cadence=daily`.
- Một channel/ngày/plan version chỉ có một observation run.
- Concurrency bằng 1.
- Playlist limit mặc định 30; inspect cap mặc định 20.
- Giới hạn thời gian mặc định 8 phút cho mỗi channel, tối đa 10 phút.
- Deadline truyền bằng `AbortSignal` xuống yt-dlp và dừng vòng inspect ngay khi hết thời gian.
- Collection dở dang được giữ thành `partial` hoặc `unavailable` thay vì treo scheduler.
- Startup tick bắt lỗi để không tạo unhandled rejection và scheduler sau vẫn tiếp tục được.
- Kill-switch tắt tạo zero provider call.

Manual collection cũng dùng cùng collector và bị chặn khi global watch kill-switch đang tắt.

### 2.4 C3b — VPH read model

Đã triển khai `vph/v1` cho các cửa sổ:

| Requested window | Khoảng thực tế được coi là comparable |
|---|---:|
| 1h | 0,5–2 giờ |
| 24h | 18–30 giờ |
| 7d | 6–8 ngày |

Read model trả:

- Requested window và actual elapsed hours.
- Start/end timestamp và view count.
- VPH hoặc lý do không tính được.
- Comparability.
- Availability và view quality.
- Provider `ytdlp` và `dataApiUsed=false`.
- Definition version `vph/v1`.
- Coverage, observation status và completeness.
- Median, sample count và cohort distribution.

Các hard-gate đã có:

- 17h không comparable với 24h.
- 18h và 30h comparable với 24h.
- 31h là stretched.
- Một observation trả `insufficient_sample`.
- Missing/private/error dừng VPH line.
- Counter giảm không tạo VPH giả.
- Median số lượng mẫu chẵn dùng trung bình của hai giá trị giữa.
- Median channel chỉ hiện khi có ít nhất 5 mẫu comparable.
- Cohort percentile chỉ hiện khi có ít nhất 3 mẫu.
- VPH channel được derive trên toàn bộ history trong khoảng lọc trước raw pagination, tránh cắt đôi cặp observation.

### 2.5 HTTP API đã mở

| Method | Endpoint | Chức năng |
|---|---|---|
| `GET` | `/api/spy/watchlists/:watchlistId/channels?segment=saved\|followed` | Danh sách Saved hoặc Followed |
| `PUT/DELETE` | `/api/spy/channels/:youtubeUcId/star` | Star hoặc Unstar |
| `PUT/PATCH/DELETE` | `/api/spy/watchlists/:watchlistId/competitors/:youtubeUcId` | Follow, Pause/Update hoặc Unfollow |
| `POST` | `/api/spy/watchlists/:watchlistId/competitors/:youtubeUcId/observe` | Thu thập một public sample khi kill-switch đang bật |
| `GET` | `/api/spy/watchlists/:watchlistId/competitors/:youtubeUcId/vph` | VPH và chart read model của channel |
| `GET` | `/api/spy/videos/:videoId/vph` | Raw points và VPH drilldown của một video |
| `GET/PUT` | `/api/settings/channel-watch` | Đọc/cập nhật daily-watch settings |

Route VPH cũ `/api/spy/channels/:youtubeUcId/vph` không còn được dùng và trả JSON 404 để tránh client đọc nhầm contract.

### 2.6 UI đã làm

Đã có:

- Saved research list.
- Followed competitors list.
- Channel detail/workspace.
- Star, Follow, Pause và Unfollow actions.
- Global daily-watch control, ghi rõ áp dụng cho mọi followed channel.
- Next collection chỉ hiện khi global watch đang bật và channel đang Followed.
- Follow list hiển thị last observation, completeness, comparable count và median VPH.
- Bộ lọc VPH `1h`, `24h`, `7d` và tùy chọn hiển thị non-comparable segments.
- VPH leader table/bar view.
- Heatmap video × ngày.
- Scatter VPH theo tuổi video.
- Cohort distribution.
- Video raw-observation drilldown.
- Provenance và coverage strip.
- UI phân biệt insufficient sample, missing/private/error, partial và provider unavailable; không hiển thị missing như số `0`.

### 2.7 Kiểm thử đã chạy

Kết quả xác minh gần nhất:

- Focused C1/C3: **17 pass, 0 fail**.
- Web tests: **18 pass, 0 fail**.
- Full Spy/daemon/pipeline/training suite: **629 pass, 0 fail**.
- TypeScript typecheck: pass.
- Web production build: pass.
- `git diff --check`: pass.
- Còn cảnh báo Vite chunk lớn hơn 500 kB; đây không phải blocker của Channel Intelligence.

Việc xác minh không khởi động daemon, scheduler thật, yt-dlp live, provider, OAuth, agent hoặc PTY. Tests dùng fake ports và database tạm.

## 3. Chưa implement trong milestone hiện tại

- Channel DNA extraction/versioning.
- Daily watch tự động gọi DNA hoặc LLM — chủ đích không làm.
- Burst sampling tự động `+2h/+6h/+12h/+24h` cho video mới.
- Auto-pause sau nhiều lần provider unavailable liên tiếp.
- Read-only MCP tools riêng cho observation/VPH.
- “Kênh của tôi”.
- Chrome extension → pool intake.
- Own-channel analytics và so sánh kênh mình với đối thủ.
- Chính sách retention riêng cho public observation history.

Lưu ý: UI có lựa chọn đọc VPH 1h, nhưng nếu chưa có hai manual observations cách nhau 0,5–2 giờ thì kết quả sẽ ghi rõ thiếu burst-compatible coverage; hệ thống không giả lập VPH 1h từ daily samples.

## 4. Các file triển khai chính

### Spy domain và persistence

- `packages/spy/src/channel-intelligence/roles.ts`
- `packages/spy/src/channel-intelligence/observations.ts`
- `packages/spy/src/channel-intelligence/types.ts`
- `packages/spy/src/adapters/ytdlp.ts`
- `packages/spy/src/store.ts`
- `packages/spy/src/index.ts`

### Daemon và scheduler

- `packages/daemon/src/spy/channel-watch-config.ts`
- `packages/daemon/src/spy/channel-watch-scheduler.ts`
- `packages/daemon/src/http.ts`

### Web UI

- `packages/web/src/api.ts`
- `packages/web/src/pages/SpyChannel.tsx`
- `packages/web/src/styles.css`

### Hard-gate tests

- `packages/spy/test/channel-intelligence-c1.test.ts`
- `packages/spy/test/public-observations-vph.test.ts`
- `packages/daemon/test/spy/channel-intelligence-route.test.ts`
- `packages/daemon/test/spy/channel-watch-scheduler.test.ts`
- `packages/web/test/spyChannelApi.test.ts`
