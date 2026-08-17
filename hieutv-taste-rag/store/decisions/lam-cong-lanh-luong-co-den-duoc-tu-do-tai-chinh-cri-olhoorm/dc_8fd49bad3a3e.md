---
id: dc_8fd49bad3a3e
memory_type: decision_case
creator: hieutv
domain: personal_finance
topic: "Hiệu chỉnh tự do tài chính thành tự chủ tài chính trước khi đơn giản hóa"
decision_type: uncertainty_calibration
source_id: src_85e69b573f28
segment_id: src_85e69b573f28_s005
selected_strategy: "correct the financial-freedom label before simplifying it for the episode"
evidence_status: observed_choice_inferred_rationale
human_validated: false
confidence: 0.94
editorial_value: high
epistemic_risk: medium
decision_geometry:
  - terminology_precision
  - scope_control
  - audience_accessibility
  - model_simplification
  - uncertainty_calibration
  - progressive_disclosure
principle_candidates:
  - disclose-simplification-before-using-it
  - preserve-precision-then-reduce-complexity
---

# Nói rõ tên gọi chưa chính xác trước khi dùng nó cho dễ hiểu

## Editorial situation

Nguồn cần dùng một thuật ngữ quen để dẫn phần mô hình số, nhưng cột mốc đang bàn không trùng hoàn toàn với hệ thống nhiều mức đã giới thiệu ở các tập trước.

## Editorial problem

Giữ toàn bộ taxonomy sẽ làm nặng mạch; dùng “tự do tài chính” mà không cảnh báo sẽ đánh đồng hai trạng thái có mức an toàn khác nhau.

## Observed choice

`OBSERVED`: Trước bảng số, người nói dừng lại và nói cụm “tự do tài chính” chỉ được dùng để đơn giản tên gọi; cột mốc đúng ra mới là “tự chủ tài chính”. Ông dẫn người muốn hiểu công thức từng mốc về loạt bài cũ, rồi đề nghị tạm thống nhất cách gọi đơn giản trong phạm vi tập này.

## Why this is editorially interesting

Đây là hiệu chỉnh chủ động, không phải lời miễn trừ cuối bài. Nó giữ một dấu mốc chính xác cho người đọc kỹ, đồng thời cấp phép cho phần còn lại dùng nhãn dễ theo dõi mà không phải lặp chú thích.

## Decision boundary

### Too safe — synthetic counterfactual

`SYNTHETIC` — `synthetic_counterfactual`: Giải lại toàn bộ các cấp tự do tài chính và công thức trước khi vào bảng. Độ chính xác tăng nhưng mục tiêu tập bị chôn trong taxonomy.

### Preferred region — observed strategy

`OBSERVED`: Nêu nhãn đang dùng → chỉ ra nhãn chính xác hơn → đặt liên kết cho độ sâu tùy chọn → thiết lập quy ước cục bộ.

### Too far — synthetic counterfactual

`SYNTHETIC` — `synthetic_counterfactual`: Dùng hai thuật ngữ thay thế lẫn nhau mà không nói khác biệt, rồi suy luận mức an toàn của trạng thái đầy đủ cho trạng thái rút gọn.

## Likely rationale

`INFERRED`: Mục đích có thể là bảo vệ tính liên tục với nội dung cũ và tránh để tranh luận thuật ngữ làm đứt mạch lập luận chính.

## Transfer conditions

Dùng khi một mô hình phổ thông gần đúng nhưng không đồng nhất với khái niệm kỹ thuật. Công bố phần rút gọn, giữ tên chính xác và giới hạn phạm vi quy ước.

## Do not transfer blindly

Một cảnh báo không tự làm công thức đúng. `epistemic_risk: medium` vì định nghĩa và ngưỡng tài chính vẫn là mô hình của nguồn, chưa được thẩm định ở đây.

## Source evidence

`OBSERVED`: `s005` trực tiếp nói tên gọi dùng cho đơn giản, cột mốc đúng ra là tự chủ tài chính, trỏ sang loạt bài cũ và xin tạm thống nhất cách gọi trong tập.
