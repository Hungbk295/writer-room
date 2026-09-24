#!/usr/bin/env python3
"""Lọc comment YouTube: bỏ nhiễu, giữ comment mang tín hiệu để phân tích insight.

Đầu vào : JSON hoặc TSV có các trường text, likes (tuỳ chọn: video_id, title, author)
Đầu ra  : TSV đã lọc + xếp theo điểm tín hiệu, kèm lý do loại cho từng comment bị bỏ

Dùng:
    python3 filter_comments.py raw.json --out comments_clean.tsv
    python3 filter_comments.py raw.json --out clean.tsv --rejected rejected.tsv --min-score 2

Nguyên tắc: KHÔNG xoá — mọi comment bị loại đều ghi vào file rejected kèm lý do,
để đo được tỉ lệ nhiễu và kiểm lại bộ lọc. Lọc bằng nhãn, không lọc bằng xoá.
"""
import argparse, csv, json, os, re, sys, html, collections

# ── NHIỄU: mẫu quan sát thật trên corpus POV Finance (286 comment, 6 video) ──
PRAISE = re.compile(r"^(thanks?|thank you|nice|great|good|love|awesome|amazing|excellent|"
                    r"perfect|wow|cool|👍|❤️?|🔥|💯)[\s!.,👍❤🔥💯😊🙏]*$", re.I)
GENERIC_PRAISE = re.compile(r"^(love|great|nice|good|excellent|amazing|awesome)\s+"
                            r"(video|content|channel|stuff|work|info)\b.{0,40}$", re.I)
KEEP_POSTING = re.compile(r"\b(keep (it up|posting|going|them coming)|more (of these|videos|content)|"
                          r"subscribed?|first comment|early gang)\b", re.I)
# Spam sách: "cuốn X của <Tên Người> đã thay đổi đời tôi" — tên tác giả bịa, đổi mỗi lần
BOOK_SPAM = re.compile(r"\b(book|read(ing)?)\b.{0,80}\bby\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b"
                       r"|\b[A-Z][a-z]+\s+[A-Z][a-z]+\b.{0,40}\b(deserves? more|underrated|"
                       r"changed (my life|everything)|why isn'?t anyone talking)", re.I)
TIMESTAMP_ONLY = re.compile(r"^\s*\d{1,2}:\d{2}\b.{0,30}$")
EMOJI_ONLY = re.compile(r"^[\W\d_]+$", re.U)
# Spam bot dau tu: cung mot khuon, doi con so. Quan sat that: "I've hit $190,590 /
# $37,590 ... conversation with my son ... generational wealth" lap 3 lan.
INVEST_SPAM = re.compile(r"\b(i'?ve hit|now i'?m at|started with)\s*\$[\d,]+.{0,120}"
                         r"\b(generational wealth|conversation with my (son|daughter)|"
                         r"financial (advisor|adviser)|reach out to|dm me|whatsapp|telegram)\b"
                         r"|\b(highly recommend|credit to)\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b.{0,60}"
                         r"\b(trading|crypto|forex|portfolio)\b", re.I)
VIDEO_META = re.compile(r"\b(typo|misspell|subtitle|caption|audio|music too loud|"
                        r"could have been \d+ min|too long|repeat(ing|s) (the same|yourself))\b", re.I)

# ── TÍN HIỆU: cái làm một comment đáng đọc cho insight ──
SELF_NUMBER   = re.compile(r"\b(i'?m|i am|i have|i've|my|we'?re|we have)\b.{0,30}\$\s?[\d,.]+\s*(k|m)?\b", re.I)
SELF_STORY    = re.compile(r"\b(i (started|began|was|used to|didn'?t|spent|saved|quit|lost|inherited)|"
                           r"my (wife|husband|dad|mom|parents|grandmother|kids?|job|boss))\b", re.I)
AGE_STAGE     = re.compile(r"\b(i'?m \d\d|at \d\d|in my (20s|30s|40s|50s|60s)|since (college|high school)|"
                           r"retired|graduated|first job)\b", re.I)
# Phản bác THẬT: phủ định trực tiếp luận điểm của video. Không dùng "but"/"actually"
# đứng một mình — hai từ đó quá phổ biến, đo thử ra 49% báo sai.
CHALLENGE     = re.compile(r"\b(categorically wrong|that'?s (wrong|false|misleading)|"
                           r"not (that|so) (easy|simple)|doesn'?t (account|work like)|"
                           r"in reality|reality is|the problem (is|with)|"
                           r"misleading|flat out wrong|bad advice|doesn'?t add up|"
                           r"only marginally|that'?s not how)\b", re.I)
# Bổ sung góc nhìn: không phản bác nhưng thêm tầng hiểu — loại comment giá trị nhất
NUANCE        = re.compile(r"\b(the (part|thing) most people miss|what (people|most) don'?t (get|realize)|"
                           r"there'?s a stage|it'?s not (about|because)|the real (reason|point)|"
                           r"less important than|more (about|important) than|actually a masterclass)\b", re.I)
CORRECTION    = re.compile(r"\b(said|claimed|says)\b.{0,50}\b(but|today|actually|now)\b"
                           r"|\b(should be|is more like|closer to)\b.{0,20}[\d$]", re.I)
SOCIAL        = re.compile(r"\b(laugh|made fun|judge|mock|people (think|said|told)|"
                           r"nobody (knows|notice)|friends|family|coworker|neighbou?r)\b", re.I)
QUESTION      = re.compile(r"\b(how do i|should i|what if|which (one|fund|etf)|any advice|"
                           r"is it (better|worth))\b", re.I)
EMOTION       = re.compile(r"\b(cried|scared|anxious|stressed|relief|proud|ashamed|regret|"
                           r"tired of|sick of|felt|feel(s|ing)? (like|broke|behind|stuck))\b", re.I)

SIGNALS = [("tu_ke_co_so",SELF_NUMBER,3), ("tu_ke_chuyen",SELF_STORY,2),
           ("giai_doan_song",AGE_STAGE,2), ("phan_bien",CHALLENGE,3),
           ("bo_sung_goc_nhin",NUANCE,3), ("hieu_chinh_so",CORRECTION,3),
           ("boi_canh_xa_hoi",SOCIAL,3), ("cau_hoi_that",QUESTION,1), ("cam_xuc",EMOTION,2)]

def clean(t):
    t = html.unescape(re.sub(r"<[^>]+>", " ", t or ""))
    return re.sub(r"\s+", " ", t).strip()

def reject_reason(t, min_len):
    if len(t) < min_len:             return f"quá ngắn (<{min_len} ký tự)"
    if EMOJI_ONLY.match(t):          return "chỉ emoji/ký tự"
    if PRAISE.match(t):              return "khen chung chung"
    if GENERIC_PRAISE.match(t):      return "khen chung chung"
    if KEEP_POSTING.search(t):       return "cổ vũ kênh, không có nội dung"
    if BOOK_SPAM.search(t):          return "spam sách (tên tác giả bịa)"
    if INVEST_SPAM.search(t):        return "spam bot đầu tư (khuôn lặp, đổi con số)"
    if TIMESTAMP_ONLY.match(t):      return "chỉ mốc thời gian"
    if VIDEO_META.search(t):         return "góp ý kỹ thuật video, không phải insight"
    return None

def score(t):
    hits, s = [], 0
    for name, pat, w in SIGNALS:
        if pat.search(t): hits.append(name); s += w
    if len(t) > 220: s += 1                      # comment dài thường có nội dung
    return s, hits

def load(path):
    if path.endswith(".json"):
        d = json.load(open(path, encoding="utf-8"))
        return d if isinstance(d, list) else d.get("comments") or d.get("items") or []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter="\t"))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--out", default="comments_clean.tsv")
    ap.add_argument("--rejected", default=None, help="ghi comment bị loại kèm lý do")
    ap.add_argument("--min-len", type=int, default=40)
    ap.add_argument("--min-score", type=int, default=1)
    a = ap.parse_args()

    raw = load(a.input)
    keep, drop = [], []
    for r in raw:
        t = clean(r.get("text") or r.get("textDisplay") or "")
        try: likes = int(float(r.get("likes") or r.get("likeCount") or 0))
        except (TypeError, ValueError): likes = 0
        base = {"video_id": r.get("video_id") or r.get("videoId", ""),
                "title": (r.get("title") or "")[:80], "likes": likes, "do_dai": len(t), "text": t}
        why = reject_reason(t, a.min_len)
        if why:
            drop.append({**base, "ly_do_loai": why}); continue
        s, hits = score(t)
        if s < a.min_score:
            drop.append({**base, "ly_do_loai": f"không tín hiệu (điểm {s})"}); continue
        keep.append({**base, "diem_tin_hieu": s, "tin_hieu": "|".join(hits)})

    keep.sort(key=lambda r: (-r["diem_tin_hieu"], -r["likes"]))
    H = ["diem_tin_hieu", "tin_hieu", "likes", "do_dai", "video_id", "title", "text"]
    with open(a.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, H, delimiter="\t"); w.writeheader()
        for r in keep: w.writerow({k: r.get(k, "") for k in H})
    if a.rejected:
        HR = ["ly_do_loai", "likes", "do_dai", "video_id", "text"]
        with open(a.rejected, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, HR, delimiter="\t"); w.writeheader()
            for r in drop: w.writerow({k: r.get(k, "") for k in HR})

    print(f"vào {len(raw)} → giữ {len(keep)} ({100*len(keep)/max(len(raw),1):.0f}%) · loại {len(drop)}")
    print("\nlý do loại:")
    for k, v in collections.Counter(r["ly_do_loai"] for r in drop).most_common():
        print(f"   {k:<38}{v:>4}")
    print("\ntín hiệu trong nhóm giữ lại:")
    cnt = collections.Counter(h for r in keep for h in r["tin_hieu"].split("|") if h)
    for k, v in cnt.most_common():
        print(f"   {k:<38}{v:>4}  ({100*v/max(len(keep),1):.0f}%)")
    print(f"\n→ {a.out}" + (f" · {a.rejected}" if a.rejected else ""))

if __name__ == "__main__":
    main()
