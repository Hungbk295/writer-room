# Writer Room — Human × Claude × Codex

Writer Room là ứng dụng local-first để phát triển kịch bản YouTube theo một
nguyên tắc đơn giản: Claude giữ quyền tác giả, Codex chỉ review và đưa phương
án, còn người dùng quyết định định hướng và điểm dừng.

## Workflow

```text
Title + Source Pack
  → Claude xây Backbone
  → Human duyệt định hướng
  → Claude viết Draft
  → Codex Review
      ├─ Còn Hard Gate fail/unclear
      │    → Level 1: phương án sửa tối thiểu
      │    → Claude tự chọn cách xử lý và sửa
      │    → Codex Review lại
      └─ Tất cả Hard Gate đạt
           → Level 2: phương án nâng trải nghiệm
           → Chờ User
                ├─ Dừng → khóa bản đạt hiện tại
                └─ Tiếp tục → Claude chọn/biến đổi/từ chối gợi ý
                               → Codex Review lại
```

Không có target score. Không có công thức bắt buộc về số hook, nhân vật,
storytelling, CTA hoặc nhịp cảm xúc. Kịch bản chỉ phải vượt sáu Hard Gate; sau
đó ưu tiên cảm xúc, thông tin truyền đạt, sự tự nhiên và giọng riêng.

## Hai agent

- **Claude — Author:** xây Backbone, viết và sửa Draft. Với mỗi gợi ý của
  Codex, Claude ghi rõ `accepted`, `adapted`, `rejected` hoặc `countered`.
- **Codex — Reviewer:** chấm sáu Hard Gate, đánh giá sàn emotion/information
  và đưa 1–3 phương án có trade-off. Codex không được viết lại kịch bản.

Sáu Hard Gate:

1. Hoàn thành lời hứa của tiêu đề.
2. Không có lỗi fact lớn.
3. Không có mâu thuẫn logic lớn.
4. Kết luận cốt lõi có đủ căn cứ.
5. Open loop chính đã được payoff.
6. Không gây hiểu nhầm nghiêm trọng cho khán giả.

## Chạy phát triển

Yêu cầu: [Bun](https://bun.sh/) v1.1+; Node.js và Rust nếu build desktop.

```bash
cd writer-room
bun install
bun run start
```

Mở `http://127.0.0.1:4187`.

Mock mode:

```bash
WRITER_ROOM_MOCK=1 WRITER_ROOM_PORT=4188 bun run start
```

Desktop:

```bash
bun run desktop:dev
```

## Kiểm tra và đóng gói

```bash
bun run typecheck
bun test
bun run build:ui
bun run build
```

Đóng gói desktop:

```bash
bun run desktop:bundle
```

## Dữ liệu

Trong bản desktop, dữ liệu nằm dưới OS Application Data
(`com.dacthao.writerroom`). Trong development:

```text
writer-room/
├── runs/<run-id>/
│   ├── input/       # Source Pack và instruction snapshots
│   ├── artifacts/   # Backbone, human brief, drafts, reviews, decisions
│   ├── jobs/        # Durable agent attempts
│   └── logs/        # Process trace
├── library.sqlite   # Các bản đã Stop & Lock
└── exports/         # Markdown/TXT exports
```

Writer Room chỉ ghi vào Library của chính nó và không mở hoặc sửa
`data/dna-spy.sqlite`.
