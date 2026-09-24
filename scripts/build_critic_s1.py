#!/usr/bin/env python3
"""Tạo file critic_findings_s1.tsv trong inbox_spy/
Đóng vai Giám khảo (Critic Gate) kiểm định nhị phân các file do search-2 nộp:
- spy_candidates.tsv (153 dòng)
- spy_corpus_video.tsv (216 dòng)
Tiêu chuẩn tối thượng: 'Tìm trường hợp dữ liệu TỆ HƠN lại được điểm CAO HƠN'.
"""
import os

OUT_FILE = "/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room/writer-room-data/spy-sheet/inbox_spy/critic_findings_s1.tsv"

header = [
    "finding_id", "gate", "severity", "claim", "evidence_table",
    "evidence_filter", "expected", "actual", "why_it_misleads",
    "suggested_fix", "source", "collected_at"
]

findings = [
    [
        "CS01",
        "B",
        "blocker",
        "niche_fit_score bị nghịch đảo hoàn toàn: top 10 điểm cao nhất thì 9 kênh là giải trí tiếng Việt, non-faceless, off-niche (50-59 điểm), trong khi 6 kênh tài chính Mỹ cốt lõi bị chấm 0.0 điểm",
        "spy_candidates.tsv",
        "niche_fit_score desc vs relevance='core'",
        "Kênh tiếng Anh, faceless, core finance có điểm cao hơn kênh giải trí/thời sự tiếng Việt off-niche",
        "Top điểm cao nhất: BPro Tube (59.11, nhạc beat VN), Linh Phạm (58.19, vlog VN), Kingbooks (57.22, sách VN), VTC NEWS (54.33, 19k video tin tức VN), Weiwei Chinese (53.78, dạy tiếng Trung). Trong khi Casual Finance, Hidden Yield, Finance POV, Money Tom, Rank POV, Ollie Finance đều bị 0.0 điểm",
        "Thuật toán cộng +10 điểm languageMatch cho VN và cộng điểm sub/recency mà bỏ qua kiểm tra đề tài; nếu dùng bảng điểm này để tuyển chọn sẽ đẩy 100% kênh rác vào danh mục",
        "Loại bỏ toàn bộ kênh language_guess != 'en' hoặc is_faceless == FALSE trước khi tính điểm; tính niche_fit dựa trên keyword overlap tài chính Mỹ; gán lại điểm cho các kênh core bị 0 điểm",
        "spy_candidates.tsv niche_fit_score inspection",
        "2026-09-18"
    ],
    [
        "CS02",
        "C",
        "blocker",
        "Corpus nghiên cứu thị trường Mỹ bị ô nhiễm nghiêm trọng: 48/216 video (22.2%) là tiếng Việt với nội dung showbiz, giang hồ mạng, học đường hoàn toàn lạc đề",
        "spy_corpus_video.tsv",
        "video_id in ('53__MnP1Ofs', '2d7TgKcnEqg', 'AFyy3lkgfHo', 'KiCkptQLafE')",
        "Toàn bộ video trong corpus phục vụ kênh POV Finance Mỹ phải là tiếng Anh và đúng ngách tài chính",
        "48 video tiếng Việt như 'Bà Phương Hằng có phải Nhà Tiên Tri' (Cỏ Khong Ngu), 'Bạn là người DUY NHẤT trượt ĐẠI HỌC' (Bí mập 666), 'TẠI SAO GIANG HỒ MẠNG ĐI TÙ' (Anh Ba Tài Chính) được gán relevance=adjacent",
        "Writer Room lấy ý tưởng kịch bản sẽ bị dẫn dụ vào đề tài giật gân bản địa Việt Nam, phá hỏng hoàn toàn định vị kênh tài chính ngôi thứ hai cho khán giả Mỹ",
        "Thiết lập bộ lọc ngôn ngữ bắt buộc (language_guess == 'en') tại tầng truy vấn spy_corpus_videos; gán relevance=off và thanh trừng toàn bộ 48 video tiếng Việt khỏi corpus",
        "spy_corpus_video.tsv title and language audit",
        "2026-09-18"
    ],
    [
        "CS03",
        "B",
        "blocker",
        "outlier_score bị so sánh xuyên kênh sai bản chất: video showbiz Việt Nam điểm cao gấp 4 lần video Model kênh, video 500k view điểm cao gấp 8 lần video 9.35 triệu view",
        "spy_corpus_video.tsv",
        "video_id in ('53__MnP1Ofs', 'avWK82b0fUU', 'QPW4mAjxBHM', 'tS_fJJxMjn4')",
        "Outlier score chỉ có ý nghĩa nội bộ trong cùng một kênh; khi đưa vào corpus chung phải có cơ chế chuẩn hóa hoặc kết hợp volume view",
        "Video 'Bà Phương Hằng' (53__MnP1Ofs) outlier_score = 44.79 trong khi video Model POV Finance 'avWK82b0fUU' (382k view) chỉ đạt 11.08; video 500k view (QPW4mAjxBHM) đạt điểm ảo 773.17 cao gấp 8 lần video 9.35 triệu view (tS_fJJxMjn4, điểm 95.59)",
        "Tái phạm trực tiếp luật (b): so sánh điểm số tính bằng các mẫu số MAD khác nhau giữa các kênh; video thuộc kênh nền chết bị thổi phồng lấn át video triệu view thực chất",
        "Cấm xếp hạng xuyên kênh bằng outlier_score đơn độc; bổ sung cột rank_score = outlier_score * log10(view_count) hoặc chỉ xếp hạng corpus theo velocity / view_count kèm lọc cohort",
        "spy_corpus_video.tsv outlier_score cross-channel comparison",
        "2026-09-18"
    ],
    [
        "CS04",
        "B",
        "major",
        "Kênh chết 0 video và kênh bán xi măng 19 sub được 15-25 điểm trong khi kênh triệu view thật sự lại xếp dưới",
        "spy_candidates.tsv",
        "channel_id in ('UCanI7a1V-TmutX15wcntZWw', 'UC9hxM72uqYb-VQXbcPqi_Eg', 'UC0L9hD7HMwWU7xuU5HRA6Iw')",
        "Kênh không có hoạt động hoặc hoàn toàn off-niche phải bị điểm 0; kênh triệu view có chỉ số thật phải có điểm cao hơn",
        "Dark Wisdom (UCanI7a1V-TmutX15wcntZWw, 0 video, 76 sub) được 15.0 điểm; Xi Măng Hoàng Long (UC9hxM72uqYb-VQXbcPqi_Eg, 19 sub) được 24.93 điểm; Cold Philosophy (10 sub) được 30.07 điểm. Trong khi kênh triệu view Hypothetically (median 1.73 triệu view) chỉ được 47.08 điểm",
        "Cho điểm an ủi cho kênh rỗng vi phạm luật (b); một kênh 0 video lại có điểm xếp trên các kênh cốt lõi bị 0 điểm",
        "Đặt điều kiện tiên quyết (pre-requisite gate): video_count >= 5 và subscriber_count >= 100 mới bắt đầu tính niche_fit_score; kênh rỗng tự động gán điểm 0",
        "spy_candidates.tsv activity vs score audit",
        "2026-09-18"
    ],
    [
        "CS05",
        "A",
        "major",
        "spy_candidates.tsv cột decision bị bỏ trống 152/153 dòng và 111/153 kênh (72.5%) thiếu hoàn toàn median_views",
        "spy_candidates.tsv",
        "column decision is empty (152 of 153 rows) or median_views is empty (111 rows)",
        "Mọi kênh ứng viên phải có nhãn quyết định rõ ràng và đầy đủ metric baseline để đối chiếu",
        "Chỉ có đúng 1 dòng (Money Talk With Leon) ghi decision='shortlisted', toàn bộ 152 dòng còn lại để trống; 72.5% kênh không có median_views khiến không thể đánh giá hiệu quả view thực chất",
        "Dữ liệu nộp ở trạng thái nửa vời, mới chỉ cào thô từ đồ thị sang mà chưa qua làm sạch hay quét sâu",
        "Yêu cầu search-2 hoàn thiện cột decision với enum chuẩn (shortlisted/rejected/pending) và quét metadata để lấp đầy median_views cho các kênh ứng viên",
        "spy_candidates.tsv decision & median_views completeness",
        "2026-09-18"
    ],
    [
        "CS06",
        "A",
        "minor",
        "spy_corpus_video.tsv không có thứ tự sắp xếp nhất quán và gán nhãn thể loại tùy tiện",
        "spy_corpus_video.tsv",
        "rows 1 to 216",
        "Corpus video phải được sắp xếp theo một tiêu chí xác định (velocity desc hoặc published_at desc) và gán format_tag chính xác",
        "Các hàng bị trộn lộn xộn giữa các mốc velocity; video thời sự/showbiz Việt Nam được gán nhãn format_tag='explainer' và 'case_study' ngang hàng với phim tài liệu kinh tế Mỹ",
        "Làm sai lệch phân tích format thị trường và gây nhầm lẫn cho việc trích xuất công thức kịch bản",
        "Quy định order_by='velocity' descending và xây dựng taxonomy chuẩn cho format_tag kèm bộ kiểm định tự động",
        "spy_corpus_video.tsv format_tag & sort order check",
        "2026-09-18"
    ]
]

def clean_str(val):
    return str(val).strip().replace("\t", " ").replace("\r", " ").replace("\n", " ")

with open(OUT_FILE, "w", encoding="utf-8") as f:
    f.write("\t".join(header) + "\n")
    for r in findings:
        f.write("\t".join(clean_str(x) for x in r) + "\n")

print(f"Ghi xong {OUT_FILE}: {len(findings)} phát hiện giám khảo x {len(header)} cột.")
