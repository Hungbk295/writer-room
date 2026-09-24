# Phân lớp niche khi spy một topic mới

**Mục tiêu:** khi bắt đầu spy một topic mới, xác định niche đó đang có những **luồng content** nào,
luồng nào **to nhất**, để đánh vào luồng to trước rồi mở rộng sang luồng liền kề.

---

## 0 · Thứ phải nói thẳng trước: tuổi khán giả KHÔNG đo được từ bên ngoài

YouTube Data API **không trả demographics** của kênh người khác. Chỉ chủ kênh thấy được tuổi/giới tính
khán giả, qua YouTube Analytics API với OAuth của chính họ.

Tôi đã thử proxy trực tiếp nhất — mốc tuổi và giai đoạn sống trong tiêu đề — trên 1.486 video:

| Phân lớp | Video | % corpus | Hiệu suất |
|---|---|---|---|
| 20s | 12 | 0,8% | 0,74x |
| 25–35 | 21 | 1,4% | 0,83x |
| 35–50 | 27 | 1,8% | 1,20x |
| 50+ | 88 | 5,9% | 0,62x |
| **không rõ** | **1.351** | **90,9%** | — |

**90,9% video không có dấu hiệu tuổi nào.** Đây là nhạc cụ quá yếu để phân lớp một niche.

> **Hệ quả thiết kế:** đơn vị phân lớp là **luồng content**, không phải nhóm tuổi.
> Tuổi chỉ được **suy ra** từ ngữ nghĩa của luồng, và phải ghi rõ đó là suy luận.

---

## 0b · Đã kiểm 5 chiều — 4 chiều KHÔNG tách được tệp khán giả

Để tìm bằng chứng hành vi cho "nhóm content này phục vụ tệp nào", tôi đo 5 chiều trên 1.486 video
của 15 kênh:

| Chiều | Biên độ đo được | Kết luận |
|---|---|---|
| Chồng lấn kênh giữa các luồng | **67–100%** | không tách được |
| Engagement rate theo luồng | 2,43% – 3,28% | không tách được |
| Thời lượng video theo luồng | 17,4 – 21,6 phút | không tách được |
| Biên độ tiền nhắc trong tiêu đề | 0,82x – 1,20x, **không đơn điệu** | yếu |
| **Luồng chủ đề** | **0,65x – 1,28x** | **chiều duy nhất có tín hiệu** |

Chồng lấn kênh là phát hiện quan trọng nhất: **mọi kênh đều làm mọi luồng** (67–100% chồng lấn).
Không có kênh nào chuyên một luồng. Nghĩa là không thể dùng "kênh chung = tệp chung" làm bằng chứng —
nó không phân biệt được gì.

Biên độ tiền tưởng hứa hẹn (`$1.000` ở đầu tư vs `$1.000.000` ở hưu trí) nhưng khi chia theo biên độ
thì hiệu suất là 1,20x · 0,82x · 1,02x · 1,11x · 1,02x — lên xuống không theo quy luật, và video
**không nhắc tiền** cũng đạt đúng 1,00x. Không phải biến phân lớp.

### Kết luận có hệ quả chiến lược

> **Trong niche này, khán giả KHÔNG bị phân mảnh.** Đó là **một tệp rộng** tiêu thụ mọi luồng
> từ cùng những kênh tổng hợp. Cái thay đổi không phải *ai xem*, mà là *chủ đề nào cộng hưởng*.

Nên câu hỏi đúng không phải "lớp khán giả nào to nhất" mà là **"chủ đề nào tệp đó phản ứng mạnh nhất"**.

⚠️ **Nhưng đây là tính chất của niche NÀY**, đo trên 15 kênh faceless tài chính cá nhân. Niche khác
có thể phân mảnh thật (ví dụ: gaming tách rõ theo tựa game, làm đẹp tách theo độ tuổi da).
**Với topic mới phải CHẠY phép đo này, không được giả định.** Xem mục 3b.

---

## 1 · Đơn vị phân lớp: luồng content

Cụm chủ đề phủ 100% corpus và phân biệt được rõ. Đo trên cùng 1.486 video:

| Luồng | Video | Kênh | Hiệu suất | Tổng view |
|---|---|---|---|---|
| giàu ngầm | 54 | 12 | **1,28x** | 3.215.975 |
| bất động sản | 39 | 10 | **1,28x** | 2.965.603 |
| thu nhập / nghề nghiệp | 73 | 11 | 1,03x | 1.208.062 |
| đầu tư & quỹ | 69 | 10 | 0,92x | 3.039.010 |
| nợ & thế chấp | 62 | 13 | 0,89x | 2.332.340 |
| tiết kiệm / frugal | 40 | 9 | 0,87x | 1.880.730 |
| tư duy / thói quen | 48 | 10 | 0,68x | 1.530.654 |
| hưu trí | 75 | 10 | **0,65x** | 1.132.848 |

Chênh lệch 1,28x so với 0,65x là gấp đôi — đủ để ra quyết định.

---

## 2 · Tự động gom cụm: đã thử, KHÔNG dùng được

Để không phải viết tay mẫu cho mỗi topic mới, tôi thử gom cụm tự động: đếm đồng xuất hiện từ trong
tiêu đề, tính PMI, dựng đồ thị, hợp cụm bằng union-find.

**Kết quả thất bại:**

| Cụm tự sinh | Video |
|---|---|
| money · every · pov · life · wealth · level | **1.087** |
| years · invest · retire · month · happens | 109 |
| actually · salary · much | 86 |
| owning · economics · company · business | 136 |

Một cụm khổng lồ nuốt 73% corpus. Nguyên nhân: từ vựng bị các từ tài chính chung chi phối, chúng
đồng xuất hiện với mọi thứ nên PMI trên unigram không tách được.

> **Kết luận:** đừng hứa tự động hoá hoàn toàn. Dùng **quy trình lai** ở mục 3.

---

## 3 · Quy trình lai — chạy được cho mọi topic mới

### Bước 1 · Thu hạt giống (tự động)

10–20 kênh trong topic → `spy_channel_start` → corpus tiêu đề.
Yêu cầu tối thiểu **≥800 tiêu đề** để thống kê có nghĩa.

### Bước 2 · Máy đề xuất từ khoá (tự động)

Rút n-gram 1–3 từ, chuẩn hoá hiệu suất theo nền từng kênh, giữ cụm xuất hiện ở **≥4 kênh khác nhau**
(lọc quirk của một kênh). Ra ~200 cụm xếp theo hiệu suất.

> Đây chính là script đã chạy cho POV Finance, ra `kw_from_channels.tsv` 208 dòng.

### Bước 3 · Người gom thành luồng (thủ công, ~15 phút, MỘT LẦN cho mỗi topic)

Đọc 200 cụm, gom thành **6–10 luồng** đặt tên bằng ngôn ngữ nghiệp vụ. Ghi ra `niche_streams.tsv`:

```
stream_id  stream_name  match_pattern  audience_hypothesis  confidence  rationale
```

- `match_pattern`: regex gom video vào luồng
- `audience_hypothesis`: nhóm tuổi **suy ra**, không phải đo
- `confidence`: `high` khi luồng có mốc tuổi tường minh (hưu trí, student loan) ·
  `medium` khi suy từ giai đoạn sống (thế chấp → 30–45) · `low` khi thuần suy đoán

Đây là bước duy nhất cần người. Mọi bước sau tự động.

### Bước 3b · Chẩn đoán: niche này có phân mảnh không? (tự động — BẮT BUỘC)

Trước khi lên chiến lược, phải biết mình đang ở kiểu niche nào. Chạy phép đo 5 chiều ở mục 0b:

```
overlap_matrix   = với mỗi cặp luồng, % kênh làm cả hai
engagement_spread = max/min engagement rate giữa các luồng
duration_spread   = max/min thời lượng median giữa các luồng
perf_spread       = max/min hiệu suất chuẩn hoá giữa các luồng
```

| Kết quả | Kiểu niche | Chiến lược |
|---|---|---|
| overlap **> 60%** và engagement/duration phẳng | **Tệp hợp nhất** | Không phân lớp khán giả. Xếp hạng **chủ đề**, đánh chủ đề mạnh nhất. Một kênh phục vụ được cả niche. |
| overlap **< 40%**, engagement hoặc duration chênh **> 1,5 lần** | **Tệp phân mảnh** | Phân lớp khán giả thật. Chọn mảnh to nhất, làm kênh riêng cho mảnh đó. Đừng trộn. |
| ở giữa | **Bán phân mảnh** | Có 2–3 cụm luồng. Đánh một cụm, đừng nhảy giữa các cụm. |

POV Finance đo ra **overlap 67–100%, engagement 2,43–3,28%, duration 17,4–21,6 phút**
→ **tệp hợp nhất**. Không cần phân lớp khán giả. Xếp hạng chủ đề là đủ.

Phép đo này rẻ (0 quota, chạy trên corpus đã có) và **quyết định toàn bộ chiến lược phía sau**.
Bỏ qua nó là mặc định niche phân mảnh — giả định sai thì chọn sai luồng và tách kênh không cần thiết.

---

### Bước 4 · Đo kích thước từng luồng (tự động)

| Chỉ số | Nghĩa |
|---|---|
| `supply_videos` · `supply_channels` | ngách đã đông chưa |
| `total_views` | cầu đã được phục vụ |
| `rel_performance` | median hiệu suất chuẩn hoá theo nền kênh |
| `search_volume` | cầu tiềm ẩn chưa phục vụ |
| **`gap_score`** | `(total_views × rel_performance) / supply_videos` |

`gap_score` cao = nhiều người xem, hiệu suất tốt, ít người làm. Đó là luồng đánh trước.

### Bước 5 · Bản đồ liền kề (tự động)

Hai luồng **chia sẻ nhiều kênh** thì khán giả của chúng chồng lấn. Đó là đường mở rộng an toàn:
kênh nào phục vụ được luồng A thì cũng phục vụ được luồng B mà không mất tệp.

```
adjacency(A,B) = số kênh làm cả hai luồng / số kênh làm luồng A
```

Vẽ ra đồ thị luồng. Đánh luồng to nhất trước, rồi bước sang luồng có `adjacency` cao nhất với nó.

---

## 4 · Chiến thuật — rẽ nhánh theo kết quả chẩn đoán

### Nếu tệp HỢP NHẤT (trường hợp POV Finance)

Không phân lớp khán giả. Xếp hạng chủ đề theo `gap_score` rồi đánh lần lượt.
Một kênh phục vụ được cả niche — **không tách kênh**.

Bằng chứng ủng hộ: kênh model xoay ba trụ (`old_money` · `stealth_wealth` · `wealth_identity`)
trên cùng một kênh và giữ nền cao 5 tuần.

### Nếu tệp PHÂN MẢNH

Chọn mảnh có `gap_score` cao nhất, làm kênh riêng. Trộn mảnh trên cùng một kênh sẽ loãng tín hiệu
đề xuất và mất tệp.

---

## 4b · Chiến thuật: to trước, rồi lan theo cạnh

```
1. Chọn luồng gap_score cao nhất          → 8–12 video đầu tiên
2. Đạt nền ổn định trong luồng đó          → xác nhận mô hình chạy
3. Bước sang luồng adjacency cao nhất      → khán giả chồng lấn, không mất tệp
4. Lặp lại
```

**Đừng đánh nhiều luồng cùng lúc lúc đầu.** Kênh model POV Finance chỉ xoay **ba** trụ
(`old_money` · `stealth_wealth` · `wealth_identity`) và giữ nền cao 5 tuần liền. Bille Finance trộn
lẫn nhiều chủ đề rời rạc và rơi từ 66.786 về 3.196 view trong 20 ngày.

Tập trung là biến phân biệt, không phải độ phủ.

---

## 5 · Suy ra khán giả — ba mức tin cậy

| Mức | Căn cứ | Ví dụ |
|---|---|---|
| `high` | mốc tuổi tường minh trong tiêu đề | "at 50 with $0 saved" · "student loan" |
| `medium` | giai đoạn sống hàm ý chắc | thế chấp → 30–45 · 401k → 40+ · nghỉ hưu sớm → 30–45 |
| `low` | thuần ngữ nghĩa chủ đề | "giàu ngầm" → ? |

Mọi dòng trong `niche_streams.tsv` phải mang `confidence`. Khi trình bày cho người quyết định,
**không được đọc `low` như thể là `high`**.

Muốn biết tuổi thật thì chỉ có một đường: kênh của chính bạn chạy được vài tuần rồi đọc
YouTube Analytics. Lúc đó mới kiểm chứng ngược được giả thuyết ở bước 3 — và **phải kiểm chứng ngược**,
vì nếu giả thuyết sai thì cả chiến thuật chọn luồng sai theo.

---

## 6 · Runbook cho một topic mới

| # | Việc | Ai | Thời gian |
|---|---|---|---|
| 1 | Chọn 10–20 kênh hạt giống | người | 30 phút |
| 2 | `spy_channel_start` toàn bộ, ≥800 tiêu đề | script | ~15 phút, ~400 đơn vị |
| 3 | Rút n-gram → `kw_from_channels.tsv` | script | 1 phút |
| 4 | **Gom 200 cụm → 6–10 luồng** | **người** | **~15 phút** |
| 5 | Đo kích thước + gap_score | script | 1 phút |
| 6 | Dựng bản đồ liền kề | script | 1 phút |
| 7 | Chọn luồng đầu tiên, lên 8–12 đề tài | người | 1 giờ |

Tổng: **~2 giờ cho một topic mới**, trong đó chỉ 1,5 giờ cần người.

Sau đó topic vào vòng lặp hằng ngày ở [spy-phase-2-van-hanh.md](./spy-phase-2-van-hanh.md).

---

## 7 · Ràng buộc kế thừa

- **Cổng ngôn ngữ cứng** — chỉ nhận nội dung đúng thị trường mục tiêu. Chặn tại tầng thu thập
  (`langgate.py`), không lọc ở tầng đọc. Dòng bị chặn vào cách ly, giữ lại để đo tỉ lệ ô nhiễm.
- **Chuẩn hoá theo nền từng kênh** — mọi hiệu suất là `view / median của chính kênh đó`.
  Không bao giờ so view thô giữa các kênh khác quy mô.
- **Kênh có đứt gãy chế độ** — mọi chỉ số bắc qua mốc đứt gãy đều vô nghĩa. Chạy `spy_regime`
  trước khi tin bất kỳ con số nào của kênh đó.
- **`≥4 kênh` là ngưỡng lọc quirk** — cụm chỉ xuất hiện ở 1–2 kênh là đặc thù kênh đó,
  không phải đặc trưng của niche.

---

## 8 · Thứ chưa làm

Script cho bước 5 và 6 (`gap_score` và bản đồ liền kề) **chưa viết**. Bước 3 đã có
(script rút n-gram đã chạy cho POV Finance). Bước 4 là quy trình cho người, không cần code.

Với niche POV Finance hiện tại, bảng luồng ở mục 1 là kết quả của mẫu viết tay — đủ dùng để
ra quyết định ngay, nhưng chưa phải output của quy trình chuẩn hoá ở mục 3.
