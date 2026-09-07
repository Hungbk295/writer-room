# Writer — Luồng tối giản và vai trò các pack

> Cập nhật: 2026-09-07 · **Đề xuất sau review, chưa triển khai vào runtime.**
> Hướng chốt: research một vòng → hook hiện có → outline được duyệt → viết theo beat + human → restyle theo persona/channel → kiểm cuối.
> Khuyến nghị: **2 agent, 8 lượt chuẩn từ đầu; 5 lượt nếu đã có topic pack và hook.**

## 1. Kết luận review

**CONDITIONAL PASS.** Luồng này phù hợp để tối giản Writer, với ba điều kiện:

1. Outline là sản phẩm sáng tác đầu tiên và được Editor duyệt trước khi viết thân bài.
2. Học từ pack phải tạo ra lựa chọn mới có lý do; đổi từ, đổi tên nhân vật hoặc đảo thứ tự beat chưa đủ chứng minh khác biệt.
3. Bản sau restyle phải qua kiểm cuối. Không lấy kết quả kiểm bản nháp làm bảo đảm cho bản đã viết lại.

Trong tài liệu này, “human” là cách người kể suy nghĩ và phản ứng, không phải một bước bắt người vận hành sửa tay. Persona pack và channel style được tổ chức thành **một channel pack về mặt sử dụng**, gồm danh tính đã duyệt và cách thể hiện của kênh. Chưa yêu cầu gộp file ngay.

## 2. Luồng mục tiêu

```text
Brief + đối tượng xem + chủ đề
  │
  ▼
RESEARCH — một vòng thu thập, đọc và tổng hợp
  → Topic pack: nguồn + bằng chứng + bài học triển khai + giới hạn
  │
  ▼
HOOK — giữ skill/cơ chế hiện có: clarify → suggest → người chọn
  → Hook đã chọn và lời hứa cần trả ở cuối bài
  │
  ▼
STUDY + OUTLINE — học pack, thử các góc nhìn, chốt outline
  → Luận điểm, payoff, chuỗi beat, bằng chứng, khác biệt so với nguồn
  │
  ▼
OUTLINE REVIEW — Editor đọc độc lập
  ├─ đạt → khóa outline
  └─ lỗi → sửa có giới hạn hoặc dừng kèm note
  │
  ▼
WRITE — triển khai toàn bài theo từng beat
  đọc Mode pack; áp dụng Human pack tại chỗ cần
  → Draft bám outline + bản đồ claim/beat
  │
  ▼
GATE DRAFT — kiểm bằng code trước khi chuyển bước
  │
  ▼
RESTYLE — một lượt viết lại toàn bài theo persona/channel pack
  → Final candidate; giữ luận điểm, beat, bằng chứng và payoff
  │
  ▼
FINAL CHECK — gate bằng code + Editor kiểm bản sau restyle
  ├─ đạt → DONE, xuất đúng phiên bản đã kiểm
  └─ lỗi → sửa có giới hạn + kiểm lại, hoặc dừng kèm note
```

Hook đứng trước outline để chốt lời hứa với người xem. Đây chưa phải lượt viết mở bài hoàn chỉnh. Outline quyết định cách trả lời lời hứa đó; nếu nguồn không đỡ được hook thì trả note để chọn lại, không ép outline chứng minh nó.

Human nằm trong WRITE. RESTYLE là lượt viết lại toàn bài cuối cùng; nếu kiểm cuối phát hiện lỗi, chỉ sửa đúng phạm vi lỗi, không mở thêm vòng restyle toàn bài.

## 3. Mỗi pack làm việc gì

Các đường dẫn dữ liệu dưới đây tương đối với `writer-room-data/`.

| Pack | Vai trò trong luồng mới | Đọc lúc nào | Ranh giới |
|---|---|---|---|
| **Topic pack** | Học chủ đề, biết nguồn nói gì, học cách nguồn triển khai và chỗ có thể làm khác | Hook, STUDY + OUTLINE; Editor truy xuất bằng chứng | Quote có nguồn chứng minh nguồn đã nói gì; không tự chứng minh phát biểu đó đúng |
| **Hook skill / library** — `hook-libraries/anh-ba-ong-chu.md` | Tạo hook theo cơ chế đang dùng | HOOK | Không tự cấp fact, số liệu hoặc lời hứa ngoài khả năng của pack |
| **Mode pack** — `writer/mode-pack.md` | Chọn hình thức và cách thực hiện từng beat | OUTLINE đọc định nghĩa; WRITE đọc phần triển khai liên quan | Ví dụ dạy kỹ thuật, không cấp dữ kiện cho chủ đề đang viết |
| **Human pack** — `writer/human-pack.md` | Học cơ chế suy nghĩ, tự sửa, do dự, giới hạn hoặc bộc lộ lập trường; vận dụng sang tình huống khác | OUTLINE đánh dấu nơi có lý do; WRITE thực hiện | Không sao chép câu mẫu, dựng tiểu sử hoặc thêm vẻ khiêm tốn cho có |
| **Persona / channel pack** — hiện là `writer/persona-pack.md` + `channel-styles/<channel>.md` | Danh tính, lập trường đã duyệt, giọng và cách xưng hô của kênh | OUTLINE/WRITE nhận giới hạn danh tính ngắn; RESTYLE đọc toàn bộ phần áp dụng | Style không được sửa cấu trúc đã khóa, đổi fact hoặc biến ví dụ giả định thành trải nghiệm thật |

**General pack và Sổ tay biên tập:** luồng đích không thêm hai đầu vào độc lập cho người vận hành. Chuyển khẩu vị, ranh giới và KEEP/AVOID đã được chủ kênh duyệt vào channel pack; chuyển kỹ thuật triển khai dùng chung vào Mode/Human pack. TRY còn là thử nghiệm, không tự trở thành luật. Loại trùng lặp trước khi bỏ dependency General pack ở runtime; hiện code vẫn còn dùng nó.

Không chuyển khẩu vị của kênh tham khảo thành bản sắc của kênh mình một cách tự động. Phần persona chưa duyệt không được dùng làm lời tự thuật. Nếu channel pack có style hợp lệ nhưng chưa có trải nghiệm được duyệt, vẫn restyle được bằng giọng kênh và bỏ phần tự thuật đó.

## 4. Research một vòng: tạo pack để học, không chỉ gom transcript

Một vòng là một đợt research theo brief, có thể gồm nhiều lần gọi công cụ để tìm, lấy và kiểm nguồn. Không đồng nghĩa với một HTTP request hay chắc chắn một model API call. Sau khi chốt pack, Writer không tự mở research mới trong từng beat.

Topic pack cần có bốn phần trong cùng một gói:

| Phần | Nội dung tối thiểu | Cách dùng |
|---|---|---|
| **Nguồn và phạm vi** | ID/link, ngày thu thập, vị trí trích dẫn; nguồn gốc chung nếu nhiều bài cùng dẫn một nơi | Truy xuất được; không đếm các bản chép lại thành bằng chứng độc lập |
| **Bằng chứng** | Claim ID, quote nguyên văn, nguồn; điều kiện, điểm mâu thuẫn/chưa rõ và trạng thái kiểm chứng | OUTLINE chọn claim rồi lập ledger cho bài; gate đối chiếu theo claim/nguồn |
| **Bài học triển khai** | Nguồn đặt câu hỏi thế nào, mở nút thắt bằng gì, nối beat ra sao, payoff hoạt động ở đâu; ví dụ kèm giải thích | Học cơ chế kể và lập luận; chỉ ra điều nên học, nên tránh và góc đã quá quen |
| **Giới hạn** | Điều pack chưa trả lời được; claim không nên dùng; phạm vi kết luận được phép | Thu hẹp bài hoặc dừng có note khi thiếu bằng chứng cốt lõi |

Research không chốt sẵn outline cho bài mới. Bài học về nguồn là quan sát có dẫn chứng; ý tưởng vận dụng sang bài mới thuộc lượt OUTLINE.

Khi research YouTube, dùng Writer Room Spy MCP trước theo `AGENTS.md`, lưu run ID và evidence sau khi Spy hoàn tất. Transcript ASR là tư liệu cần kiểm: tên, đơn vị hoặc con số nghe chưa rõ phải đánh dấu, không tự sửa thành một fact chắc chắn. “Có trong pack” và “đã kiểm chứng” là hai trạng thái khác nhau.

Pack được chốt phiên bản/hash và phạm vi thời gian trước HOOK. Nếu sau đó thiếu nguồn quyết định luận điểm, dừng để bổ sung có chủ đích ở phiên bản pack mới hoặc chọn phạm vi hẹp hơn. Không âm thầm research lặp. Dùng lại pack chỉ khi còn phù hợp brief và độ mới của dữ kiện.

## 5. Outline là nơi dành công sức nhiều nhất

STUDY và OUTLINE có thể nằm trong **một lượt Writer**, nhưng phải có đầu ra riêng để kiểm. Lượt này không viết thân bài.

Trình tự:

1. Đọc pack, ghi ngắn bài học sẽ vận dụng và cách triển khai của nguồn cần tránh lặp lại.
2. Thử **2–3 hướng luận điểm ngắn** bằng lateral thinking, chỉ ra bằng chứng ủng hộ và điều có thể bác bỏ mỗi hướng. Không viết 3 outline đầy đủ.
3. Chọn hướng phù hợp người xem và bằng chứng; ghi lý do loại các hướng còn lại.
4. Chốt payoff và sự thay đổi trong cách người xem hiểu vấn đề, rồi đi ngược để lập chuỗi beat trả lời hook.
5. Tự đối chiếu với nguồn và giao outline cho Editor duyệt độc lập.

### Lateral thinking phải thay đổi cách hiểu

Có thể đổi câu hỏi, chủ thể, đơn vị nhìn, thang thời gian, thử trường hợp đảo ngược hoặc cực trị. Phải giải thích phép đổi đó cho thấy điều gì mà cách nhìn ban đầu che khuất. Không ép mỗi beat có một cú bất ngờ; cú lật được chọn phải phục vụ luận điểm chung.

Ví dụ minh họa về kỹ thuật, không phải kết luận từ research:

- Góc quen: “Nghề ít cạnh tranh nào đáng làm?”
- Đổi câu hỏi/chủ thể: “Ít cạnh tranh vì khách khó tìm người, hay vì người làm khó trụ lại?”
- Hệ quả cho outline: cần phân biệt hai cơ chế và bằng chứng cho từng cơ chế; không chỉ thay danh sách nghề bằng một danh sách khác.

### Outline bàn giao

| Cấp | Nội dung bắt buộc |
|---|---|
| Toàn bài | Hook và lời hứa; người xem nghĩ gì trước/sau; luận điểm; payoff; sợi dây xuyên suốt; điều chủ động cắt |
| Học và làm khác | Bài học nào lấy từ nguồn nào; cơ chế được vận dụng; ít nhất **2 khác biệt có ý nghĩa** về câu hỏi, góc nhìn, đường lập luận hoặc cách trả payoff |
| Mỗi beat | Chức năng; thông tin mới; thay đổi trong nhận thức/lập luận; vì sao đứng ở đây; mode và cách triển khai; vật/hình ảnh neo; phép lật và tác dụng nếu có |
| Căn cứ mỗi beat | Claim/evidence ID, giới hạn cần nói; hoặc nhãn ví dụ giả định/suy luận/trải nghiệm đã duyệt. Không ép beat chuyển tiếp có fact mới |
| Chỗ cần human | Tình huống thật trong lập luận → cơ chế Human pack phù hợp → cách vận dụng. Có thể để trống |

**Editor chỉ cho qua khi:** luận điểm có căn cứ; hook được trả; beat tiến triển và không chỉ nhắc lại; khác biệt với nguồn có thể chỉ ra bằng nội dung; lateral thinking tạo góc hiểu mới mà không suy diễn quá bằng chứng.

Đổi tên, paraphrase hoặc đổi chuỗi mode không đủ đạt. Quy tắc hiện tại “không chép 3 mode liên tiếp của nguồn” chỉ là dấu hiệu máy có thể kiểm, không thay thế đánh giá tính khác biệt. Yêu cầu “phép lật nếu có” ở bảng trên là thay đổi đề xuất; schema hiện tại vẫn bắt `turn` ở mọi beat.

Sau duyệt, khóa phiên bản outline. WRITE được làm rõ câu chữ và nối đoạn; thay luận điểm, thứ tự/chức năng beat hoặc payoff phải quay lại checkpoint outline. Không cho phép viết xong rồi mới hợp thức hóa một outline khác bằng `outlineChanges`.

## 6. Viết theo beat, dùng human tại chỗ, restyle một lần

**WRITE:** một Writer triển khai các beat tuần tự trong một lượt toàn bài, giữ liên kết và ngân sách độ dài. Mỗi beat thực hiện đúng mode đã chọn; không cần một agent hoặc một lượt riêng cho từng beat.

**Human:** học chuyển động suy nghĩ từ ví dụ rồi áp dụng bằng chất liệu của bài. Chẳng hạn, học cách “tự sửa cách diễn đạt để chính xác hơn” rồi thực hiện trên một câu của bài đang viết; không mượn câu thú nhận hoặc câu chuyện đời của host nguồn. Chỉ dùng khi có nguyên nhân thật. Giữ giới hạn của Human pack hiện hành: tối đa 3 cử chỉ, mỗi loại tối đa một lần; 0 cũng hợp lệ.

Vận dụng tương tự không cấp quyền nói “tôi từng…” về một sự kiện mới. Ví dụ giả định phải được nhận diện là giả định; suy luận phải giữ điều kiện; trải nghiệm cá nhân phải nằm trong persona đã duyệt và đúng phạm vi được phép dùng.

**RESTYLE:** nhận draft, outline đã khóa, ledger, các nhãn giả định/giới hạn và channel pack đã chốt. Chỉnh xưng hô, từ vựng, nhịp câu, sắc thái và cách chuyển lời. Giữ chức năng/thứ tự beat, mode, cú lật, hook promise, payoff, nội dung claim và sự quy thuộc lời kể. Không thêm cảnh hoặc nhân vật mới để ép đúng style.

Đưa các yêu cầu về cấu trúc hiện còn trong channel style về OUTLINE/Mode pack. Đưa cơ chế human về Human pack. Chỉ giữ hướng dẫn thể hiện giọng ở lượt cuối; phần danh tính và ranh giới được báo ngắn từ đầu để tránh viết một bài rồi mới phát hiện trái persona.

## 7. Cần bao nhiêu agent, bao nhiêu lượt?

### Cấu hình mặc định: 2 agent

| Agent | Công việc | Ranh giới |
|---|---|---|
| **Writer** | Research, dùng hook skill, study/outline, viết theo beat + human, restyle, sửa lỗi | Không tự cấp PASS cho outline hoặc bản cuối |
| **Editor** | Duyệt outline; kiểm bản sau restyle và bản sửa | Context mới mỗi lần review, có nguồn/ledger và artifact cần đối chiếu; trả lỗi cụ thể, không viết một bài cạnh tranh |

Orchestrator là code điều phối thứ tự, lưu artifact, chạy gate và đếm lượt; không cần một LLM manager riêng. Hai agent là hai vai thực thi tách biệt, không bắt buộc hai nhà cung cấp model khác nhau.

Một bài có phụ thuộc tuần tự nên thông thường chỉ **1 agent hoạt động tại một thời điểm**. Chạy Writer/Editor đồng thời trên bản chưa chốt làm kết quả review mất hiệu lực. Chỉ cân nhắc agent Research thứ ba khi chuẩn bị nhiều topic pack cho nhiều bài song song; không cần cho luồng một bài này.

### Ngân sách lượt chuẩn

“Lượt” ở đây là một nhiệm vụ giao agent và nhận artifact, không phải số tool call, số beat hay tổng model API call bên trong CLI.

| Lượt | Agent | Nhiệm vụ | Đầu ra |
|---|---|---|---|
| 1 | Writer | RESEARCH | Topic pack chốt, có bài học và giới hạn |
| 2 | Writer dùng hook skill | HOOK CLARIFY | Câu hỏi làm rõ theo cơ chế hiện có |
| 3 | Writer dùng hook skill | HOOK SUGGEST | Hook candidates để người chọn |
| 4 | Writer | STUDY + OUTLINE | Bài học, các hướng ngắn, outline đề xuất |
| 5 | Editor | OUTLINE REVIEW | PASS hoặc repair notes |
| 6 | Writer | WRITE + HUMAN | Draft theo outline đã duyệt |
| 7 | Writer | RESTYLE | Final candidate theo persona/channel |
| 8 | Editor | FINAL CHECK | PASS hoặc repair notes trên đúng bản sau restyle |

- **Từ đầu:** 8 lượt chuẩn, gồm 6 lượt Writer và 2 lượt Editor.
- **Có pack còn dùng được:** 7 lượt. **Có cả pack và hook đã chọn:** 5 lượt.
- Research chạy một vòng; study diễn ra ở lượt outline trên pack đã chốt, không thu thập lại nguồn.
- Người trả lời/chọn hook và gate bằng code không tính vào lượt agent. Giữ hai lượt hook hiện tại; không giả định gộp chúng để báo số thấp hơn.
- Đây là ngân sách thiết kế, chưa phải số đo E2E hoặc cam kết thời gian. Công cụ research và model API calls cần được ghi riêng khi chạy thử.

### Sửa lỗi có giới hạn

Cho phép **tối đa một vòng sửa tự động cho toàn pipeline**, dùng ở checkpoint đầu tiên có lỗi sửa được: Writer sửa **+1 lượt**, Editor kiểm lại **+1 lượt**, gate code chạy lại. Nếu dùng hết quyền sửa ở outline, lỗi mới ở draft/final sẽ dừng có note.

Như vậy: **tối đa 10 lượt nội dung từ đầu**, hoặc **7 lượt khi đã có pack + hook**. Thiếu bằng chứng cốt lõi, phải đổi hook/luận điểm, hoặc còn lỗi sau sửa thì dừng; không tự khởi động lại pipeline trong cùng ngân sách. Sửa bản cuối chỉ là sửa cục bộ, không restyle toàn bài lần hai.

Lỗi hạ tầng/timeout không được tính là một lượt sáng tác thành công. Nếu resume cần gọi lại agent, ghi lượt và chi phí thực phát sinh riêng; không che chúng trong con số 8/10 và không retry nội dung ẩn.

## 8. Các cửa kiểm bắt buộc

| Cửa kiểm | Code kiểm được | Editor phải đọc và kết luận |
|---|---|---|
| Trước WRITE | Artifact outline đủ trường; claim ID hợp lệ; quote khớp đúng nguồn; pack/outline hash đúng | Luận điểm được bằng chứng hỗ trợ; hook/payoff khớp; khác biệt có ý nghĩa; lateral thinking hợp lý; persona phù hợp |
| Sau WRITE, trước RESTYLE | Độ dài; beat mapping; số/tên/tiền; phép tính có nhãn và đầu vào; nguồn/phiên bản đúng | Chưa thêm lượt review ở đây; phần ngữ nghĩa được kiểm trên bản cuối |
| Sau RESTYLE hoặc sửa | Gate lại trên bản mới; cập nhật anchor theo câu chữ mới; kiểm danh tính và artifact hash | Không thêm/đổi claim, điều kiện, phủ định, nhân quả, đơn vị, người phát ngôn; human có cơ sở; giữ outline và đạt giọng kênh |

Gate chuỗi/ký tự không chứng minh ngữ nghĩa đúng. Số xuất hiện trong ledger chưa đủ: phải đúng chủ thể, đơn vị, thời điểm và mức khẳng định. Ví dụ “có thể” bị restyle thành “chắc chắn” phải FAIL dù mọi con số giữ nguyên.

Repair note cần có: **vị trí/beat hoặc câu trích → lỗi → bằng chứng/ràng buộc bị vi phạm → sửa cụ thể → điều kiện kiểm lại**. Không trả note chung như “thiếu human” hoặc “chưa lateral”. DONE chỉ gắn với hash của bản thực sự qua gate và Editor; sửa sau PASS làm mất hiệu lực kết quả đó.

## 9. Khoảng cách với code hiện tại và thứ tự triển khai

Đối chiếu source tại `780eafc` và working tree ngày 2026-09-07; không xác nhận phiên bản daemon đang chạy.

| Ưu tiên | Hiện tại trong source | Thay đổi cần làm |
|---|---|---|
| P0 | `study-orchestrator.ts` vẫn dispatch một STUDY trả coverageMap + ledger + outline; sau đó WRITE ngay | Bổ sung bài học vào topic pack; thêm checkpoint OUTLINE REVIEW trước WRITE |
| P0 | `restyle-v1` là thao tác tùy chọn sau DONE, validator không chạy factual gate | Đưa RESTYLE vào đường hoàn tất bắt buộc; chỉ DONE sau gate và Editor kiểm final candidate |
| P0 | `evaluateWriterDraftVerdict` cho bản REPAIR đi DONE khi code gate sạch, không có Editor kiểm lại | Mọi bản sửa phải quay lại cửa kiểm thích hợp; một ngân sách sửa toàn run |
| P1 | Channel style còn yêu cầu về nhân vật, kiến trúc bài và human; Persona là ledger danh tính riêng | Phân lại nội dung pack; giữ identity guard từ đầu, style đầy đủ ở cuối; bảo toàn bộ lọc persona đã duyệt |
| P1 | WRITE còn đọc General pack và Sổ tay riêng; cho khai thay đổi outline sau viết | Chuyển nội dung đã duyệt về đúng pack; khóa outline và kiểm drift giữa outline/draft/final |
| P1 | Có module `research-map.ts` và `story-planning.ts`, nhưng chưa nối DIVERGE/RESEARCH/CONFRONT vào lifecycle đang dùng | Tái dùng phần kiểm bằng chứng phù hợp; thử các hướng trong lượt OUTLINE, không mặc định thêm ba stage/agent |

Tên stage, artifact bổ sung và giới hạn mới ở tài liệu này là hợp đồng mục tiêu, chưa phải API/schema đã có. Khi triển khai, đồng bộ [main-loop plan](plans/writer-main-loop-plan.md), [SDD 006](specs/006-writer-beat-grammar/solution-design.md), [SDD 007](specs/007-writer-human-pack/solution-design.md) và [bản nháp orchestrator](plans/writer-orchestrator-mcp-multiagent-design.md); bản nháp orchestrator còn đề xuất restyle ngoài gate, trái quyết định mới ở đây.

### Nghiệm thu luồng mới

1. Một bài sạch đi đúng 8 lượt từ đầu, hoặc 5 lượt với pack + hook có sẵn; không có WRITE trước outline PASS.
2. Topic pack có đủ bốn phần; mỗi claim dùng trong bài truy xuất được; mỗi lựa chọn học từ nguồn có giải thích cách vận dụng và khác biệt.
3. Thử outline chỉ đổi tên/đảo mode của nguồn: Editor từ chối với note cụ thể. Outline đạt có ít nhất hai khác biệt có ý nghĩa và một phép đổi góc nhìn giải thích được.
4. Thử human tự nhận trải nghiệm không được duyệt: không được PASS. Vận dụng cơ chế suy nghĩ sang tình huống giả định rõ nhãn có thể được chấp nhận.
5. Thử restyle đổi mức chắc chắn, bỏ điều kiện hoặc đổi người nói: không DONE dù gate số/tên sạch. Chỉ export bản đã kiểm cuối.
6. Lỗi sửa được dùng đúng +2 lượt; lỗi còn lại dừng. Log đủ lượt agent thực tế, tool/model calls nếu có telemetry, phiên bản pack và hash artifact.

**Trạng thái review: CONDITIONAL PASS cho thiết kế; chưa nghiệm thu runtime.**
