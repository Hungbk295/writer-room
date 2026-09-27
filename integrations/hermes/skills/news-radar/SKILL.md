---
name: news-radar
description: Radar tin tức hằng ngày. Lấy các video mới nhất của kênh báo chí/tin tức tài chính qua Writer Room Spy, tóm tắt từng video từ transcript và viết một đoạn toàn cảnh thị trường để gửi lên Telegram. Dùng cho cron buổi sáng hoặc khi người dùng hỏi "tin tức hôm nay", "radar tin", "tóm tắt tin tài chính".
version: 0.1.0
metadata:
  hermes:
    tags: [youtube, news, finance, writer-room]
    category: research
---

# News radar

## When to Use

- Cron hằng ngày gửi bản tin lên Telegram.
- Người dùng hỏi tin tức tài chính mới, radar tin, hoặc muốn tóm tắt video mới của kênh tin tức.

## Kênh theo dõi

- `@TaichinhKinhdoanhTV`

Muốn thêm kênh, thêm dòng vào danh sách này (tối đa 10 kênh).

## Quy trình

1. Gọi `mcp_writer_room_spy_news_pull` một lần với mọi kênh trong danh sách:

   ```json
   { "channels": ["@TaichinhKinhdoanhTV"] }
   ```

   Mặc định tool lấy tối đa 5 video mỗi kênh, đăng trong 36 giờ qua, và bỏ qua video đã gửi ở lần trước. Tool có thể chạy vài phút, cứ chờ.
2. Nếu tool lỗi: trả đúng một dòng `Radar tin lỗi: <thông báo>` rồi dừng. Không tự lấy tin từ nguồn khác.
3. Nếu `items` rỗng: trả một dòng `Không có video mới từ <kênh> trong <sinceHours> giờ qua.`, kèm `skipped[].reason` nếu có, rồi dừng. Không gọi ack.
4. Với mỗi item, đọc `transcript.text` và viết:
   - 2–4 gạch đầu dòng dữ kiện chính: con số, tổ chức, mốc thời gian, quyết định. Chỉ lấy từ transcript.
   - Một dòng "Điểm chính": video muốn người xem hiểu điều gì.
   - Nếu `transcript.status` khác `ok`: ghi `(không có transcript, chỉ có tiêu đề)` và không viết gạch đầu dòng nào ngoài tiêu đề.
   - Nếu `transcript.truncated` là `true`: thêm `(tóm tắt từ phần đầu)`.
5. Viết đoạn "Toàn cảnh" 2–3 câu ở đầu tin: gom các chủ đề chung (vàng, chứng khoán, lãi suất, tỷ giá, bất động sản…) và chiều hướng mà các video nói tới. Chỉ dựa trên các item vừa tóm tắt.
6. Gọi `mcp_writer_room_spy_news_ack` cho **mọi** item đã đưa vào tin, kèm phần tóm tắt đã viết:

   ```json
   { "items": [ { "video_id": "<videoId>", "summary": "<các gạch đầu dòng + điểm chính>" } ] }
   ```

   Phải ack trước khi trả lời. Nếu không ack, lần chạy sau sẽ gửi lại các video này.
   Ngoại lệ: video `transcript.status` khác `ok` **và** đăng chưa tới 12 giờ thì không ack. Phụ đề tự động thường có sau vài giờ, nên lần sau video sẽ được lấy lại và tóm tắt đầy đủ.
7. Câu trả lời cuối cùng chính là tin Telegram, theo định dạng bên dưới.

## Quy tắc dữ kiện

- Transcript là phụ đề tự động (`transcript.source` = `auto`), nên có thể nghe sai số và tên riêng. Nếu một con số hoặc tên nghe vô lý, bỏ đi hoặc ghi `(nghe không rõ)`. Không tự sửa theo trí nhớ.
- Không thêm dữ kiện, bình luận hay dự báo không có trong transcript.
- Giờ đăng: đổi `publishedAt` sang giờ Việt Nam (UTC+7).

## Định dạng tin Telegram

Tiếng Việt, dưới 3.500 ký tự. Nếu dài hơn, rút gạch đầu dòng của các video cuối.

```
📺 Radar tin tức · <dd/mm> · <số> video mới

Toàn cảnh: <2–3 câu>

1) <Tiêu đề> · <hh:mm dd/mm>
• <dữ kiện>
• <dữ kiện>
→ Điểm chính: <1 câu>
<url>

2) …
```
