#!/usr/bin/env python3
"""Tạo 3 file TSV chuẩn cho Vòng 2 trong writer-room-data/spy-sheet/inbox_spy/
Sử dụng dữ liệu thuần túy từ Writer Room Spy MCP (SQLite / MCP API).
Không can thiệp vào inbox/ cũ, không đụng vào Google Sheet.
"""
import os, sys, sqlite3, json, math, datetime

ROOT = "/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room"
DB_PATH = os.path.join(ROOT, "writer-room-data/spy/spy.sqlite")
OUT_DIR = os.path.join(ROOT, "writer-room-data/spy-sheet/inbox_spy")
COLLECTED_AT = "2026-09-18"

# 16 Kênh Seed (bỏ @NolanFinance1 vì 404)
TARGETS = [
    ("UCZJnbHQTYBy1I8GpHlsAUMg", "@JackExplainsMoneyUS", "Jack Explains Money", "en"),
    ("UCFPfloFwa6X2UddqRH83rAA", "@AliciaInvestsUS", "Alicia Invests", "en"),
    ("UCZ-H-n8fa7NqReTRKe7ByEg", "@TheWealth_Logic", "Wealth Logic", "en"),
    ("UCZjVE44LOvxPyKA-tymFoyQ", "@MartikFinance", "Martik Finance", "en"),
    ("UCl42jG0SdOVmXjcy4MazKvw", "@Bille_Finance", "Bille Finance", "en"),
    ("UCXzNNA2ngRpRiWvyA7eGd6w", "@nickinvestsUS", "Nick Invests", "en"),
    ("UCrNfRFWnLC3tCy1TnyhVQ7g", "@CasuallyFinance", "Casual Finance", "en"),
    ("UCTcOboZIhgrKHMDm-oTlTOg", "@LucasGrant-usa", "Lucas Grant", "en"),
    ("UCP9RPj_BG0vit2TNM7LuRxA", "@Crayon_Capital", "Crayon Capital", "en"),
    ("UCc6fcFEqykNVBsbTSP-7S4A", "@RookieFinance-u4d", "Rookie Finance", "en"),
    ("UCljjriRhDH7LJBN00mkch5g", "@MoneyTom-m7n", "Money Tom", "en"),
    ("UC6AwWrRKNrwt83CMJqeTUzw", "@misterfinanceyt", "Mr. Finance", "en"),
    ("UC39jphb_m0Cv6MHHWGyP8iQ", "@Statrys", "Statrys", "en"),
    ("UCl1TUreU2zcVY4798FXT0Qw", "@DAGOLDENTOOTH", "Biz Life POV", "en"),
    ("UCMHqvYlua18WMmPggAIcsVg", "@tramtrithucvn", "Trạm Trí Thức", "vi"),
    ("UCkPZLXcrP3Hc1J-Xd_uN-Mw", "@POVFinanceUS", "POV Finance", "en"),
]

# Run IDs đã quét chuẩn scan_limit=200
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
    "UCMHqvYlua18WMmPggAIcsVg": "fd4f2398-fa1b-4556-8788-1f85b141ecd3",
    "UCkPZLXcrP3Hc1J-Xd_uN-Mw": "07c1e8c6-dac1-436a-863f-08e2b9d4a719",
}

def clean_str(val):
    if val is None:
        return ""
    s = str(val).strip().replace("\t", " ").replace("\r", " ").replace("\n", " ")
    return s

def format_num(val):
    if val is None or val == "":
        return ""
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return ""
        if f.is_integer():
            return str(int(f))
        # Làm tròn tối đa 4 chữ số thập phân cho gọn
        return f"{f:.4f}".rstrip("0").rstrip(".")
    except (ValueError, TypeError):
        return str(val).strip()

def flatten_dict(d, prefix=""):
    items = {}
    for k, v in d.items():
        key = f"{prefix}_{k}" if prefix else k
        if isinstance(v, dict):
            if "value" in v and len(v) <= 3 and ("method" in v or "reason" in v):
                items[key] = v.get("value")
            elif k == "dayOfWeekHistogram":
                for dow, cnt in v.items():
                    items[f"{key}_{dow}"] = cnt
            elif k == "bands":
                pass
            else:
                items.update(flatten_dict(v, key))
        elif isinstance(v, list):
            if k == "bands":
                for b in v:
                    bname = b["band"].replace("<", "lt_").replace(">", "gt_").replace("-", "_")
                    items[f"duration_band_{bname}_count"] = b.get("count")
                    items[f"duration_band_{bname}_median"] = b.get("viewMedian")
                    items[f"duration_band_{bname}_lift"] = b.get("liftVsChannel")
            elif k == "featureLift":
                for f in v:
                    items[f"feature_{f['feature']}_lift"] = f.get("lift")
        else:
            items[key] = v
    return items

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    ref_date = datetime.datetime(2026, 9, 18, tzinfo=datetime.timezone.utc)

    # -------------------------------------------------------------
    # 1. Thu thập dữ liệu theo từng kênh
    # -------------------------------------------------------------
    dim_channel_rows = []
    fact_video_rows = []
    profile_dicts = []

    for cid, handle, title_default, lang in TARGETS:
        rid = RUN_MAP[cid]

        # Đọc channel info
        cur.execute("""
            SELECT handle, title, subscriber_count, video_count, total_view_count
            FROM channels
            WHERE youtube_uc_id = ? OR channel_id LIKE ?
            ORDER BY fetched_at DESC LIMIT 1
        """, (cid, f"%{cid}%"))
        ch_info = cur.fetchone()
        
        real_handle = handle
        ch_title = title_default
        sub_count = ""
        if ch_info:
            if ch_info[0] and ch_info[0].startswith("@"):
                real_handle = ch_info[0]
            if ch_info[1]:
                ch_title = ch_info[1]
            if ch_info[2] is not None:
                sub_count = ch_info[2]

        # Đọc snapshots
        cur.execute("""
            SELECT id, source_video_id, title, published_at, view_count, duration_sec,
                   like_count, comment_count, transcript_status
            FROM video_snapshots
            WHERE spy_run_id = ?
            ORDER BY published_at DESC
        """, (rid,))
        snaps = cur.fetchall()

        views_list = [r[4] for r in snaps if r[4] is not None]
        durs_list = [r[5] for r in snaps if r[5] is not None]
        pubs_list = [r[3] for r in snaps if r[3]]

        video_count_scanned = len(snaps)
        total_views_scanned = sum(views_list) if views_list else 0
        s_views = sorted(views_list)
        if s_views:
            median_views = s_views[len(s_views)//2]
        else:
            median_views = ""
        avg_views = total_views_scanned / video_count_scanned if video_count_scanned > 0 else ""
        avg_duration_sec = sum(durs_list) / len(durs_list) if durs_list else ""
        first_published = min(pubs_list)[:10] if pubs_list else ""
        last_published = max(pubs_list)[:10] if pubs_list else ""

        # Ghi hàng cho spy_dim_channel
        dim_channel_rows.append([
            cid,
            real_handle,
            ch_title,
            rid,
            format_num(sub_count),
            format_num(video_count_scanned),
            format_num(total_views_scanned),
            format_num(median_views),
            format_num(avg_views),
            format_num(avg_duration_sec),
            first_published,
            last_published,
            lang,
            "TRUE",
            "spy_channel_start+spy_channel_profile",
            COLLECTED_AT
        ])

        # Đọc metrics payload (chứa outliers, performance, title lifts, cadence, duration)
        cur.execute("""
            SELECT payload_json, computed_at
            FROM metrics
            WHERE spy_run_id = ? AND scope = "channel"
            ORDER BY computed_at DESC LIMIT 1
        """, (rid,))
        m_row = cur.fetchone()
        payload = json.loads(m_row[0]) if m_row else {}
        computed_at = m_row[1] if m_row else ""

        # Outliers mapping
        outliers_map = {}
        for o in payload.get("outliers", []):
            vid = o.get("videoId")
            if vid:
                sc = o.get("outlierScore")
                score_val = sc.get("value") if isinstance(sc, dict) else sc
                method_val = sc.get("method") if isinstance(sc, dict) else o.get("method", "deterministic")
                # Chỉ lấy những video thực sự có điểm outlier >= 1.5 theo quy định của spy_channel_outliers
                if score_val is not None and score_val >= 1.5:
                    outliers_map[vid] = {
                        "cohort": o.get("cohort", ""),
                        "outlier_score": score_val,
                        "metric_used": o.get("metricUsed", "view"),
                        "method": method_val or "deterministic"
                    }

        # Tạo rows cho spy_fact_video
        for snap in snaps:
            snap_id, vid, vtitle, pub_at, vviews, vdur, likes, comments, trans_st = snap
            # velocity = views / max(1, age_days)
            vel = ""
            if pub_at and vviews is not None:
                try:
                    dt = datetime.datetime.fromisoformat(pub_at.replace("Z", "+00:00"))
                    age_d = max(1.0, (ref_date - dt).total_seconds() / 86400.0)
                    vel = vviews / age_d
                except Exception:
                    pass

            # engagement = (likes + comments) / views
            eng = ""
            if vviews and vviews > 0:
                if likes is not None or comments is not None:
                    tot_eng = (likes or 0) + (comments or 0)
                    eng = tot_eng / vviews

            # outlier info
            out_info = outliers_map.get(vid, {})
            cohort = out_info.get("cohort", "")
            out_score = out_info.get("outlier_score", "")
            metric_used = out_info.get("metric_used", "")
            method = out_info.get("method", "")

            has_trans = "TRUE" if trans_st not in ("skipped", "failed", None, "") else "FALSE"

            fact_video_rows.append([
                vid,
                cid,
                ch_title,
                rid,
                snap_id,
                clean_str(vtitle),
                pub_at[:10] if pub_at else "",
                format_num(vviews),
                format_num(vdur),
                format_num(vel),
                format_num(eng),
                cohort,
                format_num(out_score),
                metric_used,
                method,
                has_trans,
                "spy_channel_videos+spy_channel_outliers",
                COLLECTED_AT
            ])

        # Flatten profile dict
        flat_p = flatten_dict(payload)
        flat_p["channel_id"] = cid
        flat_p["spy_run_id"] = rid
        flat_p["computed_at"] = computed_at
        flat_p["source"] = "spy_channel_profile"
        flat_p["collected_at"] = COLLECTED_AT
        profile_dicts.append(flat_p)

    # -------------------------------------------------------------
    # 2. Ghi file A: spy_dim_channel.tsv
    # -------------------------------------------------------------
    dim_header = [
        "channel_id", "handle", "channel_title", "spy_run_id", "subscriber_count",
        "video_count_scanned", "total_views_scanned", "median_views", "avg_views",
        "avg_duration_sec", "first_published", "last_published", "language_guess",
        "is_seed", "source", "collected_at"
    ]
    path_dim = os.path.join(OUT_DIR, "spy_dim_channel.tsv")
    with open(path_dim, "w", encoding="utf-8") as f:
        f.write("\t".join(dim_header) + "\n")
        for r in dim_channel_rows:
            f.write("\t".join(clean_str(x) for x in r) + "\n")
    print(f"Ghi xong {path_dim}: {len(dim_channel_rows)} dòng x {len(dim_header)} cột")

    # -------------------------------------------------------------
    # 3. Ghi file B: spy_fact_video.tsv
    # -------------------------------------------------------------
    fact_header = [
        "video_id", "channel_id", "channel_title", "spy_run_id", "video_snapshot_id",
        "title", "published_at", "view_count", "duration_sec", "velocity",
        "engagement", "cohort", "outlier_score", "metric_used", "method",
        "has_transcript", "source", "collected_at"
    ]
    path_fact = os.path.join(OUT_DIR, "spy_fact_video.tsv")
    with open(path_fact, "w", encoding="utf-8") as f:
        f.write("\t".join(fact_header) + "\n")
        for r in fact_video_rows:
            f.write("\t".join(clean_str(x) for x in r) + "\n")
    print(f"Ghi xong {path_fact}: {len(fact_video_rows)} dòng x {len(fact_header)} cột")

    # -------------------------------------------------------------
    # 4. Ghi file C: spy_channel_profile.tsv
    # -------------------------------------------------------------
    # Thu thập tất cả key hợp lệ
    profile_keys = set()
    for d in profile_dicts:
        profile_keys.update(d.keys())
    
    # Sắp xếp thứ tự cột logic: id -> run -> computed_at -> performance -> cadence -> duration -> feature -> source -> collected_at
    lead_cols = ["channel_id", "spy_run_id", "computed_at"]
    tail_cols = ["source", "collected_at"]
    mid_cols = sorted([k for k in profile_keys if k not in lead_cols and k not in tail_cols])
    prof_header = lead_cols + mid_cols + tail_cols

    path_prof = os.path.join(OUT_DIR, "spy_channel_profile.tsv")
    with open(path_prof, "w", encoding="utf-8") as f:
        f.write("\t".join(prof_header) + "\n")
        for d in profile_dicts:
            row = [format_num(d.get(col, "")) for col in prof_header]
            f.write("\t".join(clean_str(x) for x in row) + "\n")
    print(f"Ghi xong {path_prof}: {len(profile_dicts)} dòng x {len(prof_header)} cột")

if __name__ == "__main__":
    main()
