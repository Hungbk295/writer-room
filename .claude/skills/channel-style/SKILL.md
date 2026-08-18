---
name: channel-style
description: >
  Restyle một script Writer v2 đã chạy xong (`status: DONE`) theo style riêng của kênh,
  chạy NGOÀI pipeline. Dùng skill này khi người dùng nói "restyle bài này", "áp style kênh
  vào run X", "viết lại bản này theo giọng kênh tôi", hoặc muốn thử một style khác trên
  cùng một bản gốc để A/B. Skill đọc `finalScript` + `study.factsLedger` từ file run,
  áp một file style trong `styles/`, rồi ghi ra một file MỚI trong `writer-room-data/exports/`.
  KHÔNG sửa `finalScript`, KHÔNG thêm stage vào pipeline, KHÔNG có gate chặn.
---

# channel-style — restyle sau khi run DONE

Pipeline Writer v2 lo phần **đúng**: dữ kiện có nguồn, coverage, gate. Skill này lo phần
**giọng**: bài đọc lên có ra kênh của mình hay không.

Ba tầng đầu vào của writer đã có sẵn trong pipeline: **topic pack** (dữ kiện, đi qua
`factsLedger`), **formula** (nhịp/cấu trúc, máy học từ training lab), **general pack**
(taste DNA của kênh *tham chiếu* — Hieu TV). Tầng thứ tư — "kênh **của tôi** viết thế nào" —
nằm ở đây, ngoài pipeline, để sửa được trong 10 giây.

Nó nằm ngoài pipeline một cách có chủ ý. Gate hiện tại so khớp **chuỗi ký tự**, nên đã từng
ép writer nhồi nguyên câu `"mỗi món chỉ 100k một tháng"` vào một script voiceover. Thêm một
hard check nữa chỉ tạo thêm lối mòn và làm bài kém tự nhiên hơn. Style ở đây là **prose cho
người và agent đọc**, không phải schema để máy chấm.

---

## Bước 1 — Đọc 3 input

Cả ba đều nằm trên đĩa. Không cần gọi API, không cần daemon chạy.

| Input | Đường dẫn |
|---|---|
| Bản gốc có nguồn | `writer-room-data/writer/runs-v2/<runId>.json` → `finalScript` |
| **Facts ledger** | cùng file → `study.factsLedger` |
| Style | `.claude/skills/channel-style/styles/<ten>.md` |

**Đọc ledger là BẮT BUỘC.** Đây là thứ duy nhất phân biệt skill này với "nhờ AI viết lại
cho hay hơn". Ledger là một mảng các phần tử `{ fact, quote, videoId }` — mỗi phần tử là một
dữ kiện kèm **câu nguyên văn từ video nguồn** và id của video đó.

Ledger cho biết những thứ mà đọc `finalScript` một mình sẽ không thấy:

- mẫu khảo sát là **"sinh viên TP.HCM"**, không phải "người được hỏi" chung chung
- tỉ lệ hạn mức nguồn là **6,67×** (`600 đô → 4000 đô`)
- dải nợ trên thu nhập là **40–45%**, không phải một con số đơn
- câu nào là **lời khai của một người thật** trong video, chứ không phải văn của writer

Không đọc ledger thì mọi luật ở dưới đều không kiểm được.

## Bước 2 — Áp style

Đọc file style, áp **chỉ những gì áp được sau khi bài đã viết xong**: ngôi và xưng hô, dàn
nhân vật, nhãn chặng, định mức tu từ, hợp đồng kết bài, ranh giới. Không áp những thứ thuộc
giai đoạn nghiên cứu — không đi tìm dữ kiện mới, không đổi luận điểm, không đổi thứ tự lập
luận nếu style không yêu cầu.

## Bước 3 — Ghi ra file MỚI, KHÔNG ghi đè

```
writer-room-data/exports/writer/<runId>/styled-v1.md
```

`styled-v2.md`, `styled-v3.md`… nếu thử style khác trên **cùng một bản gốc**.

Giữ `finalScript` trong file run **nguyên vẹn** làm gốc đối chiếu. Lợi ích: một bản có nguồn,
N phiên bản style → A/B được **style** mà không phải viết lại bài. Khi một bản styled sai, so
với bản gốc là biết ngay lỗi do style hay do bài.

## Bước 4 — Nhắc người dùng chạy regate

```
bun writer:regate <runId> <path>
```

CLI này **báo cáo, không chặn**, luôn `exit 0`. Nó nói cho biết bản styled còn giữ được bao
nhiêu dữ kiện so với ledger. Đọc để biết, không phải để qua môn.

## Bước 5 — Vòng lặp nằm ở STYLE, không ở BÀI

Kết quả chưa đúng thì **sửa file style rồi chạy lại bước 2**. Đừng vá tay từng bài.

Lý do: agent áp style **không bị chấm điểm**, nên không sinh ra hành vi "diễn cho qua" — nó
không có động cơ nhồi chuỗi ký tự để lấy điểm. Bù lại, cái duy nhất điều khiển được nó là
file style. Vá tay một bài thì bài sau lại sai y như vậy; sửa style thì mọi bài sau đều đổi.

---

## BA LUẬT CỨNG về nhân vật hư cấu

Nhân vật hư cấu là chỗ dễ hỏng nhất, vì nó là chỗ duy nhất agent được phép **bịa**. Ba luật
này giới hạn đúng chỗ đó.

### Luật 1 — Số của nhân vật phải cộng đúng VÀ suy được từ tỉ lệ trong ledger

Mỗi con số gán cho nhân vật phải qua được hai phép thử: cộng lại đúng, và tỉ lệ của nó nằm
trong dải mà ledger ghi.

Đúng: `1,3 triệu × 10 kỳ = 13 triệu` — cộng đúng. `6,5 / 15 = 43%`, và dải `40–45%` **có
trong ledger**. Con số 43% không phải bịa, nó là một điểm cụ thể trong dải nguồn.

Sai: một con số nghe hợp lý nhưng không truy được về dải nào trong ledger.

### Luật 2 — Giữ nguyên bội số của nguồn khi nội địa hoá con số

Đổi đơn vị tiền được. Đổi **quan hệ giữa hai con số** thì không.

Lỗi thật đã xảy ra: ledger ghi hạn mức tăng `600 đô → 4000 đô`, tức **6,67×**. Bản viết lại
đổi thành `15 triệu → 70 triệu`, chỉ **4,67×**. Con số trông Việt Nam hơn, nhưng luận điểm
"phần thưởng cho người trả tốt là được nợ nhiều hơn" đã bị làm nhẹ đi mất một phần ba.

Đúng phải là `15 → 100 triệu`.

Cách làm: lấy bội số từ ledger trước, chọn số Việt Nam sau, rồi nhân lại để kiểm.

### Luật 3 — Nhân vật hư cấu KHÔNG BAO GIỜ phát ngôn một câu trích dẫn từ ledger

Lời khai của người thật phải giữ **chủ thể thật**. Nhân vật hư cấu chỉ được **đối thoại với**
nó — đọc nó, nhận ra mình trong đó, phản ứng lại nó.

Lỗi thật đã xảy ra:

> `"Đức tự viết ra đúng suy nghĩ này: 'Tôi chưa bao giờ trễ việc thanh toán…'"`

Câu trong ngoặc kép là lời của một người thật trong video nguồn (ledger, `videoId: DPwoGcGA-zk`).
Gán nó cho một nhân vật bịa là biến lời khai có nguồn thành văn hư cấu — mất nguồn, và về
bản chất là dựng chứng cứ.

Cách sửa đúng:

> `Đức đọc được lời kể của một người dùng lâu năm: "…". Đọc xong, Đức nhận ra đó gần như là`
> `mô tả về chính mình.`

Trích dẫn giữ chủ thể thật, nhân vật đứng cạnh nó. Sức nặng không mất đi mà còn tăng: có hai
người, một thật một hư cấu, cùng nói một chuyện.

---

## KHÔNG được làm

- **Không đổi bất kỳ dữ kiện nào** — số, tên tổ chức, mẫu khảo sát, năm. Style đổi cách nói,
  không đổi cái được nói.
- **Không thêm dữ kiện mới ngoài ledger.** Một con số không có trong ledger là một con số
  không có nguồn, bất kể nó nghe đúng cỡ nào.
- **Không sửa `finalScript` trong file run.** Đó là bản gốc đối chiếu. Ghi ra `exports/`.
- **Không bỏ mẫu khảo sát.** Lỗi thật: ledger ghi *"Hơn 60% **sinh viên TP.HCM**"*, một bản
  viết thành *"hơn 60% **người được hỏi**"*. Bỏ hai chữ, dân số suy rộng ra vô căn cứ từ sinh
  viên một thành phố thành người đi làm cả nước. Khảo sát nào cũng phải mang theo mẫu và tổ chức.
