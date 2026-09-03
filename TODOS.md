# TODOS

Deferred work with enough context to pick up cold. Added by /plan-eng-review 2026-09-02.

## 1. Run DIVERGE and RESEARCH in parallel

**What:** Dispatch the two source-blind STUDY sub-calls concurrently instead of sequentially.

**Why:** CON-3 makes DIVERGE blind to sources; CON-4 makes RESEARCH blind to hypotheses.
They share no data. Blindness *is* independence, so parallel execution is safe by
construction, not merely convenient. CONFRONT joins them.

**Pros:** Saves roughly one DIVERGE duration per run. Costs nothing in tokens.
**Cons:** Requires lane-scheduler support for concurrent stages on the same item/attempt,
and checkpoint ordering currently assumes sequential commits.

**Context:** CON-23 currently reads as if parallelism were unsafe. It is not — it is
unsupported. Reword that constraint when this lands so nobody inherits the wrong belief.

**Blocked by:** lane-scheduler write-ownership model for one item/attempt.

## 2. Real origin-group provenance for Topic Packs

**What:** Extend the Topic Pack contract to carry coordinator-pinned upstream provenance
so `independentOriginGroups` reflects reality.

**Why:** Today every group resolves to `unknown`, so `MULTI_SOURCE_ATTESTED` can never
pass. The ~100 lines of independence validation in research-map.ts ship inert. That is
safe (unknown yields one group, multi-source needs two) but it means a documented
capability does not exist in practice.

**Pros:** Makes CON-10 real; multi-source corroboration stops being aspirational.
**Cons:** Depends on the Spy / source-acquisition design, outside this delivery.

**Context:** Add a boot-time log stating multi-source attestation is inactive, so nobody
six months from now reads the code and believes corroboration is working.

**Blocked by:** Topic Pack contract owner (Spy pipeline).

## 3. Eviction policy for the RESEARCH side-cache

**What:** Bound the cache keyed on (title, brief, audience, packHash, sourceManifestHash,
RESEARCH_PROMPT_VERSION).

**Why:** ~60KB per entry, unbounded. Not urgent at current volume; cheaper to decide now
than to discover as disk pressure.

**Pros:** Predictable footprint. **Cons:** None material.
**Context:** Entries for a superseded RESEARCH_PROMPT_VERSION are dead on arrival — drop
them on version change and the problem mostly solves itself.

## 4. Measure semantic Claim Boundary recall

**What:** An eval suite for the independent editor's ability to catch empirical
propositions carrying no number and no detected proper noun.

**Why:** ADR-005 fails closed on semantic defects, but failing closed only helps *after*
the editor detects something. Nothing currently measures detection rate. The SDD's own
example, "bat dong san luon an toan hon co phieu", is exactly the class the deterministic
floor cannot catch.

**Pros:** Turns a hoped-for property into a measured one, with a recall threshold.
**Cons:** Needs a labelled adversarial corpus; the eval is itself model-graded.

**Context:** Raised by the fresh Codex outside voice during eng review. The 30
orchestration tests prove routing works; they prove nothing about detection quality.

## 5. Persona beat semantic match, not just ID eligibility

**What:** Check that a PERSONA beat's prose actually corresponds to the experience
archetype it cites, not merely that the ID is approved.

**Why:** An approved experience ID can currently be attached to any PERSONA beat. The
allowlist proves eligibility, never correspondence.

**Pros:** Closes the last "declaration as authority" gap.
**Cons:** Semantic, so it belongs to the editor rather than the deterministic floor.

**Context:** Raised by the Codex outside voice (finding 7). Related to TODO 4 — same
reviewer, same eval harness.

## 6. Enforce force-add for writer-room-data source artifacts

**What:** A check that fails when a load-bearing file under writer-room-data/ is untracked.

**Why:** .gitignore swallows the whole directory. general-packs/, hook-libraries/,
writer/persona-pack.md and channel-styles/ all feed turn keys or the hook flow, and were
all untracked until 2026-09-01. Force-add does not self-enforce: the next general pack or
style file falls out of git silently.

**Pros:** Makes the boundary automatic instead of remembered.
**Cons:** One more CI check.

**Context:** Fixed reactively in 6bd1ae1, 96c73c9, b51de0b. Quick check:
compare `ls writer-room-data/<dir>/*.md | wc -l` against
`git ls-files writer-room-data/<dir>/ | wc -l`.

## 7. Màn hình duyệt persona (read-only + trạng thái)

**What:** Route `/persona` hiển thị 16 entry của `writer-room-data/writer/persona-pack.md`
kèm trạng thái duyệt do chính `parsePersonaRegistry` tính ra.

**Why:** Duyệt persona hiện là 7 bước thủ công ngoài app, không bước nào có phản hồi. Đây
là cơ chế vật lý khiến persona tắt suốt từ đầu: dự án có tooling tốt cho việc *xây* và
không có gì cho việc *bật*. Chủ kênh đã duyệt thiết kế này (CEO review 2026-09-03, 11A),
hoãn lại theo lệnh "không mở rộng tính năng nữa".

**Pros:** Bỏ 5/7 bước mò mẫm. Thấy `allowedText` thật mà gate sẽ dùng. Bắt `PERSONA_SCHEMA`
ngay lúc sửa thay vì sau 5 model call.
**Cons:** Một page + một route + một API GET.

**Context:** Khuôn có sẵn: `packages/web/src/pages/ChannelStyles.tsx` (155 dòng) + route
`/api/writer/channel-styles` (`http.ts:1970`). Màn này phải hiện: chip APPROVED/PENDING/
REJECTED, `allowedText` thực tế, cảnh báo "A1–A8 không mang marker nên mặc định PENDING",
và lỗi parse nếu có. Read-only, giữ triết lý "file do người viết trong editor".

**Effort:** M (human ~1 ngày / CC ~30ph). **Priority:** P1.
**Depends on:** không.

## 8. Ma sát trên luồng hook board

**What:** Bốn sửa nhỏ trong `packages/web/src/pages/WriterV2.tsx`.

**Why:** Luồng hook board chưa ai bấm thật lần nào (0/20 run). Bốn chỗ dưới đây là ma sát
tìm được khi đọc code, chưa phải khi dùng.

1. **Nút "Gợi ý hook" khoá câm** — `canSuggest` đòi mọi ô trả lời non-empty
   (`answers.every((a) => a.trim())`), nhưng khối gợi ý lý do ở cuối panel chỉ xử lý
   `configurationDirty` và thiếu title. Câu nào không áp dụng thì người dùng phải bịa chữ.
   **Đã làm 2026-09-03:** nút giờ nói rõ còn thiếu mấy câu, qua `suggestBlockedReason`.
   **Chưa làm:** cho phép bỏ trống một câu không áp dụng — cần đổi `canSuggest` và
   `buildSuggestPrompt` để chịu được câu trả lời rỗng.
2. **Câu trả lời biến mất** sau khi có candidate (khối gate bằng `!run.hookCandidates`),
   mất luôn ngữ cảnh để phán đoán candidate nào hợp.
3. **Chọn hook mà không thấy công thức** — library có 6 kiểu định nghĩa rõ, UI chỉ hiện
   `typeLabel`.
4. **Không có empty state** khi agent trả 0 candidate.

**Pros:** Luồng vào của mọi run trơn hơn. **Cons:** thuần UI, không đổi hành vi pipeline.
**Effort:** S (human ~4h / CC ~20ph). **Priority:** P2.
**Depends on:** nên làm sau khi chạy thật vài run để biết ma sát nào là thật.

## 9. Script nằm dưới nội bộ STUDY trên trang run

**What:** Đưa bài viết lên trước, hoặc thêm anchor nhảy thẳng tới nó.

**Why:** Trang run xếp theo thứ tự pipeline (1. STUDY → 2. Bài viết → 3. Gate → 4. Biên tập).
Câu hỏi đầu tiên khi mở một run xong là "đọc thử xem được không", nhưng phải cuộn qua
coverage map, outline và facts ledger mới tới script. Ma sát mỗi ngày với người mở run cũ
để copy script đi quay.

**Effort:** S (human ~2h / CC ~10ph). **Priority:** P2. **Depends on:** không.

## 10. Tách validator thuần khỏi `writer-run-v2.ts`, gỡ vòng lặp phụ thuộc

**What:** Đưa 4 validator (`validateWriterV2Draft`, `validateEditorReview`,
`validatePostmortem`, `validateRestyleOutput`) và các helper thuần
(`computeWriterV2Progress`, `pinFormulaHash`, `formulaContractView`, `pinWriterPackHash`,
`defaultEditorAgent`) ra module riêng.

**Why:** `run-store-v2` ⇄ `writer-run-v2` là vòng lặp phụ thuộc **runtime** thật (không
phải type-only): store cần `computeWriterV2Progress`, hàm đó kẹt trong file orchestrator
3.047 dòng. Khoảng 700 dòng thuần đang nằm nhầm chỗ. Đây cũng đúng là file ba lane tranh
chấp, nên tách ra giảm luôn merge risk.

**Pros:** Gỡ vòng lặp, giảm điểm va chạm. Chỉ 4 file import từ `writer-run-v2.ts` nên rủi
ro thấp. **Cons:** đụng đúng file đang nóng, phải làm lúc không có lane nào đang dở.
**Effort:** M (human ~1 ngày / CC ~40ph). **Priority:** P2.
**Depends on:** cả ba lane commit xong.

## 11. `EDIT_REVIEW` và `REPAIR` còn retry ẩn

**What:** Đặt `maxContentRetries: 0` cho hai stage còn lại.

**Why:** STUDY và WRITE đã đặt 0 (2026-09-03). Hai stage này còn mặc định 2, nên một lượt
tự động xấu nhất là 4 dispatch được đếm nhưng 8 model call thật.

**Cons:** Đổi hành vi — content-validation fail thành FAILED cứng thay vì tự lành. Run có
thể dừng ở chỗ trước đây tự qua.
**Effort:** S. **Priority:** P2. **Depends on:** coordinator integration (làm cùng lúc).

## 12. Model độc lập cho D/R/C khi nối mảng C

**What:** Cho DIVERGE/RESEARCH/CONFRONT chạy trên agent khác nhau, không dùng chung
`run.agentId`.

**Why:** Kiến trúc 3 sub-call trả +50–67% số call để mua độc lập, nhưng hiện chỉ mua ở tầng
envelope. Nghiên cứu peer-identity-bias 2026 nói giả định độc lập gãy khi solver và judge
chia chung training data và RLHF preference. Blindness vì thế là hai lỗ (filesystem +
model prior), không phải một như hai doc đang ghi.

**Context:** Nguồn arXiv 2604.22971 — **chưa xác minh được**, cần đọc lại trước khi dựa vào.
**Effort:** S về code, lớn về chi phí chạy. **Priority:** P3.
**Depends on:** mảng C.
