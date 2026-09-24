#!/usr/bin/env python3
"""
Niche Scout Pipeline: POV-Finance
Combines:
1. Google Sheets API (read list-kenh-follow, write list-key & list-outliner)
2. yt-dlp (read 16 channel video titles - 0 credit)
3. vidIQ MCP (vidiq_keyword_research & vidiq_outliers)
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime
from pathlib import Path

scripts_dir = str(Path(__file__).resolve().parent)
repo_root = Path(__file__).resolve().parent.parent
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)

from google_auth import get_sheets_service

SPREADSHEET_ID = os.environ.get("SPY_SHEET_ID", "1E70vwo3h91iB_sxazuBd6B5SwhYanfWhq8z3SJaspWs")
VIDIQ_SERVER_SCRIPT = str(repo_root / "scripts" / "vidiq-mcp-server.cjs")


def call_vidiq(tool_name: str, arguments: dict) -> dict:
    """Call vidIQ tool via local stdio MCP script"""
    cmd = ["node", VIDIQ_SERVER_SCRIPT, "call", tool_name, json.dumps(arguments)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"vidIQ error ({tool_name}): {res.stderr}")
    
    # vidIQ stdout may contain markdown summary and JSON payload
    stdout = res.stdout.strip()
    # Find JSON payload
    try:
        # Check if entire stdout is json
        return json.loads(stdout)
    except Exception:
        # Search for JSON block
        idx = stdout.find('{"mode":')
        if idx == -1:
            idx = stdout.find('{"videos":')
        if idx == -1:
            idx = stdout.find('{')
        if idx != -1:
            return json.loads(stdout[idx:])
        raise ValueError(f"Could not parse JSON from vidIQ output: {stdout[:300]}")


def read_channels_from_sheet(service) -> list:
    res = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range="list-kenh-follow!A2:A"
    ).execute()
    rows = res.get("values", [])
    channels = [r[0].strip() for r in rows if r and r[0].strip()]
    return channels

def get_channel_recent_titles(channel_url: str, limit: int = 5) -> list:
    """Get latest titles from channel using yt-dlp flat playlist (fast, 0 quota)"""
    try:
        cmd = [
            "yt-dlp", "--flat-playlist",
            "--print", "%(title)s",
            channel_url,
            "-I", f"1:{limit}"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
        if res.returncode == 0:
            return [line.strip() for line in res.stdout.splitlines() if line.strip()]
    except Exception as e:
        print(f"  [warn] yt-dlp failed for {channel_url}: {e}")
    return []

def main():
    print("=== STARTING POV-FINANCE RESEARCH PIPELINE ===")
    service = get_sheets_service()
    
    # 1. Read 16 channels
    print("\n[Step 1] Reading 16 channels from 'list-kenh-follow'...")
    channels = read_channels_from_sheet(service)
    print(f"Loaded {len(channels)} channels.")
    
    # 2. Extract seed titles from first 8 channels
    print("\n[Step 2] Scanning channel titles to map niche vocabulary (yt-dlp)...")
    sample_titles = []
    for ch in channels[:8]:
        titles = get_channel_recent_titles(ch, limit=4)
        sample_titles.extend(titles)
        print(f"  + {ch.split('@')[-1] if '@' in ch else ch}: {len(titles)} titles")
    
    print(f"Total titles collected: {len(sample_titles)}")
    
    # Core seed keywords representing POV finance / personal wealth niche
    seed_keywords = [
        "pov finance",
        "money habits",
        "how to build wealth",
        "financial independence",
        "saving money",
        "index fund investing",
        "finance storytelling"
    ]
    
    # 3. vidIQ Keyword Research
    print(f"\n[Step 3] Running vidIQ Keyword Research on {len(seed_keywords)} seed topics...")
    keyword_rows = []
    seen_keywords = set()
    
    for kw in seed_keywords:
        print(f"  -> Researching: '{kw}'...")
        try:
            data = call_vidiq("vidiq_keyword_research", {"keyword": kw, "mode": "research"})
            seed_data = data.get("seedKeyword", {})
            
            # Format top 5 markets
            markets = seed_data.get("topMarkets") or []
            markets_str = ", ".join([f"{m['country']}: {m['pct']*100:.1f}%" for m in markets[:5]]) if markets else "N/A"
            
            growth = seed_data.get("searchDemandGrowthPct")
            growth_str = f"{growth:+.1f}%" if growth is not None else "N/A"
            
            related_list = data.get("relatedKeywords") or []
            low_comp = [f"{r['keyword']} ({r.get('overall', 0):.0f})" for r in related_list if r.get("competition", 100) < 40][:3]
            low_comp_str = "; ".join(low_comp) if low_comp else "N/A"
            
            kw_name = seed_data.get("keyword") or kw
            if kw_name.lower() not in seen_keywords:
                seen_keywords.add(kw_name.lower())
                keyword_rows.append([
                    kw_name,
                    seed_data.get("estimatedMonthlySearch", "N/A"),
                    f"{seed_data.get('volume', 0):.1f}",
                    f"{seed_data.get('competition', 0):.1f}",
                    f"{seed_data.get('overall', 0):.1f}",
                    growth_str,
                    markets_str,
                    "Seed Core",
                    low_comp_str
                ])
            
            # Also extract top 3 related keywords with high overall score
            for r in sorted(related_list, key=lambda x: x.get("overall", 0), reverse=True)[:4]:
                r_name = r.get("keyword", "")
                if r_name and r_name.lower() not in seen_keywords:
                    seen_keywords.add(r_name.lower())
                    r_markets = r.get("topMarkets") or []
                    r_markets_str = ", ".join([f"{m['country']}: {m['pct']*100:.1f}%" for m in r_markets[:5]]) if r_markets else "N/A"
                    r_growth = r.get("searchDemandGrowthPct")
                    r_growth_str = f"{r_growth:+.1f}%" if r_growth is not None else "N/A"
                    keyword_rows.append([
                        r_name,
                        r.get("estimatedMonthlySearch", "N/A"),
                        f"{r.get('volume', 0):.1f}",
                        f"{r.get('competition', 0):.1f}",
                        f"{r.get('overall', 0):.1f}",
                        r_growth_str,
                        r_markets_str,
                        f"Related to '{kw}'",
                        "N/A"
                    ])
            
            time.sleep(1) # respectful rate limit
        except Exception as e:
            print(f"  [error] Keyword research failed for '{kw}': {e}")
            
    print(f"Compiled {len(keyword_rows)} keywords with market & volume intelligence.")
    
    # 4. vidIQ Outliers
    print("\n[Step 4] Sourcing Outlier Videos in the last 30 days (vidIQ Outliers)...")
    outlier_search_keys = ["pov finance", "money habits", "how to build wealth", "saving money", "financial independence", "finance storytelling"]
    
    # Map known original channel IDs/handles to avoid duplicates
    original_channel_names = set([ch.lower() for ch in channels])
    outlier_videos = []
    seen_channels = set()
    
    for kw in outlier_search_keys:
        print(f"  -> Sourcing outliers for: '{kw}'...")
        try:
            data = call_vidiq("vidiq_outliers", {
                "keyword": kw,
                "publishedWithin": "thisMonth",
                "minOutlierScore": 2.0,
                "contentType": "long",
                "limit": 10
            })
            videos = data.get("videos") or []
            print(f"     Found {len(videos)} raw outlier videos.")
            
            for v in videos:
                ch_title = v.get("channelTitle", "")
                ch_id = v.get("channelId", "")
                ch_url = f"https://www.youtube.com/channel/{ch_id}" if ch_id else ""
                
                # Filter out original channels
                if any(k in ch_title.lower() for k in ["jackexplainsmoney", "aliciainvests", "martik", "bille"]):
                    continue
                
                if ch_id in seen_channels:
                    continue
                seen_channels.add(ch_id)
                
                # Format published date
                pub_epoch = v.get("videoPublishedAt")
                pub_date = datetime.fromtimestamp(pub_epoch).strftime("%Y-%m-%d") if pub_epoch else "Recent"
                
                outlier_score = v.get("breakoutScore", 0)
                views = v.get("viewCount", 0)
                vph = v.get("vph", 0)
                subscribers = v.get("subscriberCount", 0)
                
                outlier_videos.append([
                    ch_title,
                    ch_url,
                    subscribers,
                    v.get("videoTitle", ""),
                    f"https://www.youtube.com/watch?v={v.get('videoId')}",
                    views,
                    f"{outlier_score:.1f}x",
                    f"{vph:.1f}",
                    pub_date,
                    kw
                ])
            time.sleep(1)
        except Exception as e:
            print(f"  [error] Outliers query failed for '{kw}': {e}")
            
    # Sort outliers by breakout score descending
    outlier_videos.sort(key=lambda x: float(x[6].replace("x", "")) if "x" in str(x[6]) else 0, reverse=True)
    print(f"Discovered {len(outlier_videos)} unique breakout channels/videos!")
    
    # 5. Write to Google Sheets
    print("\n[Step 5] Updating Google Sheets tabs 'list-key' & 'list-outliner'...")
    meta = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID).execute()
    existing_sheets = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta.get("sheets", [])}
    
    # Prepare batch requests to create tabs if needed
    add_sheet_requests = []
    if "list-key" not in existing_sheets:
        add_sheet_requests.append({"addSheet": {"properties": {"title": "list-key"}}})
    if "list-outliner" not in existing_sheets:
        add_sheet_requests.append({"addSheet": {"properties": {"title": "list-outliner"}}})
        
    if add_sheet_requests:
        service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={"requests": add_sheet_requests}
        ).execute()
        print("  Created missing tabs.")
        
    # Write list-key
    key_headers = [
        "Từ khóa (Keyword)",
        "Lượt Search / Tháng",
        "Volume Score (0-100)",
        "Competition (0-100)",
        "Overall Score (0-100)",
        "Tăng trưởng 30d (%)",
        "Top 5 Thị trường Quốc gia (% Audience)",
        "Phân loại",
        "Từ khóa ngách liên quan (Low Comp)"
    ]
    service.spreadsheets().values().clear(
        spreadsheetId=SPREADSHEET_ID,
        range="list-key!A1:Z"
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range="list-key!A1",
        valueInputOption="USER_ENTERED",
        body={"values": [key_headers] + keyword_rows}
    ).execute()
    print(f"  + Wrote {len(keyword_rows)} rows to 'list-key'.")
    
    # Write list-outliner
    outliner_headers = [
        "Tên Kênh",
        "Link Kênh",
        "Subscribers",
        "Tiêu đề Video Outlier (Đột biến)",
        "Link Video",
        "Lượt View",
        "Hệ số Đột biến (Breakout Score)",
        "Vận tốc (Views / Giờ)",
        "Ngày đăng (30 ngày qua)",
        "Từ khóa kích hoạt"
    ]
    service.spreadsheets().values().clear(
        spreadsheetId=SPREADSHEET_ID,
        range="list-outliner!A1:Z"
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range="list-outliner!A1",
        valueInputOption="USER_ENTERED",
        body={"values": [outliner_headers] + outlier_videos}
    ).execute()
    print(f"  + Wrote {len(outlier_videos)} rows to 'list-outliner'.")
    
    # Apply styling (navy header for list-key, dark emerald for list-outliner)
    meta = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID).execute()
    sheet_ids = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta.get("sheets", [])}
    
    format_requests = [
        # list-key header styling (Navy blue)
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_ids["list-key"],
                    "startRowIndex": 0, "endRowIndex": 1
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": {"red": 0.1, "green": 0.21, "blue": 0.36},
                        "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}}
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat)"
            }
        },
        # list-outliner header styling (Dark Emerald green)
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_ids["list-outliner"],
                    "startRowIndex": 0, "endRowIndex": 1
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": {"red": 0.08, "green": 0.32, "blue": 0.18},
                        "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}}
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat)"
            }
        },
        # Freeze row 1 on both sheets
        {
            "updateSheetProperties": {
                "properties": {
                    "sheetId": sheet_ids["list-key"],
                    "gridProperties": {"frozenRowCount": 1}
                },
                "fields": "gridProperties.frozenRowCount"
            }
        },
        {
            "updateSheetProperties": {
                "properties": {
                    "sheetId": sheet_ids["list-outliner"],
                    "gridProperties": {"frozenRowCount": 1}
                },
                "fields": "gridProperties.frozenRowCount"
            }
        }
    ]
    
    service.spreadsheets().batchUpdate(
        spreadsheetId=SPREADSHEET_ID,
        body={"requests": format_requests}
    ).execute()
    print("  + Applied bold headers & frozen row 1.")
    
    print("\n=== PIPELINE COMPLETED SUCCESSFULLY! ===")

if __name__ == "__main__":
    main()
