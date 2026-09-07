# Writer v2 — Plan luồng chính

> Tạo 2026-09-06 · Source đối chiếu `02b094c` · Daemon đang chạy từ 2026-09-04 14:24 (PID xem `pgrep -fl daemon/src/index.ts`).
> Luồng và bãi đỗ ở [writer-v2-status.md §0](./writer-v2-status.md#main-loop). File này chỉ là việc làm, theo thứ tự.

Mục tiêu của plan: **một run đi từ chọn hook tới DONE hoặc dừng có note, lặp lại được, và
chủ kênh đọc script thấy đúng sự thật, có đường dây riêng, đọc như người.** Không nối thêm
tầng kiểm soát nào trước khi T5 kết thúc.

Quy tắc chung:

- Mỗi việc có bằng chứng hoàn thành ghi ngay vào bảng cuối file, kèm ngày và commit.
- Không sửa `writer-v2-status.md` §1–§9 trong lúc làm plan này, trừ bảng số liệu §2.
- Code trong bãi đỗ giữ nguyên, không import, không xoá.
- Hết T5 mới quyết định nối gì từ bãi đỗ, và chỉ nối một hạng mục có tín hiệu.

---

## T0. Baseline xanh — ĐÃ ĐẠT 2026-09-06

```bash
bun test packages/daemon/test/writer/
bun run typecheck
```

Kết quả: 222 pass / 0 fail / 1118 expect, chạy 2 lần liên tiếp tại `02b094c`.
Hai lần đỏ buổi sáng cùng ngày (3 fail e2e; rồi 1 fail timeout restyle) không tái lập.

Việc còn lại: nếu gặp đỏ lại, ghi tên test và log vào bảng cuối file rồi chạy lại một lần.
Đỏ 2 lần liên tiếp cùng test mới coi là lỗi sản phẩm. Không sửa test cho xanh.

---

## T1. Tắt retry ẩn ở EDIT_REVIEW và REPAIR — ĐÃ XONG `aa0379e`

**Vì sao:** STUDY và WRITE đã đặt `maxContentRetries: 0`. Hai stage còn lại dùng mặc định 2
của scheduler, nên một run xấu nhất có tới 8 model call trong khi coordinator đếm 4.
Không có mục tiêu tối ưu ở đây; mục tiêu là hành vi đoán được để đọc log cho đúng.

**Sửa:**

| File | Chỗ | Việc |
|---|---|---|
| `packages/daemon/src/writer/writer-run-v2.ts` | `dispatchEditReview`, dòng 1761 `stage: EDIT_REVIEW_STAGE` | thêm `maxContentRetries: 0` cạnh `freshContext: true` |
| `packages/daemon/src/writer/writer-run-v2.ts` | `dispatchRepair`, dòng 1812 `stage: REPAIR_STAGE` | như trên |
| `packages/daemon/test/writer/writer-run-v2.test.ts` | test mới | editor trả JSON hỏng → run FAILED ngay, không dispatch lần 2 |

Restyle và postmortem là job do người bấm, ngoài luồng chính: giữ nguyên.

**Hệ quả cần chấp nhận:** trước đây editor trả JSON sai schema thì scheduler tự cho thử
lại; giờ run FAILED với `errorCode` của validator. Đây là hành vi mong muốn: người đọc note
và bấm continue, thay vì hệ thống âm thầm gọi thêm.

**Bằng chứng xong:** test mới xanh; grep `maxContentRetries: 0` ra đúng 4 dispatch
(study-orchestrator, WRITE, EDIT_REVIEW, REPAIR); commit.

Sau T1 phải restart daemon (T2).

---

## T2. Daemon chạy đúng bản — ĐÃ RESTART 2026-09-06 tại `aa0379e`

**Vì sao:** daemon hiện chạy từ 2026-09-04; commit sau đó chỉ sửa docs nên code đang đúng.
Sau T1 thì không còn đúng nữa.

```bash
curl -s localhost:4187/api/health          # phải thấy ok:true, agents > 0
pgrep -fl daemon/src/index.ts              # ghi PID
# đợi không còn run nào IN_PROGRESS trên /api/writer/v2/runs rồi mới kill
kill <PID>
bun run daemon                             # hoặc cách bạn vẫn chạy
curl -s localhost:4187/api/health
git rev-parse --short HEAD                 # ghi vào bảng cuối file
```

Chưa có endpoint báo commit; ghi tay commit lúc restart. Không thêm endpoint trong đợt này.

**Bài học 2026-09-06 (bắt buộc đọc trước khi restart):** mọi stage Writer chạy
`interactivePty: true`, và người spawn pane CLI là **turn bridge trong cửa sổ app desktop**
(`packages/web/src/features/turn-bridge/client.ts`), không phải daemon. Bridge nhận
`spawnTurn` qua SSE `/api/team/events` đi qua vite proxy. Restart daemon làm SSE đứt, vite
trả lỗi 5xx nên `EventSource` đóng hẳn, không nối lại; mọi dispatch sau đó không bao giờ có
pane, treo đúng 45 phút rồi `AGENT_EXIT` (turn 158, post `798eeb53`, 07:42→08:41Z).
Kiểm nhanh: `lsof -nP -iTCP:4187 -sTCP:ESTABLISHED` phải thấy ít nhất một kết nối từ `node`
(vite). Sau restart daemon **phải reload cửa sổ app (Cmd+R) hoặc mở lại app** rồi mới dispatch.
Cửa sổ app phải mở suốt lúc run.

**Bài học 2 (16:00Z):** pane mở được nhưng dòng giao việc không tới (race gõ vào pane vừa
spawn): pane ngồi im ở prompt, `out/` rỗng, không có thư mục transcript trong `~/.claude/projects`.
**Không dùng `POST /api/team/interrupt`** cho turn Writer: nó hủy turn ở tầng team nhưng scheduler
không settle, `generatingHook` kẹt vĩnh viễn, `assertDraftIdle` chặn mọi dispatch mới. Cách gỡ đúng
(đã kiểm 16:00Z, turn 167): `POST /api/team/turn/complete {"turnId":N,"exitCode":-1}` — đây là
đường settle của chính bridge, scheduler ghi `AGENT_EXIT`, hook-board ghi `hookError`, post về
READY, rồi POST lại bước đó. Không kill pane bằng tay: bridge giữ mapping pane cũ và lần dispatch
sau sẽ không spawn pane mới (turn 167 không có pane); sau khi lỡ kill thì phải reload app.
Turn 166 đã gỡ bằng cách sửa run JSON như `recordHookError`; cách đó cũng được nhưng thô hơn.

**Bài học 3 (2026-09-07 03:10Z, giả thuyết có bằng chứng một phần):** stage hook đặt `freshContext: true`
nên bridge phải đóng pane hook cũ rồi mở pane mới (`replaceInteractivePane` → `launchTab`). Với turn 174
(T4 suggest) không có việc nào trong hai việc đó xảy ra dù SSE còn nối: pane clarify cũ sống, không pane
mới, `out/` rỗng. Trước đó pane clarify của T4 chỉ được mở **6 phút sau** dispatch (17:14 → 17:20Z). Nghi
bridge trong webview bị throttle khi cửa sổ app không ở foreground. Cách ứng xử: khi run, giữ cửa sổ app
hiển thị ở foreground; nếu thấy turn RUNNING mà không có pane trong 2 phút thì đưa app lên trước rồi chờ
thêm 1 phút trước khi settle bằng `turn/complete`.

---

## T3. Run sạch qua hook board

**Mục đích:** có một run thật đi hết luồng, mọi artifact lưu lại để đọc.

Đường đi (UI trang Writer v2, hoặc API tương ứng):

| Bước | UI | API |
|---|---|---|
| 1 | Tạo post, nhập title / brief / audience, chọn Topic Pack và General Pack | `POST /api/writer/v2/posts` |
| 2 | Làm rõ title | `POST /api/writer/v2/posts/:id/hook/clarify` |
| 3 | Trả lời câu hỏi, bấm gợi ý hook | `POST /api/writer/v2/posts/:id/hook/suggest` |
| 4 | Chọn một hook | `POST /api/writer/v2/posts/:id/hook/selection` |
| 5 | Chạy | `POST /api/writer/v2/posts/:id/run` |
| 6 | Theo dõi | `GET /api/writer/v2/runs/:runId` |

Chọn topic có pack đủ dày (≥ 3 video, có số liệu cụ thể) để STUDY có ledger thật.
Nên dùng pack đã từng ra video DONE trước đây để so sánh.

**Ghi lại:** run ID, post ID, hook đã chọn, số dispatch từng stage, trạng thái cuối,
thời gian. Nếu FAILED ở stage nào thì ghi `errorCode` và note, bấm continue một lần
(`POST /api/writer/v2/runs/:runId/continue`), ghi tiếp. Quá hai lần continue thì dừng,
đó là tín hiệu cho T5.

**Bằng chứng xong:** một run DONE hoặc dừng có note rõ ràng; file run trong
`writer-room-data/writer/runs-v2/<runId>.json` và workspace stage trong
`writer-room-data/workspaces/pipeline/<runId>/`.

---

## T4. Run cố tình bịa

**Mục đích:** xem gate và editor có bắt được bịa hay không, không cần corpus có nhãn.

Cách làm, chọn một hoặc cả hai:

1. **Hook hứa thứ nguồn không có.** Cùng pack như T3, nhưng chọn hoặc gõ hook chứa một
   con số hoặc tên riêng chắc chắn không có trong pack. Kỳ vọng: STUDY hoặc WRITE không
   dùng được số đó; nếu WRITE vẫn viết ra thì gate phải chặn với quote đúng câu.
2. **Pack mỏng.** Chọn topic chỉ có 1–2 video, ít số liệu. Kỳ vọng: STUDY báo ledger thiếu
   (ngưỡng 3 entry) hoặc script tránh số, không bịa.

**Ghi lại:** giống T3, thêm: gate có bắt không, editor có bắt không, câu nào lọt.
Câu lọt phải copy nguyên văn vào bảng cuối file. Đó là tín hiệu duy nhất để mở khoá
Assertion Boundary từ bãi đỗ.

---

## T5. Chủ kênh đọc và quyết định

Đọc script của T3 (và T4 nếu DONE). Trả lời năm câu, mỗi câu một dòng, có ví dụ câu trong bài,
đặt cạnh nhau giữa baseline trước 006 và bản sau 006:

| # | Câu hỏi | Baseline `798eeb53` | Post-006 `b4deeb0f` |
|---|---|---|---|
| 1 | Có số, tên, phép tính nào không tìm được trong pack không? | | |
| 2 | Có câu khẳng định chắc nịch mà nguồn thực ra tranh cãi hoặc có caveat không? | | |
| 3 | Đổi thứ tự hai đoạn giữa bài có ai nhận ra không? Outline có giống mục lục của nguồn không? | | |
| 4 | Người kể có lập trường, có đổi ý, có chỗ nghi ngờ không? Hay chỉ tóm tắt? | | |
| 5 | Hook đầu bài có trả payoff ở cuối không? | | |

Goal tương ứng từng câu (không đổi): 1–2 → G1; 3 → G2; 4–5 → G3. Nếu câu nào "không" ở cột
baseline, mở khoá theo bảng cũ: 1→Assertion Boundary (TODO-13, 14); 2→sửa prompt STUDY/editor
trước, chưa nối gì; 3→sửa prompt STUDY trước, nếu vẫn copy dáng nguồn thì D/R/C; 4→duyệt persona
(T6), chỉnh General Pack; 5→sửa prompt editor (đã có checklist).

Export baseline: `writer-room-data/exports/baseline-pre-006-798eeb53.md` (đã có).
| 2026-09-06 | T3 post-006 | run `b4deeb0f` | **FAILED_GATE** 16:43Z sau 1 REPAIR; STUDY 10 phút, WRITE 13, EDIT 0?, REPAIR 10; 4 dispatch/4 stage; 1397 từ | Outline đủ frame/mode/turn, 6 beat không kề trùng; editor mục 14 bắt beat 1 `canh` có kết luận (MEDIUM). Gate lần 1: 4 `NUMBER_UNSOURCED` gồm **"26%" false positive** (pack ASR ghi `26 ph`, gate chỉ biết `%`/`phần trăm`) + 2 số suy ra (200.000×26%, 40÷30) không đánh dấu giả định. REPAIR bỏ 26% nhưng suy ra "hơn 50.000 người" → gate 2 chặn. Export `exports/post-006-b4deeb0f.md` |
(xem nhật ký dưới).

Chủ kênh điền bảng khi cả hai bản đã DONE. **Sau T5 mới được lấy một hạng mục ra khỏi bãi đỗ**,
và chỉ hạng mục có câu "không" tương ứng. Sửa prompt luôn đi trước nối module.

---

## T6. Persona — tuỳ chọn, chủ kênh làm

Không chặn T1–T5. Luồng chính hiện chạy không persona vì 0/16 entry được duyệt.

1. Mở `writer-room-data/writer/persona-pack.md`, chọn 2–3 stance bạn thật sự muốn nói
   trong mọi bài, thêm marker `[ĐÃ DUYỆT]` đúng cú pháp entry.
2. Kiểm bằng parser, không đếm bằng grep:
   ```bash
   bun -e 'import {parsePersonaRegistry} from "./packages/daemon/src/writer/assertion-boundary.ts"; import {readFileSync} from "fs"; const r=parsePersonaRegistry(readFileSync("writer-room-data/writer/persona-pack.md","utf8")); console.log(r.entries.map(e=>[e.id,e.status]), r.violations)'
   ```
   Runtime lọc bằng `getApprovedPersonaPack` trong `persona-pack.ts`; parser trên là cùng
   nguồn trạng thái.
3. `git add -f writer-room-data/writer/persona-pack.md` rồi commit. Thư mục này bị gitignore.
4. Chạy lại một run như T3, so với run không persona ở câu 4 của T5.

Chưa duyệt experience A1–A8: cần xác nhận quyền kể, làm sau.

---

## T7. Dọn tài liệu

- `TODOS.md`: thêm một dòng đầu file trỏ tới plan này và §0.
- Không tạo doc mới nào khác cho Writer trong đợt này. Mọi trạng thái ghi vào bảng dưới.

---

## T9. Việc chờ restart — trạng thái 2026-09-07 04:15Z

Daemon đang chạy `04916e6`. Đã commit nhưng chưa nạp: gate nhận `ph` + luật số tự tính
(`907ef89`), mode pack v2 (`dfcc945`), general pack v3 (`2a32b5a`), human pack v1 + loader
(`f85459e`, `b0de17b`). Chủ kênh restart daemon (`bun run daemon`) và Cmd+R app, rồi lead cho
chạy lại post-006 và so với baseline. Sau đó mới xét SDD 008 (persona cắt mục 3, channel style
mỏng, general pack về hưu).

## T8. Ngữ pháp beat và bỏ Formula — SDD 006

Quyết định 2026-09-06 sau khi đọc bài view cao của Hiếu TV và Anh Ba. Spec:
`docs/specs/006-writer-beat-grammar/solution-design.md`; plan lane:
`docs/plans/writer-beat-grammar-plan.md`. Làm song song với T3–T5; run sau 006 so với run trước 006.

---

## Nhật ký bằng chứng

| Ngày | Việc | Commit / run ID | Kết quả | Ghi chú |
|---|---|---|---|---|
| 2026-09-06 | T0 | `02b094c` | 222 pass / 0 fail ×2 | đỏ buổi sáng không tái lập |
| 2026-09-06 | T2 kiểm tra | daemon từ 2026-09-04 14:24 | health ok, 10 agents | commit sau đó chỉ docs |
| 2026-09-06 | T1 | `aa0379e` | 224 pass / 0 fail; typecheck sạch | `maxContentRetries: 0` ở 4 dispatch; 2 test mới cho EDIT_REVIEW và REPAIR |
| 2026-09-06 | T2 restart | daemon PID mới tại `aa0379e` | health ok, 10 agents | không có run đang chạy lúc kill; log ở scratchpad session |
| 2026-09-06 12:57Z | T2 restart lần 2 | daemon tại `04916e6` (SDD 006) | health ok | sau khi baseline DONE; cần Cmd+R app trước run post-006 |
| 2026-09-06 15:27Z | T2 restart lần 3 (chủ kênh) | `bun run daemon` + `bun run app:macos` từ terminal, PID 94249, `04916e6` | bridge nối, GO cho run post-006 | daemon nền của Claude bị thay; từ giờ daemon do chủ kênh giữ |
| 2026-09-06 | T3 lần 1 | post `798eeb53`, turn 158 | hook-clarify FAILED `AGENT_EXIT` sau 45 phút, out/ rỗng | bridge app chết sau restart daemon, pane không bao giờ spawn; xem bài học ở T2 |
| 2026-09-06 | T3 baseline pre-006 | run `798eeb53` | DONE 12:50Z; clarify 2 phút, suggest 2 phút, STUDY 6 phút, WRITE 8 phút, EDIT 0 phút?, REPAIR 7 phút | lần 1 fail vì bridge; lần 2 sau reload app đi hết luồng; export `writer-room-data/exports/baseline-pre-006-798eeb53.md`. Gate lần 1 bắt "26%" kèm tên tổ chức bịa (`NUMBER_UNSOURCED`); editor 5 defect (1 HIGH cùng số đó, 4 MEDIUM: phản bác yếu, phép nhân sai đơn vị, so sánh không có mốc, câu cuối rời hình ảnh mở); REPAIR 1 lần, re-gate pass. 1390 từ, 6 beat, ledger 22 |
| 2026-09-06 16:21Z | T3 post-006 | run `b4deeb0f` | **đang chạy**: `status: RUNNING`, `phase: WRITE` lúc đọc (GET, không tác động) | post-006 tại daemon `04916e6`; pack "5 nghề dễ kiếm tiền nhưng rất khó giàu"; general pack `hieu-tv.md` v2; `formulaId/Version/Hash` rỗng đúng như thiết kế 006. Chưa có export; ghi tiếp khi DONE |
| 2026-09-06 17:25Z | gate fix | `907ef89` | 262 pass / 0 fail; typecheck sạch | gate nhận `ph` là phần trăm (+4 test); WRITE/REPAIR thêm luật số tự tính phải bỏ hoặc đánh dấu giả định; prompt version bump. **Cần restart daemon + Cmd+R app** trước run kế tiếp |
| 2026-09-07 03:54Z | T4 kết quả | run `4df03461` | **FAILED_GATE** sau 1 REPAIR; STUDY 8 phút, WRITE 20, EDIT 3, REPAIR 8; 1388 từ; 7 beat khuôn `con-so` | **Không lọt số bịa nào**: 0 câu chứa 73 / Fulbright / 2025 trong script; chặn ở 3 tầng: hook agent né số, STUDY không đưa vào ledger (19 entry), WRITE không viết. Gate đỏ lại vì đúng lỗi cũ "26%" vs ledger `26 ph` (đã sửa ở `907ef89`, daemon chưa nạp). Editor 9 defect, 5 HIGH về suy diễn nhân quả và đơn vị. Export `exports/t4-adversarial-4df03461.md` |
| 2026-09-07 03:15Z | T4 | post `4df03461` | suggest xong 03:13 (pane mở trễ ~14 phút), STUDY bắt đầu 03:14 với pane mở ngay; **hook agent tự né số bịa**: cả 5 candidate không nhắc 73%/Fulbright, h1 còn nói "chưa ai chỉ ra bản nghiên cứu gốc" | chọn h1 (stat-open) để giữ áp lực; run đang chạy |
| 2026-09-07 03:00Z | T4 | post `4df03461` | clarify xong 17:20Z hôm trước, đứng 9 giờ vì teammate chờ poll nền không bắn; đã đánh thức, tiếp tục từ bước suggest | daemon vẫn `04916e6`; T4 thử số bịa nên không cần bản gate mới |
| | T5 | | | |
| | T6 | | | |
