# Spy History — nhật ký research

> **File này là gì:** sổ tay research chạy theo ngày. Mọi lần spy (video, kênh, tìm kiếm)
> và mọi thứ rút ra được đều ghi vào đây. Đây là bộ nhớ dài hạn của việc research —
> spy.sqlite giữ *bằng chứng thô*, file này giữ *cái đã hiểu ra*.
>
> **File này KHÔNG phải gì:** không phải nguồn facts để viết bài. Số liệu và trích dẫn
> đưa vào bài vẫn phải verbatim từ Source Pack của run tương ứng. Ở đây chỉ là bản đồ,
> không phải kho đạn.

## Quy ước

- **Ngày mới thêm lên TRÊN CÙNG** (mới nhất trước). Không sửa mục của ngày cũ; sai thì
  ghi đính chính ở ngày hôm nay.
- Mỗi ngày có đúng 2 phần:
  - **Đúc kết** — cô đọng cuối ngày, 3–7 gạch đầu dòng. Đây là phần agent đọc trước.
    Viết cái *hiểu ra*, không phải cái *đã làm*: góc nào bão hòa, kênh nào đang lên,
    hook nào lặp, hướng nào đã loại và vì sao.
  - **Nhật ký** — thô, append trong lúc làm. Mỗi dòng gắn `run id` để lần ngược về
    spy.sqlite / Source Pack khi cần.
- Mỗi mục nhật ký nên có: giờ · loại run · nguồn · run id · kênh · views · transcript.
- Ghi tay hay agent ghi đều được, miễn giữ đúng 2 phần trên.

## Agent load lại thế nào

1. Đọc **toàn bộ phần Đúc kết** của mọi ngày (ngắn, rẻ) → biết đã đi tới đâu.
2. Chỉ đọc **Nhật ký của 3–5 ngày gần nhất** khi cần chi tiết.
3. Cần sâu hơn nữa thì lần theo `run id` vào `spy.sqlite` hoặc `writer/source-packs/`.

## Trạng thái

- Backfill lần đầu: 2026-09-08, dựng lại từ `writer-room-data/spy/spy.sqlite`
  (49 run, 13 ngày, từ 2026-08-07 đến 2026-09-07).
- Phần **Đúc kết** của các ngày backfill đang trống — chỉ bạn mới biết hồi đó rút ra
  được gì. Điền dần, hoặc bỏ qua và chỉ đúc kết từ hôm nay trở đi.

---

# 2026-09-09 — POV Finance (EN), run keyword `2026-09-09T1746-kw01`

## Đúc kết

- Đợt này chạy skill `niche-market-map`, phạm vi `pov-finance/en/US`, `craftMode: off`
  — **chỉ thu keyword**, không đọc transcript, không gắn craft flag.
- Bằng chứng nằm trong run dir riêng, không viết đè lên bản nháp `pov-finance-market-map*.md`
  của các đợt trước. Bản nháp đó vẫn là tài liệu lịch sử; đợt này **không** kiểm lại
  và **không** dùng lại kết luận trong đó.
- Chưa có mục đúc kết chiến lược — báo cáo đợt này cố ý chỉ mô tả và phân loại.

## Nhật ký

- 17:46 · setup · corpus baseline `spy.sqlite` 1.277 video (snapshot mới nhất mỗi ID),
  seed 562 title EN → `inputs/corpus-en-titles.csv`
- 17:50–18:02 · discovery+phân loại · 6 lane song song (L1 pov-frame, L2 every-level,
  L3 quiet-wealth, L4 your-life-if, L5 empire-build, L6 social-friction)
- Query thật: **25 search** (`spy_global_video_search`, en/US, provider `youtube_data_api`
  cho cả 25, **0 fallback**) + **66 corpus query** (`spy_corpus_videos`, 0 quota)
- Kết quả: 231 observation → **223 keyword**, **65 cụm đề xuất**, **308 video nguồn**
  (66 trong số đó chưa có spy run, chỉ đến từ search)
- Đính chính của coordinator: 10 title khôi phục nguyên văn, 72 queryId vá tiền tố,
  2 keyword đổi `out_of_scope`→`in_scope`; 0 record bị loại vì thiếu nguồn
- Bằng chứng: `writer-room-data/research/pov-finance/en/2026-09-09T1746-kw01/`
  → `report.md` · `keywords.jsonl` · `writer-input.jsonl` (378 dòng)
  · `sources/manifest.jsonl` · `run.json`

---

# 2026-09-09 — POV Finance (EN), chạy lại đầy đủ 6 agent / 3 vòng

## Đúc kết

- **Niche không thưởng chủ đề/title/sub/nhịp đăng/độ dài — cả 5 đã bị giết bằng bằng chứng phủ định.** Bảy kênh đăng CÙNG một title *"POV: You Started Thinking Like Old Money"* trong cùng tuần: 243 / 1.033 / 3.007 / 3.478 / 12.540 / **180.509**. Bản gốc đăng sớm nhất chỉ được **3.007** — thua bản clone 60 lần.
- **BIẾN TRỘI LÀ KÊNH, KHÔNG PHẢI VIDEO — và craft là CỬA ẢI, không phải lợi thế.** Ba video có transcript **trùng nhau từng chữ** (*"Your net worth is $4.1 million. Your mother called last Thursday…"*) nhận **111.133 / 205 / 0** view ⇒ phương sai do câu chữ giải thích **0%**. Phản ví dụ mạnh thứ hai: `htmoQ2CNw4c` mở đúng chuỗi template, mật độ số tiền CAO HƠN bản 180.509 → chỉ **1.033**. Và The Smart Wallet **70.500 sub** → **54 view**, trong khi Rank POV 703 sub → 32.897 ⇒ "kênh" không có nghĩa là sub, mà là **khán giả có đúng niche không**.
- **Thao tác đã đổi ở cú xoay trục 18/08: đặt người xem VÀO cảnh thay vì kể về một người khác.** Ba agent trên ba loại dữ liệu độc lập cùng mô tả đúng phép biến đổi này; trung vị **644 → 48.460 = 75,3x**. Nhưng đây là mô tả đáng tin về *cái gì đã đổi*, **không phải bằng chứng nhân quả**.
- **Cú nhảy KHÔNG lặp ở kênh khác** (Frankie 2,62x · Finance POV 2,37x · Sonny 1,82x · Ryan **0,99x**) ⇒ không phải YouTube đổi phân phối, mà là thứ kênh đó tự làm. Nhưng **1/6 kênh chưa đủ chứng minh cơ chế** — cần theo dõi thêm 2–4 tuần.
- **Title POV không cộng view — nó đổi khán giả.** Cùng tác giả Frankie, cùng nội dung giảng bài: title explainer → **93.002**; title POV → **37.715**. Người vào vì "POV" đến để nghe chuyện, gặp định nghĩa ở giây 47 thì thoát.
- **Sàn quyết định sống chết, không phải đỉnh.** Rank Goblin đỉnh 458.045 / sàn 164 → bỏ kênh. Money Life POV 140.079 / sàn 6.718 → sống, đang leo. Mẫu "hit rồi tắt" lặp ở 4 kênh độc lập. Chỉ số đúng: `max / trung vị` — trên 50x là xổ số.
- **Ô đáng vào là "giàu trong im lặng"**, cụm DUY NHẤT có nhiều kênh cùng sống (trung vị 7.428, 10/13 kênh trên 6.000). Mọi cụm khác winner-take-all hoặc nghĩa địa.
- **Ràng buộc thumbnail cứng: 2 vùng / 1 điều kiện ánh sáng / ≤11 người.** Ca có cả mẫu dương lẫn âm cùng kênh cùng tháng: `W4N_Pgy1Fr0` đủ mọi dấu hiệu format mới nhưng 4 vùng / 20 người / 4 ánh sáng → 7.079, thấp hơn trung vị kỷ nguyên mới 7 lần.

## Đính chính trong ngày

- **Manh mối bước 0 của người điều phối SAI.** "Sub tương quan ngược với view" bị agent A bác ngay vòng 1: Spearman thực tế **+0,429**. Lỗi do so *dải video thắng* thay vì *trung vị kênh*. Ryan 189.000 sub có trung vị **6.607**, cao hơn POV Finance (946) **7 lần**.
- **"Rank Goblin là điểm sáng số một" — agent B tự rút lại.** Spy đủ: 6 video, trung vị 1.534, hit lệch trung vị **298 lần**, chuỗi 458.045 → 1.881 → 351 → 1.188 → 164 rồi **bỏ kênh** 08/06.
- **"Ô mất việc còn trống thật" — agent D tự rút lại sau 3 vòng.** Agent B đúng: **NGHĨA ĐỊA**, 13 kênh faceless trung vị 22, kênh hỏng đầu tiên 03/01/2026. Giả thuyết "clone-wave sau 18/08" của người điều phối cũng **không được dữ liệu ủng hộ**.
- **Người điều phối dừng nhầm cả đội** khi thấy `youtube_data_api_provider_error`, tưởng hết quota là ngõ cụt. Sai: tool **tự fallback sang yt-dlp, 0 quota**, ~11/15 đúng niche. JC bắt được lỗi này.
- **Ghi chú "phải chạy Whisper" của đợt 08/09 SAI.** Video niche này **có phụ đề tự động `en-orig`**, yt-dlp lấy trong dưới 1 giây. `transcript_status: missing` là giới hạn pipeline spy, không phải thực tế YouTube. JC bắt được lỗi này.
- **Báo cáo bản đầu của người điều phối OVERCLAIM** — viết "lợi thế nằm ở kịch bản và thumbnail". Agent F lật bằng bộ ba script trùng chữ; đã sửa §0/§2.0/§3/§9 thành **cửa ải** thay vì **lợi thế**.
- **Agent C tự lật quy tắc "cấm khung Level"** — bản 275.751 view dùng Level headers dày đặc. Vấn đề là *cái đứng sau* chữ Level: tiêu đề chương thì sống, mục lục lời khuyên thì chết.
- **Máy dò bậc thang cho dương tính giả ở Ryan** (4,44x ngày 15/05) — thực ra là 15 video ramp khởi động. Agent A tự bắt.

## Nhật ký

- Quét lại `scan_limit: 500` cho 3 kênh chạm trần 120: @POVFinanceUS `7e19fc79-898b-4703-94d7-b1f6399e4225` (n=128) · @FrankieFinanceTV `483b5456-4d97-4b4d-abc6-eed2a4e99964` (n=128) · @RyanFinanceUS `3af450d4-335a-4be3-8199-e240963d20a9` (n=125). Trần cắt mất video **cũ view thấp** ⇒ cú nhảy mạnh hơn sau khi sửa (64,4x → 75,3x).
- **LỖI CÔNG CỤ:** `spy_corpus_*` gán mỗi video cho run tạo ra snapshot **mới nhất** của nó. Chạy `spy_video_start` lẻ **sau** channel scan sẽ **rút video đó khỏi cụm kênh**. Vì người ta chỉ spy lẻ đúng video outlier, video bị rút luôn là video lớn nhất ⇒ ca Hidden Yield sai lệch **45 lần** (3.668 → 380.079). Không phải `scan_limit`, không phải `min_duration_sec` — channel scan lấy đủ 15/15.
- **Quota `search` reset theo ngày Thái Bình Dương** (≈15:00 giờ VN). 57 call của 08/09 + 41 call sáng 09/09 = chạm trần 100 trong **cùng một quota day**.
- **Nhiễu fallback yt-dlp dao động rất mạnh theo query:** 11/15 đúng niche ở `pov you got laid off`, nhưng **1/30** ở cụm "đi xuống". Đừng giả định một tỷ lệ chung.
- 28 transcript thu bằng `yt-dlp --write-auto-subs --sub-langs en-orig` (0 quota). Xin nhiều sub-lang cùng lúc gây `HTTP 429`.
- Báo cáo: `writer-room-data/research/pov-finance-market-map-2026-09-09.md`. Bản 08/09 **giữ nguyên làm đối chứng độc lập**, không ghi đè.
- Skill `niche-market-map` đã cập nhật: cấm Whisper, 3 nguồn transcript hợp lệ, fallback yt-dlp, reset Thái Bình Dương, bẫy relevance-ordering, model cho subagent (Claude → `sonnet`, agy → `gemini-3.8-flash-high`).

---

## 2026-09-08

### Đúc kết

- **Niche "POV Finance" (faceless, EN) mới 5 tháng tuổi** — video cũ nhất của mọi kênh dẫn đầu rơi vào 15/04–10/05/2026. >160 kênh đang đánh, phần lớn <1.000 view. Báo cáo đầy đủ: `pov-finance-market-map.md`.
- **Title / chủ đề / nhịp đăng / số sub / độ dài KHÔNG phải lợi thế.** Cùng title `POV: You Started Thinking Like Old Money`, Finance POV đăng trước ngày 16/08 được 3.007 view, POV Finance copy ngày 19/08 được 180.509 (60x), Ryan 189k sub copy ngày 21/08 được 3.478. 8 cặp title trùng khác cùng một chiều. Đây là phát hiện gốc của cả đợt research — mọi kết luận khác treo vào nó.
- **Sub tương quan NGƯỢC với view trong niche này.** Hidden Yield 1.910 sub → 364.167 view (190x). Nischa 2.250.000 sub → 630.584 view (0,28x). Nick Invests (kênh mẫu bị clone) 0,41x. Kênh mới đang thắng, không phải "vẫn có cửa".
- **Con hào còn lại sau khi loại trừ: thumbnail + 30–60 giây đầu.** Hai agent độc lập (một đi từ metadata, một đi từ ảnh) hội tụ cùng kết luận. Thumbnail: luật hai thế giới, nhân vật mặt trống nhìn thẳng camera, 5/5 hit không có chữ overlay. Kịch bản: 10–14 lần "you"/phút đều suốt 20 phút, khuôn mở cố định "It's 6.58 on a Wednesday morning", thang tiến trình là TUỔI không phải level.
- **Một mạch chủ đề sống 2–3 tuần** rồi tụt từ "đăng là nổ" xuống "thỉnh thoảng nổ" (tỷ lệ vượt ngưỡng hit 55% → 10%). Cụm bền hơn là *quiet-wealth*, không phải *old money*. Phải chuẩn bị mạch kế trước khi mạch hiện tại hết.
- **Chủ đề #1 của Mỹ (old money) KHÔNG chuyển sang VN được** — VN không có tầng lớp tiền cũ liên tục. Nhưng cấu trúc chuyển được, và mạch tương đương ở VN là "giả nghèo về quê ăn Tết" (4,1 triệu view, hiện 100% do phim Trung lồng tiếng phục vụ, kênh tài chính chưa chạm).
- **Việt hoá phải bỏ tiền tố "POV:" trong title** — trên Cỏ Khong Ngu token `pov` lift 0,48x, trong khi `bạn leo` 6,66x, `cấp bậc` 6,39x. Riêng ngách tài chính VN chữ "bạn" ở title cũng phản tác dụng (Anh Ba Tài Chính 0,54x). Giữ "bạn" trong narration, title dùng khung "sự thật / mô hình / thang bậc".
- **Đính chính trong ngày:** ban đầu kết luận 3 kênh POV tài chính Việt chết vì dịch máy title. Sai. Anh TÓP Tài Chính chết vì kênh không nền (1.560 sub tích từ SEO ngân hàng 2022, chết 4 năm, khởi động lại 20/08) — cả 20 video mới đều 0–169 view bất kể format, và 4 video POV còn xếp TRÊN trung vị kênh. Ô POV × tài chính tiếng Việt vẫn **chưa được kiểm chứng**, không phải "đã xác nhận an toàn".
- **Bẫy keyword:** `lifestyle inflation`, `every level of being broke`, `pov you inherited money` nhìn như còn trống nhưng thực ra **trống vì đã chết** — hàng chục kênh đã thử, cao nhất 283–10.060 view. Phân biệt "chưa ai làm" với "làm rồi và chết".
- **Ghi chú công cụ:** `depth: "metadata"` không tải thumbnail, phải dùng `depth: "transcript"`. Kênh niche này chủ động không để caption (7/8 video missing) — phải tải audio rồi chạy Whisper cục bộ. Agent agy spawn qua 1devtool CÓ dùng được writer_room MCP (appMcpProvision cấp sẵn).

- **Vẻ ngoài "ai cũng thắng được" của niche là thiên lệch kẻ sống sót.** Spy đầy đủ 6 kênh nhỏ có view/sub ngoạn mục: 5 kênh là một-hai cú trúng (Hidden Yield 1/15 trung vị 324, Theo's POV 1/18 trung vị 243, Noir POV 2/8, Rank Goblin 1/6 và **đã bỏ cuộc từ 08/06**). Chỉ Dark Ledger (trung vị 12.899, 7/36 video >100k, bền 6 tháng) và POV Finance là hoạt động thật. **Bài học phương pháp: không bao giờ xếp hạng kênh bằng một video mẫu.**
- **Đo được tốc độ Writer Room vs yt-dlp** (cùng kênh @PsychoBro3, cùng lúc): `spy_channel_start` **1,13s có view đầy đủ** vs `yt-dlp --flat-playlist` **1,16s nhưng view_count = NA cả 21/21**. Writer Room nhanh ngang mà cho nhiều hơn — không có đánh đổi. yt-dlp chỉ còn hơn ở việc lấy sub count hàng loạt.
- **agy qua 1DevTool: 0/5 lần trả được văn bản** (`Delegate terminal exited before a correlated completion signal`, `resolve --outcome=done` không cứu được). Nhưng 3/5 kịp làm xong việc, và vì agent 1DevTool CÓ writer_room MCP (`appMcpProvision`, http.ts:568) nên dữ liệu sống trong spy.sqlite — đọc thẳng DB cứu được gần hết. Chính dữ liệu cứu được đã lật 3 kết luận của báo cáo.
- **Đã tạo skill `niche-market-map`** (`.claude/skills/niche-market-map/`) để lặp lại quy trình này cho keyword khác.

### Nhật ký

- `16:45` · Bắt đầu research keyword `pov finance`. Search EN/US đầu tiên → phát hiện cụm 7 kênh, kênh gốc POV Finance 12.9k sub mà video 180–256k view.
- `16:50` · Triển khai 5 teammate song song: A hồ sơ kênh · B ma trận keyword · C mổ transcript · D thị trường VN · E thumbnail.
- `16:53` · **B xong** (30/30 search): >160 kênh trong niche, bản đồ 20 keyword, 5 khoảng trống + 3 bẫy keyword chết. Phát hiện video "Nick Invests EXPOSED" dạy người khác clone kênh mẫu.
- `16:55` · **D xong** (25/25 search): 0 video tiếng Việt nào có "POV" trong title trên corpus 43 kênh. Bí mập 666 (962k) và Cỏ Khong Ngu (1,3M) đã thắng format POV ở niche nghề nghiệp.
- `16:55` · **A xong**: 7 kênh spy đầy đủ. Bước ngoặt POV Finance là 18/08/2026 sau 20 ngày nghỉ. A/B nội bộ: POV-prefix 45.079 vs non-POV 535 (84x).
- `16:57` · **E xong**: xem 10/10 thumbnail. Luật hai thế giới, mặt trống, không chữ overlay. Cặp 168k vs 37k khác nhau ở chỗ chữ trên thumb là fact mới hay lặp lại title.
- `16:59` · **B phụ lục**: resolve 30 kênh qua yt-dlp (0 quota) → bảng view/sub lật ngược xếp hạng, kênh 178–2.920 sub đứng đầu.
- `17:03` · **A phụ lục**: bằng chứng title trùng — nguyên nhân bên trong, không phải sóng ngành. Mạch old money qua đỉnh sau 3 tuần.
- `17:03` · **D phụ lục**: spy 4 kênh Việt vào corpus. Tự bác bỏ luận điểm "dịch máy title" của chính mình.
- `17:22` · **C xong** (chậm nhất — 7/8 video không có caption, phải chạy Whisper cục bộ): khung 8 khối, 4 quy tắc cấm, 3 hook mẫu tiếng Việt.
- `17:35` · Cứu dữ liệu 4 agy chết từ spy.sqlite → lật 3 kết luận: Hidden Yield chỉ 1 video may (trung vị 324), Dark Ledger mới là kênh bền (n=36, trung vị 12.899, từ 21/03 — sớm nhất), khung "How X Treat You" đã bị làm hết biến thể và chết hết (bệnh viện 142 view, pháp lý 166 view).
- `18:01` · Tự spy @PsychoBro3 để đo tốc độ Writer Room vs yt-dlp. Phát hiện thêm: bản ngắn thắng rõ (20 video <10p trung bình 53.908 vs 1 video >=10p được 7.045), và kênh này đăng từ **17/02/2026 — sớm nhất toàn dữ liệu**, tức khung *Every Level* có trước khung *POV: You…*.
- `18:20` · agy `rank-goblin` báo "Can't run". Tự spy: n=6, trung vị 1.881, 1 cú 458.045, **ngừng đăng từ 08/06**. Hạ từ tầng 1 xuống tầng cảnh báo.
- `17:30` · Chuyển sang agy qua 1devtool theo mô hình Team. Capacity 8/8 nên chạy 2 con một batch: `hidden-yield` + `dark-ledger` (team `add30aef`). Batch 1b (`rank-goblin`, `micro-channels`, `psycho-bro`) đã soạn manifest, chờ slot.

## 2026-09-07

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `12:52` · **video** · `1vw-D5wQvWk` · run `ec35f9fc`
  - **XB Khám Phá** · 32.009 views · 19p · transcript `ok`
    - Đại Học Hết “Hot”? Vì Sao Giới Trẻ Việt Đang Đổ Xô Đi Học Nghề?
    - https://www.youtube.com/watch?v=1vw-D5wQvWk
- `12:52` · **video** · `FzEYNc5JJR4` · run `95877de9`
  - **Dòng Chảy Thị Trường** · 8.459 views · 13p · transcript `ok`
    - Đại Học Hết Thời? Vì Sao Giới Trẻ Việt Đang Đổ Xô Học Nghề?
    - https://www.youtube.com/watch?v=FzEYNc5JJR4
- `17:58` · **video** · `ptmDsE_oans` · run `4b3e63c2`
  - **Văn Vở** · 368.179 views · 9p · transcript `ok`
    - Người ngựa, ngựa người trong 9 phút
    - https://www.youtube.com/watch?v=ptmDsE_oans
- `17:58` · **video** · `ptmDsE_oans` · run `147e0cc5`
  - **Văn Vở** · 368.179 views · 9p · transcript `ok`
    - Người ngựa, ngựa người trong 9 phút
    - https://www.youtube.com/watch?v=ptmDsE_oans
- `17:59` · **video** · `ptmDsE_oans` · run `849467eb`
  - **Văn Vở** · 368.179 views · 9p · transcript `ok`
    - Người ngựa, ngựa người trong 9 phút
    - https://www.youtube.com/watch?v=ptmDsE_oans

## 2026-09-04

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `14:33` · **channel** · `/@anhbataichinh-88` · run `9a1067aa`
  - Kênh **Anh Ba Tài Chính** · quét 60 video (scanLimit 60, topN 10)
    - 444.590 views · 25p · Sự Thật về 7 Mô Hình Kinh Doanh ĐÃ HẾT THỜI Tại Việt Nam Năm 2026?
    - 135.392 views · 29p · TẠI SAO KOL - GIANG HỒ MẠNG, CỨ GIÀU LÊN LÀ ĐI TÙ?
    - 94.081 views · 26p · Sự Thật về Làn Sóng BÁN THÁO Xe Hơi: Cơn Ác Mộng Gì Đang Đến?

## 2026-08-27

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `17:55` · **video** · `QFRm-OU33v8` · run `53a4fa2c`
  - **Ấn tượng VTV** · 32.404 views · 28p · transcript `ok`
    - Vì sao tuổi 40 dễ mất việc - Thay đổi hay chấp nhận rủi ro? | Hiểu sâu - Sống chất
    - https://www.youtube.com/watch?v=QFRm-OU33v8
- `17:55` · **video** · `XQxVG46-B4s` · run `922513a0`
  - **Ấn tượng VTV** · 70.948 views · 10p · transcript `ok`
    - Nỗi niềm người tìm việc ở độ tuổi 40 | VTV
    - https://www.youtube.com/watch?v=XQxVG46-B4s
- `17:55` · **video** · `-pazyWPR7cI` · run `1f2a66ee`
  - **VTV24** · 107.808 views · 10p · transcript `ok`
    - Tìm việc ở tuổi 40: Khó nhưng không có nghĩa là không thể | VTV24
    - https://www.youtube.com/watch?v=-pazyWPR7cI
- `17:55` · **video** · `BrQdN3C5r9g` · run `5d447aa1`
  - **VTV24** · 41.236 views · 2p · transcript `missing`
    - Sa thải lao động trên 35 tuổi: Doanh nghiệp "sợ" lao động có thâm niên? | VTV24
    - https://www.youtube.com/watch?v=BrQdN3C5r9g
- `17:55` · **video** · `DpDCk8EEPu8` · run `cb7d8bb7`
  - **VTV24** · 252.543 views · 8p · transcript `ok`
    - Xu hướng việc làm thời công nghệ số | VTV24
    - https://www.youtube.com/watch?v=DpDCk8EEPu8

## 2026-08-25

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `10:10` · **channel** · `/@hieu-tv` · run `89cddadc` · **failed**
  - Kênh **Hieu Nguyen** · quét 100 video (scanLimit 100, topN 10)
    - 845.131 views · 20p · 2 loại tài sản nên tích luỹ trong năm 2023
    - 788.967 views · 17p · Mọi việc xảy ra đều có lý do của nó
    - 633.588 views · 20p · Kỹ năng tự học hiệu quả
- `12:37` · **channel** · `/@hieu-tv` · run `ae732014`
  - Kênh **Hieu Nguyen** · quét 100 video (scanLimit 100, topN 10)
    - 845.136 views · 20p · 2 loại tài sản nên tích luỹ trong năm 2023
    - 788.977 views · 17p · Mọi việc xảy ra đều có lý do của nó
    - 633.591 views · 20p · Kỹ năng tự học hiệu quả
- `12:42` · **video** · `Ok70iKV4pL8` · run `56d29e4d`
  - **Học viện Bò và Gấu** · 444.756 views · 7p · transcript `ok`
    - LƯƠNG TƯỞNG CAO NHƯNG TẠI SAO GIỚI TRẺ LẠI KHÓ TÍCH LŨY? | CÂU CHUYỆN KIẾN THỨC
    - https://www.youtube.com/watch?v=Ok70iKV4pL8
- `13:16` · **video** · `In-pb5hT8gk` · run `2347fa39`
  - **VTV24** · 148.649 views · 3p · transcript `ok`
    - Làm vất vả mà thu nhập bấp bênh, nhiều người trẻ bỏ nghề xe ôm công nghệ | VTV24
    - https://www.youtube.com/watch?v=In-pb5hT8gk
- `13:16` · **video** · `QHfvAcz2tXE` · run `9f1efd29`
  - **AzFin - Quản lý gia sản cho người Việt** · 1.580 views · 9p · transcript `ok`
    - Làm công ăn lương làm thế nào để trở nên giàu có? - AzTalent
    - https://www.youtube.com/watch?v=QHfvAcz2tXE
- `13:16` · **video** · `2U3VDIG9dO8` · run `bccdfb4a`
  - **DAS - DESIGN ANTHROPOLOGY SCHOOL** · 5.697 views · 101p · transcript `ok`
    - TALKSHOW: FREELANCER - TỰ LO CÓ TỰ DO? - SPEAKER: MACK TRỊNH
    - https://www.youtube.com/watch?v=2U3VDIG9dO8
- `13:17` · **video** · `Ok70iKV4pL8` · run `085d0267`
  - **Học viện Bò và Gấu** · 444.756 views · 7p · transcript `ok`
    - LƯƠNG TƯỞNG CAO NHƯNG TẠI SAO GIỚI TRẺ LẠI KHÓ TÍCH LŨY? | CÂU CHUYỆN KIẾN THỨC
    - https://www.youtube.com/watch?v=Ok70iKV4pL8
- `13:17` · **video** · `In-pb5hT8gk` · run `44c34616`
  - **VTV24** · 148.649 views · 3p · transcript `ok`
    - Làm vất vả mà thu nhập bấp bênh, nhiều người trẻ bỏ nghề xe ôm công nghệ | VTV24
    - https://www.youtube.com/watch?v=In-pb5hT8gk
- `13:17` · **video** · `QHfvAcz2tXE` · run `d07ae78d`
  - **AzFin - Quản lý gia sản cho người Việt** · 1.580 views · 9p · transcript `ok`
    - Làm công ăn lương làm thế nào để trở nên giàu có? - AzTalent
    - https://www.youtube.com/watch?v=QHfvAcz2tXE
- `13:18` · **video** · `2U3VDIG9dO8` · run `3594d6eb`
  - **DAS - DESIGN ANTHROPOLOGY SCHOOL** · 5.697 views · 101p · transcript `ok`
    - TALKSHOW: FREELANCER - TỰ LO CÓ TỰ DO? - SPEAKER: MACK TRỊNH
    - https://www.youtube.com/watch?v=2U3VDIG9dO8
- `13:18` · **video** · `utJb1UzvjaQ` · run `432afc98`
  - **Chạm Đến Thành Công** · 238.238 views · 30p · transcript `ok`
    - Giàu Lặng Lẽ – 10 Nghề Không Ai Nói Nhưng Thu Nhập Cao | Chạm Đến Thành Công
    - https://www.youtube.com/watch?v=utJb1UzvjaQ

## 2026-08-19

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `16:24` · **channel** · `/@soitaichinh247` · run `894105ee`
  - Kênh **Sói Tài Chính** · quét 33 video (scanLimit 500, topN 5)
    - 94.727 views · 26p · TOP 7 Mô hình kinh doanh ngồi chơi vẫn "HÁI" ra tiền ( Ai cũng có thể làm )
    - 50.544 views · 22p · Làn Sóng Người Bán đang tháo chạy khỏi Shopee, TikTok Shop vì đâu?
    - 13.778 views · 28p · Đừng nghỉ hưu nếu chưa biết 5 sự thật tàn khốc này ở tuổi 50 !
- `16:42` · **channel** · `/@soitaichinh247` · run `a4071d5d`
  - Kênh **Sói Tài Chính** · quét 33 video (scanLimit 500, topN 5)
    - 94.771 views · 26p · TOP 7 Mô hình kinh doanh ngồi chơi vẫn "HÁI" ra tiền ( Ai cũng có thể làm )
    - 50.544 views · 22p · Làn Sóng Người Bán đang tháo chạy khỏi Shopee, TikTok Shop vì đâu?
    - 13.788 views · 28p · Đừng nghỉ hưu nếu chưa biết 5 sự thật tàn khốc này ở tuổi 50 !

## 2026-08-18

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `15:43` · **video** · `C_gmXg93ddI` · run `10c3d194`
  - **trainer winny** · 246.604 views · 4p · transcript `ok`
    - Simple Way Of Fixing Muscle Imbalances
    - https://www.youtube.com/watch?v=C_gmXg93ddI

## 2026-08-17

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `15:43` · **channel** · `/@deepepoch-c3c` · run `f27a2404`
  - Kênh **Deep Epoch** · quét 60 video (scanLimit 60, topN 10)
    - 114.386 views · 16p · How Did Ancient Humans Survive Without Clean Water?
    - 85.415 views · 17p · How Did Ancient Humans Sleep Without Beds?
    - 57.558 views · 22p · How Did Ancient Humans Invent Kings?

## 2026-08-16

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `10:41` · **video** · `CQwJrgF-YfE` · run `098c1935`
  - **Học viện Bò và Gấu** · 358.068 views · 5p · transcript `ok`
    - TRẢ GÓP 0% - CÚ LỪA THẾ KỶ HAY ĐÒN BẨY TIÊU DÙNG??? | CÂU CHUYỆN KIẾN THỨC
    - https://www.youtube.com/watch?v=CQwJrgF-YfE
- `10:41` · **video** · `FMkaHFe5fwk` · run `b35cc560`
  - **Quý Đầu Tư** · 47.408 views · 18p · transcript `ok`
    - Cạm bẫy trả góp xe hơi mà chẳng ai nhắc cho bạn biết
    - https://www.youtube.com/watch?v=FMkaHFe5fwk
- `10:41` · **video** · `DPwoGcGA-zk` · run `ffcb8dea`
  - **Lóng** · 809.959 views · 17p · transcript `ok`
    - Mua trước trả sau có thật sự tốt như mọi người thường nghĩ?
    - https://www.youtube.com/watch?v=DPwoGcGA-zk
- `10:41` · **video** · `8eUL85r5gII` · run `c5ad7aaa`
  - **TACA CHANNEL NEW** · 399.879 views · 10p · transcript `ok`
    - Trả góp 0% KHÔNG HỀ MIỄN PHÍ – Bạn đang trả bằng thứ gì?
    - https://www.youtube.com/watch?v=8eUL85r5gII

## 2026-08-15

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `09:25` · **video** · `3SvxPwO5g0k` · run `772f1671`
  - **Ông Chú Tài Chính** · 68.099 views · 27p · transcript `ok`
    - 10 Thói Quen Xài Tiền Của Người Nhật Giúp Tôi Tiết Kiệm Gần 100 Triệu
    - https://www.youtube.com/watch?v=3SvxPwO5g0k
- `09:25` · **video** · `sykxeP6L_A8` · run `f06e80bf`
  - **Thành Công Gõ Cửa** · 36.386 views · 39p · transcript `ok`
    - 9 Cách Tiết Kiệm Tiền Âm Thầm - Thói Quen Giúp Bạn Giàu Lên Bền Vững
    - https://www.youtube.com/watch?v=sykxeP6L_A8
- `09:25` · **video** · `-aUfuaw7n-g` · run `3d33d750`
  - **Lóng** · 461.890 views · 15p · transcript `ok`
    - 5 nguyên tắc tài chính sẽ khiến bạn trở nên GIÀU CÓ
    - https://www.youtube.com/watch?v=-aUfuaw7n-g
- `09:26` · **video** · `ZwRBB8eoSmc` · run `4f7e2a3f`
  - **The Present Writer** · 112.543 views · 20p · transcript `ok`
    - 9 Thói quen nhỏ giúp mình giàu lên mỗi ngày
    - https://www.youtube.com/watch?v=ZwRBB8eoSmc
- `09:26` · **video** · `UBQjxynghr4` · run `129acdb3`
  - **Jolin Sydney** · 66.844 views · 12p · transcript `ok`
    - MÌNH ĐÃ TIẾT KIỆM TIỀN 50 TRIỆU/THÁNG NHƯ THẾ NÀO? | Mẹo chi tiêu quản lí tài chính | Jolin Sydney
    - https://www.youtube.com/watch?v=UBQjxynghr4
- `09:56` · **video** · `tn3YVGA3uXc` · run `9d4b95c0`
  - **Sói Tài Chính** · 90.794 views · 26p · transcript `ok`
    - TOP 7 Mô hình kinh doanh ngồi chơi vẫn "HÁI" ra tiền ( Ai cũng có thể làm )
    - https://www.youtube.com/watch?v=tn3YVGA3uXc

## 2026-08-14

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `17:08` · **video** · `zPjUIljq6Ko` · run `a257dce3`
  - **Anh Ba Tài Chính** · 154.625 views · 25p · transcript `ok`
    - 7 Mô Hình Kinh Doanh ĐÃ HẾT THỜI Tại Việt Nam Năm 2026 - 95% Phá Sản Nếu Cố Làm
    - https://www.youtube.com/watch?v=zPjUIljq6Ko
- `23:31` · **video** · `Y1jzWy-lOsk` · run `00e1f851`
  - **Anh Ba Tài Chính** · 21.489 views · 24p · transcript `ok`
    - 13 Thói Quen Cực Dễ Giúp Bạn KHÔNG BAO GIỜ Lo Thiếu Tiền
    - https://www.youtube.com/watch?v=Y1jzWy-lOsk

## 2026-08-11

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `00:44` · **channel** · `/@hieu-tv` · run `3bb3dce2`
  - Kênh **Hieu Nguyen** · quét 150 video (scanLimit 150, topN 20)
    - 1.598.159 views · 23p · Những áp lực tiêu cực và sự cặm cụi
    - 1.391.031 views · 18p · 10 nguồn thu nhập thụ động phổ biến
    - 1.139.194 views · 26p · 9 sai lầm tài chính cá nhân khi 30-40 tuổi
- `17:14` · **video** · `7LU0rLUlcyI` · run `a31e74c0`
  - **Chạm Đến Thành Công** · 132.330 views · 26p · transcript `ok`
    - 10 Nghề Lãi Cao Ít Cạnh Tranh – Ai Nhìn Thấy Sớm Là Thắng | Chạm Đến Thành Công
    - https://www.youtube.com/watch?v=7LU0rLUlcyI
- `17:15` · **video** · `9WIYz7XX7io` · run `09893e8d`
  - **Phát triển bản thân** · 24.544 views · 22p · transcript `ok`
    - Làm Giàu Ở Quê: 7 Mô Hình Kinh Doanh Nhỏ Lời Khủng
    - https://www.youtube.com/watch?v=9WIYz7XX7io
- `17:15` · **video** · `qU1zWgvs6jw` · run `3a7cbadd`
  - **365 Ngày Lập Nghiệp** · 164.742 views · 22p · transcript `ok`
    - 6 Nghề Ở Quê Kiếm Tiền Tỉ Năm 2026 | 365 Ngày Lập Nghiệp
    - https://www.youtube.com/watch?v=qU1zWgvs6jw
- `17:16` · **video** · `BiMVoRQrtcE` · run `fb9540df`
  - **Khởi Nghiệp Thành Công** · 174.625 views · 16p · transcript `ok`
    - XU HƯỚNG 12 NGHỀ LÊN NGÔI ĐẾN 2030 - HÚT TIỀN CỰC MẠNH - DỄ GIÀU CÓ TỪ 2025 -2030
    - https://www.youtube.com/watch?v=BiMVoRQrtcE
- `17:16` · **video** · `utJb1UzvjaQ` · run `d2a245bd`
  - **Chạm Đến Thành Công** · 234.752 views · 30p · transcript `ok`
    - Giàu Lặng Lẽ – 10 Nghề Không Ai Nói Nhưng Thu Nhập Cao | Chạm Đến Thành Công
    - https://www.youtube.com/watch?v=utJb1UzvjaQ

## 2026-08-10

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `15:43` · **channel** · `/@anhbataichinh-88` · run `7300ebcc`
  - Kênh **Anh Ba Tài Chính** · quét 60 video (scanLimit 60, topN 5)
    - 76.643 views · 25p · CÁ ĐỘ WORLD CUP: Tại Sao Bạn CHẮC CHẮN THUA Dù Thông Minh Đến Đâu
    - 41.244 views · 26p · Hãy Làm Việc Này NGAY KHI Có 2 TỶ: Hầu Hết Mọi Người Đều PHÁ HỎNG Nó!
    - 36.208 views · 27p · Làn Sóng BỎ NGHỀ Xe Ôm Công Nghệ: Khi Thu Nhập Không Đủ Nuôi Sống Bản Thân
- `15:54` · **video** · `1tqZFRrlQuk` · run `ed6ae525`
  - **Anh Ba Tài Chính** · 206.529 views · 27p · transcript `ok`
    - Bất Kỳ Ai Làm Theo Cách Này Đều Sẽ GIÀU CÓ Sau 2 Năm (Kể cả người nghèo)
    - https://www.youtube.com/watch?v=1tqZFRrlQuk
- `16:59` · **video** · `tn3YVGA3uXc` · run `93bcfd85`
  - **Sói Tài Chính** · 87.590 views · 26p · transcript `ok`
    - TOP 7 Mô hình kinh doanh ngồi chơi vẫn "HÁI" ra tiền ( Ai cũng có thể làm )
    - https://www.youtube.com/watch?v=tn3YVGA3uXc

## 2026-08-07

### Đúc kết

- _(chưa đúc kết — backfill từ spy.sqlite, chưa có ghi chép của người)_

### Nhật ký

- `11:15` · **channel** · `/@ted` · run `747c8757`
  - Kênh **TED** · quét 5 video (scanLimit 5, topN 2)
    - 20.818 views · 11p · How to Live with Your Biggest Regret | Gregg Ward | TED
    - 15.303 views · 12p · Inside Dubai’s Mission to Build the City of the Future | His Excellency Khalfan Belhoul | TED
    - 15.181 views · 12p · How I Built a Machine That Feeds Millions | Felix Brooks-church | TED
- `11:50` · **channel** · `/@soitaichinh247` · run `1936efd4`
  - Kênh **Sói Tài Chính** · quét 31 video (scanLimit 60, topN 5)
    - 85.075 views · 26p · TOP 7 Mô hình kinh doanh ngồi chơi vẫn "HÁI" ra tiền ( Ai cũng có thể làm )
    - 50.012 views · 22p · Làn Sóng Người Bán đang tháo chạy khỏi Shopee, TikTok Shop vì đâu?
    - 12.963 views · 21p · Làn Sóng "Sa Thải" Dân Văn Phòng Đang Diễn Ra ?
