<!-- version: 1 -->

Nguồn chuẩn của cử chỉ (gestures) giờ là `writer/human-pack.md` (SDD 007) — file này
chỉ còn phục vụ skill restyle, không phải input của WRITE/REPAIR.

# Style: human-moves

Soạn từ 7 move đã mine sẵn trong TASTE DNA của `writer-room-data/general-packs/hieu-tv.md`
(dòng 17-63), đối chiếu lại nguyên văn với transcript gốc trong
`writer-room-data/spy/hieu-tv-transcripts/`. Style này KHÔNG lấy khẩu vị "kênh Sói Tài Chính"
hay "kênh của tôi" — nó mã hoá 4 trong 7 move đó thành công cụ restyle: cách một video làm
người xem tin "có một người thật đang nói", không phải cách nó chọn từ xưng hô hay dàn nhân
vật. Bốn move còn lại (steelman, không phán xét, tự đưa mình ra làm case, số có nhãn) đã có
chỗ đứng ở style khác hoặc ở luật chung của pipeline — không lặp lại ở đây.

Mỗi mục neo vào câu trích **nguyên văn** kèm số file/videoId. Tóm tắt lại là mất khẩu vị.

## Áp dụng — đọc trước khi dùng bất kỳ move nào

- **Mỗi bài chỉ áp 2-3 move, KHÔNG ép đủ bộ bốn.** Chọn move hợp với chất liệu đã có sẵn
  trong `finalScript`/ledger của bài đó — không phải move nào cũng có chỗ đứng trong mọi bài.
  Một bài liệt kê thuần (kiểu entry 07 trong general pack) có thể chỉ hợp move 2 và move 4;
  một bài không có công thức/tỉ lệ nào thì move 4 không có gì để đẩy tới cực trị.
- **Không thêm fact mới.** Mọi số liệu, case, tỉ lệ dùng để minh hoạ move phải lấy từ
  `factsLedger` hoặc đã có sẵn trong `finalScript` gốc. Move ở đây đổi **cách kể**, không đổi
  **cái được kể**.
- **Không nhận tên "Hiếu" hay tiểu sử thật của host.** Không xe, không bạn bè cụ thể, không
  chi tiết đời tư nào ngoài bài đang viết. Các move này học được từ cách host lập luận, không
  phải mượn danh host.
- **Không bê nguyên văn câu transcript vào bài.** Các quote trong file này minh hoạ NHỊP và
  KỸ THUẬT, không phải câu cho vay mượn. Viết lại bằng chất liệu của bài, chỉ giữ đúng cấu
  trúc chuyển động của move.

---

## Move 1 — Lập trường lệch chuẩn có chủ đích

**Hiệu ứng cần đạt:** nêu chuẩn chung của giới chuyên môn (hoặc lời khuyên phổ biến đã có sẵn
trong bài), rồi công khai đi lệch — và gọi thẳng đó là **trường phái cá nhân của người kể**,
không phải chân lý duy nhất. Sức nặng nằm ở chỗ người kể không giấu rằng mình đang lệch chuẩn;
họ đặt tên cho độ lệch đó.

> thường thì những người chuyên gia về tài chính họ sẽ khuyên các bạn là phải có đủ cho khoảng
> từ 3 tới 6 tháng nhưng mà tôi thì tôi theo một cái trường phái nó chắc chắn hơn do đó cho nên
> tôi luôn khuyên các bạn là cái khoảng dự phòng này nó nên là 1 năm (file `09`, videoId
> `a7kg3MTeT28`)

> chúng ta cũng đừng nghe lời của mấy ông chuyên gia xối dại mà trao đổi với nhau ngay từ buổi
> hẹn họ đầu tiên theo tôi thì ở cái thời điểm ban đầu chúng ta nên tập trung vào cái việc tìm
> hiểu về bản chất con người của nhau nhiều hơn (file `04`, videoId `9zgTJSq_cc0`)

> có những bước thoạt Nghe có vẻ hơi trái ngược với những lời khuyên của nhiều chuyên gia khác
> nhưng mà ít ra nó đã giúp cho tôi có thể ăn ngon Ngủ Yên ở trong suốt thời gian qua khi mà
> tất cả thị trường ở trên thế giới đều lao dốc đi xuống (file `115`, videoId `p-Qn4i7AYko`)

**Khi nào KHÔNG dùng:**
- Bài không có sẵn một "chuẩn chung" hay khuyến nghị phổ biến để lệch khỏi. Không được tự
  sáng tác câu "chuyên gia thường khuyên X" nếu nó không có trong `finalScript` gốc hoặc
  ledger — đó là bịa thêm một claim không có nguồn, kể cả khi nghe hợp lý.
- Bài chỉ có một luận điểm duy nhất, không có phe hay chuẩn nào đối lập. Ép move này vào sẽ
  tạo ra một cuộc tranh cãi giả, tự dựng lên rồi tự đá đổ.
- Chuẩn ngành trong bài gốc đã đủ mạnh và host/narrator đồng ý với nó — đừng lệch cho có,
  lệch phải có lý do thật đứng sau nó.

---

## Move 2 — Đường may lộ

**Hiệu ứng cần đạt:** tự sửa mình giữa câu ("thật ra nói vậy cũng không chính xác lắm..."),
thú nhận đổi kế hoạch, thú nhận chính mình từng gây hiểu lầm, hoặc cho phép người xem bỏ qua
một đoạn. Đây là chỗ lộ ra rằng bài đang được kể bởi một người đang nghĩ trong lúc nói, không
phải một văn bản đã hoàn thiện sẵn từ trước.

> tôi nói về những cái việc này nó nhiều tới mức mà nó dễ gây hiểu lầm là tôi đang kêu gọi các
> anh chị cứ sống khổ Hạnh ở cái mức vừa đủ để sinh tồn (file `09`, videoId `a7kg3MTeT28`)

> ban đầu khi mà có cái ý định chia sẻ với các anh chị về cái chủ đề này tôi đã dự định là sẽ
> chỉ gói gọn nó ở trong phạm vi một bài nhưng mà chia sẻ tới đây thì cái bài nói chuyện nó
> cũng đã khá dài rồi (file `09`, videoId `a7kg3MTeT28`)

> anh chị nào đã xem hai tập trước rồi thì có thể bỏ qua cái đoạn này (file `07`, videoId
> `PJPhR58LBYA`)

> thật ra nếu mà nói tiền nó cho phép tôi làm được việc này thì cũng không chính xác lắm nó
> một cách chính xác hơn thì tiền nó cho tôi được tự do (file `07`, videoId `PJPhR58LBYA`)

**Khi nào KHÔNG dùng:**
- Không dùng dày đặc — tối đa 1-2 lần một bài. Lặp lại nhiều hơn thì "đường may lộ" thành
  một tật nói, người nghe hết tin đó là thật.
- Không dùng để chữa một đoạn lập luận yếu. Move này giả định lập luận đúng nhưng cách trình
  bày ban đầu chưa gọn — không phải chỗ để giấu một lỗ hổng logic bằng cách giả vờ "tự sửa".
- Không đặt gần payoff/kết bài. Đường may lộ thuộc phần thân bài, nơi người nghe còn đang
  theo dõi lập luận hình thành; kết bài cần chắc chắn, không nên tự nghi ngờ ở câu chốt.

---

## Move 3 — Zoom vào một chữ

**Hiệu ứng cần đạt:** thay vì tổng kết cả một framework, dừng lại mổ xẻ **một chữ** trong một
câu khẩu hiệu hoặc mệnh đề đã quen thuộc — chỉ ra chính chữ đó mới là nơi chứa toàn bộ kỷ luật
hay toàn bộ điểm khác biệt.

> cái từ khóa đầu tiên mà tôi muốn tập trung tới đó là cái chữ có thể đây nó chính là cái giới
> hạn trong cái khả năng chi tiêu của chúng ta bởi vì nếu mà không có cái chữ này chúng ta
> không định nghĩa được là cái chữ có thể này nó đang nằm ở cái mức nào thì nó sẽ đẩy chúng ta
> đi vào cái vết xe đổ của rất là nhiều người khác đó là họ dùng toàn bộ thu nhập của họ để
> tiêu xài (file `09`, videoId `a7kg3MTeT28`)

> do đó nên các từ khóa ở đây chính là hai cái chữ giá trị Đó là một cái điểm mà có rất là
> nhiều người thường quên đó là tiền nó không phải là công cụ đại diện cho các mức năng lượng
> mà giống ta bỏ ra mà nó là cái công cụ đại diện cho những cái giá trị (file `137`, videoId
> `7ZN1hgjyYnc`)

> có một cái từ khóa được tôi lặp đi lặp lại rất là nhiều lần đó là cái từ tưởng tượng hay là
> cái từ hình dung (file `06`, videoId `9BIaI8G3mRU`)

**Khi nào KHÔNG dùng:**
- Bài không có sẵn một câu khẩu hiệu, châm ngôn, hay mệnh đề cô đọng nào đáng để mổ. Không
  được bịa một khẩu hiệu mới chỉ để có cái mổ — câu bị mổ phải đã tồn tại tự nhiên trong bài
  (thường là câu chốt của brief, hoặc một cụm hay lặp lại trong ledger).
- Bài đã có một ẩn dụ vận hành xuyên suốt (xem general pack, mục "ẩn dụ vận hành được") —
  đừng chạy song song hai kỹ thuật zoom khác nhau (một vào từ, một vào hình ảnh) trong cùng
  một đoạn, sẽ rối nhịp.
- Chữ được chọn để zoom phải mang thật sự trọng lượng lập luận. Nếu không tìm được chữ nào
  gánh được cả luận điểm, bỏ move này thay vì zoom gượng vào một chữ tình cờ.

---

## Move 4 — Stress-test cực trị

**Hiệu ứng cần đạt:** đẩy chính công thức, tỉ lệ, hay ngưỡng mà bài vừa đưa ra tới một input
vô lý — thu nhập cực cao, quy mô cực lớn — xem nó gãy ở đâu. Chỗ gãy đó, chứ không phải công
thức ban đầu, mới là nơi tiết lộ insight thật.

> tôi sẽ lấy một cái ví dụ thậm xưng đó là giả sử tới một lúc nào đó chúng ta làm ra được tới 1
> tỷ một tháng chẳng hạn thì theo cá nhân cái góc nhìn của tôi là chúng ta không thể nào mà
> chúng ta cứ dành hẳn ra 500 triệu cho những cái chi phí cố định cái số tiền đó là quá nhiều
> (file `09`, videoId `a7kg3MTeT28`)

> tôi lấy đại cái ví dụ là 100 triệu một tháng cho những cái chi tiêu căn bản (file `09`,
> videoId `a7kg3MTeT28`)

> nhưng nếu bằng cách nào đó mà chúng ta nuôi được 20 con hoặc là 100 con thì lúc đó lỡ mà có
> chết vài con thì chúng ta vẫn không lo (file `103`, videoId `DJr2hclTuLM`)

> cái rủi ro lớn nhất của Cách thứ hai đó là bò của chúng ta Nó có thể bị chết (file `103`,
> videoId `DJr2hclTuLM`)

**Khi nào KHÔNG dùng:**
- Bài không có một công thức, tỉ lệ, hay ngưỡng cụ thể nào để đẩy. Một bài thuần kể chuyện,
  không có con số vận hành được, không có gì để stress-test.
- Input cực trị dùng để test phải là một biến **đã có trong bài** (thu nhập, tỉ lệ %, ngưỡng
  thời gian…) được đẩy lên mức cao/thấp bất thường — không phát minh thêm một biến số hay
  thực thể mới không có trong ledger để nhồi vào phép thử.
- Nếu đẩy tới cực trị mà công thức gãy theo cách không nói được insight gì (chỉ gãy vô nghĩa,
  không lộ ra bài học), bỏ move này — đừng ép cho có "kịch tính".
