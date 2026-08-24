> **PART A SUPERSEDED 2026-08-21** — user quyết **bỏ hoàn toàn vidIQ** khỏi plan và code: mục tiêu của dự án là THAY THẾ vidIQ, nên không phụ thuộc nó kể cả để gieo hạt. Cold start thay bằng `seedChannelIds` + nạp corpus sẵn có + graph expansion. Còn hiệu lực: **Part B (thuật toán harvest keyword tiếng Việt)** và **Part C (seed đa ngôn ngữ)**. Riêng channelId kênh nhà `UC3pBgNay1YGUCvQmYMW6-lw` cần xác nhận lại qua `channels.list` với handle `@soitaichinh247`.

KEY FINDINGS r-seeding
- Sói Tài Chính channelId UC3pBgNay1YGUCvQmYMW6-lw (@soitaichinh247), 2,590 subs, 33 videos, avgViews 6.5k, long-form ~1000s, created 2026-06-22.
- vidIQ: 5 credits/call; balance 313 add-on (renewable 0 until 2026-09-04). similar_channels -> 30 VI channels, ~20 on-topic (Tiền Khôn, Cỗ Máy Tài Chính, Góc Nhìn Tài Chính, Chú Hai/Ông Chú/Chú Béo Tài Chính, Tư Duy Tinh Hoa, Quý Đầu Tư, Tư Duy Giàu Có; anchors Cú Thông Thái 409k, Tài chính & Kinh doanh 536k). isFaceless null for all -> need own classifier.
- keyword_research "tự do tài chính": related list (tài chính cá nhân, quản lý tài chính cá nhân, tư duy tài chính, thu nhập thụ động, tư duy làm giàu, kiến thức tài chính, quản lý tiền bạc, đầu tư thông minh, tư duy triệu phú, unaccented variant). Drift: phát triển bản thân, bí quyết thành công, tài chính, đầu tư, kiếm tiền.
- Policy: vidIQ one-shot per topic, user-confirmed, cap 25 credits, estimated_external label, separate term_external_estimates table, no daily step.
- Harvest algorithm: VI syllable n-grams 2-4, edge stopwords, field weights title x3 tags x2 desc x1 chapters x2; df_chan>=2; drift_ok = co-occur with anchorTerms in a title; score = 40*df_chan/5 + 25*spec + 20*perf + 15*novelty; longer n-gram wins dedupe. Comment question mining patterns vi/en/es/id.
- Topic JSON additions: anchorTerms, preferLongform; relation 'seed_external'. ja needs morphological tokenizer.
- Multilingual seeds drafted for en/es/pt-BR/id/hi/ja (in agent memo). P1 order: en then id.
- ADR-AL-5: finance-vi start 20 search/day; 20 SERP; 10 manual; 50 reserve. Keyword order: seeds -> comment_mined -> harvested by df_chan -> re-search top yield <=20%.
