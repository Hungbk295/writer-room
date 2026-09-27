# Hermes × Writer Room: radar tin tức lên Telegram

Tích hợp điều phối mới theo flow Telegram → Hermes (GPT Codex / ChatGPT OAuth)
→ MCP trực tiếp của Writer Room và DNA Spy nằm ở
[`makemoney/hermes/`](../../../hermes/README.md), dùng profile `content-production`.
Luồng mới không sử dụng `hermes-workspace`.

Mỗi sáng Hermes gọi Writer Room Spy MCP để lấy video mới của các kênh tin tức, tóm tắt từ transcript, rồi gửi một bản tin lên Telegram.

Kế hoạch tổng thể (kiến trúc, các phase tiếp theo): [`docs/plans/hermes-orchestrator-plan.md`](../../docs/plans/hermes-orchestrator-plan.md).

Luồng này **độc lập** với Channel Watch (luồng kênh faceless daily). Về sau hai nguồn sẽ được ghép với nhau; dữ liệu radar đã được lưu sẵn cho bước đó.

```
Hermes cron 07:00 (skill news-radar)
   │ 1. mcp_writer_room_spy_news_pull  {channels: ["@TaichinhKinhdoanhTV"]}
   ▼
Writer Room daemon (Spy) ── yt-dlp ──► YouTube
   │   liệt kê tab /videos → video mới chưa gửi → metadata + transcript (vi)
   │   lưu <data>/spy/news-radar/videos/<videoId>.json
   ▼
Hermes (LLM) tóm tắt từng video + đoạn toàn cảnh
   │ 2. mcp_writer_room_spy_news_ack  {items: [{video_id, summary}]}
   ▼
Telegram (home channel)
```

## 1. Writer Room

1. Cài `yt-dlp` trên máy (hoặc dùng bản đóng gói trong app). Daemon gọi `yt-dlp` trong `PATH`, hoặc đường dẫn trong biến `WRITER_ROOM_YTDLP_BIN`.
2. Chạy daemon: mở app, hoặc `bun run daemon` (cổng 4187).
3. Lấy token MCP cố định: đặt `WRITER_ROOM_MCP_TOKEN` trước khi chạy daemon, hoặc đọc `<data>/config/mcp-token.txt` (thư mục dữ liệu mặc định là `writer-room-data/`).

Kiểm tra tool trước khi đụng tới Hermes:

```bash
curl -s -X POST http://127.0.0.1:4187/api/spy/mcp \
  -H "Authorization: Bearer $WRITER_ROOM_MCP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"spy_news_pull","arguments":{"channels":["@TaichinhKinhdoanhTV"],"max_per_channel":1}}}'
```

Kết quả phải có `items[0].title` và `items[0].transcript.text`.

## 2. Hermes

### 2.1 Token và Telegram

`~/.hermes/.env`:

```
WRITER_ROOM_MCP_TOKEN=<token ở bước 1.3>
TELEGRAM_BOT_TOKEN=<token bot từ @BotFather>
TELEGRAM_ALLOWED_USERS=<telegram user id của bạn>
```

Cách nhanh nhất: `hermes gateway setup` (hoặc nút **Create with QR** ở trang Messaging → Telegram trong dashboard), sau đó chạy `hermes gateway`. Mở chat với bot, gõ `/sethome` để cron gửi tin về đúng chat này.

### 2.2 Nối MCP và skill

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  writer_room:
    url: "http://127.0.0.1:4187/api/spy/mcp"
    headers:
      Authorization: "Bearer ${WRITER_ROOM_MCP_TOKEN}"
    # GET trên endpoint này trả JSON discovery, không phải luồng MCP → bỏ bước probe content-type.
    skip_preflight: true
    # Lấy transcript nhiều video có thể mất vài phút.
    timeout: 600
    tools:
      include: [spy_news_pull, spy_news_ack]

skills:
  external_dirs:
    - /đường/dẫn/tới/writer-room/integrations/hermes/skills
```

Tên server `writer_room` quyết định tên tool Hermes thấy: `mcp_writer_room_spy_news_pull` và `mcp_writer_room_spy_news_ack`. Đổi tên server thì phải sửa skill theo.

Khởi động lại Hermes (`hermes gateway restart`) để nhận MCP và skill.

### 2.3 Chạy thử

Trong chat với bot (hoặc `hermes` CLI):

```
/news-radar
```

Bot phải trả về bản tin gồm "Toàn cảnh" và từng video với gạch đầu dòng. Nếu chạy lại ngay, bot sẽ báo "Không có video mới" vì các video đã được ack.

### 2.4 Lên lịch hằng ngày

```bash
hermes cron create "every 1d at 07:00" \
  "Chạy radar tin tức hôm nay và gửi bản tin theo đúng định dạng của skill." \
  --skill news-radar --name "News radar" --deliver telegram

hermes cron run "News radar"     # chạy ở tick kế tiếp để kiểm tra
hermes cron list
```

Nên pin một model đủ mạnh cho job này, vì chất lượng tóm tắt phụ thuộc model: `hermes cron edit "News radar" --provider <provider> --model <model>`.

## Thêm kênh

Sửa mục "Kênh theo dõi" trong `skills/news-radar/SKILL.md` và danh sách `channels` ở bước 1 của skill. Tool nhận `@handle`, `UC…` hoặc URL `youtube.com/@handle`, tối đa 10 kênh mỗi lần gọi.

## Dữ liệu lưu lại

Mỗi video là một file `<data>/spy/news-radar/videos/<videoId>.json`, gồm title, ngày đăng, transcript đầy đủ, thời điểm gửi (`deliveredAt`) và bản tóm tắt Hermes đã gửi. Bước ghép với luồng Channel Watch sau này sẽ đọc từ đây.

## Lỗi thường gặp

| Hiện tượng | Nguyên nhân / cách xử lý |
| --- | --- |
| Job ở trạng thái `blocked_config` | Hermes chưa kết nối được `writer_room`: daemon chưa chạy, sai URL, hoặc thiếu `skip_preflight: true` |
| `401` | Token trong `~/.hermes/.env` khác token daemon đang dùng |
| `skipped` có "liệt kê kênh lỗi … 429" hoặc "Sign in to confirm" | YouTube đang chặn yt-dlp. Chờ rồi chạy lại, hoặc trỏ `WRITER_ROOM_YTDLP_BIN` tới một script bọc `yt-dlp --cookies <file>` |
| Video có `transcript.status: missing` | Video chưa có phụ đề tự động. Nếu video đăng chưa tới 12 giờ, skill không ack nên lần sau sẽ lấy lại và tóm tắt đầy đủ; video cũ hơn thì chỉ gửi tiêu đề |
| Tool báo "hết ngân sách thời gian" | Quá nhiều video trong một lần. Giảm `max_per_channel`; video còn lại sẽ được lấy ở lần sau |
