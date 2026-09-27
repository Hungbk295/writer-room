# Giao thức điều phối nhiều agent — rút ra từ phiên POV-Finance 2026-09-18

Chạy thật với 5 agent, 2 vòng, 2 sheet, 5 lỗi xếp hạng bị bắt. Tài liệu này ghi thứ **đã kiểm chứng**,
để mở rộng lên 10 rồi 15-20 agent mà không vỡ.

## 0. Sự thật nền

| Quan sát thật | Hệ quả thiết kế |
|---|---|
| 592 video + 128 kênh + 634 keyword xong trong 1 vòng, 3 agent | Thu thập KHÔNG phải nút cổ chai. Đừng staff nó. |
| 5/5 lỗi xếp hạng lộ ra khi có NGƯỜI KHÁC hỏi con số đo gì | Staff đối kháng, không staff tổng hợp |
| 3 agent không hề nói chuyện → 0 `channel_id` mồ côi trên 127 dòng | Hợp đồng schema thay điều phối |
| 3/5 lệnh giao thất bại IM LẶNG, tôi báo sai với người dùng | Cần sổ biên lai, không tin trạng thái "đã gửi" |
| Ghép file + đẩy sheet + vẽ biểu đồ đã script hoá, chạy vài giây | Không có vai "tổng hợp". Đó là cách sheet hỏng ra đời. |

## 1. Năm lỗi xếp hạng — mẫu hỏng lặp lại

| # | Sống ở đâu | Cơ chế |
|---|---|---|
| 1 | Nguồn ngoài | `breakoutScore` vidIQ: không tái lập từ bất kỳ trường nào API trả |
| 2 | Công thức | `view/median`: kênh nền chết trúng số một lần → 773x đứng đầu |
| 3 | Công thức | Điểm rẽ 2 nhánh: dòng THIẾU dữ liệu xếp trên dòng ĐỦ dữ liệu |
| 4 | Công thức | Ràng buộc định nghĩa sản phẩm bị dùng làm trọng số thay vì cổng chặn |
| 5 | **Pipeline** | TSV→Sheets: chuỗi `"74.68"` + locale vi_VN → `746830645091782` |
| 6 | **Nguồn** | `SUBTITLE_LANGUAGE_PREFERENCE=['vi','en']` → transcript kênh Mỹ là bản dịch máy |
| 7 | **Cách đọc** | "phantom decay": dựng xu hướng bằng view lũy kế qua các tuổi khác nhau + trích dòng chọn lọc |

**Ba lớp lỗi, không phải một.** Lỗi 1-4 sống trong CÔNG THỨC. Lỗi 5-6 sống trong PIPELINE và NGUỒN —
dữ liệu đúng nhưng đường đi hỏng. Lỗi 7 sống trong CÁCH ĐỌC dữ liệu đã sạch — không công cụ nào bắt được,
chỉ người khác đọc lại mới bắt được. Tôi (người điều phối) chính là người mắc lỗi 7.
→ Người điều phối cũng phải bị phá, không được miễn trừ.

Lỗi 5 và 6 quan trọng vì chúng **không nằm trong dữ liệu**. Validator đọc TSV báo xanh trong khi
bảng đã ship xếp sai thứ tự, và transcript "sạch" về kiểu nhưng sai ngôn ngữ nguồn.

→ Người phá phải soi **cả code ghi ra và cả tầng nguồn**, không chỉ soi bảng.

## 2. Ba luật dữ liệu (đã chứng minh bằng lỗi thật)

- **(a) Cổng chặn ≠ trọng số.** Thứ ĐỊNH NGHĨA sản phẩm phải chặn. Thứ là ĐÁNH ĐỔI mới được cân.
- **(b) Không so điểm giữa hai nhóm tính bằng hai công thức hoặc hai nền khác nhau.**
  Thiếu dữ liệu thì để TRỐNG. Dữ liệu thiếu không được phép thành lợi thế.
- **(c) Lọc bằng NHÃN, không lọc bằng XOÁ.** Ngoại lệ duy nhất: đổi định nghĩa vũ trụ mẫu —
  và phải ghi vào `_decisions.tsv`.

Bổ sung từ vòng 2:
- **(d) Mọi chỉ số phái sinh phải có mốc AS-OF.** Cohort membership đổi theo ngày: cùng một video,
  as-of 09-18 ra 74.68, as-of 09-19 ra 72.52.
- **(e) Provenance ghi NGUỒN THẬT, không ghi tên tool.** `source=spy_transcript_fetch` che giấu
  việc transcript là bản dịch máy tiếng Việt. Phải có cột `transcript_lang` riêng.
- **(f) Mọi bảng ship ra phải qua đối chiếu ngược:** đọc lại từ đích bằng giá trị thô, diff với nguồn.
  Kiểu dữ liệu do `_dictionary` quyết (schema-of-record), không do phân bố dữ liệu hôm nay quyết.
  Ghi bằng RAW, không qua parser locale. Bộ phân loại của checker phải ĐỘC LẬP với writer.
- **(g) Chỉ số gộp một cửa sổ che mất hình dạng bên trong cửa sổ đó.** Kết luận về xu hướng phải kèm chuỗi.
- **(h) Không bao giờ dựng chuỗi thời gian bằng số LŨY KẾ qua các tuổi khác nhau.**
  Video 21 ngày tuổi luôn nhiều view hơn video 1 ngày tuổi kể cả khi nhu cầu phẳng.
  Và chuỗi phải ĐẦY ĐỦ, KHÔNG LỌC — trích chọn dòng là tự chấm bài lần nữa.

## 2b. Bốn tầng lỗi — thứ tự chúng lộ ra

| Tầng | Lỗi sống ở đâu | Ai bắt được | Ví dụ thật |
|---|---|---|---|
| 1 · Ô | giá trị sai kiểu, token cấm | validator tự động | `#ERROR!`, `"573.2x"` |
| 2 · Pipeline & nguồn | đường đi hỏng dù dữ liệu đúng | người phá đọc CODE và CẤU HÌNH | locale ăn `74.68` → `746830645091782`; `SUBTITLE_LANGUAGE_PREFERENCE=['vi','en']`; market `vi` cộng +10 cho kênh Việt |
| 3 · Schema | quan hệ giữa bảng hỏng | người phá đọc TOÀN BẢNG | 168 `video_id` trùng; cùng đại lượng ở hai cột rời nhau; enum khai 5 nhưng dữ liệu có 12 |
| 4 · Nội dung | dữ liệu sạch, kết luận sai | người phá đọc LẬP LUẬN | "phantom decay"; hook đáng copy nhất lại chưa phân tích; claim mạnh hơn p-value |

Tầng 1 tự động hoá được. Tầng 2-4 **bắt buộc phải có người khác đọc lại** — không công cụ nào thay được.
Và mỗi tầng chỉ lộ ra sau khi tầng dưới đã đóng: sửa xong ô mới thấy pipeline, sửa xong pipeline mới
thấy schema, sửa xong schema mới thấy nội dung. Đừng kỳ vọng thấy hết ngay vòng một.

## 2c. Hai luật cho vai giám khảo

- **Tiêu chí phải khả thi.** Trước khi chốt một tiêu chí nghiệm thu, hỏi "người bị chấm có ĐƯỜNG NÀO
  để đạt không". Không có đường thì tiêu chí đó không đo chất lượng — nó ép người ta bịa số.
  (Thật: một giám khảo đòi sửa `niche.ts` qua MCP, trong khi MCP không expose tham số nào.)
- **Giám khảo phải chặt với chính mình trước.** Hai lần liên tiếp một agent đưa con số tuyệt đối
  ("100% cột có formula", "video 301.745 là POV: You Inherited Old Money") mà kiểm lại thì sai.
  Luật: trước khi viết một con số tuyệt đối, chạy đúng phép đếm mà nó hàm ý.

## 3. Cấu trúc theo quy mô

```
5 agent    3 dựng + 2 phá                      — điều phối thủ công, tôi giữ sổ
10 agent   6 dựng + 3 phá + 1 thư ký           — thư ký giữ sổ biên lai + sổ mâu thuẫn
15 agent   8 dựng + 4 phá + 1 thư ký + 2 trực  — "trực" gác cổng nguồn và cổng pipeline
20 agent   chia 2 tổ độc lập, mỗi tổ 1 thư ký, 1 tổ trọng tài giữa hai tổ
```

**Người dựng** sở hữu một lát dọc end-to-end. Không bao giờ tự chứng nhận.
**Người phá** không bao giờ dựng. Mang đúng một câu hỏi:

> Tìm một trường hợp mà **dữ liệu tệ hơn lại được điểm cao hơn**.

Phán quyết **nhị phân**, không cho điểm 0-10 — điểm số luôn trôi lên qua mỗi vòng.

**Thư ký** giữ `_decisions.tsv`, `_contradictions.tsv`, `known_limitations`, và **sổ biên lai**
(ai nợ gì, lệnh nào giao hụt). Vai này sinh ra từ sự cố 3 lệnh giao thất bại im lặng.

**Trực (từ 15 agent)** gác hai tầng mà bảng không nhìn thấy: tầng nguồn (ngôn ngữ, quota, tham số
mặc định của công cụ) và tầng pipeline (kiểu dữ liệu, locale, đối chiếu ngược).

## 4. Luật vận hành

1. **Hợp đồng trước, giao việc sau.** Viết schema đầy đủ trước khi dispatch. Agent gặp nhau ở tên cột,
   không nói chuyện với nhau. Đây là primitive giúp mở rộng — chi phí điều phối không tăng theo số agent.
2. **Hạn ngạch phản chứng.** Mỗi người dựng nộp kèm: một khẳng định đã cố giết mà không giết được,
   và một giả thuyết đã giết chết. Sản phẩm giá trị nhất vòng 1 là việc **bác bỏ** cụm `old money`.
3. **Dừng lại hỏi được thưởng.** pro-1 dừng vì phát hiện transcript là bản dịch máy — nếu nó cứ đo
   thì mọi con số WPM đều hỏng mà validator vẫn xanh. Phải nói rõ trong brief rằng dừng hỏi là hành vi đúng.
4. **Đóng gói theo vòng, không tán gẫu.** Giao → dựng → phá → sửa → cổng. Rò rỉ tỉ lệ với số lượt
   trao đổi, không phải số agent.
5. **Không tin biên lai "đã gửi" — đo được 25% thất bại.** Trong cửa sổ 20 lệnh cuối của phiên:
   14 `answered`, 5 `failed`, 1 `queued`. Quan trọng hơn con số tổng là **phân bố**:

   | agent | gửi | thất bại |
   |---|---|---|
   | search-1 | 8 | 0% |
   | pro-2 | 6 | 0% |
   | pro-1 | 3 | 67% |
   | search-2 | 2 | 100% |
   | search-3 | 1 | 100% |

   Thất bại **dồn theo terminal đích**, không rải đều → không phải nhiễu kênh truyền mà là trạng thái
   của terminal nhận. Hệ quả cho thiết kế: retry nhiều hơn KHÔNG giải quyết được. Phải
   (a) kiểm `link status` sau mỗi đợt, (b) giữ sổ biên lai theo từng agent, (c) khi một agent có
   2 lần thất bại liên tiếp thì coi như nó KHÔNG nhận việc cho tới khi có phản hồi, đừng giả định nó đang chạy.
   Tôi đã hai lần báo sai với người dùng rằng cả đội đang chạy trong khi 3 lệnh đã rơi.
   `delivery-unconfirmed` thì KHÔNG tự retry và KHÔNG được gửi lại nếu chưa hỏi — gửi lại có thể làm
   agent nhận hai lần và làm trùng việc. `delivery-failed` thì gửi lại an toàn.
   Giữ tin dưới ~5KB.
6. **Sửa gốc, không vá danh sách.** Lỗi 5 sinh ra từ danh sách cột cứng; vá bằng cách thêm cột vào
   danh sách sẽ đẻ ra lỗi 7. Thay bằng suy luận kiểu từ chính dữ liệu.

## 5. Ba cổng nghiệm thu

- **A — kiểu dữ liệu**: validator chạy sạch, VÀ đối chiếu ngược nguồn↔đích 0 sai lệch.
- **B — đo được**: đưa workbook cho người context sạch, bắt chọn 5 việc nên làm, mỗi việc chỉ ra
  dòng/cột/giá trị. Đạt khi cả 5 truy ngược được và không phải hỏi thêm.
  *Được phép trượt và nói workbook thiếu gì — báo cáo đó giá trị hơn 5 lựa chọn bịa cho đủ.*
- **C — chuẩn analyst**: đối chiếu workbook dữ liệu công khai của Damodaran (NYU Stern).
  Bắt buộc có: tab định nghĩa biến kèm cột `Why?`, khối provenance, `n` cạnh mọi số tổng hợp.

**Điểm dừng: người phá hết chỗ để nêu.** Không phải "xong N mảnh". Phiên này đã tưởng xong 4 lần.

## 6. Bằng chứng phải nằm trong deliverable

Nếu "workbook" là cái sheet, thì mọi bằng chứng cho một khuyến nghị phải nằm TRÊN SHEET, không phải
trong thư mục làm việc. Giám khảo đã từ chối cho qua cổng vì 4/5 lựa chọn truy về một bảng còn nằm
trong inbox — đúng. Deliverable chạy sau dữ liệu thì phần chạy sau coi như chưa tồn tại.

## 7. Người điều phối không được miễn trừ

Tôi thiết kế gauntlet để agent không tự chấm bài mình, rồi tự miễn trừ chính mình khỏi nó.
Ba lỗi nặng nhất của phiên nằm trong code và lập luận của người điều phối: locale ăn số, 168 dòng
trùng, và "phantom decay". Cả ba do agent bắt, không phải tôi tự thấy.
→ Người phá phải được quyền đọc code của người điều phối, và mọi khẳng định xu hướng của người điều phối
phải qua cổng như của mọi người khác.
