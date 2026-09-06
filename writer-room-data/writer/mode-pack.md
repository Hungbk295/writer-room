<!-- version: 1 -->

# Mode pack v1

Mỗi beat trong outline chọn đúng một lối trong một mode — không trộn hai lối trong cùng một
beat, không tự sáng tác lối thứ tư. Quote nguyên văn trong file này minh hoạ **nhịp** và
**kỹ thuật** của một mode hay một phép lật, không phải câu cho vay mượn: viết bằng chất liệu
của bài đang viết, chỉ giữ đúng cấu trúc chuyển động của quote. Số liệu, case, tên riêng nằm
trong quote là của đúng video nguồn — không được chép sang bài mới làm dữ kiện. File này
không nhận tên host ("Hiếu", "Anh Ba") vào lời văn của bài; hai tên đó chỉ xuất hiện ở nhãn
nguồn cuối mỗi quote, để người soạn và writer biết quote tới từ đâu.

---

## Mode: canh — Cảnh

**Hiệu ứng cần đạt:** dựng một khoảnh khắc cụ thể — người nghe thấy được giờ, thấy được nơi,
thấy một đồ vật và một động tác — trước khi bất kỳ kết luận nào được phát biểu.

**Phải có:** giờ hoặc nơi, một đồ vật, một động tác.
**Cấm:** kết luận trong cảnh — cảnh chỉ dựng, không giải thích ý nghĩa của chính nó.

### Lối A — Cảnh siết nợ trong khoang xe

> 1100 đêm, tiếng tin nhắn ngân hàng rung lên bần bật trong cabin thơm mùi da mới. Bạn ngồi đó
> nhìn vào màn hình báo số dư bị trừ sạch cho khoản trả góp trong khi ví chỉ còn vài đồng lẻ
> tiền lẻ khách trả thừa. Thật nực cười khi sở hữu chiếc xe tiền tỷ nhưng lại không dám gọi
> thêm một quả trứng vào bát m tôm cuối ngày (Anh Ba, "VỠ NỢ Vì Chạy Xe Dịch Vụ")

Giờ, nơi, đồ vật, động tác — không một câu kết luận nào chen vào; cảnh tự nó dựng lên món nợ
và sự sĩ diện mà không cần nói ra chữ "nợ".

### Lối B — Cảnh mở nén vào một câu, có tên nhân vật

> 11 giờ đêm, Đức, 29 tuổi, nhân viên văn phòng, vừa đi làm về. (`duc.txt`, dẫn qua
> `channel-styles/nhan-vat-xuyen-suot.md`)

Cùng loại nguyên liệu của Lối A (giờ + nghề + động tác "vừa đi làm về") nhưng nén hết vào một
câu — đủ để mở bài mà không cần dựng cả một đoạn văn.

### Ví dụ dở

> Có một câu chuyện rất dễ khiến chúng ta nản lòng: có người dường như chỉ cần chạm tay vào
> tiền là tiền sinh sôi, còn mình làm việc miệt mài mà cuối tháng vẫn thấy mọi thứ quay về con
> số gần như cũ. (bản nháp AI, `anhba-01.md`)

Không giờ, không nơi, không đồ vật — câu mở bài là một mệnh đề trừu tượng về "một câu chuyện",
đúng cái lỗi mà mode canh cấm.

**Khi nào KHÔNG dùng:**
- Beat cần một phép tính lộ ra (việc của `mo-so`) — nhồi thêm cảnh sẽ làm chậm nhịp tính toán.
- Không có đồ vật hay động tác thật nào trong ledger để dựng — đừng bịa một đồ vật không có
  nguồn chỉ để có cảnh.
- Beat liền trước đã là `canh` — luật hai beat kề nhau không cùng mode chặn việc lặp lại ngay.

---

## Mode: mo-so — Mổ số

**Hiệu ứng cần đạt:** một con số từ ledger được đưa ra và phép tính trên con số đó lộ ra ngay
trước mắt người nghe — không phải một kết quả được thông báo sẵn.

**Phải có:** một số từ ledger và phép tính lộ ra.
**Cấm:** kể chuyện — mode này không dựng nhân vật hay cảnh, chỉ có con số và phép tính.

### Lối A — Phép trừ liên hoàn

> Bây giờ hãy làm một phép tính cộng trừ cuối cùng. 1 triệu đồng thực thu trừ đi 300.000 tiền
> khấu hao trừ tiếp 500.000 tiền trả nợ ngân hàng mỗi ngày. Anh em còn lại bao nhiêu? 200.000đ.
> 200.000đ ngàn đồng cho 14 tiếng đồng hồ căng mắt dưới ánh đèn cao áp, hít khói bụi, nhịn tiểu
> và đối mặt với rủi ro tai nạn luôn rình dập. (Anh Ba, "VỠ NỢ Vì Chạy Xe Dịch Vụ")

Phép trừ đi qua từng khoản một trước mặt người nghe, không tóm tắt kết quả trước; con số cuối
cùng chỉ có nghĩa khi đặt cạnh cái giá phải trả để kiếm ra nó (14 tiếng).

### Lối B — Tỉ lệ trừu tượng quy ra số cụ thể

> cái tỉ lệ lý tưởng nhất cho cái con số này dành cho đại đa số các bạn trẻ đang ở trong cái
> giai đoạn bắt đầu là đâu đó nó khoảng 50 ph thu nhập của các bạn trong cái ví dụ này thì nó
> tương đương với 10 triệu (file `09`, videoId `a7kg3MTeT28`)

Nêu tỉ lệ trừu tượng (50%) rồi lập tức quy đổi ra một con số cụ thể trên đúng ví dụ đang chạy
(thu nhập 20 triệu) — con số không đứng một mình, nó luôn được neo vào một ví dụ.

### Lối C — Nhân lên theo từng bậc

> ở đây tôi lấy cái con số 50 triệu để mà cho nó tròn số cho dễ tính khi đó chúng ta nhân lên
> nó sẽ là 600 triệu một năm và chúng ta nhân tiếp cho 25 lần thì cái cột mốc Độc Lập tài chính
> nó sẽ là 15 tỷ (file `103`, videoId `DJr2hclTuLM`)

Phép nhân đi qua ba bậc liên tiếp (tháng → năm → 25 lần); người nghe thấy con số khổng lồ được
sinh ra từ đâu, không phải chỉ được thông báo con số đó.

### Ví dụ dở

> Bằng chứng cần có là lịch sử giao dịch đủ dài, biên nhận hoặc sao kê, điều khoản áp dụng, tần
> suất sử dụng và bối cảnh của chính bạn. (bản nháp AI, `anhba-03.md`, mục 1)

Một đoạn nói về tiền bạc nhưng không một con số ledger nào xuất hiện — toàn danh từ trừu tượng
("bằng chứng", "bối cảnh"), không có phép tính nào lộ ra.

**Khi nào KHÔNG dùng:**
- Ledger của bài không có con số nào đủ chắc để tính — đừng quy đổi ẩu chỉ để có `mo-so`.
- Beat cần dựng phản bác trước (việc của `phan-bac`) — đừng mổ số khi người nghe còn chưa tin
  luận điểm đứng sau con số.
- Beat liền trước đã là `mo-so` — luật kề nhau cấm lặp mode.

---

## Mode: phan-bac — Phản bác

**Hiệu ứng cần đạt:** câu phản đối được dựng ở dạng mạnh nhất, đứng hẳn trước câu trả lời, để
người nghe thấy lập luận đối lập được tôn trọng chứ không bị dựng lên chỉ để đá đổ dễ dàng.

**Phải có:** câu cãi ở dạng mạnh nhất, đặt trước câu trả lời.
**Cấm:** trả lời trước khi dựng xong câu phản bác.

### Lối A — Steelman một trường phái sống đối lập

> đặc biệt là những người sống theo phương châm Zô lô những người mà hay quan niệm là cuộc
> sống thì ngắn chúng ta đừng có quan tâm quá nhiều tới tương lai và họ hay chỉ trích cái cách
> sống của những người theo đuổi hành trình tự do tài chính rằng tại sao cứ phải thắt lưng buộc
> mụng Tại sao chúng ta không chịu hưởng thụ (file `08`, videoId `UMe0s6vDn0M`)

Đặt tên hẳn một trường phái đối lập ("Zô lô") và để nó công kích thẳng vào luận điểm chính,
trước khi trả lời dù chỉ một chữ.

### Lối B — Giả định người nghe đã phản bác sẵn

> nghe tới đây có thể là sẽ có anh chị nói là mấy cái chuyện này thì ai mà không biết Cái quan
> trọng là làm sao để mà xây dựng được 20 nguồn thu nhập thụ động kia (file `103`, videoId
> `DJr2hclTuLM`)

Câu phản bác được viết bằng chính giọng của người nghe khó tính nhất ("ai mà không biết"),
không phải giọng người kể tự chê nhẹ lại mình.

### Lối C — Phản bác trên chính quán tính của người trong cuộc

> Anh em tự hỏi giờ lỡ đâm lao rồi phải theo lao thôi chứ biết làm sao. Nhưng anh em ơi, ngồi
> trên một con tàu đang thủng đáy mà cố sức tát nước thì không gọi là kiên trì, người ta gọi đó
> là tự sát tập thể. Hôm nay tôi muốn đưa cho anh em một chiếc phao cứu sinh, một chiến lược
> rút lui mà tôi gọi là cuộc di cư ngược dòng. (Anh Ba, "VỠ NỢ Vì Chạy Xe Dịch Vụ")

Câu phản bác trích đúng suy nghĩ quán tính của người trong cuộc, rồi lật bằng một ẩn dụ khác
hẳn (con tàu thủng đáy) chứ không phủ định trực tiếp — và chỉ sau đó mới đưa ra lối thoát.

### Ví dụ dở

> Một phản biện hợp lý là: đời người đâu thể lúc nào cũng đo đếm. Đúng vậy. (bản nháp AI,
> `anhba-01.md`)

Phản bác được dựng yếu và bị gật đầu đồng ý ngay trong cùng một câu — không phải "dạng mạnh
nhất", cũng không đứng đủ lâu trước khi bị trả lời.

**Khi nào KHÔNG dùng:**
- Ledger/finalScript không có phe đối lập thật nào — đừng bịa một câu cãi rơm.
- Beat cuối cùng của bài — kết cần một câu trả lời chắc, không phải một câu cãi mới mở ra.
- Bài chỉ có một luận điểm duy nhất, không ai phản đối được — ép mode này vào sẽ thành tranh
  cãi giả tự dựng rồi tự đá đổ.

---

## Mode: cuc-tri — Thử cực trị

**Hiệu ứng cần đạt:** chính công thức, tỉ lệ hay ngưỡng bài vừa đưa ra bị đẩy tới một input vô
lý hoặc một giả định cực đoan — chỗ nó gãy, hoặc chỗ nó vẫn đứng vững, mới là nơi lộ insight.

**Phải có:** công thức hoặc ngưỡng đã nêu, đẩy tới input vô lý hoặc giả định.
**Cấm:** thêm biến mới không có trong bài.

### Lối A — Đẩy thu nhập lên mức phi lý

> tôi sẽ lấy một cái ví dụ thậm xưng đó là giả sử tới một lúc nào đó chúng ta làm ra được tới 1
> tỷ một tháng chẳng hạn thì theo cá nhân cái góc nhìn của tôi là chúng ta không thể nào mà
> chúng ta cứ dành hẳn ra 500 triệu cho những cái chi phí cố định cái số tiền đó là quá nhiều và
> tôi nghĩ là ai cũng vậy đặc biệt là những người mà họ đã xây dựng được những cái ý thức về tài
> chính trong một cái khoảng thời gian khá dài như vậy thì chắc chắn là những người đó họ lại
> càng không phải là những người phun phí (file `09`, videoId `a7kg3MTeT28`)

Biến số bị đẩy lên (thu nhập) đã có sẵn trong công thức đang bàn (tỉ lệ chi tiêu cố định);
không có biến mới nào được thêm vào, chỉ input bị đẩy tới mức phi lý — và điều lộ ra là kỷ luật
cũ vẫn giữ nguyên chứ không đổi theo quy mô.

### Lối B — Đẩy quy mô ẩn dụ tới mức an toàn

> nhưng nếu bằng cách nào đó mà chúng ta nuôi được 20 con hoặc là 100 con thì lúc đó lỡ mà có
> chết vài con thì chúng ta vẫn không lo (file `103`, videoId `DJr2hclTuLM`)

Chính rủi ro vừa nêu (bò có thể chết) bị đẩy tới quy mô cực lớn (100 con) để lộ ra: rủi ro
không biến mất, nó chỉ bị pha loãng.

### Ví dụ dở

> Không có cam kết rằng chúng tạo ra một con số cụ thể; hoàn cảnh và chi phí mỗi người khác
> nhau. (bản nháp AI, `anhba-03.md`, mục 1)

Bài né hẳn việc đẩy bất kỳ con số nào tới giới hạn, chọn nói chung chung "mỗi người khác nhau"
thay vì thử một ngưỡng thật.

**Khi nào KHÔNG dùng:**
- Bài không có công thức, tỉ lệ hay ngưỡng cụ thể nào để đẩy — không có gì để stress-test.
- Mode đã chạm mức 2 lần trong bài, hoặc beat kề trước đã là `cuc-tri` — luật giới hạn số lần
  và luật kề nhau chặn thêm.
- Đẩy tới cực trị mà không lộ insight nào (chỉ gãy vô nghĩa) — bỏ mode này, đừng ép kịch tính.

---

## Mode: zoom-chu — Zoom một chữ

**Hiệu ứng cần đạt:** thay vì tổng kết cả một luận điểm, dừng lại mổ xẻ đúng một chữ đã xuất
hiện trong câu — chỉ ra chính chữ đó chứa toàn bộ trọng lượng lập luận.

**Phải có:** một chữ trong câu đã xuất hiện.
**Cấm:** bịa khẩu hiệu để mổ.

### Lối A — Mổ đúng chữ giới hạn trong nguyên tắc vừa nêu

> cái từ khóa đầu tiên mà tôi muốn tập trung tới đó là cái chữ có thể đây nó chính là cái giới
> hạn trong cái khả năng chi tiêu của chúng ta bởi vì nếu mà không có cái chữ này chúng ta
> không định nghĩa được là cái chữ có thể này nó đang nằm ở cái mức nào thì nó sẽ đẩy chúng ta
> đi vào cái với xe đổ của rất là nhiều người khác đó là họ dùng toàn bộ thu nhập của họ để
> tiêu xài (file `09`, videoId `a7kg3MTeT28`)

Chữ bị mổ ("có thể") đã đứng sẵn trong nguyên tắc vừa phát biểu một câu trước đó, và cái giá
của việc thiếu chữ này được nói rõ ngay sau — không phải chữ được kéo từ nơi khác vào.

### Lối B — Mổ chữ để lật định nghĩa cả bài

> do đó nên các từ khóa ở đây chính là hai cái chữ giá trị Đó là một cái điểm mà có rất là
> nhiều người thường quên đó là tiền nó không phải là công cụ đại diện cho các mức năng lượng
> mà giống ta bỏ ra mà nó là cái công cụ đại diện cho những cái giá trị (file `137`, videoId
> `7ZN1hgjyYnc` — ⚠️ transcript ASR sai nặng; học kỹ thuật, đừng chép câu chữ)

Hai chữ bị mổ ("giá trị") lặp lại y nguyên khi phát biểu định nghĩa mới — chữ bị zoom trở thành
trục của cả luận điểm, không chỉ một lần nhắc qua.

### Lối C — Tự gọi tên chữ mình đang lặp

> có một cái từ khóa được tôi lặp đi lặp lại rất là nhiều lần đó là cái từ tưởng tượng hay là
> cái từ hình dung (file `06`, videoId `9BIaI8G3mRU`)

Người kể tự gọi tên chữ mình đang lặp — cách này biến việc lặp từ thành một chủ đích công khai
thay vì một tật nói.

### Ví dụ dở

> rồi nghĩ “chuyện bé thôi”. (bản nháp AI, `anhba-03.md`, mục 1 — cùng câu này lặp lại nguyên
> văn ở cả 12 mục, chỉ đổi vế trước)

Một cụm chữ lặp lại y hệt xuyên suốt mười hai mục nhưng không mục nào dừng lại mổ xẻ nó — lặp
mà không zoom thì chỉ là máy rập khuôn, không phải kỹ thuật.

**Khi nào KHÔNG dùng:**
- Bài không có sẵn một câu khẩu hiệu hay mệnh đề cô đọng nào đáng mổ — đừng bịa slogan mới chỉ
  để có cái để mổ.
- Bài đã có một ẩn dụ vận hành xuyên suốt (xem khuôn `an-du`) — đừng chạy song song hai kỹ
  thuật zoom (một vào từ, một vào hình ảnh) trong cùng một đoạn.
- Chữ được chọn không mang trọng lượng lập luận nào — bỏ mode này thay vì zoom gượng vào một
  chữ tình cờ.

---

## Mode: doi-y — Lộ quá trình đổi ý

**Hiệu ứng cần đạt:** người kể tự sửa mình, thú nhận một hiểu lầm do chính mình gây ra, hoặc
đổi kế hoạch giữa chừng — người nghe thấy đây là một người đang nghĩ khi nói, không phải một
văn bản đã hoàn thiện sẵn.

**Phải có:** tự sửa, thú nhận hiểu lầm hoặc đổi kế hoạch.
**Cấm:** dùng ở beat cuối; quá 1 lần trong một bài.

### Lối A — Thú nhận hiểu lầm do chính mình gây ra

> tôi nói về những cái việc này nó nhiều tới mức mà nó dễ gây hiểu lầm là tôi đang kêu gọi các
> anh chị cứ sống khổ Hạnh ở cái mức vừa đủ để sinh tồn còn ngoài ra thì không tiêu xài bất kỳ
> cái gì khác nhưng mà thật ra nếu mà làm như vậy thì cái việc này nó cũng không khác gì là cái
> việc chúng ta cứ nay lưng ra chúng ta làm rồi sống một cái cuộc sống thiếu chất lượng không
> có bất kỳ một cái sự hưởng thụ hay là bất kỳ một cái trải nghiệm cuộc sống nào (file `09`,
> videoId `a7kg3MTeT28`)

Người kể nhận lỗi cho một hiểu lầm không ai ép, rồi mới đi sửa nó bằng cách vẽ ra hậu quả của
chính cách hiểu sai đó — đường may lộ ra ngay giữa câu, trước khi có ai hỏi.

### Lối B — Tự sửa lại chính định nghĩa vừa nói

> thật ra nếu mà nói tiền nó cho phép tôi làm được việc này thì cũng không chính xác lắm nó
> một cách chính xác hơn thì tiền nó cho tôi được tự do (file `07`, videoId `PJPhR58LBYA`)

Câu tự sửa diễn ra trong nội bộ một câu duy nhất — nói ra rồi lập tức chỉnh lại chữ cho đúng
hơn, không đợi sang câu sau.

### Ví dụ dở

> Có thể đó là tổng chi phí của một nghĩa vụ. Có thể đó là điều khoản của một lời mời. Có thể
> đó là một kỹ năng bạn muốn thử mà không cần tự hứa quá nhiều. (bản nháp AI, `anhba-01.md`)

Đây là hedge an toàn lặp ba lần ("có thể đó là..."), không phải một lần tự sửa hay thú nhận
thật — `doi-y` cần một khoảnh khắc cụ thể bị sửa, không phải một danh sách khả năng mơ hồ.

**Khi nào KHÔNG dùng:**
- Beat cuối cùng của bài — kết cần chắc chắn, không tự nghi ngờ ở câu chốt.
- Đã dùng `doi-y` một lần trong bài — luật giới hạn tối đa 1 lần, không lặp lại.
- Dùng để giấu một lỗ hổng logic bằng cách giả vờ "tự sửa" — mode này giả định lập luận đúng,
  chỉ cách trình bày ban đầu chưa gọn.

---

## Phép lật: doi-don-vi — Đổi đơn vị đo

Đổi cái thước dùng để đo giá trị của cùng một sự việc — từ công sức/độ khó bỏ ra sang giá trị
tạo ra cho người khác.

> bây giờ giả sử khám Chị tưởng tượng là lái một chiếc taxi nó cũng phức tạp như là lái một
> chiếc máy bay đi Chẳng hạn với rất là nhiều những cái nút bấm khác nhau cả cái cách điều
> khiển cũng phức tạp hơn nhưng mà có giá trị nó tạo ra thì cũng chỉ là đưa một vài người từ
> cái điểm A sang cái điểm B của Thành phố thì bất kể là lái các chuyến taxi nó có phức tạp tới
> mấy đi nữa thì khi lượng tiền nhận được nó cũng sẽ không thay đổi (file `137`, videoId
> `7ZN1hgjyYnc`)

Vật quen: "làm khó hơn thì được trả nhiều hơn". Cú lật: tiền đo giá trị tạo ra cho người khác,
không đo độ khó hay công sức của người bỏ ra nó.

## Phép lật: doi-chu-the — Đổi chủ thể

Đổi ai mới thực sự đứng ở vị trí sở hữu và kiểm soát, trong một quan hệ tưởng như đã rõ ai là
chủ.

> Bạn không sở hữu chiếc xe, ngân hàng mới là kẻ nắm giữ cái cả vẹt gốc. Bạn chỉ là người được
> thuê để vận hành cái tài sản đó cho họ với cái giá phải trả là toàn bộ sức lao động, thời
> gian và sự bình yên của chính mình. (Anh Ba, "VỠ NỢ Vì Chạy Xe Dịch Vụ")

Vật quen: "mua xe trả góp là làm chủ chiếc xe". Cú lật: người trả góp không phải chủ, mà là
nhân công được thuê để vận hành tài sản cho chủ nợ thật.

## Phép lật: doi-thang — Đổi thang

Cùng một công thức, đổi quy mô đủ lớn để công thức đứng vững theo cách khác hoặc rủi ro cũ đổi
tính chất.

> nhưng nếu bằng cách nào đó mà chúng ta nuôi được 20 con hoặc là 100 con thì lúc đó lỡ mà có
> chết vài con thì chúng ta vẫn không lo về cơ bản lúc đó có thể tạm xem như là chúng ta đã đạt
> được tự do tài chính rồi bất kể là chúng ta có 15 tỷ trong tay hay không (file `103`, videoId
> `DJr2hclTuLM`)

Vật quen: "một nguồn thu nhập, mất là mất trắng" và "tự do tài chính cần 15 tỷ". Cú lật: đổi
thang từ một con sang một trăm con làm cả rủi ro cũ lẫn định nghĩa "tự do tài chính" đổi theo.

## Phép lật: doi-ten — Đổi tên gọi

Gọi lại đúng bản chất của một hành vi bằng một cái tên khác, lột cái vỏ tên gọi cũ đang che
giấu điều đó.

> ví dụ lãi suất ngân hàng mà các anh chị gửi là 5% mỗi năm nhưng mà giả sử Lạm phát là 7% thì
> thật ra là mỗi năm cứ để tiền ở đó là các anh chị đang mất đi 2% (file `103`, videoId
> `DJr2hclTuLM`)

Vật quen: "gửi ngân hàng là tiết kiệm, là an toàn". Cú lật: đổi tên gọi từ "tiết kiệm" sang
"mỗi năm mất 2%" — cùng một hành vi, tên gọi mới lộ ra bản chất ngược lại.

## Phép lật: doi-thoi-diem — Đổi thời điểm nhìn

Đặt người nghe đứng ở một mốc thời gian khác — tương lai xa, hoặc lúc vừa ký kết — để nhìn lại
quyết định đang bàn ở hiện tại.

> 10 năm trước tôi đã hình dung ra một cuộc sống mà tôi sẽ muốn sống như thế nào rồi sau đó thì
> tôi lại tưởng tượng tiếp về cái việc là nếu mà có được thêm quốc tịch Úc thì khi đó cuộc sống
> của tôi sẽ ra sao mỗi khi mà tôi nhắm mắt lại để tưởng tượng như vậy thì nó cũng gần giống
> với cái việc là tôi được hóa thân mình vào cái tương lai đó để tôi được tạm sống trong một
> vài khoảnh khắc của cái cuộc sống đó (file `06`, videoId `9BIaI8G3mRU`)

Vật quen: "quyết định hôm nay chỉ cần đúng cho hôm nay". Cú lật: đứng hẳn vào một khoảnh khắc
tương lai để cảm nhận trước, rồi vẽ ngược lại xem con đường hiện tại có dẫn tới đó không.

## Phép lật: doi-cau-hoi — Đổi câu hỏi

Lùi một bước, thay câu hỏi đang được mặc định bằng một câu hỏi nền tảng hơn đứng phía sau nó.

> vậy thì trước tiên thì tiền nó là cái gì để trả lời cho câu hỏi này thì chúng ta lùi lại 1
> bước để mà trả lời một cái câu hỏi quan trọng hơn đó là chúng ta tới với cái cuộc sống này để
> làm cái gì (file `137`, videoId `7ZN1hgjyYnc`)

Vật quen: "kiếm tiền để làm gì". Cú lật: câu hỏi bị đổi thành một câu hỏi nền tảng hơn — sống
để làm gì — trước khi câu hỏi ban đầu có thể được trả lời thật.

---

## Khuôn: nhan-vat — Nhân vật

Luật: theo `writer-room-data/channel-styles/nhan-vat-xuyen-suot.md` S2 — tên, tuổi, nghề rồi
dừng; foil xuất hiện ở mở và ở kết; nhân vật không bao giờ phát ngôn một câu trích dẫn từ
ledger.

> 11 giờ đêm, Đức, 29 tuổi, nhân viên văn phòng, vừa đi làm về. (`duc.txt`, dẫn qua
> `channel-styles/nhan-vat-xuyen-suot.md`)

Nhân vật gánh cả bài nhưng chỉ mang đúng ba nhãn — không quê quán, không gia cảnh — sợi dây
này xuyên suốt cả bài, không lặp lại giới thiệu ở giữa.

## Khuôn: an-du — Ẩn dụ vận hành được

Luật: ẩn dụ phải suy luận tiếp được và quay lại ở payoff — không chỉ nghe hay một lần rồi biến
mất.

> và tôi thường gọi vui đây là những con bò sữa khi mà chúng ta nuôi được 10 con bò rồi thì tụi
> nó cứ ở đó nó cứ đều đặn nó cho sữa cho chúng ta mỗi tháng (file `103`, videoId
> `DJr2hclTuLM`)

Ẩn dụ "nuôi bò" quay lại xuyên bài (bò chết → nuôi thêm; ít trớn → nuôi 5, có trớn → nuôi 20)
và đóng lại ở payoff ("năm nay chúng ta nuôi con bò giặt ủi") — không phải hình ảnh trang trí
dùng một lần.

## Khuôn: con-so — Một con số

Luật: một số từ ledger đi qua mọi beat và đóng ở payoff — không đổi số giữa chừng bài.

> tôi nghĩ là cái tỉ lệ phù hợp cho hai cái con số này đó là 30 ph dành cho đầu tư và 20 ph
> dành cho tiêu xài và hưởng thụ cuộc sống cụ thể trong trường hợp này thì sau 1 năm nghĩa là
> sau khi mà các anh chị đã có được một cái khoản quỷ dự phòng tương đương với 120 triệu rồi
> thì sau đó các anh Chị có thể dành mỗi tháng khoảng 6 triệu cho cái hoạt động đầu tư còn đầu
> tư vào đâu cho nó an toàn và hiệu quả thì tôi cũng đã chia sẻ khá nhiều trong những cái tập
> Podcast trước đây rồi Các anh chị có thể tìm để xem lại và sau khi mà đã trừ 6 triệu này ra
> thì chúng ta còn lại cái con số cuối cùng là 4 triệu tương đương với 20 ph đây nó chính là
> cái con số mà chúng ta sẽ được cho phép mình tiêu xài để làm cho cuộc sống của mình nó vui
> hơn và nó chất lượng hơn (file `09`, videoId `a7kg3MTeT28`)

Một mức thu nhập duy nhất (20 triệu/tháng) chạy qua cả bốn con số của cùng một công thức —
120 triệu dự phòng, 6 triệu đầu tư, 4 triệu tiêu xài — không đổi ví dụ giữa các beat, và mỗi
con số mới đứng trên phần dư của con số trước nó.
