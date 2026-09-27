# Hermes × Writer Room: bản tin radar tài chính lên Telegram

Hermes gọi Writer Room Spy MCP (`spy_news_radar`) mỗi sáng. Tool này gom video mới của các kênh finance đang follow thành cụm sự kiện và đánh dấu cụm đạt tiêu chí title kiểu 3. Hermes ghép kết quả với painpoint viewer, gợi ý title, rồi gửi bản tin lên Telegram.

```
Channel Watch (daemon, mỗi ngày)  →  video_stat_points trong spy.sqlite
                                          │
Hermes cron 07:30 ── MCP HTTP ──→  spy_news_radar (0 quota, chỉ đọc)
       │                                  + insight/finance-us.md
       └─ skill finance-news-radar → viết bản tin → Telegram
```

## 1. Writer Room

1. Chạy daemon: mở app, hoặc `bun run daemon` (cổng mặc định 4187).
2. Bật Channel Watch và follow các kênh finance với nhịp `daily`: trong app, hoặc `PUT /api/settings/channel-watch` với `{"enabled": true, "dailyHourLocal": "05:00", "timezone": "Asia/Ho_Chi_Minh"}`.
   Radar chỉ thấy video mà Channel Watch đã thu, nên Channel Watch phải xong **trước** cron của Hermes. Scheduler kiểm tra mỗi giờ một lần và thu tuần tự từng kênh (mỗi kênh tối đa 8 phút), nên hãy chừa khoảng 2 giờ: thu lúc 05:00, gửi bản tin lúc 07:30. Video kênh Mỹ thường đăng vào đêm giờ Việt Nam, nên buổi sáng là lúc dữ liệu mới nhất.
   Muốn radar thấy tin tức rộng hơn thì follow thêm vài kênh tin (CNBC, WSJ, Bloomberg…) ngoài các kênh đối thủ.
3. Kiểm tra file insight: `writer-room-data/insight/finance-us.md` (nằm trong thư mục dữ liệu `WRITER_ROOM_DATA_DIR` nếu bạn đổi thư mục dữ liệu).
4. Lấy token MCP cố định: đặt biến môi trường `WRITER_ROOM_MCP_TOKEN` trước khi chạy daemon, hoặc đọc file `<data>/config/mcp-token.txt`.

Kiểm tra nhanh:

```bash
curl -s -X POST http://127.0.0.1:4187/api/spy/mcp \
  -H "Authorization: Bearer $WRITER_ROOM_MCP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"spy_news_radar","arguments":{"insight_profile":"finance-us"}}}'
```

## 2. Hermes

`~/.hermes/.env`:

```
WRITER_ROOM_MCP_TOKEN=<token ở bước 1.4>
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USERS=<telegram user id của bạn>
```

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  writer_room:
    url: "http://127.0.0.1:4187/api/spy/mcp"
    headers:
      Authorization: "Bearer ${WRITER_ROOM_MCP_TOKEN}"
    # GET trên endpoint này trả JSON discovery, không phải luồng MCP → bỏ probe content-type.
    skip_preflight: true
    timeout: 120
    tools:
      include: [spy_news_radar]

skills:
  external_dirs:
    - /đường/dẫn/tới/writer-room/integrations/hermes/skills
```

Telegram: chạy `hermes gateway setup` (hoặc nút **Create with QR** trong dashboard), rồi `hermes gateway`. Gõ `/sethome` trong chat với bot để cron gửi về đó.

## 3. Chạy thử và lên lịch

Thử tay trong chat với Hermes (CLI hoặc Telegram):

```
/finance-news-radar
```

Tạo cron:

```bash
hermes cron create "every 1d at 07:30" \
  "Chạy radar tin tài chính hôm nay và gửi bản tin theo đúng định dạng của skill." \
  --skill finance-news-radar --name "Finance news radar" --deliver telegram
hermes cron run "Finance news radar"   # chạy ngay ở tick kế tiếp để kiểm tra
```

Nên pin model đủ mạnh cho job này (`hermes cron edit "Finance news radar" --provider … --model …`), vì chất lượng title phụ thuộc model.

## Lỗi thường gặp

| Hiện tượng | Nguyên nhân |
| --- | --- |
| Job ở trạng thái `blocked_config` | Hermes chưa kết nối được `writer_room`: daemon chưa chạy, sai URL, hoặc thiếu `skip_preflight: true` |
| `401` | Token trong `~/.hermes/.env` khác token daemon đang dùng |
| Radar rỗng, ghi chú "Chưa follow kênh nào" | Chưa follow kênh trong public watchlist |
| Nhiều kênh "không có video trong cửa sổ" | Channel Watch chưa bật, hoặc chạy sau giờ cron |
| `insight_profile_not_found` | Thiếu `insight/finance-us.md` trong thư mục dữ liệu |
