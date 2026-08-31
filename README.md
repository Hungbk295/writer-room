# Writer Room

Workspace local: **Spy** kênh YouTube (transcript, velocity, Source Pack),
**Writer** light (staging pack), **Settings**. App desktop qua **Tauri**; CLI Spy độc lập.

## Yêu cầu

- [Bun](https://bun.sh)
- `yt-dlp`
- (Tuỳ chọn) YouTube Data API key — Settings trong app hoặc `config/spy.json.example`
- Tauri / Rust toolchain nếu build app macOS

## Cấu trúc

```
packages/spy/      # domain + CLI
packages/daemon/   # HTTP local (API + serve UI)
packages/web/      # UI Preact (webview Tauri)
src-tauri/         # shell desktop
```

## CLI (không cần UI)

```bash
bun install

# Channel → top video + transcript
bun run spy channel 'https://www.youtube.com/@handle' \
  --top 5 --scan 60 --pack \
  --out writer-room-data/exports/source-pack.md

# Source Pack từ spy-run đã có
bun run spy source-pack <spy-run-id> --limit 5 --out pack.md
```

| Env | Ý nghĩa |
|-----|---------|
| `WRITER_ROOM_DATA_DIR` | Thư mục data (mặc định `./writer-room-data`) |
| `WRITER_ROOM_PORT` | Port daemon (mặc định `4187`) |
| `WRITER_ROOM_SPY_ENABLED` | `0` = tắt Spy |

Config: Settings trong UI, hoặc copy `config/spy.json.example` → `writer-room-data/config/spy.json`.

## Writer Spy MCP — tìm video global

Hermes/agent có thể gọi tool `spy_global_video_search` trên Writer Spy MCP:

```json
{
  "query": "tài chính cá nhân cho người mới",
  "limit": 20,
  "language": "vi",
  "region": "VN"
}
```

`query` bắt buộc; `limit` mặc định 20 và nằm trong 1..50. `language`/`region`
mặc định `vi`/`VN`. Tool ưu tiên YouTube Data API khi key đã cấu hình; nếu thiếu
key hoặc provider không khả dụng, nó dùng yt-dlp. Response luôn có `providerUsed`
(`youtube_data_api` hoặc `ytdlp`) và `fallbackReason` (`null` khi không fallback).
`localeHintsApplied=true` chỉ có nghĩa Data API đã nhận relevance hints; đây không
phải cam kết mọi kết quả đều cùng ngôn ngữ. Khi dùng yt-dlp, field này là `false`
và `language`/`region` chỉ ghi lại locale người gọi yêu cầu.
Tool dùng scope `spy.start`, không trả API key. Endpoint/token local để kết nối MCP
được đọc từ `GET /api/spy/mcp`.

Luồng Source Pack hiện có vẫn luôn dùng yt-dlp và không đi qua tool global này.

## App desktop (Tauri)

```bash
bun install
bun run ui:build          # build UI → packages/web/dist
bun run app:macos         # Tauri dev — spawn daemon + mở cửa sổ
```

### Bản cài đặt để share (macOS / Windows)

`bun run app:build` tạo installer cho **OS/CPU đang build**. Bản phát hành có
daemon và UI riêng, không yêu cầu người nhận cài Bun hoặc có source code. Mỗi
máy tạo data rỗng trong thư mục ứng dụng của user; không đưa
`writer-room-data/`, evidence, transcript, SQLite hay `spy.json` vào bản cài.

Trước khi build, đặt binary `yt-dlp` chính thức đúng target vào một trong các
đường dẫn sau (xem thêm `vendor/yt-dlp/README.md`):

```text
vendor/yt-dlp/darwin-arm64/yt-dlp
vendor/yt-dlp/darwin-x64/yt-dlp
vendor/yt-dlp/win32-x64/yt-dlp.exe
```

Build trên macOS để phát hành `.dmg`; build trên Windows hoặc Windows CI để
phát hành `.msi`/NSIS `.exe`. Không cross-compile một installer production giữa
hai hệ điều hành. Khi mở lần đầu, người dùng nhập API key trong Settings; Spy
MCP sẽ dùng daemon localhost và token riêng của máy đó.

Luồng: shell Tauri đảm bảo daemon đang chạy, rồi load `http://127.0.0.1:4187`.
Đóng cửa sổ **không** kill daemon (để job harvest tiếp tục).

Chỉ engine (không cửa sổ):

```bash
bun run ui:build && bun run daemon
# health: curl -s http://127.0.0.1:4187/api/health
```

## UI trong app

| Màn | Việc |
|-----|------|
| **Home** | Landing + shortcut |
| **Spy channel** | Dán URL kênh → harvest → danh sách run |
| **Spy run** | Thumb + transcript, multi-select, Source Pack / Writer |
| **Writer** | Staging Source Pack — xem / copy / tải `.md` |
| **Settings** | YouTube API key, concurrency, paths |

Depth harvest: `metadata` \| `transcript` (đã bỏ deep video / frame extract).

## Scripts

| Script | Mô tả |
|--------|--------|
| `bun run spy` | CLI Spy |
| `bun run daemon` | HTTP engine local |
| `bun run ui:build` | Build UI cho daemon/Tauri |
| `bun run app:macos` | Tauri dev |
| `bun test` | Test packages |
| `bun run typecheck` | `tsc` packages |

## Data

Mặc định dưới `writer-room-data/` (đã gitignore):

- `spy/spy.sqlite` + `spy/artifacts/` — evidence
- `config/spy.json` — API key / sampling
- `exports/writer/` — Source Pack staging (Writer light)

## Phát triển

```bash
bun test packages/spy
bun run typecheck
bun run ui:build
```
