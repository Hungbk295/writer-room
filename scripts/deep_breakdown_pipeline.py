#!/usr/bin/env python3
"""
Deep Breakdown Pipeline: Hook Breakdown & Title Formulas
For both 'list-kenh-follow' (seed channels) and 'list-outliner' (breakout channels).
Writes to Google Sheet 'POV-Finance':
  - Tab 1: 'hook-breakdown'
  - Tab 2: 'title-formulas'
"""

import os
import re
import subprocess
import time
from google.oauth2 import service_account
from googleapiclient.discovery import build

SPREADSHEET_ID = "1E70vwo3h91iB_sxazuBd6B5SwhYanfWhq8z3SJaspWs"
SERVICE_ACCOUNT_FILE = "service_account.json"

def get_sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE,
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return build("sheets", "v4", credentials=creds)

def fetch_clean_hook_transcript(video_id: str, max_seconds: int = 50) -> dict:
    """Fetch subtitle using yt-dlp and extract clean 45-50s transcript"""
    tmp_path = f"/tmp/hook_{video_id}"
    try:
        cmd = [
            "yt-dlp", "--write-auto-sub", "--sub-lang", "en",
            "--skip-download", "--sub-format", "vtt",
            "-o", f"{tmp_path}.%(ext)s",
            f"https://www.youtube.com/watch?v={video_id}"
        ]
        subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        
        vtt_file = f"{tmp_path}.en.vtt"
        if not os.path.exists(vtt_file):
            return {"text": "(Phụ đề không khả dụng hoặc video dạng podcast nhạc/không lời)", "wpm": 0, "duration": 0}
            
        with open(vtt_file, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
            
        cues = []
        last_sec = 0
        for line in lines:
            match = re.match(r"(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})", line)
            if match:
                h, m, s, ms, eh, em, es, ems = map(int, match.groups())
                start_sec = h * 3600 + m * 60 + s
                end_sec = eh * 3600 + em * 60 + es
                if start_sec > max_seconds:
                    break
                last_sec = max(last_sec, end_sec)
            elif line.strip() and not line.startswith("WEBVTT") and not line.startswith("Kind:") and not line.startswith("Language:") and "-->" not in line:
                clean_line = re.sub(r"<[^>]+>", "", line).strip()
                if clean_line and (not cues or cues[-1] != clean_line):
                    cues.append(clean_line)
                    
        # Deduplicate rolling text
        merged = []
        for c in cues:
            if not merged:
                merged.append(c)
            else:
                prev = merged[-1]
                if c.startswith(prev):
                    merged[-1] = c
                elif prev in c:
                    merged[-1] = c
                elif c not in prev:
                    merged.append(c)
                    
        full_text = " ".join(merged).strip()
        words = len(full_text.split())
        eff_sec = max(last_sec, 30)
        wpm = int((words / eff_sec) * 60) if eff_sec > 0 else 0
        
        # Cleanup tmp
        if os.path.exists(vtt_file):
            os.remove(vtt_file)
            
        return {"text": full_text, "wpm": wpm, "duration": eff_sec}
    except Exception as e:
        return {"text": f"Lỗi lấy transcript: {e}", "wpm": 0, "duration": 0}

def main():
    print("=== STARTING DEEP BREAKDOWN PIPELINE ===")
    service = get_sheets_service()
    
    # 1. Target Videos to Analyze
    # Group A: Seed Channels (from list-kenh-follow)
    # Group B: Outlier Channels (from list-outliner)
    videos_to_breakdown = [
        # Seed Channels
        {
            "channel": "JackExplainsMoneyUS",
            "title": "The True Cost of a “Normal” American Lifestyle",
            "videoId": "sFe9JMHcpsQ",
            "group": "Seed Channel (list-kenh-follow)",
            "views": "Recent",
            "breakout": "Benchmark",
            "archetype": "Hidden Illusion & Identity Reality Check",
            "psychology": "Đánh vào nỗi sợ 'sống theo chuẩn mực xã hội nhưng thực chất đang nghèo đi âm thầm'. Khơi gợi sự đồng cảm về chi phí nhà cửa, xe cộ vô lý.",
            "pivot": "Giây 00:25 (Chuyển từ liệt kê mức lương trung bình sang bóc tách thực tế số tiền tiết kiệm bằng 0)."
        },
        {
            "channel": "AliciaInvestsUS",
            "title": "10 Free Habits That Make Every Morning Feel Expensive",
            "videoId": "CnVCgNe-0s8",
            "group": "Seed Channel (list-kenh-follow)",
            "views": "Recent",
            "breakout": "Benchmark",
            "archetype": "Paradoxical Luxury (Thói quen 0 đồng tạo cảm giác giàu)",
            "psychology": "Tạo cảm xúc đắc thắng: không cần tốn tiền mua sắm xa xỉ nhưng vẫn tận hưởng lối sống thượng lưu qua các vi thói quen buổi sáng.",
            "pivot": "Giây 00:20 (Chuyển từ khái niệm 'xa xỉ không nằm ở tiền bạc' sang thói quen số 1)."
        },
        {
            "channel": "TheWealth_Logic",
            "title": "The 401k Number Where COMPOUNDING Finally Beats Your Paycheck!",
            "videoId": "jzMphXboc_E",
            "group": "Seed Channel (list-kenh-follow)",
            "views": "Recent",
            "breakout": "Benchmark",
            "archetype": "The Milestone Tipping Point (Ngưỡng bùng nổ)",
            "psychology": "Gợi sự tò mò tột độ: Đưa ra một con số cụ thể mà ai cũng muốn biết để so sánh xem tài khoản của mình đã chạm tới 'điểm bùng nổ' chưa.",
            "pivot": "Giây 00:35 (Giải thích tại sao lãi kép 100k đầu tiên chậm nhưng từ 300k trở lên tiền lãi tự làm việc thay bạn)."
        },
        {
            "channel": "CasuallyFinance",
            "title": "America Is Walking Into Something It Can't Stop",
            "videoId": "DgbHW0IqHrI",
            "group": "Seed Channel (list-kenh-follow)",
            "views": "Recent",
            "breakout": "Benchmark",
            "archetype": "Macro Ominous Warning (Cảnh báo vĩ mô không thể đảo ngược)",
            "psychology": "Kích hoạt cảm xúc lo âu về tương lai kinh tế, lạm phát và nợ công; người xem phải theo dõi để biết cách tự bảo vệ tài sản.",
            "pivot": "Giây 00:30 (Từ bối cảnh nợ tiêu dùng chuyển sang tác động trực tiếp đến từng hộ gia đình)."
        },
        
        # Outlier Channels (from list-outliner)
        {
            "channel": "POV Finance",
            "title": "POV: You Paid Off Your Mortgage — Everyone Else Has Decades Left",
            "videoId": "Je8hjgrKvmc",
            "group": "Top Outlier (list-outliner)",
            "views": "19,836",
            "breakout": "Outlier Leader",
            "archetype": "Cinematic First-Person POV (Điện ảnh hóa ngôi thứ nhất)",
            "psychology": "Sử dụng chi tiết cảm giác cực thực (đứng trước hiên nhà, cốc cà phê nguội, hàng xóm kéo gậy golf). Tạo cảm giác tự do tối thượng trong âm thầm.",
            "pivot": "Giây 00:28 (Cú đấm tâm lý: 'Not paid down, paid off. Zero balance. He has 26 years left. You didn't correct him.')."
        },
        {
            "channel": "POV Finance",
            "title": "POV: You Retired at 40 — Nobody Knows",
            "videoId": "KqMZWAEmM1A",
            "group": "Top Outlier (list-outliner)",
            "views": "85,299",
            "breakout": "Outlier Leader",
            "archetype": "Stealth Wealth / Secret Freedom (Giàu ngầm & Bí mật tự do)",
            "psychology": "Đánh trúng khao khát thoát khỏi guồng quay 9-to-5 mà không cần khoe mẽ. Đưa người xem vào vai người đã chiến thắng cuộc chơi tài chính.",
            "pivot": "Giây 00:32 (Từ việc thức dậy vào sáng thứ 2 không có báo thức sang cách xây dựng danh mục cổ tức)."
        },
        {
            "channel": "Mind Over Pages",
            "title": "Money Loves Discipline 💰 | The Daily Habits of Future Millionaires",
            "videoId": "tws7DDdR-T4",
            "group": "Top Outlier (list-outliner)",
            "views": "12,022",
            "breakout": "573.2x (Siêu đột biến)",
            "archetype": "Authoritative Wisdom / Audiobook Tone (Triết lý kỷ luật)",
            "psychology": "Gán cho đồng tiền một 'tính cách' (Money loves discipline). Biến việc tiết kiệm từ cực nhọc thành một đức tính quý phái của người giàu.",
            "pivot": "Giây 00:25 (Từ định nghĩa kỷ luật sang thói quen kiểm soát dòng tiền buổi sáng)."
        },
        {
            "channel": "Ankerstar Wealth",
            "title": "How I Plan to BUILD WEALTH in Retirement...",
            "videoId": "O8BOvoAMk1U",
            "group": "Top Outlier (list-outliner)",
            "views": "16,423",
            "breakout": "154.8x (Đột biến)",
            "archetype": "Advisor Confession / Portfolio Blueprint (Tiết lộ danh mục)",
            "psychology": "Chuyên gia tài chính nói thật góc nhìn cá nhân ('Cách TÔI làm, không phải lý thuyết sách vở'), tạo sự tin cậy tuyệt đối.",
            "pivot": "Giây 00:40 (Chuyển từ sai lầm của 90% người về hưu sang chiến lược dòng tiền cổ tức thực tế)."
        },
        {
            "channel": "BizMoney Explained",
            "title": "Corporate Finance Masterclass (Learn What CFOs Know)",
            "videoId": "_pPmFAhbqQE",
            "group": "Top Outlier (list-outliner)",
            "views": "107,147",
            "breakout": "39.6x (Đột biến)",
            "archetype": "Elite Insider Knowledge (Kiến thức của tầng lớp CFO)",
            "psychology": "Lời hứa chuyển giao 'vũ khí của kẻ mạnh' — biến kiến thức tài chính doanh nghiệp phức tạp thành bản đồ hành động dễ hiểu cho cá nhân.",
            "pivot": "Giây 00:30 (Từ câu hỏi 'Tại sao CFO kiếm hàng triệu đô' sang mô hình 3 báo cáo tài chính)."
        }
    ]
    
    print(f"\n[Step 1] Fetching clean hook transcripts for {len(videos_to_breakdown)} selected videos...")
    hook_rows = []
    
    for item in videos_to_breakdown:
        print(f"  -> Processing: '{item['channel']}' - {item['title'][:40]}...")
        data = fetch_clean_hook_transcript(item["videoId"], max_seconds=45)
        hook_rows.append([
            item["channel"],
            item["title"],
            f"https://www.youtube.com/watch?v={item['videoId']}",
            item["group"],
            f"{item['views']} (Breakout: {item['breakout']})",
            item["archetype"],
            data["text"],
            f"{data['wpm']} WPM",
            item["pivot"],
            item["psychology"]
        ])
        time.sleep(1)
        
    # 2. Extract Title Formulas
    print("\n[Step 2] Formulating Winning Title Templates (title-formulas)...")
    formulas_data = [
        [
            "TF-01",
            "POV First-Person Cinema (Điện ảnh hóa Ngôi thứ nhất)",
            "POV: You [Đạt thành tựu lớn] at [Độ tuổi] — [Nghịch lý / Sự thật]",
            "POV: You Paid Off Your Mortgage — Everyone Else Has Decades Left\nPOV: You Retired at 40 — Nobody Knows",
            "Cảm giác thỏa mãn ngầm (Superiority), Tự do tối thượng, Sự tương phản mạnh mẽ với số đông xung quanh.",
            "POV, Nobody Knows, Paid Off, Decades Left, Quietly",
            "Dùng cho các kịch bản mang tính storytelling, miêu tả cảm giác sau khi đạt tự do tài chính, trả hết nợ hoặc nghỉ hưu sớm."
        ],
        [
            "TF-02",
            "Hidden Illusion & Real Cost (Chi phí thực sự của lối sống bình thường)",
            "The True Cost of a “[Khái niệm bình thường]” [Lối sống / Quyết định]",
            "The True Cost of a “Normal” American Lifestyle\nThe True Cost of Buying a New Car in Your 20s",
            "Đánh vào nỗi sợ bị 'dắt mũi' bởi truyền thông và xã hội; vạch trần cái bẫy vô hình của tầng lớp trung lưu.",
            "The True Cost, Normal, Trap, Hidden Price, Draining",
            "Thích hợp cho các video bóc tách lối sống tiêu dùng, chi phí ẩn của việc mua nhà, sắm xe trả góp."
        ],
        [
            "TF-03",
            "The Unspoken Milestone (Cột mốc tiền bạc không ai nói cho bạn)",
            "What Nobody Tells You About [Cột mốc tiền bạc / Thành quả]",
            "What Nobody Tells You About Your First $100,000\nWhat Nobody Tells You About Living on Dividends",
            "Sự tò mò tột độ (Curiosity Gap) + Cảm giác được tiếp cận thông tin hậu trường độc quyền.",
            "What Nobody Tells You, First $100K, The Reality, Secret",
            "Thích hợp làm video về 100 triệu/1 tỷ đầu tiên, hoặc giai đoạn khởi đầu tích lũy tài sản."
        ],
        [
            "TF-04",
            "Silent Account Drainers (Kẻ trộm tiền vô hình)",
            "[Số lượng] Silent [Danh từ] Draining Your [Tài khoản/Ví] Every Month",
            "10 Silent Fees Draining Your Bank Account Every Month\n7 Silent Habits Keeping You Poor in Your 30s",
            "Nỗi đau mất tiền ngầm (Loss Aversion) — con người ghét bị mất tiền hơn là thích kiếm thêm tiền.",
            "Silent, Draining, Bleeding, Sneaky, Without Realizing",
            "Rất hợp với các đề tài quản lý chi tiêu, phí ngân hàng, thói quen tiêu vặt không tên."
        ],
        [
            "TF-05",
            "The Contrarian Harsh Reality (Sự thật phũ phàng đi ngược số đông)",
            "The Harsh Reality of [Mục tiêu tài chính] (Nobody Tells You This)",
            "The Harsh Reality of Getting Rich\nThe Brutal Truth About Passive Income",
            "Phá vỡ ảo tưởng màu hồng; thu hút người xem vì sự chân thật, thẳng thắn, không lùa gà.",
            "The Harsh Reality, Brutal Truth, Nobody Tells You, Dark Side",
            "Dùng cho video cảnh báo về rủi ro đầu tư, những cái giá phải trả khi làm giàu, lối sống độc thân tài chính."
        ],
        [
            "TF-06",
            "Paradoxical Luxury Habits (Thói quen 0 đồng tạo cảm giác giàu)",
            "[Số lượng] Free Habits That Make Every [Thời điểm] Feel Expensive",
            "10 Free Habits That Make Every Morning Feel Expensive\n5 Zero-Cost Habits That Completely Shift Your Money Mindset",
            "Nghịch lý 'Miễn phí nhưng đắt giá'; thỏa mãn nhu cầu nâng cấp bản thân mà không tốn kém tài chính.",
            "Free Habits, Feel Expensive, Zero-Cost, Transform, Daily",
            "Dùng cho các video phong cách sống, rèn luyện tư duy tiền bạc (Money Mindset), kỷ luật cá nhân."
        ],
        [
            "TF-07",
            "The Tipping Point Trigger (Điểm bùng nổ của Lãi kép)",
            "The [Tài khoản/Con số] Where [Yếu tố tài chính] Finally Beats [Thu nhập]",
            "The 401k Number Where COMPOUNDING Finally Beats Your Paycheck!\nThe Exact Investment Amount Where Dividends Pay Your Rent",
            "Hình dung cụ thể vạch đích: Đưa ra mục tiêu toán học rõ ràng để người xem soi chiếu tài chính bản thân.",
            "Finally Beats, Exact Number, Tipping Point, Compounding, Paycheck",
            "Dùng cho video đầu tư chứng khoán, quỹ chỉ số S&P 500, đầu tư cổ tức (Dividend Investing)."
        ],
        [
            "TF-08",
            "Personification of Money (Đồng tiền có tính cách & quy luật)",
            "Money Loves [Đức tính / Kỷ luật]: The [Thời gian] Habits of Future Millionaires",
            "Money Loves Discipline: The Daily Habits of Future Millionaires\nMoney Hates Emotion: How Stoics Handle Market Crashes",
            "Nhân cách hóa tiền bạc; tạo cảm giác tôn trọng quy luật vũ trụ của dòng tiền.",
            "Money Loves, Future Millionaires, Secret Rules, Attraction, Discipline",
            "Dùng cho video triết lý tài chính (Financial Stoicism), bài học tư duy từ các bậc thầy làm giàu."
        ]
    ]
    
    # 3. Write to Google Sheets
    print("\n[Step 3] Creating and Updating Tabs on Google Sheet 'POV-Finance'...")
    meta = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID).execute()
    existing_sheets = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta.get("sheets", [])}
    
    add_reqs = []
    if "hook-breakdown" not in existing_sheets:
        add_reqs.append({"addSheet": {"properties": {"title": "hook-breakdown"}}})
    if "title-formulas" not in existing_sheets:
        add_reqs.append({"addSheet": {"properties": {"title": "title-formulas"}}})
        
    if add_reqs:
        service.spreadsheets().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={"requests": add_reqs}
        ).execute()
        print("  Created missing tabs.")
        
    # Write hook-breakdown
    hook_headers = [
        "Tên Kênh",
        "Tiêu đề Video",
        "Link Video",
        "Phân nhóm Kênh",
        "Lượt View & Hệ số Breakout",
        "Loại Hook (Archetype)",
        "Kịch bản 30-45s Đầu (Nguyên văn)",
        "Nhịp điệu (WPM)",
        "Điểm Chuyển Hồi (The Pivot)",
        "Cơ chế Tâm lý Giữ chân (Psychology)"
    ]
    service.spreadsheets().values().clear(
        spreadsheetId=SPREADSHEET_ID,
        range="hook-breakdown!A1:Z"
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range="hook-breakdown!A1",
        valueInputOption="USER_ENTERED",
        body={"values": [hook_headers] + hook_rows}
    ).execute()
    print(f"  + Wrote {len(hook_rows)} rows to 'hook-breakdown'.")
    
    # Write title-formulas
    formula_headers = [
        "Mã Công thức (Formula ID)",
        "Tên Công thức Đóng gói",
        "Cấu trúc Tiêu đề Mẫu (Template)",
        "Ví dụ Thực tế trong Niche (Case Studies)",
        "Cơ chế Tâm lý Kích thích Click (Psychology)",
        "Từ khóa Quyền lực (Power Words)",
        "Chỉ dẫn Ứng dụng cho Writer (Production Prompt)"
    ]
    service.spreadsheets().values().clear(
        spreadsheetId=SPREADSHEET_ID,
        range="title-formulas!A1:Z"
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range="title-formulas!A1",
        valueInputOption="USER_ENTERED",
        body={"values": [formula_headers] + formulas_data}
    ).execute()
    print(f"  + Wrote {len(formulas_data)} rows to 'title-formulas'.")
    
    # Apply styling
    meta = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID).execute()
    sheet_ids = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta.get("sheets", [])}
    
    format_requests = [
        # hook-breakdown header: Deep Royal Purple (#3B0764)
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_ids["hook-breakdown"],
                    "startRowIndex": 0, "endRowIndex": 1
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": {"red": 0.23, "green": 0.03, "blue": 0.39},
                        "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}}
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat)"
            }
        },
        # title-formulas header: Warm Amber (#78350F)
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_ids["title-formulas"],
                    "startRowIndex": 0, "endRowIndex": 1
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": {"red": 0.47, "green": 0.21, "blue": 0.06},
                        "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}}
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat)"
            }
        },
        # Freeze row 1
        {
            "updateSheetProperties": {
                "properties": {
                    "sheetId": sheet_ids["hook-breakdown"],
                    "gridProperties": {"frozenRowCount": 1}
                },
                "fields": "gridProperties.frozenRowCount"
            }
        },
        {
            "updateSheetProperties": {
                "properties": {
                    "sheetId": sheet_ids["title-formulas"],
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
    print("  + Applied styling & frozen rows.")
    print("\n=== PIPELINE FINISHED SUCCESSFULLY! ===")

if __name__ == "__main__":
    main()
