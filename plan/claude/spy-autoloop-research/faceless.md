> **SUPERSEDED 2026-08-21** — user quyết bỏ detector chạy local; vision sẽ do **agent** chấm (thiết kế vòng riêng). Phần detector/scoring visual dưới đây giữ làm **hồ sơ khảo sát**, KHÔNG còn trong plan hay code. Còn hiệu lực: **bộ regex tín hiệu văn bản vi/en** (dùng cho `faceless_hint`) và **rubric style_match** (input cho vòng vision sau).

# r-faceless memo (2026-08-20) — faceless_score + style_match

## Env verified
Bun 1.3.10, macOS arm64, ffmpeg /opt/homebrew/bin/ffmpeg, python3 3.14 (no cv2), swift CLT present.

## Detector decision (tested on 13 real thumbnails: 5 host, 2 Kurzgesagt, 2 anime, diagrams)
| Option | Result |
|---|---|
| **Apple Vision VNDetectFaceRectanglesRequest via ~40-line Swift CLI** | compile once `swiftc -O` (18s, 78KB), ~10ms/img, 0 false positives on cartoons/anime → **PRIMARY (darwin)** |
| OpenCV YuNet (opencv-python-headless 5.0 + face_detection_yunet_2023mar.onnx) | 0 FP cartoons, ~0.4s/13 imgs → **FALLBACK / Linux** |
| onnxruntime-node + UltraFace | works on Bun but 2 FP on Kurzgesagt faces → no |
| @vladmandic/face-api (tfjs) | archived 2025-02, tfjs-node+Bun issues → reject |
| MediaPipe / Haar | reject |

Architecture: `FaceDetectorPort` → `VisionCliAdapter` (darwin, compiled into ~/.cache/writer-room/facedet) → `YuNetPyAdapter` (if `python3 -c "import cv2"`) → null adapter = `insufficient_sample(no_detector)`. JSON contract: `[{path, faces:[[x,y,w,h,conf]], error}]`, normalized bbox.

Swift source:
```swift
import Foundation; import Vision; import AppKit
struct Out: Codable { let path: String; let faces: [[Double]]; let error: String? }
var results: [Out] = []
for path in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { results.append(Out(path: path, faces: [], error: "load_failed")); continue }
  let req = VNDetectFaceRectanglesRequest(); req.revision = VNDetectFaceRectanglesRequestRevision3
  do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
    results.append(Out(path: path, faces: (req.results ?? []).map { let b = $0.boundingBox; return [b.origin.x, b.origin.y, b.width, b.height, Double($0.confidence)] }, error: nil))
  } catch { results.append(Out(path: path, faces: [], error: "\(error)")) }
}
print(String(data: try! JSONEncoder().encode(results), encoding: .utf8)!)
```
Cost/channel (12 hqdefault thumbnails ~0.4MB): ~0.45s wall. Thumbnails processed in memory / temp, NOT persisted (ToS).

## Text signals
HOST (→ not faceless)
- en: `\b(vlog|day in (my|the) life|grwm|i tried|i tested|i spent|my (morning|night) routine|room tour|storytime|reacting to|reaction|podcast|interview|q&a|ama\b|face reveal|unboxing|haul|mukbang|let'?s talk|rant|irl\b)`
- vi: `(vlog|một ngày của (mình|tôi|em)|nhật ký|mình đã thử|trải nghiệm thực tế|tâm sự|chia sẻ (của )?(mình|tôi)|câu chuyện của (mình|tôi)|podcast|phỏng vấn|hỏi đáp|lộ mặt|reaction|ăn thử|mukbang|đập hộp|livestream|talkshow|du lịch cùng|cùng (mình|tôi|em))`
- Name-as-brand channel title (low weight). Transcript first-person ONLY counts with deixis: vi `(như (các )?bạn thấy|ở đây|đây là|cho bạn xem|camera|máy quay|trên tay)`, en `(as you can see|right here|behind me|on camera|look at this)`. Pure first-person narration is common in faceless VN story channels → must not flip score.

FACELESS-EXPLAINER
- en: `(explained|what if|why (do|does|is)|the (truth|science|history) (of|behind)|top \d+|\d+ (facts|reasons|ways)|documentary|animated|whiteboard|doodle|narrated|ai voice|tts|no commentary)`
- vi: `(giải thích|giải mã|bí ẩn|sự thật (về|đằng sau)|tại sao|vì sao|điều gì (sẽ )?xảy ra nếu|top \d+|\d+ (sự thật|điều|lý do|cách|bí mật)|thuyết minh|lồng tiếng|kể chuyện|đọc truyện|tóm tắt (phim|sách)|hoạt hình|doodle|vẽ tay|giọng (ai|đọc|máy)|tổng hợp|bản tin)`
- Description boilerplate (strong): `(stock|storyblocks|pexels|pixabay|envato|artlist|epidemic sound)`, `(voice|giọng đọc) (by|bởi) (elevenlabs|murf|vbee|fpt\.ai|google tts)`, fair-use notice.
- AI avatar override: `(heygen|synthesia|d-id|ai avatar|vtuber|live2d|nhân vật ảo)` → `synthetic_presenter` (photoreal avatars DO trigger face detector).

## Scoring
Per thumbnail (N≤12 after dHash dedupe): face_i if conf ≥0.7 (Vision)/0.75 (YuNet) AND bbox h ≥0.08; host_like_i = face_i AND h ≥0.15 AND count ≤2.
```
visual_faceless = 1 - Σhost_like/N
text_host = min(1, hits_host_titles*0.15 + hits_host_desc*0.1 + deixis*0.25 + name_brand*0.1)
text_faceless = min(1, hits_fl_titles*0.1 + boilerplate*0.3 + hits_fl_desc*0.1)
faceless_score = clamp(0.65*visual_faceless + 0.2*(1-text_host) + 0.15*text_faceless)
```
reasons[] typed `{kind:'face'|'no_face'|'keyword'|'boilerplate'|'deixis'|'name_brand', ref, value, weight}`, top 8.
Gate → `null` + gate_reason: N<6, no_detector, or ambiguous (host ratio in (0.25,0.6) and both text scores <0.3) → escalate 3 frames × top-3 videos via FfmpegAdapter.extractFrames; still ambiguous → label `mixed`. >50% thumbnails same template (hamming ≤6) → reason `template_thumbnails`, confidence low.
Thresholds: ≥0.75 faceless · ≤0.35 host · else mixed.

## style_match rubric (LLM, P1) — labels with evidence refs (≥2 thumb refs + 1 text ref, zod-validated)
narration_explainer · doodle_whiteboard · stock_footage · ai_slideshow · screen_recording · talking_head · vlog · animation_character (secondary). Output `faceless_consistent: boolean`; disagreement with faceless_score → confidence low, show both, never override.
