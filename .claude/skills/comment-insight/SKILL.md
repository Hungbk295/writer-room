---
name: comment-insight
description: >
  Lọc và phân tích comment YouTube để rút insight người xem thật, thay vì suy đoán.
  Kéo comment bằng Writer Room Spy MCP (spy_video_comments), loại nhiễu bằng script
  filter_comments.py, rồi gom nhóm chủ đề TỪ DỮ LIỆU chứ không áp khung có sẵn.
  Dùng khi cần xác nhận một giả thuyết về insight khán giả, hiểu vì sao một nhóm
  video ăn view, hoặc tìm ngôn ngữ thật của người xem để viết hook và tiêu đề.
  Luôn báo cáo kèm tỉ lệ nhiễu và cỡ mẫu; không kết luận nhân quả từ comment.
---

# Comment Insight

Rút insight người xem từ comment, có bằng chứng, không suy đoán.

## KHÔNG làm sentiment analysis

Chia comment thành positive / negative / neutral là **vô dụng cho chiến lược nội dung**.
Biết 70% comment tích cực không cho bạn biết nên làm video gì tiếp.

Thứ cần rút là **Audience Signal** — Voice of Customer. Một comment:

> *"I'm 34 with $20k saved and thought I was doing okay until I watched this."*

phải cho ra:

| Trường | Giá trị |
|---|---|
| life_stage | 34 tuổi |
| current_state | $20k tiết kiệm |
| emotion | lo lắng / thấy mình kém cỏi |
| underlying_question | **Tôi có đang tụt hậu không?** |
| desired_outcome | được trấn an + mốc so sánh + kế hoạch |
| niche_goi_y | Mốc tài chính theo độ tuổi |

`underlying_question` là trường quan trọng nhất — nó là **đề bài của video tiếp theo**.

## Kiến trúc hai tầng

| Tầng | Trả lời câu gì | Công cụ | Tự động? |
|---|---|---|---|
| 1 · Lọc | comment này có **đáng đọc** không | `filter_comments.py` | có |
| 2 · Trích | comment này mang **insight gì** | `extract_voc.py` + người/LLM đọc | một phần |

Đo thật: regex ở tầng 2 chỉ gán được 33% comment, 67% phải đọc. Đừng hứa tự động hoá
tầng 2 — trường `underlying_question` và `desired_outcome` cần hiểu ngữ cảnh.

## Chín loại insight

| Loại | Nghĩa |
|---|---|
| `pain` | vấn đề đang khó chịu |
| `desire` | trạng thái họ muốn đạt |
| `fear` | điều họ sợ xảy ra |
| `objection` | điều khiến họ không tin / không làm theo |
| `question` | điều họ chưa hiểu |
| `request` | nội dung họ trực tiếp yêu cầu |
| `identity` | "người như tôi thì..." |
| `situation` | hoàn cảnh khiến vấn đề xuất hiện |
| `language` | **cách audience tự mô tả vấn đề, nguyên văn** |

`language` là loại bị bỏ quên nhiều nhất nhưng dùng được ngay: cụm nguyên văn của
người xem là nguyên liệu viết tiêu đề và hook. Ví dụ thu được từ corpus thật —
*"super late start"*, *"lifestyle creep"*, *"the famous 100k line"*,
*"for the first several years you are doing almost all the work"*.

## Vì sao cần lọc trước

Đo thật trên 286 comment của 6 video ngách tài chính Mỹ: **72% là nhiễu**.

| Loại nhiễu | Tỉ lệ |
|---|---|
| Không mang tín hiệu nào | 38% |
| Quá ngắn (<40 ký tự) — "thanks", "love the video", "👍" | 31% |
| Spam sách (tên tác giả bịa, đổi mỗi lần) | 2% |
| Góp ý kỹ thuật video, cổ vũ kênh | <1% |

Phân tích trên comment chưa lọc sẽ ra kết luận sai. Và nếu viết mẫu phân loại
**từ giả thuyết của mình** rồi đo xem dữ liệu khớp bao nhiêu thì tỉ lệ không khớp
lên tới 79% — đó là dấu hiệu áp khung sai, không phải dữ liệu xấu.

## Quy trình

### 1. Kéo comment

```python
import spy
r = spy.call("spy_video_comments",
             {"video_id": "<id>", "max_results": 100, "order": "relevance"})
```

~1 đơn vị quota mỗi video. `order="relevance"` trả comment nhiều like trước —
**đã thiên lệch sẵn**, phải ghi vào phần hạn chế khi báo cáo.

Lấy tối thiểu **6–10 video** cùng nhóm để mẫu đủ. Ghi JSON với `text`, `likes`, `video_id`, `title`.

### 2. Lọc (tầng 1)

```bash
python3 scripts/filter_comments.py raw.json \
        --out comments_clean.tsv --rejected rejected.tsv
```

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `--min-len` | 40 | dưới ngưỡng này coi là quá ngắn |
| `--min-score` | 1 | điểm tín hiệu tối thiểu để giữ |

**Không xoá gì cả** — comment bị loại vào `rejected.tsv` kèm lý do, để đo được tỉ lệ
nhiễu và kiểm lại bộ lọc. Lọc bằng nhãn, không lọc bằng xoá.

### 3. Trích VoC (tầng 2)

```bash
python3 scripts/extract_voc.py comments_clean.tsv --out voc.tsv --for-llm 40
```

Gán nhãn 9 loại bằng regex, trích cụm `language` nguyên văn, rồi in khung cho
người/LLM điền 6 trường sâu: `life_stage`, `current_state`, `emotion`,
`underlying_question`, `desired_outcome`, `niche_goi_y`.

### 4. Đọc trước, gom sau

Đọc **30–50 comment điểm cao nhất bằng mắt**, gom nhóm từ cái thấy được, rồi mới
viết mẫu regex và đo. Làm ngược lại — viết mẫu từ giả thuyết trước — là lỗi đã mắc
và đo được: 79% không khớp.

### 5. Báo cáo

Mỗi kết luận phải kèm: cỡ mẫu · tỉ lệ nhiễu đã loại · số comment ủng hộ · tổng like.

## Chín tín hiệu script chấm

| Tín hiệu | Điểm | Vì sao đáng đọc |
|---|---|---|
| `tu_ke_co_so` | 3 | tự khai con số cụ thể — "I'm at $600k" |
| `phan_bien` | 3 | phủ định trực tiếp luận điểm video |
| `hieu_chinh_so` | 3 | sửa con số video đưa ra |
| `boi_canh_xa_hoi` | 3 | nhắc tới người khác — bạn bè, gia đình, bị cười nhạo |
| `bo_sung_goc_nhin` | 3 | thêm tầng hiểu mà video không nói |
| `tu_ke_chuyen` | 2 | kể trải nghiệm cá nhân |
| `giai_doan_song` | 2 | lộ tuổi hoặc giai đoạn sống |
| `cam_xuc` | 2 | từ chỉ cảm xúc thật |
| `cau_hoi_that` | 1 | hỏi cụ thể, không phải hỏi xã giao |

Mẫu `phan_bien` **cố ý không nhận** `but` / `actually` / `however` đứng một mình —
đo thử thì hai từ đó tạo 49% báo sai vì quá phổ biến trong tiếng Anh.

## Ba giới hạn phải ghi trong mọi báo cáo

**Comment là tiếng nói của thiểu số.** Người bình luận không đại diện cho người xem.
Đo thật: comment về được minh oan chỉ 4/286 nhưng đạt 153 like/cái, trong khi câu hỏi
kỹ thuật có 19 cái mà chỉ 2 like/cái. Đông ≠ cộng hưởng, và cả hai đều ≠ toàn bộ người xem.

**Comment không chứng minh nhân quả.** Nó cho biết người bình luận *nghĩ gì*, không cho
biết *vì sao video ăn view*. Trên corpus POV Finance, nhóm video ăn nhất (lãi kép, 2,01x)
có comment chủ yếu là câu hỏi kỹ thuật, còn comment cộng hưởng nhất lại nói về vị thế xã hội —
hai thứ tách rời nhau.

**`order="relevance"` đã thiên lệch.** Muốn mẫu trung lập hơn thì dùng `order="time"`,
nhưng sẽ nhiều nhiễu hơn.

## Đầu ra

`voc.tsv` — bảng Voice of Customer, mỗi dòng một comment đã trích:

```
insight_types  life_stage  current_state  emotion  underlying_question
desired_outcome  niche_goi_y  language_phrases  diem_tin_hieu  likes  text
```

Cột `niche_goi_y` gom lại chính là **danh sách đề tài rút từ người xem**, không phải
từ suy đoán của người làm nội dung.

`comments_clean.tsv` — xếp theo `diem_tin_hieu` rồi `likes`:

```
diem_tin_hieu  tin_hieu  likes  do_dai  video_id  title  text
```

`rejected.tsv` — `ly_do_loai · likes · do_dai · video_id · text`
