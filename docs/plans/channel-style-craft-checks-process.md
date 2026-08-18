# Process — Channel Style + Craft Checks

> Ngày: 2026-08-18
> Trạng thái: **ĐÃ TRIỂN KHAI XONG**, typecheck xanh, không gây thêm test failure nào.
> Thay thế: `docs/plans/craft-checks-plan.md` (bản DRAFT đó **không được triển khai** — lý do ở §5).
> Căn cứ: phân tích hai run thật `9bf99a61` và `d638638b` (cùng brief, cùng pack `Bay-tra-gop`, cùng formula v34, cùng writer `claude` + editor `codex`).

---

## 0. Tóm tắt một dòng

Style của kênh **không** được đưa vào pipeline. Nó sống thành một skill chạy sau khi run `DONE`, cộng một CLI báo cáo không chặn. Trong pipeline chỉ có đúng hai thay đổi, và cả hai đều **giảm** áp lực lên người viết chứ không tăng.

---

## 1. Vấn đề đã xác định

### 1.1 Ô trống kiến trúc

| Tầng | Trả lời câu | Ai sở hữu |
|---|---|---|
| Topic pack | Bài này có dữ kiện gì | máy (spy) |
| Formula | Thể loại này chạy nhịp gì | máy (training lab) |
| General pack | **Kênh tôi học** làm gì | người soạn, mô tả kênh nguồn |
| *(trống)* | **Kênh tôi** làm gì | — |

Bằng chứng ô trống có thật: cùng brief, cùng pack, cùng formula, hai run vẫn khác nhau ở xưng hô (`bạn` vs `anh chị`), số chặng (7 vs 6), lớp mở bài (4 vs 1), ẩn dụ (có vs không), dẫn nguồn khảo sát (bỏ mẫu vs giữ mẫu). Không ai sai — **không ai quyết**.

### 1.2 Gate đang ép văn phong, không chỉ bắt bịa

Run `d638638b` bị chặn ở `900 nghìn` và `một trăm nghìn`. **Cả hai đều có trong ledger**, chỉ khác cách viết. Writer tự ghi trong `outlineChanges`:

> *"cả hai con số bị gắt đều có trong ledger nhưng tôi viết sai dạng, nên máy không khớp được"*

Nó buộc phải chép đúng ký tự của pack vào một script voiceover: `"khoảng từ 300 đến 900.000đ"`, `"mỗi món chỉ 100k một tháng"`.

Nguyên nhân: `claimKey()` = `` `${value}|${unit}` `` — so **chuỗi**, không so **giá trị**. Hệ quả kép: vừa quá chặt (ví dụ trên) vừa quá lỏng ngẫu nhiên (`Long`, `35 triệu`, `15 triệu` lọt gate chỉ vì pack tình cờ có "Giám đốc Nguyễn Hoàng **Long**", "niềng răng **35 triệu**", "bảo hiểm xe … **15 triệu** đồng một năm").

### 1.3 Không tầng nào bắt lỗi craft và lỗi số học của nguồn

Editor bắt đúng 9/9 defect ở hai run, nhưng cả hai run đều để lọt con số `20 triệu/tháng × 8%/năm × 7 năm = 1,7–2 tỷ`. Riêng tiền góp đã 1,68 tỷ; giá trị tương lai thật ≈ **2,24 tỷ**. Con số sai **nằm trong video nguồn**, nên gate cho qua (nó chỉ kiểm *có nguồn*, không kiểm *đúng*). Bài `9bf99a61` bị editor bắt nhưng vòng repair không tính lại, chỉ chèn hedge *"theo ước tính này… không phải một con số chắc chắn"* — đúng hành vi "perform compliance" mà header `writer-run-v2.ts` cảnh báo.

---

## 2. Quyết định kiến trúc

### Q1 — Style vào Formula?  **KHÔNG**

- `contracts.ts` ghi rõ Formula *"Scoped to a `genre`, never to a channel"*. Motif nhân vật là quyết định của **series**, không phải của thể loại.
- Formula sinh từ training lab + Studio merge, có `lineage`. Viết tay rule vào đó làm bẩn lineage; lần discovery sau sẽ ghi đè hoặc mâu thuẫn.
- Rule chỉ là `{id, statement, role?}` — một câu văn. Gate là **code**, nó không đọc `statement`. Dù viết rule hay tới đâu, gate vẫn chặn.

### Q2 — Gộp vào General pack?  **KHÔNG**

| # | Lý do | Hậu quả nếu gộp |
|---|---|---|
| 1 | Quan hệ N–M: một style dùng với nhiều general pack và ngược lại | ép 1–1, nhân bản style mỗi lần thêm kênh học |
| 2 | Vòng đời ngược: general pack còn 25 entry → sẽ phình lên 40–50k từ; style phải ~1k từ và sửa liên tục | style bị chôn, agent đọc lướt |
| 3 | Đã có `GENERAL_PACK_CHANGED` — sửa file giữa chừng là fail run | chỉnh một dòng style → hỏng mọi run đang chạy |
| 4 | **General pack MÔ TẢ kênh nguồn (read-only); style RA LỆNH cho kênh mình** | sửa `hieu-tv.md` để cho phép nhân vật hư cấu = ghi sai sự thật về Hieu TV |

### Q3 — Thành một stage mới trong pipeline?  **KHÔNG**

Trong hệ này **"là một stage" đồng nghĩa với "có validator làm fail được run"** — mọi `dispatchItem` đều mang `validateContent`, settle không `COMMITTED` là `failRun`. Thêm restyle thành stage = thêm hard check. Ngoài ra `DONE` hiện được set ở **đúng một chỗ**, chỉ khi gate xanh (cách sửa lỗi run `86de3ca5`); thêm stage sau đó sẽ khiến một bài **sạch về dữ kiện** bị chặn vì lý do văn phong.

### Q4 — Thêm hard gate cho craft (triad / burstiness / forbidden phrase)?  **KHÔNG**

Nguyên tắc đã chốt: **một field chỉ được hard-code nếu trả lời "có" cho câu *"Tôi có sẵn sàng để run rơi vào `FAILED_GATE` vì nó không?"***. Ba điều kiện: nhị phân đúng/sai · qua nó không định hình câu chữ · kiểm ĐẦU RA chứ không kiểm CÁCH VIẾT.

Phân biệt then chốt: **khớp CHUỖI định hình prose, khớp GIÁ TRỊ thì không.** `NUMBER_UNSOURCED` so chuỗi → sinh ra `100k`. Kiểm nhất quán số học so giá trị → viết kiểu gì cũng qua.

### Kết luận

```
PIPELINE (sản xuất bản CÓ NGUỒN — nhịp thay đổi: tháng)
   STUDY → WRITE → GATE → EDIT_REVIEW → REPAIR → GATE → DONE → finalScript
                                                                   │
NGOÀI PIPELINE (làm cho nó GIỐNG GIỌNG KÊNH — nhịp thay đổi: ngày) │
   skill channel-style ──► styled-vN.md ──► bun writer:regate ──► NGƯỜI đọc & quyết
```

Vòng lặp sửa nằm ở **style**, không ở **bài**. Agent không bị chấm điểm nên không có gì để diễn. Cùng một check, đặt sau khi viết thay vì trước, thì không sinh lối mòn — vì không có đường phản hồi chạy ngược vào lúc viết.

---

## 3. Đã làm gì

Bốn việc, chạy song song bởi bốn teammate, không ai chồng file với ai.

### 3.1 `deterministic-gate.ts` — quy đơn vị tiền về VND

`packages/daemon/src/writer/deterministic-gate.ts` (+63 dòng), test `+75` dòng.

- Thêm hậu tố ngắn `k` / `tr` / `đ` vào `UNIT_PATTERN`, đặt **cuối** alternation (JS first-match-wins: `tr` đứng trước `triệu` sẽ cắt "13 triệu" thành "13 tr" và mất hệ số), mỗi cái kèm negative lookahead `(?![\p{L}\p{M}])` để không bắn vào `km` / `trong` / `được`; `\p{M}` để chặn cả input NFD.
- `normalizeUnit`: `k→nghìn`, `tr→triệu`, `đ→đồng`.
- `claimKey` quy mọi đơn vị tiền VND về `đồng` qua `VND_SCALE`.
- **`usd` / `đô` CỐ Ý không quy đổi** — tỷ giá thay đổi, folding sẽ bịa ra khớp.
- Phép nhân hệ số nằm **sau** `parseDigits`, giữ nguyên bất biến đã có: `2,5 triệu` (2_500_000) vẫn khác `25 triệu` (25_000_000).

**Không thêm `GateViolationCode` nào. Không đổi signature.**

### 3.2 CLI `writer:regate` — báo cáo, không chặn

`packages/daemon/src/regate-cli.ts` (mới) + script trong `package.json`.

```
bun writer:regate <runId> <path-to-styled.md>
```

Sáu mục:

| Mục | Nội dung |
|---|---|
| 1 | Gate gốc — **cố ý bỏ** `outline` + `beatAnchors` (bản restyle viết lại câu nên anchor không còn khớp; chạy chúng chỉ báo "đã viết lại", không nói gì về sự thật) |
| 2 | Tách `NUMBER_UNSOURCED` thành **SUY RA ĐƯỢC** / **BỊA THẲNG** |
| 3 | Lệch style bề mặt — đếm xưng hô, số viết tắt còn sót |
| 4 | Lặp cụm / ẩn dụ — **lọc bỏ mọi cụm đã có trong topic pack** |
| 5 | Phân phối độ dài câu — **lọc heading trước** |
| 6 | `PERSONA_QUOTE_LEAK` heuristic |

Mục 2 là phần giá trị nhất. Bốn phép thử theo thứ tự: (a) có trong pack · (b) tổ hợp 2 số · (c) tổ hợp 3 số · (d) phần trăm của một số khác với `rate` lấy từ `factsLedger`. Đơn vị tiền quy về VND trước khi so.

Cải tiến ngoài brief, giữ lại: **suy diễn chỉ tính các số nằm CÙNG ĐOẠN VĂN.** Người đọc chỉ cộng trừ được những số đang trước mắt; nới ra cả bài thì hai số bất kỳ luôn ghép ra được số thứ ba. Các tổ hợp rải rác được in riêng dưới nhãn "không tính" thay vì bị giấu.

Mục 4 áp cùng bộ lọc pack cho cả cụm 2–4 từ lẫn từ đơn, ngưỡng ≥ 3 lần: cụm nào có trong pack là từ vựng của chủ đề, không phải nhãn/ẩn dụ tự đặt. Lọc này kéo danh sách từ 375 xuống 30.

**Luôn `exit 0`.**

### 3.3 Skill `channel-style`

`.claude/skills/channel-style/SKILL.md` (1.344 từ) + `styles/nhan-vat-xuyen-suot.md` (1.483 từ).

Quy trình 5 bước: đọc `finalScript` + **`study.factsLedger`** + file style → áp style → ghi ra **file MỚI** `writer-room-data/exports/writer/<runId>/styled-vN.md` (không ghi đè `finalScript`) → nhắc chạy `writer:regate` → nếu chưa đúng thì **sửa file style rồi chạy lại**, đừng vá tay từng bài.

Đọc ledger là **bắt buộc** — đó là thứ phân biệt skill này với "nhờ AI viết lại cho hay hơn".

Ba luật cứng về nhân vật hư cấu:

1. **Số của nhân vật phải cộng đúng và suy được từ tỉ lệ trong ledger.**
2. **Giữ nguyên bội số của nguồn khi nội địa hoá.** Lỗi thật: nguồn ghi `600 đô → 4000 đô` (6,67×), bản viết lại đổi thành `15 → 70 triệu` (4,67×). Đúng phải là `15 → 100 triệu`.
3. **Nhân vật hư cấu KHÔNG BAO GIỜ phát ngôn một câu trích dẫn từ ledger.** Lỗi thật: `"Đức tự viết ra đúng suy nghĩ này: 'Tôi chưa bao giờ trễ việc thanh toán…'"` — câu trong ngoặc kép là lời của một người thật trong video nguồn.

Style file **không có phần `grants` / `constraints` máy đọc** — đúng quyết định Q4. Chỉ prose. Mỗi mục neo vào câu trích nguyên văn từ hai bài thật, và **đối chiếu bài nào đúng / bài nào sai** thay vì chỉ ra lệnh.

### 3.4 Editor checklist +6 câu

`packages/daemon/src/writer/writer-run-v2.ts` (+24 dòng). `EDIT_REVIEW_PROMPT_VERSION` → `writer-v2-edit-review-v2`.

| # | Câu hỏi |
|---|---|
| **7** | **Tính lại mọi phép cộng/trừ/nhân/chia/phần trăm — kể cả số trông đã có nguồn** |
| 8 | Ba câu liền cùng khuôn mở đầu tới mức nghe như máy? (liệt kê ba bước là hợp lệ — chỉ báo khi *formulaic*) |
| 9 | Ẩn dụ chủ đạo có dùng để **suy luận tiếp** hay chỉ để nghe hay? |
| 10 | Phe đối lập có dựng ở dạng **mạnh nhất** trước khi bị trả lời? |
| 11 | Bộ phép thử cuối bài có **cùng một chiều** đạt/không đạt? |
| 12 | Câu cuối có đóng lại **hình ảnh cụ thể** của phần mở? |

Envelope `dispatchEditReview()` **không đổi** — sáu câu là câu hỏi trong prompt, không phải dữ liệu mới. Giữ nguyên comment thiết kế *"An editor that can see the writer's reasoning starts grading the reasoning."* Thêm một dòng chống biến checklist thành hạn ngạch: *"The checklist is where to look, not a defect quota."*

---

## 4. Xác minh

Tất cả số dưới đây do team-lead tự chạy lại, không lấy từ báo cáo của teammate.

### 4.1 `claimKey` — đạt acceptance

| Bản | Trước | Sau |
|---|---|---|
| `d638638b` write attempt 1 *(bản từng bị chặn)* | 2 × `NUMBER_UNSOURCED` | **0 — passed** |
| `9bf99a61` write attempt 2 | 1 × `tháng 14,` | **1 — vẫn chặn** (đúng: số tự cộng, không có trong ledger) |
| Cả hai `finalScript` đã DONE | xanh | **vẫn xanh** |

### 4.2 CLI — Mục 2 khớp 100% kỳ vọng trên `duc.txt`

- **SUY RA ĐƯỢC (7):** `13 triệu` (=1,3+11,7) · `1,3 triệu` · `11,7 triệu` (=13−1,3) · `390.000đ` (=3%×13tr, rate từ ledger) · `6,5 triệu` (=14,5−8) · `43%` (=6,5/15) · `14,5 triệu` (=6,5+8)
- **BỊA THẲNG (4):** `29 tuổi` · `1,1 triệu` · `2,8 triệu` · **`70 triệu`**

`70 triệu` là con số quan trọng nhất — nó chính là chỗ vỡ bội số của nguồn, và bộ phân loại tìm ra nó **độc lập**, trùng với kết quả soi tay trước đó.

- Mục 3: `"bạn" ×33 · "anh chị" ×0` · 0 số viết tắt còn sót
- Mục 4: sau khi lọc theo pack còn **30 cụm** (bản đầu chưa lọc là 375, top list toàn từ vựng chủ đề: `trả góp ×21`, `hợp đồng ×11` — vô dụng). Giờ in ra đúng thứ người viết tự đặt: `chiếc laptop ×7`, `xách đồ ra cửa ×3` (nhịp gọi lại motif Long), `không trả một đồng lãi ×3`. Phần từ đơn bắt được `guồng ×3`
- Mục 5: lọc 8 dòng heading · 130 câu · min 1 / trung vị 18 / max 79 từ
- Mục 6: cảnh báo đúng câu `"Đức tự viết ra…"`
- `EXIT=0`

### 4.3 Skill — 28/29 câu trích là nguyên văn

Kiểm bằng so chuỗi thật với `duc.txt` / `B-repair.txt` / `hieu-tv.md`. Câu còn lại chỉ khác dấu nháy trong-ngoài, nội dung nguyên văn. Không lọt `grants`/`constraints`.

### 4.4 Test & typecheck

- `bun run typecheck`: **xanh**
- Chạy từng file riêng lẻ, **không thay đổi nào gây thêm failure**:
  - `writer-run-v2.test.ts`: 13 pass / 1 fail — **y hệt HEAD** (đã stash 3 file để đối chứng)
  - `parse-agent-json.test.ts`: 11 pass / 1 fail — pre-existing, thuộc `parseAgentResultJson`, không liên quan
  - `preflight.test.ts`: **5 pass / 0 fail** khi chạy riêng
- Full suite: 373–374 pass / 3–4 fail, số dao động giữa các lần chạy → có nhiễu do chạy song song (`preflightVideo` mất 5.050ms = chạm timeout khi tải nặng).

**Hai failure pre-existing khi chạy riêng:**
1. `Writer v2 — end to end > STUDY → WRITE → GATE → EDIT_REVIEW → DONE when everything is clean` — `projectRoot không tồn tại` từ `packages/daemon/src/agents/config.ts:39`, đến từ commit `52bfb4a`.
2. `parseAgentResultJson > repairs real on-disk Claude orphan draft when present`.

Cả hai **không nằm trong phạm vi thay đổi này**.

---

## 5. Vì sao KHÔNG triển khai `craft-checks-plan.md`

Bản DRAFT đó chẩn đoán đúng bệnh (không tầng nào bắt AI-tell) nhưng cả ba cơ chế đều không chạy được. Đã verify bằng code thật:

| # | Lỗi | Bằng chứng |
|---|---|---|
| 1 | **Dựa vào một tầng WARNING không tồn tại** (nhắc 6 lần) | `deterministic-gate.ts:543` — `passed: violations.length === 0`. Push vào `violations` = gate đỏ → REPAIR → còn đỏ = `FAILED_GATE`. Craft sẽ **ăn hết vòng repair duy nhất**, tranh với lỗi factual |
| 2 | **Nhắm vào nhánh Profile đã bị v2 loại bỏ** | `writer-run-v2.ts` có **0** lần xuất hiện từ `profile`; run `9bf99a61` không có `profileId`, nó dùng `formulaId … v34`; `writer-profile.ts` không tồn tại |
| 3 | **AC-1 fail** | chạy `countTriads()` nguyên văn theo plan → **1**, không phải ≥2. Chính triad được plan dẫn làm bằng chứng lại không bị bắt: first-token là `Hợp → Anh → Anh`, chuỗi chỉ dài 2 |
| 4 | **AC-2 fail** | có **7** câu ≤5 từ (min = 1 từ), không phải 0 |
| 5 | **`forbiddenPhrases` xoá đúng thứ tốt nhất** | `bánh xe hamster` **có trong topic pack** và là `factsLedger[24]`; nó cũng là ẩn dụ vận hành được duy nhất của bài. `đường đua` xuất hiện **0** lần — list chưa từng được kiểm |
| 6 | **Spec tự mâu thuẫn 3 chiều** | doc `countTriads` nói bắt ordinal triad ↔ AC-6 nói không được bắt ↔ code không implement |
| 7 | Số liệu phụ lệch | bài 2.516 từ (plan ghi 2.300) · `guồng` 3 lần (plan ghi 4) |

Ba nhận định lõi được **giữ lại và chuyển vị trí**: ẩn dụ lặp → CLI Mục 4 · nhịp câu → CLI Mục 5 · cấu trúc song song → editor câu 8.

---

## 6. Cố ý KHÔNG làm

- Gate check mới, `GateViolationCode` mới
- `GateResult` hai mức (blocking / advisory)
- Profile schema, `forbiddenPhrases`
- `styleId` / `styleHash` pin vào `WriterRunV2`
- `personas` schema, `grants`, cấp phép nhân vật ở tầng code
- Stage `restyle` trong pipeline
- Sửa Formula, General pack, Topic pack, UI Writer

---

## 7. Khi nào xem lại

Gặp **một** trong ba mốc thì cân nhắc đưa style vào code:

1. **> ~15 bài/tháng** — chi phí đọc tay (~10 phút/bài) vượt chi phí code.
2. **Style ổn định 3 phiên bản liên tiếp** — hết dò, đáng pin hash.
3. **CLI báo cùng một loại vi phạm đều đặn** — dấu hiệu cần cưỡng chế bằng code, không bằng lời nhắc.

Trước ba mốc đó, đưa vào pipeline là **kỹ thuật đi trước nhu cầu**: bạn sẽ phải viết style trước khi biết style là gì.

Nếu sau này promote thành stage: bố cục hiện tại đã sẵn hình dạng — output đã nằm ở `exports/writer/<runId>/` tức một thư mục artifact theo run. Việc phải làm chỉ là bọc skill thành `dispatchItem`, thêm `phase: 'RESTYLE'`, và trả lời câu hỏi **style fail thì có được chặn `DONE` không** — khuyến nghị: **không**.

---

## 8. File đã đụng

| File | Thay đổi |
|---|---|
| `packages/daemon/src/writer/deterministic-gate.ts` | +63 — quy đơn vị tiền về VND |
| `packages/daemon/test/writer/deterministic-gate.test.ts` | +75 — cặp tương đương, chống sập nhập `2,5` vs `25`, usd không quy đổi |
| `packages/daemon/src/writer/writer-run-v2.ts` | +24 — 6 câu checklist, bump prompt version |
| `packages/daemon/src/regate-cli.ts` | mới — CLI báo cáo 6 mục |
| `package.json` | +1 — script `writer:regate` |
| `.claude/skills/channel-style/SKILL.md` | mới |
| `.claude/skills/channel-style/styles/nhan-vat-xuyen-suot.md` | mới — style v1 |
