> **Agent:** claude
> **Ngày:** 2026-08-19
> **Phạm vi:** Plan tìm video/nguồn để tiếp tục training pipeline
> **Đi kèm:** [`pipeline-assessment-2026-08-19.md`](./pipeline-assessment-2026-08-19.md)
> **Nguyên tắc nguồn:** Spy MCP là source of record cho harvest (AGENTS.md); vidIQ chỉ dùng
> cho discovery ngoài corpus (đúng ADR-SI-4 trong `plan/codex/spy-intelligence-learning-roadmap.md`).

# Plan mở rộng nguồn training

## 0. Insight định hướng: pipeline học 3 thứ khác nhau → cần 3 loại nguồn khác nhau

| Lớp | Học gì | Asset | Hiện có | Cần |
|---|---|---|---|---|
| **Craft/voice** (cách kể) | hook shape, cách dẫn ví dụ, payoff, taste DNA | General pack | 1 pack, **5/30 entry** | Hoàn thành + pack thứ 2 |
| **Structure** (khung bài) | beat, escalation, payoff theo format | Formula | 13 formula / **3 video / 2 kênh** | ≥10 video, ≥4 kênh |
| **Voice kênh mình** | xưng hô, nhịp câu, dàn nhân vật | Channel style | 2 style v1 | Thêm evidence + style mới |

**Hệ quả quan trọng nhất: nghẽn hiện tại KHÔNG phải thiếu video.** Corpus đã có 392
snapshot / 66 transcript nhưng mới formula-hóa 3 video và khai thác 5/30 transcript Hiếu
TV. Wave 0 vì thế là khai thác kho có sẵn, chưa cần spy gì mới.

---

## Wave 0 — Vắt kho đang có (tuần này, 0 quota YouTube)

1. **Hoàn thành general pack `hieu-tv.md`: 25 entry còn lại.**
   - Transcript đã nằm sẵn ở `writer-room-data/spy/hieu-tv-transcripts/` (30 file).
   - Làm theo đúng process spec ở cuối file pack; mỗi entry ~1 buổi làm tay, hoặc dựng
     tooling: agent đề xuất entry draft → máy verify "mọi dòng `>` là substring
     transcript" (tái dùng logic `validateAnalysis`) → human duyệt. Đây là đòn bẩy
     lớn nhất trên chất lượng WRITE.
   - Lưu ý ngân sách: pack đầy đủ ~60-80k token/prompt WRITE → cân nhắc chia pack theo
     content mode (explainer vs story-led) thay vì 1 file nhồi tất.

2. **Formula-hóa video đã có transcript nhưng chưa dùng.**
   - Anh Ba Tài Chính: 63 snapshot trong DB, mới 2-3 video thành formula. Chọn 3-5 video
     top-view có transcript `ok`, chạy ANALYZE → Lab.
   - Sói Tài Chính: 33 snapshot, tương tự chọn 2-3.
   - Mục tiêu ra khỏi Wave 0: **≥8 formula REFINED từ ≥8 video khác nhau** → lần đầu
     tiên clustering ở Studio có cơ hội merge thật (hiện 15/15 SINGLE), và đủ điều kiện
     FM4 (merge nhiều video) theo `FORMULA-MIGRATION-TO-WRITER.md:271`.

3. **Deep Epoch (60 snapshot) — quyết định giữ/bỏ.** Đang chiếm 15% corpus nhưng 0
   formula, 0 pack. Nếu không thuộc định hướng nội dung thì đánh dấu ngoài-scope để
   khỏi nhiễu metrics; nếu thuộc, xếp vào Wave 1.

4. **Điều kiện tiên quyết:** làm Đợt 1 của assessment trước (chặn formula DRAFT, carry
   `role` qua compound, pin topic pack, eval.jsonl) — đổ thêm dữ liệu vào pipeline chưa
   đo được là lãng phí.

---

## Wave 1 — Kênh mới cùng format (2-3 tuần, dùng Spy MCP)

Ứng viên đã xác minh số liệu qua vidIQ ngày 2026-08-19. Ưu tiên theo **fit format** với 2
content mode đang chạy (explainer có host + story-led hoạt hình nhân vật):

### Nhóm 1 — Hoạt hình kể chuyện tài chính (cùng format Anh Ba / kênh mình)

| Kênh | Handle | Tín hiệu | Học gì |
|---|---|---|---|
| Anh Nhân Viên Tài Chính | `@anhnhanvientaichinh` | breakout, **+35%/30d subs**, 2.4k subs, 29 video dài/30d | Kênh nhỏ đang thắng bằng đúng format "bài học từ đời đi làm" — pattern dễ tách vì chưa bị nhiễu thương hiệu |
| Chuyện Tài Chính | `@ctc-confession` | breakout, +23.6%/30d, 22 video, avg 23.7k views | Confession-style kể chuyện ngôi tôi — bổ sung mode story-led |
| Ông Chú Tài Chính | `@ongchutaichinh-vn` | breakout, +7.2%/30d, avg 23.8k | Đã có 1 snapshot trong corpus; cùng "vũ trụ" Anh Ba |
| Cuộc Đời Doanh Nhân | `@cuocdoidoanhnhan` | +16%/30d, 13 video dài/7d | Biography arc — cấu trúc khác để formula đa dạng |

### Nhóm 2 — Host chững chạc kiểu Hiếu TV (nguồn craft/voice)

| Kênh | Handle | Tín hiệu | Học gì |
|---|---|---|---|
| **Trí Tài Chính** | `@tritaichinh` | 313k subs / **35 video / avg 98.7k views** — hiệu suất trên video cao nhất danh sách | Kênh ít video mà avg views cực cao = mật độ "công thức thắng" trên mỗi video lớn nhất; ứng viên số 1 cho pack thứ 2 |
| Clever Girls | `@clevergirls271` | 47.9k subs, đăng đều, long-form 14' | Giọng nữ, đơn giản hoá — mở content mode mới |
| fmthanhtc | `@fmthanhtc` | +104%/30d subs, +212%/30d views | Đang có cú viral — spy để xem video nào kéo |

### Nhóm 3 — Story-led "làm giàu" thuần faceless (đối chứng)

| Kênh | Handle | Tín hiệu |
|---|---|---|
| CỔ NHÂN HỌC | `@conhanhoc2026` | breakout, +12%/30d, 249 video dài/năm, est $200/mo |
| Dòng Chảy Tri Thức | `@dongchaytrithuc90` | 8.5k subs, 26' avg, tăng từ 0 trong 1 năm |
| Bí mật kinh doanh | `@bimatkinhdoanh614` | 60k subs, +73%/năm, est $500/mo, 30 video/30d |
| Giàu Một Đời | `@giaumotdoi` | +17%/30d, 30 video/30d — content farm để học *anti-pattern* |

### Cách chạy mỗi kênh (đúng policy Spy MCP)

```
spy_channel_start { url, topN: 8, selectionMode: "popular", rankBy: "views", depth: "transcript" }
→ spy_wait → spy_run_manifest
→ chọn 1-2 video outlier nhất (views / tuổi video so với median kênh)
→ ANALYZE → Lab REFINE (chỉ video vượt gate transcript ok)
```

**Tiêu chí chọn VIDEO (không phải chọn kênh):**
- Long-form 8–30 phút, transcript lấy được (`transcript_status: ok`);
- Outlier thật so với chính kênh đó (views cao hơn median kênh ≥2×) — học video thắng,
  không học video trung bình;
- Format khớp content mode đích (explainer / story-led); loại video news/market-update
  (Nhóm tin tức không tái dùng được cấu trúc);
- Mỗi kênh tối đa 2-3 formula để tránh lệch nguồn như hiện tại.

**Định mức Wave 1:** 5 kênh × 8 video spy = 40 snapshot mới, ~12-15 transcript,
7-10 formula mới. Sau Wave 1 corpus formula: ≥15 formula / ≥6 kênh — đủ cho compound
merge thật và đủ 8-12 video/kênh cho metrics distribution với 2-3 kênh trọng tâm.

---

## Wave 2 — Vòng lặp liên tục (từ tuần 4, gắn với roadmap M1/M2 của codex)

1. **Watchlist đối thủ** (M1 roadmap): đưa ~8 kênh Wave 1 + 4 kênh gốc vào competitor
   list; re-scan 2 tuần/lần; báo cáo "what changed" — video mới nào outlier → ứng viên
   formula/pack tiếp theo. Bảng `competitors`/`candidate_channels` đang 0 row, đây là chỗ
   dùng nó.
2. **Snapshot định kỳ để có VPH thật** (M2): poll corpus đã track, không crawl toàn
   YouTube. Outlier by-age-cohort thay cho "views tuyệt đối" khi chọn video học.
3. **Nguồn từ chính kênh mình:** mỗi bài publish → về sau lấy retention/CTR qua OAuth
   (M4) làm eval thật; trước mắt, mỗi lần human sửa bản final là một Taste case
   (FM2 capture — đang 0 case, cơ chế đã thiết kế xong trong FORMULA-MIGRATION §3).
4. **Tiêu chí dừng nạp nguồn:** khi 2 wave liên tiếp không sinh rule mới sống sót qua
   Lab (loop-until-dry) thì chuyển ngân sách từ "thêm kênh" sang "làm sâu pack + eval".

---

## Đo lường (điều kiện để plan này không thành đổ dữ liệu vào hố đen)

Trước khi kết thúc Wave 0, bật `eval.jsonl` ghi mỗi run DONE:
`{ runId, formulaId+version, packVersion, gateFirstPass, violationsByCode, defectsBySeverity, repairRounds, humanEditDistance? }`

Câu hỏi cần trả lời được sau Wave 1:
- Formula từ N video có giảm editor defect so với formula 2 video không?
- Pack 30 entry có tăng gate-first-pass so với pack 5 entry không?
- Kênh nguồn nào cho formula "sống" qua nhiều topic nhất?

Không trả lời được 3 câu này = chưa nên mở Wave 2.

---

## Tóm tắt việc theo tuần

| Tuần | Việc | Đầu ra |
|---|---|---|
| 1 | Đợt-1 fix (assessment) + 10 entry pack Hiếu TV + eval.jsonl | pipeline sạch, đo được |
| 2 | 15 entry còn lại + formula-hóa 5 video Anh Ba/Sói có sẵn | pack 30/30, 8+ formula |
| 3 | Spy Trí Tài Chính + Anh Nhân Viên TC + Chuyện Tài Chính | 3 kênh mới, 4-6 formula |
| 4 | Spy nốt nhóm 3 + Studio compound merge thật + so eval | compound v2 đa nguồn |
| 5+ | Watchlist 2-tuần/lần + Taste capture + quyết định pack thứ 2 | vòng lặp thường trực |
