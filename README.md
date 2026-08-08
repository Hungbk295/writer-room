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

## App desktop (Tauri)

```bash
bun install
bun run ui:build          # build UI → packages/web/dist
bun run app:macos         # Tauri dev — spawn daemon + mở cửa sổ
```

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
