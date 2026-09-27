#!/usr/bin/env python3
import csv
import os

OUTPUT_FILE = "/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room/writer-room-data/spy-sheet/inbox/dim_title_formula.tsv"

# Definitions of TF-01 to TF-13
# Each entry is a dict with formula metadata and a list of examples
formulas = [
    {
        "id": "TF-01",
        "name": "POV First-Person Cinema (Điện ảnh hóa Ngôi thứ nhất)",
        "template": "POV: You [Đạt thành tựu lớn] at [Độ tuổi] — [Nghịch lý / Sự thật]",
        "psych": "Cảm giác thỏa mãn ngầm (Superiority), Tự do tối thượng, Sự tương phản mạnh mẽ với số đông xung quanh.",
        "power_words": "POV, Nobody Knows, Paid Off, Decades Left, Quietly",
        "note": "Dùng cho các kịch bản mang tính storytelling, miêu tả cảm giác sau khi đạt tự do tài chính, trả hết nợ hoặc nghỉ hưu sớm.",
        "examples": [
            {
                "type": "real",
                "video_id": "by_Ah5cDyP8",
                "title": "POV: What Happens When You Start Paying Cash for Cars",
                "channel": "Lucas Grant",
                "views": 301712,
                "outlier": 37.87,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "69VInHOHsYM",
                "title": "POV: You Paid Off Your Mortgage 20 Years Early — Life Is Never The Same",
                "channel": "Lucas Grant",
                "views": 67119,
                "outlier": 8.42,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "yLSaQwfOUAI",
                "title": "POV: Your Family Found Out You Have Money",
                "channel": "Bille Finance",
                "views": 18165,
                "outlier": 7.26,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "suggested",
                "video_id": "",
                "title": "POV: You Retired at 40 — Nobody Knows",
                "channel": "",
                "views": "",
                "outlier": "",
                "source": "hypothetical"
            }
        ]
    },
    {
        "id": "TF-02",
        "name": "Hidden Illusion & Real Cost (Chi phí thực sự của lối sống bình thường)",
        "template": "The True Cost of a “[Khái niệm bình thường]” [Lối sống / Quyết định]",
        "psych": "Đánh vào nỗi sợ bị 'dắt mũi' bởi truyền thông và xã hội; vạch trần cái bẫy vô hình của tầng lớp trung lưu.",
        "power_words": "The True Cost, Normal, Trap, Hidden Price, Draining",
        "note": "Thích hợp cho các video bóc tách lối sống tiêu dùng, chi phí ẩn của việc mua nhà, sắm xe trả góp.",
        "examples": [
            {
                "type": "real",
                "video_id": "sFe9JMHcpsQ",
                "title": "The True Cost of a “Normal” American Lifestyle",
                "channel": "Jack Explains Money",
                "views": 3368,
                "outlier": 0.5,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "SH74yUccrYo",
                "title": "The True Cost of a “Normal” American Lifestyle",
                "channel": "Nick Invests",
                "views": 17393,
                "outlier": 2.23,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "suggested",
                "video_id": "",
                "title": "The True Cost of Buying a New Car in Your 20s",
                "channel": "",
                "views": "",
                "outlier": "",
                "source": "hypothetical"
            }
        ]
    },
    {
        "id": "TF-03",
        "name": "The Unspoken Milestone (Cột mốc tiền bạc không ai nói cho bạn)",
        "template": "What Nobody Tells You About [Cột mốc tiền bạc / Thành quả]",
        "psych": "Sự tò mò tột độ (Curiosity Gap) + Cảm giác được tiếp cận thông tin hậu trường độc quyền.",
        "power_words": "What Nobody Tells You, First $100K, The Reality, Secret",
        "note": "Thích hợp làm video về 100 triệu/1 tỷ đầu tiên, hoặc giai đoạn khởi đầu tích lũy tài sản.",
        "examples": [
            {
                "type": "real",
                "video_id": "8NegfIMQJfQ",
                "title": "What Nobody Tells You About Your First $100,000",
                "channel": "Alicia Invests",
                "views": 6331,
                "outlier": 0.87,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "x_0SiM-UEzg",
                "title": "What No One Tells You About Dividend Income",
                "channel": "Kate Stalter CFP @TruthAboutRetirement",
                "views": 271804,
                "outlier": "",
                "source": "youtube_search"
            },
            {
                "type": "suggested",
                "video_id": "",
                "title": "What Nobody Tells You About Living on Dividends",
                "channel": "",
                "views": "",
                "outlier": "",
                "source": "hypothetical"
            }
        ]
    },
    {
        "id": "TF-04",
        "name": "Silent Account Drainers (Kẻ trộm tiền vô hình)",
        "template": "[Số lượng] Silent [Danh từ] Draining Your [Tài khoản/Ví] Every Month",
        "psych": "Nỗi đau mất tiền ngầm (Loss Aversion) — con người ghét bị mất tiền hơn là thích kiếm thêm tiền.",
        "power_words": "Silent, Draining, Bleeding, Sneaky, Without Realizing",
        "note": "Rất hợp với các đề tài quản lý chi tiêu, phí ngân hàng, thói quen tiêu vặt không tên.",
        "examples": [
            {
                "type": "real",
                "video_id": "_zgWg3yu0T8",
                "title": "10 Silent Fees Draining Your Bank Account Every Month (That You Probably Didn't Know About)",
                "channel": "Alicia Invests",
                "views": 3093,
                "outlier": 0.43,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "wAcw8UN0-YU",
                "title": "5 Silent Wealth Killers Costing You $6,000+ Per Year",
                "channel": "Nick Invests",
                "views": 12942,
                "outlier": 1.66,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "0I9_-6JICnU",
                "title": "7 Money Mistakes Keeping You Poor (Fix These This Week)",
                "channel": "Jack Explains Money",
                "views": 11523,
                "outlier": 1.72,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "suggested",
                "video_id": "",
                "title": "7 Silent Habits Keeping You Poor in Your 30s",
                "channel": "",
                "views": "",
                "outlier": "",
                "source": "hypothetical"
            }
        ]
    },
    {
        "id": "TF-05",
        "name": "The Contrarian Harsh Reality (Sự thật phũ phàng đi ngược số đông)",
        "template": "The Harsh Reality of [Mục tiêu tài chính] (Nobody Tells You This)",
        "psych": "Phá vỡ ảo tưởng màu hồng; thu hút người xem vì sự chân thật, thẳng thắn, không lùa gà.",
        "power_words": "The Harsh Reality, Brutal Truth, Nobody Tells You, Dark Side",
        "note": "Dùng cho video cảnh báo về rủi ro đầu tư, những cái giá phải trả khi làm giàu, lối sống độc thân tài chính.",
        "examples": [
            {
                "type": "suggested",
                "video_id": "",
                "title": "The Harsh Reality of Getting Rich",
                "channel": "",
                "views": "",
                "outlier": "",
                "source": "hypothetical"
            },
            {
                "type": "suggested",
                "video_id": "",
                "title": "The Brutal Truth About Passive Income",
                "channel": "",
                "views": "",
                "outlier": "",
                "source": "hypothetical"
            }
        ]
    },
    {
        "id": "TF-06",
        "name": "Paradoxical Luxury Habits (Thói quen 0 đồng tạo cảm giác giàu)",
        "template": "[Số lượng] Free Habits That Make Every [Thời điểm] Feel Expensive",
        "psych": "Nghịch lý 'Miễn phí nhưng đắt giá'; thỏa mãn nhu cầu nâng cấp bản thân mà không tốn kém tài chính.",
        "power_words": "Free Habits, Feel Expensive, Zero-Cost, Transform, Daily",
        "note": "Dùng cho các video phong cách sống, rèn luyện tư duy tiền bạc (Money Mindset), kỷ luật cá nhân.",
        "examples": [
            {
                "type": "real",
                "video_id": "ylv5PYLrMVM",
                "title": "12 Free Upgrades That Make Life Feel Expensive",
                "channel": "Alicia Invests",
                "views": 149638,
                "outlier": 20.68,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "CnVCgNe-0s8",
                "title": "10 Free Habits That Make Every Morning Feel Expensive",
                "channel": "Alicia Invests",
                "views": 15024,
                "outlier": 2.08,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "suggested",
                "video_id": "",
                "title": "5 Zero-Cost Habits That Completely Shift Your Money Mindset",
                "channel": "",
                "views": "",
                "outlier": "",
                "source": "hypothetical"
            }
        ]
    },
    {
        "id": "TF-07",
        "name": "The Tipping Point Trigger (Điểm bùng nổ của Lãi kép)",
        "template": "The [Tài khoản/Con số] Where [Yếu tố tài chính] Finally Beats [Thu nhập]",
        "psych": "Hình dung cụ thể vạch đích: Đưa ra mục tiêu toán học rõ ràng để người xem soi chiếu tài chính bản thân.",
        "power_words": "Finally Beats, Exact Number, Tipping Point, Compounding, Paycheck",
        "note": "Dùng cho video đầu tư chứng khoán, quỹ chỉ số S&P 500, đầu tư cổ tức (Dividend Investing).",
        "examples": [
            {
                "type": "real",
                "video_id": "jzMphXboc_E",
                "title": "The 401k Number Where COMPOUNDING Finally Beats Your Paycheck!",
                "channel": "Wealth Logic",
                "views": 6781,
                "outlier": 0.68,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "n5q80b8R8Tc",
                "title": "The 6 Wealth Levels Where Compounding Gets Insane",
                "channel": "Nick Invests",
                "views": 61720,
                "outlier": 7.9,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "suggested",
                "video_id": "",
                "title": "The Exact Investment Amount Where Dividends Pay Your Rent",
                "channel": "",
                "views": "",
                "outlier": "",
                "source": "hypothetical"
            }
        ]
    },
    {
        "id": "TF-08",
        "name": "Personification of Money (Đồng tiền có tính cách & quy luật)",
        "template": "Money Loves [Đức tính / Kỷ luật]: The [Thời gian] Habits of Future Millionaires",
        "psych": "Nhân cách hóa tiền bạc; tạo cảm giác tôn trọng quy luật vũ trụ của dòng tiền.",
        "power_words": "Money Loves, Future Millionaires, Secret Rules, Attraction, Discipline",
        "note": "Dùng cho video triết lý tài chính (Financial Stoicism), bài học tư duy từ các bậc thầy làm giàu.",
        "examples": [
            {
                "type": "real",
                "video_id": "tws7DDdR-T4",
                "title": "Money Loves Discipline 💰 | The Daily Habits of Future Millionaires | Finance Audiobook",
                "channel": "Mind Over Pages",
                "views": 12080,
                "outlier": 355.29,
                "source": "fact_video_outlier.tsv"
            },
            {
                "type": "real",
                "video_id": "E4MKlz8LB_c",
                "title": "Money Loves Discipline: The Daily Habits of Future Millionaires | Full Audiobook",
                "channel": "Limitless Growth Audiobook",
                "views": 15707,
                "outlier": "",
                "source": "youtube_search"
            },
            {
                "type": "suggested",
                "video_id": "",
                "title": "Money Hates Emotion: How Stoics Handle Market Crashes",
                "channel": "",
                "views": "",
                "outlier": "",
                "source": "hypothetical"
            }
        ]
    },
    {
        "id": "TF-09",
        "name": "The Affordability Disconnect (Nghịch lý Thu nhập vs Mua sắm)",
        "template": "How Are Americans Affording [Món đồ/Tài sản đắt đỏ] on Average Salaries?",
        "psych": "Social comparison & status anxiety (nghi ngờ xã hội, tò mò tài chính ngầm, bóc trần nợ nần trung lưu Mỹ).",
        "power_words": "How Are Americans Affording, Average Salaries, The Math Doesn't Work, Secret Debt, New Normal",
        "note": "Rất mạnh với audience Mỹ. Bóc tách bài toán chi phí thật, so sánh lương trung bình US ($59k) với giá nhà $500k hoặc xe bán tải $100k, chỉ ra việc dùng nợ 84 tháng.",
        "examples": [
            {
                "type": "real",
                "video_id": "xRjVEdl9350",
                "title": "How Are Americans Affording $500,000 Homes on Average Salaries?",
                "channel": "Wealth Logic",
                "views": 243162,
                "outlier": 24.29,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "9-JtM9moW7c",
                "title": "How Are Americans Affording $100,000 Trucks On Average Salaries?",
                "channel": "Wealth Logic",
                "views": 132142,
                "outlier": 13.2,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "KewJ93AxIkY",
                "title": "How Are Americans Affording The $3,000 iPhone Duo on Average Salaries?!",
                "channel": "Wealth Logic",
                "views": 97575,
                "outlier": 9.75,
                "source": "fact_video_seed.tsv"
            }
        ]
    },
    {
        "id": "TF-10",
        "name": "Post-Milestone Metamorphosis (Biến chuyển tâm lý sau cột mốc tiền)",
        "template": "How Your Life Changes After [Tiết kiệm/Đạt cột mốc $X] ([Góc nhìn/Sự thật])",
        "psych": "Relief & aspiration (hy vọng đổi đời, tò mò về cảm giác của người đã chạm mốc tài chính, giảm stress sinh tồn).",
        "power_words": "How Your Life Changes, After Saving, First $10,000, Different Person, The Shift",
        "note": "Tập trung vào sự biến chuyển tâm lý và hành vi vô hình (stress giảm, tự tin hơn, compounding bắt đầu rõ) thay vì chỉ nói con số khô khan.",
        "examples": [
            {
                "type": "real",
                "video_id": "bNVpbTAAaDk",
                "title": "How Your Life Changes After Saving $10,000",
                "channel": "Jack Explains Money",
                "views": 127607,
                "outlier": 19.02,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "Kk0ncArtWHA",
                "title": "How to Build Wealth in 5 Years (Realistic Version)",
                "channel": "Jack Explains Money",
                "views": 157185,
                "outlier": 23.43,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "-2VvHOm6QQ8",
                "title": "How to Turn Saving Into Investing (Step by Step Path)",
                "channel": "Jack Explains Money",
                "views": 625746,
                "outlier": 93.29,
                "source": "fact_video_seed.tsv"
            }
        ]
    },
    {
        "id": "TF-11",
        "name": "ELI5 Macro & Financial Scandal (Giải mã khủng hoảng & lừa đảo tài chính)",
        "template": "The [Vụ lừa đảo / Cuộc khủng hoảng tài chính] Explained Like You're 5",
        "psych": "Curiosity gap & schadenfreude (sự tò mò trước các vụ sụp đổ tài chính chấn động, ham muốn hiểu kinh tế mà không cần thuật ngữ phức tạp).",
        "power_words": "Explained Like You're 5, Scam, Crisis, Wall Street, Collapsing, Millions",
        "note": "Kể chuyện tài chính điện ảnh ngôi thứ hai kết hợp giải thích trực quan, mổ xẻ cơ chế vận hành của những trò gian lận tài chính lịch sử.",
        "examples": [
            {
                "type": "real",
                "video_id": "HawmGu7oNrc",
                "title": "The Wolf of Wall Street Scam Explained Like You're 5",
                "channel": "Crayon Capital",
                "views": 4225162,
                "outlier": 16.45,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "LuEcoqizj0o",
                "title": "The Great Depression Explained Like You’re 5",
                "channel": "Crayon Capital",
                "views": 2776663,
                "outlier": 10.81,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "KE-WJevx-7c",
                "title": "The 2008 Financial Crisis Explained Like You’re 5",
                "channel": "Crayon Capital",
                "views": 2295113,
                "outlier": 8.93,
                "source": "fact_video_seed.tsv"
            }
        ]
    },
    {
        "id": "TF-12",
        "name": "The Hidden Economics of Everyday Businesses (Kinh tế học phía sau doanh nghiệp quen thuộc)",
        "template": "The Economics of Owning a [Doanh nghiệp quen thuộc / Aspirational Business]",
        "psych": "Behind-the-curtain intrigue (nhìn xuyên qua vỏ bọc bề ngoài của một mô hình kinh doanh, tính toán dòng tiền thực).",
        "power_words": "The Economics of Owning, Cash Flow, Hidden Profit, Real Margins, Behind Closed Doors",
        "note": "Phân tích cấu trúc chi phí, margin lợi nhuận, và những cạm bẫy tài chính của các ngành kinh doanh từ tiệm bánh đến quỹ PE.",
        "examples": [
            {
                "type": "real",
                "video_id": "uQ_fQEBYTJ0",
                "title": "The Economics of Owning a Private Equity Firm",
                "channel": "Mr. Finance",
                "views": 115427,
                "outlier": 14.95,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "aNghmPn-OGw",
                "title": "The Economics of Owning a Bakery",
                "channel": "Mr. Finance",
                "views": 82485,
                "outlier": 10.69,
                "source": "fact_video_seed.tsv"
            }
        ]
    },
    {
        "id": "TF-13",
        "name": "Second-Person Quiet Wealth Counter-Narrative (Kịch bản nghịch lý giàu ngầm)",
        "template": "You [Sự kiện tài chính ngược đời/Bị sa thải/Kín tiếng]. You [Phản ứng điềm tĩnh/Không ai biết].",
        "psych": "Stoic superiority & stealth wealth (tâm lý thỏa mãn ngầm khi làm chủ cuộc chơi tài chính, không phụ thuộc vào công việc hay xã hội).",
        "power_words": "You Get Laid Off, You Say Thank You, Nobody Knows Your Name, Quiet Millionaire, Old Money",
        "note": "POV điện ảnh thuần túy mô tả một ngày hoặc một tình huống đời sống của người sở hữu tự do tài chính tuyệt đối, phong thái điềm tĩnh trước biến cố kinh tế.",
        "examples": [
            {
                "type": "real",
                "video_id": "ne_ZlaNw1M4",
                "title": "A Day in the Life of a Quiet Millionaire",
                "channel": "Bille Finance",
                "views": 181771,
                "outlier": 72.68,
                "source": "fact_video_seed.tsv"
            },
            {
                "type": "real",
                "video_id": "Ezbchs68YjY",
                "title": "You Get Laid Off at 57. You Say Thank You.",
                "channel": "Bille Finance",
                "views": 66547,
                "outlier": 26.61,
                "source": "fact_video_seed.tsv"
            }
        ]
    }
]

def main():
    header = [
        "formula_id",
        "formula_name",
        "template",
        "psych_mechanism",
        "power_words",
        "production_note",
        "evidence_type",
        "evidence_video_id",
        "evidence_title",
        "evidence_channel",
        "evidence_views",
        "evidence_outlier_ratio",
        "source",
        "collected_at"
    ]

    rows = []
    for f in formulas:
        f_id = f["id"]
        f_name = f["name"]
        f_tmpl = f["template"]
        f_psych = f["psych"]
        f_pw = f["power_words"]
        f_note = f["note"]

        for ex in f["examples"]:
            e_type = ex["type"]
            e_vid = ex["video_id"]
            e_title = ex["title"]
            e_channel = ex["channel"]
            e_views = str(ex["views"]) if ex["views"] != "" else ""
            e_outlier = str(ex["outlier"]) if ex["outlier"] != "" else ""
            e_source = ex["source"]

            rows.append([
                f_id,
                f_name,
                f_tmpl,
                f_psych,
                f_pw,
                f_note,
                e_type,
                e_vid,
                e_title,
                e_channel,
                e_views,
                e_outlier,
                e_source,
                "2026-09-18"
            ])

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as out:
        writer = csv.writer(out, delimiter="\t", lineterminator="\n")
        writer.writerow(header)
        for r in rows:
            writer.writerow(r)

    print(f"Successfully generated {len(rows)} rows across {len(formulas)} formulas to {OUTPUT_FILE}")

if __name__ == "__main__":
    main()
