/**
 * Mock data for Spy Auto-Loop UI — enabled by ?mock=1 in URL.
 * This module is never imported at runtime unless the mock flag is active.
 */
import type {
  Topic,
  LoopStatus,
  InboxItem,
  Keyword,
  StoredReport,
  ReportSummaryJson,
  SpyLoopSettings,
} from '../../api.ts';

export const MOCK_TOPICS: Topic[] = [
  {
    topicId: 'finance-vi',
    label: 'Tài chính cá nhân VI',
    market: 'vi',
    language: 'vi',
    status: 'active',
    ownChannelIds: ['UC3pBgNay1YGUCvQmYMW6-lw'],
    briefMd: 'Kênh giải thích tài chính cá nhân bằng giọng kể chuyện, không lộ mặt.',
    facelessRequired: true,
    dailySearchBudget: 20,
    createdAt: '2026-08-20T00:00:00Z',
    updatedAt: '2026-08-20T08:00:00Z',
  },
];

export const MOCK_LOOP_STATUS: LoopStatus = {
  topicId: 'finance-vi',
  topicLabel: 'Tài chính cá nhân VI',
  topicStatus: 'active',
  lastTick: {
    tickId: 'tick-001',
    quotaDay: '2026-08-20',
    status: 'done',
    step: 'report',
    startedAt: '2026-08-20T08:30:00Z',
    finishedAt: '2026-08-20T08:47:12Z',
    error: null,
  },
  nextTickAt: '2026-08-21T08:30:00Z',
  inboxTotal: 43,
  shortlistedTotal: 12,
  studiedTotal: 3,
  keywordsPending: 7,
  quota: {
    searchUsed: 18,
    searchBudget: 20,
    searchRemainingDay: 82,
    generalUsed: 612,
    generalLimit: 10000,
  },
};

function thumbGrid(videoIds: string[]): string[] {
  return videoIds.map((vid) => `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`);
}

export const MOCK_INBOX_ITEMS: InboxItem[] = [
  {
    channelId: 'UC_mock_tien_khon',
    title: 'Tiền Khôn',
    handle: '@tienkhon',
    url: 'https://www.youtube.com/@tienkhon',
    thumbnails: thumbGrid(['dQw4w9WgXcQ', 'abc123def45', 'xyz789uvw12', 'lmn456opq78', 'rst012uvw34', 'aaa111bbb22']),
    subscriberCount: 84200,
    videoCount: 47,
    country: 'VN',
    publishedAt: '2025-09-10T00:00:00Z',
    medianViews: 123000,
    medianViewsVsOwn: 3.1,
    fitScore: 82,
    fitReasons: ['anchor match: tài chính × 8', 'prefer_longform đạt 90%', 'country: VN'],
    // P0: chưa có agent vision nào chấm → verdict null, chỉ có phỏng đoán từ chữ.
    facelessScore: null,
    facelessSignals: [],
    facelessHint: 0.91,
    facelessHintReasons: [
      'title khớp "giải thích" × 6',
      'mô tả có boilerplate stock footage (storyblocks)',
      'không có tín hiệu HOST (vlog / reaction / lộ mặt)',
    ],
    learnValueScore: 87,
    learnValueReasons: ['median view 3.1× Sói Tài Chính', 'sub/age: 84k/11 tháng', 'momentum tốt'],
    langDetected: 'vi',
    langConfidence: 0.97,
    langEvidence: {
      method: 'declared_fields', evidenceField: 'defaultAudioLanguage',
      declaredByField: { defaultAudioLanguage: 11, defaultLanguage: 0 },
      declaredCount: 11, sampleSize: 12, majority: 'vi',
      canJustifyRejection: true, summary: '11/12 video khai defaultAudioLanguage = vi',
    },
    foundVia: { relation: 'search_video', term: 'lãi kép', fromChannelId: null },
    status: 'new',
    decidedBy: null,
    decidedReason: null,
    decidedAt: null,
    firstSeenAt: '2026-08-20T08:35:00Z',
  },
  {
    channelId: 'UC_mock_co_may',
    title: 'Cỗ Máy Tài Chính',
    handle: '@comay_tc',
    url: 'https://www.youtube.com/@comay_tc',
    thumbnails: thumbGrid(['vid001vid001', 'vid002vid002', 'vid003vid003', 'vid004vid004']),
    subscriberCount: 31500,
    videoCount: 28,
    country: 'VN',
    publishedAt: '2025-12-01T00:00:00Z',
    medianViews: 55000,
    medianViewsVsOwn: 1.4,
    fitScore: 74,
    fitReasons: ['anchor match: tiết kiệm × 5', 'country: VN'],
    facelessScore: null,
    facelessSignals: [],
    facelessHint: 0.52,
    facelessHintReasons: ['title có "một ngày của mình" × 1 (tín hiệu HOST)', 'mẫu quá ít: 9 title'],
    learnValueScore: 62,
    learnValueReasons: ['median view 1.4× Sói Tài Chính', 'cadence đều 2 video/tuần'],
    langDetected: 'vi',
    langConfidence: 0.88,
    langEvidence: {
      method: 'title_heuristic', evidenceField: null,
      declaredByField: { defaultAudioLanguage: 1, defaultLanguage: 0 },
      declaredCount: 1, sampleSize: 9, majority: 'vi',
      canJustifyRejection: false,
      summary: 'đoán từ title → vi (1/9 video) — không dùng để reject',
    },
    foundVia: { relation: 'harvested_title', term: 'quản lý tiền bạc', fromChannelId: null },
    status: 'new',
    decidedBy: null,
    decidedReason: null,
    decidedAt: null,
    firstSeenAt: '2026-08-20T08:36:00Z',
  },
  {
    channelId: 'UC_mock_goc_nhin',
    title: 'Góc Nhìn Tài Chính',
    handle: '@gocnhintc',
    url: 'https://www.youtube.com/@gocnhintc',
    thumbnails: thumbGrid(['g1g1g1g1g1g', 'g2g2g2g2g2g']),
    subscriberCount: 18700,
    videoCount: 19,
    country: 'VN',
    publishedAt: '2026-01-15T00:00:00Z',
    medianViews: 28000,
    medianViewsVsOwn: 0.7,
    fitScore: 68,
    fitReasons: ['anchor match: đầu tư × 4'],
    // Không đủ mẫu văn bản → không hint, không verdict. UI phải nói "chưa xác định".
    facelessScore: null,
    facelessSignals: [],
    facelessHint: null,
    facelessHintReasons: [],
    learnValueScore: 44,
    learnValueReasons: ['median view 0.7× Sói Tài Chính — dưới baseline'],
    langDetected: null,
    langConfidence: null,
    langEvidence: {
      method: 'insufficient_sample', evidenceField: null, declaredByField: {},
      declaredCount: 0, sampleSize: 2, majority: null,
      canJustifyRejection: false,
      summary: 'không đủ mẫu để kết luận ngôn ngữ (0/2 video)',
    },
    foundVia: { relation: 'graph', term: null, fromChannelId: 'UC_mock_tien_khon' },
    status: 'new',
    decidedBy: null,
    decidedReason: null,
    decidedAt: null,
    firstSeenAt: '2026-08-20T08:37:00Z',
  },
];

export const MOCK_KEYWORDS: Keyword[] = [
  { topicId: 'finance-vi', termKey: 'tu-do-tai-chinh', displayTerm: 'tự do tài chính', relation: 'seed', status: 'searched', yieldChannels: 12, lastSearchedAt: '2026-08-20T08:31:00Z', addedAt: '2026-08-20T00:00:00Z', addedBy: 'user' },
  { topicId: 'finance-vi', termKey: 'lai-kep', displayTerm: 'lãi kép', relation: 'seed', status: 'searched', yieldChannels: 7, lastSearchedAt: '2026-08-20T08:32:00Z', addedAt: '2026-08-20T00:00:00Z', addedBy: 'user' },
  { topicId: 'finance-vi', termKey: 'bay-tieu-dung', displayTerm: 'bẫy tiêu dùng', relation: 'harvested_title', status: 'pending', yieldChannels: 0, lastSearchedAt: null, addedAt: '2026-08-20T08:47:00Z', addedBy: 'loop' },
  { topicId: 'finance-vi', termKey: 'no-tot-no-xau', displayTerm: 'nợ tốt nợ xấu', relation: 'harvested_title', status: 'pending', yieldChannels: 0, lastSearchedAt: null, addedAt: '2026-08-20T08:47:00Z', addedBy: 'loop' },
  { topicId: 'finance-vi', termKey: 'kiem-tien-online', displayTerm: 'kiếm tiền online', relation: 'seed', status: 'exhausted', yieldChannels: 1, lastSearchedAt: '2026-08-19T08:00:00Z', addedAt: '2026-08-19T00:00:00Z', addedBy: 'user' },
  { topicId: 'finance-vi', termKey: 'forex-signal', displayTerm: 'forex signal', relation: 'seed', status: 'rejected', yieldChannels: 0, lastSearchedAt: null, addedAt: '2026-08-20T00:00:00Z', addedBy: 'user' },
];

export const MOCK_REPORTS: StoredReport[] = [
  { reportId: 'rpt-001', reportDate: '2026-08-20', topicId: 'finance-vi', summary: null, markdown: '', createdAt: '2026-08-20T08:47:12Z', deliveredJson: { telegram: '2026-08-20T08:47:30Z' } },
  { reportId: 'rpt-000', reportDate: '2026-08-19', topicId: 'finance-vi', summary: null, markdown: '', createdAt: '2026-08-19T08:47:00Z', deliveredJson: { telegram: '2026-08-19T08:47:18Z', telegram_digest: '2026-08-20T08:00:05Z' } },
];

export const MOCK_REPORT_MARKDOWN = `📊 Spy Loop — Tài chính cá nhân VI — 2026-08-20

**Tick:** done · 08:30 → 08:47 (17 phút)
**Quota:** 18/20 search · 612/10000 unit

**Kênh mới:** 41 → auto-shortlist 6 · chờ duyệt 19 · auto-reject 16
**Inbox hiện tại:** 43 kênh

🔄 **So với hôm qua:** kênh mới 23 → 41 · Inbox 31 → 43 · Keyword pending 5 → 7

⭐ **Đáng học nhất**
1. Tiền Khôn — 84k sub, 11 tháng, median 123k view (3.1× Sói Tài Chính) · faceless? 91% (đoán từ chữ) · keyword: "lãi kép"
   → https://www.youtube.com/@tienkhon

🔑 **Keyword mới (2):** "bẫy tiêu dùng", "nợ tốt nợ xấu"
⚠ **Keyword exhausted:** "kiếm tiền online" (92% reject, 1 kênh)

👉 Duyệt: http://127.0.0.1:4187/#/spy/loop?topic=finance-vi
`;

export const MOCK_REPORT_SUMMARY: ReportSummaryJson = {
  version: 1,
  reportId: 'rpt-001',
  reportDate: '2026-08-20',
  topicId: 'finance-vi',
  topicLabel: 'Tài chính cá nhân VI',
  tick: { tickId: 'tick-001', status: 'done', startedAt: '2026-08-20T08:30:00Z', finishedAt: '2026-08-20T08:47:12Z', durationSec: 1032, error: null, dryRun: false },
  quota: { searchUsed: 18, searchBudget: 20, searchRemainingDay: 82, generalUsed: 612, generalLimit: 10000 },
  funnel: { expanded: 12, searched: 3, newCandidates: 41, autoShortlisted: 6, pendingReview: 19, autoRejected: 16, scanned: 0, keywordsHarvested: 2 },
  inboxTotal: 43,
  topLearn: [
    { channelId: 'UC_mock_tien_khon', title: 'Tiền Khôn', url: 'https://www.youtube.com/@tienkhon', subscriberCount: 84200, ageMonths: 11, medianViews: 123000, medianViewsVsOwn: 3.1, ownChannelTitle: 'Sói Tài Chính', facelessScore: null, fitScore: 82, learnValueScore: 87, foundVia: { relation: 'search_video', term: 'lãi kép' }, status: 'new', decidedBy: null, why: ['median view 3.1× Sói Tài Chính', '84k sub/11 tháng', 'faceless? 91% (đoán từ chữ, chưa có kết luận vision)'] },
  ],
  newKeywords: ['bẫy tiêu dùng', 'nợ tốt nợ xấu'],
  exhaustedKeywords: [{ term: 'kiếm tiền online', rejectRate: 0.92, yieldChannels: 1 }],
  scannedChannels: [],
  delta: {
    vsReportId: 'rpt-000', vsDate: '2026-08-19',
    newCandidatesPrev: 23, inboxTotalPrev: 31, shortlistedTotalPrev: 8, studiedTotalPrev: 3, keywordsPendingPrev: 5,
    firstSeenToday: ['UC_mock_tien_khon', 'UC_mock_co_may'],
    movedToShortlistToday: [],
    userDecisionsSinceLast: { shortlisted: 4, rejected: 9 },
    newlyExhausted: ['kiếm tiền online'],
  },
  warnings: [],
  links: { dashboard: 'http://127.0.0.1:4187/#/spy/loop?topic=finance-vi', mcpTool: 'spy_loop_report' },
};

export const MOCK_SETTINGS: SpyLoopSettings = {
  enabled: true,
  tickHourLocal: '15:30',
  digestHourLocal: '08:00',
  timezone: 'Asia/Ho_Chi_Minh',
  telegram: { chatId: '', enabled: false, botTokenSet: false },
};
