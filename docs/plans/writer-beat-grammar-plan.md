# Plan — Ngữ pháp beat (SDD 006)

> Tạo 2026-09-06 · Spec: `docs/specs/006-writer-beat-grammar/solution-design.md` · Source `aa0379e`.
> Đây là việc T8 nối tiếp `writer-main-loop-plan.md`. Điều phối: Claude (lead); thực hiện: teammate Sonnet theo lane.

Mục tiêu: một run thật ra outline có khuôn, mỗi beat có mode và phép lật, WRITE không còn nhận
Formula, editor kiểm được câu mở và mode. Không thêm model call.

## Lane và thứ tự

| Lane | Việc | File chạm | Phụ thuộc | Bằng chứng xong |
|---|---|---|---|---|
| A | Mode pack v1 có quote thật | `writer-room-data/writer/mode-pack.md` (mới, `git add -f`) | không | 12 heading; mỗi mode 2–3 lối, mỗi lối ≥1 quote `(file, videoId)`; mỗi mode 1 ví dụ dở; mỗi phép lật ≥1 quote; 3 khuôn |
| B | Schema outline + validator + prompt STUDY + coverageMap.sequence | `video-plan.ts`, `study-orchestrator.ts`, test tương ứng | không | test fixture §8 spec xanh; prompt STUDY có bảng định nghĩa, thứ tự "kết trước"; KHÔNG chạm `writer-run-v2.ts` |
| C | Bỏ Formula + loader mode pack + staging WRITE/REPAIR + prompt WRITE/EDIT + UI + test | `writer-run-v2.ts`, `mode-pack.ts` (mới), `run-store-v2.ts`, `http.ts`, `WriterV2.tsx`, `Channels.tsx`, test | B đã commit; A đã có file để test staging | typecheck sạch; test xanh; grep `formula` trong `src/writer/` chỉ còn comment deprecated |
| D | Tích hợp: test toàn bộ, restart daemon **và reload app**, một run thật, ghi nhật ký | không sửa code | A, B, C | run ID; outline có `frame/mode/turn`; `outlineChanges` nêu lối; kết quả editor mục 13–15 |

A và B chạy song song. C chạy sau B (cùng đụng `study-orchestrator.ts` type `LegacyStudyDispatchInput`
và `writer-run-v2.ts`). D do lead làm.

## Lane A — chi tiết

Nguồn quote:
- Hiếu TV: `writer-room-data/spy/hieu-tv-transcripts/*.txt` (30 file, tên file có số thứ tự và videoId).
  Ưu tiên bài view cao đã có entry trong `writer-room-data/general-packs/hieu-tv.md`: 09, 08, 103, 07, 137.
- Anh Ba: transcript bài "vỡ nợ xe dịch vụ" nằm trong
  `../dna-spy/outputs/writer-room-top20-20260730/writer-room-top20-corpus-and-drafts.xlsx.inspect.ndjson`
  (row chứa `1tqZFRrlQuk`, path `/values[6][8]`, ~30k ký tự). Ghi nguồn là `(Anh Ba, "VỠ NỢ Vì Chạy Xe Dịch Vụ")`.
- Ví dụ dở: `../dna-spy/outputs/writer-room-top20-20260730/anhba-03.md` (đoạn mục 1 và 2 lặp mẫu),
  `anhba-01.md` (mở bài bằng câu chủ đề trừu tượng).
- Khuôn: trỏ `channel-styles/nhan-vat-xuyen-suot.md` (nhân vật), entry 103 general pack (ẩn dụ bò), một
  ví dụ con số từ entry 09 (công thức bốn con số).

Luật soạn (theo general pack): nguyên văn là chính, không sửa ASR, không viết lại cho gọn; bình ≤ 2 câu
mỗi lối; không nhận tên host; mỗi mode có "Khi nào KHÔNG dùng" 2–3 gạch đầu dòng.

## Lane B — chi tiết

1. `video-plan.ts`: thêm 3 enum, các trường mới, luật §4 spec. Giữ hàm `validateWriterVideoPlan` là
   validator duy nhất của outline; thêm tham số tuỳ chọn `sourceSequences?: string[][]` cho luật chép chuỗi.
2. `study-orchestrator.ts`: `coverageMap[].sequence` trong `validateStudyArtifact` (parse, giới hạn 12,
   enum ∪ `khac`), truyền `sourceSequences` vào validator outline; `buildStudyPrompt` theo §6 spec.
   **Chưa** bỏ `formula`/`formulaLabel` (Lane C làm) để không phá typecheck của `writer-run-v2.ts`.
3. Test: `packages/daemon/test/writer/video-plan.test.ts` (mới nếu chưa có) + cập nhật
   `study-orchestrator.test.ts`: fixture hợp lệ và 6 fixture bị từ chối theo §8 spec.

## Lane C — chi tiết

Theo bảng §7 spec, đúng thứ tự: loader `mode-pack.ts` → `writer-run-v2.ts` (bỏ formula, staging
mode pack, prompt WRITE/EDIT/REPAIR) → `study-orchestrator.ts` bỏ `formula` khỏi
`LegacyStudyDispatchInput`/envelope/prompt → `run-store-v2.ts` → `http.ts` → UI → test.
Commit CHỈ file của lane; không `git add -A`.

## Lane D — chi tiết

1. `bun test packages/daemon/test/writer/`, `bun run typecheck`, `bun run ui:build`.
2. Không run nào IN_PROGRESS → kill daemon → `bun packages/daemon/src/index.ts` → **chủ kênh Cmd+R app**
   → `lsof -nP -iTCP:4187 -sTCP:ESTABLISHED | grep node` có dòng.
3. Run thật qua hook board (cấu hình như T3 của `writer-main-loop-plan.md`). Ghi run ID, outline, lối
   WRITE chọn, defect editor.
4. Chủ kênh đọc, trả lời 5 câu T5. Nếu có baseline trước 006 thì đặt cạnh nhau.

## Nhật ký

| Ngày | Lane | Commit / run | Kết quả | Ghi chú |
|---|---|---|---|---|
| 2026-09-06 | spec | — | SDD 006 và plan này | |
| 2026-09-06 | A | `e3f3d0d` | 429 dòng, 30 quote đã grep-verify, 15 heading | tỷ lệ trích 41%; `canh` và `doi-y` chỉ 2 lối; quote 137 có ASR xấu, đã gắn cảnh báo |
| 2026-09-06 | C | `04916e6` | 434 pass / 0 fail toàn daemon; typecheck + web tsc + ui:build sạch | bỏ Formula khỏi writer; mode pack staged WRITE/REPAIR; prompt WRITE/EDIT/REPAIR bump; UI bỏ select Formula, thêm chip mode/turn |
| 2026-09-06 | B | `a64db7c` | 241 pass / 0 fail; typecheck sạch | thêm ngoài scope: `story-planning.ts` (module bãi đỗ) phải mở allowlist vì dùng chung validator; chấp nhận |
