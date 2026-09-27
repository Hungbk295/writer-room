#!/usr/bin/env python3
"""Đo transcript đầy đủ của một video — chỉ số đo được, tái lập được.

KHÔNG diễn giải. File này chỉ ĐO. Diễn giải là việc của người/LLM ở bước sau,
và chỉ hợp lệ khi có nhóm đối chứng (xem compare_transcripts.py).

Đầu vào : file .json3 từ yt-dlp --write-auto-subs --sub-langs en-orig --sub-format json3
Đầu ra  : một dòng TSV chỉ số, hoặc JSON

Dùng:
    yt-dlp --skip-download --write-auto-subs --sub-langs en-orig --sub-format json3 \
           -o "%(id)s.%(ext)s" "https://www.youtube.com/watch?v=VIDEO_ID"
    python3 analyze_transcript.py VIDEO_ID.en-orig.json3 --video-id VIDEO_ID
"""
import argparse, json, re, statistics, sys, csv, os

# ── Mật độ: đếm trên 1000 từ. Đây là các chiều PHÂN BIỆT được, không phải mô tả ──
DENS = {
 "you_per1k":        r"\byou\b|\byour\b|\byou'?re\b|\byou'?ve\b|\byou'?ll\b|\byourself\b",
 "we_per1k":         r"\bwe\b|\bour\b|\bus\b",            # đối lập với you — kênh nào dùng we thì khác chất
 "i_per1k":          r"\bi\b|\bmy\b|\bme\b|\bmine\b",
 "number_per1k":     r"\$[\d,]+|\b\d{2,}\b|\b\d+%|\b\d+ (years?|months?|weeks?|days?|dollars?)\b",
 "concrete_per1k":   r"\b(coffee|kitchen|driveway|garage|car|phone|door|window|shoes|desk|mailbox|"
                     r"screen|couch|bill|receipt|keys|fridge|alarm|closet|wallet|grocery|rent|"
                     r"paycheck|truck|apartment|neighbou?r)\b",
 "abstract_per1k":   r"\b(financial freedom|wealth building|mindset|strategy|discipline|principle|"
                     r"framework|journey|potential|abundance|alignment|optimi[sz]e|leverage)\b",
 "hedge_per1k":      r"\b(maybe|perhaps|might|probably|sort of|kind of|i think|arguably)\b",
 "absolute_per1k":   r"\b(never|always|every single|nobody|everyone|no one|zero)\b",
}
# ── Cơ chế tự sự: đếm và ghi VỊ TRÍ, vì phân bố quan trọng hơn tổng số ──
MECH = {
 "open_loop":   r"\b(but here'?s|the thing is|and that'?s (when|where)|here'?s (why|what|the)|"
                r"what (happens|comes) next|and this is (why|where)|the strange part|"
                r"the part nobody|what nobody)\b",
 "contrast":    r"\b(most people|everyone else|nobody|while (others|they)|unlike|the difference|"
                r"instead of|rather than)\b",
 "time_jump":   r"\b(a year later|\d+ years? later|by (then|now)|that (morning|night)|eventually|"
                r"over time|after (that|a while)|months? later|one day)\b",
 "question":    r"\?",
 "direct_cmd":  r"\b(remember|notice|imagine|picture|look at|think about|listen)\b",
}

def load(p):
    d = json.load(open(p, encoding="utf-8"))
    segs = []
    for e in d.get("events", []):
        t = e.get("tStartMs", 0) / 1000
        txt = "".join(s.get("utf8", "") for s in (e.get("segs") or [])).strip()
        if txt: segs.append((t, txt))
    return segs

def analyze(segs):
    if not segs: return None
    full = re.sub(r"\s+", " ", " ".join(t for _, t in segs))
    words = full.split(); W = len(words)
    dur = segs[-1][0]
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", full) if len(s.strip()) > 4]
    sl = [len(s.split()) for s in sents] or [0]
    o = {"n_words": W, "duration_sec": round(dur, 1),
         "wpm_overall": round(W / (dur / 60), 1) if dur else 0,
         "n_sentences": len(sents),
         "sent_len_median": statistics.median(sl),
         "sent_len_p90": sorted(sl)[int(len(sl) * .9)] if sl else 0}
    # nhip theo phut -> do bien thien
    bym = {}
    for t, txt in segs: bym.setdefault(int(t // 60), []).extend(txt.split())
    wpm = [len(v) for v in bym.values()]
    o["wpm_min"], o["wpm_max"] = min(wpm), max(wpm)
    o["wpm_cv"] = round(statistics.pstdev(wpm) / statistics.mean(wpm), 3) if len(wpm) > 1 else 0
    for k, pat in DENS.items():
        o[k] = round(1000 * len(re.findall(pat, full, re.I)) / W, 1) if W else 0
    # co che + phan bo theo 3 phan
    third = dur / 3 if dur else 1
    for k, pat in MECH.items():
        pos = [t for t, txt in segs if re.search(pat, txt, re.I)]
        o[f"{k}_n"] = len(re.findall(pat, full, re.I))
        o[f"{k}_dau"] = sum(1 for t in pos if t < third)
        o[f"{k}_giua"] = sum(1 for t in pos if third <= t < 2 * third)
        o[f"{k}_cuoi"] = sum(1 for t in pos if t >= 2 * third)
    # VUNG CHET: doan dai nhat khong co you / so / chi tiet cu the
    live = re.compile(DENS["you_per1k"] + "|" + DENS["number_per1k"] + "|" + DENS["concrete_per1k"], re.I)
    gap, worst, wstart = 0, 0, 0
    last = 0.0
    for t, txt in segs:
        if live.search(txt):
            if t - last > worst: worst, wstart = t - last, last
            last = t
    o["dead_zone_sec"] = round(worst, 1)
    o["dead_zone_at"] = f"{int(wstart//60)}:{int(wstart%60):02d}"
    # lap lai cum 3 tu (callback)
    tri = [" ".join(words[i:i+3]).lower() for i in range(len(words) - 2)]
    from collections import Counter
    rep = [(g, c) for g, c in Counter(tri).most_common(40)
           if c >= 4 and not all(w in ("the","a","of","to","in","and","you","your","that","it","is") for w in g.split())]
    o["callback_top"] = " | ".join(f"{g}×{c}" for g, c in rep[:3])
    o["callback_n"] = len(rep)
    return o

def main():
    a = argparse.ArgumentParser()
    a.add_argument("json3"); a.add_argument("--video-id", default="")
    a.add_argument("--append", help="ghi thêm vào file TSV này")
    a = a.parse_args()
    r = analyze(load(a.json3))
    if not r: print("transcript rỗng"); sys.exit(1)
    r = {"video_id": a.video_id or os.path.basename(a.json3).split(".")[0], **r}
    if a.append:
        new = not os.path.exists(a.append)
        with open(a.append, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, list(r.keys()), delimiter="\t")
            if new: w.writeheader()
            w.writerow(r)
        print(f"+1 dòng → {a.append}")
    else:
        for k, v in r.items(): print(f"{k:<20}{v}")

if __name__ == "__main__":
    main()
