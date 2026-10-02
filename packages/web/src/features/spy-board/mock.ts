/**
 * Mock data cho Spy Board — chỉ được import động khi URL có ?mock=1.
 * Số liệu giả để review bố cục 4 màn (3 ngách, đủ ✅/⚠️/🆕, keyword bị khoá,
 * lượt chạy có mục bỏ qua).
 */
import type {
  AgentSelection,
  AgentTemplate,
  BoardAgentTask,
  BoardChannelRow,
  BoardEnvelope,
  BoardKeywordRow,
  BoardRunCard,
  BoardRunDetail,
  BoardScorecardRow,
  BoardVideoRow,
} from '../../api.ts';

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const day = (d: number) => new Date(now - d * 86_400_000).toISOString().slice(0, 10);

export function mockEnvelope<T>(data: T, sample = { channels: 0, videos: 0 }): BoardEnvelope<T> {
  return {
    data,
    dataAsOf: ago(3),
    runIds: ['tick-daily', 'run-1'],
    freshness: { lastTrackAt: ago(3), lastDiscoverAt: ago(49) },
    sample,
    limit: 50,
    truncated: false,
  };
}

function series(base: number, drift: number, missing = 0): BoardScorecardRow['history'] {
  return Array.from({ length: 28 }, (_, i) => ({
    day: day(27 - i),
    floorSmall: i < missing ? null : Math.round(base + drift * i + ((i * 37) % 11) * base * 0.01),
  }));
}

export const MOCK_SCORECARD: BoardScorecardRow[] = [
  {
    niche: 'side-hustle', floorSmall: 4_150, floorSmall7dAgo: 3_600, nSmallChannels: 23, nSmallVideos: 410,
    repeat: { total: 6, reliable: 3, thin: 2, niche: 1 }, outliers28d: 14,
    stop: { ready: true, smallMeasured: 23, need: 20, rankStableDays: 15 }, history: series(3_200, 34),
  },
  {
    niche: 'debt-payoff', floorSmall: 2_300, floorSmall7dAgo: 2_450, nSmallChannels: 14, nSmallVideos: 205,
    repeat: { total: 3, reliable: 1, thin: 1, niche: 1 }, outliers28d: 6,
    stop: { ready: false, smallMeasured: 14, need: 20, rankStableDays: 15 }, history: series(2_500, -7),
  },
  {
    niche: 'retire-early', floorSmall: 1_150, floorSmall7dAgo: null, nSmallChannels: 6, nSmallVideos: 71,
    repeat: { total: 1, reliable: 0, thin: 0, niche: 1 }, outliers28d: 2,
    stop: { ready: false, smallMeasured: 6, need: 20, rankStableDays: 15 }, history: series(1_000, 6, 12),
  },
  {
    niche: null, floorSmall: 900, floorSmall7dAgo: 880, nSmallChannels: 3, nSmallVideos: 40,
    repeat: { total: 0, reliable: 0, thin: 0, niche: 0 }, outliers28d: 0,
    stop: { ready: false, smallMeasured: 3, need: 20, rankStableDays: 3 }, history: series(880, 1),
  },
];

const v = (
  id: string, title: string, ch: string, subs: number, views: number, x: number | null,
  tier: BoardVideoRow['tier'], ageDays: number, extra: Partial<BoardVideoRow> = {},
): BoardVideoRow => ({
  videoId: id, title, thumbnailUrl: null, channelId: `UC${ch}`, channelTitle: ch, subs,
  channelAgeDays: 120, niche: 'side-hustle', views, velocity24h: Math.round(views / Math.max(ageDays, 1)),
  publishedAt: ago(ageDays * 24), videoAgeDays: ageDays, outlierX: x, tier,
  baselineViews: x ? Math.round(views / x) : null, baselineN: tier === 'thin' ? 5 : 22,
  isOutlier: ageDays >= 7 && (x ?? 0) >= 3, isRising: ageDays < 7, foundByKeyword: 'side hustle ideas',
  ...extra,
});

export const MOCK_VIDEOS: BoardVideoRow[] = [
  v('dQw4w9WgXcQ', 'I Tried 7 Side Hustles for 30 Days — Real Numbers', 'Quiet Money', 6_200, 184_000, 22.4, 'reliable', 12),
  v('M7lc1UVf-VE', 'The $0 Side Hustle Nobody Talks About (POV)', 'Tiny Ledger', 2_100, 61_000, 18.46, 'thin', 9, { baselineN: 4, channelAgeDays: 64 }),
  v('aqz-KE-bpKQ', 'I Was Drowning in Debt. This Spreadsheet Saved Me', 'New Start Co', 800, 45_000, 11.0, 'niche', 15, { channelAgeDays: 21, baselineN: 410 }),
  v('ScMzIvxBSi4', 'How I Made $1,200 Reselling Thrift Finds', 'Flip Diary', 9_400, 22_000, 4.2, 'reliable', 20),
  v('jNQXAC9IVRw', 'My Honest Etsy Month 3 Report', 'Quiet Money', 6_200, 12_000, 3.1, 'reliable', 26),
  v('9bZkp7q19f0', 'Day 4 of Building a $100/day Side Hustle', 'Tiny Ledger', 2_100, 14_500, 5.8, 'thin', 3, { baselineN: 4 }),
  v('kJQP7kiw5Fk', 'Why Everyone Is Quitting Dropshipping (Data)', 'Flip Diary', 9_400, 9_800, 1.9, 'reliable', 2),
];

export const MOCK_CHANNELS: BoardChannelRow[] = [
  { channelId: 'UCQuiet Money', title: 'Quiet Money', subs: 6_200, isSmall: true, channelAgeDays: 410, niche: 'side-hustle', state: 'following', verdict: null, baselineViews: 8_200, baselineN: 28, tier: 'reliable', dead: false, outliers28d: 2, bestOutlierX: 22.4 },
  { channelId: 'UCTiny Ledger', title: 'Tiny Ledger', subs: 2_100, isSmall: true, channelAgeDays: 64, niche: 'side-hustle', state: 'measured', verdict: 'proposed', baselineViews: 3_300, baselineN: 5, tier: 'thin', dead: false, outliers28d: 1, bestOutlierX: 18.46 },
  { channelId: 'UCNew Start Co', title: 'New Start Co', subs: 800, isSmall: true, channelAgeDays: 21, niche: 'side-hustle', state: 'measured', verdict: 'unreliable', baselineViews: null, baselineN: 1, tier: null, dead: false, outliers28d: 1, bestOutlierX: 11 },
  { channelId: 'UCFlip Diary', title: 'Flip Diary', subs: 9_400, isSmall: true, channelAgeDays: 900, niche: 'side-hustle', state: 'pending', verdict: 'proposed', baselineViews: 5_200, baselineN: 30, tier: 'reliable', dead: false, outliers28d: 1, bestOutlierX: 4.2 },
  { channelId: 'UCSleepy', title: 'Sleepy Coins', subs: 3_000, isSmall: true, channelAgeDays: 300, niche: 'side-hustle', state: 'measured', verdict: 'dead', baselineViews: 210, baselineN: 14, tier: 'reliable', dead: true, outliers28d: 0, bestOutlierX: null },
];

export const MOCK_KEYWORDS: BoardKeywordRow[] = [
  { termKey: 'side_hustle_ideas', term: 'side hustle ideas', niche: 'side-hustle', status: 'active', lastCheckedAt: ago(30), lockedUntil: ago(-42), lastNResults: 50, lastNNew: 18, newRate: 0.36, nChecks: 3, outliersFound: 5 },
  { termKey: 'make_money_online_2026', term: 'make money online 2026', niche: 'side-hustle', status: 'active', lastCheckedAt: ago(24 * 5), lockedUntil: null, lastNResults: 50, lastNNew: 3, newRate: 0.06, nChecks: 4, outliersFound: 1 },
  { termKey: 'reselling_thrift', term: 'reselling thrift', niche: 'side-hustle', status: 'active', lastCheckedAt: null, lockedUntil: null, lastNResults: null, lastNNew: null, newRate: null, nChecks: 0, outliersFound: 0 },
  { termKey: 'debt_snowball', term: 'debt snowball', niche: 'debt-payoff', status: 'active', lastCheckedAt: ago(24 * 4), lockedUntil: null, lastNResults: 48, lastNNew: 20, newRate: 0.42, nChecks: 2, outliersFound: 3 },
  { termKey: 'fire_movement', term: 'FIRE movement', niche: 'retire-early', status: 'pending', lastCheckedAt: null, lockedUntil: null, lastNResults: null, lastNNew: null, newRate: null, nChecks: 0, outliersFound: 0 },
];

export const MOCK_RUNS: BoardRunCard[] = [
  { runId: 'tick-daily', source: 'loop_tick', type: 'track', niche: null, note: 'Theo dõi hằng ngày (tự động)', triggeredBy: 'loop', status: 'done', startedAt: ago(3.2), finishedAt: ago(3), nItems: null, itemsDone: null, searchCalls: 0, units: 38, nNew: null, nSkipped: null, newChannels: 0, error: null },
  { runId: 'run-1', source: 'keyword_run', type: 'discover', niche: 'side-hustle', note: 'Tìm kênh nhỏ đang lên', triggeredBy: 'human', status: 'done', startedAt: ago(49.2), finishedAt: ago(49), nItems: 12, itemsDone: 12, searchCalls: 10, units: 41, nNew: 143, nSkipped: 2, newChannels: 4, error: null },
  { runId: 'run-0', source: 'keyword_run', type: 'discover', niche: 'debt-payoff', note: null, triggeredBy: 'human', status: 'skipped_quota', startedAt: ago(98), finishedAt: ago(97.8), nItems: 8, itemsDone: 8, searchCalls: 5, units: 20, nNew: 61, nSkipped: 0, newChannels: 1, error: null },
];

export const MOCK_DEEPDIVE_CARD: BoardRunCard = {
  runId: 'run-dd', source: 'keyword_run', type: 'deepdive', niche: 'side-hustle',
  note: 'Đào comment + transcript các outlier tiêu biểu', triggeredBy: 'human', status: 'done',
  startedAt: ago(20), finishedAt: ago(19.8), nItems: 3, itemsDone: 3, searchCalls: 0, units: 9,
  nNew: 2, nSkipped: 1, newChannels: 0, error: null,
};

export const MOCK_DEEPDIVE_DETAIL: BoardRunDetail = {
  card: MOCK_DEEPDIVE_CARD,
  items: [
    { target: 'dQw4w9WgXcQ', status: 'done', nResults: 138, nNew: 1, medianViews: null, outliersFound: null, skipReason: 'transcript_present', error: null },
    { target: 'M7lc1UVf-VE', status: 'done', nResults: 43, nNew: 1, medianViews: null, outliersFound: null, skipReason: null, error: 'transcript: spy video completed, không có caption' },
    { target: 'aqz-KE-bpKQ', status: 'skipped_dedup', nResults: 0, nNew: 0, medianViews: null, outliersFound: null, skipReason: 'comments_present,transcript_present', error: null },
  ],
};

export const MOCK_RUN_DETAIL: BoardRunDetail = {
  card: MOCK_RUNS[1]!,
  items: [
    { target: 'side_hustle_ideas', status: 'done', nResults: 50, nNew: 18, medianViews: 21_000, outliersFound: 3, skipReason: null, error: null },
    { target: 'make_money_online_2026', status: 'skipped_dedup', nResults: null, nNew: null, medianViews: null, outliersFound: null, skipReason: `searched_at:${ago(30)}`, error: null },
    { target: 'passive_income_ideas', status: 'done', nResults: 50, nNew: 4, medianViews: 88_000, outliersFound: 0, skipReason: null, error: null },
  ],
};

// ── Phiếu việc agent ────────────────────────────────────────────────────────

const TEMPLATE_LABEL: Record<AgentTemplate, string> = {
  compare_niches: 'So sánh tệp',
  outlier_patterns: 'Phân tích outlier',
  audience_pains: 'Nỗi đau khán giả',
  keyword_ideas: 'Đề xuất keyword',
  next_steps: 'Lượt tiếp theo',
};

const SUBMIT_EXAMPLE: Record<AgentTemplate, string> = {
  compare_niches: '{ "ranking": [{ "niche": "<group_key>", "verdict": "choose|maybe|drop", "reason": "…" }], "pick": null, "missingEvidence": ["…"] }',
  outlier_patterns: '{ "patterns": [{ "name": "…", "description": "…", "videoIds": ["<video_id>"] }], "titleTemplates": ["…"] }',
  audience_pains: '{ "pains": [{ "pain": "…", "frequency": "high|medium|low", "quotes": [{ "videoId": "<video_id>", "text": "…" }] }], "questions": ["…"] }',
  keyword_ideas: '{ "stop": [{ "termKey": "<term_key>", "reason": "…" }], "try": [{ "term": "…", "reason": "…", "evidenceVideoIds": ["<video_id>"] }] }',
  next_steps: '{ "discover": [{ "termKey": "<term_key>", "reason": "…", "priority": 1 }], "deepdive": [], "follow": [] }',
};

/** Prompt giả nhưng đúng dạng server soạn: prompt_id, danh sách ID, dòng spy_board_submit. */
export function mockPromptText(promptId: string, template: AgentTemplate, niche: string | null | undefined, selection: AgentSelection, note: string | null): string {
  const nicheArg = niche === undefined ? null : niche === null ? '_none' : niche;
  const lines = [
    `[Spy Board · phiếu ${promptId} · ${TEMPLATE_LABEL[template]}]`,
    `Topic: finance-vi${nicheArg ? ` · Ngách: ${nicheArg}${nicheArg === '_none' ? ' (chưa gán)' : ''}` : ''}`,
  ];
  if (selection.niches?.length) lines.push(`Ngách đã chọn: ${selection.niches.map((n) => n ?? '_none').join(', ')}`);
  if (selection.videoIds?.length) lines.push(`Video đã chọn (${selection.videoIds.length}): ${selection.videoIds.join(', ')}`);
  if (selection.termKeys?.length) lines.push(`Keyword đã chọn (${selection.termKeys.length}): ${selection.termKeys.join(', ')}`);
  if (note) lines.push(`Ghi chú của người dùng: ${note}`);
  lines.push(
    '',
    'Dùng MCP Writer Room Spy (tool spy_board_*). Gọi spy_board_metrics trước để hiểu đúng định nghĩa chỉ số.',
    '(mock) Việc cần làm: đọc dữ liệu bằng spy_board_scorecard / spy_board_videos / spy_board_keywords rồi đề xuất.',
    '',
    `Kết thúc: gọi spy_board_submit với prompt_id="${promptId}" và result đúng khuôn JSON sau (không thêm trường):`,
    SUBMIT_EXAMPLE[template],
  );
  return lines.join('\n');
}

const task = (
  promptId: string, template: AgentTemplate, niche: string | null, selection: AgentSelection,
  hoursAgo: number, note: string | null, result: BoardAgentTask['result'],
): BoardAgentTask => ({
  promptId, topicId: 'finance-vi', template, label: TEMPLATE_LABEL[template], niche, selection, note,
  promptText: mockPromptText(promptId, template, template === 'compare_niches' ? undefined : niche, selection, note),
  status: result ? 'submitted' : 'pending',
  createdAt: ago(hoursAgo),
  result,
  submittedBy: result ? 'claude-code' : null,
  submittedAt: result ? ago(hoursAgo - 0.2) : null,
});

export const MOCK_TASKS: BoardAgentTask[] = [
  task('p_a1b2c3d4e5f6', 'next_steps', 'side-hustle', { termKeys: ['make_money_online_2026'] }, 0.5, 'Ưu tiên tăng cỡ mẫu kênh nhỏ', null),
  task('p_10a1b2c3d4e5', 'compare_niches', null, { niches: ['side-hustle', 'debt-payoff', 'retire-early'] }, 5, 'Chọn tệp để làm 5 video đầu', {
    ranking: [
      { niche: 'side-hustle', verdict: 'choose', reason: 'Sàn view 4.150, 23 kênh nhỏ, 6 kênh outlier khác nhau (3 tin cậy), đủ luật dừng.' },
      { niche: 'debt-payoff', verdict: 'maybe', reason: 'Sàn 2.300 nhưng mới 14/20 kênh nhỏ, sàn giảm 6% so với tuần trước.' },
      { niche: 'retire-early', verdict: 'drop', reason: 'Chỉ 6 kênh nhỏ, 1 kênh lặp outlier, chưa đủ bằng chứng.' },
    ],
    pick: 'side-hustle',
    missingEvidence: ['debt-payoff cần thêm 6 kênh nhỏ để đạt luật dừng', 'retire-early chưa có outlier nào ở kênh có mức thường tin cậy'],
  }),
  task('p_20b2c3d4e5f6', 'outlier_patterns', 'side-hustle', { videoIds: ['dQw4w9WgXcQ', 'M7lc1UVf-VE', 'aqz-KE-bpKQ'] }, 26, null, {
    patterns: [
      { name: 'Thử thách có con số', description: 'Tiêu đề nêu số ngày/số tiền và cam kết "Real Numbers"; kể theo nhật ký, lặp ở kênh khác nhau.', videoIds: ['dQw4w9WgXcQ', 'M7lc1UVf-VE'] },
      { name: 'Cứu tinh từ nợ nần', description: 'Mở bằng nỗi đau (nợ) rồi giới thiệu công cụ đơn giản như phao cứu sinh.', videoIds: ['aqz-KE-bpKQ'] },
    ],
    titleTemplates: ['I Tried {X} for 30 Days — Real Numbers', 'The $0 {X} Nobody Talks About', 'I Was Drowning in {Y}. This {Z} Saved Me'],
  }),
  task('p_30c3d4e5f6a1', 'audience_pains', 'side-hustle', { videoIds: ['dQw4w9WgXcQ', 'ScMzIvxBSi4'] }, 30, 'Chỉ 2 video đã đào sâu', {
    pains: [
      { pain: 'Không biết bắt đầu side hustle nào khi chỉ có 1–2 giờ mỗi ngày', frequency: 'high', quotes: [
        { videoId: 'dQw4w9WgXcQ', text: 'I only have an hour after work, which one of these would you pick first?' },
        { videoId: 'ScMzIvxBSi4', text: 'Where do you even start when you have zero budget?' },
      ] },
      { pain: 'Nghi ngờ số liệu thu nhập có thật hay không', frequency: 'medium', quotes: [
        { videoId: 'dQw4w9WgXcQ', text: 'Do you have screenshots of the payouts or is this estimated?' },
      ] },
    ],
    questions: ['Cần bao nhiêu vốn ban đầu?', 'Thuế xử lý thế nào với thu nhập phụ?'],
  }),
  task('p_40d4e5f6a1b2', 'keyword_ideas', 'side-hustle', { termKeys: ['side_hustle_ideas', 'make_money_online_2026'] }, 50, null, {
    stop: [{ termKey: 'make_money_online_2026', reason: 'Tỉ lệ mới chỉ 6% sau 4 lần search, chỉ ra 1 outlier — đã cạn.' }],
    try: [
      { term: 'side hustle with no money', reason: 'Nhiều tiêu đề outlier nhấn mạnh vốn $0.', evidenceVideoIds: ['M7lc1UVf-VE'] },
      { term: 'side hustle real numbers', reason: 'Cụm "Real Numbers" lặp ở outlier 22x.', evidenceVideoIds: ['dQw4w9WgXcQ'] },
    ],
  }),
  task('p_50e5f6a1b2c3', 'next_steps', 'side-hustle', { termKeys: ['side_hustle_ideas'] }, 74, null, {
    discover: [{ termKey: 'reselling_thrift', reason: 'Chưa từng search, cùng ngách với outlier 4.2x của Flip Diary.', priority: 1 }],
    deepdive: [
      { videoId: 'dQw4w9WgXcQ', reason: 'Outlier 22.4x, kênh 6.2k subs, mức thường tin cậy.', priority: 1 },
      { videoId: 'M7lc1UVf-VE', reason: 'Outlier 18.5x nhưng mẫu mỏng — cần thêm dữ liệu.', priority: 2 },
    ],
    follow: [{ channelId: 'UCTiny Ledger', reason: 'Kênh 64 ngày tuổi đã có outlier 18x.' }],
  }),
];

export function mockCreateTask(template: AgentTemplate, niche: string | null | undefined, selection: AgentSelection, note: string | undefined): { promptId: string; promptText: string } {
  const promptId = `p_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  const t = task(promptId, template, niche ?? null, selection, 0, note?.trim() || null, null);
  t.promptText = mockPromptText(promptId, template, niche, selection, t.note);
  MOCK_TASKS.unshift(t);
  return { promptId, promptText: t.promptText };
}

// ── Mock báo cáo verify công thức (schema v1) — màn Công thức ───────────
import type { BoardFormulasReport } from '../../api.ts';

export const MOCK_FORMULAS: BoardFormulasReport = {
  reportType: 'formula_verify',
  schemaVersion: 1,
  meta: {
    topicId: 'finance-us',
    runId: '4146d0ae-ca2a-4a8d-9ff0-a58bb96cd976',
    date: '2026-10-01',
    verifyRule: "sống = ≥3 kênh độc lập lặp skeleton, ≥1 kênh <10K subs",
    cost: { searches: 22, channelUnits: 123 },
    yield: { videos: 2056, channelsProposed: 13, channelsRejected: 4 },
  },
  formulas: [
    {
      id: 'F-A',
      skeleton: 'How Are [GROUP] Affording [$ASSET] on [$INCOME]?',
      verdict: 'live',
      repeatability: { channels_lt10k: 2, channels_10_50k: 1, channels_gt50k: 1, proof: 'Nate 5.8K chạy 12 video/tháng cùng skeleton' },
      packaging: ['How Are Americans Affording $600K Homes on Average Salaries?'],
      slots: {
        trigger: { rotating: true, desc: 'Kỷ lục giá/sốc giá vừa xảy ra', examples: ['giá nhà $600K', 'daycare $2,000/tháng'] },
        visible_behavior: { rotating: true, desc: 'Nhóm người người xem thấy ngoài đời', examples: ['Americans', 'Uber Drivers', 'Gen Z', 'Retirees'] },
        contradiction: { rotating: false, desc: 'Giá tài sản >> thu nhập trung bình' },
        mechanism: { rotating: false, desc: '84–96 tháng nợ, hai thu nhập, tiền gia đình — LÕI bền' },
        title_render: 'Biến nghịch lý "giá cao mà vẫn mua được" thành câu hỏi How',
      },
      evidence: [
        { channel: 'American Finance With Nate', subs: 5800, videos: 12, topViews: 325_000, note: 'series slot-filling', lastSeen: '2026-09-30' },
        { channel: 'Wealth Logic', subs: 94_600, videos: 1, topViews: 1_100_000, note: 'kênh gốc công thức' },
      ],
    },
    {
      id: 'F-E',
      skeleton: 'Why [X] Became So Expensive',
      verdict: 'rejected',
      reject_reason: 'Chỉ kênh >140K subs ăn — tệp kênh lớn, kênh nhỏ khớp pattern là clip/meme.',
      slots: {
        trigger: { rotating: true, desc: 'Tin giá tăng' },
        contradiction: { rotating: false, desc: 'Thứ quen thuộc thành xa xỉ' },
      },
      evidence: [{ channel: 'Front Page', subs: 142_000, topViews: 335_000 }],
    },
  ],
  keywordHealth: [
    { term: 'how are americans affording', medianViews: 55_000, outliers: 4, note: 'sống' },
    { term: 'secretly living paycheck', medianViews: 173, note: 'n-gram bị giải trí chiếm' },
  ],
  modelChannels: [
    { channel: 'American Finance With Nate', subs: 5_800, why: 'F-A series ở <10K' },
    { channel: 'Cartor Raay', subs: 7_200, why: 'F-B + F-D' },
  ],
  nextActions: [
    { type: 'title_draft', from: 'F-A', title: 'How Are Americans Affording $2,000 Daycare on Average Salaries?' },
    { type: 'follow_channel', item: 'Too Late Now (18K) — cloner hệ thống F-B/C' },
  ],
};
