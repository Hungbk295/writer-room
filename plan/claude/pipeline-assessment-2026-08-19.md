> **Agent:** claude
> **Ngày:** 2026-08-19
> **Phạm vi:** Đánh giá toàn pipeline Formula → Training → Writer v2 (đọc code + dữ liệu thật + chạy test)
> **Đi kèm:** [`training-source-expansion-plan.md`](./training-source-expansion-plan.md) — plan tìm nguồn training tiếp theo

# Đánh giá pipeline — điểm mạnh, điểm yếu

## 0. Bức tranh hiện tại (đã xác minh trên dữ liệu thật)

```
Spy (thu thập + transcript)
  └─ 27 run · 20 kênh · 392 snapshot · 66 transcript · 38.827 segment
Training (ANALYZE → Lab REFINE → Studio COMPOUND)
  └─ 13 formula (chỉ từ 3 video / 2 kênh) · 2 profile TRIAL · compound chủ lực v34
Writer v2 (STUDY → WRITE → GATE → EDIT_REVIEW → REPAIR → DONE)
  └─ 9 run: 4 DONE / 4 FAILED / 1 kẹt RUNNING · 2 topic · 100% dùng pack hieu-tv.md
Channel style (ngoài pipeline, restyle sau DONE)
  └─ 2 style file · restyle qua daemon chưa từng thành công (skill path thì có)
```

Kiểm tra sức khỏe hôm nay: `bun run typecheck` xanh; `bun test` **88/89 pass** — 1 fail ở
e2e happy-path (`writer-run-v2.test.ts`: fixture không ghi `general-pack.md`/`prompt.md`
vào workspace tạm).

---

## 1. Điểm mạnh — thứ đáng giữ nguyên

1. **Grounding được cưỡng chế bằng máy, không phải bằng lời.** Mọi rule/quote phải là
   exact substring của transcript đã pin (`training-core/src/validator.ts:40`, cố ý
   không fuzzy `:57`); ledger thật có 2 lần `AGENT_UNGROUNDED` bị chặn. Critique trong
   Lab grounded **hai chiều** (transcript + draft) nên agent không tự khai khống
   `appliedRules`.

2. **Gate deterministic — DONE không thể đạt khi gate đỏ, theo control flow.**
   `deterministic-gate.ts` (606 dòng, không model, không IO). `DONE` chỉ được gán ở đúng
   2 chỗ, cả hai đều sau `gate.passed` (`writer-run-v2.ts:1434,1480`). Đây là fix trực
   tiếp cho run `86de3ca5` của v1 và nó hoạt động: run `9bf99a61` bị bắt
   `NUMBER_UNSOURCED` thật.

3. **Editor mù pack** (`freshContext: true`, chỉ thấy title/outline/script,
   `writer-run-v2.ts:1245-1266`) — không thể bị thuyết phục rằng "số này có nguồn".
   Defect thật sự sắc (bắt được "chênh lệch 336 triệu" không kiểm chứng được).

4. **Provenance bằng hash ở gần như mọi mối nối.** `turnKey = sha256(batch|item|stage|
   attempt|inputHashes|promptVersion)`; general pack đổi giữa run → run FAIL
   (`GENERAL_PACK_CHANGED`, `writer-run-v2.ts:1043`); aggregator re-verify hash artifact
   trên đĩa trước khi build formula.

5. **Style asset chất lượng cao hiếm thấy.** `general-packs/hieu-tv.md` và 2 file
   `channel-styles/` đều là taste-DNA neo vào quote nguyên văn kèm videoId, có luật kiểm
   được bằng máy ("mọi dòng `>` phải là substring của transcript"). Đây là tài sản quý
   nhất của hệ thống.

6. **Kỷ luật ghi chép.** Hằng số nào cũng dẫn bug/run sinh ra nó; cái gì chưa build được
   flag thẳng (REVIEW/REPAIR stage, VALIDATED unreachable); STATUS.md phân biệt
   "verified bằng run thật" vs "mới typecheck".

7. **Honest uncertainty.** Metrics đều `MethodTagged` với sample gate (8 video cho
   distribution, 12 cho correlation); `LOW_SAMPLE`/`SINGLE_SOURCE`/`TOPIC_LEAK` được lưu
   trên artifact thay vì nuốt.

---

## 2. Điểm yếu — xếp theo mức phải-xử-lý

### Nhóm A — Nghẽn cốt lõi: dữ liệu và đo lường (chặn mọi thứ khác)

| # | Vấn đề | Bằng chứng |
|---|---|---|
| A1 | **13 formula chỉ từ 3 video / 2 kênh.** Compound chủ lực `1c95764f` v34 dựa trên đúng 2 video và mang warning `TOPIC_LEAK` chưa xử lý. Clustering chưa bao giờ merge được gì (15/15 và 18/18 cluster SINGLE) — threshold 0.5 "là guess" và giờ đã gặp dữ liệu thật, sai. | `training/formulas/*`, `studio-sessions/*`, `cluster.ts:62` |
| A2 | **General pack 5/30 entry (17%).** Tài sản đòn bẩy cao nhất đang dở dang, blocked trên công việc tay không có tooling — dù luật "dòng `>` phải là substring transcript" máy kiểm được và `validateAnalysis` đã làm đúng phép đó cho formula. | `general-packs/hieu-tv.md:15` |
| A3 | **Không có eval loop ở bất kỳ đâu.** Compound v34 = 34 lần sửa mà không có gì đo v34 tốt hơn v1. Prompt version được ghi (`writer-v2-write-v3-exact-length`) nhưng không bao giờ được so sánh. Eval file của taste-RAG là `[]`. 4/4 run DONE đều cần repair — chưa run nào DONE thẳng từ WRITE, và không ai biết vì prompt, vì pack thiếu, hay vì editor quá gắt. | `FORMULA-MIGRATION:273`, run history |
| A4 | **44% run fail chưa được điều tra.** Cả 4 FAILED đều là `AGENT_EXIT` tại STUDY, `study: null`, **không có `errorReason`**; 1 run kẹt `RUNNING` từ 16/8 không ai fail nó, UI poll mãi mãi. `continueWriterRunV2` chỉ cover WRITE-fail — failure mode chưa từng xảy ra; STUDY-fail (100% failure thật) không recover được. | `writer-run-v2.ts:1160,1362` |

### Nhóm B — Lỗ hổng kỹ thuật cụ thể (sửa được ngay, xếp theo độ nguy hiểm)

1. **Topic pack không được pin hash** — general pack và formula thì có, riêng nguồn
   fact duy nhất thì không (`WriterRunV2` không có `packHash`). Sửa pack giữa STUDY và
   GATE làm gate xét "sourced" trên văn bản khác. *(Fix ~10 dòng.)*
2. **Writer v2 nhận formula DRAFT/0-rule.** `startWriterRunV2:875` chỉ check tồn tại;
   trên đĩa có 2 formula 0-rule; UI auto-select `formulas[0]` sort theo createdAt DESC →
   một session interactive mới mở sẽ nổi lên đầu và bị pin làm "style contract" rỗng.
3. **Payoff gate mất trên đường COMPOUND — đúng artifact mà v2 pin.** `rebuildCompound`
   (`studio.ts:472-483`) không carry `role`; cả 2 compound trên đĩa `role: null` toàn bộ;
   `validateCompoundRule` không đòi payoff. Invariant "formula không được chỉ tả setup"
   bốc hơi đúng chỗ quan trọng nhất.
4. **Spy LLM layer là stub nhưng expose như thật.** `DeterministicStubLlm` là
   implementation duy nhất; `http.ts:150` không truyền `llm`; 5 tool MCP
   (`spy_channel_profile`, `spy_hook_taxonomy`, `spy_voice_profile`…) trả canned output
   gắn nhãn `method: 'interpreted'`. Bảng `profiles` 0 row. Hoặc nối LLM thật, hoặc rút
   khỏi `EXPOSED_TOOL_NAMES`.
5. **Mọi defect ⇒ repair, severity thu thập nhưng không dùng** (`:1480` chỉ test
   `defects.length === 0`); một nit LOW tốn một vòng repair đầy đủ. Và **không ai đọc lại
   prose sinh ra trong lúc repair** — sau REPAIR chỉ chạy gate.
6. **Hai contract Writer mâu thuẫn cùng ship.** v1 hard-fail mọi thứ không phải Profile;
   v2 bắt buộc Formula; doc kiến trúc còn ghi "formula là training-only". Kèm ~3.400 dòng
   dead code (writer-run.ts, taste-rag.ts, taste-store.ts, profile-store.ts) + corpus RAG
   267 doc mồ côi (chưa index từ 12/8).
7. **Hai đường restyle song song, lệch nhau.** Daemon ghi/đọc `writer/styled/<runId>/vN.md`
   nhưng skill ghi `exports/writer/<runId>/styled-vN.md` → bản styled thật không bao giờ
   xuất hiện trong `run.styled` và UI. Đường daemon chưa từng thành công (`AGENT_EXIT`).
8. **Dữ liệu spy bẩn:** bảng `channels` có row trùng cho cả Anh Ba lẫn Sói; **20/20 row
   NULL `subscriber_count`** → `viewPerSubMedian` không bao giờ tính được;
   `lastChannelEnrichError` có ghi lý do nhưng không ai đọc. 312/392 snapshot
   `transcript: skipped`.
9. **Heuristic chỉ-tiếng-Việt không gate theo `scope.language`** (leak check, stopwords
   clustering) — formula tiếng Anh sẽ được 0 leak detection một cách im lặng.
10. **Không có Zod schema cho `FormulaArtifact`** — `role: "resolution"`, `"framing"` (giá
    trị bịa) đã nằm trên đĩa; `saveFormula` ghi mọi thứ được đưa.
11. **Lỗi bị nuốt im lặng:** `getFormula` nuốt mọi error thành `null` (file hỏng = file
    không tồn tại); `listFormulas` skip corrupt không đếm không log.
12. **Test e2e đang đỏ** (fixture thiếu `general-pack.md`) + `regate-cli.ts` 678 dòng
    **0 test**.

### Nhóm C — Vận hành

- Manual ở mọi mối nối: soạn pack, pick rule Studio, promote VALIDATED (0 asset nào từng
  được promote), soạn channel style, invoke restyle.
- Docs lệch thực tế: `plan/writer-train/STATUS.md` vẫn chỉ M2.6/FM1 là việc hiện tại
  trong khi v2 đã đảo ngược premise — người theo docs sẽ build sai thứ.

---

## 3. Thứ tự sửa đề xuất (trước khi đổ thêm dữ liệu training)

**Đợt 1 — vá lỗ trước khi train thêm (1-2 ngày):**
B1 pin topic pack hash · B2 chặn formula DRAFT/0-rule · B3 carry `role` qua compound +
require payoff · B10 Zod schema cho FormulaArtifact · sửa test e2e đỏ · fail-fast +
`errorReason` cho STUDY `AGENT_EXIT` và stale-run reaper (A4).

**Đợt 2 — đo lường tối thiểu (song song với thu thập nguồn):**
A3: định nghĩa 4 chỉ số rẻ, tính được từ run record có sẵn — (1) gate-first-pass rate,
(2) số violation theo code, (3) số editor defect theo severity, (4) human edit distance
trên bản final. Ghi vào một `eval.jsonl` mỗi run DONE. Không cần LLM score.

**Đợt 3 — dọn nợ:** gỡ v1 surface + taste-RAG (hoặc archive), hợp nhất 2 đường restyle
về một directory, cập nhật STATUS/SDD, dedupe bảng channels + backfill subscriber_count.

Chi tiết nguồn dữ liệu mới: xem [`training-source-expansion-plan.md`](./training-source-expansion-plan.md).
