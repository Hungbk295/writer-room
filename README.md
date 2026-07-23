# ✍️ Writer Room — Human × Multi-Agent Editorial System

> **Writer Room** là ứng dụng desktop & web ứng dụng mô hình đồng biên tập **Human-in-the-Loop × 3 AI Agents** chuyên sâu để sản xuất kịch bản YouTube và bài viết chất lượng cao.

---

## 🌟 Tổng Quan & Triết Lý Thiết Kế

Writer Room giải quyết vấn đề kịch bản AI thường bị nhạt, nông hoặc giật gân rỗng (clickbait) bằng cách kết hợp sức mạnh của 3 AI Agent chuyên biệt cùng sự định hướng trực tiếp từ người viết (Human Gate):

- 🤖 **Agent 1 (Writer)**: Thu thập bằng chứng (Evidence Ledger), bóc tách mâu thuẫn (Insights), xây dựng các hướng kịch bản (Angles & Hooks) và viết kịch bản chi tiết.
- 👩‍🎨 **Human Gate (Tác giả)**: Khóa góc nhìn (Angle), chọn/viết Hook phù hợp, bổ sung trực giác khán giả và trải nghiệm thực tế mà AI không thể tự suy diễn.
- 🧐 **Agent 2 (Editor)**: Chấm điểm khắt khe theo weighted score, chỉ ra Blocking Issues và yêu cầu sửa cho tới khi đạt điểm mục tiêu.
- 🎯 **Agent 3 (SEO Specialist)**: Tối ưu hóa tiêu đề, từ khóa, khả năng giữ chân khán giả và kiểm tra rủi ro gây hiểu lầm.
- 📁 **Article Library & Export**: Lưu trữ nguyên bản hoàn tất, xuất file `.md` và xuất trực tiếp từng lượt bản thảo ra file `.txt` tự động mở thư mục chứa.

---

## 🔄 Quy Trình Biên Tập (Workflow)

```text
Title + Source Pack (Thông tin đầu vào)
  │
  ├── 1. INIT PHASE (Agent 1)
  │      ↳ Evidence Ledger (bằng chứng) → Insights → 3 Angles → 2 Hooks/Angle + Draft sơ bộ
  │
  ├── 2. HUMAN GATE (Tác giả khóa định hướng)
  │      ↳ Tác giả chọn Angle + Hook (hoặc tự viết Hook) + trả lời 3 câu hỏi trải nghiệm/giọng viết
  │
  ├── 3. REVIEW & REVISION LOOP (Agent 1 ↔ Agent 2)
  │      ↳ Agent 1 viết Draft → Agent 2 chấm & nêu sửa đổi → Lặp lại cho tới khi PASSED
  │
  ├── 4. SEO OPTIMIZATION (Agent 3)
  │      ↳ Đánh giá SEO, gợi ý tiêu đề & kiểm tra rủi ro Clickbait
  │
  └── 5. PUBLISH & EXPORT
         ↳ Lưu vào Article Library, Xuất Markdown hoặc Xuất file TXT từng lượt Draft (tự động mở folder)
```

---

## 🚀 Tính Năng Nổi Bật

- 🎯 **Human Gate Định Hướng Triệt Để**: AI không tự quyết định góc nhìn kịch bản. Tác giả giữ quyền quyết định Angle, Hook và thêm trải nghiệm sống thực tế.
- 📄 **Xuất File TXT Theo Lượt Draft**: Ở bất kỳ lượt nháp nào (Init, Draft 1, Draft 2...), bạn có thể bấm **Xuất TXT** để lưu bản thảo ra file `.txt` và ứng dụng tự động mở thư mục chứa file (`exports/`) trong Finder / File Explorer.
- 📊 **Tiến Trình Chấm Điểm Minh Bạch**: Agent Editor phân tích chi tiết từng tiêu chí (Hook, Insight, Pacing, Retention...), đưa ra minh chứng từ kịch bản và kế hoạch chỉnh sửa cụ thể.
- 🖥️ **Ứng Dụng Desktop Tauri v2 + Web Server**: Chạy mượt mà trên macOS (DMG) & Windows (NSIS) hoặc chạy qua Web Server (Bun + HTML/CSS/JS thuần).
- ⚙️ **Cấu Hình Agent Linh Hoạt (Tab Agents)**: Tự do tùy chỉnh Provider, Model, Adapters (Agy, Gemini, Codex, Claude, Custom CLI) độc lập cho từng Agent 1, 2 và 3.
- 📚 **Article Library & Tìm Kiếm Tiếng Việt**: Lưu trữ lịch sử tất cả kịch bản đã chấp nhận, tích hợp FTS5 tìm kiếm toàn văn tiếng Việt không dấu/có dấu.

---

## 🛠️ Hướng Dẫn Cài Đặt & Phát Triển

### Yêu cầu hệ thống:
- [Bun](https://bun.sh/) (v1.1+)
- Node.js & Rust (nếu phát triển / build bản Desktop Tauri v2)

### 1. Chạy Web Server (Đơn giản nhất)

```bash
cd writer-room
bun install
bun run start
```
Mở trình duyệt tại: `http://127.0.0.1:4187`

> 💡 **Mock Mode (Thử nghiệm không tốn API key)**:
> ```bash
> WRITER_ROOM_MOCK=1 WRITER_ROOM_PORT=4188 bun run start
> ```

### 2. Phát triển App Desktop (Tauri v2)

```bash
cd writer-room
bun run desktop:dev
```

---

## 📦 Build & Đóng Gói (Production)

### Kiểm tra mã nguồn & Test:
```bash
bun run typecheck
bun test
bun run build
bun run build:ui
```

### Đóng gói App Desktop:
```bash
bun run desktop:bundle
```
File cài đặt đầu ra sẽ nằm tại: `src-tauri/target/release/bundle/` (DMG trên macOS, Installer trên Windows).

---

## 📂 Cấu Trúc Dữ Liệu & Thư Mục

Dữ liệu của ứng dụng được lưu tại OS Application Data (`com.dacthao.writerroom`):

```text
writer-room/
├── public/              # Giao diện Frontend (HTML, CSS, JS)
├── src/                 # Engine Backend (Bun RPC, Orchestrator, Store, Supervisor)
│   ├── orchestrator.ts  # Điều phối quy trình Human x Multi-Agent & Export
│   ├── store.ts         # Quản lý file hệ thống theo từng run
│   ├── library.ts       # Quản lý SQLite Article Library
│   └── rpc.ts           # Xử lý lệnh RPC nội bộ
├── src-tauri/           # Shell ứng dụng Desktop Rust / Tauri v2
└── prompt/              # Prompt kịch bản & tiêu chí biên tập mẫu
```

Khi ứng dụng thực thi, các tệp dữ liệu được tổ chức dưới thư mục app-data:

```text
app-data/
├── runs/<run-id>/       # Mỗi bài viết có 1 thư mục riêng
│   ├── input/           # Kịch bản gốc, tiêu chí, source pack
│   ├── artifacts/       # File JSON lưu draft-rN, review-rN, SEO...
│   ├── jobs/            # Lịch sử các lệnh đã giao cho Agent
│   └── logs/            # Nhật ký thực thi chi tiết
├── library.sqlite       # Cơ sở dữ liệu SQLite các bài đã hoàn thành
└── exports/             # Thư mục chứa các file .txt & .md đã xuất
```

---

## 🤝 Đóng Góp & Giấy Phép

Dự án phát triển riêng cho quy trình sản xuất nội dung YouTube cao cấp. Bản quyền thuộc về **Writer Room Project**.
# writer-room
