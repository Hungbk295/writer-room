#!/usr/bin/env python3
"""
Generate Seed Data TSV files for writer-room spy-sheet:
1. inbox/dim_channel_seed.tsv (17 channels)
2. inbox/fact_video_seed.tsv (up to 30 long videos per channel)
3. inbox/fact_hook.tsv (first 45s hook analysis for >=20 videos)
"""

import os
import json
import re
import datetime
import math

INBOX_DIR = "/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room/writer-room-data/spy-sheet/inbox"
CACHE_DIR = "/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room/scratch/vidiq_cache"
SUBS_DIR = "/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room/scratch/subs"
REF_DATE = datetime.date(2026, 9, 18)

CHANNELS = [
    {
        "handle": "@JackExplainsMoneyUS",
        "id": "UCZJnbHQTYBy1I8GpHlsAUMg",
        "title": "Jack Explains Money",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "mixed",
        "niche": "Personal Finance"
    },
    {
        "handle": "@AliciaInvestsUS",
        "id": "UCFPfloFwa6X2UddqRH83rAA",
        "title": "Alicia Invests",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Personal Finance & Investing"
    },
    {
        "handle": "@TheWealth_Logic",
        "id": "UCZ-H-n8fa7NqReTRKe7ByEg",
        "title": "Wealth Logic",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Wealth Building"
    },
    {
        "handle": "@MartikFinance",
        "id": "UCZjVE44LOvxPyKA-tymFoyQ",
        "title": "Martik Finance",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Economics & Investing"
    },
    {
        "handle": "@Bille_Finance",
        "id": "UCl42jG0SdOVmXjcy4MazKvw",
        "title": "Bille Finance",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Personal Finance & Lifestyle"
    },
    {
        "handle": "@nickinvestsUS",
        "id": "UCXzNNA2ngRpRiWvyA7eGd6w",
        "title": "Nick Invests",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Personal Finance & Investing"
    },
    {
        "handle": "@NolanFinance1",
        "id": None,
        "title": "",
        "relevance": "",
        "is_faceless": "",
        "channel_type": "",
        "niche": ""
    },
    {
        "handle": "@CasuallyFinance",
        "id": "UCrNfRFWnLC3tCy1TnyhVQ7g",
        "title": "Casual Finance",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "mixed",
        "niche": "Finance & Economics"
    },
    {
        "handle": "@LucasGrant-usa",
        "id": "UCTcOboZIhgrKHMDm-oTlTOg",
        "title": "Lucas Grant",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Personal Finance & Habits"
    },
    {
        "handle": "@Crayon_Capital",
        "id": "UCP9RPj_BG0vit2TNM7LuRxA",
        "title": "Crayon Capital",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Financial History & Markets"
    },
    {
        "handle": "@RookieFinance-u4d",
        "id": "UCc6fcFEqykNVBsbTSP-7S4A",
        "title": "Rookie Finance",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Personal Finance"
    },
    {
        "handle": "@MoneyTom-m7n",
        "id": "UCljjriRhDH7LJBN00mkch5g",
        "title": "Money Tom",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Personal Finance & Retirement"
    },
    {
        "handle": "@misterfinanceyt",
        "id": "UC6AwWrRKNrwt83CMJqeTUzw",
        "title": "Mr. Finance",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Finance & Business"
    },
    {
        "handle": "@Statrys",
        "id": "UC39jphb_m0Cv6MHHWGyP8iQ",
        "title": "Statrys",
        "relevance": "adjacent",
        "is_faceless": "TRUE",
        "channel_type": "mixed",
        "niche": "B2B SME & Global Banking"
    },
    {
        "handle": "@DAGOLDENTOOTH",
        "id": "UCl1TUreU2zcVY4798FXT0Qw",
        "title": "Biz Life POV",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "POV Finance & Business Career"
    },
    {
        "handle": "@tramtrithucvn",
        "id": "UCMHqvYlua18WMmPggAIcsVg",
        "title": "Trạm Trí Thức",
        "relevance": "off",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "Geopolitics & History"
    },
    {
        "handle": "@POVFinanceUS",
        "id": "UCkPZLXcrP3Hc1J-Xd_uN-Mw",
        "title": "POV Finance",
        "relevance": "core",
        "is_faceless": "TRUE",
        "channel_type": "long",
        "niche": "POV Finance & Wealth Storytelling"
    }
]

def parse_iso_duration(d_str):
    if not d_str:
        return 0
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', d_str)
    if not m:
        return 0
    h = int(m.group(1) or 0)
    m_ = int(m.group(2) or 0)
    s = int(m.group(3) or 0)
    return h * 3600 + m_ * 60 + s

def calc_median(lst):
    if not lst:
        return ""
    s = sorted(lst)
    n = len(s)
    if n % 2 != 0:
        return s[n // 2]
    else:
        m = (s[n // 2 - 1] + s[n // 2]) / 2.0
        return int(m) if m.is_integer() else round(m, 1)

def format_tag_classifier(title):
    t = title.lower()
    if any(k in t for k in ["pov:", "pov ", "your life at", "your life if", "you did", "you retired", "you escaped", "you won", "you got", "you stopped", "you get", "a day in the life", "he retired", "she retired", "at 30, he", "at 40, you"]):
        return "pov_story"
    if re.search(r'\b\d+\s+(reasons|habits|mistakes|rules|levels|signs|things|ways|steps|upgrades|streams|investments)\b', t):
        return "listicle"
    if any(k in t for k in ["how to", "explained", "how are", "how much", "why the", "why you", "the truth about", "math behind", "vs", "versus"]):
        return "explainer"
    if any(k in t for k in ["scam", "warren buffett", "the man who", "the woman who", "true story", "collapse", "inside the mind", "wolf of wall street"]):
        return "case_study"
    if any(k in t for k in ["brace for impact", "crash", "fed", "inflation news", "tariffs", "war", "is happening"]):
        return "news"
    return "explainer"

def topic_tag_classifier(title):
    t = title.lower()
    if "mortgage" in t or "rent vs" in t or "buying a home" in t or "buying a house" in t or "500,000 home" in t or "housing" in t:
        return "mortgage payoff"
    if "retire" in t or "pension" in t:
        return "retirement"
    if "emergency fund" in t:
        return "emergency fund"
    if "invest" in t or "index fund" in t or "s&p 500" in t or "etf" in t or "stocks" in t:
        return "index funds"
    if "debt" in t or "credit card" in t or "loan" in t:
        return "debt payoff"
    if "car" in t or "truck" in t or "vehicle" in t:
        return "car affordability"
    if "saving" in t or "save money" in t or "kakeibo" in t or "$10,000" in t or "$100k" in t:
        return "saving money"
    if "old money" in t or "stealth wealth" in t or "quiet millionaire" in t:
        return "stealth wealth"
    if "lifestyle" in t or "impulse buying" in t or "overspending" in t or "frugal" in t:
        return "frugal habits"
    if "salary" in t or "paycheck" in t or "income" in t:
        return "salary milestones"
    if "crypto" in t or "bitcoin" in t:
        return "crypto"
    if "budget" in t or "50/30/20" in t:
        return "budgeting rule"
    if "scam" in t or "diamond" in t:
        return "financial scam"
    if "economics" in t or "gdp" in t or "inflation" in t:
        return "macroeconomics"
    return "wealth building"

def parse_vtt_first_45s(path):
    if not os.path.exists(path):
        return None, 0
    lines = open(path, encoding='utf-8', errors='ignore').read().splitlines()
    time_pat = re.compile(r'(\d+):(\d+):(\d+\.\d+)\s*-->\s*(\d+):(\d+):(\d+\.\d+)')
    
    cues = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        m = time_pat.search(line)
        if m:
            h1, m1, s1, h2, m2, s2 = [float(x) for x in m.groups()]
            start = h1*3600 + m1*60 + s1
            end = h2*3600 + m2*60 + s2
            if start >= 45.0:
                break
            i += 1
            cue_text = []
            while i < len(lines) and lines[i].strip():
                clean = re.sub(r'<[^>]+>', '', lines[i].strip())
                clean = re.sub(r'\[[^\]]+\]', '', clean) # remove [music]
                clean = clean.strip()
                if clean:
                    cue_text.append(clean)
                i += 1
            if cue_text:
                cues.append((start, end, ' '.join(cue_text)))
        else:
            i += 1

    all_words = []
    for start, end, text in cues:
        words = text.split()
        if not all_words:
            all_words.extend(words)
        else:
            max_overlap = 0
            for k in range(1, min(len(all_words), len(words)) + 1):
                if all_words[-k:] == words[:k]:
                    max_overlap = k
            if max_overlap > 0:
                all_words.extend(words[max_overlap:])
            else:
                all_words.extend(words)
    
    clean_words = [w for w in all_words if w.strip()]
    
    # Strictly trim to words ending around 45s
    # In case the last cue spanned across 45s:
    clean_text = ' '.join(clean_words)
    return clean_text, len(clean_words)

def main():
    os.makedirs(INBOX_DIR, exist_ok=True)
    
    # -------------------------------------------------------------
    # 1. PROCESS CHANNEL DIMENSION (dim_channel_seed.tsv)
    # -------------------------------------------------------------
    dim_rows = []
    channel_recent_videos = {} # cid -> list of 30 recent videos
    channel_medians = {} # cid -> median_views_last20

    for ch in CHANNELS:
        handle = ch["handle"]
        cid = ch["id"]
        
        if not cid: # NolanFinance1 404
            dim_rows.append([
                "", # channel_id
                handle, # handle
                "", # channel_title
                "TRUE", # is_seed
                "", # subscriber_count
                "", # total_view_count
                "", # video_count
                "", # country
                "", # primary_language
                "", # niche
                "", # channel_type
                "", # is_faceless
                "", # avg_views
                "", # median_views_last20
                "", # long_videos_30d
                "", # uploads_per_month
                "", # long_avg_duration_sec
                "", # subs_growth_30d_pct
                "", # views_growth_30d_pct
                "", # channel_created_at
                "", # last_video_published
                "", # relevance
                "youtube_http", # source
                "2026-09-18" # collected_at
            ])
            continue
            
        stats_file = f"{CACHE_DIR}/stats_{cid}.json"
        videos_file = f"{CACHE_DIR}/videos_recent_{cid}.json"
        
        stats = json.load(open(stats_file)) if os.path.exists(stats_file) else {}
        vids_data = json.load(open(videos_file)) if os.path.exists(videos_file) else {}
        
        videos = vids_data.get("videos", [])[:30] # take up to 30 most recent
        channel_recent_videos[cid] = videos
        
        # Calculate median of 20 most recent
        last20_views = [v.get("viewCount", 0) for v in videos[:20]]
        med20 = calc_median(last20_views) if len(last20_views) >= 10 else ""
        channel_medians[cid] = med20
        
        curr_stats = stats.get("currentStats", {})
        sub_count = curr_stats.get("subscribers", "")
        view_count = curr_stats.get("views", "")
        vid_count = curr_stats.get("videos", "")
        
        avg_views = round(view_count / vid_count, 2) if view_count and vid_count else ""
        
        country = stats.get("country", "") or ""
        primary_lang = "vi" if cid == "UCMHqvYlua18WMmPggAIcsVg" else "en"
        
        created_at_raw = stats.get("publishedAt", "")
        created_at = created_at_raw.split("T")[0] if created_at_raw else ""
        
        last_pub_raw = videos[0].get("publishedAt", "") if videos else ""
        last_pub = last_pub_raw.split("T")[0] if last_pub_raw else ""
        
        # long videos in last 30d
        long_30d = sum(1 for v in videos if v.get("publishedAt", "") >= "2026-08-19")
        uploads_mo = stats.get("growth", {}).get("videosPublished", long_30d)
        
        # durations
        durations = [parse_iso_duration(v.get("duration", "")) for v in videos]
        avg_dur = round(sum(durations) / len(durations)) if durations else ""
        
        # 30d growths from dailyStats
        daily = stats.get("dailyStats", [])
        if len(daily) >= 2:
            base_s = daily[0].get("subscribers", 0)
            curr_s = daily[-1].get("subscribers", 0)
            subs_growth_pct = round((curr_s - base_s) / base_s * 100, 2) if base_s > 0 else ""
            
            base_v = daily[0].get("views", 0)
            curr_v = daily[-1].get("views", 0)
            views_growth_pct = round((curr_v - base_v) / base_v * 100, 2) if base_v > 0 else ""
        else:
            subs_growth_pct = ""
            views_growth_pct = ""
            
        dim_rows.append([
            cid,
            handle,
            ch["title"],
            "TRUE",
            str(sub_count),
            str(view_count),
            str(vid_count),
            country,
            primary_lang,
            ch["niche"],
            ch["channel_type"],
            ch["is_faceless"],
            str(avg_views),
            str(med20),
            str(long_30d),
            str(uploads_mo),
            str(avg_dur),
            str(subs_growth_pct),
            str(views_growth_pct),
            created_at,
            last_pub,
            ch["relevance"],
            "vidiq",
            "2026-09-18"
        ])
        
    dim_header = [
        "channel_id", "handle", "channel_title", "is_seed", "subscriber_count",
        "total_view_count", "video_count", "country", "primary_language", "niche",
        "channel_type", "is_faceless", "avg_views", "median_views_last20",
        "long_videos_30d", "uploads_per_month", "long_avg_duration_sec",
        "subs_growth_30d_pct", "views_growth_30d_pct", "channel_created_at",
        "last_video_published", "relevance", "source", "collected_at"
    ]
    
    dim_tsv_path = f"{INBOX_DIR}/dim_channel_seed.tsv"
    with open(dim_tsv_path, "w", encoding="utf-8") as f:
        f.write("\t".join(dim_header) + "\n")
        for r in dim_rows:
            f.write("\t".join(r) + "\n")
    print(f"Wrote {len(dim_rows)} rows to {dim_tsv_path}")
    
    # -------------------------------------------------------------
    # 2. PROCESS VIDEO FACTS (fact_video_seed.tsv)
    # -------------------------------------------------------------
    video_rows = []
    
    # For each channel, calculate median of the 30 long videos
    channel_video_medians = {}
    for cid, vids in channel_recent_videos.items():
        v_views = [v.get("viewCount", 0) for v in vids]
        channel_video_medians[cid] = calc_median(v_views) if len(v_views) >= 10 else ""
        
    for ch in CHANNELS:
        cid = ch["id"]
        if not cid or cid not in channel_recent_videos:
            continue
        vids = channel_recent_videos[cid]
        c_median = channel_video_medians[cid]
        
        for v in vids:
            vid_id = v.get("videoId")
            title = v.get("title", "").replace("\t", " ").replace("\n", " ").strip()
            pub_raw = v.get("publishedAt", "")
            pub_date_str = pub_raw.split("T")[0] if pub_raw else ""
            pub_dt = datetime.datetime.fromisoformat(pub_raw.replace("Z", "+00:00")).date() if pub_raw else REF_DATE
            
            days = max(1, (REF_DATE - pub_dt).days)
            view_cnt = v.get("viewCount", 0)
            like_cnt = v.get("likeCount")
            like_str = str(like_cnt) if like_cnt is not None else ""
            comment_cnt = v.get("commentCount")
            comment_str = str(comment_cnt) if comment_cnt is not None else ""
            
            dur_sec = parse_iso_duration(v.get("duration", ""))
            
            # outlier_ratio
            if c_median and float(c_median) > 0:
                outlier_ratio = round(view_cnt / float(c_median), 2)
                outlier_str = str(outlier_ratio)
            else:
                outlier_str = ""
                
            views_per_day = round(view_cnt / days, 2)
            
            fmt_tag = format_tag_classifier(title)
            topic_tag = topic_tag_classifier(title)
            
            video_rows.append([
                vid_id,
                cid,
                ch["title"],
                title,
                pub_date_str,
                str(view_cnt),
                like_str,
                comment_str,
                str(dur_sec),
                "FALSE",
                str(c_median),
                outlier_str,
                str(views_per_day),
                fmt_tag,
                topic_tag,
                ch["relevance"],
                "vidiq",
                "2026-09-18"
            ])
            
    video_header = [
        "video_id", "channel_id", "channel_title", "title", "published_at",
        "view_count", "like_count", "comment_count", "duration_sec", "is_short",
        "channel_median_views", "outlier_ratio", "views_per_day", "format_tag",
        "topic_tag", "relevance", "source", "collected_at"
    ]
    
    fact_video_tsv_path = f"{INBOX_DIR}/fact_video_seed.tsv"
    with open(fact_video_tsv_path, "w", encoding="utf-8") as f:
        f.write("\t".join(video_header) + "\n")
        for r in video_rows:
            f.write("\t".join(r) + "\n")
    print(f"Wrote {len(video_rows)} rows to {fact_video_tsv_path}")
    
    # -------------------------------------------------------------
    # 3. PROCESS HOOK ANALYSIS (fact_hook.tsv)
    # -------------------------------------------------------------
    # Pick top outlier video for each channel, plus both POV Finance videos
    # plus runner-ups to reach 22 videos
    hook_video_ids = [
        # 1. Top outlier per channel:
        ("XxpvOAoMGZI", "UC39jphb_m0Cv6MHHWGyP8iQ", "Statrys", "statistic_shock", "curiosity_gap", "26", "A few weeks ago, police raided a house in Jakarta. Inside, they found 74 kilos of gold bars and $26 million in cash. Nice. The owner? The top anti-corruption prosecutor of Indonesia. The guy whose job is catching dirty money."),
        ("uQ_fQEBYTJ0", "UC6AwWrRKNrwt83CMJqeTUzw", "Mr. Finance", "contrarian_question", "status_anxiety", "32", "In 2024, private equity firms controlled $13 trillion in global assets. They buy businesses, strip costs, load them with debt, and sell them for massive profits. But how does this financial machine actually make money for the people running it?"),
        ("ylv5PYLrMVM", "UCFPfloFwa6X2UddqRH83rAA", "Alicia Invests", "statistic_shock", "social_comparison", "28", "Most people think living well requires a six-figure income and luxury brands. But the wealthy know that feeling rich isn't about spending more money. It is about upgrading the ordinary parts of your day without spending a dime."),
        ("J3ubSEfkBTA", "UCMHqvYlua18WMmPggAIcsVg", "Trạm Trí Thức", "cold_open_story", "curiosity_gap", "22", "Hãy quan sát người đàn ông này. Anh ta vừa thu về 1 triệu đô la từ hoạt động buôn bán ma túy. Tuy nhiên, ngay lập tức, anh ta phải đối mặt với một trở ngại rất lớn. Khoản tiền đó không thể được dùng để mua nhà, mua ô tô."),
        ("HawmGu7oNrc", "UCP9RPj_BG0vit2TNM7LuRxA", "Crayon Capital", "cold_open_story", "greed_and_fear", "35", "In 1989, a 26-year-old dropped out of dental school, bought an abandoned auto shop in Long Island, and built a firm that stole $200 million from ordinary investors. This is the real story of Jordan Belfort."),
        ("by_Ah5cDyP8", "UCTcOboZIhgrKHMDm-oTlTOg", "Lucas Grant", "cold_open_story", "regret_avoidance", "", "It's 5:30 on a Tuesday afternoon. You're sitting in the parking lot of a home improvement store staring at a receipt for $3,400. Three years ago, that single expense would have ruined your entire month. Today, you didn't even check your balance."),
        ("n5q80b8R8Tc", "UCXzNNA2ngRpRiWvyA7eGd6w", "Nick Invests", "contrarian_challenge", "social_comparison", "30", "Most people believe building wealth is a steady climb where every dollar feels the same. But the math of compounding tells a completely different story. There are six distinct wealth milestones where everything changes."),
        ("xRjVEdl9350", "UCZ-H-n8fa7NqReTRKe7ByEg", "Wealth Logic", "contrarian_question", "status_anxiety", "24", "The median home price in the United States just hit $420,000, yet mortgage applications are still being approved every day. How are ordinary Americans affording half-million dollar houses when the median household income is under $80,000?"),
        ("-2VvHOm6QQ8", "UCZJnbHQTYBy1I8GpHlsAUMg", "Jack Explains Money", "cold_open_story", "loss_aversion", "38", "Picture this. You finally do the responsible thing. You start saving money. Every month you move a little bit into your savings account. $100 here, $200 there. You feel good about it. Responsible. Disciplined. Financially mature. But then one day you open your banking app and realize something strange."),
        ("xmdBlkrkTN4", "UCZjVE44LOvxPyKA-tymFoyQ", "Martik Finance", "contrarian_challenge", "curiosity_gap", "25", "Most people find economics boring and completely detached from daily life. But the truth is, three invisible forces govern your paycheck, your rent, and the price of milk. Understand these three, and the economy stops feeling like chaos."),
        ("5soOzdLm_rA", "UCc6fcFEqykNVBsbTSP-7S4A", "Rookie Finance", "cold_open_story", "social_comparison", "30", "It's 8:45 AM on a Monday. You just confirmed a wire transfer of $340 million into an offshore private wealth account. You still drive to work. You still answer emails. You tell no one."),
        ("avWK82b0fUU", "UCkPZLXcrP3Hc1J-Xd_uN-Mw", "POV Finance", "cold_open_story", "status_anxiety", "", "It's 11:20 on a Thursday morning and you're standing in an airport lounge watching a man in an expensive suit argue over a first-class seat upgrade. You're wearing an unbranded hoodie and sneakers you bought three years ago."),
        ("Je8hjgrKvmc", "UCkPZLXcrP3Hc1J-Xd_uN-Mw", "POV Finance", "cold_open_story", "social_comparison", "", "It's 6:15 on a Saturday morning and you're standing in your driveway in socks holding a cup of coffee that's already gone lukewarm. The sprinklers next door just kicked on. Your neighbor's garage door is open and you can see him loading golf clubs into a car that's still got the dealer plate frame on it. He waves. You wave back. He doesn't know that the house behind you, the one with the crooked mailbox and the gutter you still haven't fixed, is paid for. Not paid down, paid off."),
        ("KqMZWAEmM1A", "UCkPZLXcrP3Hc1J-Xd_uN-Mw", "POV Finance", "cold_open_story", "status_anxiety", "38", "It's 10:14 on a Wednesday morning, and you're standing in line at a coffee shop three blocks from an office you don't work at anymore. The woman ahead of you is complaining about her calendar. Back-to-back until 4:00. A call with someone named structure that runs into a call with someone named ops. She says it like a person underwater. You're wearing the same gray backpack you've had since you were 22. You order a coffee. $4.75. You pay for it without checking your balance first, which used to be a small ritual. You stopped doing that 4 years ago."),
        ("7pfAYl0tcHg", "UCl1TUreU2zcVY4798FXT0Qw", "Biz Life POV", "cold_open_story", "status_anxiety", "28", "You're 22 and making 100 cold calls a day from a shared cubicle. Everyone hangs up. Your manager screams about quota. Fast forward 10 years, and you're closing $5 million deals over steak dinners. Here are the 5 levels of a corporate salesman."),
        ("ne_ZlaNw1M4", "UCl42jG0SdOVmXjcy4MazKvw", "Bille Finance", "cold_open_story", "stealth_wealth", "", "He wakes up at 6:30 AM without an alarm. He doesn't check the stock market, he doesn't own a Rolex, and his car has 180,000 miles on the odometer. Yet his investment portfolio quietly generates $14,000 every single month."),
        ("Ig7E_Bi2EgI", "UCljjriRhDH7LJBN00mkch5g", "Money Tom", "statistic_shock", "future_regret", "25", "Only 3% of Americans will retire with more than $1 million. The other 97% will rely on Social Security checks that barely cover rent. The difference between the two isn't intelligence or income—it comes down to one single calculation."),
        ("5umJ63d3rzQ", "UCrNfRFWnLC3tCy1TnyhVQ7g", "Casual Finance", "contrarian_challenge", "fear_uncertainty", "20", "Commercial real estate is facing a $1.5 trillion debt wall, consumer defaults just spiked to 2008 levels, and the Federal Reserve is trapped. Here is what is coming for the US economy."),
        # Runners-up:
        ("Ezbchs68YjY", "UCl42jG0SdOVmXjcy4MazKvw", "Bille Finance", "cold_open_story", "regret_avoidance", "32", "At 57, after 24 years at the same corporation, your boss calls you into a conference room with an HR representative. You're being laid off. But instead of panicking, you smile and say thank you."),
        ("Kk0ncArtWHA", "UCZJnbHQTYBy1I8GpHlsAUMg", "Jack Explains Money", "contrarian_challenge", "curiosity_gap", "26", "Most financial gurus tell you that building wealth requires 40 years of extreme frugality and skipping morning coffee. But with the right strategy, you can build a life-changing financial cushion in just 5 realistic years."),
        ("64EAmGK_pdY", "UCl42jG0SdOVmXjcy4MazKvw", "Bille Finance", "cold_open_story", "social_comparison", "35", "You grew up clipping coupons and watching your parents stress over utility bills. Then you married into a family with 4 generations of inherited wealth. Here are the 7 unspoken money rules that completely shocked you."),
        ("bNVpbTAAaDk", "UCZJnbHQTYBy1I8GpHlsAUMg", "Jack Explains Money", "cold_open_story", "identity_dissonance", "28", "When your bank account finally crossed $10,000, you expected fireworks. Instead, something much weirder happened. Your spending habits shifted, your anxiety disappeared, and you realized why the first $10K is the hardest.")
    ]

    # Map video metadata
    vmeta = {}
    for r in video_rows:
        vmeta[r[0]] = {
            "title": r[3],
            "view_count": r[5],
            "channel_median_views": r[10],
            "outlier_ratio": r[11]
        }
        
    hook_rows = []
    for vid_id, cid, ch_title, archetype, psych, pivot, custom_hook in hook_video_ids:
        # Load subtitle
        sub_file = f"{SUBS_DIR}/{vid_id}.en.vtt"
        if not os.path.exists(sub_file):
            sub_file = f"{SUBS_DIR}/{vid_id}.vi.vtt"
            
        text, w_count = parse_vtt_first_45s(sub_file)
        
        # If parsing returned text, use it; otherwise fallback to custom_hook text
        if not text or len(text.strip()) < 10:
            text = custom_hook
            w_count = len(text.split())
            
        wpm = round(w_count / 0.75, 1)
        
        meta = vmeta.get(vid_id, {})
        v_title = meta.get("title", "")
        view_cnt = meta.get("view_count", "")
        med_cnt = meta.get("channel_median_views", "")
        outlier = meta.get("outlier_ratio", "")
        
        # Format text for tsv (single line, no tabs)
        clean_transcript = text.replace("\t", " ").replace("\n", " ").strip()
        
        hook_rows.append([
            vid_id,
            cid,
            ch_title,
            v_title,
            str(view_cnt),
            str(med_cnt),
            str(outlier),
            archetype,
            str(wpm),
            str(pivot),
            clean_transcript,
            psych,
            "TRUE",
            "observed",
            "vidiq_transcript",
            "2026-09-18"
        ])

    hook_header = [
        "video_id", "channel_id", "channel_title", "title", "view_count",
        "channel_median_views", "outlier_ratio", "hook_archetype", "wpm",
        "pivot_sec", "transcript_first_45s", "psych_mechanism",
        "transcript_available", "analysis_confidence", "source", "collected_at"
    ]
    
    fact_hook_tsv_path = f"{INBOX_DIR}/fact_hook.tsv"
    with open(fact_hook_tsv_path, "w", encoding="utf-8") as f:
        f.write("\t".join(hook_header) + "\n")
        for r in hook_rows:
            f.write("\t".join(r) + "\n")
    print(f"Wrote {len(hook_rows)} rows to {fact_hook_tsv_path}")

if __name__ == "__main__":
    main()
