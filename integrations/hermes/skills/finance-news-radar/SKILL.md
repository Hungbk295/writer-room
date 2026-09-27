---
name: finance-news-radar
description: Bản tin sáng cho kênh Finance-US. Đọc radar sự kiện từ Writer Room Spy (video mới của các kênh finance đang follow), giữ các sự kiện đạt tiêu chí title kiểu 3 và hợp tệp khán giả, ghép với painpoint viewer, rồi gợi ý title cho video tiếp theo. Dùng cho cron hằng ngày hoặc khi người dùng hỏi "tin tài chính hôm nay", "radar sự kiện", "gợi ý title kiểu 3".
version: 0.1.0
metadata:
  hermes:
    tags: [youtube, finance, news, writer-room]
    category: content
---

# Finance news radar (title kiểu 3)

## When to Use

- Cron hằng ngày gửi bản tin lên Telegram.
- Người dùng hỏi tin tài chính đáng làm video, radar sự kiện, hoặc title kiểu 3.

## Nguồn dữ liệu

Chỉ một tool: `mcp_writer_room_spy_news_radar` (server `writer_room`, Writer Room Spy MCP). Tool chỉ đọc dữ liệu Channel Watch đã lưu, không tốn quota.

Gọi với:

```json
{ "insight_profile": "finance-us" }
```

Giữ mặc định: `window_days` 7, `min_videos` 3, `min_channels` 3, `min_vph` 100. Đây đúng là tiêu chí kiểu 3.

Kết quả gồm:
- `clusters[]`: mỗi cụm có `label`, `terms`, `status` (`qualified` đạt tiêu chí, `emerging` mới thấy ở ≥ 2 kênh), `qualifyingChannelCount`, `topVph`, `postBy` (hạn đăng 72 giờ), `evidence[]` (video, kênh, VPH, link).
- `coverage`: số kênh follow, kênh không có video trong cửa sổ, ghi chú.
- `insight.markdown`: tệp khán giả, painpoint (mã N3-1, N3-2, N3-3, N2-1, N2-2, N2-4), quy tắc title kiểu 3 và danh sách "không làm lúc này".

## Quy trình

1. Gọi tool một lần. Nếu lỗi, gửi đúng một dòng: `Radar lỗi: <thông báo lỗi>` rồi dừng. Không tự tìm dữ liệu YouTube bằng nguồn khác.
2. Nếu `coverage.followedChannels` = 0 hoặc `videosInWindow` = 0, gửi cảnh báo ngắn kèm `coverage.notes` rồi dừng.
3. Với mỗi cụm `qualified`, đọc `insight.markdown` và quyết định **giữ** hay **bỏ**:
   - Bỏ nếu lệch tệp (khán giả 60+, người giàu, trader, vĩ mô thuần không dịch được ra tiền của hộ $45k–$90k), hoặc nằm trong mục "Không làm lúc này".
   - Bỏ nếu cụm là trùng hợp từ ngữ, không phải một sự kiện (các video nói về chuyện khác nhau). Đọc title trong `evidence` để kiểm tra.
4. Với mỗi cụm được giữ (tối đa 3, ưu tiên `qualifyingChannelCount` rồi `topVph`):
   - Viết 1 câu: sự kiện là gì, chỉ dựa trên title trong `evidence`.
   - Nếu có tool tìm kiếm web, tìm **một** nguồn tin uy tín (Reuters, AP, CNBC, WSJ, Bloomberg, trang chính phủ) xác nhận sự kiện và đính link. Không tìm được thì ghi `chưa xác minh bằng nguồn tin`.
   - Chọn 1–2 painpoint khớp nhất và ghi mã.
   - Viết 2 title tiếng Anh theo quy tắc trong insight: một con số cụ thể, dịch sự kiện ra tiền của một hộ bình thường, hứa phép tính thật ("The Real Math", "What It Costs a $70K Household"), trung lập chính trị. Nếu hợp, ghép với một khuôn bền như "(By Salary)".
   - Ghi hạn đăng từ `postBy`, theo giờ Việt Nam.
   - Liệt kê 3 video bằng chứng: kênh · VPH · link.
5. Các cụm `emerging`: một dòng mỗi cụm (nhãn, số kênh, VPH cao nhất) trong mục "Theo dõi". Tối đa 5.
6. Các cụm `qualified` bị bỏ ở bước 3: một dòng mỗi cụm kèm lý do trong mục "Bỏ qua".

## Quy tắc dữ kiện

- Mọi số VPH, số kênh, số video, ngày giờ lấy nguyên từ output của tool. Không làm tròn thành số khác, không tự thêm số liệu.
- Con số trong title (vd $70K) là hồ sơ hộ gia đình ví dụ, không phải dữ kiện. Không đưa số liệu kinh tế (lãi suất, giá xăng…) vào title nếu không có trong title bằng chứng hoặc trong nguồn tin đã mở.
- VPH là VPH trọn đời (view ÷ số giờ từ lúc đăng tới lần quan sát). Khi nhắc thì ghi đúng như vậy.
- Nếu không có cụm nào được giữ, nói thẳng "Hôm nay không có sự kiện kiểu 3 hợp tệp" và chỉ gửi mục "Theo dõi".

## Định dạng tin Telegram

Tiếng Việt cho phần phân tích, tiếng Anh cho title. Dưới 3.500 ký tự. Không dùng bảng.

```
📰 Radar tài chính · <ngày> · <N> kênh follow, <M> video 7 ngày

1) <nhãn sự kiện> — <số kênh> kênh · VPH cao nhất <topVph> · hạn đăng <giờ VN>
<1 câu sự kiện>. Nguồn: <link hoặc "chưa xác minh bằng nguồn tin">
Painpoint: <mã> <tên>
• <Title 1>
• <Title 2>
Bằng chứng: <kênh> · <VPH> VPH · <link> | …

Theo dõi: <nhãn> (<số kênh> kênh, <VPH>) · …
Bỏ qua: <nhãn> — <lý do> · …
```
