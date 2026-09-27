# Plan Research Hằng Ngày

**Hai đầu ra duy nhất:** `keyword index` và `insight database`. Mọi thứ khác là đường đi tới đó.

---

## Luật gốc

| | |
|---|---|
| **Keyword** | không do LLM nghĩ ra. Phải có `origin` là dữ liệu thật, và phải kiểm bằng search mỗi ngày. |
| **Insight** | không do LLM tuyên bố. Phải soi ngược **toàn bộ corpus cũ**, phán định bằng code chứ không bằng agent. |

---

## Chạy hằng ngày

```bash
python3 loop/run.py daily            # quét kênh follow, dựng board vận tốc thật
python3 loop/score_keywords.py       # chấm lại 25 keyword
python3 loop/backtest_insight.py --all   # soi ngược insight trên corpus
```

| Bước | Node | Làm gì |
|---|---|---|
| 1 | CODE | Quét video mới của kênh follow → `snapshots.tsv` |
| 2 | CODE | Delta view giữa 2 snapshot → `board_moving.tsv` (**vận tốc thật**) |
| 3 | CODE | Chấm lại 25 keyword, ghi `xu_huong` so với hôm qua |
| 4 | AGENT | Rút cụm từ mới từ tiêu đề video mới → ứng viên keyword (`cho_kiem`) |
| 5 | CODE | Kéo comment video có `heat` cao → lọc 77% nhiễu |
| 6 | AGENT | Trích VoC 6 trường, quan trọng nhất là `underlying_question` |
| 7 | AGENT | Đề xuất **mẫu khớp** cho insight ứng viên |
| 8 | CODE | Backtest mẫu đó trên 1.486 video cũ → phán định |
| 9 | CODE | Cập nhật `keyword_index` + `insight_db` |

**Bước 7 và 8 tách nhau có chủ đích.** Agent chỉ đề xuất mẫu; phán định *strengthening / weakening*
do code ra theo ngưỡng cố định. Để agent tự tuyên bố insight mạnh lên là mở cửa cho bịa.

---

## Hằng tuần

```bash
python3 loop/run.py weekly           # search keyword → kênh vãng lai
```

Duyệt `inbox_channels.tsv` theo luật thăng. Hiệu suất đường này đo được **3,4%** nên không chạy hằng ngày.

---

## Ngưỡng phán định — cố định, không thương lượng

**Keyword:** vào `active` khi bản thân truy vấn là khái niệm tài chính **và** ≥70% kết quả search đúng ngách.

**Insight:**
```
n < 15 video hoặc < 3 kênh  →  cần thêm mẫu · LOW
lift >= 1,20                →  strengthening
lift <= 0,85                →  weakening (bằng chứng NGƯỢC)
còn lại                     →  đi ngang
```

---

## Bốn cổng chặn không được bỏ

1. **Ngôn ngữ** — `langgate.py` chặn tại tầng thu thập, không lọc ở tầng đọc
2. **Chế độ kênh** — chạy `spy_regime` trước khi tính baseline; median phẳng sai khi kênh đứt gãy
3. **Nền kênh** — `baseline_tier` dead/thin/proven; kênh nền chết không lên shortlist
4. **Đối chiếu ngược** — đọc lại từ sheet, diff với TSV sau mỗi lần ghi

---

## Trạng thái hiện tại

```
keyword_index    243   (38 active · 191 chờ kiểm · 14 loại)
insight_db         5   (1 strengthening · 4 LOW)
snapshots        214   1 mốc — cần lần chạy thứ 2 để có board
follow_list       18   (11 active · 7 watch)
corpus         1.486 video · 1.488 comment
```

**Insight duy nhất đứng vững sau backtest:** INS-001 — *người xem giai đoạn đầu nản vì lãi kép
chưa có tác dụng, không ai nói cho họ phải gồng bao lâu*. lift 1,30 · 25 video · 9 kênh.

---

## Ba việc chưa làm

| | Chặn gì |
|---|---|
| JTBD từ VoC | chặn Audience Cluster → Micro-Niche |
| Trích sâu 316 comment còn lại | mẫu 20 dòng quá nhỏ |
| Luật giáng tự động trong `run.py` | follow_list không tự dọn |
