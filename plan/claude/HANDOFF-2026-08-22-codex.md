---
title: "Handoff → codex: Spy Auto-Loop P0 và việc phải làm với roadmap intelligence"
from: claude
to: codex
date: 2026-08-22
status: bàn giao — chờ codex nhận
reads: plan/claude/spy-autoloop-design.md (v3), plan/claude/spy-autoloop-research/*, plan/codex/spy-intelligence-learning-roadmap.md
---

# Handoff → codex

## 0. Tóm tắt điều hành

Lần cuối bạn cập nhật (`plan/codex/STATUS.md`, 19-08) trạng thái là **M0 complete, M1–M5 chờ chọn**. Từ đó tới nay đã có một nhánh công việc lớn chạy song song: **Spy Auto-Loop** — vòng lặp tự tìm kênh đối thủ theo chủ đề, chạy hằng ngày, có dashboard và báo cáo. Nhánh này đã qua research (5 memo), chốt thiết kế (plan v3) và đang build P0 bằng 3 seat song song.

**Việc bạn cần biết ngay:** ba quyết định của user trong nhánh đó **mâu thuẫn trực tiếp với ADR đang mở trong roadmap của bạn**. Roadmap không còn thi hành được nguyên trạng. Đây là lý do chính của handoff này.

**Kết quả mong đợi từ bạn:** roadmap v2 đã hoà giải, một bộ hard gate kiểm P0, và đặc tả M2 làm lại theo dữ kiện quota mới.

---

## 1. Ba ràng buộc cứng — user quyết, không thương lượng lại

| # | Quyết định | Ngày | Ảnh hưởng tới roadmap của bạn |
|---|---|---|---|
| **C1** | **Không dùng vidIQ hay bất kỳ provider dữ liệu ngoài nào.** Mục đích của hệ thống là *thay thế* vidIQ; một hệ thống cần X để khởi động thì không thay thế được X. | 21-08 | **ADR-SI-4 vô hiệu** — nó đang ghi "giữ vidIQ/external provider cho estimated global demand". Mục §3 bảng "Keyword Research" và "Similar videos/thumbnails" phải viết lại. |
| **C2** | **Không detector thị giác chạy local.** Việc chấm faceless / phong cách hình ảnh sẽ do **agent vision** làm, thiết kế trong một vòng riêng chưa lên lịch. | 21-08 | M5 (similarity, có nhánh thumbnail) phải tách phần thị giác ra khỏi phần văn bản/embedding. |
| **C3** | **Không scrape YouTube bằng browser.** Vi phạm ToS (đã verify điều khoản). Không có API thay thế cho `relatedToVideoId` từ 08-2023. | 20-08 | Ràng buộc này bạn đã có tinh thần đó rồi, chỉ cần ghi thành ADR tường minh. |

Hệ quả tổng: **mọi năng lực phải tự dựng từ YouTube Data API + corpus của mình.** Không mua, không mượn, không cào.

---

## 2. Dữ kiện đã verify — đừng verify lại, hãy dùng

Đã kiểm trực tiếp trên docs Google 20-08, nguồn ghi trong `plan/claude/spy-autoloop-research/youtube-api.md`:

1. **`videos.batchGetStats` — endpoint mới 03-06-2026, 1 unit.** Đây là dữ kiện quan trọng nhất với **M2 của bạn**: poller time-series rẻ hơn hẳn so với giả định cũ. Đặc tả M2 nên viết lại quanh endpoint này.
2. Quota: `search.list` bucket riêng, trần cứng **100 call/ngày**, 1 unit/call; **phân trang tính thêm một call**. Mọi endpoint khác 1 unit, chung túi 10.000.
3. `search.list type=channel` **không** trả statistics → luôn phải batch `channels.list` (1 unit/50 kênh). Kéo theo: **tìm theo video trước rồi gom channelId** cho nhiều tín hiệu hơn trên cùng chi phí.
4. `relevanceLanguage` **chỉ nghiêng kết quả, không lọc** (nguyên văn: "results in other languages will still be returned if they are highly relevant"). Không có trường "ngôn ngữ chính của kênh"; proxy khả dụng: `defaultAudioLanguage` từng video, `snippet.country`, `localizations`.
5. `channelSections` kiểu `multipleChannels` còn sống, không có thông báo deprecate. `subscriptions.list?channelId=` trả **403 `subscriptionForbidden`** với đa số kênh (mặc định riêng tư) — đây là trạng thái bình thường, không phải lỗi.
6. Trường có thật hôm nay: `videos.snippet.tags`, `defaultAudioLanguage`, `defaultLanguage`; `channels.topicDetails.topicCategories`, `brandingSettings.channel.keywords` (có thể thiếu với kênh bên thứ ba).
7. Chính sách lưu trữ: dữ liệu kênh **không thuộc quyền uỷ quyền** phải refresh hoặc xoá trong 30 ngày — **kể cả số liệu thống kê**. Điều này đã sửa một khẳng định sai trong `spy-discovery-design.md §0.3`; time-series của video không sở hữu chỉ hợp lệ ở dạng **cửa sổ trượt 30 ngày**. Có điều khoản cấm "tạo dữ liệu hoặc chỉ số phái sinh" — nên cờ phái sinh kiểu faceless phải giữ ở mức thô và tái tính trong hạn.
8. Telegram: 4096 ký tự/tin, khuyến nghị ≤1 tin/giây/chat, 429 kèm `retry_after`.

Còn **cần verify khi build M2**: metric `impressions` / `impressionsClickThroughRate` có sẵn qua Reports API cho scope của mình hay không — nếu không thì ghi `unavailable`, cấm thay bằng heuristic.

---

## 3. Đã build gì ở P0 — kiểm kê

Toàn bộ nằm trong working tree, **chưa commit**. Ba seat viết song song, tôi review và gộp.

### packages/spy
| Đường dẫn | Nội dung |
|---|---|
| `src/store.ts` | `SCHEMA_VERSION = 5`; bảng mới `topics`, `topic_keywords`, `topic_channel_sources`, `topic_channels`, `loop_ticks`, `daily_reports`; migration ALTER `candidate_channels.uploads_playlist_id` |
| `src/loop/types.ts` | Hợp đồng dùng chung: `TopicConfig` (zod), `TickPlan`, `TickResult`, `InboxItem`, `LoopStatus`, `ReportSummaryJson` v1 |
| `src/loop/planner.ts` | `planTick()` — thuần, không gọi API; tính ngân sách và thứ tự từ khoá. Chế độ chạy thử in ra chính vật thể này |
| `src/loop/runner.ts` | `LoopRunner.runTick()` bước 0–4 và 7; checkpoint vào `loop_ticks.step`; khoá theo topic trong bộ nhớ; `UNIQUE(topic_id, quota_day)` chặn chạy đôi |
| `src/loop/report.ts` | `buildDailyReport()` → `ReportSummaryJson` có phần `delta` so với báo cáo trước; `renderReport(summary, {mode:'tick'\|'digest'})` |
| `src/adapters/quota-counting-data-api.ts` | **Vá một lỗ hổng thật**: `acquisition.ts`, `videosByIds`, `channelsByIds`, `videoComments` trước đây gọi Data API mà **không** ghi sổ quota. Decorator này bọc port và `consume()` trước mỗi request |
| `src/topic.ts` | Nạp `config/topics/*.json`; cầu nối `topicToNicheMarket()` để tái dùng `scoreChannelFit` |
| `src/learn-value.ts` | 4 yếu tố xác định: vượt mốc kênh nhà 40, đà tăng 25, sub/tuổi kênh 20, đều đặn 15; trả `insufficient_sample` khi thiếu mẫu |
| `src/faceless.ts` | **đang viết lại theo C2** — còn lại tín hiệu văn bản, không phải verdict |
| `src/mcp-tools.ts` | +4 tool đọc, +2 tool ghi có scope riêng không nằm trong allowlist |

### packages/daemon
`src/spy/loop-config.ts` (file cấu hình **riêng** `config/spy-loop.json`) · `src/spy/loop-scheduler.ts` (bắt kịp khi khởi động, không phụ thuộc cron OS) · `src/spy/report-telegram.ts` · `src/http.ts` (10+ route `/api/spy/topics`, `/api/spy/loop/*`, `/api/settings/spy-loop`) · `src/spy-mcp.ts` (allowlist +4).

### packages/web
`src/pages/SpyLoop.tsx` — hộp chờ duyệt bằng phím, bảng từ khoá, kênh đã quét, kho báo cáo; `src/router.ts` phải khớp `spy-loop` **trước** `spy-run`.

### Trạng thái kiểm thử tại thời điểm bàn giao
- `bun test packages/spy` → **125 pass / 0 fail**
- `bun test packages/daemon/test/spy` + `spy-mcp.test.ts` → **23 pass / 0 fail**
- `bun run typecheck` → sạch
- Chạy toàn repo có **1 fail có sẵn** tại `packages/daemon/test/pipeline/parse-agent-json.test.ts` — đã xác nhận tồn tại trước nhánh này (stash rồi chạy lại vẫn fail). Không thuộc phạm vi Auto-Loop nhưng **đáng để bạn xử lý** vì nó đang che tín hiệu CI.

### Đang bay, chưa đáp (3 seat thực hiện)
1. Gỡ `src/adapters/face-detector/*` và đổi `scoreFaceless` → `scoreFacelessHint`; thêm seam `FacelessVerdictPort`.
2. Gỡ bảng `term_external_estimates` và mọi nhánh vidIQ; thay bằng nhập kênh thủ công + nạp corpus sẵn có.
3. Lọc ngôn ngữ hiện còn là stub trong `runner.ts` (~dòng 278) — phải làm thật bằng `defaultAudioLanguage`.

Đừng review ba mục này như lỗi tồn đọng; chúng đang được sửa.

---

## 4. Mâu thuẫn phải hoà giải trong roadmap của bạn

Đọc `plan/codex/spy-intelligence-learning-roadmap.md` cùng plan v3 rồi xử lý từng mục:

| Mục trong roadmap | Vấn đề | Hướng đề xuất (bạn quyết) |
|---|---|---|
| **ADR-SI-4 Keyword boundary** | Ghi "giữ vidIQ/external provider" — **trái C1** | Viết lại: không nguồn ngoài. Demand thật chỉ có một nguồn hợp lệ là Analytics OAuth của kênh mình (M4). Ngoài ra chỉ có `derived_corpus` với nhãn rõ |
| **§3 dòng "Similar videos / thumbnails"** | Ghi "thử nghiệm sau khi corpus đủ lớn" — nay đây là **năng lực thay thế cốt lõi** cho thứ vidIQ bán | Nâng ưu tiên. Tách 2 nhánh: (a) đồng xuất hiện trên kết quả search — rẻ, làm được ngay ở P1; (b) embedding corpus — M5. Nhánh thumbnail tách riêng, chờ vòng vision (C2) |
| **M1 Competitor & corpus intelligence** | **Chồng lấn nặng** với `topic_channels` + `loop_ticks` vừa build. Nguy cơ hai hệ song song đúng thứ roadmap tự cấm ("không tạo candidate/index song song") | Quyết ranh giới: Auto-Loop sở hữu vòng phát hiện và trạng thái duyệt; M1 thu hẹp lại còn *báo cáo thay đổi* trên tập đã duyệt. Hoặc tuyên bố M1 đã được Auto-Loop thực hiện và đóng nó |
| **M2 Time-series** | Đặc tả viết trước khi có `videos.batchGetStats` (1 unit) và trước khi sửa hiểu lầm về hạn lưu 30 ngày | Viết lại quanh endpoint mới; nêu rõ retention là **cửa sổ trượt 30 ngày** cho video không sở hữu; đây cũng là đầu vào nâng cấp `learn_value` (hiện dùng đà tăng thô thay VPH) |
| **ADR-SI-1 MCP surface** | Đã có thêm 4 tool đọc; và có một sự thật cần ghi vào ADR: `SCOPES` trong `spy-mcp.ts` đã chứa `spy.start`, nên **scope không chặn mutation — allowlist mới là gate duy nhất** | Ghi tường minh vào ADR để người sau không tưởng scope đang bảo vệ |
| **M0 "complete"** | Vẫn đúng, nhưng danh sách tool đã đổi | Cập nhật, ghi cả assertion trong `spy-mcp.test.ts` là danh sách sorted chính xác |

---

## 5. Việc giao

### T1 — Roadmap v2 đã hoà giải  *(ưu tiên 1)*
Cập nhật `plan/codex/spy-intelligence-learning-roadmap.md` và `plan/codex/STATUS.md`.

Acceptance:
- Mỗi mục ở §4 trên được xử lý dứt điểm — sửa, thu hẹp, hoặc đóng — kèm lý do một dòng.
- ADR-SI-1…5 chuyển từ "chờ chọn" sang có quyết định, cộng ADR mới cho C1/C2/C3.
- Không còn câu nào trong roadmap ngụ ý dùng nguồn ngoài hoặc detector local.
- Nêu rõ ranh giới với `plan/claude/spy-autoloop-design.md` để hai plan không tranh phần.

### T2 — Bộ hard gate cho P0  *(ưu tiên 2)*
Đây đúng chuyên môn của bạn. Viết checklist **kiểm được bằng lệnh**, không phải nhận xét chung. Đặt tại `plan/codex/spy-autoloop-hardgate.md`.

Tối thiểu phải phủ:
- **Sổ quota khớp thực tế.** Chạy một tick thử rồi đối chiếu `api_quota_usage` với số call thật, gồm cả đường quét sâu và các tool by-ids. Đây là chỗ vừa vá, phải chứng minh nó kín.
- **Không vượt ngân sách.** Tick thật không tiêu quá `daily_search_budget`; phân trang cũng phải tính.
- **Chạy lại giữa chừng không sinh trùng.** Giết daemon giữa tick rồi khởi động lại: không tìm lại từ khoá đã tìm trong ngày, không tạo tick thứ hai cùng `quota_day`.
- **Không mất khoá API.** Ghi cấu hình loop rồi đọc lại `spy.json`: `youtubeDataApiKey` còn nguyên. Đây là bẫy thật — schema `.strict()` cộng `loadConfig` nuốt lỗi sẽ âm thầm xoá khoá.
- **Trung thực về số liệu.** Không có đường nào phát ra chữ "VPH", "search volume", "CTR", "trend toàn cầu" khi không có nguồn. `faceless_hint` không được hiển thị như kết luận. Vị trí trong kết quả API không được gọi là "rank".
- **MCP không rò mutation.** `tools/list` không chứa `spy_loop_decide` / `spy_loop_tick`; gọi thẳng vẫn bị chặn.
- **Lọc ngôn ngữ hoạt động.** Kênh tiếng Anh lọt vào chủ đề tiếng Việt bị loại với lý do rõ ràng, không âm thầm.

Chạy bộ này **sau khi tôi báo 3 seat đã đáp**. Ra `PASS` / `CONDITIONAL PASS` / `FAIL` kèm repair note chính xác theo `file:line`.

### T3 — Đặc tả lại M2  *(ưu tiên 3, sau T1)*
Time-series và VPH thật, viết quanh `videos.batchGetStats`. Nêu rõ: ngân sách poller, chống trùng điểm, retention cửa sổ trượt 30 ngày, và cách `learn_value` nâng cấp từ đà tăng thô sang VPH có cửa sổ. Giữ nguyên hard gate cũ của bạn: VPH chỉ tính khi có đủ hai mẫu hợp lệ trong cửa sổ.

---

## 6. Nguyên tắc giữ nguyên hiệu lực

Những thứ này của bạn đã đúng, tôi không đụng và mong bạn giữ:

- Mọi số phải mang nhãn nguồn; thiếu nguồn thì trả `unavailable`, không thay bằng heuristic.
- Cổng mẫu tối thiểu (`MIN_VIDEOS_FOR_DISTRIBUTION`, `MIN_VIDEOS_FOR_CORRELATION`) và kiểu `MetricValue{method}` — từ chối trả số khi mẫu quá nhỏ.
- `validateEvidenceRefs` — mọi khẳng định của LLM phải neo vào segment/frame/quote có thật.
- Spy sinh evidence; Writer quyết góc nhìn. Không có đường "copy đối thủ" tự động.

---

## 7. Nơi tra cứu

| Cần gì | Đọc |
|---|---|
| Thiết kế Auto-Loop hiện hành | `plan/claude/spy-autoloop-design.md` (v3) |
| Dữ kiện API đã verify kèm nguồn | `plan/claude/spy-autoloop-research/youtube-api.md` |
| Hợp đồng code hiện có, gap, rủi ro | `plan/claude/spy-autoloop-research/codebase.md` |
| Thuật toán thu từ khoá tiếng Việt, seed đa ngôn ngữ | `plan/claude/spy-autoloop-research/seeding.md` (Part A đã đóng dấu superseded) |
| Regex tín hiệu văn bản, rubric phong cách | `plan/claude/spy-autoloop-research/faceless.md` (phần detector đã superseded) |
| Schema báo cáo, endpoint, MCP | `plan/claude/spy-autoloop-research/delivery.md` |

**Chưa chạy được lượt thật** vì thiếu khoá YouTube Data API — user chưa nhập. Mọi thứ dưới chế độ chạy thử vẫn kiểm được.
