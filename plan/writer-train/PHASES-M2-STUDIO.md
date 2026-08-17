<!--
Kế hoạch phase cho M2 (batch) + M2.5 (Formula Studio).
Nguồn sự thật thiết kế: docs/specs/002-writer-agent-mvp/solution-design.md §6.1a, §12b, ADR-5, ADR-13.
File này chỉ là bảng theo dõi thi công — không lặp lại thiết kế, chỉ trỏ về SDD.
-->

# Phases — M2 (batch) + M2.5 (Formula Studio)

| Field | Value |
|---|---|
| Thiết kế gốc | SDD §6.1a (batch), §12b (Studio), ADR-5, ADR-13 |
| Trạng thái | **P1 + P2 + P3 done** (2026-08-10) · P2 có E2E thật; **P3 chưa E2E thật** (chưa tiêu token nào) · P4–P5 cũ **superseded** bởi [`FORMULA-MIGRATION-TO-WRITER.md`](./FORMULA-MIGRATION-TO-WRITER.md) · P0 bỏ, P6 hoãn |
| Cập nhật | 2026-08-10 |

## 0. Đề xuất thứ tự — đọc trước

**Tôi đề nghị làm Studio trước phần lớn M2, không phải theo số thứ tự milestone.** Lý do:

- Studio là vòng lặp trí tuệ cốt lõi và là phần **rủi ro nhất, mới nhất**. Làm sớm = biết sớm nó có hoạt động không.
- Studio **không phụ thuộc** batch: rule pool chỉ đọc các Formula đã lưu (`listFormulas()`), không quan tâm chúng được tạo bằng 1 lần bấm hay 10 lần bấm.
- Batch không mở khoá năng lực mới, nó chỉ làm việc tạo Formula **nhanh hơn**. Luồng M1 1-video đã chạy thật rồi.

Nên: làm **P0 (batch-lite)** đủ để không phải ngồi bấm 10 lần, rồi vào thẳng Studio. Phần M2 đầy đủ (dashboard SSE cursor, replay, run console, filter) đẩy xuống **P6**, làm sau khi đã biết Studio có giá trị thật.

Nếu bạn muốn giữ đúng thứ tự M2 → M2.5, nói một câu, tôi đảo lại — nhưng khi đó P6 nằm trước P1 và bạn sẽ mất thêm một quãng trước khi thấy được Studio.

**Quy tắc chung mọi phase:** mỗi phase là 1 commit độc lập; `bun test` + `bun run typecheck` xanh trước khi qua phase sau; không đụng `packages/daemon/src/team/**`, `src-tauri/**`, `packages/daemon/src/agents/**`.

---

## P0 — Batch-lite: N video → N Formula

**Mục tiêu:** chọn nhiều video, bấm 1 lần, quay lại sau có N Formula. Không làm dashboard đầy đủ.

| Việc | File |
|---|---|
| Nhận `videoSnapshotId[]` thay vì 1 id; tạo N item, dispatch qua `LaneScheduler` sẵn có (`maxParallel` đã có, không sửa scheduler) | `daemon/src/training/orchestrator.ts` |
| Aggregator xử lý N item độc lập — mỗi item settle → 1 Formula riêng, item lỗi **không** chặn item khác | `daemon/src/training/aggregator.ts` |
| Route batch + status trả danh sách item kèm **lý do** lỗi | `daemon/src/http.ts` |
| UI: chọn nhiều video, bảng trạng thái đơn giản (item / trạng thái / lý do / link Formula) | `web/src/pages/Training.tsx` |

- **Không làm ở phase này:** `events.jsonl` + SSE cursor/replay, run console drawer, filter chips, retry-failed hàng loạt → để P6.
- **Rủi ro:** đây là lần đầu chạy >3 clone song song thật. Bẫy `AGENT_STALL` từng gặp ở M1 (`STALL_MS` đã nới 600s, **chưa rõ root cause**) có thể lộ lại ở đây — nếu lặp lại, phải bật DevTools xem log `[turnBridge]` heartbeat thay vì nới tiếp timeout.
- **DoD:** chạy thật 3 video (cố tình có 1 video hỏng transcript) → 2 Formula ra, 1 item `FAILED` có lý do đọc được, 2 cái kia không bị ảnh hưởng.

---

## P1 — Contracts + thuật toán cluster (thuần, không I/O, không tốn token)

**Mục tiêu:** dựng xong nền của Studio và **chứng minh phần "thuật toán" bằng test**, trước khi tiêu một token nào.

| Việc | File |
|---|---|
| `CompoundRule`, `CompoundRuleProvenance`, `CompoundFormula`; `CritiqueEvidence` thêm `videoSnapshotId` | `training-core/src/contracts.ts` |
| `validateCompoundRule()` — `provenance[]` rỗng ⇒ `STUDIO_RULE_UNGROUNDED` | `training-core/src/validator.ts` |
| `validateCritique()` chế độ compound — video được cite phải nằm trong provenance set, nếu không ⇒ `STUDIO_EVIDENCE_OUT_OF_SCOPE` | `training-core/src/validator.ts` |
| `clusterRules()` — tất định, không LLM: trùng/gần trùng → merge candidate; cùng facet khác cách làm → **conflict, không tự gộp**; còn lại → unique | `training-core/src/cluster.ts` (mới) |

- **Điểm cần bạn biết trước:** ngưỡng "gần trùng" là tham số tôi phải tự chọn. Tôi sẽ bắt đầu **bảo thủ** (thà báo 2 rule là khác nhau để bạn tự gộp, còn hơn tự gộp nhầm 2 rule khác nhau) và để ngưỡng thành hằng số đặt tên rõ, chỉnh được sau khi bạn xem dữ liệu thật. Tôi **không** hứa ngưỡng này đúng ngay lần đầu.
- **DoD:** `bun test packages/training-core` xanh, phủ: rule trùng y hệt, trùng cách diễn đạt, cùng facet mâu thuẫn, rule độc nhất, provenance rỗng bị chặn, critique cite video ngoài phạm vi bị chặn.

---

## P2 — Rule pool + session + picking (backend + UI, vẫn chưa gọi LLM)

**Mục tiêu:** bạn duyệt được **toàn bộ rule của mọi video**, tick chọn, và **nhìn thấy chỗ trùng/mâu thuẫn** — không tốn token nào.

| Việc | File |
|---|---|
| Đọc mọi L1 Formula → phẳng thành rule refs, lọc theo channel/video/facet/text | `daemon/src/training/studio-pool.ts` (mới) |
| Session bền: tạo/đọc, lưu tập rule đã pick, lưu kết quả cluster | `daemon/src/training/studio-store.ts` (mới) |
| Routes: `POST /api/studio/sessions`, `GET .../:id`, `POST .../picks`, `POST .../cluster`, `GET /api/studio/rule-pool` | `daemon/src/http.ts` |
| UI: trang duyệt rule (filter + tick) và trang cluster (trùng / mâu thuẫn / độc nhất) | `web/src/pages/Studio*.tsx` (mới), `router.ts` |

- **Đây là mốc bạn kiểm tra được giá trị đầu tiên:** kể cả nếu Studio dừng ở đây, bạn đã có một công cụ đọc-so-sánh rule xuyên video mà hiện chưa có.
- **DoD:** mở app, chọn rule từ ≥3 video khác kênh, thấy đúng nhóm trùng và nhóm mâu thuẫn, đóng app mở lại session còn nguyên.

---

## P3 — Synthesize + duyệt đề xuất (lần đầu Studio gọi LLM)

**Mục tiêu:** LLM viết lại câu chữ cho cụm **bạn đã duyệt**, bạn accept/sửa/loại từng cái.

| Việc | File |
|---|---|
| 1 turn LLM bounded cho mỗi cluster đã duyệt, qua `LaneScheduler.dispatchItem` sẵn có (không sửa scheduler) | `daemon/src/training/studio-synthesize.ts` (mới) |
| Gate: output thiếu provenance ⇒ từ chối (`STUDIO_RULE_UNGROUNDED`), không ghi | dùng validator P1 |
| Accept / sửa tay / loại từng proposal → `CompoundFormula` v1 (`status: DRAFT`) | `studio-store.ts` |
| UI: danh sách proposal, mỗi cái xem được nó gộp từ rule nào của video nào | `web/src/pages/Studio*.tsx` |

- **LLM chỉ đề xuất, không bao giờ commit** — mọi rule vào compound đều phải qua tay bạn (ADR-13).
- **DoD:** một `CompoundFormula` DRAFT tồn tại, mỗi rule trong đó truy ngược được về (video, formula gốc, rule gốc, evidence).

---

## P4 — Superseded: test-write không còn là release gate

P4 cũ không tiếp tục theo premise “compound Formula đã là Writer input”. Test-write chỉ còn tùy chọn; LLM critique không phải release proof.

Studio migrate sang `WRITER_READY_PROFILE` (nhất quán series) và/hoặc Taste case (human preference). Chi tiết: FM1–FM2 trong [`FORMULA-MIGRATION-TO-WRITER.md`](./FORMULA-MIGRATION-TO-WRITER.md) (số hiệu FM cập nhật 2026-08-11, FM0 cũ đã gộp vào FM1 — đừng tin số hiệu cũ, xem nội dung).

---

## P5 — Superseded: không promote `COMPOUND` thẳng vào Writer

Không còn `WriterFormula` runtime. Writer chỉ nhận pinned `WRITER_READY_PROFILE`. Legacy compound/per-video = Training-only. Taste optional, không authority. Xem FM1 trong [`FORMULA-MIGRATION-TO-WRITER.md`](./FORMULA-MIGRATION-TO-WRITER.md).

---

## P6 — M2 đầy đủ (làm sau khi Studio đã chứng minh giá trị)

`events.jsonl` + SSE cursor/replay, dashboard §7.4 (cột trạng thái luôn kèm lý do, filter "Cần xử lý", banner mất kết nối), retry 1 item đúng `attempt+1/epoch+1`, `Continue with successes`, run console drawer.

- Tách riêng vì đây là **công thái dụng**, không phải năng lực mới. Nếu sau P4 bạn thấy hướng Studio sai, phần này chưa bị làm phí.

---

## Cách bạn theo dõi

Mỗi phase xong tôi cập nhật `STATUS.md` với: xây gì, **verify được gì** và **chưa verify được gì** (tách bạch, không gộp), số test, và sự cố thật nếu có — đúng cách các phase M0.5/M1/M1.5 đã ghi.

Ba mốc bạn tự kiểm được trong app, không cần đọc code:
- **Sau P2** — duyệt và so sánh rule xuyên video, chưa tốn token.
- **Sau P3** — compound Formula đầu tiên, mọi rule truy ngược được nguồn.
- **Sau P4** — bài viết thật từ compound Formula + bản chấm có bằng chứng.
