---
name: dna-cook
description: Cook một cook project trong DNA Spy qua control bridge — tạo project, nhận script, chạy board workspace, lint, gen ảnh, TTS, render. Dùng khi người dùng nói "cook bài này", "chuyển script sang dnaspy", "làm video từ script", "gen ảnh/tts/render project X", hoặc khi Writer Room vừa xuất xong một kịch bản cần làm video.
version: 0.1.0
metadata:
  hermes:
    tags: [dna-spy, cook, video-pipeline]
    category: production
---

# DNA Spy — cook pipeline

## Khi nào dùng

- Người dùng đưa script/title và muốn làm video trong DNA Spy.
- Writer Room vừa DONE một run và muốn "chuyển qua dnaspy cook luôn".
- Project cook đang dở một stage và cần chạy tiếp / làm lại một frame/câu.

## Điều kiện

- App **DNA Spy phải đang mở** (control bridge nằm trong sidecar). Nếu thiếu
  `<dataDir>/_control.json` → app đang đóng, báo người dùng mở app rồi dừng.
- License đã active trong Settings (các tool `cook_prepare`, `cook_run`, … trả
  `isError` "cần license" nếu chưa).
- Server MCP `dnaspy` đã cấu hình trong `~/.hermes/config.yaml` (xem
  `integrations/hermes/README.md` mục DNA Spy).

## Luồng chuẩn — project mới từ script có sẵn

1. `dna_options` → lấy `myDnas`/`channels`/`lenses`. Chọn `myDnaId` (ưu tiên)
   hoặc `channelId` khớp kênh; nếu không rõ, hỏi người dùng.
2. `cook_create` {title, topic, myDnaId|channelId, refUrls?, targetMinutes?,
   visualProfileId?} → `projectId`.
3. `cook_save_script` {projectId, sentences:[{text, ttsText?}]} — mảng câu theo
   đúng thứ tự đọc. Project tự sang stage `board`.
4. `cook_prepare` {projectId, stage:"board"} → `{dir, command}`. **Hermes tự
   làm agent**: đọc `dir/prompt.md` + `dir/context/*`, làm việc và ghi
   `dir/output/board.json` (hoặc `board-intent.json` nếu prompt yêu cầu).
   Không spawn Claude/CLI nào khác.
5. `cook_import_stage` {projectId, stage:"board", dir} → app normalize và lưu.
6. `cook_lint` {projectId} → nếu báo lỗi board nghiêm trọng, sửa trong
   workspace rồi import lại (hoặc `cook_prepare` stage `board-edit`).
7. `cook_makeup` {projectId} (viết lại `ttsText` cho giọng đọc) rồi
   `cook_clean_tts` {projectId} (chuẩn hoá số/ký tự). Có thể bỏ qua nếu chủ
   không yêu cầu.
8. `cook_run` {projectId, stage:"images"} → `{runId}` — job chạy nền trong
   app. Poll `cook_project` {projectId} cho tới khi mọi frame `imageStatus`
   không còn `pending` (hoặc hỏi chủ trước khi tốn tiền ảnh).
9. `cook_run` {projectId, stage:"tts"} → đợi audios ok.
10. `cook_run` {projectId, stage:"render"} → xong khi `render_path`/`video`
    trong `cook_project` có giá trị.

Báo cáo ngắn sau mỗi stage: stage nào xong, số frame/câu, lỗi nếu có.

## Làm lại / sửa lẻ

- `cook_board_frame` {projectId, frameIdx, instruction?} — gen lại prompt một
  frame ("làm lại ý frame 12").
- `cook_image_one` {projectId, frameIdx} — gen lại đúng một ảnh.
- `cook_tts_one` {projectId, sentenceIdx} — gen lại đúng một câu audio.
- `cook_cancel` {runId} — huỷ job đang chạy.
- `cook_projects` / `cook_project` — liệt kê và xem chi tiết project.

## Luật cứng (vi phạm là hỏng project)

- **Không bao giờ ghi `data/dna-spy.sqlite`** hay file `*.sqlite`/`*.db` nào —
  mọi mutation đi qua tool bridge.
- Board/scene-groups chỉ được tạo bằng cách **viết file `output/*.json` trong
  workspace** rồi `cook_import_stage`. Tuyệt đối không viết script
  Python/procedural để sinh board, không gọi API LLM bên ngoài bằng key trong
  DB.
- Frame count tính theo **scene** (`round(sceneDuration / secPerFrame)`, kẹp
  `frameRange` của lens) — không ép tối thiểu 1 frame/câu.
- Khi prompt yêu cầu phân tích ảnh/frame tham chiếu, phải thật sự đọc file ảnh
  — không đoán nội dung từ transcript.
- `cook_run` stage `board` bị chặn bằng thiết kế — board chỉ qua
  prepare → làm workspace → import.
