# Plan chi tiết — Write Loop v2

> Ngày: 2026-08-14
> Căn cứ: design "Write Loop v2" (artifact 3f2cd0f3) + audit giả thuyết (artifact b66ed11b) + dữ liệu 9 lab-run, 7 writer-run.
> Trạng thái: **ĐÃ TRIỂN KHAI (2026-08-14)** — code Phase 0/1/3/4 xong, test xanh.
> Phase 2 mới có 5/30 entry (mẫu). Acceptance E2E với agent thật chưa chạy — cần restart daemon.

## Trạng thái triển khai (2026-08-14)

| Phase | Trạng thái | File chính |
|---|---|---|
| 0 — gate tất định | ✅ code + test (18 test, fixture thật của run `7d626c50`) | `packages/daemon/src/writer/deterministic-gate.ts`, `packages/daemon/src/writer/script-checks.ts` |
| 1 — lab gọn | ✅ code + test (2 vòng mặc định, band 800–1500, forced choice, ruleVerdicts) | `packages/daemon/src/training/training-lab.ts` |
| 2 — `hieu-tv.md` | ⚠️ **5/30 entry** (09, 08, 103, 07, 137) + TASTE DNA 6 yếu tố, quote đã verify verbatim | `writer-room-data/general-packs/hieu-tv.md` |
| 3 — write flow 2-call | ✅ code + test + HTTP + UI | `packages/daemon/src/writer/writer-run-v2.ts`, `general-pack.ts`, `run-store-v2.ts`, `packages/web/src/pages/WriterV2.tsx` |
| 4 — refine 3 lớp | ✅ trong cùng settle machine của v2 (13 test, có test tái hiện case `86de3ca5`) | `writer-run-v2.ts` |

Sai lệch có chủ ý so với plan (đã đo trên dữ liệu thật, không phải cắt xén):

1. **Gate check 4 (coined labels)** chỉ bắt nhãn *thấy được là nhãn*: cụm trong ngoặc kép
   lặp ≥3 lần, cụm viết hoa lặp, và `coinedLabels` writer tự khai ở stage WRITE. Mọi bộ
   dò n-gram tổng quát (lặp ≥3, lặp + vị trí định danh) đều bắn ≥3 nhãn trên CẢ script
   sạch khi thử trên 4 script thật — một gate lúc nào cũng đỏ thì không phải gate. Nhãn
   viết thường không khai báo giao cho editor lớp 1 (checklist §12).
2. **Gate check 1** chỉ bắt số dạng chữ số và số-chữ ghép (“hai mươi lăm triệu”), không
   bắt numeral một chữ (“bốn năm trước”). Fixture thật vẫn cho 15 claim vô nguồn ≥ mốc 12.
4. **Đường thoát “kiến thức phổ thông”** (thêm 2026-08-14 theo quyết định của người dùng:
   *“những kiến thức phổ thông để agent thoải mái writer”*). Gate không bắt số nữa khi:
   mốc thời gian đời thường ≤ 12 đơn vị (“3 tới 6 tháng”, “trả góp 12 tháng”); phân số quy
   ước 0/25/50/75/100%; hoặc quy ước ngành ≤ 100 **có dẫn nguồn nhìn thấy được** trong câu
   (“chuyên gia thường khuyên…”, “thông thường…”). **Không bao giờ áp dụng cho: tiền
   (đồng/nghìn/triệu/tỷ/usd), tuổi, “N lần”, số thập phân, và mọi giá trị > 100 — nên năm
   (1994) và thế kỷ vẫn phải có nguồn**, đúng nguyên tắc “số liệu khoa học/lịch sử không
   được bịa”. Cùng lúc vá một lỗ thật: trước đó “năm 1994” (đơn vị đứng trước số, trật tự
   tiếng Việt) không hề bị trích ra — giờ có `DATE_CLAIM_RE`.
3. **Phase 2** dừng ở 5 entry mẫu theo quyết định của người dùng; quy trình + danh sách 25
   transcript còn lại nằm cuối file `hieu-tv.md`.

## 0. Phạm vi và nguyên tắc

**Giữ nguyên (không đụng):**
- Formula schema + cơ chế evidence 2 phía verbatim (`validateCritique`, `isExactQuote`) — phần chắc nhất của hệ.
- Hạ tầng dispatch: `LaneScheduler.dispatchItem`, batchId/itemId/attempt, settle-listener pattern.
- Schema `WriterVideoPlan` trong `video-plan.ts` — tái dùng làm schema outline, không viết lại.
- Nguyên tắc "bài nén" trong lab.

**Thay/bỏ:**
- Taste RAG trong writer (`taste-rag.ts` + editorial-decision retrieval ở plan stage) → general pack dạng file.
- `maxRounds = 3` → 1–2 round.
- Band 25–45% theo video nguồn → band tuyệt đối 800–1.500 từ.
- Reviewer LLM một-lượt làm factual gate → gate tất định (code) + editor 3 lớp.
- Tinh chỉnh formula chuyển trọng tâm sang giai đoạn tái dựng (reconstruction) sau merge.

**Thứ tự phụ thuộc:**

```
Phase 0 (gate) ──┬─→ Phase 1 (lab gọn)
                 ├─→ Phase 3 (write flow 2-call) ─→ Phase 4 (refine 3 lớp)
Phase 2 (hieu-tv.md) ─→ Phase 3
```

Phase 1 và Phase 2 chạy song song được.

**Ngoài phạm vi triển khai:** Giai đoạn B — tái dựng theo title gốc (hidden case) — bạn tự chạy tay
sau khi Writer xong: có formula → merge trong Training Lab → viết thử theo title gốc → quay lại sửa
formula/profile. Design chi tiết (hold-out video đích, diff 5 lớp, cổng craft + ≥2 title) giữ ở design
doc để dùng khi tới lúc. Điểm nối duy nhất phía code: write flow v2 (Phase 3) nhận `videoIds` loại trừ
khi build topic pack — có sẵn từ `source-pack.ts`, không cần làm thêm gì.

---

## Phase 0 — Gate tất định (~1 buổi)

Nền cho mọi phép chấm phía sau. Không LLM, chạy < 1 giây, chặn cứng.

### File mới
`packages/daemon/src/writer/deterministic-gate.ts` + test `packages/daemon/test/writer/deterministic-gate.test.ts`

### API

```ts
interface GateInput {
  script: string;
  packMarkdown: string;          // topic pack
  factsLedger?: LedgerEntry[];   // từ Phase 3; optional để dùng được ngay cho bài cũ
  outline?: WriterVideoPlan;     // để check beat coverage
  beatAnchors?: string[];        // exact quotes writer tự khai, 1/beat
  wordRange?: { minWords: number; maxWords: number };
  forbiddenNames: string[];
}

interface GateResult {
  passed: boolean;
  violations: GateViolation[];   // { code, detail, quote? }
}
```

### Các check (theo thứ tự)

1. **Numeric claims**: regex `\d[\d.,]*\s*(triệu|nghìn|tỷ|đồng|tuổi|lần|%|năm|tháng)` trên script → mỗi token phải khớp (chuẩn hoá `.`/`,`/khoảng trắng) với ledger; ledger quote phải là substring của pack. Không có ledger (bài cũ) → khớp thẳng vào pack.
2. **Proper nouns**: tên riêng viết hoa không nằm trong pack/ledger (heuristic: token viết hoa giữa câu, loại stopwords VN) → flag.
3. **Assumption escape**: số/tên không có nguồn được tha **chỉ khi** câu chứa nó có marker giả định (`giả sử`, `ví dụ`, `thử hình dung`, `tạm lấy`) — đây là đường thoát hợp lệ cho "tình huống giả định nói rõ là giả định". Không marker → violation.
4. **Coined labels ≤ 2**: đếm cụm được đặt tên riêng + lặp ≥3 lần (cụm trong ngoặc kép hoặc cụm danh từ viết hoa lặp) — chặn kiểu "mặt sàn lối sống / chi tiêu danh tính / quyền nhúc nhích" (3 nhãn một bài).
5. **Beat coverage**: mỗi beat của outline phải có `beatAnchor` là exact substring của script (tái dùng logic `isExactQuote`). Thiếu anchor hoặc anchor không khớp → violation (bắt lỗi "viết một lèo rơi beat").
6. **Word band + forbidden host names**: tái dùng `targetWordRange` và `forbiddenHostNames` hiện có.

### Acceptance
- Fixture: script run `7d626c50` + pack `1c24954b` → gate flag **≥ 12** numeric claims (danh sách 12 số bịa đã xác định trong audit: 380.000, 28 tuổi, 9 triệu, 2,5 triệu, 6,5 triệu, 2,2 triệu, 1,5 triệu, 13 triệu, 20–25 năm, tháng thứ tám, bốn năm, 25 triệu-lộ-trình).
- Script chỉ dùng facts trong pack → 0 violation.
- Câu "Giả sử lương bạn 30 triệu…" với 30 triệu không trong pack → pass nhờ marker.

---

## Phase 1 — Lab gọn (~1 buổi–1 ngày)

Sửa `packages/daemon/src/training/training-lab.ts` + test.

### Thay đổi

1. **`maxRounds`: 3 → mặc định 2, cho phép 1** (param của `startTrainingLabRun`).
2. **Word band tuyệt đối**: bỏ tính theo `~25–45%` độ dài nguồn; cố định `minWords: 800, maxWords: 1500`. Sửa prompt DRAFT tương ứng (bỏ câu "~25-45% of the real source video's length").
3. **Ép REFINE ra quyết định** — sửa `buildRefinePrompt` + validator:

```jsonc
// out/result.json của REFINE, shape mới
{
  "ruleChanges": [
    { "ruleId": "rule-3", "action": "edit|add|remove|narrow",
      "statement": "...", "sourcePatternIds": ["n1","n2"] }
  ],
  "notARuleProblem": [
    { "patternId": "n3", "reason": "lỗi thi hành của draft, rule đúng" }
  ]
}
```

   Validator từ chối khi tồn tại negative pattern id không xuất hiện trong `sourcePatternIds` của bất kỳ ruleChange nào **và** không có trong `notARuleProblem`. Hết đường trả 0–0 (hiện tại 9/9 run `ruleChanges = 0`).
4. **Rule verdict cuối run**: sau round cuối, tổng hợp per-rule từ critique + appliedRules:

```ts
ruleVerdicts: Array<{
  ruleId: string;
  exercised: number;      // số round draft có áp
  hurtCount: number;      // số negative pattern trỏ vào rule
  verdict: 'KEEP' | 'SUSPECT' | 'DROP_BEFORE_MERGE';
}>
```

   Quy tắc: 0 lần exercised sau 2 round → `DROP_BEFORE_MERGE`. Bị negative ở mọi round có áp → `SUSPECT` (người quyết khi merge). Còn lại `KEEP`.
5. **Không thêm** per-rule ledger dài hạn, không thêm vòng hội tụ — lab dừng ở vai "vớt rule dễ thấy, loại rule không thi hành được".

### Acceptance
- Run lab mới trên 1 formula thật: hoàn thành 2 round, `ruleVerdicts` có đủ mọi rule, refine round nào có negative pattern thì `ruleChanges + notARuleProblem` phủ hết pattern đó.
- Draft 2 round đều trong band 800–1.500 kể cả khi video nguồn dài 18k+ chars.

---

## Phase 2 — Soạn `hieu-tv.md` (~1 ngày, agent-assisted + duyệt tay)

### Vị trí + versioning
- File: `writer-room-data/general-packs/hieu-tv.md` (thư mục mới).
- Header file: `<!-- version: 1 | generated: ... -->`. Khi dùng trong run: pin `generalPackHash = sha256(nội dung)` vào run record.
- **Một file một kênh.** Kênh khác (anh-ba…) là file riêng. Không merge.

### Cấu trúc

```markdown
# Hieu TV — Source Pack General
<!-- version: 1 -->

## TASTE DNA (cấp kênh — đọc trước mọi entry)
1. **Chính sách cá nhân, lệch chuẩn có chủ đích** — nêu chuẩn chung rồi công khai
   lệch bằng khẩu vị riêng. Quote: "tôi thì tôi theo một cái trường phái nó chắc
   chắn hơn… nên là 1 năm" (09)
2. **Số có dán nhãn trạng thái** — [số thật] [tròn cho dễ tính] [thậm xưng] [lấy đại].
   Quote: "tôi sẽ lấy một cái ví dụ thậm xưng… 1 tỷ một tháng" (09)
3. **Quan sát gộp, không tiểu sử giả** — case không tên/tuổi, độ cụ thể khớp mức
   bằng chứng. Quote: "mỗi khi mà tôi hỏi ai đó… câu trả lời phổ biến" (09)
4. **Đường may lộ** — tự sửa hiểu lầm tích luỹ, thú nhận đổi kế hoạch giữa bài,
   cho phép bỏ qua đoạn. Quote: "ban đầu… tôi dự định gói gọn trong một bài" (09)
(+ 2 yếu tố per-video, ghi ở entry: ví dụ chạy suốt · steelman phe đối lập)

## <Tiêu đề video> | <views> | <phút>
- **Hook**: nước đi mở bài thật (1–2 câu trích sát) + nó gài món nợ gì
- **Outline**: các beat — mỗi beat ghi *thông tin mới*, không chỉ tên mục
- **Example**: case/số + tag nguồn gốc & trạng thái:
    [số có nguồn: tên + năm] · [kinh nghiệm host] · [quan sát gộp]
    · [thậm xưng có dán nhãn] · [nhân vật hư cấu — KHÔNG bắt chước]
  + có "ví dụ chạy suốt" không, re-run ở mức nào
- **Payoff**: ending trả nợ hook bằng gì + để lại việc gì cho người xem
- **Ranh giới**: điều video cố tình KHÔNG làm; có steelman phe nào không
```

### Quy trình soạn
1. **TASTE DNA soạn tay** từ 3 script đại diện (`09`, `08`, `103`) — mỗi yếu tố bắt buộc ≥1 quote nguyên văn. (Bản nháp 6 yếu tố đã có trong design doc, việc còn lại là đối chiếu thêm 2 script để xác nhận đó là bất biến kênh chứ không phải đặc điểm 1 tập.)
2. **30 entry sinh bằng agent**, mỗi transcript trong `writer-room-data/spy/hieu-tv-transcripts/` một call, theo template trên; prompt yêu cầu: quote hook nguyên văn, tag Example bắt buộc, và cấm suy diễn nội dung không có trong transcript.
3. **Người duyệt** ít nhất 2 cột: tag nguồn gốc Example (đúng loại chưa — nhất là `[nhân vật hư cấu]`) và dòng Ranh giới (có thật là điều video né không).

### Acceptance
- ≤ 12.000 từ tổng. Đủ 30 entry, mỗi entry đủ 5 trường, mọi Example có ≥1 tag.
- Grep nhanh: mọi quote trong TASTE DNA là substring thật của transcript tương ứng.

---

## Phase 3 — Write flow 2-call (~2 ngày)

Mới: `packages/daemon/src/writer/writer-run-v2.ts` (+ store/http). Chạy song song flow cũ, không xoá code cũ trong phase này.

### Run record v2 (rút gọn)

```ts
interface WriterRunV2 {
  id: string;
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'FAILED_GATE';
  phase: 'STUDY' | 'WRITE' | 'GATE' | 'EDIT_REVIEW' | 'REPAIR' | 'DONE' | 'FAILED';
  brief: string; requestedTitle?: string; targetWords?: number;
  packId: string;                    // topic pack — bắt buộc
  generalPackPath: string;           // vd 'general-packs/hieu-tv.md' — bắt buộc
  generalPackHash: string;           // pin
  formulaId: string; formulaVersion: number; formulaHash: string;  // thay profile pin
  study: StudyArtifact | null;       // output Call 1
  draft: { title: string; script: string; outlineChanges: string[]; beatAnchors: string[] } | null;
  gateResults: GateResult[];         // mỗi lần chạy gate một entry
  editorDefects: EditorDefect[] | null;
  finalScript: string | null;
  createdAt: string; updatedAt: string; errorCode?: string; errorReason?: string;
}
```

Ghi chú: v2 **bỏ dependency vào Profile** — formula (đã qua lab + merge) là hợp đồng style; rubric review thay bằng refine 3 lớp (Phase 4). Anti-pattern factual duy nhất được thi hành bằng gate, không bằng lời hứa của reviewer.

### Call 1 — STUDY (stage `study-v2`)

Envelope, **theo đúng thứ tự này** trong prompt:
1. Hợp đồng: vai + định nghĩa khán giả kênh mình + formula (view gọn: statement các rule, không evidence).
2. Tiêu đề + brief.
3. **Topic pack toàn bộ** (`pack.markdown`).
4. Chỉ dẫn khai thác — **đặt sau pack**: từng video nguồn nói gì / góc nào đã phủ; gap nào chưa ai làm × hợp khán giả mình; chọn 1 góc.

Output `out/result.json`:

```jsonc
{
  "coverageMap": [ { "videoId": "...", "mainClaim": "...", "angle": "..." } ],
  "gap": "...",
  "outline": { /* đúng schema WriterVideoPlan: coreInsight, memoryAnchor,
                  progression[2-8] (beat/newInformation/characterOrArgumentChange/visualAnchor),
                  endingPayoff, cutList */ },
  "factsLedger": [ { "fact": "mốc 25 lần chi phí năm", "videoId": "PJPhR58LBYA",
                     "quote": "<substring nguyên văn của pack>" } ]
}
```

Validator `validateStudyArtifact`: outline qua `validateWriterVideoPlan` (tái dùng nguyên hàm); mọi `ledger.quote` phải là exact substring của pack markdown; coverageMap phủ đủ videoIds của pack.

### Call 2 — WRITE (stage `write-v2`)

Envelope theo thứ tự: (1) formula gọn + outline + factsLedger, (2) **general pack toàn bộ**, (3) chỉ dẫn sau pack + task.

Hard rules trong prompt:
- General pack là **cách làm** (hook shape, example strategy, payoff, taste DNA) — **cấm** lấy số liệu/case/nhân vật từ nó.
- Dữ kiện chỉ từ `factsLedger`. Style đòi ví dụ người thật mà ledger không có → dùng tình huống giả định có marker (`giả sử…`), cấm đặt tên + tuổi + địa danh cho nhân vật giả định.
- Trước khi viết: ghi `outlineChanges` 3–5 dòng (đổi gì so với outline v1, học từ entry nào của general pack) — để trace.
- Viết **một lèo** toàn bộ script; sau khi viết, khai `beatAnchors`: mỗi beat một quote nguyên văn từ script.

Output: `{ "title", "script", "outlineChanges": [], "beatAnchors": [] }`.
Validator: word band; forbidden names; `beatAnchors.length === outline.progression.length` + mỗi anchor là exact substring.

### HTTP
- `POST /api/writer/v2/runs` — body: `{ packId, generalPack, formulaId, brief, requestedTitle?, targetWords? }`.
- `GET /api/writer/v2/runs`, `GET /api/writer/v2/runs/:id`.
- UI tối thiểu: trang list + detail đọc JSON (tái dùng pattern trang Writer hiện có; không cần đẹp ở phase này).

### Acceptance
- 1 run E2E title mới (không trùng video nguồn): `study` đầy đủ, ledger ≥ 3 facts đều verify được, script trong band, đủ beatAnchors. Daemon restart trước khi test (bài học run v2/v4 cũ).

---

## Phase 4 — Refine 3 lớp (~1 ngày)

Nối vào settle-flow của v2 sau Call 2.

### Lớp 0 — gate (code)
Chạy `deterministic-gate` với đủ input (ledger + outline + beatAnchors). Có violation → sang Lớp 1 kèm violations; sạch → vẫn sang Lớp 1 (editor soi thứ máy không soi được).

### Lớp 1 — editor LLM (stage `edit-review-v2`)
- **Model/agent khác** với writer (`agentId` riêng, config trên run).
- Envelope **chỉ gồm**: title + outline + script (+ gate violations nếu có). Không pack, không general pack, không self-report của writer.
- Nhiệm vụ (checklist §12 learnings): recall 1 câu; thử xoá/đổi chỗ 2–3 đoạn; ending trả nợ hook chưa; new-info từng đoạn; **soi riêng 20% cuối** (điểm suy giảm của bài một-lèo).
- Output: `defects: [{ quote, severity: 'HIGH'|'MEDIUM'|'LOW', note }]` — quote exact substring, validator kiểm. Cấm đề xuất viết lại toàn bài. 0 defect hợp lệ.

### Lớp 2 — repair (stage `repair-v2`, tối đa 1 vòng)
- Writer nhận: defects + gate violations + outline + script. Sửa tại chỗ, giữ phần tốt, cập nhật beatAnchors nếu câu anchor bị sửa.
- Sau repair: **chạy lại chỉ Lớp 0**. Sạch → `DONE` (finalScript). Còn đỏ → `FAILED_GATE` + `errorReason` liệt kê violations, chờ người. **Không lặp thêm** — vòng 2+ nuôi "diễn tuân thủ".
- `passed`/`DONE` chỉ tồn tại khi gate sạch — sửa đúng lỗi `86de3ca5` (reviewer flag `violated: true` mà run vẫn `passed: true, DONE`).

### Acceptance
- Test tái hiện: cho script kiểu `86de3ca5` (case bịa) chạy qua v2 → kết thúc `FAILED_GATE`, không bao giờ `DONE`.
- Run sạch E2E: STUDY → WRITE → GATE → EDIT_REVIEW → REPAIR → GATE → DONE.

---

## Giai đoạn B — tái dựng theo title gốc (NGOÀI PHẠM VI — bạn tự chạy)

Không code, không harness ở đợt này. Khi Writer v2 xong, bạn chạy tay theo trình tự đã thống nhất:
formula → merge trong Training Lab → viết thử theo title gốc bằng write flow v2 → so với script gốc →
quay lại sửa formula/profile.

Ghi chú vận hành để dùng khi tới lúc (chi tiết đầy đủ ở design doc):
- **Hold-out video đích**: tạo run v2 với topic pack build từ `videoIds` loại video đích (param có sẵn),
  và tạm rút entry của video đích khỏi `hieu-tv.md` (xoá tay section, hash pin sẽ ghi nhận bản đã rút).
- **Diff 5 lớp** khi so tay: hook (gài nợ gì) · trình tự beat · loại bằng chứng · lập trường · payoff.
- **Cổng nhận hidden case**: craft (chuyển được sang đề khác) + xuất hiện ≥ 2 title; đời tư thật của host
  → rule "cần nguồn tự thân thật", không thành "bịa tiểu sử".
- Lịch gợi ý: `09` → `07` → `04` → `10`; hold-out nghiệm thu `137`.

---

## Rủi ro & guardrail

| Rủi ro | Guardrail |
|---|---|
| Ledger quá chặt làm bài khô cứng | Đường thoát assumption-marker (gate check 3); editor Lớp 1 soi "bài có khô không" là defect MEDIUM |
| Writer khai `beatAnchors` gian | Exact-substring check; anchor sai = gate violation |
| General pack lẫn vào facts | Rule cấm trong prompt Call 2 + gate: số trong script phải truy về ledger (ledger chỉ build từ topic pack) |
| `hieu-tv.md` bị sửa giữa chừng | `generalPackHash` pin từng run |
| Lab vẫn trả tay trắng | Validator forced-choice (Phase 1.3) — vá trước khi bạn chạy merge, để ruleVerdicts có nghĩa |
| Daemon giữ code cũ khi test | Mỗi phase acceptance đều bắt đầu bằng restart daemon + verify version field mới xuất hiện trong run record |

## Điều kiện bắt đầu

1. Chốt plan này (bạn duyệt).
2. Xác nhận model/agent cho 2 vai: writer và editor (khác writer).
3. Phase 0 làm trước tiên — mọi phase sau đều tựa vào gate.
