# SDD 006 — Ngữ pháp beat: bỏ Formula, mỗi beat một hình thức và một phép lật

> Tạo 2026-09-06 · Source đối chiếu `aa0379e` · Chủ kênh và Claude thống nhất trong phiên thảo luận cùng ngày.
> Nằm trong luồng chính (§0 `docs/plans/writer-v2-status.md`): không thêm model call, không thêm stage.

## 1. Vấn đề

Outline hiện tại (`WriterVideoPlan`) mô tả mỗi beat bằng **nói gì** (`beat`, `newInformation`,
`characterOrArgumentChange`, `visualAnchor`), không mô tả **chơi beat đó bằng hình thức nào**
và **cú lật nào** làm người nghe thấy "quen mà mới". WRITE nhận 5 beat cùng dạng thì triển khai
cùng một công thức, bài trôi về essay. Bằng chứng trong kho: bản nháp
`dna-spy/outputs/writer-room-top20-20260730/anhba-03.md` lặp nguyên một đoạn văn mẫu cho mục 1
và mục 2, chỉ đổi tên món.

Formula (`training-core` `FormulaArtifact`) đang được đưa nguyên vào STUDY và WRITE như "style
formula". Đọc các Formula thật (`Anh-ba`, `soitc`, TRIAL) thì luật của nó trộn ba lớp: giọng kênh,
mode/khuôn, và **chuỗi của video nguồn**. Lớp thứ ba là lệnh "viết theo dáng video đó", đúng thứ
G2 cấm. Có luật còn đi ngược G1 ("trích dẫn nghiên cứu kèm tên tổ chức, năm công bố").

## 2. Quyết định

1. **Bỏ Formula khỏi Writer v2.** Không còn là input của STUDY, WRITE, REPAIR. Training Lab và
   các route `/api/training/formula*` giữ nguyên; Formula trở thành dữ liệu thô để đào mode pack,
   không còn là luật cho người viết.
2. **Một beat = vật quen + một phép lật + một mode**, trong **một khuôn** cho cả bài.
3. **Mode pack** là file markdown do người soạn, có quote nguyên văn, staged vào WRITE như
   General Pack. STUDY chỉ thấy định nghĩa rút gọn trong prompt, không thấy quote.
4. **Kết phải sửa lại câu hỏi của hook**, không trả lời thẳng. STUDY khai câu trả lời thẳng bị
   từ chối để máy kiểm được.
5. **Học ý từ nguồn, không chép chuỗi.** STUDY ghi chuỗi mode của từng video nguồn; outline không
   được trùng chuỗi 3 beat liền với bất kỳ nguồn nào.
6. Chỉ **Mode**, **Phép lật**, **Khuôn** và **Kết** là luật máy kiểm. Câu mở, độ "khác nhau" thật
   của prose là việc của editor (checklist), không phải validator.
7. **General pack thu về Taste DNA + Ranh giới + Payoff kênh + bảng nhãn**; entry theo video
   chuyển làm nguồn thô của mode pack (Lane F, `docs/plans/writer-packs-v2-plan.md`).

## 3. Từ vựng

### Mode (hình thức của một beat) — 6 giá trị

| id | Tên | Phải có | Cấm |
|---|---|---|---|
| `canh` | Cảnh | giờ hoặc nơi, một đồ vật, một động tác | kết luận trong cảnh |
| `mo-so` | Mổ số | một số từ ledger và phép tính lộ ra | kể chuyện |
| `phan-bac` | Phản bác | câu cãi ở dạng mạnh nhất, đặt trước câu trả lời | trả lời trước khi dựng xong |
| `cuc-tri` | Thử cực trị | công thức hoặc ngưỡng đã nêu, đẩy tới input vô lý hoặc giả định | thêm biến mới không có trong bài |
| `zoom-chu` | Zoom một chữ | một chữ trong câu đã xuất hiện | bịa khẩu hiệu để mổ |
| `doi-y` | Lộ quá trình đổi ý | tự sửa, thú nhận hiểu lầm hoặc đổi kế hoạch | dùng ở beat cuối; quá 1 lần |

### Phép lật (lateral turn) — 6 giá trị

| id | Tên | Ví dụ đã thấy trong bài view cao |
|---|---|---|
| `doi-don-vi` | Đổi đơn vị đo | tiền đo giá trị, không đo công sức (taxi vs máy bay) |
| `doi-chu-the` | Đổi chủ thể | không phải bạn làm chủ xe, ngân hàng thuê bạn vận hành |
| `doi-thang` | Đổi thang | bò chết thì nuôi 20 con; 1 tỷ một tháng thì công thức gãy |
| `doi-ten` | Đổi tên gọi | tiết kiệm mức 3 là đang mất 2% mỗi năm |
| `doi-thoi-diem` | Đổi thời điểm nhìn | nhìn từ 10 năm sau, hoặc từ ngày ký hợp đồng |
| `doi-cau-hoi` | Đổi câu hỏi | kiếm tiền để làm gì → sống để làm gì |

### Khuôn (sợi dây xuyên suốt cả bài) — 3 giá trị

| id | Tên | Luật |
|---|---|---|
| `nhan-vat` | Nhân vật | theo `writer-room-data/channel-styles/nhan-vat-xuyen-suot.md` S2: tên, tuổi, nghề rồi dừng; foil ở mở và kết; nhân vật không nói câu trích ledger |
| `an-du` | Ẩn dụ vận hành được | ẩn dụ phải suy luận tiếp được, quay lại ở payoff |
| `con-so` | Một con số | một số từ ledger đi qua mọi beat và đóng ở payoff |

## 4. Schema

`packages/daemon/src/writer/video-plan.ts`:

```ts
export const WRITER_BEAT_MODES = ['canh','mo-so','phan-bac','cuc-tri','zoom-chu','doi-y'] as const;
export const WRITER_BEAT_TURNS = ['doi-don-vi','doi-chu-the','doi-thang','doi-ten','doi-thoi-diem','doi-cau-hoi'] as const;
export const WRITER_FRAME_KINDS = ['nhan-vat','an-du','con-so'] as const;

export interface WriterVideoPlanBeat {
  beat: string;
  newInformation: string;
  characterOrArgumentChange: string;
  visualAnchor: string;
  mode: WriterBeatMode;          // MỚI
  turn: WriterBeatTurn;          // MỚI
  familiarObject: string;        // MỚI: vật quen mà phép lật áp lên
  whyNotEarlier: string;         // MỚI: vì sao beat này không đứng sớm hơn được
}

export interface WriterVideoPlan {
  coreInsight: string;
  memoryAnchor: { kind: WriterMemoryAnchorKind; value: string };
  frame: { kind: WriterFrameKind; value: string };   // MỚI
  progression: WriterVideoPlanBeat[];
  endingPayoff: {
    resolvesOpening: string;
    audienceCanDo: string;
    directAnswer: string;        // MỚI: câu trả lời thẳng cho hook mà bài TỪ CHỐI kết bằng
    reframedQuestion: string;    // MỚI: câu hỏi của hook sau khi được sửa lại
  };
  cutList: string[];
}
```

`StudyArtifact.coverageMap[]` thêm `sequence: Array<WriterBeatMode | 'khac'>`: chuỗi mode của
video nguồn theo thứ tự xuất hiện, tối đa 12 phần tử.

### Luật validator (tất định, trong `validateWriterVideoPlan` và `validateStudyArtifact`)

| Luật | Lý do từ chối (reason) |
|---|---|
| `mode`, `turn` thuộc enum; `familiarObject`, `whyNotEarlier` ≥ 12 ký tự | `progression[i].mode/turn/familiarObject/whyNotEarlier` |
| Hai beat kề nhau không cùng `mode` | `adjacent beats share mode` |
| Hai beat kề nhau không cùng `turn` | `adjacent beats share turn` |
| Một `mode` xuất hiện tối đa 2 lần; `doi-y` tối đa 1 lần và không ở beat cuối | `mode overused` |
| `frame.kind` thuộc enum, `frame.value` non-empty | `frame` |
| `endingPayoff.directAnswer` và `reframedQuestion` non-empty; `directAnswer` ≠ `resolvesOpening` sau normalize | `ending answers the hook directly` |
| Chuỗi `mode` của outline không chứa cửa sổ 3 phần tử liên tiếp trùng với cửa sổ 3 phần tử liên tiếp của bất kỳ `coverageMap[].sequence` (bỏ qua `khac`) | `outline copies source sequence` |
| `coverageMap[].sequence` là mảng 0–12 phần tử thuộc enum ∪ `khac` | `coverageMap[i].sequence` |

Mã lỗi giữ nguyên `AGENT_SCHEMA` (orchestrator đã map). Run cũ đã lưu không bị re-validate.

## 5. Mode pack

File `writer-room-data/writer/mode-pack.md` (**phải `git add -f`**, xem memory gitignore).
Loader `packages/daemon/src/writer/mode-pack.ts`: `getModePack(dataDir)` trả `{ markdown, hash }`
hoặc `null` khi file thiếu; `validateModePack(markdown)` fail-closed khi thiếu bất kỳ heading
`## Mode: <id>` hoặc `## Phép lật: <id>` (12 heading). WRITE thiếu mode pack → fail
`WRITER_V2_INPUT_MISSING` với lý do rõ.

Cấu trúc mỗi mode (khuôn theo `channel-styles/human-moves.md`):

```
## Mode: canh — Cảnh
**Hiệu ứng cần đạt:** ...
**Phải có:** ... **Cấm:** ...
### Lối A — <tên>
> quote nguyên văn (file `NN`, videoId `...`)
### Lối B — ...
### Ví dụ dở
> trích từ bản nháp AI, ghi rõ nguồn
**Khi nào KHÔNG dùng:** ...
```

Mỗi phép lật một mục `## Phép lật: <id>` với ít nhất một quote thật. Mỗi khuôn một mục
`## Khuôn: <id>` trỏ tới style file tương ứng. Quote lấy từ
`writer-room-data/spy/hieu-tv-transcripts/*.txt` và transcript Anh Ba trong
`dna-spy/outputs/writer-room-top20-20260730/writer-room-top20-corpus-and-drafts.xlsx` (sheet
corpus). Luật soạn: nguyên văn là chính, bình ngắn; không sửa lỗi ASR; không nhận tên host.

Staging: WRITE và REPAIR nhận `input/mode-pack.md`; hash vào `inputHashes`. STUDY và EDIT_REVIEW
không nhận file; STUDY nhận bảng định nghĩa §3 rút gọn trong prompt.

## 6. Prompt

**STUDY** (`study-orchestrator.ts` `buildStudyPrompt`): bỏ dòng `## Style formula`. Thêm:
- Bảng Mode / Phép lật / Khuôn rút gọn (id + phải có + cấm), không quote.
- Thứ tự làm: (1) `coverageMap` kèm `sequence`; (2) viết `endingPayoff` TRƯỚC: ghi `directAnswer`
  rồi tìm `reframedQuestion` và `resolvesOpening` sao cho câu hỏi của hook bị sửa lại; (3) chọn
  `frame`; (4) đi ngược từ kết về hook, mỗi beat khai `familiarObject`, `turn`, `mode`,
  `whyNotEarlier`; (5) ledger.
- Nhắc luật kề nhau và luật không chép chuỗi nguồn bằng lời.
- JSON mẫu cập nhật đủ trường mới.

**WRITE** (`buildWritePrompt`): bỏ "style formula". Thêm mục `## Mode pack` (đọc toàn bộ
`input/mode-pack.md`, chọn một lối cho mỗi beat, nói lối nào trong `outlineChanges`), mục
`## Khuôn` (in `frame`), và luật câu mở: **ba câu đầu không được là câu chủ đề**; phải có một cái
cụ thể: giờ, nơi, đồ vật, con số từ ledger, hoặc một câu ai đó nói. Hook do người chọn vẫn đứng
đầu; nếu hook đã là cảnh thì luật này tự thoả.

**EDIT_REVIEW** (`buildEditReviewPrompt`): thêm checklist 13–15:
13. Câu mở là câu chủ đề hay là một cái cụ thể? Câu chủ đề ở ba câu đầu là MEDIUM.
14. Với từng beat, prose có làm đúng `mode` đã khai không (cảnh có giờ/nơi/đồ vật; mổ số có phép
    tính lộ ra; phản bác dựng mạnh trước khi trả lời)? Sai mode là MEDIUM, trích câu.
15. Hai beat liền nhau đọc lên cùng một nhịp (cùng cách vào câu, cùng kiểu kết đoạn)? HIGH.

**REPAIR**: envelope thêm `input/mode-pack.md`; prompt nhắc giữ mode của beat đang sửa.

## 7. Bỏ Formula — điểm chạm

| Nơi | Việc |
|---|---|
| `writer-run-v2.ts` `updateWriterPostV2` | không resolve formula; `formulaId/Version/Hash` ghi rỗng; `phase = READY` không cần formula |
| `runWriterRoomV2` | bỏ điều kiện `run.formulaId` và kiểm pin; `dispatchStudy(deps, run, pack)` |
| `dispatchStudy` / `LegacyStudyDispatchInput` | bỏ `formula`; envelope STUDY bỏ `formula`, `formulaLabel` |
| `dispatchWrite` | envelope bỏ `formula`; thêm `modePack` staging |
| retry STUDY (≈ dòng 1586) | bỏ kiểm formula |
| `formulaContractView`, `pinFormulaHash`, import `training-core` | xoá khỏi writer nếu không còn ai dùng |
| `run-store-v2.ts` | giữ 3 field để đọc run cũ, ghi rỗng cho run mới; comment "deprecated 006" |
| `http.ts` PUT post | nhận `formulaId` nhưng bỏ qua (không lỗi cho client cũ) |
| `channel-profile.ts` | giữ `defaultFormulaId` (Training có thể dùng), writer không đọc |
| `packages/web/src/pages/WriterV2.tsx` | bỏ select Formula và mọi state liên quan; không còn chặn READY vì thiếu formula |
| `packages/web/src/pages/Channels.tsx` | ẩn "Formula mặc định" khỏi form kênh (giữ field trong API) |
| test `writer-run-v2.test.ts` | bỏ `makeFormula` khỏi fixture writer; thêm test READY không formula; test envelope STUDY/WRITE không có `formula` |

## 8. Nghiệm thu

- `bun test packages/daemon/test/writer/` xanh; `bun run typecheck` sạch.
- Fixture outline: từ chối kề nhau cùng mode, cùng turn, mode dùng 3 lần, `doi-y` ở beat cuối,
  ending trả lời thẳng, chuỗi 3 beat trùng nguồn; chấp nhận outline hợp lệ.
- Mode pack: 12 heading đủ; mọi quote có `(file ..., videoId ...)`; parser fail-closed khi thiếu.
- Một run thật qua hook board tại daemon mới: STUDY trả outline có `frame`, `mode`, `turn`;
  WRITE `outlineChanges` nêu lối đã chọn; editor không báo mục 13–15 HIGH. Chủ kênh đọc và trả
  lời 5 câu T5 của `writer-main-loop-plan.md`; so với run baseline trước 006 nếu có.

## 9. Ngoài phạm vi

D/R/C ba call, Assertion Boundary, path jail (vẫn ở bãi đỗ §0). Không sửa Training Lab. Không
sinh mode pack bằng model trong đợt này; người soạn tay có quote thật.

## 10. Trạng thái triển khai

> Cập nhật 2026-09-06 chiều, lấy từ nhật ký `docs/plans/writer-beat-grammar-plan.md`.

| Hạng mục | Commit | Ghi chú |
|---|---|---|
| Lane A — Mode pack v1 có quote thật | `e3f3d0d` | 429 dòng, 30 quote đã grep-verify, 15 heading; tỷ lệ trích 41%; `canh` và `doi-y` chỉ 2 lối; quote 137 có ASR xấu, đã gắn cảnh báo |
| Lane B — Schema outline + validator + prompt STUDY | `a64db7c` | 241 pass / 0 fail; typecheck sạch; mở rộng ngoài scope: `story-planning.ts` (module bãi đỗ) phải mở allowlist vì dùng chung validator, đã chấp nhận |
| Lane C — Bỏ Formula, loader mode pack, staging WRITE/REPAIR, prompt, UI | `04916e6` | 434 pass / 0 fail toàn daemon; typecheck + web tsc + ui:build sạch; bỏ Formula khỏi writer; mode pack staged WRITE/REPAIR; prompt WRITE/EDIT/REPAIR bump; UI bỏ select Formula, thêm chip mode/turn |
| Lane D — Run thật qua hook board | run `b4deeb0f` | **Đang chạy** (`status: RUNNING`, `phase: WRITE` lúc 2026-09-06 16:21Z), **chưa nghiệm thu**. Baseline trước 006 đã DONE ở run `798eeb53`, export `writer-room-data/exports/baseline-pre-006-798eeb53.md` |

Nghiệm thu §8 (fixture, mode pack, run thật, T5 chủ kênh) coi là **chưa đóng** cho tới khi Lane D
có run DONE và chủ kênh trả lời 5 câu ở T5 của `writer-main-loop-plan.md`.
