---
id: dc_72dbfecc0388
memory_type: decision_case
creator: hieutv
domain: personal_finance
topic: "Đặt ranh giới một kênh chính thức trước hành động ghi danh"
decision_type: call_to_action
source_id: src_c67b545c531b
segment_id: src_c67b545c531b_s011
selected_strategy: "route enrollment through one official channel and explicitly reject all others"
evidence_status: observed_choice_inferred_rationale
human_validated: false
confidence: 0.98
editorial_value: high
epistemic_risk: low
decision_geometry:
  - trust_boundary
  - impersonation_risk
  - irreversible_action
  - channel_control
  - high_stakes_conversion
  - instruction_clarity
principle_candidates:
  - one-authoritative-channel-before-action
  - explicit-negative-boundary-for-high-risk-cta
---

# Với CTA có rủi ro mạo danh, nói cả đường đúng lẫn đường cấm

## Editorial situation

Khán giả sắp thực hiện một hành động liên quan tới tiền và tài khoản. Thương hiệu cá nhân đang bị mạo danh trên nhiều kênh, nên một CTA mơ hồ có thể vô tình đẩy người nghe sang luồng lừa đảo.

## Editorial problem

Chỉ đưa URL đúng chưa đủ vì người dùng có thể nhận một đường dẫn giả trông tương tự sau đó. Liệt kê mọi dấu hiệu gian lận lại gây cognitive overload ngay tại conversion point.

## Observed choice

OBSERVED: Người nói chọn một nguồn duy nhất là website chính thức, lặp lại địa chỉ ở phần ghi danh và nói rõ không làm theo hướng dẫn từ bất kỳ nguồn nào khác. Facebook, Zalo và Telegram được nêu như các negative routes cụ thể. CTA vì vậy có positive instruction và explicit exclusion.

## Why this is editorially interesting

Đây là một decision boundary vận hành được: không bắt người nghe tự đánh giá giọng điệu hay avatar của người liên hệ, mà giảm bài toán xuống kiểm tra channel. Negative instruction cũng khóa cách diễn giải “tôi thấy thông tin tương tự trên nơi khác nên chắc vẫn được”.

## Decision boundary

### Too safe — synthetic counterfactual

SYNTHETIC — synthetic_counterfactual: Chỉ nói “hãy cẩn thận lừa đảo”. Cảnh báo đúng nhưng không cho người nghe một test để quyết định nguồn nào hợp lệ.

### Preferred region — observed strategy

OBSERVED: Nêu rủi ro mạo danh → chỉ định một authoritative channel → lặp lại endpoint → phủ định rõ các kênh thay thế phổ biến.

### Too far — synthetic counterfactual

SYNTHETIC — synthetic_counterfactual: Khẳng định cứ thấy tên miền quen là tuyệt đối an toàn. Tên miền có thể bị giả chính tả, tài khoản có thể bị chiếm và người dùng vẫn cần kiểm tra HTTPS, chính tả cùng chính sách thanh toán.

## Likely rationale

INFERRED: Mục đích likely là giảm ambiguity tại điểm có irreversible action và chuyển trách nhiệm xác thực từ cảm tính sang một quy tắc đơn giản.

## Transfer conditions

Dùng cho thanh toán, đăng ký, tải phần mềm, hỗ trợ tài khoản hoặc mọi CTA dễ bị impersonation. Chỉ chọn endpoint do tổ chức kiểm soát và giữ thông tin nhất quán ở mọi nơi.

## Do not transfer blindly

Ranh giới một kênh phải được cập nhật khi endpoint thay đổi và cần quy trình dự phòng nếu website gặp sự cố. Transcript cung cấp lời cảnh báo, không phải kiểm toán an ninh của website.

## Source evidence

OBSERVED: Đoạn s011 yêu cầu chỉ đăng ký qua website chính thức, cảnh báo mạo danh và phủ định hướng dẫn từ Facebook, Zalo, Telegram hay nguồn khác.
