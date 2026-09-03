# Writer v2 — Human Quality

> Cập nhật: 2026-09-03 · Code: **chưa commit** · Số liệu: xem khối dùng chung bên dưới
> Tài liệu ngữ cảnh cho chủ kênh và các terminal phối hợp. Không phải rule nạp vào agent prompt.

Doc chị em: [`writer-v2-status.md`](./writer-v2-status.md) — lane Blind Study + Claim
Boundary. Hai doc là **hai lane song song của cùng dự án Writer v2**, không phải hai bản
của cùng một tài liệu:

| | doc này | `writer-v2-status.md` |
|---|---|---|
| Lane | persona / chất người | Blind Study (3 sub-call) + Claim Boundary |
| Stage chạm tới | WRITE · GATE · REPAIR | STUDY (DIVERGE→RESEARCH→CONFRONT) · EDIT_REVIEW |
| Spec gốc | không gắn SDD | SDD 005 |
| Trạng thái | implement xong, chờ chủ kênh duyệt entry | `CONDITIONAL PASS`, chưa chạy thật |

---

## Số liệu dùng chung — 2026-09-03

> Khối này **giống hệt** trong `writer-human-quality.md` và `writer-v2-status.md`.
> Sửa một bên thì sửa cả hai, nếu không hai doc lại lệch như trước.

| | Giá trị | Phạm vi đo |
|---|---|---|
| Test vùng writer | **216 pass / 0 fail / 1105 assertions** | `bun test packages/daemon/test/writer/` trên **working tree** (gồm lane persona chưa commit) |
| Test toàn repo | **751 pass / 0 fail** | `bun test` trên working tree |
| Test vùng writer @`81aa99c` | 193 pass / 948 assertions | worktree tách rời **chỉ chứa commit sạch** — con số lịch sử, không so trực tiếp với 216 |
| Source artifact | **7 file** force-add trong 3 commit (`6bd1ae1` 5 · `96c73c9` 1 · `b51de0b` 1); **8 file** tracked tổng cộng dưới `writer-room-data/` | `git ls-files writer-room-data/` |
| Dòng module | Bảng module ở `writer-v2-status.md` §3 đo trên `81aa99c`; working tree lớn hơn (vd `writer-run-v2.ts` 2615 → 3047) | — |

**Vì sao hai con số test không mâu thuẫn:** 193 đo trên commit sạch, 216 đo trên working
tree đang mang thêm lane persona. Luôn ghi kèm phạm vi khi trích một con số test.

---

## PHẦN 1 — GOAL

### Đích đến

Bài viết ra khỏi pipeline phải **đúng sự thật** *và* **đọc lên như một người thật đang nghĩ**.

Vế đầu pipeline đã làm tốt: gate tất định, facts ledger, editor mù nguồn. Vế sau là thứ
đợt này xây.

### "Chất người" là gì — định nghĩa làm việc

Chốt sau khi phân tích corpus Hiếu TV: chất người **không** nằm ở độ cao siêu của kiến
thức, cũng không nằm ở câu chữ. Nó nằm ở **vị trí của người nói so với kiến thức**.

Ba biểu hiện:

1. **Kiến thức có chủ** — người kể có trường phái riêng, dám lệch chuẩn ngành và gọi
   thẳng đó là lựa chọn cá nhân chứ không phải chân lý.
2. **Tư duy đang diễn ra** — tự sửa mình giữa câu, thú nhận đổi kế hoạch, lộ đường may.
   Ngược với một văn bản đã hoàn thiện sẵn rồi đọc lên.
3. **Lateral thinking** — tái tổ hợp cái người nghe *đã biết*, không bơm thêm cái họ
   chưa biết. Bốn move: nối hai fact mâu thuẫn · mổ một chữ trong câu quen · stress-test
   công thức ở cực trị · đảo ngược câu hỏi.

Một câu chứa cả ba, từ kênh nguồn:

> *"thường thì những người chuyên gia về tài chính họ sẽ khuyên các bạn là phải có đủ cho
> khoảng từ 3 tới 6 tháng nhưng mà tôi thì tôi theo một cái trường phái nó chắc chắn hơn…"*

### Ba tầng — và tầng đang thiếu

| Tầng | Là gì | Trạng thái trước đợt này |
|---|---|---|
| Câu chữ | burstiness, nhịp câu, forbidden phrases | Đã có (`docs/writer/Sources`) |
| Giọng | 7 TASTE DNA trong general pack hieu-tv | Đã mine tốt |
| **Nhận thức** | **vị trí người nói so với kiến thức** | **Thiếu — goal của đợt này** |

### Vì sao pipeline cũ không tự sinh ra được

1. **Chỉ biết chặn, không biết sinh.** Gate và editor tối ưu cho *kiểm chứng* và *cấu
   trúc* — cả hai ngược chiều với chất người, thứ nằm đúng ở phần không kiểm chứng được:
   lập trường, do dự, chi tiết thừa đúng chỗ. Toàn hệ chỉ có một check âm duy nhất
   (editor #6 "prose dry — all rule, no life"), đứng cuối luồng.
2. **Writer không có "tôi" hợp pháp.** Gate cấm bịa tiểu sử (đúng), nhưng không nguồn nào
   cấp chất liệu cá nhân → writer kẹt giữa "vô hồn" và "bịa".

---

## PHẦN 2 — IMPLEMENT ĐÃ LÀM

### Tổng quan luồng sau thay đổi

```
persona-pack.md (file gốc, 16 entry)
        │
        ▼  filterApprovedPersonaMarkdown()   ◄── T1 + T2
   ┌────────────────────────────────────┐
   │ CHỈ entry [ĐÃ DUYỆT]               │
   │ + preamble/từ-vựng ĐÃ strip quote  │
   └────────────────────────────────────┘
        │  0 entry duyệt → null (+ WARN log)
        │
        ├──────────────► WRITE   : stage input/persona-pack.md
        │                          pin personaPackHash (theo BẢN LỌC)
        │                          promptVersion += "-persona-v1"
        │
        ├──────────────► GATE    : nguồn grounding thứ 3   ◄── 1A
        │                          (sau ledger, sau pack)
        │
        └──────────────► REPAIR  : "fix thứ tư — trace về persona"

STUDY ─► WRITE ─► GATE ─► EDIT ─► REPAIR
          ▲        ▲                ▲
          └────────┴────────────────┘
             persona đi vào 3 chỗ này
```

### Feature 1 — Persona pack: narrator có danh tính

**File:** `writer-room-data/writer/persona-pack.md` · `packages/daemon/src/writer/persona-pack.ts`

Chưng cất từ Hiếu TV (general pack + 30 transcript) thành danh tính cố định của người kể:
**8 ô quan điểm** (dự phòng, nợ/mua nhà, hưởng thụ, tự do vs ổn định, đầu tư, thu nhập thụ
động, giàu chậm, định nghĩa "đủ") · **8 trải nghiệm phóng tác** (đã tẩy chi tiết định danh
thật) · **từ vựng cá nhân**. Mọi mục neo quote nguyên văn transcript.

Đây là **ledger thứ hai**, đứng ngang factsLedger: chất liệu cá nhân phải trace về đây
hoặc bị bỏ.

| | Trước | Sau |
|---|---|---|
| Kể chuyện cá nhân | Phải bịa → gate chặn | Lấy từ persona pack, hợp pháp |
| Quan điểm giữa các tập | Trôi theo từng run | Cố định ở cấp kênh, nhất quán |

Nguyên tắc chốt: **quan điểm thuộc về kênh, không thuộc về run** — narrator phải là một
người nhất quán xuyên tập.

### Feature 2 — Cơ chế duyệt fail-closed (T1 + T2)

**File:** `assertion-boundary.ts` (`filterApprovedPersonaMarkdown`, export dùng chung)

Lỗ được Codex phát hiện: WRITE đang được stage **toàn bộ** file — gồm 16 entry chưa duyệt
— và prompt bảo đó là "lập trường chính thức của kênh". Fail-closed bị bypass ngay từ prompt.

Đã sửa:
- **T2:** cả stance *và* experience mặc định `PENDING`; chỉ `APPROVED` khi có marker
  `[ĐÃ DUYỆT]`. (Trước đó experience auto-approve.)
- **T1:** chỉ bản **đã lọc** mới được stage / hash / vào gate. 0 entry duyệt → coi như
  không có persona, kèm `console.warn` (trạng thái "file 20KB trên đĩa nhưng chạy như
  không có" nhìn từ ngoài rất giống hỏng).
- **Bịt lỗ phụ:** mục từ vựng có quote *"tôi lấy con số 50 triệu cho tròn"*. Sau feature 3,
  những con số đó thành nguồn grounding hợp lệ mà chưa ai duyệt. Nay strip mọi dòng `>`
  khỏi preamble/từ-vựng; quote **trong** entry đã duyệt thì giữ — *duyệt entry là duyệt cả
  bằng chứng của nó, văn xuôi quanh nó thì không*.

**Hệ quả tốt của việc hash theo bản lọc:** sửa entry `PENDING` không đổi turn key → chủ
kênh soạn nháp thoải mái, không vỡ cache. Duyệt một entry thì đổi hash → run mới. Cả hai
đều là cố ý.

### Feature 3 — Gate hiểu persona (1A)

**File:** `deterministic-gate.ts`

Vấn đề: luật gate "tiền không bao giờ là common knowledge" khiến narrator nói *"quan điểm
của tôi là tích lũy 15 tỷ"* bị bắn `NUMBER_UNSOURCED` → run fail oan. Phần đáng giá nhất
của persona (lập trường tài chính cụ thể) không dùng được.

Đã sửa: `runDeterministicGate` nhận thêm `personaMarkdown` (bản đã lọc) làm **nguồn
grounding thứ ba** cho `NUMBER_UNSOURCED` và `PROPER_NOUN_UNSOURCED` — cùng cơ chế
verbatim-substring như ledger. Không truyền → hành vi y hệt trước (có test regression pin lại).

`buildRepairPrompt` thêm lựa chọn fix thứ tư: "trace về persona pack", chỉ hiện khi run có persona.

### Feature 4 — Human-moves + bằng chứng A/B

**File:** `writer-room-data/channel-styles/human-moves.md` · `exports/human-moves-ab-*.md`

4 kỹ thuật kể mã hoá từ Hiếu TV, mỗi move kèm quote gốc và mục "khi nào KHÔNG dùng":
lập trường lệch chuẩn · đường may lộ · zoom vào một chữ · stress-test cực trị.

Chạy ngoài pipeline (restyle, không gate). 2 run DONE đã restyle sẵn đặt cạnh bản gốc —
fact giữ nguyên 100%, regate sạch — để chủ kênh so trực tiếp trước khi quyết đưa move nào
vào general pack.

### Feature 5 — Vá hạ tầng

- **Loader hết nuốt lỗi (2A):** `ENOENT`/file rỗng → `null`; lỗi đọc khác → fail run với
  `PERSONA_PACK_UNREADABLE`. Trước đó `catch { return null }` biến mọi lỗi thành "không có
  persona" — narrator mất tính cách mà không ai biết.
  *Bất đối xứng có chủ đích:* ở gate thì lỗi đọc = coi như vắng, vì WRITE đã chạy xong rồi
  và mất persona ở gate chỉ gây **false violation** (chặt hơn), không bao giờ false pass.
  Comment tại chỗ ghi rõ "do not fix the two sites to match".
- **7 source artifact vào git:** general pack, persona pack, 2 style file mới, hook
  library, 2 export A/B — force-add qua 3 commit (`6bd1ae1` `96c73c9` `b51de0b`). Trước đó
  `writer-room-data/` bị gitignore toàn bộ, trong khi contentHash của chúng đi thẳng vào
  turn key (mất/sửa = cache vỡ im lặng; mất hook library = chết cổng vào mọi run). Tổng
  cộng **8 file** hiện tracked — `nhan-vat-xuyen-suot.md` đã vào git từ trước đợt này.
- **Trần call hết bị retry ẩn qua mặt (STUDY + WRITE):** scheduler mặc định
  `maxContentRetries = 2`, còn coordinator chỉ đếm *dispatch* — một dispatch được đếm 1 có
  thể là 3 model call. Nay STUDY và WRITE dispatch với `maxContentRetries: 0`. Retry không
  bị bỏ, nó **lên một tầng**: coordinator giữ quỹ retry (STUDY attempt 2, WRITE
  continuation) ở chỗ có đếm. `EDIT_REVIEW` và `REPAIR` **vẫn** mặc định 2 — xem
  `writer-v2-status.md` §4.
- **WRITE đầu tiên hết kế thừa context của STUDY:** `freshContext` trước đó chỉ bật khi
  WRITE là continuation, nên lần WRITE đầu resume đúng pane CLI vừa đọc nguồn mà envelope
  cố tình giấu. Blindness là tính chất của *turn*, không chỉ của envelope. Nay WRITE luôn
  `freshContext: true`. (AC 20–21 của SDD 005.)
- **Kỷ luật scope:** commit `97e4c95` lỡ ship stance + lateral-gap ngoài phạm vi duyệt →
  revert `3d49d7e`, giữ persona wiring.

### Hoãn có chủ đích (không bỏ)

| Thành phần | Vì sao hoãn | Điều kiện mở |
|---|---|---|
| **Stance permission** (WRITE được phát biểu quan điểm không cần ledger) | "Theo tôi" có thể thành đường lách cho fact bịa | ADR 4 + Claim Boundary reviewer + chủ kênh duyệt entry |
| **Lateral gap** (STUDY bắt `gap` là phép nối, 4 provocation) | Thuộc về stage DIVERGE của STUDY 3 sub-call, ship vào STUDY cũ là làm hai lần | Coordinator integration (SDD 005) |

`_wip/stance-lateral-gap.patch` **chỉ để tham khảo** — nội dung "stance không cần ledger"
mâu thuẫn thiết kế Claim Boundary; bản thật phải viết lại trên assertion-boundary.

Quan hệ thiết kế: **stance là quyền phát biểu, persona là kho phát biểu chính thức.** Khi
cả hai mở, writer nói quan điểm *lấy từ persona pack* — vừa tự do, vừa kiểm soát được.

---

## PHẦN 3 — TRẠNG THÁI & VIỆC CÒN LẠI

**Code:** 8 file vùng writer, ~840 dòng, typecheck sạch, **chưa commit**. Số test: xem
khối dùng chung ở đầu doc (216 vùng writer / 751 toàn repo, đo trên working tree).
Lưu ý: `writer-run-v2.ts` đang có cả thay đổi của terminal topic-flow — sync trước khi commit.

| # | Việc | Ai | Chặn gì |
|---|---|---|---|
| 1 | Xác nhận commit | Chủ kênh | Mọi bước sau |
| 2 | Duyệt entry: `[CHỜ CHỦ KÊNH DUYỆT]` → `[ĐÃ DUYỆT]` — **0/16 approved** (8 stance + 8 experience) | Chủ kênh | Chưa duyệt = persona tắt hoàn toàn |
| 3 | Restart daemon (chờ run settle) + run test persona | Terminal writer | Đèn xanh cho topic-flow |
| 4 | Đọc so 2 cặp A/B trong `exports/` | Chủ kênh | Move nào vào general pack |
| 5 | Coordinator integration + sandbox theo stage | Terminal topic-flow | Mở stance & lateral gap |
| 5b | `maxContentRetries:0` cho `EDIT_REVIEW` + `REPAIR` (STUDY/WRITE đã xong) | Terminal topic-flow | Đóng nốt trần call |
| 6 | Nuôi general pack 5/30 → 30 entry | Liên tục | Độ dày craft |

⚠️ **Bẫy khi duyệt:** chỉ 8 stance mang marker `[CHỜ CHỦ KÊNH DUYỆT]` nhìn thấy được; 8
experience (A1–A8) **không mang marker nào** nhưng vẫn PENDING theo mặc định T2. Đọc file
bằng mắt sẽ tưởng chỉ có 8 thứ cần duyệt. Đếm bằng `parsePersonaRegistry`, đừng đếm bằng
grep marker.

Run test ở bước 3 kiểm: file được stage, hash được pin, prompt có suffix `-persona-v1`,
experience/từ-vựng có được dùng. **Không** kiểm stance — fail-closed đúng thiết kế.

## Guardrail giữ vĩnh viễn

Move là **menu tùy chọn** — tối đa 2-3 mỗi bài, chọn theo chất liệu, **được phép bằng 0**
khi bài không có chỗ. Đánh giá theo outcome (editor đọc như người xem), **không đếm số
move** — một quota "phải có N move" tự nó là formula. Sự không đều giữa các bài chính là
human. Dạy bằng ví dụ trong pack, không dạy bằng rule trong prompt.

## TODO đã ghi sổ (`TODOS.md`)

- **Blind eval human-moves** (n ≥ 10 cặp) trước khi đưa move vào general pack — 2 mẫu A/B
  hiện tại là cảm quan, không phải evidence.
- **Persona theo kênh** — hiện 1 file toàn cục, là giả định đơn kênh có chủ đích.
