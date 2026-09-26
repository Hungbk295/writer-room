# Pilot v3.1 — topic `finance-us` (US / en)

Kết quả pilot bằng tay của Spy Pipeline v3.1 (ngách & painpoint), 2026-09-25 → 26.
Nguồn dữ liệu: Writer Room Spy MCP (`spy_channel_start`, `spy_video_comments`) + loop daily/weekly thật trên `writer-room-data/spy/spy.sqlite`.
Bảng `niches` / `painpoints` (DB v14) chưa có — tài liệu này là nơi lưu chính thức cho tới khi migrate.

## Ngách focus (JC chọn, tối đa 2)

| Mã | Ngách | Ai / hoàn cảnh | Keyword active |
|---|---|---|---|
| **N2** | Lãi kép & mốc triệu đô đầu tiên | 25–40, đã đầu tư đều nhưng chưa "cảm" được lãi kép | Building Wealth, Become Millionaire, Living Paycheck Paycheck, Invest Half Income, Let Compounding Work |
| **N3** | Chi phí sống thực vs thu nhập | Trung lưu Mỹ, thấy chi phí vượt thu nhập | LOOKING RICH, Real Math, True Cost, Normal American Lifestyle |

Ngách chưa focus: N1 Giàu âm thầm, N4 Vĩ mô, N5 Kiến thức nền.
Keyword tạm dừng: American Lifestyle, 1 Million (quá rộng, 0/50 kết quả khớp follow list).

## Painpoint confirmed (JC duyệt)

Chuẩn bằng chứng: ≥ 10 comment · ≥ 3 video · ≥ 2 kênh · ≥ 3 câu nguyên văn.

| Mã | Painpoint | Câu hỏi ngầm | Nguyên văn tiêu biểu | Bằng chứng |
|---|---|---|---|---|
| N2-1 | Khủng hoảng → bất tiện | Bao lâu nữa tôi thoát cảm giác luôn cận kề khủng hoảng? | "The first $10k doesn't change your life overnight... it changes the way you think about money forever." | Jack Explains Money, Nick Invests, Tally Press, Alexs Brooks |
| N2-2 | Nỗi sợ Năm Thứ 6 | Chưa thấy kết quả nhiều năm, sao biết mình đi đúng? | "Compounding isn't hard. Waiting is hard... The problem is your brain in Year 6." · "Boring, behind, invisible and then you were free" | Jack Explains Money, Money Tom, Finance With Henry |
| N2-4 | Câu chuyện này không phải người như tôi | Có đường nào cho người lương $20–40k không? | "Make yourself a millionaire with 20k per year, THAT'S the challenge." · "Starting with $200 is impossible no way" | ~15 comment, 4 video, 4 kênh |
| N3-1 | Giá thật bị giấu (trả góp, phí ẩn, lương gross ≠ thực nhận) | Giá thật của thứ này là bao nhiêu? | "Apple just makes the bad math look really good." · "your salary isn't your take-home pay" | Wealth Logic, Nick Invests, Alexs Brooks, Tally Press, Table With AO |
| N3-2 | Muốn tự kiểm chứng công thức | Công thức này có đúng với hoàn cảnh của tôi? | "That is exactly why your own numbers matter more than ours" · "there is no way in 24 months..." | Wealth Logic, Finance With Henry, Table With AO, Steve |
| N3-3 | Đã cắt hết rồi, không còn gì để cắt | Làm đúng hết sao vẫn không đủ? | "What do you do when you've cut, cut, cut and there's nothing left to cut?" · "2 masters and 10+ years... paycheck is 3680 monthly" | ~20 comment, 3 video, 2 kênh (Alexs Brooks, Tally Press) |

Gợi ý nội dung:
- N3-2 → định dạng công cụ/calculator người xem tự nhập số liệu, không phải kết luận một chiều.
- N2-4 → phiên bản "lên triệu đô với lương thường, bắt đầu từ số tiền nhỏ" — khoảng trống rõ nhất so với công thức POV "lên triệu đô" đang phổ biến.
- N3-3 có phe phản bác sẵn trong khán giả ("six figures and struggling = living above your means") — góc tranh luận khai thác được.

## Theo dõi (chưa đủ chuẩn)

| Ứng viên | Ngách | Bằng chứng hiện có |
|---|---|---|
| Tiếc vì bắt đầu muộn (N2-3) | N2 | 7 comment, 3 video, 3 kênh |
| 9-to-5 có thể mất bất cứ lúc nào | N2 | 8 comment, 3 video, 3 kênh |
| 55+ không có đệm tài chính | N3 | 12+ comment, 1 video |
| Tiết kiệm âm thầm bị mất lòng xã hội | N2 | 6 comment, 2 video |
| Chọn quỹ nào, lúc nào (60+) | N2 | 5 comment, 1 video |
| Quá tốn kém để lập gia đình | N3 | 3 comment, 1 video |

## Follow List (15 kênh active)

INIT (11, JC chọn tay): Jack Explains Money, Alicia Invests, Wealth Logic, Martik Finance, Bille Finance, Nick Invests, Casual Finance, Lucas Grant, Crayon Capital, Rookie Finance, Money Tom. (`@NolanFinance1` không tồn tại — 404.)

Weekly outlier (4, JC duyệt 2026-09-26):
- Alexs Brooks — N3, khán giả thật
- The Tally Press — N2 + N3, phỏng vấn đường phố (không faceless)
- Steve | Call to Leap — N2, khán giả 60+, duyệt tạm
- The Table With AO — N2, podcast Anthony O'Neal, nhiều scam, duyệt tạm

Đã loại vì tương tác giả (comment chủ yếu từ tài khoản kênh tài chính khác): Finance With Henry, Highfinance_View.

## Bài học cho code v3.1

1. Keyword rút tự động ở mẫu nhỏ ra nhiều mảnh câu vô nghĩa — cần người lọc trước khi active.
2. Keyword quá rộng ("Real Math", "True Cost", "1 Million") kéo về kênh ngoài niche — đo bằng `last_n_followed / last_n_results`.
3. Bộ lọc weekly chỉ kiểm ngôn ngữ/chết/xổ số → lọt phim ngắn, game, tarot, kênh Ấn Độ/Nam Phi nói tiếng Anh. Cần thêm lọc chủ đề và thị trường cấp kênh; cổng ngôn ngữ để lọt title trộn Hindi.
4. View cao ≠ khán giả thật: cần đo tỉ lệ comment từ tài khoản kênh khác / scam trước khi đề xuất follow.
5. Chạy lại weekly cùng ngày không ghi đè `daily_reports` (báo cáo hiển thị bản cũ).
