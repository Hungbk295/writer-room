> **Trạng thái:** simplified 2026-08-11 — user chốt: agent đã đủ viết bài tốt; hệ thống chỉ thêm nhất quán series + human taste
> **Rev 2026-08-11b:** boundary bằng tách store (FM0 gộp vào FM1); Taste đơn vị = cặp sửa + `decisionType`; capture tách khỏi retrieve; merge nhiều video xuống FM4
> **Phạm vi:** Formula lifecycle, profile migration, Taste memory, ranh giới Training / Studio / Writer
> **Không làm:** thay Source Pack; biến Taste thành factual KB; pipeline Writer nhiều phase chỉ để “nâng chất lượng prose”

# Formula → Writer — nhất quán series + human taste

## 0. Premise

Agent viết đã đủ để ra **một bài tốt**. Không xây thêm quy trình phức tạp để “dạy viết”.

Hai việc hệ thống thực sự cần:

| Mục tiêu | Cơ chế |
|---|---|
| **Nhất quán series** (voice, tone, anti-pattern lặp lại) | `WRITER_READY_PROFILE` — guardrail nhẹ, đã generic |
| **Human taste** (trong tình huống này chọn hướng nào) | Taste memory — case quyết định thật của người, retrieve khi hữu ích |

```text
Truth        = Source Pack (bài này được nói gì, evidence nào)
Consistency  = WRITER_READY_PROFILE (series nghe giống một voice)
Taste        = human decision memory (ưu tiên editorial khi có lựa chọn)
Writing      = agent (đã đủ năng lực prose)
```

Không kỳ vọng Formula/profile “làm bài hay hơn” theo nghĩa prose skill. Profile chỉ giữ series không lệch giọng. Taste chỉ giúp không quên preference đã chốt.

---

## 1. Ba artifact — không thêm concept

| Artifact | Vai trò | Writer? |
|---|---|---|
| `VIDEO_FORMULA` (`ANALYZED` / `REFINED` / legacy `COMPOUND`) | Quan sát có evidence từ video; Training only | **Không — hard fail** |
| `WRITER_READY_PROFILE` | Voice/style đã migrate + human duyệt | **Có** (pin version/hash) |
| `TASTE_DECISION_CASE` | Tình huống → options → human chọn → lý do/boundary | **Retrieve hỗ trợ**, không lệnh |

Không có runtime concept thứ ba tên `Writer Formula`. `toWriterFormula()` strip evidence **không đủ**: rule vẫn dính topic/timestamp/catchphrase trong câu (vd. formula `0fcb21c0`). Phải migrate + duyệt, không chỉ chiếu projection.

`toWriterFormula()` → **đổi tên `toTrainingDraftView()`**, type `WriterFormula` → `TrainingDraftView`, file `writer-view.ts` → `draft-view.ts`.

Không xoá: projection này có consumer thật ở `training-lab.ts:161` (DRAFT stage — dựng cái mà draft agent nhìn thấy), và đó là việc **hợp lệ bên trong Training**. Thứ phải giết là *product concept* "Writer Formula" — tức niềm tin rằng strip evidence là đủ để writer-ready — chứ không phải bản thân projection. Tên cũ chính là thứ gây nhầm.

`detectTopicLeak()` đi cùng sang file mới, giữ nguyên — leak gate cần.

### Boundary bằng cấu trúc, không bằng runtime guard

Writer **chưa tồn tại** trong code. Nên không retrofit guard vào API đã có; xây đúng ngay từ đầu:

- Profile nằm ở **store riêng, thư mục riêng, type riêng** — không phải một `kind` field trong formula store.
- Writer **không import gì** từ formula store. Không có đường để formula source-bound đi vào.
- `FORMULA_TRAINING_ONLY` chỉ là hard fail phòng thủ cho đường cũ (`promoteCompound` gắn nhãn writer-ready), không phải cơ chế chính.

Lý do tách store: `WriterReadyProfile` (guidelines, không evidence) khác hình dạng hẳn `FormulaArtifact` (rules + quote + segmentIds). Union một store đẻ ra type rẽ nhánh khắp nơi, và boundary do hệ thống chặn rẻ hơn boundary do `if` chặn.

---

## 2. `WRITER_READY_PROFILE` — đủ mỏng để giữ series

### 2.1 Mục đích

- Giọng nhận diện được qua nhiều bài
- Tone theo ngữ cảnh (không một skeleton cố định)
- Anti-pattern AI / lệch series đã biết
- Không encode checklist viết đầy đủ

### 2.2 Shape tối thiểu

```ts
interface WriterReadyProfile {
  kind: 'WRITER_READY_PROFILE';
  id: string;
  version: number;
  label: string;
  readiness: 'TRIAL' | 'VALIDATED'; // TRIAL = đủ sạch để thử, không = đã chứng minh hay hơn
  scope: { language: string; genre?: string; contentModes: string[] };
  editorialPromise?: string;
  guidelines: Array<{
    id: string;
    instruction: string;
    when?: string;   // optional, free text
    avoidWhen?: string;
    priority: 'CORE' | 'OPTIONAL';
    sourceRuleIds: string[];  // provenance: rule gốc trong VIDEO_FORMULA
  }>;
  antiPatterns: string[];
}
```

Một list `guidelines` là đủ. Không bắt buộc năm bucket (voice/tone/tendencies/explanation/…). CORE nên ít — hướng dẫn: **≤ 8 CORE**; thừa thì OPTIONAL hoặc cắt.

`sourceRuleIds` là field **không tái tạo được** sau khi migrate xong — không có nó thì sau này nhìn guideline không biết vì sao nó ở đó, muốn re-migrate cũng chịu. Một field, không phải scope creep.

**`VALIDATED` do human tự đánh dấu** sau khi dùng qua vài bài. Không có gate tự động — transfer test và LLM score đều đã cắt (§5), nên không tồn tại đường tự động nào tới `VALIDATED`. Mọi profile mới publish đều là `TRIAL`.

### 2.3 Giữ / bỏ

**Giữ:** voice ổn định, tone có điều kiện, nhịp/chuyển ý xu hướng, ranh giới giải thích, diction ưa/ghét, anti-pattern (forced humor, fake specificity, hook nhồi…).

**Bỏ:** số hook bắt buộc, % cảm xúc, average sentence length, skeleton mọi bài, catchphrase/greeting kênh, fact/số/ví dụ video nguồn, “phải dùng hết rule”.

### 2.4 Migration (Studio)

Human-driven, LLM chỉ đề xuất wording:

```text
Chọn observation/rule từ VIDEO_FORMULA
  → PROFILE | TASTE | SOURCE_ONLY | REJECT
  → (profile) generic hóa + leak check
  → human Accept/Edit/Reject
  → publish immutable WRITER_READY_PROFILE version
```

Leak check chặn: tên kênh/video, catchphrase, timestamp, example/số/claim nguồn, instruction chỉ hiểu khi biết video gốc. Domain vocab đúng `scope` (vd. tài chính cá nhân) **không** tự động là leak.

Legacy: compound/`ANALYZED` trên đĩa = training-only cho tới khi migrate. Không auto-promote.

### 2.5 Merge nhiều video **không** nằm trên critical path

Đường đi đầu tiên là **1 formula thật → 1 profile TRIAL**. Đường đó không cần rule pool nhiều video, không cần clustering, không cần compound merge.

Đúng với dữ liệu đang có: 2 formula của **cùng 1 video** — clustering trên đó vô nghĩa. Hệ quả:

- Blocker "phải chạy P3 SYNTHESIZE thật trước" **biến mất**. FM1 không chờ có thêm video.
- Điều kiện `LOW_SOURCE_DIVERSITY` (cảnh báo migrate từ 1 nguồn) **bỏ** — một-nguồn giờ là đường đi chính thức, không phải trường hợp cần cảnh báo.
- Studio P2/P3 đã build **không phí**: bước generic hoá của FM1 chính là `studio-synthesize.ts`, đổi cluster size N→1 và đổi output từ `statement` sang `{instruction, when, avoidWhen, priority}`.
- Merge nhiều video → **FM4**, khi đã có đủ dữ liệu thật.

---

## 3. Taste — memory của human, không phải bộ não

### 3.1 Đơn vị lưu = **cặp sửa**, không phải bộ phương án

Không lưu chunk transcript. Lưu can thiệp thật của human:

```text
Situation (decisionType) → before → after → Reason? → Boundary / khi nào không áp
```

```ts
interface TasteDecisionCase {
  id: string;
  decisionType: 'OPENING' | 'ANGLE' | 'TRANSITION' | 'DEPTH' | 'TONE' | 'ENDING' | 'CUT';
  situation: string;
  before: string;             // agent viết
  after: string;              // human sửa thành
  options?: Array<{ id: string; description: string; status: 'CHOSEN' | 'REJECTED' }>;
  reason?: string;
  boundary?: string;
  doNotTransfer?: string[];
  evidenceStatus: 'OBSERVED' | 'INFERRED' | 'SYNTHETIC';
  humanValidated: boolean;
}
```

**Vì sao cặp sửa, không phải `options[]`:** §3.2 nguyên tắc 3 đã bỏ blind divergence bắt buộc — mà divergence là thứ duy nhất sinh options đáng tin. Luồng thật là *agent viết một hướng → human sửa*: chỉ có before và after. Ép điền `options[]` thì hoặc bắt agent đẻ N phương án (đúng bằng cái vừa cắt), hoặc suy ngược phương án bị loại từ diff (= `INFERRED`, bị cấm trình bày như ý human).

Nên `options?` là **optional**, dùng cho trường hợp hiếm mà agent có đưa lựa chọn thật (chọn góc bài — đưa 3 góc là tự nhiên, một lượt, không phải state machine).

**`decisionType` là enum đóng** để retrieve theo *loại quyết định*, không theo *chủ đề*. Không có nó, similarity trên `situation` free text sẽ khớp "tiết kiệm tiền" thay vì "cách mở bài" — đúng rủi ro topic-search ở §9, và §9 chỉ giảm hậu quả chứ không chạm nguyên nhân.

`reason?` optional chấp nhận được: 5 lần sửa "cắt trạng từ" là preference rõ ràng kể cả khi không ai viết lý do. Nhưng **hỏi ngay lúc sửa** — hỏi sau thì không ai điền.

- `OBSERVED` = human thật sự chọn/sửa. Cặp sửa luôn `OBSERVED`.
- `INFERRED` = hệ thống suy luận — không được trình bày như ý human.
- **Không mine case từ transcript.** Nhìn script cuối không thấy phương án bị loại, nên mọi case mined đều là suy diễn kèm rejected bịa — loại dữ liệu bẩn nhất cho một store nhỏ. Bắt đầu **rỗng**. Cần thì thêm ở FM4.

Canonical có thể là Markdown + index rebuild được (QMD/vector). Index không phải nguồn sự thật.

### 3.2 Runtime — nhẹ

```text
Brief + Source Pack + Profile
        ↓
Agent đề xuất hướng / viết (agent đã đủ)
        ↓
(Optional) lấy vài Taste case gần tình huống — để so, không để copy
        ↓
Human chốt / sửa
        ↓
Ghi decision case mới
```

Nguyên tắc:

1. Taste **hỗ trợ**, không `must follow`. Reject hết precedent là hành vi đúng.
2. Không dump RAG vào mọi prompt. Chỉ khi đang có lựa chọn editorial (angle, cách mở, có/không story…).
3. Không bắt buộc multi-phase “Blind Divergence 4–8 → Compare matrix → …”. Agent nghĩ trước hoặc song song với gợi ý đều được; **không** thiết kế hệ thống quanh việc chống anchoring bằng state machine nặng.
4. Fact chỉ từ Source Pack. Taste/Profile không cấp số liệu bài hiện tại.

**Capture trước, retrieve sau.** §3.1 tự nói signal dài hạn đến từ decision khi vận hành — mà hiện có **0 bài đã viết**, tức 0 case. Retrieve trên 0–3 case tệ hơn không retrieve: nó nổi lên precedent lạc đề và dạy human thói quen bỏ qua gợi ý. Capture thì làm ngay (rẻ, và quyết định không log là mất vĩnh viễn). Bật retrieve khi có **~15–20 case thật** → tách thành FM3.

Promotion principle (khi sau này cần): cùng preference lặp lại vài context + human duyệt → candidate bổ sung profile. **Một edit không auto-sửa profile đang active.**

---

## 4. Training Lab & Studio — giữ đúng việc

| Surface | Việc | Không còn là |
|---|---|---|
| **Formula / Training** | Khai thác observation + evidence từ video | Input Writer |
| **Training Lab** | Thử / soi choice nếu hữu ích | Release gate; LLM score = quality proof; auto-refine promote |
| **Studio** | Migrate → Profile và/hoặc Taste case; human duyệt | Merge xong là Writer-ready |
| **Writer** | Profile + Source Pack + (optional) Taste; human chốt | Tuân thủ formula dài |

Formula tab: hai view — Training only vs Writer-ready profiles. Không nút “Use in Writer” trên training formula.

---

## 5. Việc đã cắt (không đưa lại nếu không có evidence mới)

| Cắt | Vì sao |
|---|---|
| Giant Writer Formula / checklist đầy đủ | Agent đã viết được; checklist máy móc |
| `Writer Formula` + `Writer Profile` hai concept | Một runtime artifact: profile |
| Per-video / compound thẳng vào Writer | Source leak cấu trúc |
| Pipeline Writer nhiều phase bắt buộc (blind 4–8, stage retrieval table, diagnose 6 lớp…) | Overkill so với mục tiêu nhất quán + taste |
| Mandatory transfer-test / LLM numeric release score | Tốn kém; tối ưu theo rubric; model tự chấm mình |
| Auto-refine Formula từ critic | Học preference model, không phải human |
| Bắt buộc dùng mọi guideline | Prose đồng phục, predictable |
| Formula/Taste làm factual source | Phá Truth boundary |
| Auto-promote mọi human edit lên profile | Một decision ≠ principle ổn định |
| Schema guideline 5 bucket + appliesWhen[] phức tạp | Free text `when` / `avoidWhen` đủ lúc đầu |
| `options[]` bắt buộc trong Taste case | Nguồn sinh options (divergence) đã cắt → chỉ còn bịa hoặc `INFERRED` |
| Mine Taste case từ transcript | Không thấy được phương án bị loại → rejected bịa; bắt đầu rỗng |
| Retrieve Taste trong milestone đầu | 0 case; retrieve trên store rỗng dạy human ignore gợi ý |
| Tên `toWriterFormula` / `WriterFormula` | Ám chỉ strip evidence là writer-ready. Đổi tên `toTrainingDraftView`; logic vẫn dùng trong Training Lab |
| `LOW_SOURCE_DIVERSITY` warning | Một-nguồn là đường đi chính thức, không phải bất thường |

---

## 6. Implementation

FM0 cũ (boundary + tên) **gộp vào FM1**: Writer chưa tồn tại nên không có gì để retrofit, boundary do tách store bảo đảm (§1), phần còn lại chỉ là xoá dead code + sửa docs.

### FM1 — Profile mỏng, dùng được ngay

- Store riêng cho `WRITER_READY_PROFILE`; type riêng; Writer không import formula store.
- Rename `toWriterFormula()` → `toTrainingDraftView()`, `writer-view.ts` → `draft-view.ts`; cập nhật `training-lab.ts` + test. Giữ nguyên hành vi và `detectTopicLeak()`.
- `promoteCompound()` không được gắn nhãn writer-ready; `ANALYZED`/`REFINED`/`COMPOUND` → `FORMULA_TRAINING_ONLY`.
- Studio: classify `PROFILE | TASTE | SOURCE_ONLY | REJECT`.
- Generic hoá (tái dùng `studio-synthesize.ts`, cluster size 1) + leak check + human approve → immutable profile version, luôn `TRIAL`.
- Mỗi guideline mang `sourceRuleIds`.
- Tab/list: Training formulas vs Writer-ready profiles. Không nút "Use in Writer" trên training formula.
- Sửa SDD/docs còn cho per-video formula vào Writer (§10).

**Thin path:** 1 formula thật → 1 profile TRIAL (≤8 CORE + antiPatterns). Không cần merge nhiều video (§2.5).

**DoD:** một profile sạch (không topic/catchphrase/timestamp), có provenance; không đường nào đưa formula source-bound vào Writer.

### FM2 — Taste capture (chưa retrieve)

- Khi human sửa output trên Writer (hoặc Studio): ghi case `{decisionType, situation, before, after, reason?}`.
- Hỏi `reason` **ngay tại thời điểm sửa**, optional, một ô text.
- Store rỗng lúc đầu — không mine từ transcript.
- Không retrieve, không auto-mutate profile.

**DoD:** một bài chạy với Source Pack + profile pinned; mỗi lần human sửa sinh một case `OBSERVED`; fact không lấy từ Formula/Taste.

### FM3 — Taste retrieve (mở khi có ~15–20 case)

- Retrieve top vài case **trong cùng `decisionType`**, sau khi agent đã đề xuất hướng.
- UI "precedents gợi ý", bỏ qua được, không authority.
- Promote lên profile chỉ khi human chủ động và preference đã lặp lại.

**DoD:** gợi ý xuất hiện đúng loại quyết định; reject hết precedent vẫn là luồng hợp lệ.

### FM4 — sau, khi có dữ liệu thật

Merge nhiều video (rule pool + clustering + compound) khi có ≥3 formula từ video khác nhau. Mine Taste case bootstrap nếu lúc đó vẫn thấy cần.

Eval sau (không chặn ship): leak rate, human edit distance / acceptance, retrieval có ích hay bị ignore — **không** gộp thành writing score giả.

---

## 7. Acceptance

- [ ] Training formula không qua Writer API; Writer không import formula store.
- [ ] Writer chỉ nhận pinned `WRITER_READY_PROFILE`.
- [ ] Profile không chứa transcript, quote, catchphrase, timestamp, example/source identity.
- [ ] Mỗi guideline có `sourceRuleIds`; profile mới publish luôn `TRIAL`.
- [ ] Profile = consistency series, không phải quality proof / factual source.
- [ ] Taste case ghi `before`/`after` + `decisionType`; `options` optional; inferred ≠ human intent.
- [ ] Taste gợi ý được bỏ qua; không authority.
- [ ] Source Pack = factual input bài hiện tại.
- [ ] Human decision → case mới; không tự sửa profile active.

---

## 8. ADR đã chốt

- [x] **ADR-FM1** — Per-video/compound chỉ Training; Writer chỉ material đã migrate. *(2026-08-10)*
- [x] **ADR-FM2** — Hai trạng thái: `VIDEO_FORMULA` vs `WRITER_READY_PROFILE`. *(2026-08-11)*
- [x] **ADR-FM3** — Không runtime “Writer Formula” riêng. *(2026-08-11)*
- [x] **ADR-FM4** — Profile cố ý nhẹ; consistency series, không encode hết năng lực viết. *(2026-08-11)*
- [x] **ADR-FM5** — Taste = decision memory có context/options/boundary; support không phải authority. *(2026-08-11)*
- [x] **ADR-FM6** — Human ops là signal dài hạn; mined case chỉ bootstrap. *(2026-08-11)*
- [x] **ADR-FM7** — Không auto-mutate profile; promote thận trọng. *(2026-08-11)*
- [x] **ADR-FM8** — Truth / Taste / Style tách; Source Pack không thay thế. *(2026-08-11)*
- [x] **ADR-FM9** — Agent đã đủ viết bài; hệ thống chỉ thêm consistency + human taste — không phình pipeline “nâng prose”. *(2026-08-11, simplified)*

- [x] **ADR-FM10** — Profile ở store/type riêng; boundary Writer↔Formula do cấu trúc bảo đảm, không do runtime guard. *(2026-08-11)*
- [x] **ADR-FM11** — Đơn vị Taste là **cặp sửa** (`before`/`after`) + `decisionType` enum đóng; `options` optional. Hệ quả trực tiếp của việc cắt blind divergence. *(2026-08-11)*
- [x] **ADR-FM12** — Capture Taste trước, retrieve sau (~15–20 case). Không mine case từ transcript. *(2026-08-11)*
- [x] **ADR-FM13** — `VALIDATED` chỉ do human đánh dấu thủ công; không tồn tại gate tự động. *(2026-08-11)*
- [x] **ADR-FM14** — Merge nhiều video không nằm trên critical path; thin path 1 formula → 1 profile. *(2026-08-11)*

*(ADR-FM10 **cũ** — blind divergence state machine bắt buộc — **bỏ**, và số FM10 được cấp lại cho decision ở trên. Không thiết kế runtime quanh chống anchoring bằng nhiều phase; thứ tự "agent đề xuất trước, retrieve sau" ở §3.2 đã đủ.)*

> ⚠️ Số hiệu ADR-FM2/FM3 từng mang nội dung khác trong bản 2026-08-10. Trích dẫn cũ theo số có thể sai — đối chiếu nội dung, đừng tin số.

---

## 9. Rủi ro còn lại

| Rủi ro | Xử lý mỏng |
|---|---|
| Profile lại phình checklist | ≤8 CORE; reject advice rỗng |
| Source leak sau generic hóa | Leak gate + human duyệt |
| Taste thành topic-search / copy | `decisionType` enum đóng — retrieve theo loại quyết định, không theo chủ đề; cho phép ignore |
| Docs/code cũ vẫn cho formula vào Writer | Tách store (FM1) + regression |
| Compound TRIAL cũ bị nhầm Writer-ready | Training-only badge; migrate tường minh |
| Agent baseline hoá ra chưa đủ tốt | Câu trả lời **không phải** profile dài hơn — mà Source Pack / brief tốt hơn. Không kéo checklist quay lại (§5). |

---

## 10. Docs conflict

Trong FM1, đồng bộ premise cũ:

1. `docs/specs/002-writer-agent-mvp/solution-design.md` §6.3, §8.2, §12b, ADR-13/15 — còn cho per-video/compound / `toWriterFormula` như Writer input đủ.
2. `docs/plans/writer-training-architecture-v2.md` — nặng Formula release.
3. `plan/writer-train/PHASES-M2-STUDIO.md` — P4/P5 superseded; trỏ file này.

**File này** là decision source cho Formula → Writer + Taste cho tới khi SDD được revise. Lịch sử Training implementation vẫn hợp lệ; chỉ premise “formula (kể cả compound) = Writer input” và “pipeline Writer nhiều phase để nâng chất” bị thay.
