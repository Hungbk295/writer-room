#!/usr/bin/env python3
"""Tầng 2 — gán nhãn Voice-of-Customer cho comment ĐÃ LỌC.

Tầng 1 (filter_comments.py) trả lời: comment này có đáng đọc không.
Tầng 2 (file này)           trả lời: comment này mang INSIGHT gì.

9 loại insight:
  pain       vấn đề đang khó chịu
  desire     trạng thái họ muốn đạt
  fear       điều họ sợ xảy ra
  objection  điều khiến họ không tin / không làm theo
  question   điều họ chưa hiểu
  request    nội dung họ trực tiếp yêu cầu
  identity   "người như tôi thì..."
  situation  hoàn cảnh khiến vấn đề xuất hiện
  language   cách audience tự mô tả vấn đề (cụm từ nguyên văn)

Regex ở đây chỉ là VÒNG GÁN NHÃN ĐẦU. Các trường sâu — life_stage,
current_state, underlying_question, desired_outcome, niche_goi_y —
phải do người hoặc LLM đọc và điền. Script in ra khung sẵn để làm việc đó.

Dùng:
    python3 extract_voc.py comments_clean.tsv --out voc.tsv
    python3 extract_voc.py comments_clean.tsv --out voc.tsv --for-llm 40
"""
import argparse, csv, re, collections

T = [
 ("pain", r"\b(struggl|stuck|can'?t (afford|save|seem)|hard(est)?|barely|paycheck to paycheck|"
          r"drowning|behind|nothing (saved|left)|broke|tired of|sick of|frustrat|no idea how)\b"),
 ("desire", r"\b(i want|wish i|hope to|goal is|dream|trying to (reach|get|build)|"
            r"can'?t wait to|would love to|aiming for|one day i)\b"),
 ("fear", r"\b(afraid|scared|worr(y|ied)|anxious|nervous|what if i|too late|never (be able|make it)|"
          r"risk of|lose (it all|everything)|outlive|run out)\b"),
 ("objection", r"\b(assume[sd]?|unrealistic|not everyone|easy for (you|them)|must be nice|"
               r"doesn'?t (work|apply|account)|only works if|in reality|not that simple|"
               r"what about (those|people) who|privileg)\b"),
 ("question", r"\b(how (do|would|can) i|should i|what (if|about)|which (one|fund|etf)|"
              r"is it (worth|better)|any (advice|tips)|does (this|it) work|can someone)\b"),
 ("request", r"\b(can you (make|do|cover)|please (make|do)|would love (a|to see)|"
             r"video (on|about)|make one (for|about)|do a (video|breakdown)|next video)\b"),
 ("identity", r"\b(as a \w+|people like (me|us)|those of us|i'?m (just )?a \w+|"
              r"someone (like me|who)|for us \w+|we (who|that)|single (mom|dad|parent))\b"),
 ("situation", r"\b(i'?m \d\d|at \d\d|after (my )?(divorce|layoff|graduat)|just (got|started|lost)|"
               r"since (i|my)|when i (was|got)|now that i|my (wife|husband|kid|mom|dad))\b"),
]
# LANGUAGE: cum tu nguyen van audience dung — trich chu khong phan loai
LANG = re.compile(r"[\"“']([^\"”']{12,70})[\"”']|\b((?:feel|feels|felt) like [^.,!?]{6,50})", re.I)

def tag(t):
    return [n for n, p in T if re.search(p, t, re.I)]

def phrases(t):
    out = []
    for m in LANG.finditer(t):
        out.append((m.group(1) or m.group(2) or "").strip())
    return [p for p in out if p][:3]

def main():
    a = argparse.ArgumentParser()
    a.add_argument("input"); a.add_argument("--out", default="voc.tsv")
    a.add_argument("--for-llm", type=int, default=0,
                   help="in N comment điểm cao nhất ra khung để người/LLM điền trường sâu")
    a = a.parse_args()
    rows = list(csv.DictReader(open(a.input, encoding="utf-8"), delimiter="\t"))
    out, cnt = [], collections.Counter()
    for r in rows:
        t = r.get("text", "")
        ts = tag(t); ph = phrases(t)
        for x in ts: cnt[x] += 1
        if ph: cnt["language"] += 1
        out.append({**r, "insight_types": "|".join(ts) or "chưa gán",
                    "language_phrases": " ⁄ ".join(ph),
                    # trường sâu — để TRỐNG, người/LLM điền
                    "life_stage": "", "current_state": "", "emotion": "",
                    "underlying_question": "", "desired_outcome": "", "niche_goi_y": ""})
    H = ["insight_types", "life_stage", "current_state", "emotion", "underlying_question",
         "desired_outcome", "niche_goi_y", "language_phrases",
         "diem_tin_hieu", "likes", "video_id", "text"]
    with open(a.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, H, delimiter="\t", extrasaction="ignore")
        w.writeheader(); w.writerows(out)
    n = len(rows)
    print(f"{n} comment · gán nhãn vòng đầu\n")
    print(f"{'loại insight':<14}{'số':>5}{'%':>7}")
    for k, v in cnt.most_common():
        print(f"{k:<14}{v:>5}{100*v/max(n,1):>6.0f}%")
    un = sum(1 for r in out if r["insight_types"] == "chưa gán")
    print(f"{'chưa gán':<14}{un:>5}{100*un/max(n,1):>6.0f}%")
    print(f"\n→ {a.out}  (6 cột sâu để trống, chờ người/LLM điền)")
    if a.for_llm:
        print(f"\n{'='*74}\nKHUNG CHO {a.for_llm} COMMENT ĐIỂM CAO NHẤT — điền 6 trường sâu\n{'='*74}")
        for r in out[:a.for_llm]:
            print(f"\n[{r.get('likes','0')} like | {r['insight_types']}]")
            print(f"  {r['text'][:260]}")

if __name__ == "__main__":
    main()
