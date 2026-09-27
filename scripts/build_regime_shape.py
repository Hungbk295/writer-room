#!/usr/bin/env python3
"""Tạo file spy_regime_shape.tsv trong writer-room-data/spy-sheet/inbox_spy/
Bổ sung cột theme_tag: chủ đề chiếm ưu thế trong tuần.
Schema: channel_id | channel_title | week_start | n_videos | median_views | max_views | pov_format_share | theme_tag | as_of | source | collected_at
"""
import os, sys, sqlite3, datetime, math
from collections import Counter

ROOT = "/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room"
DB_PATH = os.path.join(ROOT, "writer-room-data/spy/spy.sqlite")
OUT_FILE = os.path.join(ROOT, "writer-room-data/spy-sheet/inbox_spy/spy_regime_shape.tsv")
AS_OF = "2026-09-18"
COLLECTED_AT = "2026-09-18"

# 15 kênh seed tiếng Anh
TARGETS = [
    ("UCZJnbHQTYBy1I8GpHlsAUMg", "Jack Explains Money"),
    ("UCFPfloFwa6X2UddqRH83rAA", "Alicia Invests"),
    ("UCZ-H-n8fa7NqReTRKe7ByEg", "Wealth Logic"),
    ("UCZjVE44LOvxPyKA-tymFoyQ", "Martik Finance"),
    ("UCl42jG0SdOVmXjcy4MazKvw", "Bille Finance"),
    ("UCXzNNA2ngRpRiWvyA7eGd6w", "Nick Invests"),
    ("UCrNfRFWnLC3tCy1TnyhVQ7g", "Casual Finance"),
    ("UCTcOboZIhgrKHMDm-oTlTOg", "Lucas Grant"),
    ("UCP9RPj_BG0vit2TNM7LuRxA", "Crayon Capital"),
    ("UCc6fcFEqykNVBsbTSP-7S4A", "Rookie Finance"),
    ("UCljjriRhDH7LJBN00mkch5g", "Money Tom"),
    ("UC6AwWrRKNrwt83CMJqeTUzw", "Mr. Finance"),
    ("UC39jphb_m0Cv6MHHWGyP8iQ", "Statrys"),
    ("UCl1TUreU2zcVY4798FXT0Qw", "Biz Life POV"),
    ("UCkPZLXcrP3Hc1J-Xd_uN-Mw", "POV Finance"),
]

RUN_MAP = {
    "UCZJnbHQTYBy1I8GpHlsAUMg": "d2834cc0-9556-4324-8e8f-00a192a5eaa3",
    "UCFPfloFwa6X2UddqRH83rAA": "3912c326-326b-4e9e-a9a2-7cbb192e00d5",
    "UCZ-H-n8fa7NqReTRKe7ByEg": "c39d5791-d0af-4660-b4ff-814d93a1883e",
    "UCZjVE44LOvxPyKA-tymFoyQ": "29037452-0009-4fc7-af06-b93904f3cef0",
    "UCl42jG0SdOVmXjcy4MazKvw": "b548f196-8fa3-41dc-9ae3-9b7e3e02fc34",
    "UCXzNNA2ngRpRiWvyA7eGd6w": "823391e1-9345-488f-bddb-01c659e9ad71",
    "UCrNfRFWnLC3tCy1TnyhVQ7g": "63ce8146-30df-4df3-abdf-294d23d019d9",
    "UCTcOboZIhgrKHMDm-oTlTOg": "1a47fc00-0a8b-48b6-82fe-289a76ddd5e8",
    "UCP9RPj_BG0vit2TNM7LuRxA": "9f0219d1-2c94-42d5-a72a-02e99885cf16",
    "UCc6fcFEqykNVBsbTSP-7S4A": "83745fe7-3a4e-4635-9daf-0db2e89a4c22",
    "UCljjriRhDH7LJBN00mkch5g": "7585ec71-5aa7-42d2-bd82-3abeecb446ce",
    "UC6AwWrRKNrwt83CMJqeTUzw": "f2ea0d54-e9a6-4fc4-ac96-b3031e9c45b4",
    "UC39jphb_m0Cv6MHHWGyP8iQ": "d0b90dda-3a33-4f90-bdd6-2ed1accfd7e0",
    "UCl1TUreU2zcVY4798FXT0Qw": "99de84b2-201e-4075-9404-622bfc0ebbcc",
    "UCkPZLXcrP3Hc1J-Xd_uN-Mw": "07c1e8c6-dac1-436a-863f-08e2b9d4a719",
}

def to_monday(dt):
    mon = dt - datetime.timedelta(days=dt.weekday())
    return mon.strftime("%Y-%m-%d")

def is_pov_format(title):
    t = title.strip().lower()
    return t.startswith("pov") or t.startswith("you ") or t.startswith("you'") or t.startswith("you’")

def classify_title(title):
    t = title.lower()
    if "old money" in t:
        return "old_money"
    if any(k in t for k in ["nobody knows", "in secret", "nobody noticed", "quietly", "stealth", "silence", "told nobody", "quiet millionaire"]):
        return "stealth_wealth"
    if any(k in t for k in ["every level", "level by level", "levels of"]):
        return "levels_progression"
    if any(k in t for k in ["cash for car", "paying cash", "save", "saving", "50% of your income", "frugal", "ordinary salary", "spending"]):
        return "frugality_habits"
    if any(k in t for k in ["retire", "pension", "401k", "roth", "mortgage", "debt"]):
        return "retirement_debt"
    if any(k in t for k in ["laid off", "job", "salary", "promotion", "rat race", "paycheck", "college", "boss", "coworkers", "business instead of"]):
        return "career_ratrace"
    if any(k in t for k in ["fed", "interest rate", "market", "economy", "dollar", "inflation", "bubble", "scam", "nvidia", "byd", "tesla", "etf", "housing", "banking"]):
        return "macro_investing"
    if any(k in t for k in ["rich", "wealth", "millionaire", "billionaire", "fake rich", "money"]):
        return "wealth_identity"
    return "general"

def clean_str(val):
    if val is None:
        return ""
    return str(val).strip().replace("\t", " ").replace("\r", " ").replace("\n", " ")

def format_num(val):
    if val is None or val == "":
        return ""
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return ""
        if f.is_integer():
            return str(int(f))
        return f"{f:.4f}".rstrip("0").rstrip(".")
    except (ValueError, TypeError):
        return str(val).strip()

def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    header = [
        "channel_id", "channel_title", "week_start", "n_videos",
        "median_views", "max_views", "pov_format_share", "theme_tag",
        "as_of", "source", "collected_at"
    ]

    out_rows = []

    for cid, cname in TARGETS:
        rid = RUN_MAP[cid]
        cur.execute("""
            SELECT vs.title, vs.published_at, vs.view_count, vs.channel_title
            FROM video_snapshots vs
            WHERE vs.spy_run_id = ?
            ORDER BY vs.published_at ASC
        """, (rid,))
        rows = cur.fetchall()
        
        real_title = rows[0][3] if rows and rows[0][3] else cname

        weeks = {}
        for title, pub, views, _ in rows:
            if not pub or views is None:
                continue
            try:
                dt = datetime.datetime.fromisoformat(pub.replace("Z", "+00:00"))
                w = to_monday(dt)
                tag = classify_title(title)
                weeks.setdefault(w, []).append((title, views, tag))
            except Exception:
                pass

        for w in sorted(weeks.keys()):
            vids = weeks[w]
            v_list = [x[1] for x in vids]
            s_v = sorted(v_list)
            med = s_v[len(s_v)//2]
            mx = max(v_list)
            pov_cnt = sum(1 for x in vids if is_pov_format(x[0]))
            pov_share = pov_cnt / len(vids)

            # Xác định theme_tag chiếm ưu thế trong tuần
            tag_counts = Counter([x[2] for x in vids])
            tag_views = {}
            for _, v, tag in vids:
                tag_views[tag] = tag_views.get(tag, 0) + v
            # Sắp xếp theo số video trước, nếu bằng nhau sắp theo tổng view
            dominant_theme = sorted(tag_counts.keys(), key=lambda t: (tag_counts[t], tag_views[t]), reverse=True)[0]

            out_rows.append([
                cid,
                real_title,
                w,
                str(len(vids)),
                format_num(med),
                format_num(mx),
                format_num(pov_share),
                dominant_theme,
                AS_OF,
                "spy_run_manifest",
                COLLECTED_AT
            ])

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        f.write("\t".join(header) + "\n")
        for r in out_rows:
            f.write("\t".join(clean_str(x) for x in r) + "\n")

    print(f"Ghi xong {OUT_FILE}: {len(out_rows)} dòng x {len(header)} cột cho 15 kênh seed.")

if __name__ == "__main__":
    main()
