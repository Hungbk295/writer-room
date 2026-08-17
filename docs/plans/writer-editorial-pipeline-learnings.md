# Writer editorial pipeline — bài học tích lũy

> Cập nhật gần nhất: 2026-08-13  
> Mục đích: tài liệu ngữ cảnh cho các turn sau và cho người sửa Writer pipeline.  
> Đây **không phải** một bộ rule được nạp trực tiếp vào agent. Không sao chép toàn bộ tài liệu này vào prompt.

## 1. Kết luận lớn nhất

Một bài viết có câu chữ tự nhiên vẫn có thể là một video YouTube yếu. Khác biệt thường nằm ở khả năng **đóng gói insight thành một vật thể dễ nhớ**, làm thông tin tiến triển và trả đủ payoff ở cuối — không nằm ở việc thêm nhiều quy tắc câu chữ.

Đích của Writer Room là giữ được chất người của một bài essay tốt, đồng thời tạo được xương sống của một video:

- Người xem kể lại được ý chính bằng một câu.
- Có đúng một điểm neo trí nhớ đủ mạnh.
- Mỗi phần làm hiểu biết hoặc trạng thái nhân vật thay đổi.
- Đoạn kết hoàn tất lời hứa phần mở và để lại một phép tự kiểm tra/hành động nhỏ.
- Những nhánh kiến thức hay nhưng không phục vụ xương sống được chủ động bỏ.

## 2. Bài học từ hai kịch bản tài chính

### “Bỏ phố về quê”

Bản sửa tốt hơn bản cũ vì có:

- Một nghịch lý số học rõ: lương tăng 12 triệu nhưng phần giữ lại chỉ tăng 300 nghìn.
- Ba lớp chi phí tạo chiều sâu: tiền, thời gian/năng lượng và quyền lựa chọn.
- Các thử nghiệm đảo ngược được, thay vì nhảy thẳng tới một kết luận lớn.
- Một quyết định cụ thể của An, có số mới và có cái giá phải trả.
- Ending quay lại câu hỏi ban đầu và trả lời nó bằng thay đổi có thể đo được.

Bài học: nhân vật không chỉ minh họa luận điểm; nhân vật phải **phát hiện, thử, quyết định và trả giá**.

### “Lương 25 triệu vẫn không có tiền”

Run agent `7d626c50-a84f-45d6-8a9f-63de4ba570c8` có câu chữ tự nhiên và “người” hơn, nhưng yếu hơn bản human ở khả năng làm video:

- Ý chính là lifestyle inflation/mức sống phình theo lương, nhưng không được nén thành một câu hoặc hình ảnh đủ sắc.
- Nhiều đoạn tiếp tục chứng minh cùng một kết luận bằng mốc 50%, áp lực đồng nghiệp, con số 25 lần chi phí và vay mua nhà.
- Các nhánh 25 lần chi phí và mua nhà có thể bỏ hoặc đổi chỗ mà hành trình chính gần như không đổi.
- Nhân vật Minh nhận ra vấn đề nhưng không có quyết định đủ cụ thể, con số sau quyết định hoặc cái giá phải trả.
- Ending giàu suy ngẫm như essay nhưng không hoàn tất một lời hứa thực hành.

Bản human thắng nhờ một điểm neo rất rõ: **“lương tự do”**, thực chất là tương phản `25 triệu đi vào / 5 triệu còn quyền quyết định`. Các phần sau lần lượt làm con số đó đổi nghĩa: tính ra, so sánh, thử khi thu nhập mất, rồi đưa người xem phép tự tính.

Không nên sao chép máy móc toàn bộ hình thức bản human. Bản đó cũng có nguy cơ quá công thức vì dùng chín phần đánh số, hai khái niệm được đặt tên, ba phép tính và một số câu kịch tính quá mức. Mục tiêu tốt hơn là:

> Chất người của bản agent + khả năng đóng gói một ý trung tâm của bản human.

## 3. Vì sao plan cũ thất bại

Plan của run trên chỉ có `OPENING`, `ANGLE`, `DEPTH`, `ENDING`. Nó thiếu các quyết định quan trọng:

- Người xem phải nhớ câu nào?
- Một điểm neo trí nhớ là gì?
- Mỗi nhịp thêm thông tin gì mới?
- Những nhánh nào chủ động không nói?
- Ending trả món nợ nào từ hook và người xem làm được gì?

`DEPTH` và `ENDING` trong plan cũ dành nhiều chữ để nói “không checklist”, “không tư vấn”, “không phán xét”. Đây là biểu hiện **nịnh rule**: agent mô tả sự tuân thủ các điều cấm thay vì đưa ra lựa chọn sáng tạo tích cực cho video cụ thể.

Bài học: negative rule hữu ích để chặn lỗi, nhưng không được trở thành nội dung chính của plan.

## 4. Ranh giới trách nhiệm trong pipeline

### Profile

Profile chứa gu và ranh giới ổn định của series:

- Giọng kể, lời hứa biên tập.
- Một tập CORE guardrail nhỏ.
- Guideline OPTIONAL dùng như checkpoint mềm.
- Anti-pattern, trong đó chỉ rủi ro sự thật mới nên là hard gate.

Profile không nên chứa dàn ý riêng cho từng video, danh sách mọi kỹ thuật hay toàn bộ bài học trong file này.

### Plan

Plan chịu trách nhiệm cho lựa chọn riêng của từng tiêu đề:

- Một `coreInsight`.
- Một `memoryAnchor`: `name | equation | contrast | image`.
- Một chuỗi `progression` trong đó từng nhịp có thông tin mới, chuyển biến và hình ảnh có thể dựng.
- Một `endingPayoff` trả lời phần mở và để lại đúng một phép tự kiểm tra/hành động.
- Một `cutList` bảo vệ góc kể khỏi các nhánh hấp dẫn nhưng thừa.
- 2–4 editorial decisions để tìm Taste precedent.

`videoPlan` là hợp đồng nén ý, không phải template câu chữ. Beat trong plan không bắt buộc biến thành heading hoặc chương đánh số trong draft.

### Draft

Draft chỉ nhận:

- Tiêu đề/brief.
- `videoPlan`.
- Editorial decisions và Taste precedents.
- Editorial promise, anti-patterns và CORE guideline của Profile.
- Source Pack để lấy dữ kiện.

Draft không thấy toàn bộ OPTIONAL guideline để tránh viết bài theo checklist.

### Reviewer

Reviewer dùng toàn bộ Profile như rubric mềm, cộng editorial decisions và ba hiệu quả video:

1. Người xem có thể kể lại ý chính bằng một câu không?
2. Mỗi phần có thêm phát hiện mới không?
3. Ending có hoàn tất lời hứa đầu video và để lại một việc cụ thể không?

Ba tiêu chí video có điểm nhưng không phải hard gate. Một cách thể hiện sáng tạo vẫn có thể đạt mà không lặp nguyên văn plan, không đặt thuật ngữ mới và không đánh số phần.

### Refine

Refine chỉ nhận checkpoint `MISS`/`PARTIAL`, anti-pattern bị vi phạm và `videoPlan`. Nó sửa đúng điểm yếu, không được biến phản hồi thành các phần mới để “cho đủ rule”.

## 5. Nguyên tắc thiết kế rule

- Ít rule generation hơn; dùng rule gợi mở và negative rule để chặn hành vi tệ.
- Guideline tích cực phần lớn là OPTIONAL và được hậu kiểm bằng tỷ lệ.
- `NA` phải được phép khi guideline không hợp bài; agent không cần dùng hết Profile.
- Không biến một lựa chọn phong cách thành hard gate.
- Rule phải mô tả hiệu quả cần đạt hoặc ranh giới cần tránh, không áp đặt dấu hiệu bề mặt.
- “Không dùng nhiều tiếng Anh” chưa đủ. Tiếng Việt vẫn có thể khó nghe nếu đặt quá nhiều nhãn khái niệm mới.
- Ngôn từ nên bình dân, hiểu được ngay khi nghe một lần; thuật ngữ chỉ dùng khi nó nén ý tốt hơn lời thường.
- Một bài có thể có chương đánh số, nhưng các chương phải phụ thuộc nhau và làm hành trình tiến lên. Nếu đổi chỗ được gần như nguyên vẹn, đó là taxonomy/checklist.

## 6. Điểm neo trí nhớ

Không bắt buộc đặt tên mới. Chọn đúng một trong bốn dạng:

- `name`: tên gọi bình dân thật sự làm ý dễ hiểu hơn.
- `equation`: một phép tính hoặc quan hệ số học.
- `contrast`: hai đại lượng/hình ảnh đặt cạnh nhau.
- `image`: một hình ảnh cụ thể chứa nghịch lý trung tâm.

Ví dụ tốt cho bài lương 25 triệu:

- Equation: `25 triệu − 20 triệu nghĩa vụ = 5 triệu được quyền quyết định`.
- Contrast: `lương trên giấy / lương còn quyền lựa chọn`.

Không nên đồng thời thêm “lương tự do”, “độ cứng tài chính”, “ngân hàng lối sống” và nhiều tên gọi khác nếu chúng cạnh tranh trí nhớ với nhau.

## 7. Thông tin tiến triển và retention

Một progression tốt không phải danh sách chủ đề. Mỗi beat cần trả lời bốn câu:

- Beat này xảy ra chuyện gì?
- Người xem biết thêm điều gì chưa biết ở beat trước?
- Nhân vật hoặc lập luận đã thay đổi ra sao?
- Có hình ảnh/số liệu/đối chiếu nào để dựng hình?

Dấu hiệu bài đang phẳng:

- Nhiều đoạn đều kết luận “chi phí tăng theo lương”.
- Một phần có thể xóa mà phần sau không mất tiền đề.
- Các đoạn chỉ đổi tên cho cùng một cơ chế.
- Source Pack có gì hay cũng được kéo vào bài.
- Nhân vật chỉ nghĩ, không thử hoặc quyết định.

## 8. Ending và tính actionable

“Không giả vờ tư vấn chuyên môn” không đồng nghĩa “không được cho người xem làm gì”. Một phép tự kiểm tra đơn giản không phải lời khuyên đầu tư.

Ending tốt cần:

- Quay lại con số, câu hỏi hoặc hình ảnh của phần mở.
- Cho thấy nhân vật/luận điểm đã thay đổi.
- Trả lời chính xác lời hứa tiêu đề.
- Để lại một việc nhỏ, rõ và phù hợp phạm vi bài.

Với bài lương 25 triệu, hành động phù hợp là lấy thu nhập thực nhận trừ các nghĩa vụ bắt buộc để thấy phần tiền còn quyền quyết định. Không cần thêm một checklist quản lý tài chính dài.

## 9. Sự thật và hard gate

Run `7d626c50-a84f-45d6-8a9f-63de4ba570c8` đã bịa case Minh: tuổi, nghề ở quận 3, số dư 380.000 đồng, các mức lương, tiền nhà, trả góp điện thoại và gym không có trong Source Pack. Reviewer cũ vẫn chấm 89 và kết luận sai rằng case không bịa.

Bài học:

- Số liệu đúng định dạng không có nghĩa là có nguồn.
- “Nhân vật minh họa hư cấu hợp lý” vẫn là vi phạm nếu draft trình bày như người thật mà brief/Source Pack không cho phép giả định.
- Nếu dùng tình huống giả định, phải nói rõ là giả định và không thêm tiểu sử giả để làm nó có vẻ thật.
- Một bài hay về câu chữ vẫn không được publish nếu vi phạm grounding.
- Hard gate hiện tại là **reviewer-confirmed**: code chặn chắc khi reviewer đánh dấu, nhưng chưa tự đối chiếu mọi claim với Source Pack. Đây chưa phải fact checker tất định.
- Hướng nâng cấp sau này nếu cần độ chắc cao hơn: claim ledger/source-span mapping hoặc một lượt source-grounding riêng trước review phong cách.

## 10. Profile hiện hành và ID cần nhớ

- Profile: `Soi tài chính`
- Profile ID: `294ced86-197c-40aa-b7df-d85416d4209e`
- Phiên bản hiện hành sau thay đổi này: `v4`
- Guideline điểm neo trí nhớ: `6cd10af9-4bc9-4014-b150-1880bd55ac20`
- Guideline ending tự vấn: `29af4bf3-3a34-413b-a665-86bc0adb0577`
- Guideline case study có nguồn: `d0e38164-1417-4045-a9d0-247af3dc8c09`
- Guideline tránh chương có thể đổi chỗ: `82fddbe7-14f6-4e57-8f75-49aa3fe285b5`
- Formula nguồn: `0fcb21c0-7852-489e-9915-150f4e2ad198`
- Formula nguồn: `17b85fa7-ec0e-46bf-8a24-fbdce132efd8`

Profile được quản lý và tìm trong Studio. Writer chỉ chọn và pin một Profile cụ thể cho run. Formula là tài liệu Training; Formula không đi thẳng vào Writer.

## 11. Quy tắc vận hành và phiên bản

- Mỗi Writer run pin `profileId`, `profileVersion` và `profileHash` khi bắt đầu.
- Sửa file Profile không làm run cũ tự chạy lại hoặc tự trở thành phiên bản mới.
- Run `7d626c50-a84f-45d6-8a9f-63de4ba570c8` dùng Profile v2; không được dùng nó để chứng minh v3/v4 đã hoạt động.
- Muốn kiểm thử thay đổi mới phải khởi động lại daemon nếu process đang giữ code cũ, rồi tạo run mới.
- Run mới hợp lệ cho thay đổi hiện tại phải hiển thị Profile v4 và có `videoPlan` trong UI/dữ liệu run.

Prompt version sau thay đổi:

- Plan: `writer-plan-v3-video-packaging`
- Draft: `writer-draft-v6-video-plan`
- Review: `writer-review-v3-video-effect`

## 12. Cách review một bài mới ở các turn sau

Đọc bài như người xem trước, rồi mới đối chiếu hệ thống:

1. Viết lại ý mình nhớ nhất bằng đúng một câu. Nếu không làm được, memory anchor yếu.
2. Ghi bên cạnh mỗi phần: “thông tin mới là gì?”. Nếu nhiều phần có cùng câu trả lời, progression phẳng.
3. Thử xóa hoặc đổi chỗ từng phần. Nếu bài hầu như không đổi, cấu trúc đang là taxonomy.
4. So hook và ending: ending có trả đúng món nợ hook đã tạo không?
5. Xác định người xem làm được gì sau video; không nhầm actionable với checklist dài.
6. Lập danh sách mọi tuổi, tiền, tỷ lệ, địa điểm, nghiên cứu và case; đối chiếu Source Pack trước khi chấm câu chữ.
7. Chỉ sau khi qua factual gate mới cho điểm tổng thể và cân nhắc publish.

## 13. Điều không nên làm tiếp

- Không thêm một rule mới cho mỗi lỗi gặp trong một bài.
- Không ép mọi bài phải có nhân vật, ba bước, một thuật ngữ hay chương đánh số.
- Không buộc draft dùng hết guideline để đạt điểm.
- Không đánh đồng nhiều heading với tiến trình thông tin.
- Không coi ending mơ hồ là sâu sắc chỉ vì câu chữ đẹp.
- Không coi một reviewer LLM là bằng chứng tuyệt đối rằng mọi claim đã có nguồn.
- Không sửa Profile để giải quyết một quyết định chỉ thuộc riêng một tiêu đề; đưa quyết định đó vào `videoPlan`.
