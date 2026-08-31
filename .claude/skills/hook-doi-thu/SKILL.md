---
name: hook-doi-thu
description: >
  Làm rõ title rồi gợi ý 3–5 hook mở bài cho Writer v2, dựa trên khung
  Anh Ba Tài Chính / Ông Chú Tài Chính. Kích hoạt khi Writer v2 chạy
  hook-clarify-v1 hoặc hook-suggest-v1, hoặc khi người dùng nói "làm rõ title",
  "gợi ý hook", "chọn hook rồi viết". Không viết cả kịch bản — chỉ hỏi và
  gợi ý hook. Thư viện nằm ở writer-room-data/hook-libraries/anh-ba-ong-chu.md.
---

# Hook đối thủ — hỏi rõ title, gợi ý vài hook

Writer v2 gọi skill này **trước STUDY**. Hai nhịp, form trên post, không chat tự do.

1. **Clarify** — 1–4 câu hỏi. Không hỏi lại Title / Brief / Audience đã có. Không phân nhóm taxonomy.
2. **Suggest** — 3–5 hook mới cho đúng title, mượn khung từ thư viện, không copy câu đối thủ, không bịa số.
3. Người chọn 1 hook trên UI. Chưa chọn thì không Run.

Đọc `writer-room-data/hook-libraries/anh-ba-ong-chu.md` khi gợi ý. Output JSON đúng schema prompt (`questions` hoặc `candidates`). Không viết bài.
