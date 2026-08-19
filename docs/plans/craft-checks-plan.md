# Plan — Craft Checks: Triad, Burstiness, Forbidden Phrases

> Ngày: 2026-08-17
> Căn cứ: phân tích run `9bf99a61` (bài "Trả góp 0%", DONE, 2300 từ) + so sánh workflow NotebookLM vs Writer Room.
> Trạng thái: **KHÔNG TRIỂN KHAI — superseded 2026-08-18.**

> **Superseded 2026-08-18:** plan này **đã bị bác bỏ sau khi verify bằng code thật**, đừng
> implement. Ba nhận định lõi (ẩn dụ lặp · nhịp câu đều · cấu trúc song song) là ĐÚNG và đã
> được giữ lại, nhưng chuyển sang chỗ khác: hai cái đầu vào CLI `bun writer:regate` (Mục 4 và
> Mục 5, chế độ báo cáo), cái thứ ba vào checklist EDIT_REVIEW (câu 8). Xem
> `docs/plans/channel-style-craft-checks-process.md` §5 để có đủ 7 lỗi đã verify. Bốn lỗi chặn:
> ① toàn bộ plan dựa vào một tầng WARNING **không tồn tại** — `deterministic-gate.ts` trả
> `passed: violations.length === 0`, nên mọi violation đều là hard block và sẽ **ăn hết vòng
> repair duy nhất**, tranh với lỗi factual; ② §2b/§2c nhắm vào nhánh **Profile đã bị v2 loại bỏ**
> (`writer-run-v2.ts` có 0 lần xuất hiện từ `profile`; run `9bf99a61` dùng `formulaId` v34,
> không có `profileId`); ③ **AC-1 fail** — chạy `countTriads()` nguyên văn theo plan trên chính
> run làm căn cứ cho ra **1**, không phải ≥2, và triad được plan dẫn làm bằng chứng lại không bị
> hàm này bắt (first-token `Hợp → Anh → Anh`, chuỗi chỉ dài 2); ④ **AC-2 fail** — bài có **7**
> câu ≤5 từ (min 1 từ), không phải 0. Ngoài ra `forbiddenPhrases` đề xuất sẽ cấm
> `bánh xe hamster` — cụm này **có trong topic pack**, là `factsLedger[24]`, và là ẩn dụ vận
> hành được duy nhất của bài.

---

## 0. Vì sao cần làm

### Bằng chứng từ run thực

Run `9bf99a61` là bài đã qua đầy đủ pipeline v2: STUDY → WRITE → gate → EDIT\_REVIEW → DONE.
`gateResults[0].passed = false` (NUMBER\_UNSOURCED), được repair và pass round 2.
`editorDefects` ghi 5 lỗi cấu trúc (HIGH × 2, MEDIUM × 3) — toàn bộ đều là lỗi factual/logic.

**Không một defect nào flag các vấn đề sau:**

| Vấn đề craft | Bằng chứng trong run `9bf99a61` |
|:---|:---|
| Triad (ba câu song song cùng cấu trúc) | `"Hợp đồng của anh không sai một chữ. Anh chưa trễ một kỳ nào. Anh thật sự không trả một đồng lãi nào."` — ba câu "Anh + verb + không" cuối bài. Thêm một triad khác trong đoạn quote. |
| Thiếu câu siêu ngắn | Không có câu nào ≤ 5 từ trong toàn bài 2.300 từ. Bài đọc đều nhịp từ đầu đến cuối — dấu hiệu của nhịp AI. |
| Metaphor lặp | "guồng" xuất hiện 4 lần: "chạy trong guồng", "ra khỏi guồng", "bánh xe hamster... càng chạy nhanh", "guồng tài chính". Một bài lặp một hình ảnh 4 lần là formulaic. |

### Vì sao pipeline hiện tại bỏ qua

`deterministic-gate.ts` chỉ có 6 check, tất cả về factual grounding — không có check nào về nhịp câu hay cấu trúc ngôn ngữ. Thiết kế đúng cho mục tiêu của nó.

`quality-review.ts` xây rubric từ Profile guidelines + anti-patterns — LLM reviewer (Codex) đánh giá. Vấn đề: Codex không được hướng dẫn cụ thể để đếm triads hay đo sentence-length distribution. Profile `294ced86` v4 có 5 anti-pattern và 18 guidelines — không cái nào đo được bằng số.

Kết quả: craft issues không có điểm vào nào để bị phát hiện — không phải reviewer vô năng, mà là không có công cụ.

---

## 1. Quyết định thiết kế

### Q1: Triad counter đặt ở gate hay rubric?

**Quyết định: gate (WARNING, không FAIL cứng).**

Lý do: triad trong tiếng Việt thường là hợp lệ (liệt kê 3 bước hành động, 3 câu hỏi cuối bài). Hard-block ngay sẽ false-positive cao — bài "Trả góp 0%" có triad cuối bài như câu kết luận, không phải AI-tell. Nhưng ≥ 2 triad cấu trúc giống nhau trong cùng một bài **là** dấu hiệu AI-formulaic. Đặt ở gate vì: (1) code, không LLM, chạy < 1 giây; (2) cho phép tuỳ chỉnh ngưỡng theo Profile nếu cần sau; (3) không phụ thuộc M0.5 hay bất kỳ BLOCKER nào.

**Quyết định chưa chốt — cần người dùng xác nhận ngưỡng:**
- Option A: `TRIAD_COUNT ≥ 2` → WARNING (ghi vào violations, không block DONE)
- Option B: `TRIAD_COUNT ≥ 3` → WARNING

Mặc định đề xuất: **Option A** — căn cứ dữ liệu thực (run `9bf99a61` có đúng 2 triad và bài đọc đã có cảm giác formulaic ở kết).

### Q2: Burstiness đặt ở gate hay rubric?

**Quyết định: gate (WARNING, không FAIL cứng).**

Lý do tương tự — không phải mọi bài cần câu siêu ngắn. Nhưng một bài 2.300 từ **không có câu nào ≤ 5 từ** là bất thường và đo được bằng code. Không gọi LLM.

### Q3: Forbidden phrases đặt ở đâu?

**Quyết định: Profile schema (per-Profile, không hardcode global) + code-match trong gate.**

Lý do: khác với triad/burstiness là universal, "guồng" hay "bánh xe hamster" không phải forbidden phrase cho mọi kênh hay mọi thể loại — nó phụ thuộc vào giọng kênh. Profile `294ced86` (Soi tài chính) cần list riêng; một Profile khác có thể không cần. Hardcode global sẽ sai.

Hiện tại `antiPatterns: string[]` trong Profile là mô tả text cho LLM reviewer — **không phải** literal strings để code match. Cần field mới `forbiddenPhrases?: string[]`.

---

## 2. Thay đổi chi tiết

### 2a. `deterministic-gate.ts` — thêm 2 check mới

**File:** `packages/daemon/src/writer/deterministic-gate.ts`

**Thêm vào `GateInput` interface (sau `forbiddenNames`):**

```ts
/**
 * Strings the writer should not use verbatim — sourced from the pinned Profile.
 * Code-matched (exact substring, case-insensitive), never LLM-evaluated.
 * Absent → check is skipped entirely (backward compatible with old runs).
 */
forbiddenPhrases?: string[];

/**
 * Maximum number of triad structures allowed in the script before a WARNING
 * is emitted. Absent → check is skipped. Recommended default: 2.
 * A triad is defined as 3 or more consecutive sentences sharing the same
 * opening token pattern (subject + verb start, or ordinal "Một./Hai./Ba.").
 */
maxTriads?: number;

/**
 * If true, emit BURSTINESS_LOW when the script has no sentence of ≤ 5 words.
 * Absent / false → check is skipped.
 */
checkBurstiness?: boolean;
```

**Thêm vào `GateViolationCode`:**

```ts
| 'FORBIDDEN_PHRASE'   // a literal phrase from forbiddenPhrases appears in the script
| 'TRIAD_OVERLOAD'     // ≥ maxTriads triad structures detected
| 'BURSTINESS_LOW'     // no sentence of ≤ 5 words in the entire script
```

**Thêm 3 check mới vào `runDeterministicGate()` (sau check 6, trước return):**

```ts
// ── 7. Forbidden phrases (code-matched, per-Profile) ──────────────────────
if (input.forbiddenPhrases) {
  for (const phrase of input.forbiddenPhrases) {
    if (!phrase.trim()) continue;
    if (script.toLowerCase().includes(phrase.toLowerCase())) {
      violations.push({
        code: 'FORBIDDEN_PHRASE',
        detail: `forbidden phrase "${phrase}" appears in script — remove or rephrase`,
        quote: findFirstOccurrence(script, phrase),
      });
    }
  }
}

// ── 8. Triad overload ─────────────────────────────────────────────────────
if (input.maxTriads !== undefined) {
  const triadCount = countTriads(script);
  if (triadCount >= input.maxTriads) {
    violations.push({
      code: 'TRIAD_OVERLOAD',
      detail: `${triadCount} triad structures detected (max ${input.maxTriads - 1}) — `
        + 'parallel three-part constructions are an AI-formulaic signal',
    });
  }
}

// ── 9. Burstiness ─────────────────────────────────────────────────────────
if (input.checkBurstiness) {
  const sentences = splitSentences(script);
  const hasShort = sentences.some((s) => s.split(/\s+/).filter(Boolean).length <= 5);
  if (!hasShort) {
    violations.push({
      code: 'BURSTINESS_LOW',
      detail: 'no sentence of ≤ 5 words found in the entire script — '
        + 'uniform sentence length is a detectable AI-writing signal',
    });
  }
}
```

**Helper `countTriads()` — thêm vào cuối file (trước `formatGateViolations`):**

```ts
/**
 * Count triad structures: 3+ consecutive sentences that all start with the
 * same grammatical pattern.
 * Two patterns are detected:
 *   A) Subject-repeat triads: "Anh không X. Anh chưa Y. Anh thật Z."
 *      — consecutive sentences sharing the same first token.
 *   B) Ordinal triads: sentences beginning with "Một.", "Hai.", "Ba." in order.
 *
 * Returns the number of distinct triad groups found.
 */
export function countTriads(script: string): number {
  const sentences = splitSentences(script);
  let triadGroups = 0;
  let runLength = 1;
  let runToken = '';

  for (let i = 1; i < sentences.length; i++) {
    const prev = sentences[i - 1] ?? '';
    const curr = sentences[i] ?? '';
    const prevToken = (prev.split(/\s+/)[0] ?? '').toLowerCase();
    const currToken = (curr.split(/\s+/)[0] ?? '').toLowerCase();

    if (prevToken && currToken && prevToken === currToken) {
      if (runToken === prevToken) {
        runLength += 1;
      } else {
        runToken = prevToken;
        runLength = 2;
      }
      if (runLength === 3) triadGroups += 1; // count once at the threshold
    } else {
      runToken = '';
      runLength = 1;
    }
  }
  return triadGroups;
}
```

**Helper `findFirstOccurrence()` — thêm gần `countOccurrences`:**

```ts
function findFirstOccurrence(haystack: string, needle: string): string {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return needle;
  const start = Math.max(0, idx - 30);
  const end = Math.min(haystack.length, idx + needle.length + 30);
  return `…${haystack.slice(start, end)}…`;
}
```

---

### 2b. Profile schema — thêm `forbiddenPhrases`

**File:** `packages/training-core/src/writer-profile.ts` (hoặc file định nghĩa `WriterProfileView` — cần xác nhận exact path khi implement)

```ts
export interface WriterProfileGuideline {
  id: string;
  instruction: string;
  when?: string;
  avoidWhen?: string;
  priority: 'CORE' | 'OPTIONAL';
  sourceRuleIds?: string[];
}

export interface WriterProfileView {
  kind: 'WRITER_READY_PROFILE';
  id: string;
  version: number;
  label: string;
  readiness: 'TRIAL' | 'VALIDATED';
  editorialPromise: string;
  guidelines: WriterProfileGuideline[];
  /** Descriptions evaluated by the LLM reviewer — unchanged. */
  antiPatterns: string[];
  /**
   * NEW — Literal phrases that must not appear verbatim in any script using
   * this Profile. Matched in code (deterministic-gate check 7), not by LLM.
   * Profile owner is responsible for keeping this list calibrated:
   * too many entries → false positives on clean writing.
   * Absent / empty → check is skipped.
   */
  forbiddenPhrases?: string[];
}
```

**Profile `294ced86` (Soi tài chính) — thêm field vào file JSON trực tiếp:**

```json
"forbiddenPhrases": [
  "bánh xe hamster",
  "gõ cửa",
  "đường đua"
]
```

Ghi chú: "guồng" **không** vào list vì nó xuất hiện trong source transcript thực tế của Hiếu TV — nếu thêm vào sẽ block cả việc trích dẫn trực tiếp nguồn. Cần đánh giá case-by-case trước khi thêm vào list.

---

### 2c. `writer-run-v2.ts` — truyền các param mới xuống gate

**File:** `packages/daemon/src/writer/writer-run-v2.ts`

Khi gọi `runDeterministicGate()`, bổ sung từ Profile đang pin:

```ts
const gateResult = runDeterministicGate({
  script: draft.script,
  packMarkdown: pack.markdown,
  factsLedger: study.factsLedger,
  outline: study.outline,
  beatAnchors: draft.beatAnchors,
  wordRange: run.wordRange,
  forbiddenNames: run.forbiddenNames,
  // ── NEW ──
  forbiddenPhrases: profile.forbiddenPhrases ?? [],
  maxTriads: 2,           // hardcode ngưỡng tại đây cho đến khi có nhu cầu per-Profile
  checkBurstiness: true,  // bật cho mọi v2 run
});
```

Lý do hardcode `maxTriads: 2` tại call-site thay vì per-Profile: ngưỡng này là nhận xét kỹ thuật (AI-signal), không phải taste của Profile. Nếu sau này cần per-Profile thì thêm field — không cần thêm ngay.

---

## 3. Acceptance Criteria

| Criterion | Cách kiểm tra |
|:---|:---|
| **AC-1** Script run `9bf99a61` qua gate mới → `TRIAD_OVERLOAD` được flag | Chạy `runDeterministicGate` với script đó, `maxTriads: 2` |
| **AC-2** Script run `9bf99a61` qua gate mới → `BURSTINESS_LOW` được flag | Cùng script, `checkBurstiness: true` |
| **AC-3** Phrase "bánh xe hamster" trong script → `FORBIDDEN_PHRASE` flag | Unit test với script chứa phrase, Profile có entry đó |
| **AC-4** Script sạch (đủ câu ngắn, không triad, không forbidden phrase) → 0 violation mới | Unit test với script "bình thường" để tránh regression |
| **AC-5** Run cũ (không có `forbiddenPhrases`/`maxTriads`/`checkBurstiness`) → không bị ảnh hưởng | Optional fields → các check bị skip khi absent |
| **AC-6** `countTriads()` không flag bài có 3 câu hỏi hành động cuối bài (ordinal khác nhau) | Unit test: "Một. Hai. Ba." (ordinal) vs "Anh không X. Anh không Y. Anh không Z." (subject-repeat) |

---

## 4. Thứ tự triển khai và dependency

```
2a (deterministic-gate.ts)
  ├── không có dependency nào — làm độc lập
  └── unit test trước khi merge

2b (Profile schema)
  ├── thêm type field → backward compatible (optional)
  └── cập nhật JSON file 294ced86 → thêm forbiddenPhrases[]

2c (writer-run-v2.ts)
  ├── phụ thuộc 2a (cần GateInput mở rộng)
  └── phụ thuộc 2b (đọc profile.forbiddenPhrases)
```

Không phụ thuộc M0.5, turnBridge, hay bất kỳ BLOCKER GAP nào.
Tất cả thay đổi là additive (optional fields, new check codes) — backward compatible với mọi run đang có.

---

## 5. Ngoài phạm vi plan này

- Tuỳ chỉnh `maxTriads` per-Profile — defer đến khi có bằng chứng cần thiết (> 1 Profile với ngưỡng khác)
- Ornament density / Voice Profile tracking — không đủ dữ liệu để calibrate ngưỡng, defer
- Auto-populate `forbiddenPhrases` từ transcript — cần thiết kế riêng, không làm vội
- Sửa Profile UI để expose và edit `forbiddenPhrases` — UI change, scope riêng

---

## 6. Rủi ro

| Rủi ro | Mức độ | Guardrail |
|:---|:---|:---|
| `countTriads()` false-positive trên script sạch | MEDIUM | AC-6 bắt buộc; ngưỡng là WARNING không FAIL cứng — chỉ thêm vào violations list, không block DONE |
| `forbiddenPhrases` list quá dài → block clean writing | MEDIUM | List khởi đầu ngắn (3 entry); owner Profile phải review trước khi thêm |
| Burstiness check flag bài dạng Q&A hoặc bài giáo lý (nhiều câu dài) | LOW | WARNING — không block DONE; editor layer vẫn đọc bài và quyết định cuối |
| Regression trên run cũ | LOW | Tất cả fields optional → check bị skip khi absent |
