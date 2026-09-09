# Input, record và bàn giao research

Đọc cùng SKILL.md. Các cấu trúc dưới đây là hợp đồng file cho skill; không phải API
hay schema đã được daemon Writer triển khai. Coordinator kiểm chúng trước khi bàn giao.

## 1. Scope và pack input

Scope gồm `nicheId`, `language`, `region` và `formatScope`. `reportLanguage` chỉ điều
khiển báo cáo; không đổi ngôn ngữ quote hoặc bộ craft. Hai bộ riêng:

| Scope | Human moves | Mode pack |
|---|---|---|
| finance / vi | Cử chỉ và ví dụ tiếng Việt trong phạm vi tài chính đã khai báo | Mode, phép lật, khuôn với hướng dẫn/ví dụ tiếng Việt |
| pov-finance / en | Cử chỉ và ví dụ tiếng Anh thu từ niche POV Finance | Mode, phép lật, khuôn với hướng dẫn/ví dụ tiếng Anh trong niche này |

Đích lưu pack đề xuất cho bước tạo/enhance sau research:

```text
writer-room-data/craft-packs/<nicheId>/<language>/
  human-moves.md
  mode-pack.md
```

Chỉ đưa path có thật vào input; tên thư mục đề xuất không chứng minh pack đã tồn tại.
Mỗi pack cần metadata: packId, kind, nicheId, language, formatScope, version. Nếu là
file legacy chưa có metadata, coordinator ghi scope được người dùng xác nhận trong
run manifest, không suy scope từ tên file. Lưu content hash và snapshot bản đã đọc.

Một pack reference trong run.json gồm:

```text
kind: human-moves | mode-pack
state: available | absent
packId, version, hash, originalPath, snapshotPath: giá trị thật hoặc null khi absent
nicheId, language, formatScope
```

Luôn có hai reference, kể cả khi một/both absent. Đường dẫn trong prompt worker phải
là đường dẫn tuyệt đối đã resolve. Snapshot nằm trong run, không đọc file live có thể
bị sửa giữa các worker. File khác scope không được fallback thành pack đúng scope.

### enhance — đã có bộ đúng phạm vi

Worker gắn flag đọc đầy đủ hai snapshot: định nghĩa, ví dụ, phạm vi và điều kiện không
dùng. Pack giúp phân loại, không chứng nhận hiệu quả. Cho phép `unmapped` và
`variant_candidate`; không ép mọi nguồn vào các ID có sẵn. Ghi packId/version/hash
trên mapping để skill enhance biết agent đã đối chiếu bản nào.

### bootstrap — niche mới hoặc còn thiếu một pack

Không chờ pack xuất hiện mới research. Chỉ dùng định nghĩa phân loại chung:

- Human move: một thao tác ở lời kể/tương tác với người nghe có thể chỉ ra bằng câu
  nguồn và ngữ cảnh. Ghi thao tác nhìn thấy, không tự kết luận nó tạo cảm giác chân thật.
- Mode: cách một đoạn/beat được triển khai, ví dụ dựng cảnh, trình bày phép tính,
  nêu và trả lời phản đối. Đây là gợi ý nhận diện, không phải danh sách bắt buộc.
- Turn: một thay đổi góc nhìn/đơn vị/chủ thể/câu hỏi có thể chỉ ra trước và sau.
- Frame: đối tượng hoặc cấu trúc tái xuất hiện xuyên bài; phải lưu các vị trí liên quan.
- Chưa rõ: giữ đoạn có nguồn và mô tả bằng chữ, không gán loại chắc chắn.

Với pack absent: mapping có packId/version/hash null, matchedId null và tag tạm bằng
ngôn ngữ đích. Nếu một pack đã có, vẫn dùng snapshot đó để đối chiếu loại tương ứng;
đầu ra của loại còn thiếu tiếp tục là bootstrap. Không bịa pack version hoặc ID chính thức.

POV Finance EN bootstrap giữ quote EN, viết mô tả/tag ứng viên EN. Không dịch bộ finance
VI thành bộ mới và không mặc định các giới hạn như tám cử chỉ, tối đa ba cử chỉ/bài,
hay sáu mode là luật chung cho niche EN. Không tìm đủ danh mục cho đẹp báo cáo.

### Human move chung niche và danh tính riêng kênh

Bộ human move chung niche chỉ chứa craft. Lập trường, danh tính, lời kể trải nghiệm
của một host không trở thành danh tính cho cả niche.

Legacy `writer/human-pack.md` có Phần A cử chỉ, B lập trường và C trải nghiệm. Khi
được dùng làm đầu vào craft finance/vi, coordinator snapshot Phần A và các ranh giới
áp dụng liên quan; ghi source section/hash. Không cấp B/C làm chuẩn chung cho worker.
Không đưa tên host, tiểu sử hay số tài sản tự khai vào rule mới.

## 2. Thư mục một run

```text
run.json
inputs/packs/                 # snapshot pack thực có
tasks/<taskId>/assignment.md
tasks/<taskId>/result.json    # trạng thái, coverage, output paths, lỗi
tasks/<taskId>/observations.jsonl
tasks/<taskId>/craft-flags.jsonl
sources/manifest.jsonl
sources/transcripts/          # raw captions + bản đọc có locator
queries.jsonl
keywords.jsonl
writer-input.jsonl
craft-flags.jsonl
rejected-records.jsonl
report.md
delta.json                    # run daily
```

Các file output rỗng được phép nếu task không tìm được record. result.json phải phân
biệt `complete_no_candidates` với chưa đọc xong/thiếu nguồn. Một worker sở hữu một
task directory; coordinator sở hữu file hợp nhất. Retry dùng attempt riêng, không
append mù vào output cũ. Mỗi record JSONL ghi hoàn chỉnh trước khi chuyển record tiếp.

run.json ghi taskId, phase, dependencies, input hashes, agent/runtime/model thực tế,
external run/team/terminal/dispatch IDs nếu có, budget, deadline và status của từng task.
Không ghi token/credential vào manifest hoặc prompt lưu trữ.

## 3. Query, source và keyword

Query record:

- queryId, exactQuery, language, region, requestedLimit, ordering, requestedAt.
- providerUsed, fallbackReason, localeHintsApplied và cache metadata thực trả về.
- rawResultPath, result video IDs/ranks, inScope IDs, exclusions kèm lý do; khi chưa
  xác định được scope thì ghi uncertain. Query chưa chạy không được giả là query zero-result.

Source record:

- sourceId, videoId, channelId, originalTitle, URL, queryIds, spyRunIds thực đã hoàn tất.
- acquisitionProvider, acquiredAt, metadataObservedAt, publishedAt, viewCount hoặc null.
- rawTranscriptPath/hash, readableTranscriptPath/hash, transcriptLanguage, track/source,
  locator type và status: ready | missing | partial | wrong_language.
- Phạm vi đã đọc, các field thiếu và giới hạn caption. Nguồn được sao chép nguyên văn
  cần originGroup nếu đã kiểm; chưa kiểm thì originGroup null, không coi mỗi kênh là
  nguồn độc lập mặc định.

Tách researchRunId, agent run ID và spyRunId. Transcript lấy trực tiếp bằng yt-dlp
có spyRunId null cho lần thu đó dù metadata của video có Spy run riêng.

Keyword record:

- keywordId, queryIds, observedPhrases và source video IDs cho từng phrase.
- proposedClusterId/label, assignmentBasis: title | transcript | both;
  căn cứ cụ thể và classificationStatus: proposed | ambiguous.
- scopeStatus: in_scope | out_of_scope | uncertain; lý do mô tả.
- discoveryStatus: observed | no_in_scope_result | not_searched | source_missing.
- Các count/median nếu có phải ghi sample IDs, n, cohort, thời điểm và cách tính.

Không đổi no_in_scope_result thành "chưa ai làm"; không đổi view thấp thành "không
có cầu". Không gọi số video/kênh trong mẫu là search volume.

## 4. Craft flag

Mỗi flag là một ứng viên, không phải một rule được duyệt. Field bắt buộc:

| Field | Ý nghĩa |
|---|---|
| flagId, researchRunId, taskId | ID ổn định để hợp nhất và truy về worker |
| nicheId, language, formatScope | Phạm vi đích của ứng viên |
| sourceId, videoId, channelId | Liên kết source manifest; scope nguồn ghi trong manifest |
| acquisitionProvider, spyRunIds | Nguồn thu thật; [] nếu không có Spy run phù hợp |
| transcriptPath, transcriptHash | Bản văn được trích, lưu bền vững |
| segments | Một hoặc nhiều đoạn có quote nguyên văn và locator |
| context | Đoạn trước/sau hoặc related segment refs; thiếu ghi rõ |
| observation | Thao tác có thể nhìn thấy trong nguồn, viết bằng language đích |
| mapping | kind, proposedTag, matchedId, relation và pack reference |
| reviewFocus | Đặc điểm cần bước enhance xem xét, không khẳng định hiệu quả |
| limitations | Giới hạn nguồn, vị trí, phạm vi đã đọc, phần chưa xác minh |
| evidenceStatus | verified | needs_source_check |

Mỗi segment có `quote`, `startSec`, `endSec`, `locator` và `locatorType`.
locatorType là timestamp/cue/paragraph/line; startSec/endSec null khi nguồn không có
timestamp thật. Quote phải khớp đoạn đã chỉ ra, không nối hai đoạn xa nhau thành một
quote liên tục. Callback/phép lật dùng nhiều segment và nêu quan hệ quan sát được.

mapping.kind: human_move | mode | turn | frame | uncertain.
mapping.relation: existing_example | variant_candidate | unmapped.
mapping có packId/version/hash và matchedId thật khi đối chiếu; trường chưa có để null.
Mọi mapping vẫn là đề xuất; evidenceStatus verified chỉ xác nhận nguồn/quote/locator,
không có nghĩa tag đúng hoặc rule được duyệt.

Không có quote đọc được thì không xuất flag verified. File OCR/auto-caption lỗi số
vẫn giữ chữ nguồn và ghi lỗi nghi ngờ; không chữa lại rồi gọi là nguyên văn. Nguồn
khác ngôn ngữ/scope chỉ ghi trong danh sách ngoài scope để review riêng, không đưa vào
queue của bộ đích bằng cách dịch âm thầm.

Giới hạn của lời ghi nhận:

- Được: mô tả câu nguồn tự sửa cách gọi, đưa phép trừ qua các bước, hoặc nhắc lại vật
  đã xuất hiện ở đoạn đầu; dẫn đủ segment.
- Chưa được: "làm người nghe tin hơn", "giữ retention", "tạo view", "cách này hay",
  "chỉ dùng tối đa N lần" nếu đang tự suy ra rule từ mẫu.

View chỉ là metadata độc lập. Khi cần bổ sung mẫu, lấy nhiều đoạn/kênh và các dải view
khác nhau trong budget; không dùng view như nhãn chất lượng craft. Không chỉ đọc đoạn
mở nếu nhiệm vụ cần quan sát thân/kết; ghi readCoverage và phần chưa đọc.

## 5. Kiểm và bàn giao

Coordinator kiểm source path/hash, quote khớp locator, scope và pack refs. Record lỗi
đưa vào rejected-records với lý do, giữ output thô của worker. Hai phân loại khác nhau
thì lưu ambiguity hoặc đối chiếu lại nguồn; không ép ra một kết luận về nguyên nhân.

Gom trùng theo videoId + transcriptHash + segment locators + loại/tag ứng viên; giữ
các mapping khác nhau khi có lý do, không nhân nhiều bản clone thành nhiều bằng chứng
độc lập cho rule. Không sửa quote để gom trùng.

### Writer input

Mỗi dòng writer-input.jsonl gồm keywordId/clusterId, observed phrase, originalTitle,
videoId/sourceId, source readiness, căn cứ gán cụm và phần còn thiếu. Đây là nguyên liệu
để bước sau chọn angle/title. Không có điểm "tiềm năng", khuyến nghị đăng hay title mới.
Chưa tự tạo Source Pack, post hoặc run Writer. Fact từ video vẫn cần quy trình nguồn
của bài cụ thể; báo cáo research không phải factsLedger.

### Enhance input

Bàn giao craft-flags đã kiểm cùng run.json, source manifest, transcript/context và
snapshot pack. Bootstrap chuyển ứng viên cho bước tạo bộ đầu tiên; enhance chuyển
ví dụ/biến thể/unmapped cho bước cập nhật bộ có sẵn. Không tự promote thành rule.

Daily delta liên kết previousRunId, input pack hashes, added/updated/unchanged record
IDs và lý do thay đổi quan sát được. Một flag chuyển tag sau khi pack đổi phải giữ
mapping cũ theo version; cập nhật view không tự tạo một craft flag mới. Không có ứng
viên mới thì ghi rõ, không ép tạo thêm move/rule mỗi ngày.

## 6. Ranh giới tích hợp Writer hiện tại

Writer hiện dùng loader cố định `writer/human-pack.md` và `writer/mode-pack.md`; mode/
turn IDs nằm trong `packages/daemon/src/writer/video-plan.ts`. Chỉ tạo thư mục pack
theo niche không làm daemon tự chọn bộ mới.

Khi triển khai bước tích hợp riêng, cần resolver theo niche/language/format; chọn và
pin version/hash cho từng run; không fallback EN sang VI; cập nhật schema/prompt/gate
nếu danh mục mode/turn thay đổi; giữ danh tính kênh riêng với craft chung niche. Đây
là yêu cầu tích hợp, chưa phải capability của skill hoặc daemon.
