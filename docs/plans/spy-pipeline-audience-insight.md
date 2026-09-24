# Pipeline Audience Insight — bản áp cho Writer Room

**Ngày:** 2026-09-21
**Tham chiếu:** `youtube_audience_insight_sop.md` (38 bước) · `youtube_agent_node_standardization.md` (5 agent)
**Thực trạng:** [Báo cáo vòng 1–2](../../writer-room-data/spy-sheet/bao-cao-pov-finance.md) · [Vận hành](./spy-phase-2-van-hanh.md) · [Phân lớp niche](./spy-phan-lop-niche.md)

Hai file tham chiếu là **khung tốt**. Tài liệu này giữ khung đó, nhưng thay các chỗ
mà dữ liệu thật trong dự án đã chứng minh là sai hoặc không đo được.

---

## 1 · Đã có gì — đối chiếu 38 bước SOP

| Bước SOP | Trạng thái | Tài sản |
|---|---|---|
| 6 · Metadata video | ✅ | `spy_channel_start` → `spy_fact_video` 1.486 dòng |
| 7 · Transcript | ✅ | yt-dlp `en-orig` → `spy_hook_analysis` 182 dòng |
| 8 · Comments | ✅ | `spy_video_comments` → 1.488 comment |
| 9 · Làm sạch | ✅ **vượt SOP** | `langgate.py` + `validate.py` + đối chiếu ngược sheet |
| 10 · Baseline kênh | ✅ **vượt SOP** | median **theo từng chế độ**, không phải median phẳng |
| 11 · Outlier Score | ✅ **có sửa** | xem mục 3 |
| 13 · Phân tích Title | ✅ **vượt SOP** | Mann-Whitney có p-value, `spy_title_analysis` |
| 15 · Phân tích Hook | ✅ | WPM, ngôi kể, chi tiết giác quan, n=182 |
| 18 · Lọc comment | ✅ | `filter_comments.py`, đo được 77% nhiễu |
| 19 · Phân loại VOC | ✅ | `extract_voc.py`, 9 loại đúng SOP |
| 20 · Audience Signal | ⚠️ mới 20/336 | `chien_luoc_voc` |
| 29 · Gap | ⚠️ thô | `spy_gaps` 8 dòng |
| 31 · Opportunity Score | ❌ | chưa có công thức thống nhất |

**Chưa có gì — và đây là mắt xích lớn nhất:**

```
22 JTBD  →  23 Job type  →  24 Cluster  →  25 Đặt tên  →  26 Micro-Niche
                                                              ↓
                          33 Content Territory  →  34 Hypothesis  →  35 Kiểm trùng
```

Cộng: 14 Thumbnail · 16 Nội dung video ngoài hook · 17 Audience Assumption · 32 Giải thích điểm.

---

## 2 · Bốn chỗ SOP cần sửa vì dữ liệu nói khác

### 2.1 · Baseline không được phẳng (bước 10)

SOP viết `Median Views(channel baseline)`. Dữ liệu nói: **kênh có thể đứt gãy chế độ**.
POV Finance ngày 18/08 nhảy từ median 726 lên 53.419 view — hệ số 73,6x, Pettitt p=6,6×10⁻¹¹.
Median phẳng trộn hai kênh khác nhau.

> **Bắt buộc:** chạy phát hiện đứt gãy TRƯỚC, rồi tính median **trong từng chế độ**.
> Tôi đã dính lỗi này và nó làm nhóm `giàu ngầm` hiện 1,28x trong khi thật là 1,00x.

### 2.2 · Outlier Score cần cổng chặn nền (bước 11)

`Views / Median` đẩy kênh nền chết lên đầu: kênh median 91 view có một video 70.357 → 773x.
Đó là trúng số, không phải mô hình lặp lại được.

> **Bắt buộc thêm:** `baseline_tier` = dead (<500) | thin (500–4999) | proven (≥5000),
> và `baseline_video_count < 10` thì luôn là `dead`. Dòng `dead` giữ trong bảng nhưng
> không bao giờ lên shortlist.

### 2.3 · "Audience similarity 25%" không đo được từ ngoài (Agent 03)

Agent 03 chấm đối thủ theo 5 chiều, trong đó `audience_similarity` chiếm 25%.
Đo thật trên 15 kênh: **chồng lấn kênh giữa các luồng nội dung là 67–100%** — mọi kênh
làm mọi luồng. Engagement 2,43–3,28%, thời lượng 17,4–21,6 phút, đều phẳng.

> Không có tín hiệu ngoài nào phân biệt được audience. Dùng `audience_similarity` như
> một điểm số là **tạo ra con số giả**. Thay bằng: `format_similarity` + `market_language`
> (đo được), và ghi `audience_similarity = KHÔNG ĐO ĐƯỢC` thay vì chấm bừa.

### 2.4 · Ngưỡng Opportunity Score là heuristic, không phải luật

Agent 05 đặt `>= 8.0 = PRIORITY_TEST`. Không có gì trong dữ liệu biện minh cho con số 8,0.
Giữ công thức 6 thành phần của SOP (nó hợp lý), nhưng **ngưỡng phải hiệu chỉnh lại sau
mỗi vòng** bằng kết quả thật, và ghi rõ đó là heuristic đang thử.

---

## 3 · Năm thứ dự án này có mà SOP không có — phải giữ

**Cổng ngôn ngữ tại tầng thu thập.** SOP không nhắc ô nhiễm thị trường. Vòng 2 lọt 74 dòng
tiếng Việt vào nghiên cứu nhắm Mỹ. `langgate.py` chặn tại tầng thu thập, không lọc ở tầng đọc —
lọc tầng đọc thì lần refresh sau nó lại lọt vào.

**Đối chiếu ngược deliverable.** Ghi TSV đúng không có nghĩa sheet đúng. Locale `vi_VN` biến
`"74.68"` thành `746830645091782` mà validator vẫn báo xanh. Mọi bảng ship ra phải đọc lại
từ đích bằng giá trị thô và diff với nguồn.

**Đo tỉ lệ nhiễu, không chỉ lọc.** 77% comment là nhiễu. Con số đó tự nó là thông tin về
chất lượng đường thu thập. Dòng bị loại vào cách ly, không xoá.

**Kiểm định thống kê trên title.** SOP bước 13 chỉ nói "phân tích title". Không có p-value
thì không phân biệt được `real math` (13 thắng/1 thua) với `pov` (16/25, p=0,615).

**Nhật ký quyết định.** Vũ trụ mẫu của ta là tập **được phát hiện**, không sạch sẵn.
Mọi thay đổi phạm vi ghi vào `_decisions.tsv`.

---

## 4 · Pipeline áp dụng

```
[AGENT 01] Research Scope ──────────────── ĐÃ CÓ dạng thủ công, nên tự động hoá
      ↓
[AGENT 03] Competitor Criteria ─────────── sửa theo 2.3
      ↓
[CODE] spy_channel_start + spy_expand_graph
      ↓
[CODE] langgate.py ──────────────────────── CỔNG NGÔN NGỮ, chặn tại đây
      ↓
[CODE] spy_regime (Pettitt) ─────────────── PHẢI chạy trước baseline
      ↓
[CODE] baseline theo chế độ + baseline_tier
      ↓
[CODE] outlier_score_within_channel + rank_score
      ↓
   ┌──────────────┴──────────────┐
   ↓                             ↓
[AGENT] Title/Hook            [CODE] spy_video_comments
  Mann-Whitney                      ↓
   │                          [CODE] filter_comments.py   (77% nhiễu)
   │                                ↓
   │                          [AGENT] extract_voc.py + đọc sâu 6 trường
   └──────────────┬──────────────┘
                  ↓
        [AGENT] JTBD ◄──────────────────── CHƯA CÓ · ưu tiên 1
                  ↓
        [AGENT] Audience Cluster ◄──────── CHƯA CÓ · ưu tiên 2
                  ↓
        [AGENT] Micro-Niche ◄───────────── CHƯA CÓ · ưu tiên 3
                  ↓
        [AGENT] Gap = Demand − Supply
                  ↓
        [CODE] Opportunity Score
                  ↓
        [AGENT 04] Quality Reviewer ◄───── 6 cổng của SOP, giữ nguyên
                  ↓
        [AGENT] Content Hypothesis ◄────── CHƯA CÓ · ưu tiên 4
                  ↓
        [HUMAN] chỉ khi rơi vào Exception Queue
```

---

## 5 · Bốn thứ phải xây, theo thứ tự

### 5.1 · JTBD — từ VoC đã có

Đầu vào: `chien_luoc_voc` (cột `underlying_question` chính là hạt giống JTBD).

```
WHEN     [tình huống cụ thể]
I WANT TO [hành động]
SO I CAN [kết quả mong muốn]
BUT      [rào cản]
```

Ví dụ rút được ngay từ comment 63 like:

```
WHEN     tôi mới đầu tư vài năm và chưa thấy lãi kép có tác dụng
I WANT TO biết chính xác phải gồng bao lâu nữa
SO I CAN không bỏ cuộc giữa chừng
BUT      mọi video chỉ dạy lãi kép hoạt động ra sao, không nói giai đoạn đầu
```

Bảng `jtbd.tsv`: `jtbd_id · when · i_want_to · so_i_can · but · job_type · evidence_comment_ids · n_comment · confidence`

`job_type` = functional | emotional | social (bước 23).

### 5.2 · Audience Cluster

Gom JTBD theo `situation` + `barrier` chung. **Không gom theo chủ đề** — đã đo, gom theo
chủ đề chỉ cho biên độ 1,78x, gom theo insight cho 2,64x.

`cluster.tsv`: `cluster_id · ten · jtbd_ids · situation_chung · barrier_chung · n_evidence · ngon_ngu_dac_trung`

### 5.3 · Micro-Niche — bốn thành phần, không được thiếu

```
AUDIENCE + SITUATION + PROBLEM + DESIRED TRANSFORMATION
```

Ví dụ đủ chuẩn, rút từ VoC thật:

> Người đã đầu tư 2–4 năm · đang ở giai đoạn lãi kép chưa thấy tác dụng ·
> không biết còn phải gồng bao lâu nên nghi ngờ cả phương pháp ·
> muốn biết mốc thời gian thật để yên tâm không bỏ cuộc

Ví dụ **bị loại** theo Gate 6: `Investing` · `Saving` · `Personal Finance` · và cả
`Lãi kép & cột mốc` — đó là **chủ đề**, không phải micro-niche.

### 5.4 · Content Hypothesis

`hypothesis.tsv`: `niche_id · audience · tension · promise · angle · evidence · title_de_xuat ·
trung_lap_voi (bước 35) · opportunity_score · decision`

---

## 6 · Quy tắc Evidence — lấy nguyên của SOP, và tôi đã vi phạm nó

Mỗi insight phải có đủ 6 phần:

| | |
|---|---|
| **Observation** | quan sát được gì |
| **Pattern** | lặp lại ở đâu |
| **Interpretation** | động cơ nào giải thích |
| **Evidence** | video/comment/hiệu suất nào chống lưng |
| **Confidence** | HIGH · MEDIUM · LOW |
| **Alternative** | còn cách giải thích nào khác |

Ô trống thì ghi `INSUFFICIENT EVIDENCE`, không được đoán.

> **Gate 5 (nhân quả) tôi đã vi phạm trong phiên này.** Tôi dựng chuỗi "Bille Finance suy giảm
> đơn điệu" bằng view **luỹ kế qua các tuổi khác nhau** rồi bỏ qua hai điểm dữ liệu, trong đó
> có điểm cao nhất cửa sổ. Agent khác bắt được và đặt tên là *phantom decay*.
>
> **Luật bổ sung:** mọi khẳng định xu hướng phải kèm **chuỗi đầy đủ không lọc**, và không bao giờ
> dựng chuỗi thời gian bằng số luỹ kế qua các tuổi khác nhau. Trend claim chỉ hợp lệ từ **snapshot kép**.

---

## 7 · Ràng buộc vận hành thực tế

**Người điều phối không được miễn trừ.** Ba lỗi nặng nhất phiên này nằm trong code và lập luận
của người điều phối, cả ba do agent khác bắt. Agent 04 (Quality Reviewer) phải soi cả output của
người điều phối.

**Kênh giao việc mất tin.** Đo được: **25% lệnh giao thất bại**, và dồn theo terminal đích chứ
không rải đều. Seat bị `quarantined` thì im lặng biến mất. Cần sổ biên lai; 2 lần thất bại liên
tiếp thì coi như agent đó không nhận việc.

**Công cụ có cấu hình rò.** Spy đang cấu hình cho topic tiếng Việt: `ytdlp.ts:172` ưu tiên `vi`
trước `en`, `niche.ts:209` cộng +10 cho kênh khớp regionCode của market. **Mọi điểm số của Spy
dính ngôn ngữ hoặc thị trường đều vô hiệu** cho dự án nhắm Mỹ cho tới khi sửa thành tham số theo topic.

---

## 8 · Thứ tự làm

| # | Việc | Node | Chặn cái gì |
|---|---|---|---|
| 1 | JTBD từ 20 dòng VoC đã có | AGENT | chặn 2,3,4 |
| 2 | Trích sâu nốt 316 comment còn lại | AGENT | mẫu quá nhỏ |
| 3 | Audience Cluster | AGENT | chặn 4 |
| 4 | Micro-Niche 4 thành phần | AGENT | chặn 5,6 |
| 5 | Opportunity Score + giải thích | CODE+AGENT | |
| 6 | Content Hypothesis + kiểm trùng | AGENT | |
| 7 | Agent 04 soi lại toàn bộ theo 6 cổng | AGENT | |

Bước 1 và 2 làm được ngay với dữ liệu đang có. Bước 3–6 phụ thuộc bước 1–2.

**Chưa ưu tiên:** Thumbnail (bước 14) và nội dung video ngoài hook (bước 16) — tốn kém,
và dữ liệu hiện có chưa dùng hết.
