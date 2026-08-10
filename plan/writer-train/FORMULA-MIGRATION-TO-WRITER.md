> **Agent:** writer-train
> **Status:** planned
> **Owns:** `packages/training-core/**`, `packages/daemon/src/training/**`, `packages/daemon/test/training/**`, `packages/web/src/pages/{Training,TrainingLab,Studio}.tsx`, Formula routes/types trong `packages/daemon/src/http.ts` + `packages/web/src/api.ts`
> **Does not touch:** Writer Runtime (`writer-core`, `packages/daemon/src/writer/**`), Curated Pack, `packages/daemon/src/team/**`, `src-tauri/**`, Spy domain
> **Depends on:** M1, M1.5, Studio P1–P3 (đã xong); dùng lại `pipeline-core` + `LaneScheduler`

# Formula Migration to Writer

Sản xuất **Writer Formula đủ điều kiện đưa cho Writer**. Formula có thể được migrate từ một hoặc nhiều Training Formula; không mặc định mọi output đều là compound. Không bao gồm việc Writer viết bài.

---

## 0. Ranh giới hai lane

User chốt 2026-08-10: công việc chia làm hai capability lane độc lập. Executor cụ thể được cấu hình lúc chạy, không nằm trong domain plan.

| | Formula Migration lane | Writer lane |
|---|---|---|
| Sản phẩm | Một **Writer Formula** generic, bất biến | Bài viết hoàn chỉnh |
| Câu hỏi trả lời | "Viết **như thế nào**" | "Viết **cái gì**" |
| Nguồn | Transcript video → rule phong cách | Curated Pack → dữ kiện |
| Kết thúc ở | Formula được human duyệt, `readiness: WRITER_READY` | Bài được duyệt + export |

**Hai lane gặp nhau tại đúng một chỗ: `WriterFormulaInput` ở §2.** Ngoài chỗ đó ra, không lane nào cần biết lane kia làm gì.

---

## 1. Vì sao Formula của Training không dùng thẳng cho Writer được

Đây là quyết định gốc (ADR-FM1, user xác nhận 2026-08-10) và là lý do tồn tại của toàn bộ plan này.

Bằng chứng đo được trên Formula thật `0fcb21c0` — **5/8 rule** dính chủ đề hoặc chữ nguyên văn của đúng một video:

```
rule-1  "trì hoãn chào hỏi tới giây thứ ~101"          → mốc thời gian của riêng video đó
rule-3  "Phần một, Phần hai, Phần bốn"                  → đánh số của riêng video đó
rule-4  "khái niệm tài chính ('thuế ở lại thành phố')"  → chủ đề + cụm từ tự chế
rule-6  "'Nếu nhìn... anh... hơn trước'"                → chữ nguyên văn
rule-7  "'tôi là sói tài chính'"                        → câu nhận diện thương hiệu kênh
```

Đưa nguyên bộ này cho Writer viết chủ đề mới thì rule 4-7 hoặc ép nội dung quay về tài chính, hoặc ép chép câu cửa miệng của kênh.

**Premise cũ đã bị bác bỏ và cần ghi lại để không ai lặp lại:** “Writer nối được với bất kỳ Formula nào, chỉ cần bỏ evidence khi gửi”. Sai. **Bỏ evidence không làm một rule trở nên generic** — rule “tôi là sói tài chính” bỏ evidence đi thì vẫn là “tôi là sói tài chính”. Formula phải được **viết lại**, không phải chỉ lọc trường.

Hệ quả:
1. `ANALYZED`/`REFINED` là **Training Formula** — không bao giờ xuất hiện trong Writer picker.
2. Formula cũ **không tự động** nâng cấp. Giữ nguyên để audit, mặc định không đủ điều kiện.
3. `COMPOUND` đã promote theo flow P2/P3 cũ → phân loại `MIGRATION_REQUIRED`, không tự thành Writer Formula.

---

## 2. HỢP ĐỒNG BÀN GIAO — Writer lane đọc phần này

Đây là toàn bộ thứ lane Writer cần biết về Formula. Writer plan có thể dùng contract này ngay, không phụ thuộc người hoặc model nào implement Formula Migration lane.

### 2.1 Writer nhận cái gì

```ts
interface WriterFormulaInput {
  id: string;
  version: number;
  label: string;                 // tên thể loại, vd "kể chuyện tài chính cá nhân"
  rules: Array<{
    id: string;
    instruction: string;         // phải làm gì
    appliesWhen: string[];       // khi nào rule này hữu ích
    avoidWhen: string[];         // khi nào KHÔNG dùng
    antiPatterns: string[];      // dấu hiệu áp dụng máy móc / quá tay
  }>;
}
```

### 2.2 Ba bảo đảm

1. **Không có dữ liệu nguồn.** Không transcript, không evidence, không quote, không tên video/kênh, không `sourceFormulaId`, không lineage. Bản đầy đủ vẫn giữ provenance để audit, nhưng **projection thì sạch**.
2. **Rule là policy có điều kiện, không phải checklist.** `avoidWhen` tồn tại nghĩa là Writer **không được** nhồi đủ mọi rule vào mọi bài. Nhồi đủ rule là lỗi, không phải thành tích.
3. **Formula chỉ nói cách viết, không cung cấp dữ kiện.** Mọi fact trong bài phải đến từ Curated Pack của lane Writer. Formula không bao giờ là nguồn của một con số.

### 2.3 API

```text
GET /api/formulas?kind=writer&readiness=ready     → chỉ trả Writer Formula đã duyệt
GET /api/formulas/{id}                            → bản đầy đủ (có provenance, để audit)
```

Truyền một Training Formula vào Writer boundary → **hard fail `FORMULA_TRAINING_ONLY`**, không im lặng chiếu. Đây là chủ ý: im lặng chiếu chính là cách một rule dính chủ đề lọt vào bài viết mà không ai biết.

### 2.4 Ba việc thuộc lane Writer, không phải lane này

- **Curated Pack (ADR-12, đang `Pending`)** — pack hiện tại là khối markdown **không có claim id**, nên `CITATION_GATE` không có gì để kiểm (GAP-14). Đây là chặn thật của lane Writer và cần quyết sớm, vì cổng trích dẫn nằm giữa luồng viết.
- **ADR-7** — trích dẫn cấu trúc là cổng cứng, kiểm ngữ nghĩa chỉ là tư vấn. Nghĩa là MVP **không được tuyên bố là chống bịa tự động**.
- Thesis / Brief / Architecture / Draft / Review / Approve / Export.

**Lưu ý tránh trùng lặp:** plan cũ có nhắc `MigrationTestPack`. Khái niệm đó **đã bỏ** (xem §4) — đừng dựng một khái niệm pack thứ hai song song với Curated Pack.

---

## 3. Kế hoạch thi công của lane này

### Bước 0 — chạy P3 thật một lần (điều kiện tiên quyết)

P3 (generic hoá bằng LLM) **đã code xong, 232/232 test xanh, nhưng chưa chạy thật lần nào**. Chưa biết LLM có generic hoá được không mà xây tiếp là xây trên cát.

Cần: tạo thêm 2-3 Formula từ **các video khác nhau** (hiện chỉ có 2 Formula cùng 1 video, không có cụm trùng thật để ghép). Rồi mở `#/studio` → chọn rule → "Ghép bằng LLM" → xem câu chữ đề xuất có bỏ được "tài chính", "thuế ở lại thành phố", "tôi là sói tài chính" không.

Kết quả quyết định Bước 1 có phải sửa prompt không.

### Bước 1 — contract + boundary

Đây là thứ lane Writer đang chờ, làm trước.

- Phân biệt `TrainingFormula` / `WriterFormula` bằng discriminant, **một registry duy nhất** (không tách store — xem ADR-14, đã sửa đúng lỗi đó rồi).
- `toWriterFormulaInput()` chỉ nhận `readiness: WRITER_READY`; Training Formula → `FORMULA_TRAINING_ONLY`.
- Training Lab vẫn viết thử được với Training Formula, nhưng qua projector **tên khác**, không gọi là Writer input.
- Nâng rule từ một câu `statement` → 4 trường `instruction/appliesWhen/avoidWhen/antiPatterns`. Đây là sửa prompt SYNTHESIZE, không phải làm lại P3.
- Formula tab tách hai view; Training Formula mang badge `TRAINING ONLY`.

**DoD:** không origin Training/legacy nào lọt qua Writer boundary — chứng minh bằng unit test.

### Bước 2 — cổng rò rỉ + human duyệt

- Cổng rò rỉ **tất định, 0 token**: quét formula tìm chữ nguyên văn trong ngoặc kép, mốc thời gian, thứ tự phần cụ thể. `detectTopicLeak` đã có và đã bắt được 5/8 rule thật.
- Finding phải được `FIXED` hoặc human `WAIVED` kèm lý do — không cho qua khi còn finding chưa xử lý.
- Human bấm duyệt → sinh Writer Formula **bất biến**, `readiness: WRITER_READY`. Sửa rule sau đó tạo version mới và làm bản duyệt cũ stale.

**DoD:** một Writer Formula được tạo từ Training Formula với đủ vết truy ngược; đưa thẳng Formula nguồn vào Writer vẫn `FORMULA_TRAINING_ONLY`.

---

## 4. Đã cắt khỏi plan — và vì sao (đừng thêm lại nếu chưa đọc phần này)

### 4.1 Transfer test bắt buộc (viết bài thử rồi cho critic chấm) — **BỎ**

Lý do, theo thứ tự quan trọng:

1. **Agent viết không được thấy transcript nguồn** (chính plan quy định). Vậy bài viết **không thể** chứa catchphrase của video nguồn — trừ khi thứ đó nằm sẵn trong rule. Nên **kiểm thẳng formula là đủ để phát hiện rò rỉ; không cần viết bài nào.** Viết một bài thử tốn 2-4 lượt LLM để tìm ra thứ mà một hàm regex đọc formula đã tìm xong.
2. **Critic không chấm được chất lượng.** Không có bản chuẩn để đối chiếu. Một LLM phán "bài này tốt" không dựa vào tiêu chuẩn nào — trái nguyên tắc "model rẻ không được là người ký duy nhất".
3. **Bài thật đầu tiên chính là transfer test**, trên chủ đề user thực sự quan tâm, do người có thể đánh giá thật đánh giá.

Giữ lại dưới dạng **nút "viết thử" tuỳ chọn** — là công cụ để user xem formula ra bài kiểu gì, **không phải cổng**, và người chấm là user đọc.

### 4.2 Đo "formula có làm bài tốt hơn không" — tách ra, không thuộc plan này

Cách trung thực duy nhất là **so mù**: cùng chủ đề, hai bản có/không formula, user chọn mà không biết bản nào là bản nào, lặp ~20 chủ đề (SDD v2 §15.1: thắng ≥15/20 mới GO). Nó trả lời "hướng này có đáng theo không" — **một lần**, không phải chạy mỗi lần migrate. Đừng nhầm với việc kiểm từng formula.

### 4.3 Hoãn (bổ sung sau khi luồng chính chạy tốt, theo đúng chỉ thị user)

| Bỏ/hoãn | Lý do |
|---|---|
| Portability analysis artifact (Gate B cũ) | Trùng phần lớn với chính bước generic hoá của P3 |
| `refinementMap` rule lineage ở Training Lab | Provenance trỏ `(formulaId, ruleId)` mà mỗi version formula bất biến có id riêng → ref luôn giải được. Là chuyện truy vết đẹp hơn, không phải lỗi đúng/sai |
| `migration-lint-report.json` đầy đủ | Cổng rò rỉ ở Bước 2 đã đủ cho luồng chính |
| 11 mã lỗi, 9 trạng thái, conflict workflow | Chính là "lan man vào handle lỗi" mà user yêu cầu tránh |
| 8 phase FM0–FM7 | Rút còn 2 bước + 1 điều kiện tiên quyết |

---

## 5. Rủi ro đã biết

- **P3 chưa chạy thật.** Toàn bộ chất lượng generic hoá phụ thuộc một prompt chưa từng gặp dữ liệu thật. Đây là rủi ro lớn nhất và là lý do Bước 0 tồn tại.
- **Gom cụm không bắc cầu được qua ngôn ngữ.** Hai rule cùng nghĩa nhưng một tiếng Việt một tiếng Anh thì độ trùng token = 0, không bao giờ gom. Formula `9a88a60d` (09-08) có statement tiếng Anh. Prompt ANALYZE đã có ràng buộc ngôn ngữ nên formula mới không dính, nhưng dữ liệu cũ thì có.
- **`detectTopicLeak` cố ý hẹp.** Bắt được chữ trong ngoặc kép, mốc `giây/phút`, danh sách "Phần một, Phần hai". **Không** bắt được danh từ chủ đề trần như "khái niệm tài chính" — đó là việc của bước generic hoá bằng LLM. Đừng mô tả cổng này như thể nó đầy đủ.
- **Nguyên liệu chưa đủ để E2E.** Hiện có 2 Formula, cùng 1 video, 0 compound.

---

## 6. ADR còn treo

- [x] **ADR-FM1 — Hard separation.** Formula của video chỉ dùng trong Training; Writer chỉ nhận Formula đã migrate. *User confirmed 2026-08-10.*
- [ ] **ADR-FM2 — Một registry, hai kind có phân biệt kiểu.** Giữ một nơi lưu nhưng không dùng một type dễ dãi cho cả hai. *Khuyến nghị: duyệt — tránh phân mảnh store (lỗi ADR-14 vừa sửa) mà vẫn có ranh giới cứng.*
- [ ] **ADR-FM3 — Số nguồn.** Migration bắt đầu từ 1 hoặc nhiều Training Formula; một nguồn vẫn được nhưng mang cảnh báo `LOW_SOURCE_DIVERSITY` và không được gọi là validated. *Khuyến nghị: duyệt — không ép merge cơ học, đồng thời trung thực về độ mạnh bằng chứng.*
- [ ] **ADR-FM4 (cũ: transfer test bắt buộc) — RÚT.** Xem §4.1.

### ADR bổ sung từ editorial review

- [ ] **ADR-FM5 — Generic trong phạm vi, không generic vô hạn.** Mỗi Writer Formula khai báo `genre`, `language`, `contentModes` và `domain` nếu có. Migration phải loại dấu vết của video/kênh nguồn, nhưng được giữ từ vựng chuyên môn thuộc phạm vi đã khai báo. *Khuyến nghị: duyệt — nếu ép bỏ mọi topic noun, Formula “kể chuyện tài chính cá nhân” sẽ mất chính thứ làm nó phù hợp với tài chính.*
- [ ] **ADR-FM6 — Editorial contract tối thiểu.** Writer Formula thêm formula-level `editorialPromise`; mỗi rule thêm `editorialFunction`, `audienceEffect` và `priority`. *Khuyến nghị: duyệt — bốn trường instruction/applies/avoid/anti-pattern mô tả cách dùng, nhưng chưa nói rule tồn tại để tạo hiệu ứng gì.*
- [ ] **ADR-FM7 — Eligibility khác validation.** `WRITER_READY + TRIAL` nghĩa là được phép dùng có cảnh báo, không có nghĩa Formula đã chứng minh làm bài tốt hơn. Chỉ blind evaluation nhiều topic mới được gắn `VALIDATED`. *Khuyến nghị: duyệt — giữ đúng lý do transfer test bắt buộc đã bị rút ở §4.1 mà không biến “ready” thành tuyên bố chất lượng quá mức.*

Khi FM2/FM3 được xác nhận: cập nhật SDD 002 §6.3 và ADR-15 (hiện còn ghi "picker offers every origin interchangeably" — **đã sai** sau ADR-FM1).

---

## 7. Validation

```bash
bun test packages/spy packages/daemon packages/pipeline-core packages/training-core
bun run typecheck
bun run ui:build
```

**Bẫy đã biết:** `preflight.test.ts` gọi một agent CLI `--version` thật nên có thể flake khi chạy song song 20+ file — chạy lại riêng để xác nhận, đừng "sửa" nó. Và **daemon không tự restart khi tắt/mở app Tauri** — phải tự kill process cũ (HANDOFF §6).

---

## 8. Editorial contract — bảo toàn cái hay khi generic hoá

### 8.1 Tension trung tâm

Migration có hai cách thất bại đối nghịch:

```text
Quá gần nguồn                              Quá generic
→ copy topic/catchphrase/cấu trúc cũ      → rule đúng nhưng vô dụng
→ không chuyển được sang bài mới          → Formula mất cá tính
```

Ví dụ:

| Source rule | Generic sai | Generic đúng hơn |
|---|---|---|
| “Trì hoãn câu ‘tôi là sói tài chính’ tới giây 101” | “Tạo hook hấp dẫn” | “Hoãn phần tự giới thiệu cho tới sau khi tension đầu tiên đã được thiết lập; không để branding cắt đứt hook” |
| “Gọi chi phí sống ở thành phố là ‘thuế ở lại thành phố’” | “Dùng ẩn dụ” | “Đặt một nhãn ẩn dụ ngắn cho lực cản trung tâm rồi tái sử dụng nó như motif; tránh lấy lại nhãn riêng của nguồn” |

Mục tiêu không phải làm câu rule áp dụng được cho mọi nội dung trên đời. Mục tiêu là:

> **Loại bỏ payload của video nguồn, giữ lại technique và audience effect trong phạm vi Formula đã khai báo.**

### 8.2 Formula promise khác audience promise của một bài

Để không trộn Formula với Story Brief:

- `audiencePromise` của **một bài**: người xem bài này sẽ hiểu/thay đổi niềm tin gì — thuộc lane Writer.
- `editorialPromise` của **một Formula**: khi dùng đúng phạm vi, Formula tạo ra trải nghiệm đọc/xem kiểu gì — thuộc lane migration.

Ví dụ `editorialPromise`:

> “Biến một vấn đề tài chính trừu tượng thành câu chuyện có nhân vật, lực cản được đặt tên và ba lần reveal tăng dần; giọng gần gũi nhưng không làm nhẹ bằng chứng.”

`editorialPromise` là tiêu chuẩn để human quyết định các rule có đang cùng tạo một style hay chỉ là một túi mẹo rời rạc.

### 8.3 Editorial Analyst làm gì trong migration

`Editorial Analyst` là một capability role, không bind với agent/model cụ thể. Role này không promote và không thay deterministic gate.

#### Trước SYNTHESIZE — Migration Brief

Editorial Analyst đề xuất một brief ngắn để human duyệt:

```ts
interface FormulaMigrationBrief {
  genre: string;
  language: string;
  contentModes: string[];
  domain?: string;
  editorialPromise: string;
  preserve: string[];       // technique/effect phải giữ
  remove: string[];         // catchphrase/topic payload/identity phải bỏ
  nonGoals: string[];       // Formula không cố trở thành gì
}
```

Brief không tự sinh Formula và không quyết định rule nào được giữ. Nó chỉ cho P3/human một chuẩn chung để tránh generic hoá mỗi rule theo một hướng khác nhau.

#### Sau SYNTHESIZE — challenge từng proposal

Editorial Analyst trả lời năm câu hỏi cho từng proposal:

1. Bỏ tên riêng/chủ đề nguồn xong, rule còn đủ cụ thể để một writer thực hiện không?
2. Rule giữ **audience effect** hay chỉ thay vài danh từ bằng từ chung chung?
3. `appliesWhen` và `avoidWhen` có ngăn việc áp dụng máy móc không?
4. Còn brand voice/catchphrase/cấu trúc chỉ hợp đúng video nguồn không?
5. Rule có trùng hoặc mâu thuẫn với rule khác trong cùng Formula không?

Kết quả là advisory note nằm ngay cạnh proposal. Human vẫn là người Accept/Edit/Reject.

### 8.4 Contract editorial đề xuất

Nếu ADR-FM5/FM6 được duyệt, mở rộng handoff §2.1 như sau:

```ts
interface WriterFormulaInput {
  id: string;
  version: number;
  label: string;
  scope: {
    genre: string;
    language: string;
    contentModes: string[];
    domain?: string;
  };
  editorialPromise: string;
  rules: Array<{
    id: string;
    editorialFunction:
      | 'HOOK'
      | 'TENSION'
      | 'REVEAL'
      | 'EVIDENCE'
      | 'TRANSITION'
      | 'VOICE'
      | 'CLOSE';
    audienceEffect: string;
    priority: 'CORE' | 'OPTIONAL';
    instruction: string;
    appliesWhen: string[];
    avoidWhen: string[];
    antiPatterns: string[];
  }>;
}
```

`priority` không có nghĩa CORE phải nhồi vào mọi bài. Nó chỉ nói rule nào định nghĩa identity của Formula; `appliesWhen/avoidWhen` vẫn thắng trong một bài cụ thể.

### 8.5 Phân biệt source leak với domain scope

| Loại | Xử lý | Ví dụ |
|---|---|---|
| Source-specific | Loại hoặc rewrite bắt buộc | tên kênh, catchphrase, timestamp, nhân vật riêng, con số của video |
| Domain-specific nhưng đúng scope | Được giữ | “dòng tiền”, “lãi kép” trong Formula có `domain: personal-finance` |
| Genre-specific | Được giữ | reveal tăng dần trong Formula storytelling |
| Generic nhưng rỗng | Reject/rewrite | “mở đầu hấp dẫn”, “kể chuyện tự nhiên”, “dùng bằng chứng phù hợp” |
| Portable technique | Giữ | “đặt tên lực cản trung tâm và dùng lại như motif” |

Vì vậy `detectTopicLeak` không được hard-block chỉ vì thấy một domain noun. Finding phải được đối chiếu với `scope`: “Sói Tài Chính” là source identity; “tài chính cá nhân” có thể là scope hợp lệ.

### 8.6 Formula-level coherence gate — nhẹ, không thêm workflow lớn

Một tập rule tốt riêng lẻ vẫn có thể tạo Formula tệ nếu chúng kéo bài theo các hướng khác nhau. Trước human approve, UI cần một review panel duy nhất:

- `editorialPromise` có được ít nhất một CORE rule thực hiện không?
- Hai CORE rule có mâu thuẫn trực tiếp không?
- Có rule nào chỉ là phiên bản mơ hồ hơn của rule khác không?
- Formula có quá nhiều CORE rule khiến Writer không còn quyền thích nghi không?
- Mọi rule có editorial function và audience effect đọc được không?

Không tạo state machine/conflict subsystem mới. Panel chỉ sinh advisory findings; human phải Resolve/Edit/Waive trước approve, dùng cùng cơ chế finding của Bước 2.

### 8.7 Không khôi phục transfer test bắt buộc

Editorial review này **không** đảo quyết định ở §4.1:

- “Viết thử” vẫn là nút tùy chọn để user cảm nhận output.
- Một bài thử không chứng minh Formula làm nội dung tốt hơn.
- `WRITER_READY + TRIAL` chỉ có nghĩa contract sạch, source leak đã xử lý và human cho phép dùng.
- `VALIDATED` chỉ đến từ blind evaluation trên nhiều topic theo §4.2.

Điều phải tránh trong UI copy:

- Không ghi “đã kiểm chứng hiệu quả” sau khi migrate.
- Không gọi một Formula một nguồn là “công thức chung đã được chứng minh”.
- Hiển thị rõ `TRIAL`, source diversity và số lần Formula đã được dùng/đánh giá.

### 8.8 Acceptance criteria của editorial layer

- [ ] WHEN migration begins, THE SYSTEM SHALL require a human-approved scope and `editorialPromise` before SYNTHESIZE.
- [ ] WHEN a proposed rule becomes source-independent but non-actionable, THE SYSTEM SHALL flag it as `GENERIC_BUT_EMPTY` for human review.
- [ ] WHEN a term belongs to the declared domain rather than the source video's identity, THE SYSTEM SHALL allow a scoped human decision instead of treating the term as an automatic leak.
- [ ] WHEN a Writer Formula is approved, EVERY rule SHALL state its editorial function, audience effect, priority, application conditions, and anti-patterns.
- [ ] WHEN CORE rules contradict or fail to support the Formula's editorial promise, THE SYSTEM SHALL block approval until the finding is resolved or explicitly waived.
- [ ] WHEN a Formula is merely Writer-ready, THE UI SHALL label it `TRIAL` and SHALL NOT imply measured quality improvement.
