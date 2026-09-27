/**
 * News radar: groups recent videos from followed channels into event clusters
 * and applies the "type 3 / event-driven title" rule:
 *   >= minVideos videos from >= minChannels channels within windowDays, each with VPH >= minVph.
 *
 * Pure and deterministic (no store, no provider) so the rule is testable with fixtures.
 * VPH here is lifetime VPH: views / hours between publish and the sample that measured them.
 */

export interface RadarVideo {
  videoId: string;
  channelId: string;
  channelTitle: string | null;
  title: string;
  /** ISO datetime, or YYYY-MM-DD when the provider only exposes the upload day. */
  publishedAt: string;
  views: number;
  sampledAt: string;
}

export interface NewsRadarOptions {
  now: Date;
  windowDays?: number;
  minVideos?: number;
  minChannels?: number;
  minVph?: number;
  maxClusters?: number;
  maxEvidencePerCluster?: number;
  /** Extra channel-specific filler words to ignore (lowercase). */
  ignoreTerms?: string[];
}

export interface RadarEvidence {
  videoId: string;
  url: string;
  channelId: string;
  channelTitle: string | null;
  title: string;
  publishedAt: string;
  publishedAtPrecision: 'time' | 'day';
  ageHours: number;
  views: number;
  vph: number;
}

export interface RadarCluster {
  clusterId: string;
  label: string;
  terms: string[];
  /** qualified = passes the type-3 rule; emerging = seen on >= 2 channels but not yet enough. */
  status: 'qualified' | 'emerging';
  channelCount: number;
  videoCount: number;
  qualifyingChannelCount: number;
  qualifyingVideoCount: number;
  topVph: number;
  sumVph: number;
  firstPublishedAt: string;
  newestPublishedAt: string;
  /** Newest video in the cluster + 72h: the type-3 window to publish while the event is hot. */
  postBy: string;
  evidence: RadarEvidence[];
}

export interface NewsRadarResult {
  generatedAt: string;
  rule: {
    windowDays: number;
    minVideos: number;
    minChannels: number;
    minVph: number;
    vphDefinition: string;
  };
  videosInWindow: number;
  channelsInWindow: number;
  clusters: RadarCluster[];
}

const HOUR_MS = 3_600_000;
const POST_WINDOW_HOURS = 72;

/** Words that never carry an event on their own (EN + VI function words, title filler). */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'for', 'from', 'by', 'with', 'about',
  'into', 'over', 'after', 'before', 'under', 'up', 'down', 'out', 'off', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'what', 'why', 'how', 'when', 'who', 'which',
  'where', 'will', 'would', 'can', 'could', 'should', 'do', 'does', 'did', 'done', 'has', 'have', 'had', 'you',
  'your', 'yours', 'we', 'our', 'they', 'their', 'them', 'he', 'she', 'his', 'her', 'i', 'me', 'my', 'us', 'not',
  'no', 'so', 'just', 'now', 'here', 'there', 'than', 'then', 'too', 'very', 'all', 'more', 'most', 'every',
  'any', 'some', 'only', 'even', 'still', 'really', 'actually', 'finally', 'officially', 'again', 'new', 'next',
  'get', 'got', 'going', 'gonna', 'make', 'makes', 'need', 'know', 'things', 'thing', 'way', 'ways', 'nobody',
  'everyone', 'anyone', 'people', 'don', 't', 's', 're', 've', 'll', 'vs', 'ft',
  'và', 'của', 'là', 'có', 'không', 'những', 'các', 'một', 'cho', 'với', 'này', 'đó', 'khi', 'thì', 'mà', 'để',
  'được', 'bị', 'đã', 'sẽ', 'đang', 'rất', 'vì', 'sao', 'tại', 'gì', 'bạn', 'tôi', 'mình', 'ai', 'nào',
]);

/** Domain words too broad to name an event alone; still allowed inside a two-word term. */
const GENERIC_WORDS = new Set([
  'money', 'finance', 'financial', 'finances', 'invest', 'investing', 'investment', 'investor', 'investors',
  'stock', 'stocks', 'market', 'markets', 'economy', 'economic', 'rich', 'wealth', 'wealthy', 'millionaire',
  'broke', 'budget', 'save', 'saving', 'savings', 'dollar', 'dollars', 'price', 'prices', 'cost', 'costs',
  'americans', 'american', 'america', 'us', 'usa', 'year', 'years', 'month', 'months', 'week', 'today', 'day',
  'breaking', 'news', 'update', 'warning', 'huge', 'big', 'massive', 'crazy', 'shocking', 'truth', 'real',
  'math', 'explained', 'video', 'watch', 'live', 'podcast', 'episode', 'full', 'guide', 'tips', 'mistakes',
  // Headline verbs/adjectives: they say something moved, not what moved.
  'hit', 'hits', 'getting', 'gets', 'change', 'changes', 'changing', 'official', 'risk', 'problem', 'problems',
  'rise', 'rising', 'fall', 'falling', 'drop', 'dropping', 'soaring', 'surge', 'crushed', 'struggling', 'generation',
  '2024', '2025', '2026', '2027', 'tiền', 'tài', 'chính', 'đầu', 'tư', 'năm', 'tháng',
]);

function isEligibleWord(word: string, ignore: ReadonlySet<string>): boolean {
  return !FUNCTION_WORDS.has(word) && !ignore.has(word);
}

function tokenize(title: string): string[] {
  return title.normalize('NFC').toLowerCase().match(/[$]?[\p{L}\p{N}]+(?:[.,]\d+)?%?/gu) ?? [];
}

/** Unigrams (non-generic) and bigrams of neighbours once function words are dropped ("Fed Just Raised" → "fed raised"). */
export function titleTerms(title: string, ignore: ReadonlySet<string> = new Set()): Set<string> {
  const words = tokenize(title).filter((word) => isEligibleWord(word, ignore));
  const terms = new Set<string>();
  words.forEach((word, i) => {
    if (!GENERIC_WORDS.has(word) && (word.length >= 3 || /\d/.test(word))) terms.add(word);
    const next = words.at(i + 1);
    if (next !== undefined && !(GENERIC_WORDS.has(word) && GENERIC_WORDS.has(next))) terms.add(`${word} ${next}`);
  });
  return terms;
}

function publishedMs(publishedAt: string): { ms: number; precision: 'time' | 'day' } | null {
  const precision = /^\d{4}-\d{2}-\d{2}$/.test(publishedAt) ? 'day' : 'time';
  const ms = Date.parse(precision === 'day' ? `${publishedAt}T00:00:00Z` : publishedAt);
  return Number.isFinite(ms) ? { ms, precision } : null;
}

function toEvidence(video: RadarVideo, now: Date): RadarEvidence | null {
  const published = publishedMs(video.publishedAt);
  const sampled = Date.parse(video.sampledAt);
  if (!published || !Number.isFinite(sampled)) return null;
  const hoursAtSample = Math.max(1, (sampled - published.ms) / HOUR_MS);
  return {
    videoId: video.videoId,
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    title: video.title,
    publishedAt: video.publishedAt,
    publishedAtPrecision: published.precision,
    ageHours: Math.round(Math.max(0, now.getTime() - published.ms) / HOUR_MS),
    views: video.views,
    vph: Math.round(video.views / hoursAtSample),
  };
}

function slug(term: string): string {
  return term.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'cluster';
}

export function buildNewsRadar(videos: readonly RadarVideo[], options: NewsRadarOptions): NewsRadarResult {
  const windowDays = options.windowDays ?? 7;
  const minVideos = options.minVideos ?? 3;
  const minChannels = options.minChannels ?? 3;
  const minVph = options.minVph ?? 100;
  const maxClusters = options.maxClusters ?? 10;
  const maxEvidence = options.maxEvidencePerCluster ?? 8;
  const ignore = new Set((options.ignoreTerms ?? []).map((term) => term.toLowerCase()));
  const windowStart = options.now.getTime() - windowDays * 24 * HOUR_MS;

  // Latest sample per video wins; one video can appear across several observation runs.
  const latestById = new Map<string, RadarVideo>();
  for (const video of videos) {
    const current = latestById.get(video.videoId);
    if (!current || video.sampledAt > current.sampledAt) latestById.set(video.videoId, video);
  }
  const pool: RadarEvidence[] = [];
  for (const video of latestById.values()) {
    const published = publishedMs(video.publishedAt);
    if (!published || published.ms < windowStart) continue;
    const evidence = toEvidence(video, options.now);
    if (evidence) pool.push(evidence);
  }

  const termIndex = new Map<string, Set<number>>();
  pool.forEach((video, index) => {
    for (const term of titleTerms(video.title, ignore)) {
      const bucket = termIndex.get(term) ?? new Set<number>();
      bucket.add(index);
      termIndex.set(term, bucket);
    }
  });

  const channelsOf = (members: Iterable<number>) => new Set([...members].map((i) => pool.at(i)!.channelId));
  const seeds = [...termIndex.entries()]
    .map(([term, members]) => ({
      term,
      members,
      channels: channelsOf(members).size,
      sumVph: [...members].reduce((sum, i) => sum + pool.at(i)!.vph, 0),
    }))
    .filter((seed) => seed.channels >= 2)
    .toSorted((a, b) => b.channels - a.channels
      || (b.term.includes(' ') ? 1 : 0) - (a.term.includes(' ') ? 1 : 0)
      || b.sumVph - a.sumVph
      || a.term.localeCompare(b.term));

  // Greedy: a seed mostly covered by an existing cluster becomes that cluster's alias.
  const clusters: Array<{ terms: string[]; members: Set<number> }> = [];
  for (const seed of seeds) {
    const home = clusters.find((cluster) => {
      const shared = [...seed.members].filter((i) => cluster.members.has(i)).length;
      return shared / seed.members.size >= 0.6;
    });
    if (home) {
      if (home.terms.length < 5) home.terms.push(seed.term);
      continue;
    }
    clusters.push({ terms: [seed.term], members: new Set(seed.members) });
  }

  const results = clusters.map((cluster): RadarCluster => {
    const members = [...cluster.members].map((i) => pool.at(i)!).toSorted((a, b) => b.vph - a.vph);
    const qualifying = members.filter((video) => video.vph >= minVph);
    const qualifyingChannels = new Set(qualifying.map((video) => video.channelId)).size;
    const published = members.map((video) => publishedMs(video.publishedAt)!.ms);
    const newest = Math.max(...published);
    const label = cluster.terms.find((term) => term.includes(' ')) ?? cluster.terms.at(0)!;
    return {
      clusterId: slug(label),
      label,
      terms: cluster.terms,
      status: qualifying.length >= minVideos && qualifyingChannels >= minChannels ? 'qualified' : 'emerging',
      channelCount: new Set(members.map((video) => video.channelId)).size,
      videoCount: members.length,
      qualifyingChannelCount: qualifyingChannels,
      qualifyingVideoCount: qualifying.length,
      topVph: members.at(0)?.vph ?? 0,
      sumVph: members.reduce((sum, video) => sum + video.vph, 0),
      firstPublishedAt: new Date(Math.min(...published)).toISOString(),
      newestPublishedAt: new Date(newest).toISOString(),
      postBy: new Date(newest + POST_WINDOW_HOURS * HOUR_MS).toISOString(),
      evidence: members.slice(0, maxEvidence),
    };
  });

  return {
    generatedAt: options.now.toISOString(),
    rule: {
      windowDays,
      minVideos,
      minChannels,
      minVph,
      vphDefinition: 'VPH = view tại lần quan sát mới nhất ÷ số giờ từ lúc đăng tới lần quan sát đó (VPH trọn đời).',
    },
    videosInWindow: pool.length,
    channelsInWindow: new Set(pool.map((video) => video.channelId)).size,
    clusters: results
      .toSorted((a, b) => (a.status === b.status ? 0 : a.status === 'qualified' ? -1 : 1)
        || b.qualifyingChannelCount - a.qualifyingChannelCount
        || b.sumVph - a.sumVph)
      .slice(0, maxClusters),
  };
}
