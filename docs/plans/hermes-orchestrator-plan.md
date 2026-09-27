# Plan: Hermes điều phối Writer Room và DNA Spy

Trạng thái 27/9/2026: **Phase 0 (radar tin tức → Telegram) đã có code**, đang chờ chạy thử trên máy thật. Phase 1–4 chưa bắt đầu.

Tài liệu liên quan:
- Cài đặt Hermes và chạy radar: [`integrations/hermes/README.md`](../../integrations/hermes/README.md)
- Skill radar: [`integrations/hermes/skills/news-radar/SKILL.md`](../../integrations/hermes/skills/news-radar/SKILL.md)
- Danh sách MCP của Writer Room: [`docs/mcp-inventory.md`](../mcp-inventory.md)

## 1. Mục tiêu

Một người vận hành hai app, và giao tiếp chủ yếu qua Telegram (sau này thêm một dashboard gộp):

1. Mỗi sáng nhận bản tin: tin tức thị trường, đề tài đáng làm, việc đang chờ duyệt.
2. Chọn đề tài → Writer Room viết kịch bản → duyệt.
3. Chuyển kịch bản sang DNA Spy → cook video → xem kết quả trên giao diện DNA Spy → duyệt hoặc yêu cầu sửa.

Hermes ([NousResearch Hermes Agent](https://github.com/NousResearch/hermes-agent)) là agent điều phối. Nó lo lịch cron, Telegram, bộ nhớ job và các điểm cần hỏi người dùng. Nó **không** tự quyết thay người dùng và không có logic pipeline riêng.

## 2. Kiến trúc

```
   Người dùng ── Telegram / dashboard
                     │
             ┌───────▼────────┐  cron, sổ job, hỏi người dùng ở điểm duyệt
             │     HERMES     │  (chạy trên CÙNG máy với 2 app)
             └──┬──────────┬──┘
    (A) MCP HTTP│          │(A) MCP stdio
                │          │
 ┌──────────────▼──┐   ┌───▼─────────────────┐
 │ Writer Room     │   │ DNA Spy             │  ← nơi chấm, nơi giữ trạng thái
 │ daemon :4187    │   │ hermes/server.ts    │
 └──────┬──────────┘   └───┬─────────────────┘
        │ tự spawn          │ tự spawn
 ┌──────▼──────────┐   ┌───▼─────────────────┐
 │ Claude Code     │   │ Claude Code         │  ← thợ làm, mỗi stage một phiên
 └─────────────────┘   └─────────────────────┘

 (B) Việc ngoài pipeline: Hermes → `claude -p` trong thư mục repo
```

### Nguyên tắc

- **Hermes nói chuyện với MCP của app, không nói chuyện với Claude Code.** App tự spawn Claude Code cho từng stage và vẫn là nơi chấm: gate, sandbox, giới hạn số lần gọi model, cắt turn 45 phút ở Writer Room; cook store ở DNA Spy.
- **Kênh A: MCP, kênh chính.**
  - Writer Room có Writer MCP (`/api/writer/mcp`), Spy MCP (`/api/spy/mcp`) và General Pack MCP. Cả ba chạy trên cổng cố định 4187, dùng chung một token bền (`WRITER_ROOM_MCP_TOKEN` hoặc `<data>/config/mcp-token.txt`).
  - Hermes nối thẳng qua `url` + `headers`, không cần bridge. Cấu hình phải có `skip_preflight: true`, vì GET trên các endpoint này trả JSON discovery.
- **Kênh B: `claude -p` headless** trong thư mục repo, cho việc không có trong MCP (restyle, board-enhance, research tự do).
  - Claude Code tự nạp `CLAUDE.md`, skill và phần permissions của repo.
  - Lưu `session_id` để `--resume` khi hỏi tiếp.
  - Không dùng kênh B cho pipeline, vì làm vậy sẽ vượt qua phần chấm của app.
- **`claude mcp serve` không hợp:** nó chỉ expose tool của Claude Code (Read/Edit/Bash), không expose vòng lặp agent.
- **Hermes chỉ lưu sổ job** `(jobId, writer runId, cook projectId, trạng thái, đang chờ ai)`. Mọi trạng thái chi tiết đọc lại từ app.
- **Chạy cùng máy.** Mọi MCP đều nghe ở `127.0.0.1`, nên Hermes phải chạy trên máy có 2 app. Telegram là đường điều khiển từ xa, không cần mở cổng ra ngoài.
- **Không bao giờ ghi thẳng vào DB của DNA Spy** (`data/dna-spy.sqlite`), theo quy tắc trong `AGENTS.md` của repo đó. Mọi thay đổi phải đi qua code store của app.

### Hai nguồn dữ liệu đề tài (độc lập, sẽ ghép ở Phase 3)

| Nguồn | Mục đích | Cơ chế | Trạng thái |
| --- | --- | --- | --- |
| **Channel Watch** | Theo dõi các kênh faceless (đối thủ) mỗi ngày: video mới + VPH | `ChannelWatchScheduler` trong daemon, config `config/channel-intelligence.json` | Đã có sẵn |
| **Radar tin tức** | Đọc các kênh báo chí/tin tức mỗi ngày để có cái nhìn tổng quan thị trường | `spy_news_pull` / `spy_news_ack` + skill Hermes `news-radar` | Phase 0, vừa xong |

## 3. Phase 0: Radar tin tức → Telegram (đã có code)

### Việc radar làm

Mỗi sáng lấy video mới nhất của kênh tin tức (hiện chỉ có [`@TaichinhKinhdoanhTV`](https://www.youtube.com/@TaichinhKinhdoanhTV/videos)), đọc transcript, tóm tắt từng video kèm một đoạn toàn cảnh, rồi gửi lên Telegram.

```
Hermes cron 07:00 (skill news-radar)
   │ 1. mcp_writer_room_spy_news_pull {channels: ["@TaichinhKinhdoanhTV"]}
   ▼
Writer Room daemon (Spy) ── yt-dlp ──► YouTube
   │   tab /videos (mới nhất trước) → bỏ video đã gửi → metadata + transcript
   │   lưu <data>/spy/news-radar/videos/<videoId>.json
   ▼
Hermes (LLM) tóm tắt từng video + đoạn "Toàn cảnh"
   │ 2. mcp_writer_room_spy_news_ack {items: [{video_id, summary}]}
   ▼
Telegram (home channel)
```

### Logic `spy_news_pull` (`packages/spy/src/news-radar.ts`)

1. Chuẩn hoá từng kênh (`@handle`, `UC…` hoặc URL `youtube.com/@handle`) thành URL tab `/videos`, do code tự dựng.
   - Input của caller không bao giờ tới yt-dlp nguyên văn. Chuỗi kiểu `--exec=…` bị từ chối.
2. `yt-dlp --flat-playlist` lấy `max_per_channel × 3` video mới nhất (danh sách mới nhất trước).
3. Duyệt từng video:
   - Video đã ack thì bỏ qua (trừ khi `include_delivered`).
   - Inspect để lấy giờ đăng. Gặp video cũ hơn `since_hours` thì dừng, vì các video sau còn cũ hơn.
   - Lấy transcript: ưu tiên tiếng Việt, phụ đề thủ công trước, phụ đề tự động sau, có đường fallback. Các dòng phụ đề lặp liên tiếp được gộp.
   - Ghi file `<data>/spy/news-radar/videos/<videoId>.json` với transcript đầy đủ. Kết quả trả về cắt ở `max_transcript_chars`.
4. Lỗi của một kênh hoặc một video được ghi vào `skipped[]`, không làm hỏng cả lần chạy.
5. Toàn bộ lần gọi có ngân sách 240 giây. Video chưa kịp lấy sẽ được lấy ở lần sau.

Mặc định: `max_per_channel` 5, `since_hours` 36, `max_transcript_chars` 12.000. Scope `spy.start` (gọi yt-dlp), không tốn quota Data API.

### Logic `spy_news_ack`

- Ghi `deliveredAt` và bản tóm tắt vào file của từng video. Video đã ack không bị pull lại.
- Giao hàng theo kiểu **at-least-once**: nếu Hermes chết trước bước ack, lần sau video được gửi lại chứ không mất.
- Skill không ack video chưa có transcript mà đăng chưa tới 12 giờ, để lần sau tóm tắt đầy đủ.

### Skill `news-radar` (Hermes)

- Gọi pull một lần. Lỗi thì báo một dòng rồi dừng. Không có video mới thì báo một dòng và không ack.
- Mỗi video: 2–4 gạch đầu dòng dữ kiện, một dòng "Điểm chính" và link. Đầu tin có đoạn "Toàn cảnh" 2–3 câu.
- Chỉ dùng dữ kiện có trong transcript. Phụ đề tự động có thể nghe sai số và tên, nên chỗ nào vô lý thì bỏ hoặc ghi "(nghe không rõ)".
- Ack mọi item đã đưa vào tin, sau đó trả lời. Câu trả lời chính là tin Telegram, dưới 3.500 ký tự.

### Đã kiểm tra

- 8 test mới trong `packages/spy/test/news-radar.test.ts`: chuẩn hoá URL, chặn cờ yt-dlp, gộp dòng phụ đề, cửa sổ thời gian, giới hạn số video, cắt transcript, ack và không pull lại, lỗi theo kênh, scope và validate của tool MCP.
- Toàn bộ 862 test pass, typecheck sạch.
- Đã chạy daemon thật và gọi `tools/list` / `tools/call` qua `http://127.0.0.1:<port>/api/spy/mcp`.
- **Chưa kiểm tra:** YouTube thật (container dev bị chặn mạng tới YouTube), Hermes và Telegram. Cần chạy lần đầu theo checklist bên dưới.

### Checklist chạy lần đầu trên máy local

Chi tiết lệnh và YAML ở [`integrations/hermes/README.md`](../../integrations/hermes/README.md).

- [ ] Merge nhánh, pull về, chạy `bun install`.
- [ ] Máy có `yt-dlp` (hoặc đặt `WRITER_ROOM_YTDLP_BIN`). Chạy daemon (`bun run daemon` hoặc mở app).
- [ ] Lấy token ở `writer-room-data/config/mcp-token.txt`. Chạy lệnh `curl` trong README, kết quả phải có `items[0].transcript.text`.
- [ ] `~/.hermes/.env`: `WRITER_ROOM_MCP_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`.
- [ ] `~/.hermes/config.yaml`:
  - Server `writer_room` với `url`, header `Authorization`, `skip_preflight: true`, `timeout: 600`, `tools.include: [spy_news_pull, spy_news_ack]`.
  - `skills.external_dirs` trỏ tới `integrations/hermes/skills`.
- [ ] `hermes gateway setup` → `hermes gateway restart` → gõ `/sethome` trong chat với bot.
- [ ] Gõ `/news-radar` trong chat. Chạy lại ngay thì bot phải báo "Không có video mới", tức là ack đã hoạt động.
- [ ] `hermes cron create "every 1d at 07:00" "…" --skill news-radar --name "News radar" --deliver telegram`, rồi `hermes cron run "News radar"`.
- [ ] Pin model cho job: `hermes cron edit "News radar" --provider … --model …`.

### Câu hỏi còn mở của Phase 0

- Kênh đăng nhiều video mỗi ngày. Mặc định lấy 5 video mới nhất mỗi lần; cần chốt là 1 video, 5 video hay toàn bộ video trong ngày.
- Nếu YouTube chặn yt-dlp (429 / "Sign in to confirm"): hiện chỉ có cách trỏ `WRITER_ROOM_YTDLP_BIN` tới script bọc `yt-dlp --cookies <file>`. `YtDlpAdapter` có nhận `cookieFile` nhưng daemon chưa nối cấu hình vào.
- Thêm kênh tin tức nào tiếp theo.

## 4. Roadmap

Mỗi phase phải test được cả hệ thống ngay khi xong: Phase 1 nối thông một bài từ đầu tới cuối, bước nào chưa tự động thì bấm tay trong app. Các phase sau thay dần bước tay bằng tự động hoá.

### Phase 1: Nối thông một bài Writer Room → DNA Spy

**Mục tiêu:** từ Telegram ra lệnh viết một bài, chọn hook, nhận script, rồi chuyển sang DNA Spy thành cook project. Board, ảnh, TTS và render vẫn bấm tay trong app.

| # | Việc | Repo |
| --- | --- | --- |
| W1 | ~~Bridge stdio cho Writer MCP~~: **không cần nữa.** Writer MCP đã có cổng cố định `/api/writer/mcp` và dùng chung token với Spy MCP (`packages/daemon/src/http.ts`). Chỉ cần thêm server `writer` vào `~/.hermes/config.yaml` | — |
| W2 | Skill Hermes `writer-room`: `writer_post_create(substrate:'terminal')` → `writer_hook_clarify` → gửi câu hỏi lên Telegram → `writer_hook_answer` → gửi hook lên Telegram → `writer_hook_select` → `writer_run_start` → `writer_wait(until:'terminal')` → `writer_get_script`. Dùng `substrate:'terminal'` để daemon tự spawn Claude Code cho từng stage. Không dùng `external`, vì chế độ đó bắt Hermes tự mở agent từng stage | writer-room (`integrations/hermes/skills/`) |
| D1 | Control bridge trong sidecar DNA Spy: HTTP `127.0.0.1` cổng ngẫu nhiên, bearer token, ghi `data/_control.json` lúc khởi động và xoá lúc tắt, chỉ cho gọi `cook.list`, `cook.get`, `cook.create`, `cook.saveScript` | DNASPY `sidecar/` |
| D2 | Tool hermes `cook_create_from_script(title, script, myDnaId\|channelId, lens?)`: tách câu (`ttsText = text`) → `cook.create` + `cook.saveScript` qua bridge. Project nằm ở stage `board`. App chưa mở thì báo lỗi, không ghi DB | DNASPY `hermes/` |
| D3 | Bỏ đường dẫn cứng `/Users/jc/.local/bin/claude` (`hermes/server.ts`), lấy từ `CLAUDE_BIN` hoặc `PATH` | DNASPY `hermes/` |
| H1 | Sổ job (`jobs.json`) và lệnh Telegram `/viet`, `/jobs`, `/chuyen` | phía Hermes |

Lý do cần control bridge (D1): stage images/tts/render chỉ chạy được trong sidecar của app đang mở, qua `cook.run` → `CookJobManager` (`sidecar/src/cookjob.ts`). Sidecar chỉ nhận lệnh từ Tauri qua stdin. Server hermes lại là tiến trình riêng nên không gọi vào được. Chạy job trong app thì tiến độ hiện ngay trên giao diện DNA Spy.

Với DNASPY, D1 + D2 phải đi lane **high-risk** của harness (hệ thống ngoài, thêm hợp đồng giao tiếp, loopback/token): cần story folder và decision record trước khi code.

**Test nghiệm thu:**
1. `/viet <title>` → nhận câu hỏi làm rõ → trả lời → nhận hook → chọn → nhận thông báo DONE kèm đoạn mở đầu script.
2. `/chuyen <job>` → trong DNA Spy xuất hiện cook project ở stage board, số câu khớp với script.
3. Restart daemon Writer Room giữa chừng → Hermes kết nối lại (token bền) và báo đúng trạng thái.
4. Tắt DNA Spy → `/chuyen` báo lỗi rõ ràng, DB không bị đụng tới.
5. Unit test: bridge từ chối request thiếu token hoặc gọi lệnh ngoài danh sách; bộ tách câu xử lý đúng số, viết tắt, xuống dòng.

### Phase 2: DNA Spy tự cook, người dùng chỉ duyệt video

| # | Việc |
| --- | --- |
| D4 | Mở thêm cho bridge: `cook.prepare` và `cook.importStage` (makeup, board), `cook.lint`, `cook.run` (images, tts, render), `cook.cancel` |
| D5 | `cook_start(projectId, opts)`: makeup → board (Claude Code chạy trong workspace do `cook.prepare` tạo) → `cook.importStage` → lint → images và tts song song → render. `cook_report(projectId)`: đường dẫn video, số frame ok/lỗi, thời lượng |
| D6 | Viết lại `prepare_workspace` / `import_results` của hermes để gọi lệnh của app qua bridge. Hiện chúng là bản viết riêng, lệch với `cook.prepare` (thiếu lens, frameRange, hostMode). Board import đã an toàn vì mọi đường ghi đều qua `saveBoard()` → `normalizeBoardScenes` |
| H2 | Render xong thì Hermes nhắn Telegram → người dùng xem trên DNA Spy → trả lời `ok`, `làm lại ảnh frame N` hoặc `huỷ` |

**Test:**
- Chạy trọn một project 1 phút.
- Huỷ giữa stage images thì job dừng sạch.
- Sau khi import board, `frameIdx` và `imageStatus` vẫn nguyên.
- Frame lỗi hiện đúng trong báo cáo.

### Phase 3: Ghép nguồn đề tài, research và analyst

| # | Luồng | Cách chạy |
| --- | --- | --- |
| R1 | **Ghép radar tin tức + Channel Watch → gợi ý title** | Tin tức cho biết sự kiện gì đang diễn ra. Channel Watch cho biết kênh faceless nào đang làm và VPH ra sao. Ghép hai nguồn với insight viewer (painpoint) để gợi ý title kiểu 3 (bám sự kiện). Có thể dùng lại bản prototype ở commit `ef660f2` (`buildNewsRadar`: gom cụm theo từ khoá title, tiêu chí ≥ 3 video từ ≥ 3 kênh trong 7 ngày, VPH ≥ 100; file `writer-room-data/insight/finance-us.md`). Bản đó đã bị gỡ khỏi luồng radar vì lẫn hai nguồn |
| R2 | **Research sâu theo yêu cầu** (`/research <keyword>`) | Kênh B: `claude -p` trong repo writer-room với skill `niche-market-map` → file trong `writer-room-data/research/` → Hermes gửi tóm tắt |
| A1 | **Analyst phản biện đề tài/brief** (`/phanbien <title>`) | Thêm tool `writer_brief_analyze(postId)` chạy trong daemon, dùng agent role `analyst` có sẵn (Grok, `packages/daemon/src/agents/defaults.ts`). Cần kiểm tra trước agent này đang được gọi từ đâu |
| B1 | Tool chung `ask_repo_agent(repo, prompt, sessionId?)` | Chỉ chạy được trong 2 repo này, có `--resume` |

**Test:**
- Bản tin sáng có ít nhất một đề tài, mỗi đề tài ghi rõ lệnh Spy / run ID tạo ra nó (đúng tiêu chí trong `AGENTS.md`).
- `/research` tạo ra file.
- `/phanbien` trả kết luận có lý do.

### Phase 4: Dashboard gộp và gia cố

- **Dashboard local:** Hermes phục vụ một trang trên máy (vì app chỉ nghe loopback), gồm bảng job (tiêu đề, phase Writer, stage cook, đang chờ ai) và link sang giao diện từng app.
- **Gia cố:**
  - Mỗi client một token riêng cho control bridge.
  - Gắn danh tính agent cho Team MCP (P1-3 trong `mcp-inventory.md`).
  - Retry có backoff.
  - Thời gian và chi phí cho từng job.
  - Nối cấu hình cookies yt-dlp vào daemon.

## 5. Rủi ro

| Rủi ro | Ảnh hưởng | Cách giảm |
| --- | --- | --- |
| YouTube chặn yt-dlp | Radar và Channel Watch không có dữ liệu | Lỗi hiện trong `skipped`; thêm cookies (Phase 4); giữ số video mỗi lần thấp |
| Phụ đề tự động nghe sai số/tên | Bản tin sai dữ kiện | Skill bắt bỏ hoặc đánh dấu chỗ vô lý, không tự sửa; transcript đầy đủ được lưu để đối chiếu |
| Hermes dùng model yếu cho cron | Tóm tắt và title kém | Pin model cho từng job |
| Hermes giữ trạng thái lệch với app | Báo sai tiến độ | Hermes chỉ giữ sổ job; mọi trạng thái đọc lại từ app |
| Ghi thẳng DB DNA Spy | Hỏng board (đã xảy ra với project #87) | Mọi thay đổi đi qua control bridge và code store của app |
