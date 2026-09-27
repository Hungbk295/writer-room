#!/usr/bin/env python3
"""
Update inbox/_dictionary.tsv and generate inbox/_readme.tsv
following Aswath Damodaran's provenance and decision-driven architecture.
"""

import os
import csv

INBOX_DIR = "/Users/jc/Documents/Sth/Taphoa/makemoney/writer-room/writer-room-data/spy-sheet/inbox"
DICT_PATH = os.path.join(INBOX_DIR, "_dictionary.tsv")
README_PATH = os.path.join(INBOX_DIR, "_readme.tsv")

# =============================================================================
# 1. BUILD DICTIONARY (90 rows across 5 tables)
# =============================================================================
DICT_HEADER = [
    "table_name", "column_name", "data_type", "unit", "definition",
    "why", "formula", "source_field", "nullable", "example_value"
]

DICT_ROWS = [
    # -------------------------------------------------------------------------
    # dim_channel (24 columns)
    # -------------------------------------------------------------------------
    [
        "dim_channel", "channel_id", "string", "",
        "Mã định danh duy nhất của kênh YouTube theo định dạng UC...",
        "Quyết định mapping quan hệ 1-N với bảng fact_video và tra cứu API YouTube chuẩn xác.",
        "", "youtube.channel.id", "FALSE", "UCZJnbHQTYBy1I8GpHlsAUMg"
    ],
    [
        "dim_channel", "handle", "string", "",
        "Tên định danh người dùng công khai trên YouTube bắt đầu bằng ký tự @.",
        "Quyết định nhận diện thương hiệu công khai và truy cập trực tiếp trang chủ kênh.",
        "", "youtube.channel.snippet.customUrl", "FALSE", "@JackExplainsMoneyUS"
    ],
    [
        "dim_channel", "channel_title", "string", "",
        "Tên hiển thị chính thức của kênh YouTube.",
        "Quyết định hiển thị nhãn thân thiện trên dashboard phân tích và báo cáo tổng hợp.",
        "", "youtube.channel.snippet.title", "FALSE", "Jack Explains Money"
    ],
    [
        "dim_channel", "is_seed", "boolean", "",
        "Cờ nhị phân xác định kênh thuộc tập 16 kênh hạt giống chuẩn hay tập đối thủ mở rộng.",
        "Quyết định phân nhóm phân tích chuẩn đối sánh (benchmark group) so với toàn bộ vũ trụ kênh quét được.",
        "", "manual_flag", "FALSE", "TRUE"
    ],
    [
        "dim_channel", "subscriber_count", "integer", "subscribers",
        "Tổng số lượng tài khoản đăng ký kênh tại thời điểm thu thập.",
        "Quyết định phân tầng quy mô đối thủ (micro/mid/macro) để chọn benchmark phù hợp với kênh mới.",
        "", "youtube.channel.statistics.subscriberCount", "TRUE", "77300"
    ],
    [
        "dim_channel", "total_view_count", "integer", "views",
        "Tổng lượt xem tích lũy của toàn bộ video trên kênh từ khi thành lập.",
        "Quyết định đánh giá tổng dung lượng tiếp cận lịch sử và tuổi thọ thương hiệu của kênh.",
        "", "youtube.channel.statistics.viewCount", "TRUE", "1200662"
    ],
    [
        "dim_channel", "video_count", "integer", "count",
        "Tổng số lượng video (cả long-form và Shorts) đã xuất bản trên kênh.",
        "Quyết định kiểm tra quy mô mẫu phát hành và đánh giá độ bền sản xuất của kênh đối thủ.",
        "", "youtube.channel.statistics.videoCount", "TRUE", "24"
    ],
    [
        "dim_channel", "country", "string", "",
        "Mã quốc gia 2 ký tự ISO 3166-1 alpha-2 nơi tài khoản kênh được đăng ký.",
        "Quyết định sàng lọc nguồn gốc pháp lý ban đầu của kênh đối thủ.",
        "", "youtube.channel.snippet.country", "TRUE", "US"
    ],
    [
        "dim_channel", "primary_language", "string", "",
        "Ngôn ngữ chính được sử dụng trong âm thanh và tiêu đề video của kênh.",
        "Quyết định lọc kênh cùng ngôn ngữ tiếng Anh để đưa vào kho nguyên liệu clone kịch bản.",
        "", "vidiq.primaryLanguage", "TRUE", "en"
    ],
    [
        "dim_channel", "niche", "string", "",
        "Phân loại chuyên mục nội dung mà kênh tập trung khai thác.",
        "Quyết định định vị danh mục cạnh tranh và phân bổ tỷ trọng các trụ cột chủ đề.",
        "", "vidiq.niche", "TRUE", "Personal Finance"
    ],
    [
        "dim_channel", "channel_type", "enum", "",
        "Định dạng xuất bản chủ đạo của kênh gồm long|short|mixed.",
        "Quyết định lựa chọn chiến lược định dạng sản xuất (tập trung thuần long-form hay kết hợp Shorts kéo phễu).",
        "", "vidiq.channelType", "TRUE", "long"
    ],
    [
        "dim_channel", "is_faceless", "boolean", "",
        "Xác định kênh sản xuất nội dung không lộ mặt (animation/b-roll/voiceover) hay dùng người thật.",
        "Quyết định chọn lọc mô hình có thể nhân bản quy trình sản xuất faceless mà không phụ thuộc talent.",
        "", "manual_audit", "TRUE", "TRUE"
    ],
    [
        "dim_channel", "avg_views", "float", "views",
        "Lượt xem trung bình trên mỗi video tính trên toàn bộ lịch sử kênh.",
        "CANDIDATE_FOR_REMOVAL",
        "total_view_count / video_count", "derived", "TRUE", "50027.58"
    ],
    [
        "dim_channel", "median_views_last20", "float", "views",
        "Trung vị lượt xem của 20 video long-form gần nhất đã phát hành của kênh.",
        "Quyết định thiết lập đường cơ sở (baseline) thực tế của kênh để tính tỷ lệ outlier và đo sức hút thực của format hiện tại.",
        "calc_median(last20_long_views)", "derived", "TRUE", "6707.5"
    ],
    [
        "dim_channel", "long_videos_30d", "integer", "count",
        "Số lượng video long-form được xuất bản trong 30 ngày gần nhất.",
        "Quyết định đo lường nhịp độ phát hành thực tế hiện tại của đối thủ để thiết lập KPI công suất sản xuất của team.",
        "count(videos_published_last_30d)", "derived", "TRUE", "30"
    ],
    [
        "dim_channel", "uploads_per_month", "integer", "count",
        "Số lượng video xuất bản trung bình hàng tháng theo thống kê của vidIQ.",
        "CANDIDATE_FOR_REMOVAL",
        "", "vidiq.growth.videosPublished", "TRUE", "30"
    ],
    [
        "dim_channel", "long_avg_duration_sec", "integer", "seconds",
        "Thời lượng trung bình của các video long-form tính bằng giây.",
        "Quyết định ấn định khung thời lượng chuẩn (ví dụ 20-22 phút) cho kịch bản nhằm tối ưu tỷ lệ giữ chân và chèn mid-roll ads.",
        "sum(long_durations) / count(long_videos)", "derived", "TRUE", "1260"
    ],
    [
        "dim_channel", "subs_growth_30d_pct", "float", "percent_0_100",
        "Tỷ lệ phần trăm tăng trưởng lượng người đăng ký trong 30 ngày gần nhất.",
        "Quyết định nhận diện sớm các kênh breakout thần tốc đang được thuật toán YouTube ưu ái để mổ xẻ chiến lược.",
        "(subs_now - subs_30d) / subs_30d * 100", "derived", "TRUE", "849.17"
    ],
    [
        "dim_channel", "views_growth_30d_pct", "float", "percent_0_100",
        "Tỷ lệ phần trăm tăng trưởng tổng lượt xem kênh trong 30 ngày gần nhất.",
        "Quyết định phát hiện đột biến lưu lượng (traffic surge) của đối thủ để bám đuổi đề tài đang bùng nổ.",
        "(views_now - views_30d) / views_30d * 100", "derived", "TRUE", "1211.41"
    ],
    [
        "dim_channel", "channel_created_at", "date", "ISO_date",
        "Ngày tạo kênh trên YouTube theo định dạng chuẩn YYYY-MM-DD.",
        "Quyết định phân biệt mô hình bứt phá thần tốc trong thời gian ngắn với kênh lâu năm tích lũy uy tín thương hiệu.",
        "", "youtube.channel.snippet.publishedAt", "TRUE", "2026-04-07"
    ],
    [
        "dim_channel", "last_video_published", "date", "ISO_date",
        "Ngày phát hành video long-form gần nhất theo định dạng YYYY-MM-DD.",
        "Quyết định sàng lọc loại bỏ các kênh đã ngừng hoạt động (dormant) khỏi danh sách theo dõi chiến dịch.",
        "", "youtube.activities.publishedAt", "TRUE", "2026-09-17"
    ],
    [
        "dim_channel", "relevance", "enum", "",
        "Mức độ liên quan đến ngách mục tiêu của dự án gồm core|adjacent|off.",
        "Quyết định đưa kênh vào danh mục đối sánh trọng tâm (core), tham khảo mở rộng (adjacent) hay loại bỏ (off).",
        "", "manual_audit", "TRUE", "core"
    ],
    [
        "dim_channel", "source", "string", "",
        "Tên công cụ, API hoặc phương thức được dùng để thu thập dữ liệu dòng kênh.",
        "Quyết định kiểm chứng tính xác thực và khả năng tái lập của pipeline dữ liệu.",
        "", "system_provenance", "FALSE", "vidiq"
    ],
    [
        "dim_channel", "collected_at", "date", "ISO_date",
        "Ngày thực hiện thu thập dữ liệu theo chuẩn ISO YYYY-MM-DD.",
        "Quyết định xác định mốc thời gian tính toán độ trôi dữ liệu và vận tốc tăng trưởng.",
        "", "system_timestamp", "FALSE", "2026-09-18"
    ],

    # -------------------------------------------------------------------------
    # fact_video (24 columns)
    # -------------------------------------------------------------------------
    [
        "fact_video", "video_id", "string", "",
        "Mã định danh duy nhất gồm 11 ký tự của video trên YouTube.",
        "Quyết định định danh chính xác video để xem xét, trích xuất transcript và tạo URL nguồn.",
        "", "youtube.video.id", "FALSE", "Je8hjgrKvmc"
    ],
    [
        "fact_video", "channel_id", "string", "",
        "Mã định danh kênh YouTube sở hữu video.",
        "Quyết định liên kết khoá ngoại (foreign key) với bảng dim_channel để tổng hợp hiệu suất cấp kênh.",
        "", "youtube.video.snippet.channelId", "FALSE", "UCkPZLXcrP3Hc1J-Xd_uN-Mw"
    ],
    [
        "fact_video", "channel_title", "string", "",
        "Tên hiển thị của kênh tại thời điểm xuất bản video.",
        "Quyết định hiển thị nhãn kênh trực quan trên các báo cáo và bảng pivot video mà không cần join.",
        "", "youtube.video.snippet.channelTitle", "FALSE", "POV Finance"
    ],
    [
        "fact_video", "title", "string", "",
        "Tiêu đề công khai đầy đủ của video trên YouTube.",
        "Quyết định giải mã công thức đặt tiêu đề, trích xuất power words và xác định góc nhìn nội dung.",
        "", "youtube.video.snippet.title", "FALSE", "POV: You Paid Off Your Mortgage — Everyone Else Has Decades Left"
    ],
    [
        "fact_video", "published_at", "date", "ISO_date",
        "Ngày video được công khai trên YouTube theo chuẩn YYYY-MM-DD.",
        "Quyết định tính tuổi thọ video (days since publish) để đo lường tốc độ view và tính mùa vụ của chủ đề.",
        "", "youtube.video.snippet.publishedAt", "FALSE", "2026-09-16"
    ],
    [
        "fact_video", "view_count", "integer", "views",
        "Tổng số lượt xem tích lũy của video tại thời điểm thu thập dữ liệu.",
        "Quyết định xác định quy mô tiếp cận tuyệt đối và làm tử số tính toán tỷ lệ outlier.",
        "", "youtube.video.statistics.viewCount", "FALSE", "28692"
    ],
    [
        "fact_video", "like_count", "integer", "count",
        "Tổng số lượt bấm thích công khai của người xem đối với video.",
        "Dùng làm dữ liệu thô đầu vào để tính toán chỉ số cộng hưởng khán giả thực tế (like_rate = like_count / view_count).",
        "", "youtube.video.statistics.likeCount", "TRUE", "148"
    ],
    [
        "fact_video", "comment_count", "integer", "count",
        "Tổng số lượng bình luận của khán giả để lại dưới video.",
        "Quyết định đo lường mức độ tương tác sâu và khai thác các câu chuyện, tranh cãi của người xem để đưa vào kịch bản mới.",
        "", "youtube.video.statistics.commentCount", "TRUE", "81"
    ],
    [
        "fact_video", "duration_sec", "integer", "seconds",
        "Tổng thời lượng video tính bằng số giây nguyên.",
        "Quyết định kiểm soát độ dài kịch bản sản xuất để đạt ngưỡng giữ chân tối ưu của ngách.",
        "", "youtube.video.contentDetails.duration", "FALSE", "1230"
    ],
    [
        "fact_video", "is_short", "boolean", "",
        "Cờ xác định video có phải là định dạng YouTube Shorts hay không.",
        "Quyết định lọc bỏ triệt để video ngắn để bảo toàn độ chính xác của trung vị lượt xem video dài.",
        "", "youtube.video.isShort", "FALSE", "FALSE"
    ],
    [
        "fact_video", "channel_median_views", "float", "views",
        "Trung vị lượt xem của 30 video long-form gần nhất của chính kênh đó.",
        "Quyết định làm mẫu số chuẩn mực khách quan để tính outlier_ratio độc lập với quy mô kênh.",
        "calc_median(recent_30_long_views)", "derived", "TRUE", "54750"
    ],
    [
        "fact_video", "outlier_ratio", "float", "ratio",
        "Tỷ số giữa lượt xem của video và trung vị lượt xem 30 video dài gần nhất của chính kênh đó.",
        "Đo lường độ bứt phá nội tại của video so với chính kênh phát hành; đóng vai trò thành phần tính toán cốt lõi trong công thức rank_score.",
        "view_count / channel_median_views", "derived", "TRUE", "1.62"
    ],
    [
        "fact_video", "baseline_tier", "enum", "",
        "Phân tầng độ tin cậy của nền kênh gồm dead|thin|proven (dead: channel_median_views < 500 hoặc baseline_video_count < 10; thin: 500-4999; proven: >= 5000 views).",
        "Quyết định sàng lọc bỏ các tỷ lệ outlier ảo (cargo cult) phát sinh trên nền kênh chết (ví dụ median 91 views trúng 1 video 70k views ra 773x nhưng không thể nhân bản), chỉ giữ lại các kênh có nhu cầu thực chứng lặp lại được.",
        "CASE WHEN baseline_video_count < 10 OR channel_median_views < 500 THEN 'dead' WHEN channel_median_views < 5000 THEN 'thin' ELSE 'proven' END",
        "derived", "FALSE", "proven"
    ],
    [
        "fact_video", "baseline_video_count", "integer", "count",
        "Số lượng video long-form được dùng để tính toán trung vị lượt xem (channel_median_views) của kênh.",
        "Quyết định kiểm tra độ vững chắc của kích thước mẫu thống kê, nếu dưới 10 video thì không đủ độ tin cậy để tính outlier_ratio và rank_score.",
        "count(sampled_long_videos)", "derived", "FALSE", "30"
    ],
    [
        "fact_video", "rank_score", "float", "ratio",
        "Điểm số xếp hạng ưu tiên tổng hợp cân bằng giữa hệ số bứt phá (outlier_ratio) và quy mô tối thiểu của kênh (log10 của median views), để trống khi baseline_tier=dead.",
        "Quyết định làm CỘT XẾP HẠNG TỐI HẬU cho toàn bộ workbook để chọn đề tài clone; thay thế outlier_ratio thuần túy nhằm loại trừ các kênh trúng số rác và ưu tiên các chủ đề bứt phá trên nền kênh đã được kiểm chứng (proven).",
        "outlier_ratio * log10(channel_median_views + 10)", "derived", "TRUE", "7.68"
    ],
    [
        "fact_video", "vidiq_breakout_score", "float", "ratio",
        "Chỉ số bứt phá do thuật toán hộp đen của vidIQ ước lượng dựa trên vận tốc view thời gian thực toàn cầu.",
        "Quyết định làm tín hiệu cảnh báo sớm (realtime alert) cho video đang tăng tốc nhanh trong 24-48h đầu; KHÔNG dùng làm cột xếp hạng chính vì không kiểm toán được công thức.",
        "", "vidiq.breakoutScore", "TRUE", "3.75"
    ],
    [
        "fact_video", "views_per_day", "float", "views",
        "Lượt xem trung bình mỗi ngày kể từ ngày xuất bản đến ngày thu thập.",
        "Quyết định so sánh vận tốc tiêu thụ thực tế giữa các video có độ tuổi khác nhau.",
        "view_count / max(days_since_published, 1)", "derived", "FALSE", "14346"
    ],
    [
        "fact_video", "like_rate", "float", "percent_0_100",
        "Tỷ lệ phần trăm giữa lượt bấm thích (like_count) và lượt xem (view_count) của video.",
        "Quyết định phân biệt giữa video chỉ được thuật toán YouTube phân phối ngẫu nhiên (view cao nhưng like_rate thấp) và video thực sự tạo ra sự cộng hưởng sâu sắc, hài lòng nơi người xem (like_rate cao) để định hình chất lượng kịch bản.",
        "like_count / view_count * 100", "derived", "TRUE", "3.45"
    ],
    [
        "fact_video", "content_farm_signal", "boolean", "",
        "Cờ cảnh báo nhận diện kênh sản xuất hàng loạt dạng content farm chất lượng thấp (tần suất > 2 video/ngày, thời lượng bất thường, tiêu đề spam template).",
        "Quyết định loại bỏ các video ăn may của các trang trại nội dung rác (content farms) khỏi danh sách mô hình kịch bản chuẩn của dự án.",
        "uploads_per_day > 2 OR spam_pattern_detected", "derived", "FALSE", "FALSE"
    ],
    [
        "fact_video", "format_tag", "enum", "",
        "Định dạng cấu trúc triển khai gồm pov_story|listicle|explainer|case_study|news|interview|vlog|audiobook|reaction|other.",
        "Quyết định lựa chọn khung kịch bản (framework) phù hợp nhất với năng lực và phong cách sản xuất của kênh.",
        "", "classifier_format", "FALSE", "pov_story"
    ],
    [
        "fact_video", "topic_tag", "string", "",
        "Cụm từ 2-4 chữ mô tả chủ đề tài chính cốt lõi của video.",
        "Quyết định gom nhóm các đề tài cùng chủ đề để xây dựng kế hoạch nội dung có tính hệ thống.",
        "", "classifier_topic", "FALSE", "mortgage payoff"
    ],
    [
        "fact_video", "relevance", "enum", "",
        "Mức độ phù hợp của nội dung video với ngách gồm core|adjacent|off.",
        "Quyết định chọn lọc video phục vụ clone kịch bản trực tiếp (core) hay chỉ để quan sát xu hướng rộng (adjacent).",
        "", "classifier_relevance", "FALSE", "core"
    ],
    [
        "fact_video", "source", "string", "",
        "Nguồn dữ liệu hoặc công cụ được sử dụng để lấy thông tin video.",
        "Quyết định phục vụ kiểm tra tính toàn vẹn và tái tạo số liệu.",
        "", "system_provenance", "FALSE", "vidiq"
    ],
    [
        "fact_video", "collected_at", "date", "ISO_date",
        "Ngày thu thập dữ liệu theo chuẩn YYYY-MM-DD.",
        "Quyết định xác định mốc tính toán vận tốc và đối soát dữ liệu lịch sử.",
        "", "system_timestamp", "FALSE", "2026-09-18"
    ],

    # -------------------------------------------------------------------------
    # fact_keyword (12 columns)
    # -------------------------------------------------------------------------
    [
        "fact_keyword", "keyword", "string", "",
        "Cụm từ khóa tìm kiếm thực tế của người dùng liên quan đến ngách tài chính.",
        "Quyết định chọn chủ đề trọng tâm để phát triển ý tưởng video và tối ưu hóa SEO tiêu đề.",
        "", "vidiq.keyword", "FALSE", "pov finance"
    ],
    [
        "fact_keyword", "parent_keyword", "string", "",
        "Từ khóa gốc hoặc chủ đề mẹ mà từ khóa hiện tại trực thuộc.",
        "Quyết định gom cụm từ khóa thành các cụm chủ đề (topic clusters) để bao phủ toàn diện một mảng nội dung.",
        "", "vidiq.parentKeyword", "TRUE", "personal finance"
    ],
    [
        "fact_keyword", "tier", "enum", "",
        "Phân tầng cấp độ từ khóa gồm seed|related|longtail.",
        "Quyết định ưu tiên lộ trình làm nội dung: đánh từ khóa ngách dài (longtail) trước khi cạnh tranh từ khóa hạt giống (seed).",
        "", "classifier_tier", "FALSE", "seed"
    ],
    [
        "fact_keyword", "search_volume_monthly", "integer", "count",
        "Lượng tìm kiếm ước tính hàng tháng của từ khóa trên YouTube.",
        "Quyết định đánh giá trần dung lượng thị trường (market demand ceiling) của chủ đề.",
        "", "vidiq.searchVolume", "TRUE", "3021844"
    ],
    [
        "fact_keyword", "us_share_pct", "float", "percent_0_100",
        "Tỷ lệ phần trăm lượng tìm kiếm đến từ người dùng tại thị trường Mỹ.",
        "Quyết định sàng lọc từ khóa có lượng khán giả Mỹ áp đảo để đảm bảo tối ưu RPM quảng cáo và bán sản phẩm số.",
        "", "vidiq.countryShare.US", "TRUE", "45.8"
    ],
    [
        "fact_keyword", "tier1_share_pct", "float", "percent_0_100",
        "Tổng phần trăm lượng tìm kiếm đến từ 5 quốc gia Tier 1 (US + CA + GB + AU + NZ).",
        "Quyết định thẩm định chất lượng giá trị kinh tế của tệp khán giả mục tiêu cho kênh tiếng Anh.",
        "sum(share_US, share_CA, share_GB, share_AU, share_NZ)", "derived", "TRUE", "72.4"
    ],
    [
        "fact_keyword", "competition_0_100", "float", "percent_0_100",
        "Điểm số mức độ cạnh tranh của từ khóa trên thang điểm 0-100 do công cụ tính toán.",
        "Quyết định tránh các từ khóa quá bão hòa (competition > 70) và ưu tiên từ khóa có độ cạnh tranh thấp/trung bình.",
        "", "vidiq.competition", "TRUE", "29.2"
    ],
    [
        "fact_keyword", "growth_30d_pct", "float", "percent_0_100",
        "Tỷ lệ phần trăm tăng trưởng lượng tìm kiếm của từ khóa trong 30 ngày qua.",
        "Quyết định nhận diện xu hướng tìm kiếm đang tăng nhiệt (trending keyword) để đón đầu làn sóng quan tâm.",
        "", "vidiq.growth30d", "TRUE", "2629.8"
    ],
    [
        "fact_keyword", "opportunity_score", "float", "ratio",
        "Chỉ số cơ hội tổng hợp kết hợp giữa dung lượng tìm kiếm, tăng trưởng và độ cạnh tranh.",
        "Quyết định xếp hạng thứ tự ưu tiên đưa từ khóa vào danh sách sản xuất kịch bản hàng tuần.",
        "", "vidiq.overallScore", "TRUE", "86.4"
    ],
    [
        "fact_keyword", "top5_geo", "string", "",
        "Chuỗi văn bản dạng danh sách liệt kê 5 quốc gia có tỷ trọng tìm kiếm từ khóa cao nhất kèm tỷ lệ phần trăm.",
        "Phục vụ lưu vết kiểm toán (audit trail) độc lập để người dùng và các bên liên quan đối soát, xác thực tính chân thực của us_share_pct và tier1_share_pct; không dùng để lọc dữ liệu.",
        "", "vidiq.topCountries", "TRUE", "PK: 25.7%, IN: 14.7%, US: 12.2%"
    ],
    [
        "fact_keyword", "source", "string", "",
        "Nguồn gốc công cụ trích xuất dữ liệu từ khóa.",
        "Quyết định xác thực nguồn gốc và kiểm chứng số liệu thị trường.",
        "", "system_provenance", "FALSE", "vidiq_keyword_research"
    ],
    [
        "fact_keyword", "collected_at", "date", "ISO_date",
        "Ngày thu thập dữ liệu từ khóa theo chuẩn YYYY-MM-DD.",
        "Quyết định xác định chu kỳ cập nhật lại số liệu từ khóa theo định kỳ hàng tháng.",
        "", "system_timestamp", "FALSE", "2026-09-18"
    ],

    # -------------------------------------------------------------------------
    # fact_hook (16 columns)
    # -------------------------------------------------------------------------
    [
        "fact_hook", "video_id", "string", "",
        "Mã định danh video YouTube có đoạn hook được phân tích.",
        "Quyết định liên kết với fact_video để đối chiếu hiệu suất tổng thể của video tương ứng.",
        "", "youtube.video.id", "FALSE", "Je8hjgrKvmc"
    ],
    [
        "fact_hook", "channel_id", "string", "",
        "Mã định danh kênh YouTube sở hữu video có đoạn hook.",
        "Quyết định liên kết với dim_channel để phân tích phong cách mở màn đặc trưng theo kênh.",
        "", "youtube.video.snippet.channelId", "FALSE", "UCkPZLXcrP3Hc1J-Xd_uN-Mw"
    ],
    [
        "fact_hook", "channel_title", "string", "",
        "Tên hiển thị của kênh tại thời điểm phân tích.",
        "Quyết định hiển thị trực quan tác giả của mẫu hook trên báo cáo chuyên sâu.",
        "", "youtube.video.snippet.channelTitle", "FALSE", "POV Finance"
    ],
    [
        "fact_hook", "title", "string", "",
        "Tiêu đề công khai của video được mổ xẻ hook.",
        "Quyết định đánh giá độ liền mạch (congruence) giữa hứa hẹn ở tiêu đề và câu mở đầu trong 45 giây đầu.",
        "", "youtube.video.snippet.title", "FALSE", "POV: You Paid Off Your Mortgage — Everyone Else Has Decades Left"
    ],
    [
        "fact_hook", "view_count", "integer", "views",
        "Lượt xem tích lũy của video có hook được phân tích.",
        "Quyết định xác nhận quy mô thực chứng của mẫu hook trên thị trường thực tế.",
        "", "youtube.video.statistics.viewCount", "FALSE", "28692"
    ],
    [
        "fact_hook", "channel_median_views", "float", "views",
        "Trung vị lượt xem của kênh sở hữu video.",
        "Quyết định cung cấp hệ quy chiếu để biết hook này có đóng góp vào sự bứt phá của video hay không.",
        "", "fact_video.channel_median_views", "TRUE", "54750"
    ],
    [
        "fact_hook", "outlier_ratio", "float", "ratio",
        "Tỷ lệ outlier của video có hook tương ứng.",
        "Quyết định ưu tiên học hỏi cấu trúc mở đầu từ các video có hệ số outlier cao nhất.",
        "", "fact_video.outlier_ratio", "TRUE", "1.62"
    ],
    [
        "fact_hook", "hook_archetype", "enum", "",
        "Hình mẫu cấu trúc hook gồm cold_open_story|contrarian_question|statistic_shock|future_regret|secret_reveal|identity_challenge.",
        "Quyết định lựa chọn khuôn mẫu mở đầu phù hợp với mục tiêu cảm xúc của kịch bản đang viết.",
        "", "manual_nlp_classification", "TRUE", "cold_open_story"
    ],
    [
        "fact_hook", "wpm", "float", "ratio",
        "Tốc độ đọc trung bình trong 45 giây đầu tính bằng số từ chia cho 0.75 phút.",
        "Quyết định chuẩn hóa tốc độ đọc của voiceover trong khâu sản xuất để tạo nhịp điệu điện ảnh tối ưu (170-180 WPM).",
        "words_in_first_45s / 0.75", "derived", "TRUE", "173.3"
    ],
    [
        "fact_hook", "pivot_sec", "integer", "seconds",
        "Thời điểm tính bằng giây mà lời thoại chuyển từ câu chuyện dẫn nhập sang luận điểm chính.",
        "Quyết định kiểm soát độ trễ giữ chân người xem trước khi tiết lộ giá trị cốt lõi, tránh thoát video sớm.",
        "(pivot_word_index / wpm) * 60", "derived", "TRUE", "38"
    ],
    [
        "fact_hook", "transcript_first_45s", "string", "",
        "Toàn văn lời thoại phụ đề xuất hiện chính xác trong 45 giây đầu tiên của video.",
        "Quyết định cung cấp tư liệu mẫu nguyên bản từng từ để biên kịch phân tích nghệ thuật dùng từ và nhịp điệu mở màn.",
        "", "youtube.transcript", "TRUE", "It's 6:15 on a Saturday morning and you're standing in your driveway in socks holding a cup of coffee..."
    ],
    [
        "fact_hook", "psych_mechanism", "string", "",
        "Cơ chế tâm lý kích hoạt sự chú ý của khán giả trong đoạn hook (ví dụ: social_comparison, status_anxiety, loss_aversion).",
        "Quyết định kích hoạt chính xác tử huyệt cảm xúc của đối tượng mục tiêu để tối đa hóa tỷ lệ giữ chân ở 30-60 giây đầu.",
        "", "manual_audit", "TRUE", "social_comparison"
    ],
    [
        "fact_hook", "transcript_available", "boolean", "",
        "Cờ xác nhận video có phụ đề thật để phân tích hay không gồm TRUE|FALSE.",
        "Quyết định làm cổng chặn liêm chính dữ liệu (data integrity gatekeeper), tuyệt đối không suy đoán khi không có phụ đề thật.",
        "", "system_check", "FALSE", "TRUE"
    ],
    [
        "fact_hook", "analysis_confidence", "enum", "",
        "Mức độ tin cậy của kết quả phân tích đoạn hook gồm observed|inferred.",
        "Quyết định đánh giá độ chuẩn xác của dữ liệu mổ xẻ trước khi áp dụng vào sản xuất thực tế.",
        "", "system_confidence", "FALSE", "observed"
    ],
    [
        "fact_hook", "source", "string", "",
        "Nguồn trích xuất phụ đề của đoạn hook.",
        "Quyết định bảo đảm tính truy nguyên của văn bản phụ đề phục vụ kiểm toán.",
        "", "system_provenance", "FALSE", "vidiq_transcript"
    ],
    [
        "fact_hook", "collected_at", "date", "ISO_date",
        "Ngày thu thập và phân tích đoạn hook theo chuẩn YYYY-MM-DD.",
        "Quyết định đối chiếu thời điểm phân tích với các phiên bản kịch bản mẫu.",
        "", "system_timestamp", "FALSE", "2026-09-18"
    ],

    # -------------------------------------------------------------------------
    # dim_title_formula (14 columns)
    # -------------------------------------------------------------------------
    [
        "dim_title_formula", "formula_id", "string", "",
        "Mã định danh duy nhất của công thức đặt tiêu đề (ví dụ TF-01, TF-02).",
        "Quyết định mã hóa và quản lý tập trung các mẫu tiêu đề đã được chứng minh hiệu quả.",
        "", "formula_catalog.id", "FALSE", "TF-01"
    ],
    [
        "dim_title_formula", "formula_name", "string", "",
        "Tên định danh khái quát của công thức đóng gói tiêu đề.",
        "Quyết định giúp đội ngũ sáng tạo nội dung gọi tên và trao đổi nhanh về phong cách tiêu đề khi lên ý tưởng.",
        "", "formula_catalog.name", "FALSE", "POV First-Person Cinema"
    ],
    [
        "dim_title_formula", "template", "string", "",
        "Cấu trúc khung câu mẫu có chứa các biến số thay thế đặt trong dấu ngoặc vuông.",
        "Quyết định cung cấp khuôn mẫu điền từ tự động cho biên kịch khi đóng gói tiêu đề video mới.",
        "", "formula_catalog.template", "FALSE", "POV: You [Đạt thành tựu lớn] at [Độ tuổi] — [Nghịch lý / Sự thật]"
    ],
    [
        "dim_title_formula", "psych_mechanism", "string", "",
        "Cơ chế tâm lý cốt lõi mà công thức tiêu đề đánh vào để kích thích người dùng bấm vào xem.",
        "Quyết định căn chỉnh cảm xúc của tiêu đề khớp với tâm lý tò mò hoặc lo âu về địa vị của khán giả.",
        "", "formula_catalog.psychology", "FALSE", "Cảm giác thỏa mãn ngầm (Superiority), Tự do tối thượng, Sự tương phản mạnh mẽ với số đông xung quanh"
    ],
    [
        "dim_title_formula", "power_words", "string", "",
        "Tập hợp các từ khóa quyền lực có tỷ lệ click cao đặc trưng cho công thức này.",
        "Quyết định bổ sung các từ khóa giàu cảm xúc và hình ảnh vào tiêu đề để tối đa hóa CTR.",
        "", "formula_catalog.powerWords", "FALSE", "POV, Nobody Knows, Paid Off, Decades Left, Quietly"
    ],
    [
        "dim_title_formula", "production_note", "string", "",
        "Chỉ dẫn chi tiết dành cho biên kịch về cách ứng dụng và bối cảnh phù hợp của công thức.",
        "Quyết định hướng dẫn biên kịch triển khai nội dung video ăn khớp hoàn hảo với tiêu đề đã chọn.",
        "", "formula_catalog.note", "FALSE", "Dùng cho các kịch bản mang tính storytelling, miêu tả cảm giác sau khi đạt tự do tài chính, trả hết nợ hoặc nghỉ hưu sớm."
    ],
    [
        "dim_title_formula", "evidence_type", "enum", "",
        "Loại bằng chứng thực chứng của công thức gồm real|suggested.",
        "Quyết định phân loại công thức đã có bằng chứng video thật thành công trên thị trường (real) hay là công thức đề xuất thử nghiệm (suggested).",
        "", "manual_classification", "FALSE", "real"
    ],
    [
        "dim_title_formula", "evidence_video_id", "string", "",
        "Mã định danh video YouTube thật làm bằng chứng thành công cho công thức (bắt buộc có nếu evidence_type=real, để trống nếu suggested).",
        "Quyết định cung cấp liên kết kiểm chứng trực tiếp đến video thực tế đạt hiệu quả cao.",
        "", "youtube.video.id", "TRUE", "KqMZWAEmM1A"
    ],
    [
        "dim_title_formula", "evidence_title", "string", "",
        "Tiêu đề thực tế của video làm bằng chứng cho công thức.",
        "Quyết định đối chiếu cấu trúc tiêu đề thực tế với khuôn mẫu lý thuyết để đánh giá tính khả thi.",
        "", "youtube.video.snippet.title", "TRUE", "POV: You Retired at 40 — Nobody Knows"
    ],
    [
        "dim_title_formula", "evidence_channel", "string", "",
        "Tên kênh sở hữu video làm bằng chứng thực chứng.",
        "Quyết định xác định kênh tiên phong đã ứng dụng thành công công thức này.",
        "", "youtube.video.snippet.channelTitle", "TRUE", "POV Finance"
    ],
    [
        "dim_title_formula", "evidence_views", "integer", "views",
        "Số lượt xem của video bằng chứng (bắt buộc có nếu evidence_type=real, để trống nếu suggested).",
        "Quyết định đo lường quy mô tiếp cận thực tế chứng minh sức hút của công thức.",
        "", "youtube.video.statistics.viewCount", "TRUE", "88867"
    ],
    [
        "dim_title_formula", "evidence_outlier_ratio", "float", "ratio",
        "Tỷ lệ outlier của video bằng chứng so với trung vị kênh.",
        "Quyết định xác thực bằng chứng đạt chuẩn thành công vượt trội (>1.5x) chứ không chỉ ăn may nhờ kênh lớn.",
        "", "fact_video.outlier_ratio", "TRUE", "1.62"
    ],
    [
        "dim_title_formula", "source", "string", "",
        "Nguồn gốc đúc kết ra công thức tiêu đề.",
        "Quyết định lưu trữ nguồn gốc tư liệu phục vụ rà soát quy trình.",
        "", "system_provenance", "FALSE", "research_analysis"
    ],
    [
        "dim_title_formula", "collected_at", "date", "ISO_date",
        "Ngày đúc kết và cập nhật công thức theo chuẩn YYYY-MM-DD.",
        "Quyết định quản lý phiên bản và tuổi thọ của kho công thức sáng tạo.",
        "", "system_timestamp", "FALSE", "2026-09-18"
    ]
]

# =============================================================================
# 2. BUILD README (Provenance Block following Aswath Damodaran's margin.xls)
# =============================================================================
README_HEADER = ["field", "value"]

README_ROWS = [
    [
        "workbook_name",
        "POV Finance — YouTube Faceless Competitive Intelligence & Research Workbook"
    ],
    [
        "purpose",
        "Cung cấp cơ sở dữ liệu định lượng, kiểm toán được 100% về đối thủ, video bứt phá, từ khóa và mẫu hook/tiêu đề để ra quyết định sản xuất kênh YouTube faceless 'POV Finance' nhắm audience Mỹ."
    ],
    [
        "last_updated",
        "2026-09-18"
    ],
    [
        "universe_scope",
        "16 kênh hạt giống (seed channels) + kênh mẫu POV Finance + tập mở rộng các kênh faceless tài chính cá nhân nhắm thị trường Mỹ; lấy 30 video long-form gần nhất mỗi kênh (thời lượng >= 8 phút, loại bỏ Shorts); khoảng thời gian dữ liệu từ 2022 đến 18/09/2026."
    ],
    [
        "collection_method",
        "vidIQ API / MCP endpoint (vidiq_get_channels_by_ids, vidiq_channel_videos, vidiq_channel_stats, vidiq_keyword_research, vidiq_video_transcript) kết hợp trích xuất phụ đề YouTube có timestamp (yt-dlp auto-sub/sub) để đo nhịp đọc WPM và vị trí câu pivot."
    ],
    [
        "known_limitations",
        "Mẫu nghiên cứu là tập kênh ĐƯỢC PHÁT HIỆN và chọn lọc (discovered universe) trong ngách POV Finance, không đại diện cho toàn bộ 100% video tài chính trên YouTube."
    ],
    [
        "known_limitations",
        "Điểm vidiq_breakout_score là thuật toán hộp đen độc quyền của bên thứ ba, không thể tái lập hay kiểm toán được công thức từ dữ liệu gốc, chỉ được dùng làm tín hiệu cảnh báo sớm."
    ],
    [
        "known_limitations",
        "Một số cột dữ liệu phụ (như like_count, comment_count, country) có thể bị trống do API YouTube/vidIQ trả về null đối với video mới xuất bản hoặc kênh ẩn thông tin quốc gia."
    ],
    [
        "known_limitations",
        "Kênh seed @NolanFinance1 trả về HTTP 404 Not Found trên YouTube (kênh đã bị xoá, đổi handle hoặc bị phạt); toàn bộ các cột chỉ số được để trống để đảm bảo liêm chính dữ liệu."
    ],
    [
        "known_limitations",
        "Phân bổ lượt tìm kiếm địa lý từ vidIQ mang tính ước lượng tương đối dựa trên mẫu người dùng cài extension, không phải dữ liệu server-side cấp 1 (first-party) từ YouTube Studio."
    ],
    [
        "how_to_refresh",
        "Chạy script scripts/generate_seed_sheets.py và scripts/build_outlier_tsvs.py để lấy lại snapshot 30 video gần nhất, cập nhật lại trung vị kênh, tính toán lại rank_score và đẩy TSV vào thư mục inbox/ để hợp nhất."
    ],
    [
        "table_list",
        "dim_channel (24 cột), fact_video (24 cột), fact_keyword (12 cột), fact_hook (16 cột), dim_title_formula (14 cột)."
    ],
    [
        "primary_ranking_column",
        "rank_score (trong bảng fact_video) = outlier_ratio * log10(channel_median_views + 10). Cột này được chọn làm tiêu chí xếp hạng tối hậu thay cho outlier_ratio thuần túy nhằm triệt tiêu hiện tượng 'trúng số ảo' trên các kênh chết (kênh median < 500 views có 1 video viral đột biến), ưu tiên các chủ đề có sức hút vượt trội trên nền kênh đã được kiểm chứng nhu cầu (proven baseline >= 5000 views)."
    ],
    [
        "contact",
        "Codex Agent & Research Analyst (Terminal link: ed252e9c-70a5-404c-b406-d45b1f835efc, Workspace: makemoney/writer-room)."
    ]
]

def main():
    os.makedirs(INBOX_DIR, exist_ok=True)
    
    # Write _dictionary.tsv
    with open(DICT_PATH, "w", encoding="utf-8") as f:
        f.write("\t".join(DICT_HEADER) + "\n")
        for r in DICT_ROWS:
            f.write("\t".join(r) + "\n")
    print(f"Wrote {len(DICT_ROWS)} rows to {DICT_PATH}")

    # Write _readme.tsv
    with open(README_PATH, "w", encoding="utf-8") as f:
        f.write("\t".join(README_HEADER) + "\n")
        for r in README_ROWS:
            f.write("\t".join(r) + "\n")
    print(f"Wrote {len(README_ROWS)} rows to {README_PATH}")

if __name__ == "__main__":
    main()
