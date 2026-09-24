import json
import os
import re
from datetime import datetime

COLLECTED_AT = "2026-09-18"
COLLECTED_DATE = datetime.strptime(COLLECTED_AT, "%Y-%m-%d")

# Duration parser ISO PT1H2M3S -> seconds
def parse_duration(d_str):
    if not d_str:
        return 0
    if isinstance(d_str, int):
        return d_str
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', d_str)
    if not m:
        return 0
    hours = int(m.group(1) or 0)
    minutes = int(m.group(2) or 0)
    seconds = int(m.group(3) or 0)
    return hours * 3600 + minutes * 60 + seconds

def parse_date(date_str):
    if not date_str:
        return ""
    # Can be ISO string like "2026-09-02T22:15:21Z" or "2026-09-02" or timestamp
    if isinstance(date_str, (int, float)):
        return datetime.utcfromtimestamp(date_str).strftime("%Y-%m-%d")
    m = re.match(r'(\d{4}-\d{2}-\d{2})', str(date_str))
    if m:
        return m.group(1)
    return ""

def format_tsv_val(val):
    if val is None or val == "" or str(val).strip().lower() in ["none", "nan", "null"]:
        return ""
    return str(val).replace("\t", " ").replace("\r", "").replace("\n", " ").strip()

def clean_tsv_str(s):
    return format_tsv_val(s)

def main():
    # Load all collected artifacts
    with open('scripts/existing_outliers.json') as f:
        old_sheet_rows = json.load(f)[1:]

    with open('scripts/existing_50_videos_meta.json') as f:
        old_vids_meta = {v['id']: v for v in json.load(f)}

    with open('scripts/existing_50_medians.json') as f:
        old_medians = json.load(f)

    with open('scripts/new_core_videos_full_meta.json') as f:
        new_vids_meta = json.load(f)

    with open('scripts/verified_core_outliers.json') as f:
        v_list1 = {v['videoId']: v for v in json.load(f)}
    with open('scripts/additional_verified_core.json') as f:
        v_list2 = {v['videoId']: v for v in json.load(f)}
    raw_core_candidates = {**v_list1, **v_list2}

    with open('scripts/all_115_channels_meta.json') as f:
        channels_meta = {c['id']: c for c in json.load(f)}

    with open('scripts/all_channel_stats.json') as f:
        channels_stats = json.load(f)

    with open('scripts/channel_handles.json') as f:
        channels_handles = json.load(f)

    with open('scripts/channel_video_metrics.json') as f:
        channels_vid_metrics = json.load(f)

    # 1. Classifications for the 50 old rows
    # Map index/video_id -> relevance, format_tag, topic_tag
    old_curation = {
        "tws7DDdR-T4": ("core", "audiobook", "money_habits"),
        "WT6Fizq3BV4": ("adjacent", "vlog", "trading_prop_firm"),
        "Q5uVYQXxCg4": ("off", "listicle", "crafting_hacks"),
        "E8BbWoP9-Xk": ("off", "interview", "institutional_finance"),
        "O8BOvoAMk1U": ("core", "explainer", "retirement"),
        "LHmcFcLEMd0": ("adjacent", "interview", "australian_property"),
        "45W-kVCMY8U": ("off", "news", "emergency_preparedness"),
        "0p8ZElZCH9k": ("off", "explainer", "history_documentary"),
        "5kmAc0q1MFU": ("core", "listicle", "investing_stocks"),
        "pRUx-QpbeP4": ("off", "explainer", "nepal_exam_solution"),
        "rnu2uBkzje0": ("off", "explainer", "coin_collecting"),
        "Q3IeTp4Y628": ("adjacent", "listicle", "life_habits"),
        "bg-k1cyo1CI": ("adjacent", "interview", "singapore_finance"),
        "Q0jfwAdO71o": ("off", "listicle", "survival_prepping"),
        "_pPmFAhbqQE": ("adjacent", "explainer", "corporate_finance"),
        "66eLsC6T_nU": ("core", "vlog", "frugal_living"),
        "hDpWwNzW1CM": ("core", "explainer", "retirement"),
        "dxOXha6fArs": ("off", "other", "gaming_saves"),
        "MpRWRSHlXd8": ("core", "listicle", "money_habits"),
        "ajvQceCSLg0": ("off", "explainer", "india_motorcycle_emi"),
        "fd0ZCw1ZVNE": ("off", "news", "australian_news"),
        "KCt9a9AnNfk": ("off", "news", "financial_news"),
        "7GxUGYJOJoQ": ("off", "listicle", "survival_prepping"),
        "07PsDoBOGOA": ("core", "listicle", "underconsumption"),
        "CIC8PFagdfU": ("core", "explainer", "dividend_income"),
        "bhX3RA03mfA": ("core", "explainer", "wealth_building"),
        "bGGlDtU3Guw": ("off", "interview", "india_fintech_news"),
        "KyfXOblWqRo": ("core", "vlog", "budgeting"),
        "rNiHjxe9g_A": ("off", "reaction", "channel_critique"),
        "HqewY5X5doY": ("off", "other", "religious_sermon"),
        "fIVwbJTRuxE": ("adjacent", "listicle", "dutch_money_habits"),
        "tPyx0BYWyL0": ("adjacent", "explainer", "money_psychology"),
        "nQMltx4ZP7w": ("off", "other", "cartoon_clip"),
        "_9tyTHK5eD0": ("core", "explainer", "financial_independence"),
        "RzmG92puPzs": ("core", "listicle", "frugal_habits"),
        "qj7ZYBC4ir0": ("core", "listicle", "frugal_habits"),
        "-nGMoV1PN5g": ("off", "news", "financial_news"),
        "OHcJIxVYEFI": ("core", "pov_story", "frugal_habits"),
        "9fFXt3VqV_0": ("off", "news", "local_news"),
        "O9f5E9jhGR0": ("core", "explainer", "wealth_building"),
        "s7bwcm1hwMU": ("adjacent", "explainer", "australian_property"),
        "3LPjV2ChW-Y": ("adjacent", "interview", "indian_investing"),
        "yfiXevifbyE": ("adjacent", "explainer", "kenya_investing"),
        "Ma0ror5AnUA": ("off", "news", "australian_news"),
        "mvvbRC1-Uts": ("adjacent", "explainer", "nigerian_wealth"),
        "vUYR5zv6gqU": ("core", "explainer", "money_habits"),
        "edcS400HxDM": ("off", "interview", "football_club_finance"),
        "dwtrXyPM6_I": ("off", "explainer", "video_production"),
        "8KKe404IpwM": ("core", "explainer", "wealth_building"),
        "XF57G6vty-g": ("core", "explainer", "wealth_building")
    }

    fact_video_rows = []
    seen_video_ids = set()

    # Part 1: Process 50 old rows
    print("Processing Part 1: 50 existing rows...")
    for r in old_sheet_rows:
        v_url = r[4]
        vid_id = v_url.split('v=')[-1]
        v_meta = old_vids_meta.get(vid_id, {})
        med_info = old_medians.get(vid_id, {})

        ch_id = v_meta.get('channelId') or r[1].split('channel/')[-1]
        ch_title = v_meta.get('channelTitle') or r[0]
        title = v_meta.get('title') or r[3]
        pub_at = parse_date(v_meta.get('publishedAt') or r[8])
        views = v_meta.get('viewCount') if v_meta.get('viewCount') is not None else int(r[5])
        likes = v_meta.get('likeCount') if v_meta.get('likeCount') is not None else ""
        comments = v_meta.get('commentCount') if v_meta.get('commentCount') is not None else ""
        dur = parse_duration(v_meta.get('duration'))
        is_short = "FALSE"

        ch_med = med_info.get('median_views', "")
        ratio = med_info.get('outlier_ratio', "")

        # Views per day
        if pub_at:
            try:
                days = (COLLECTED_DATE - datetime.strptime(pub_at, "%Y-%m-%d")).days
                vpd = round(views / max(1, days), 1)
            except Exception:
                vpd = ""
        else:
            vpd = ""

        rel, fmt, top = old_curation.get(vid_id, ("off", "other", "finance"))
        src = "vidiq_get_videos_by_ids"

        row = {
            "video_id": vid_id,
            "channel_id": ch_id,
            "channel_title": clean_tsv_str(ch_title),
            "title": clean_tsv_str(title),
            "published_at": pub_at,
            "view_count": views,
            "like_count": likes,
            "comment_count": comments,
            "duration_sec": dur,
            "is_short": is_short,
            "channel_median_views": ch_med,
            "outlier_ratio": ratio,
            "views_per_day": vpd,
            "format_tag": fmt,
            "topic_tag": top,
            "relevance": rel,
            "source": src,
            "collected_at": COLLECTED_AT
        }
        fact_video_rows.append(row)
        seen_video_ids.add(vid_id)

    print(f"Part 1 rows processed: {len(fact_video_rows)}")

    # Part 2: Process 70 new verified core outlier videos
    print("Processing Part 2: New core outlier videos...")
    bad_vids = {
        "FonFon", "Squawk 619", "TaxPayers' Alliance", "CapX", "1% Aura", 
        "AwayWithJoe", "Mishi daily routine ", "Home Central", "So Nasty Entertainment ", 
        "MarketBeat Clips"
    }

    # Assign topic_tag and format_tag dynamically based on title
    def get_core_tags(title):
        t_low = title.lower()
        if "audiobook" in t_low:
            fmt = "audiobook"
        elif "react" in t_low:
            fmt = "reaction"
        elif any(w in t_low for w in ["routine", "paycheck", "budget with me", "debt numbers", "what i spend"]):
            fmt = "vlog"
        elif any(w in t_low for w in ["habits", "mistakes", "rules", "things", "signs", "reasons", "ways", "accounts", "upgrades"]):
            fmt = "listicle"
        elif any(w in t_low for w in ["story", "confessions", "reveal", "journey"]):
            fmt = "pov_story"
        else:
            fmt = "explainer"

        if any(w in t_low for w in ["401k", "401(k)"]):
            top = "401k"
        elif any(w in t_low for w in ["ira", "roth", "rmd"]):
            top = "roth_ira"
        elif any(w in t_low for w in ["retire", "retirement", "pension", "social security"]):
            top = "retirement"
        elif any(w in t_low for w in ["mortgage", "renting vs buying", "home"]):
            top = "mortgage_payoff"
        elif any(w in t_low for w in ["frugal", "save", "saving", "poor man", "broke", "wasting"]):
            top = "frugal_habits"
        elif any(w in t_low for w in ["underconsumption", "underconsumer"]):
            top = "underconsumption"
        elif any(w in t_low for w in ["stealth wealth", "quiet luxury", "old money", "invisible money"]):
            top = "stealth_wealth"
        elif any(w in t_low for w in ["dividend"]):
            top = "dividend_income"
        elif any(w in t_low for w in ["index fund", "fidelity", "vanguard", "invest"]):
            top = "index_funds"
        elif any(w in t_low for w in ["debt", "pay off"]):
            top = "debt_payoff"
        else:
            top = "money_habits"

        return fmt, top

    new_core_count = 0
    # Sort new core by outlier ratio descending
    sorted_new_candidates = sorted(
        raw_core_candidates.values(), 
        key=lambda x: x.get('calculated_outlier_ratio') or 0, 
        reverse=True
    )

    for c in sorted_new_candidates:
        vid_id = c['videoId']
        if vid_id in seen_video_ids:
            continue
        ch_title = c.get('channelTitle', '')
        if ch_title in bad_vids:
            continue
        if c.get('calculated_outlier_ratio', 0) < 3.0:
            continue

        meta = new_vids_meta.get(vid_id, {})
        if not meta:
            continue

        cid = c['channelId']
        title = meta.get('title') or c.get('videoTitle', '')
        pub_at = parse_date(meta.get('publishedAt') or c.get('videoPublishedAt'))
        views = meta.get('viewCount') or c.get('viewCount', 0)
        likes = meta.get('likeCount', '')
        comments = meta.get('commentCount', '')
        dur = parse_duration(meta.get('duration')) or c.get('videoDuration', 0)
        is_short = "FALSE"

        ch_med = c.get('calculated_channel_median', '')
        ratio = c.get('calculated_outlier_ratio', '')

        if pub_at:
            try:
                days = (COLLECTED_DATE - datetime.strptime(pub_at, "%Y-%m-%d")).days
                vpd = round(views / max(1, days), 1)
            except Exception:
                vpd = ""
        else:
            vpd = ""

        fmt, top = get_core_tags(title)
        rel = "core"
        src = "vidiq_outliers"

        row = {
            "video_id": vid_id,
            "channel_id": cid,
            "channel_title": clean_tsv_str(ch_title),
            "title": clean_tsv_str(title),
            "published_at": pub_at,
            "view_count": views,
            "like_count": likes,
            "comment_count": comments,
            "duration_sec": dur,
            "is_short": is_short,
            "channel_median_views": ch_med,
            "outlier_ratio": ratio,
            "views_per_day": vpd,
            "format_tag": fmt,
            "topic_tag": top,
            "relevance": rel,
            "source": src,
            "collected_at": COLLECTED_AT
        }
        fact_video_rows.append(row)
        seen_video_ids.add(vid_id)
        new_core_count += 1

    print(f"Part 2 new core rows processed: {new_core_count}")
    print(f"Total rows in fact_video_outlier: {len(fact_video_rows)}")

    # 2. Build dim_channel_outlier
    print("\nBuilding dim_channel_outlier...")
    all_channel_ids = list(dict.fromkeys([r['channel_id'] for r in fact_video_rows]))
    print(f"Total unique channels: {len(all_channel_ids)}")

    # Faceless manual classifications
    faceless_map = {
        "UClMcY_R_W-prVWTO3nUBeFg": "TRUE",   # Mind Over Pages
        "UCKhpM-cu2Cod-GyG6KngNYg": "TRUE",   # Logical Money
        "UCfdNM3NAhaBOXCafH7krzrA": "TRUE",   # The Infographics Show
        "UC9Yv9fwZGNi77S2NDqRDgEQ": "TRUE",   # Forgotten Ways to Make Money
        "UC8YvQpqqnxCenV3kPNm0fWg": "TRUE",   # Restful Wealth
        "UCGnEifqFXS1JzXPXKuvMjTw": "TRUE",   # Silverline Economy
        "UCi5PwwrMllGPHG-2S9hSkuQ": "TRUE",   # Sight of Fortitude
        "UCGKoYDkQcHE7bZ4gCg6gSiA": "TRUE",   # MindQuarry Audiobook
        "UCw8yWhWk7pchXIB_qUPUsNA": "TRUE",   # Wealth Construct
        "UC6QgBMuWxGlz7xhacWZZbaw": "TRUE",   # Money Mastery Audiobooks
        "UC903Q5A0J9KUfldLGZ4sZJQ": "TRUE",   # Real Math Money
        "UCxoC2voi0vPg2hwqgfjdhYw": "TRUE",   # Carl Invests
        "UC63n-uPwtfY71kO4ME6wGAg": "TRUE",   # KIM FINANCE
        "UCogYxvdGc8i7qfjPct1c-Bg": "TRUE",   # Finance Simplified
        "UCCn_sMT2AliFdlXKlvTrwdQ": "TRUE",   # Academic Gain Tutorials
        "UCHqDy8pKfyAoAg6fW1_0ZJA": "TRUE",   # Cash Woke
        "UCDllZcL6UODaGN56bkh6qQg": "TRUE",   # Big Dream Investing
        "UCL58WqBMCDsoH68j9Dy7l5A": "TRUE",   # Investor Motivation
        "UCRufMx9OhDsQxd1xYgDvZzA": "TRUE",   # Cash Stuffing with Onyx
        "UCWhIKUZ8WnXJPAOdZrA07FQ": "TRUE",   # Boss Investor
        "UC_zzWFodd8j-XoiAjsK6yLg": "TRUE",   # Citizen T OBP Republic
        "UCOWFJkFtW8e2Ndz_wLwqY7A": "TRUE",   # Wealth Quest
        "UCT9Jq8GgQ_WCP_x6zzTK72g": "TRUE",   # Successprintss
        "UCgjqzaArjKs8op97z5AYFog": "TRUE",   # SilverHQ
        "UC-JjgZLelrq83F4vIfmD3Jw": "TRUE",   # Lost Survival Knowledge
        "UCsRrO74b-e3OuN4JucUdUmQ": "TRUE",   # BizMoney Explained
        "UCQbLAKb20pndIfjK-YQ2Zrw": "TRUE",   # Mr. Rupert
        "UCFO491oneCkfoS_EuquK-Gw": "TRUE",   # Let's Grow and Glow
        "UC-V6TdG64vKNXYLg9XbY6dQ": "FALSE",  # Creations By Caredeo
        "UCkkBU2zcSkI7R-u6s2C_qUQ": "FALSE",  # Guy Who Trade
        "UC8Zy7crsNBL8NJCc_ueF-CA": "FALSE",  # CFA Institute
        "UCS07_owQ-uQ34nr1JJ4me9g": "FALSE",  # Ankerstar Wealth
        "UCKLKKgXY-oQ63CjGfvOdKDQ": "FALSE",  # Solid Ground Property
        "UC72nbKQLSDyiSARhg0Ywj4w": "FALSE",  # 9NEWS
        "UC-98P1HknuXGxDYNwlxsKwQ": "FALSE",  # The Great Courses
        "UC74J5qYfBm_BFT2gxdudHLw": "FALSE",  # Dominique Broadway
        "UCwEZid3AdHRt8HSODCCVyyQ": "FALSE",  # Smart Learning
        "UC31AGxT4cadjw746MGLzv9g": "FALSE",  # How We Think
        "UCaHHfl30XrlcjE4EsP5DjUg": "FALSE",  # Med Talk Singapore
        "UCM0rGpeptdOcU53f9GbZ0IQ": "FALSE",  # My Sensible Kitchen
        "UCHYZJnUxYgAzUbs5aEyYToQ": "FALSE",  # Dupé Aleru
        "UCIDKqtGWxjIBZ7o_nBPS0Rg": "FALSE",  # Joocy Jace
        "UCcy6FnBnE6TlTGJJDAxL7QA": "FALSE",  # Shubham Yadawans
        "UCVgO39Bk5sMo66-6o6Spn6Q": "FALSE",  # ABC News Australia
        "UCIALMKvObZNtJ6AmdCLP7Lg": "FALSE",  # Bloomberg
        "UCVIirwqWdBCyynoWRsld2Ug": "FALSE",  # Ray Sutter
        "UCkirzNOK5N1Bnc465OcRvvQ": "FALSE",  # Alice Yacubi
        "UCtDoMEqEFNoSq2J2A7fuFpQ": "FALSE",  # Dividend Hustle Mark
        "UChftTVI0QJmyXkajQYt2tiQ": "FALSE",  # moneycontrol
        "UCR3FsdWZkrW2l65e76_Nnkw": "FALSE",  # Daisy Dollar Budgets
        "UCzLBBwf9V_4AvYwTuNTPdug": "FALSE",  # False Profit
        "UC0bPwCjxpflURPwMlUIdL7w": "FALSE",  # Spirit of Faith Church
        "UC-VTLKBjdYAj0E8El6x_lZQ": "FALSE",  # Victoria's Dutch Diaries
        "UCehoDE3yzmJ9y2ZgSB8C0hQ": "FALSE",  # The Temporal Nomad
        "UCDa21MKyIA2wRdd-g55P5Jw": "FALSE",  # Joyee Yang
        "UC63-QV_GDomHm0eAi_oR0Pw": "FALSE",  # Hanna Kim
        "UCBDIuYogcalOfy5g4o2hnLA": "FALSE",  # Jas Anahis
        "UCX7TbTCz71eh-FMzJNP7FCw": "FALSE",  # Fox Business
        "UCu0Gn50PSjozOgwgPVTBB4A": "FALSE",  # WLOS
        "UCDAbrXOj2yIrzj8QE4jC-Og": "FALSE",  # BRAD LEA TV
        "UCqW3KQyRG7QwDc4WTRMm1hw": "FALSE",  # Bothsides
        "UCvRsdcvm5y5upP6Qf7ebMrQ": "FALSE",  # GIBS
        "UCoIJlM_xHRih2pIkCoV_psg": "FALSE",  # Alfred Mathu
        "UCIYLOcEUX6TbBo7HQVF2PKA": "FALSE",  # 9 News Australia
        "UCuTfyAM46PR3eaRHu3l9hoA": "FALSE",  # Dr. Charles Apoki
        "UCNtiga3OXdsgpKtdrNkDvNA": "FALSE",  # Justin Talks Villa
        "UCla3VF8y6VixwulHEHZ9MQQ": "FALSE",  # Vuhlandes
        "UCMPcupZziOB8R6zEbw_elvw": "FALSE",  # Money Guy Clips
        "UCk4LyxBy_LLhpgHL2ZyijzA": "FALSE",  # Michela Allocca
        "UCTqkzUSsowaHqZwITKbhJuQ": "FALSE",  # Dr. Linda J. Browne
        "UCkbXWoK2Antd-LrwzfAdj9Q": "FALSE",  # Glen Evans
        "UC5_CAuwHN9auyoMMaAlyQoA": "FALSE",  # John's Money Retirement
        "UCjlYesfklKa8MTMKsJMttmQ": "FALSE",  # Over 50 Creator
        "UCkmclsX_QQDJT-D9xYlxaow": "FALSE",  # James Invests
        "UCCE2rqDL2wou2sgAGFIxrHA": "FALSE",  # Kai Explores Life
        "UC4ijFet4QxQa0AX93SXICNQ": "FALSE",  # Jacopo Regeni
        "UCxMtCY9MVjuJ7qwmgBSkk5A": "FALSE",  # Wealth With Hannah
        "UCvwLPOt7F8dztHZrNP_TuMw": "FALSE",  # Daniel Miller
        "UCM-WvjTBBdwd8VnNeIA2LqQ": "FALSE",  # SLP Wealth
        "UCGT8G537oFO305Q9BoIgOOQ": "FALSE",  # Ryan Janus
        "UC7HWHEt9zMnuRonSglOe3oQ": "FALSE",  # Retirement 4 the Rest of Us
        "UCGWgMJc__LLgy-rmaqv4eyg": "FALSE",  # Align Your Retirement
        "UCFUMsTT9SWFlU7_ADxYoOLg": "FALSE",  # NerdWallet Wealth Partners
        "UCOvq-1piPnzCmrqfSspVIwA": "FALSE",  # Robin MBA
        "UC9Xmw8JwfXG-JfRbHxw1Nkg": "FALSE",  # Denzel Napoleon Rodriguez
        "UCsOSIcfV0QMTyS0iAC5BZXg": "FALSE",  # Mat Sorensen
        "UCugwwKRUS5juG0qYif2HABA": "FALSE",  # Home Loan Education
        "UCVTOc0UyMQMOCUcdz5HZpgA": "FALSE",  # The Clackleys
        "UCoxWpx6geIdSrwIZ5fkXKZg": "FALSE",  # Chereeka Lou
        "UC2cfzvGC8CJNWtvaynN7TeA": "FALSE",  # BiggerPockets Money
        "UC0RJXW_UepzRTiS8QOm0YJQ": "FALSE",  # Wealth Protection Lady
        "UCch0lyZYQCNOjVwQEOWxwcA": "FALSE",  # Davonte Durden
        "UCKU7PUmv7ULjDl51KOxwySw": "FALSE",  # Chris Wendt
        "UC6H6CZlmvpW6NGmyBVezaww": "FALSE",  # Ozarks Retirement Group
        "UCuo7iQC6soA3ExG4IMMZC8g": "FALSE",  # MoneywithSwAbi
        "UClx0MFmPkTOXZZ0hJZwVTjg": "FALSE",  # The Enlisted Millionaire
        "UCMmYleqaKE4Raambtc-vfww": "FALSE",  # FinanceMom
        "UCqxIR8dda-y3C5gWATzQp-Q": "FALSE",  # sydney stephen
        "UC0wdGhsaCbn3-ISKMTyQD8g": "FALSE",  # Jacqueline Schadeck
        "UCV1Zf1a-TxB1TK5LtZvYVpQ": "FALSE",  # Retired and Trying
        "UC-Qg1YmxZXezEVR_1w5q6sw": "FALSE",  # Dave Talk TV
        "UCir-nHCy89xHdHy9aNq3-fw": "FALSE",  # DIY Retirement
        "UCNVmPCS9M6rH-CwqM7DoQ3A": "FALSE",  # Retirement For Singles
        "UC3QxPxb3qMAJWqXdDuLAeug": "FALSE",  # Evan Mercer
        "UC3L8o9LrIq8STcp2uJmZFMw": "FALSE",  # Money May
        "UCkuJ5fajkvZagI3C6MuZjPQ": "FALSE",  # Reset At 50
        "UCQZgCU3n7mTUME_fIKgE2PA": "FALSE",  # Jacob Wade
        "UCRJiQraHHIxUEgGRoABm-xw": "FALSE",  # Our Rich Journey
        "UCW9-D4dMixm2j3TMlvp3Bpw": "FALSE",  # Retired and Thriving
        "UCrUWQD0_Qp7VG7P2tSmxsow": "FALSE"   # Mortgage Note$ Index
    }

    dim_channel_rows = []
    for cid in all_channel_ids:
        ch_meta = channels_meta.get(cid, {})
        ch_stat = channels_stats.get(cid, {})
        ch_metrics = channels_vid_metrics.get(cid, {})
        handle = channels_handles.get(cid, "")

        title = ch_meta.get('title') or ch_stat.get('title', '')
        country = ch_stat.get('country') or ch_meta.get('country', '')
        created_at = parse_date(ch_meta.get('publishedAt') or ch_stat.get('publishedAt'))
        
        cur = ch_stat.get('currentStats', {})
        subs = cur.get('subscribers', ch_meta.get('subscriberCount', ''))
        views = cur.get('views', ch_meta.get('viewCount', ''))
        vcount = cur.get('videos', ch_meta.get('videoCount', ''))
        
        # 30d growth
        gro = ch_stat.get('growth', {})
        sub_gain = gro.get('subscribersGained')
        if sub_gain is not None and subs:
            prev_s = subs - sub_gain
            subs_growth_30d = round(sub_gain / max(1, prev_s) * 100, 2) if prev_s > 0 else ""
        else:
            subs_growth_30d = ""

        view_gain = gro.get('viewsGained')
        if view_gain is not None and views:
            prev_v = views - view_gain
            views_growth_30d = round(view_gain / max(1, prev_v) * 100, 2) if prev_v > 0 else ""
        else:
            views_growth_30d = ""

        v_pub = gro.get('videosPublished')
        if v_pub is not None and str(v_pub).strip() != '':
            try:
                long_30d = max(0, int(v_pub))
                uploads_per_m = long_30d
            except Exception:
                long_30d = ""
                uploads_per_m = ""
        else:
            long_30d = ""
            uploads_per_m = ""

        avg_views = round(views / max(1, vcount), 1) if (views and vcount) else ""
        med_views = ch_metrics.get('median_views', "")
        avg_dur = ch_metrics.get('long_avg_duration_sec', "")

        # Determine channel relevance based on videos
        ch_vids = [r for r in fact_video_rows if r['channel_id'] == cid]
        if any(r['relevance'] == 'core' for r in ch_vids):
            ch_rel = "core"
        elif any(r['relevance'] == 'adjacent' for r in ch_vids):
            ch_rel = "adjacent"
        else:
            ch_rel = "off"

        # Faceless status
        is_face = faceless_map.get(cid, "")

        # Niche
        if ch_rel == "core":
            niche = "personal_finance"
        elif ch_rel == "adjacent":
            niche = "adjacent_finance"
        else:
            niche = "non_niche"

        # Channel type
        ch_type = "long"

        # Last video published
        # Find latest published_at among videos
        v_dates = [r['published_at'] for r in ch_vids if r['published_at']]
        last_pub = max(v_dates) if v_dates else ""

        row = {
            "channel_id": cid,
            "handle": handle,
            "channel_title": clean_tsv_str(title),
            "is_seed": "FALSE",
            "subscriber_count": subs,
            "total_view_count": views,
            "video_count": vcount,
            "country": country,
            "primary_language": "en" if country in ["US", "AU", "GB", "NZ", "CA"] or ch_rel == "core" else "",
            "niche": niche,
            "channel_type": ch_type,
            "is_faceless": is_face,
            "avg_views": avg_views,
            "median_views_last20": med_views,
            "long_videos_30d": long_30d,
            "uploads_per_month": uploads_per_m,
            "long_avg_duration_sec": avg_dur,
            "subs_growth_30d_pct": subs_growth_30d,
            "views_growth_30d_pct": views_growth_30d,
            "channel_created_at": created_at,
            "last_video_published": last_pub,
            "relevance": ch_rel,
            "source": "vidiq_get_channels_by_ids",
            "collected_at": COLLECTED_AT
        }
        dim_channel_rows.append(row)

    print(f"Total dim_channel_rows: {len(dim_channel_rows)}")

    # 3. Write TSV files
    inbox_dir = "/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room/writer-room-data/spy-sheet/inbox"
    os.makedirs(inbox_dir, exist_ok=True)

    fact_file = os.path.join(inbox_dir, "fact_video_outlier.tsv")
    dim_file = os.path.join(inbox_dir, "dim_channel_outlier.tsv")

    fact_headers = [
        "video_id", "channel_id", "channel_title", "title", "published_at", 
        "view_count", "like_count", "comment_count", "duration_sec", "is_short", 
        "channel_median_views", "outlier_ratio", "views_per_day", "format_tag", 
        "topic_tag", "relevance", "source", "collected_at"
    ]

    dim_headers = [
        "channel_id", "handle", "channel_title", "is_seed", "subscriber_count", 
        "total_view_count", "video_count", "country", "primary_language", "niche", 
        "channel_type", "is_faceless", "avg_views", "median_views_last20", 
        "long_videos_30d", "uploads_per_month", "long_avg_duration_sec", 
        "subs_growth_30d_pct", "views_growth_30d_pct", "channel_created_at", 
        "last_video_published", "relevance", "source", "collected_at"
    ]

    with open(fact_file, "w", encoding="utf-8") as f:
        f.write("\t".join(fact_headers) + "\n")
        for r in fact_video_rows:
            f.write("\t".join([format_tsv_val(r.get(h)) for h in fact_headers]) + "\n")

    with open(dim_file, "w", encoding="utf-8") as f:
        f.write("\t".join(dim_headers) + "\n")
        for r in dim_channel_rows:
            f.write("\t".join([format_tsv_val(r.get(h)) for h in dim_headers]) + "\n")

    print(f"\nWrote {len(fact_video_rows)} rows to {fact_file}")
    print(f"Wrote {len(dim_channel_rows)} rows to {dim_file}")

if __name__ == '__main__':
    main()
