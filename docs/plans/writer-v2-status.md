# Writer v2 — Blind Study + Claim Boundary

Tài liệu handoff ngắn gọn cho hai câu hỏi: **đích đến của thay đổi này là gì** và
**phần nào đã được implement thật**. Cập nhật 2026-09-03, xác minh trên commit sạch
`81aa99c`.

Spec đầy đủ: [`docs/specs/005-writer-study-claim-boundary/solution-design.md`](../specs/005-writer-study-claim-boundary/solution-design.md)
Lane persona/stance: [`docs/plans/writer-human-quality.md`](./writer-human-quality.md) —
**hai lane song song của cùng dự án Writer v2**, không phải hai bản của cùng một tài liệu.
Doc kia lo WRITE/GATE/REPAIR (persona, chất người); doc này lo STUDY + EDIT_REVIEW
(blind study, Claim Boundary). Chỗ chồng lấn duy nhất là persona: ở đây nó chỉ xuất hiện
như hai loại assertion (`STANCE`, `PERSONA_EXPERIENCE`) và như thứ đang chặn §5.

| Mốc | Trạng thái |
|---|---|
| Contract, schema, prompt và validator thuần | Đã implement và có test |
| Nối DIVERGE/RESEARCH/CONFRONT vào runtime | Chưa implement |
| Chạy Writer thật theo kiến trúc mới | Chưa chạy |
| Kết luận hiện tại | `CONDITIONAL PASS`, chưa phải `runtime PASS` |

---

## Số liệu dùng chung — 2026-09-03

> Khối này **giống hệt** trong `writer-human-quality.md` và `writer-v2-status.md`.
> Sửa một bên thì sửa cả hai, nếu không hai doc lại lệch như trước.

| | Giá trị | Phạm vi đo |
|---|---|---|
| Test vùng writer | **222 pass / 0 fail / 1118 assertions** | `bun test packages/daemon/test/writer/` trên commit `17d6bad` |
| Test toàn repo | **757 pass / 0 fail** | `bun test` trên commit `17d6bad` |
| Test vùng writer @`81aa99c` | 193 pass / 948 assertions | worktree tách rời **chỉ chứa commit sạch** — con số lịch sử, không so trực tiếp |
| Source artifact | **7 file** force-add trong 3 commit (`6bd1ae1` 5 · `96c73c9` 1 · `b51de0b` 1); **8 file** tracked tổng cộng dưới `writer-room-data/` | `git ls-files writer-room-data/` |
| Dòng module | Bảng module ở `writer-v2-status.md` §3 đo trên `81aa99c`; working tree lớn hơn (vd `writer-run-v2.ts` 2615 → 3060) | — |

**Trạng thái code:** ba lane đã land trong một commit `17d6bad` (2026-09-03). Tách theo
lane **bất khả thi và đã chứng minh bằng thực nghiệm**: `http.ts` làm `channelId` thành bắt
buộc trong `WriterV2PostConfigInput`, nên stage riêng lane writer cho 3 lỗi TS và 3 test
đỏ. Rollback hiện là `git revert 17d6bad`, không tách được từng lane.

---

## 1. Goal đang theo đuổi

### Vấn đề

Pipeline cũ có **một** call STUDY vừa đọc nguồn vừa dựng outline. Hệ quả: topology của
source trở thành topology của bài. Kể cả khi phủ đủ keyword và loại video trùng, bài viết
vẫn thừa hưởng thứ tự category của topic pack và đọc như một bài essay tổng hợp.

Nặng hơn: hook do người chọn được coi là bất biến. Agent chỉ được vá evidence vào hook đã
có. Đó là confirmation bias có cấu trúc — càng chạy nhiều vòng càng củng cố ý ban đầu.

Và narrator không có quyền có quan điểm, vì mọi câu đều phải truy về ledger. Kết quả là
văn không có người trong đó.

### Kết quả mong muốn

Writer phải tạo ra một bài có **đường dây tư duy riêng**, rồi mới dùng nguồn để kiểm tra,
siết và đôi khi bác bỏ đường dây đó. Topic Pack là lớp bằng chứng và phản biện; nó không
được trở thành mục lục ngầm của bài. Sau khi plan đã sống sót qua CONFRONT, General Pack,
Formula và Persona mới được dùng để triển khai thành prose tự nhiên.

Nói ngắn gọn: mục tiêu không phải “gom đủ nguồn rồi tóm tắt hay hơn”, mà là mô phỏng ba
động tác gần với cách một người viết tốt làm việc: **nảy ý độc lập → nghiên cứu không
thiên kiến → đối chất ý với thực tế**.

### Ba mục tiêu kỹ thuật

**A. Bài không mang hình dạng của nguồn.** Tách phát minh, quan sát và phán xét thành ba
bước mù nhau: hypothesis sinh ra *trước* khi thấy nguồn, nghiên cứu diễn ra *trước* khi
thấy hypothesis, đối chất xảy ra sau cùng.

**B. Evidence được quyền giết ý ban đầu.** CONFRONT có thể REBUILD hoặc REJECT cả
hypothesis lẫn hook. Một vòng lặp chỉ biết vá là confirmation bias nhiều vòng, không phải
nghiên cứu.

**C. Narrator có quan điểm, nhưng `"theo tôi"` không mở đường cho fact.** Tách năm loại
phát ngôn, và không cho marker quan điểm hạ cấp một factual detector.

### Ràng buộc

- Public state machine **không đổi**: `STUDY → WRITE → GATE → EDIT_REVIEW → REPAIR`.
  Ba sub-call nằm *trong* phase STUDY; UI không thêm stage.
- Trần **6 model call** mỗi run sau khi chọn hook (5 nếu không repair).
- Không thêm phụ thuộc ngoài: không Google, Reddit, browser, API, DB, search.

### Không phải mục tiêu

- Không bắt một video hoặc một nguồn đơn lẻ phải bao phủ toàn bộ keyword.
- Không dùng thứ tự category/video trong Topic Pack làm outline.
- Không biến trải nghiệm của người trong source thành trải nghiệm ngôi thứ nhất của
  narrator.
- Không gọi một claim là “đúng ngoài đời” chỉ vì nhiều video lặp lại; trạng thái chỉ mô tả
  mức độ Topic Pack đang chứng thực hoặc tranh chấp claim đó.

---

## 2. Kiến trúc

```
  hook (human chọn)
        │
        ▼
┌─── STUDY (public phase không đổi) ─────────────────────────┐
│                                                             │
│  DIVERGE ──────────► RESEARCH ──────────► CONFRONT          │
│  mù nguồn            mù hypothesis        thấy cả hai       │
│                                                             │
│  3 hypothesis        ResearchMap          KEEP/REBUILD/     │
│  4 provocation       claim + evidence     REJECT + hook     │
│  belief before/      exact quote          verdict           │
│  after               origin group         → final plan      │
│                                                             │
│  KHÔNG thấy:         KHÔNG thấy:          KHÔNG thấy:       │
│   pack, source,       hook, hypothesis,    raw pack,        │
│   ResearchMap,        general, formula,    persona prose,   │
│   general, formula,   persona              quote ngoài      │
│   persona                                  ResearchMap      │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
      WRITE ──► GATE (2 validator) ──► EDIT_REVIEW ──► REPAIR (1 lần)
                deterministic
                + assertion boundary
```

**Vì sao ba call chứ không hai.** Bản MVP hai call đạt được *research không thấy outline*,
nhưng hypothesis sinh sau khi ResearchMap đã tồn tại nên không thực sự mù nguồn. Không thể
đạt cả hai chiều mù bằng đúng hai LLM call. Chủ kênh chọn bản đầy đủ, chấp nhận +50–67%
số call.

### Claim Boundary (ADR-004)

Năm loại phát ngôn, mỗi câu được bảo vệ bằng một `assertionAnchor` là substring chính xác
của script:

| Loại | Cần gì |
|---|---|
| `FACT` | claim ID chưa bị reject |
| `COMMON_KNOWLEDGE` | whitelist |
| `STANCE` | persona stance entry đã duyệt |
| `HYPOTHETICAL` | marker nhìn thấy được + chủ thể ẩn danh |
| `PERSONA_EXPERIENCE` | persona experience entry đã duyệt |

**Luật xương sống:** mọi số tiền, %, tuổi, năm, "N lần", proper noun, study attribution,
external case đều là `FACT` **bất kể tiền tố "theo tôi"**. Stance marker không bao giờ
override factual detector.

---

## 3. Implementation đã làm

Phần dưới đây chỉ tính code/docs đã nằm trong lịch sử Git đến `81aa99c`. Nó không tính
các thay đổi đang unstaged của lane khác trong shared worktree.

### Commit

| Commit | Nội dung |
|---|---|
| `3d49d7e` | Hoãn stance + lateral-gap, giữ persona wiring |
| `6bd1ae1` `96c73c9` `b51de0b` | Track 7 source artifact bị `.gitignore` nuốt (tổng 8 file tracked) |
| `c8466ba` `6b3d7d1` `9bd0991` | SDD + ADR, 1038 dòng, 29 constraint, 11 ADR, 31 AC |
| `87b7863` | `research-map.ts` + `assertion-boundary.ts` |
| `bae1947` | `story-planning.ts` |
| `6c958d3` | Vá 3 lỗ fail-open |
| `45d99a2` | `writer-hard-gate.ts` + ràng prose vào evidence đã chọn |
| `b42f1b7` | Gom 4 đường `advanceAfterDraft` về một điểm |
| `acfe8b8` | Tách `study-orchestrator.ts` |
| `81aa99c` | Ba prompt D/R/C + provenance do code sở hữu |

### Module

| File | Dòng | Vai trò |
|---|---|---|
| `story-planning.ts` | 1653 | DIVERGE/CONFRONT schema, prompt, validator, typed beat |
| `assertion-boundary.ts` | 858 | 5 loại assertion, anchor, persona registry |
| `research-map.ts` | 922 | ResearchMap schema, exact quote, permission, ledger |
| `study-orchestrator.ts` | 383 | STUDY contract, input allowlist, envelope, dispatch |
| `writer-hard-gate.ts` | 231 | Hợp nhất 2 validator, typed editor defect, routing |

Số dòng trong bảng trên đo **trên `81aa99c`**, không phải trên working tree — working
tree đang mang thêm lane persona (`assertion-boundary.ts` 858 → 940, `writer-run-v2.ts`
2615 → 3060). `writer-run-v2.ts` giảm **2888 → 2615** dòng qua hai refactor thuần, rồi
phình lại khi ba lane land.

**193 test pass / 0 fail / 948 assertions** khi chạy
`bun test packages/daemon/test/writer/` trong detached worktree chỉ chứa commit
`81aa99c` — xem khối số liệu dùng chung ở đầu doc để đối chiếu với con số đo trên working
tree. 22/31 acceptance criteria hiện nằm ở tầng contract/validator; con số này
không chứng minh orchestration mới đã chạy.

### Bốn lỗ fail-open đã bịt

Không lỗ nào do test tìm ra. Tất cả đến từ rà chéo giữa các module.

1. **Agent tự chọn nhãn sức mạnh.** Cùng bộ evidence thoả cả `DISPUTED` lẫn
   `MULTI_SOURCE_ATTESTED` → agent chọn nhãn mạnh hơn. Nay positive + `CONTRADICTS`
   **buộc** `DISPUTED`.
2. **Ledger inflate bằng một quote.** Dedupe key chứa `claim.id` nên một quote gắn vào ba
   claim ID sinh ba entry giống hệt, qua ngưỡng "≥3 grounded". Nay dedupe theo
   `(videoId, quote)`.
3. **Persona duplicate ID không fail closed.** `PERSONA_DUPLICATE_ID` được ghi nhưng không
   ai đọc; entry đầu vẫn APPROVED. Nay colliding ID thành `REJECTED`.
4. **Số viết bằng chữ lọt whole-script scan.** `"một tỷ"` thoát khi bỏ anchor hoặc khai
   giả STANCE. Nay scan độc lập.

### Quyết định đã chốt

| Quyết định | Lý do |
|---|---|
| 3 sub-call, không phải MVP 2 call | Chỉ hypothesis sinh trước khi thấy nguồn mới thật sự tránh confirmation bias |
| Beat có loại `FACTUAL/NARRATIVE/PERSONA` | Beat chuyển cảnh không phải bịa claim. **Khai báo không cấp quyền** — gate quét toàn script bất kể kind |
| FACT được paraphrase `claim.text` | Văn tự nhiên hơn. Nhưng specific phải khớp exact quote: `800 triệu → một tỷ` FAIL |
| Stance hoãn tới khi có ADR-004 | `"theo tôi"` mở đường cho fact tệ hơn việc chưa có stance |
| `maxContentRetries: 0` cho D/R/C/WRITE | Scheduler retry 2 lần/dispatch mà coordinator không thấy. **Đã implement** cho STUDY + WRITE (2026-09-03); D/R/C chưa tồn tại; EDIT_REVIEW/REPAIR còn mở — §4 |
| Quỹ retry tách riêng 6 + 2 | 3 sub-call × 1 retry = hết budget, WRITE không chạy |
| Provenance do code sở hữu | Code đã biết đáp án thì đừng bắt model khai rồi so |
| Sandbox thư mục theo stage | Thư mục **đã** tách theo stage; cái thiếu là ràng buộc đường dẫn cho tool — §4 |
| Force-add source artifact | `writer-room-data/` bị ignore nhưng chứa file vào turn key (7 file, 3 commit) |

---

## 4. Chưa implement

### Mảng B — Editor Claim Boundary

`buildEditReviewPrompt` hiện **0** mention Claim Boundary. Nửa deterministic của ADR-005
xong; nửa independent reviewer chưa có gì. Thiếu: section Claim Boundary trong prompt,
compact admissibility index, output `kind` + `code` thay vì `{quote, severity, note}`.

AC 13 phụ thuộc hoàn toàn vào đây — `"Tôi tin bất động sản luôn an toàn hơn cổ phiếu"`,
mệnh đề thực nghiệm không số không tên riêng, deterministic floor **không thể** bắt.

### Mảng C — Orchestration, 9/31 AC

| AC | Việc |
|---|---|
| 1–3 | Ba stage D/R/C, blindness lúc dispatch, `freshContext` |
| 7 | `HOOK_REVIEW_REQUIRED` khi CONFRONT giết hook |
| 8–9 | Checkpoint/resume, không rerun RESEARCH, tamper fail closed |
| 10 | Trần 6 call, không có call thứ 7 |
| 20–21 | Run cũ đọc được. Initial WRITE `freshContext` — **đã vá 2026-09-03**, WRITE giờ luôn `freshContext: true` |

Cộng: sandbox theo stage, RESEARCH side-cache, header doc + ASCII diagram, **30 test
orchestration** (hiện 2/32 = 6%).

### Critical gap

**Blindness chưa có sandbox — còn mở.** Mô tả cũ ("artifact mọi stage nằm chung
`workspaces/pipeline/{batchId}/{itemId}/`") **sai**: `lane-scheduler.ts:344` đã dựng
`.../{batchId}/{itemId}/attempts/{attempt}/{stage}/`, tức đã tách theo stage, và
`overrideCwd` trỏ đúng vào đó. Lỗ thật nằm chỗ khác và vẫn nguyên:

- `allowedTools: ['Read', 'Write', 'Glob', 'mcp__team']` — **không có ràng buộc đường
  dẫn**. Agent Read đường dẫn tuyệt đối, hoặc Glob `../<stage khác>/`, là thấy artifact
  stage anh em.
- `sandboxRoot = join(itemRunDir, '..')` là thư mục *attempt*, tức chính là thư mục chứa
  mọi stage anh em.
- Không tồn tại cơ chế để vá: không `disallowedTools`, không deny-rule, không path jail ở
  `agents/index.ts` hay `team/workflow.ts`. **Đây là xây mới, không phải vá** — phải thêm
  ràng buộc đường dẫn xuyên `agents` → `workflow` → `lane-scheduler`.

CON-3 và CON-4 vì thế vẫn là tài liệu chứ không phải ràng buộc. **Test kiểm envelope sẽ
pass trong khi tính chất chúng kiểm bị vi phạm.**

**Retry ẩn của scheduler — đã vá một nửa (2026-09-03).** `lane-scheduler.ts:169`
`DEFAULT_MAX_CONTENT_RETRIES = 2`; coordinator đếm *dispatch*, scheduler chạy *model* tới
3 lần cho mỗi dispatch.

| Stage | `maxContentRetries` | Model call xấu nhất / dispatch |
|---|---|---|
| STUDY (`study-orchestrator.ts:373`) | **0** ✅ | 1 |
| WRITE (`writer-run-v2.ts:1511`) | **0** ✅ | 1 |
| EDIT_REVIEW | mặc định 2 ❌ | 3 |
| REPAIR | mặc định 2 ❌ | 3 |

Pipeline hiện chạy 4 dispatch (D/R/C chưa tồn tại): xấu nhất **12 → 8** model call trong
khi counter đọc 4. Retry không bị bỏ, nó lên tầng coordinator (STUDY attempt 2, WRITE
continuation) — chỗ có đếm. Đóng nốt EDIT_REVIEW/REPAIR đổi hành vi: content-validation
fail thành `FAILED` thật thay vì tự lành, nên để lại cho lúc làm coordinator integration.
Test pin lại: `writer-run-v2.test.ts` — *"STUDY and WRITE spend exactly one model call per
dispatch, each in a fresh context"*.

---

## 5. Đang chặn

Nút thắt cũ (lane persona giữ file uncommitted) đã gỡ: ba lane land tại `17d6bad`.
Còn lại đúng một việc chặn, và nó cần chủ kênh chứ không cần code.

1. Duyệt entry trong `writer-room-data/writer/persona-pack.md` — hiện **0/16 approved**
   (8 stance + 8 experience; xác minh bằng `parsePersonaRegistry`, không phải bằng grep).
   Sau khi mặc định đổi thành PENDING cho cả stance lẫn experience, bản lọc đang **rỗng**,
   nên persona bị skip toàn phần và run test không có gì để đo.
   ⚠️ Bẫy khi duyệt: chỉ 8 stance mang marker `[CHỜ CHỦ KÊNH DUYỆT]` nhìn thấy được; 8
   experience (A1–A8) **không mang marker nào** nhưng vẫn PENDING theo mặc định T2. Đọc
   file bằng mắt sẽ tưởng chỉ có 8 thứ cần duyệt.
2. Restart daemon sau khi mọi run settle.
3. Chạy **một** run thật qua hook board với persona bật → mở khoá mảng B và C.
   Đây sẽ là lần đầu tiên hook board chạy: 0/20 run trước đó có `selectedHook`.

---

## 6. Trạng thái thật

**`CONDITIONAL PASS`** — contract và fixture đủ để wiring, **chưa chạy thật lần nào**.

193 test trên commit sạch chứng minh các contract/validator hiện có đúng *riêng lẻ*.
Chúng không chứng minh các module đã được nối với nhau đúng. Mọi tính chất làm kiến trúc
này đáng giá — blindness, trần call, resume không rerun RESEARCH, không có đường DONE bỏ
qua Assertion Boundary — đều nằm trong 94% orchestration chưa test.

Ngoại lệ nhỏ, tính từ 2026-09-03: **trần call** và **context isolation của WRITE** giờ có
một test end-to-end thật đứng sau (§4), chạy qua `LaneScheduler` production. Đó là hai
tính chất, không phải cả mảng.

Chỉ sau một clean run và một adversarial run thật mới được nâng lên `runtime PASS`.
