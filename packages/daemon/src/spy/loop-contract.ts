/**
 * Spy Loop — adapter giữa `SpyService` (packages/spy) và bề mặt HTTP của daemon.
 *
 * Trước đây file này chỉ là *type bridge* tạm: nó khai lại toàn bộ kiểu của
 * `spy.loop` vì module đó chưa tồn tại, và `http.ts` lấy adapter bằng
 * `(spy as unknown as { loop?: SpyLoopAdapter }).loop`. `spy.loop` đã ship, nên
 * cast đó đã bị gỡ; file này giờ là adapter thật.
 *
 * Vì sao vẫn cần một lớp adapter thay vì gọi thẳng `spy.loop` từ route:
 *   1. `LoopRunner` trả **Row thô của SQLite** (snake_case) cho `inbox()` /
 *      `listTopics()`; hợp đồng JSON với web (`delivery.md` §3) là camelCase và
 *      có thêm trường suy diễn. Map ở đây, một chỗ duy nhất.
 *   2. `LoopRunner` mới có runTick/status/inbox/decide/report/listTopics. Các
 *      mặt còn lại (keyword board, report archive, studied, cold-start) đọc
 *      thẳng `spy.store` — vẫn là API công khai của package spy, không phải cast.
 *   3. Chữ ký của `LoopRunner` là của packages/spy; khi nó đổi, chỉ file này đổi,
 *      route giữ nguyên.
 *
 * ⚠ Hợp đồng faceless ở P0 (design §3): `facelessScore` là **verdict** và
 * LUÔN null cho tới khi vòng agent-vision chấm. `facelessHint` là **phỏng đoán
 * từ chữ**, không bao giờ được hiển thị như kết luận và không được auto-reject.
 */
import type { SpyService } from '@writer-room/spy';
import { normalizeTermKey, planTick, quotaDay } from '@writer-room/spy';
import type {
  CandidateChannel,
  LoopMode,
  LoopStatus,
  ReportSummaryJson,
  SetupStep,
  TickResult,
  TopicSettings,
} from '@writer-room/spy';

type CandidateRecord = CandidateChannel;

export type { LoopMode, LoopStatus, ReportSummaryJson, SetupStep, TickResult, TopicSettings };

// ─── Wire types (hợp đồng JSON với packages/web) ──────────────────────────────

export interface TopicConfig {
  topicId: string;
  label: string;
  market: string;
  language: string;
  status: 'active' | 'paused' | 'archived';
  ownChannelIds: string[];
  briefMd: string;
  facelessRequired: boolean;
  dailySearchBudget: number;
  createdAt: string;
  updatedAt: string;
}

export interface InboxItem {
  channelId: string;
  title: string | null;
  handle: string | null;
  url: string;
  /** ≤6 URL thumbnail do ENRICH ghi. Rỗng khi kênh chưa qua bước ENRICH. */
  thumbnails: string[];
  subscriberCount: number | null;
  videoCount: number | null;
  country: string | null;
  publishedAt: string | null;
  medianViews: number | null;
  medianViewsVsOwn: number | null;
  fitScore: number | null;
  fitReasons: string[];
  /**
   * VERDICT faceless. P0 luôn `null` — chưa có agent vision nào chấm.
   * Chỉ được set khi `FacelessVerdictPort` có implementation thật.
   */
  facelessScore: number | null;
  /** Evidence ref của verdict ở trên. P0 luôn rỗng. */
  facelessSignals: string[];
  /** PHỎNG ĐOÁN từ title/description (0..1). Không phải kết luận. */
  facelessHint: number | null;
  /** Lý do của phỏng đoán — luôn hiển thị kèm hint. */
  facelessHintReasons: string[];
  learnValueScore: number | null;
  learnValueReasons: string[];
  langDetected: string | null;
  langConfidence: number | null;
  /**
   * Bằng chứng ngôn ngữ. `method` quyết định nó được ĐỌC như cái gì:
   *   'declared_fields'     → bằng chứng cứng, được phép nêu làm lý do reject
   *   'title_heuristic'     → phỏng đoán đã ghi lại; loop KHÔNG BAO GIỜ reject vì nó
   *   'insufficient_sample' → không kết luận gì
   * `canJustifyRejection` là câu trả lời đã tính sẵn cho UI, để không nơi nào
   * phải tự suy lại luật đó (và suy sai).
   */
  langEvidence: LangEvidence | null;
  foundVia: { relation: string; term: string | null; fromChannelId: string | null };
  /** v13 CHECK: new | active | paused | rejected | own. */
  status: 'new' | 'active' | 'paused' | 'rejected' | 'own';
  decidedBy: string | null;
  /** Lý do máy đọc được khi loop tự quyết: 'lang_mismatch' | 'low_fit' | … */
  decidedReason: string | null;
  decidedAt: string | null;
  firstSeenAt: string;
}

export interface LangEvidence {
  method: 'declared_fields' | 'title_heuristic' | 'insufficient_sample' | string;
  evidenceField: string | null;
  declaredByField: Record<string, number>;
  declaredCount: number | null;
  sampleSize: number | null;
  majority: string | null;
  /**
   * CHỈ true khi `method === 'declared_fields'`. Là giá trị TÍNH SẴN cho UI, để
   * không nơi nào phải tự suy lại luật (và suy sai) — nhưng `method` ở trên luôn
   * được giữ nguyên bên cạnh, nên khi luật đổi thì boolean này vẫn kiểm chứng
   * lại được. Một boolean lưu sẵn mà không tái tính được cũng vô dụng như một
   * điểm số không kèm lý do.
   */
  canJustifyRejection: boolean;
  /** Câu tiếng Việt sẵn để hiển thị — luôn nói rõ bằng chứng đến từ field nào. */
  summary: string;
}

export interface KeywordItem {
  topicId: string;
  termKey: string;
  displayTerm: string;
  relation: string;
  /** v13 CHECK: pending | active | paused | rejected. */
  status: 'pending' | 'active' | 'paused' | 'rejected';
  yieldChannels: number;
  lastSearchedAt: string | null;
  addedAt: string;
  addedBy: string;
}

export interface StoredReport {
  reportId: string;
  reportDate: string;
  topicId: string | null;
  summary: ReportSummaryJson | null;
  markdown: string;
  createdAt: string;
  deliveredJson: Record<string, string>;
}

export interface StudiedChannel {
  channelId: string;
  title: string | null;
  handle: string | null;
  spyRunId: string | null;
  status: string;
  fitScore: number | null;
  learnValueScore: number | null;
  facelessScore: number | null;
  facelessHint: number | null;
  decidedAt: string | null;
}

/** Kết quả cold-start tự lực (§1.2 — không provider ngoài). */
export interface ManualCandidateResult {
  added: number;
  skippedKnown: number;
  notFound: string[];
}

export interface ImportCorpusResult {
  added: number;
  skippedKnown: number;
}

/**
 * Kế hoạch tick hiển thị trước khi chạy thật (§5.1 "Chạy tick ngay (dry-run)").
 * Đây là bản trình bày theo BƯỚC của `planTick()` — người duyệt cần thấy chi phí
 * rơi vào đâu, không chỉ một con số tổng.
 */
export interface TickPlanView {
  topicId: string;
  quotaDay: string;
  dryRun: true;
  steps: Array<{
    step: string;
    estimatedSearchCalls: number;
    estimatedGeneralUnits: number;
    keywords: string[];
    note: string;
  }>;
  totalSearchCalls: number;
  totalGeneralUnits: number;
  canProceed: boolean;
  warnings: string[];
}

export interface SpyLoopAdapter {
  listTopics(): Promise<TopicConfig[]>;
  getTopic(topicId: string): Promise<TopicConfig | null>;
  upsertTopic(config: {
    topicId: string;
    label: string;
    market: string;
    language: string;
    status?: 'active' | 'paused' | 'archived';
    ownChannelIds?: string[];
    briefMd?: string;
    facelessRequired?: boolean;
    dailySearchBudget?: number;
  }): Promise<TopicConfig>;
  status(topicId?: string): Promise<LoopStatus[]>;
  inbox(params: {
    topicId: string;
    status?: string;
    limit?: number;
    cursor?: number;
    sort?: string;
  }): Promise<{ items: InboxItem[]; total: number; nextCursor: number | null }>;
  /** `status: 'new'` = undo một quyết định (phím `u` trên dashboard). */
  decide(params: {
    topicId: string;
    channelIds: string[];
    status: 'new' | 'active' | 'paused' | 'rejected';
    negativeKeyword?: string;
    decidedBy?: 'user' | 'loop_auto';
  }): Promise<{ updated: number }>;
  listKeywords(topicId: string): Promise<KeywordItem[]>;
  addKeyword(params: { topicId: string; term: string; relation?: string; addedBy?: 'user' | 'loop' | 'agent' }): Promise<KeywordItem>;
  decideKeyword(params: {
    topicId: string;
    termKeys: string[];
    status: 'pending' | 'active' | 'paused' | 'rejected';
    addToNegative?: boolean;
  }): Promise<{ updated: number }>;
  /**
   * Tick thật. `mode` v3: 'daily' (0 search call), 'weekly' (search bounded),
   * 'setup' (cần `setupStep` S2='channels' | S3='keywords'). Bỏ `mode` = tick
   * legacy v5 — giữ nguyên cho caller cũ.
   */
  tick(params: { topicId: string; mode?: LoopMode; setupStep?: SetupStep }): Promise<TickResult>;
  /** Ngưỡng của topic (settings_json merge mặc định §3 plan) — scheduler đọc dailyAt/weeklyAt. */
  topicSettings(topicId: string): Promise<TopicSettings>;
  /** Dry-run: chỉ lập kế hoạch + ước tính chi phí, KHÔNG gọi API nào. */
  planTick(topicId: string): Promise<TickPlanView>;
  listReports(params: { topicId?: string; limit?: number }): Promise<StoredReport[]>;
  getReport(reportId: string): Promise<StoredReport | null>;
  markDelivered(reportId: string, channel: string, ts: string): Promise<void>;
  listStudied(topicId: string): Promise<StudiedChannel[]>;
  /** Cold start #1: dán URL / @handle / UC-id. Resolve qua Data API (có tính quota). */
  addManualCandidates(params: { topicId: string; inputs: string[] }): Promise<ManualCandidateResult>;
  /** Cold start #2: nạp kênh đã spy sẵn trong corpus. 0 quota. */
  importCorpus(params: { topicId: string }): Promise<ImportCorpusResult>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  return String(row[key] ?? '');
}
function nstr(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined || v === '' ? null : String(v);
}
function nnum(row: Row, key: string): number | null {
  const v = row[key];
  return v === null || v === undefined ? null : Number(v);
}
function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * `faceless_hint_reasons_json` và `learn_value_reasons_json` dùng CÙNG một
 * envelope: `{ method, sampleSize?, reasons: [...] }` — không phải mảng phẳng.
 *
 * `method` bắt buộc đi ra tới UI. Design §7 acceptance: "mọi điểm số có
 * reasons[]/method; không có số nào không nhãn nguồn" — một hint suy từ 9 title
 * và một hint suy từ 200 title là hai mức tin cậy khác nhau, người duyệt phải
 * phân biệt được.
 */
function envelopeReasonsToStrings(raw: unknown, kind: 'faceless_hint' | 'learn_value'): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // Bản ghi cũ có thể là mảng phẳng — vẫn đọc được.
  if (Array.isArray(parsed)) return reasonsToStrings(JSON.stringify(parsed));
  if (!parsed || typeof parsed !== 'object') return [];

  const obj = parsed as { method?: unknown; sampleSize?: unknown; reasons?: unknown };
  const out = reasonsToStrings(JSON.stringify(obj.reasons ?? []));

  const sample = typeof obj.sampleSize === 'number' ? ` (mẫu ${obj.sampleSize})` : '';
  if (obj.method === 'insufficient_sample') {
    out.unshift(
      kind === 'faceless_hint'
        // Đi kèm hint = null → badge là "chưa xác định", không phải một con số.
        ? `mẫu văn bản quá mỏng — không đủ để đoán${sample}`
        : `không đủ mẫu để chấm${sample}`,
    );
  } else if (obj.method === 'text_only') {
    out.unshift('phương pháp: chỉ đọc chữ (title/mô tả), chưa xem hình');
  } else if (obj.method === 'deterministic') {
    out.unshift(`phương pháp: tính từ số liệu thật${sample}`);
  } else if (typeof obj.method === 'string' && obj.method !== '') {
    out.unshift(`phương pháp: ${obj.method}${sample}`);
  }
  return out;
}

/**
 * `lang_evidence_json` — G7 đòi lý do reject phải chỉ ra bằng chứng đến TỪ FIELD
 * NÀO: "12/12 video khai defaultAudioLanguage=en" khác hẳn "đoán từ title".
 * `decided_reason='lang_mismatch'` một mình không phân biệt được hai thứ đó.
 */
function parseLangEvidence(raw: unknown): LangEvidence | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;

  const method = typeof o['method'] === 'string' ? o['method'] : 'insufficient_sample';
  const evidenceField = typeof o['evidenceField'] === 'string' ? o['evidenceField'] : null;
  const declaredCount = typeof o['declaredCount'] === 'number' ? o['declaredCount'] : null;
  const sampleSize = typeof o['sampleSize'] === 'number' ? o['sampleSize'] : null;
  const majority = typeof o['majority'] === 'string' ? o['majority'] : null;
  const declaredByField: Record<string, number> = {};
  if (o['declaredByField'] && typeof o['declaredByField'] === 'object') {
    for (const [key, value] of Object.entries(o['declaredByField'] as Record<string, unknown>)) {
      if (typeof value === 'number') declaredByField[key] = value;
    }
  }

  // Luật của spy: chỉ 'declared_fields' mới là bằng chứng đủ mạnh để reject.
  const canJustifyRejection = method === 'declared_fields';

  const counted = declaredCount !== null && sampleSize !== null
    ? `${declaredCount}/${sampleSize} video`
    : sampleSize !== null ? `${sampleSize} video` : 'mẫu chưa rõ';
  const summary = method === 'declared_fields'
    ? `${counted} khai ${evidenceField ?? 'ngôn ngữ'}${majority ? ` = ${majority}` : ''}`
    : method === 'title_heuristic'
      ? `đoán từ title${majority ? ` → ${majority}` : ''} (${counted}) — không dùng để reject`
      : `không đủ mẫu để kết luận ngôn ngữ (${counted})`;

  return { method, evidenceField, declaredByField, declaredCount, sampleSize, majority, canJustifyRejection, summary };
}

/** `thumbnails_json` là `string[]` do ENRICH ghi; trần 6 theo §5.1. */
function parseThumbnails(raw: unknown): string[] {
  return parseJsonArray(raw)
    .filter((url): url is string => typeof url === 'string' && url !== '')
    .slice(0, 6);
}

/**
 * Điểm số nào cũng phải kèm lý do đọc được (design §7 acceptance).
 * Reason có thể là string, hoặc object {label|factor|detail|reason}.
 */
function reasonsToStrings(raw: unknown): string[] {
  return parseJsonArray(raw).map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      const label = o['label'] ?? o['factor'] ?? o['kind'] ?? o['code'];
      const detail = o['detail'] ?? o['reason'] ?? o['note'] ?? o['message'] ?? o['ref'];
      const points = o['points'];
      const value = o['value'];
      const parts = [
        label === undefined ? null : String(label),
        detail === undefined ? null : String(detail),
        points !== undefined ? `+${String(points)}`
          : typeof value === 'number' ? `(${value.toFixed(2)})`
          : null,
      ].filter((p): p is string => p !== null && p !== '');
      if (parts.length > 0) return parts.join(' — ');
    }
    return JSON.stringify(entry);
  });
}

function topicFromRow(row: Row): TopicConfig {
  let ownChannelIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(str(row, 'own_channel_ids_json') || '[]');
    if (Array.isArray(parsed)) ownChannelIds = parsed.map(String);
  } catch { /* cột hỏng không được làm sập trang */ }
  const status = str(row, 'status');
  return {
    topicId: str(row, 'topic_id'),
    label: str(row, 'label'),
    market: str(row, 'market'),
    language: str(row, 'language'),
    status: status === 'paused' || status === 'archived' ? status : 'active',
    ownChannelIds,
    briefMd: str(row, 'brief_md'),
    facelessRequired: Boolean(row['faceless_required']),
    dailySearchBudget: Number(row['daily_search_budget'] ?? 20),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function keywordFromRow(row: Row): KeywordItem {
  const status = str(row, 'status');
  return {
    topicId: str(row, 'topic_id'),
    termKey: str(row, 'term_key'),
    displayTerm: str(row, 'display_term'),
    relation: str(row, 'relation'),
    // v13: searched→active, exhausted→paused đã được migration ánh xạ.
    status: status === 'active' || status === 'paused' || status === 'rejected' ? status : 'pending',
    yieldChannels: Number(row['yield_channels'] ?? 0),
    lastSearchedAt: nstr(row, 'last_searched_at'),
    addedAt: str(row, 'added_at'),
    addedBy: str(row, 'added_by') || 'user',
  };
}

function reportFromRow(row: Row): StoredReport {
  let summary: ReportSummaryJson | null = null;
  try {
    summary = JSON.parse(str(row, 'summary_json')) as ReportSummaryJson;
  } catch { /* report cũ/hỏng vẫn phải liệt kê được */ }
  let deliveredJson: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(str(row, 'delivered_json') || '{}');
    if (parsed && typeof parsed === 'object') deliveredJson = parsed as Record<string, string>;
  } catch { /* idem */ }
  return {
    reportId: str(row, 'report_id'),
    reportDate: str(row, 'report_date'),
    topicId: nstr(row, 'topic_id'),
    summary,
    markdown: str(row, 'markdown'),
    createdAt: str(row, 'created_at'),
    deliveredJson,
  };
}

/**
 * Chuẩn hoá một dòng người dùng dán vào ô "Nhập kênh thủ công" thành token mà
 * `channelsByIds` hiểu: `UC…` hoặc `@handle`.
 *
 * Chấp nhận: `UC…`, `@handle`, `youtube.com/channel/UC…`, `youtube.com/@handle`,
 * `youtube.com/c/<name>`, `youtube.com/user/<name>` (hai dạng legacy thử như handle).
 * Trả `null` khi không suy ra được gì — route báo lại trong `notFound`.
 */
export function parseChannelInput(raw: string): string | null {
  const input = raw.trim();
  if (input === '') return null;

  if (/^UC[\w-]{20,24}$/.test(input)) return input;
  if (/^@[\w.-]{2,}$/.test(input)) return input;

  let path = input;
  if (/^https?:\/\//i.test(input) || /^(www\.)?(m\.)?youtube\.com/i.test(input)) {
    try {
      const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
      if (!/(^|\.)youtube\.com$/i.test(url.hostname) && !/(^|\.)youtu\.be$/i.test(url.hostname)) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  }

  const channelMatch = /\/channel\/(UC[\w-]{20,24})/.exec(path);
  if (channelMatch) return channelMatch[1]!;
  const handleMatch = /\/@([\w.-]{2,})/.exec(path);
  if (handleMatch) return `@${handleMatch[1]!}`;
  const legacyMatch = /\/(?:c|user)\/([\w.-]{2,})/.exec(path);
  if (legacyMatch) return `@${legacyMatch[1]!}`;
  return null;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

class SpyLoopService implements SpyLoopAdapter {
  constructor(private readonly spy: SpyService) {}

  // ── Topics ──────────────────────────────────────────────────────────────────

  async listTopics(): Promise<TopicConfig[]> {
    return this.spy.loop.listTopics().map((row) => topicFromRow(row as Row));
  }

  async getTopic(topicId: string): Promise<TopicConfig | null> {
    const row = this.spy.store.getTopic(topicId);
    return row ? topicFromRow(row as Row) : null;
  }

  async upsertTopic(config: Parameters<SpyLoopAdapter['upsertTopic']>[0]): Promise<TopicConfig> {
    this.spy.store.upsertTopic({
      topicId: config.topicId,
      label: config.label,
      market: config.market,
      language: config.language,
      status: config.status ?? 'active',
      ownChannelIds: config.ownChannelIds ?? [],
      briefMd: config.briefMd ?? '',
      facelessRequired: config.facelessRequired !== false,
      dailySearchBudget: config.dailySearchBudget ?? 20,
    });
    const saved = await this.getTopic(config.topicId);
    if (!saved) throw new Error(`Không đọc lại được topic '${config.topicId}' sau khi ghi`);
    return saved;
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  async status(topicId?: string): Promise<LoopStatus[]> {
    if (topicId) {
      const one = this.spy.loop.status(topicId);
      return one ? [one] : [];
    }
    const out: LoopStatus[] = [];
    for (const row of this.spy.loop.listTopics()) {
      const s = this.spy.loop.status(String((row as Row)['topic_id']));
      if (s) out.push(s);
    }
    return out;
  }

  // ── Inbox ───────────────────────────────────────────────────────────────────

  async inbox(params: {
    topicId: string;
    status?: string;
    limit?: number;
    cursor?: number;
    sort?: string;
  }): Promise<{ items: InboxItem[]; total: number; nextCursor: number | null }> {
    this.candidateCache = null;
    this.sourceCache = null;
    this.termLabelCache = null;
    const limit = params.limit ?? 50;
    const cursor = params.cursor ?? 0;
    const statusFilter = params.status ?? 'new';

    // `listTopicChannels` đã ORDER BY fit_score * learn_value_score DESC — chính là
    // thứ tự mặc định của Inbox (§5.1). `facelessHint` KHÔNG tham gia xếp hạng
    // chính, chỉ phá hoà (dưới đây), vì nó là phỏng đoán.
    const rows = this.spy.loop.inbox(params.topicId, {
      status: statusFilter,
      limit: limit + 1,
      cursor,
    }) as Row[];

    const total = this.spy.store.countTopicChannelsByStatus(params.topicId)[statusFilter] ?? 0;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const items = page.map((row) => this.toInboxItem(row));
    this.applyTiebreak(items);

    return { items, total, nextCursor: hasMore ? cursor + limit : null };
  }

  /**
   * Chỉ phá hoà: hai kênh có cùng fit×learn thì kênh có hint faceless cao hơn
   * lên trước. Không đảo thứ tự chính — hint là phỏng đoán, không phải verdict.
   */
  private applyTiebreak(items: InboxItem[]): void {
    const rank = (item: InboxItem) => (item.fitScore ?? 0) * (item.learnValueScore ?? 0);
    items.sort((a, b) => {
      const diff = rank(b) - rank(a);
      if (diff !== 0) return diff;
      return (b.facelessHint ?? 0) - (a.facelessHint ?? 0);
    });
  }

  private toInboxItem(row: Row): InboxItem {
    const channelId = str(row, 'channel_id');
    const candidate = this.candidateById(channelId);
    const status = str(row, 'status');
    return {
      channelId,
      title: candidate?.title ?? null,
      handle: candidate?.handle ?? null,
      url: `https://www.youtube.com/channel/${channelId}`,
      // ENRICH ghi ≤6 URL vào `thumbnails_json`. Kênh chưa qua ENRICH (vd vừa
      // nạp từ corpus) thì rỗng — UI hiện placeholder, không bịa URL.
      thumbnails: parseThumbnails(row['thumbnails_json']),
      subscriberCount: candidate?.subscriberCount ?? null,
      videoCount: candidate?.videoCount ?? null,
      country: candidate?.country ?? null,
      publishedAt: candidate?.publishedAt ?? null,
      medianViews: null,
      medianViewsVsOwn: null,
      fitScore: nnum(row, 'fit_score'),
      fitReasons: reasonsToStrings(row['fit_reasons_json']),
      // VERDICT — P0 luôn null (design §3). Không đọc từ hint.
      facelessScore: nnum(row, 'faceless_score'),
      facelessSignals: reasonsToStrings(row['faceless_signals_json']),
      facelessHint: nnum(row, 'faceless_hint'),
      facelessHintReasons: envelopeReasonsToStrings(row['faceless_hint_reasons_json'], 'faceless_hint'),
      learnValueScore: nnum(row, 'learn_value_score'),
      learnValueReasons: envelopeReasonsToStrings(row['learn_value_reasons_json'], 'learn_value'),
      langDetected: nstr(row, 'lang_detected'),
      langConfidence: nnum(row, 'lang_confidence'),
      langEvidence: parseLangEvidence(row['lang_evidence_json']),
      // `topic_channel_sources` là nguồn đúng: nó biết kênh này ra từ KEYWORD
      // nào, thứ `candidate_channels.discovered_via` không ghi. Chỉ lùi về
      // candidate khi chưa có dòng provenance nào (dữ liệu cũ trước v5).
      foundVia: (() => {
        const src = this.sourceFor(str(row, 'topic_id'), channelId);
        if (src) {
          const topicId = str(row, 'topic_id');
          return {
            relation: str(src, 'relation') || 'unknown',
            term: this.displayTerm(topicId, nstr(src, 'term_key')),
            fromChannelId: nstr(src, 'from_channel_id'),
          };
        }
        return {
          relation: candidate?.discoveredVia ?? 'unknown',
          term: null,
          fromChannelId: candidate?.discoveredFrom ?? null,
        };
      })(),
      status: (['new', 'active', 'paused', 'rejected', 'own'].includes(status)
        ? status
        : 'new') as InboxItem['status'],
      decidedBy: nstr(row, 'decided_by'),
      decidedReason: nstr(row, 'decided_reason'),
      decidedAt: nstr(row, 'decided_at'),
      firstSeenAt: str(row, 'first_seen_at'),
    };
  }

  /**
   * `SpyStore` không có `getCandidate(channelId)`; `listCandidates` là accessor
   * duy nhất. Nạp một lần cho mỗi request rồi tra Map — tránh N query cho một
   * trang Inbox 50 dòng. Cache reset sau mỗi lần dựng danh sách.
   */
  private candidateCache: Map<string, CandidateRecord> | null = null;

  /** Provenance đầu tiên của mỗi kênh trong topic — cũng nạp một lần/trang. */
  private sourceCache: { topicId: string; byChannel: Map<string, Row> } | null = null;

  /**
   * `term_key` → `display_term`. Provenance lưu term_key (bỏ dấu, lowercase) vì
   * đó là khoá; nhưng hiện «lai kep» cho người Việt đọc là sai — Inbox phải
   * hiện «lãi kép».
   */
  private termLabelCache: { topicId: string; byKey: Map<string, string> } | null = null;

  private displayTerm(topicId: string, termKey: string | null): string | null {
    if (termKey === null) return null;
    if (this.termLabelCache?.topicId !== topicId) {
      const byKey = new Map<string, string>();
      for (const row of this.spy.store.listTopicKeywords(topicId) as Row[]) {
        byKey.set(str(row, 'term_key'), str(row, 'display_term'));
      }
      this.termLabelCache = { topicId, byKey };
    }
    // Keyword đã bị xoá khỏi bảng vẫn phải hiện được gì đó → lùi về chính key.
    return this.termLabelCache.byKey.get(termKey) ?? termKey;
  }

  private loadCandidateCache(): void {
    const all = this.spy.store.listCandidates({ limit: 100_000 });
    this.candidateCache = new Map(all.map((c) => [c.channelId, c]));
  }

  private candidateById(channelId: string): CandidateRecord | null {
    if (!this.candidateCache) this.loadCandidateCache();
    return this.candidateCache!.get(channelId) ?? null;
  }

  /**
   * `listTopicChannelSources` trả mọi dòng theo `seen_at` tăng dần, nên dòng
   * ĐẦU TIÊN gặp cho một kênh chính là provenance đầu tiên — cùng định nghĩa
   * với `getTopicChannelSource`, nhưng một query cho cả trang thay vì N query.
   */
  private sourceFor(topicId: string, channelId: string): Row | null {
    if (this.sourceCache?.topicId !== topicId) {
      const byChannel = new Map<string, Row>();
      for (const row of this.spy.store.listTopicChannelSources(topicId) as Row[]) {
        const id = str(row, 'channel_id');
        if (!byChannel.has(id)) byChannel.set(id, row);
      }
      this.sourceCache = { topicId, byChannel };
    }
    return this.sourceCache.byChannel.get(channelId) ?? null;
  }

  // ── Decide ──────────────────────────────────────────────────────────────────

  async decide(params: {
    topicId: string;
    channelIds: string[];
    status: 'new' | 'active' | 'paused' | 'rejected';
    negativeKeyword?: string;
    decidedBy?: 'user' | 'loop_auto';
  }): Promise<{ updated: number }> {
    // v13: đường duy nhất đổi status là decideChannel — ghi decisions
    // actor='human' (tôn chỉ 1). `decidedBy` giữ trong signature cho caller cũ;
    // quyết định ở đây luôn là của người duyệt.
    // "Reject + negative keyword" đi qua decided_reason='reject_neg:<kw>'
    // (hợp đồng web — không thêm cột mới); term cũng được đánh rejected để
    // loop không search lại (§2.3).
    const negative = params.negativeKeyword?.trim();
    const reason = negative && params.status === 'rejected' ? `reject_neg:${negative}` : null;
    for (const channelId of params.channelIds) {
      this.spy.store.decideChannel(params.topicId, channelId, params.status, reason);
    }
    if (negative) {
      this.spy.store.setKeywordStatus(params.topicId, normalizeTermKey(negative), 'rejected');
    }
    return { updated: params.channelIds.length };
  }

  // ── Keywords ────────────────────────────────────────────────────────────────

  async listKeywords(topicId: string): Promise<KeywordItem[]> {
    return this.spy.store.listTopicKeywords(topicId).map((row) => keywordFromRow(row as Row));
  }

  async addKeyword(params: {
    topicId: string;
    term: string;
    relation?: string;
    addedBy?: 'user' | 'loop' | 'agent';
  }): Promise<KeywordItem> {
    const displayTerm = params.term.trim();
    const termKey = normalizeTermKey(displayTerm);
    this.spy.store.upsertTopicKeyword({
      topicId: params.topicId,
      termKey,
      displayTerm,
      relation: params.relation ?? 'seed',
      status: 'pending',
      addedBy: params.addedBy ?? 'user',
    });
    const found = this.spy.store
      .listTopicKeywords(params.topicId)
      .map((row) => keywordFromRow(row as Row))
      .find((kw) => kw.termKey === termKey);
    if (!found) throw new Error(`Không đọc lại được keyword '${displayTerm}'`);
    return found;
  }

  async decideKeyword(params: {
    topicId: string;
    termKeys: string[];
    status: 'pending' | 'active' | 'paused' | 'rejected';
  }): Promise<{ updated: number }> {
    // v13: qua decideKeyword của hợp đồng store — ghi decisions actor='human'.
    for (const termKey of params.termKeys) {
      this.spy.store.decideKeyword(params.topicId, termKey, params.status, null);
    }
    return { updated: params.termKeys.length };
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  async tick(params: { topicId: string; mode?: LoopMode; setupStep?: SetupStep }): Promise<TickResult> {
    return this.spy.loop.runTick(params.topicId, {
      dryRun: false,
      mode: params.mode,
      setupStep: params.setupStep,
    });
  }

  async topicSettings(topicId: string): Promise<TopicSettings> {
    return this.spy.store.getTopicSettings(topicId);
  }

  async planTick(topicId: string): Promise<TickPlanView> {
    const plan = planTick(this.spy.store, this.spy.quota, topicId);
    // EXPAND đọc channelSections + subscriptions: 1–2 unit/kênh (§2.1 bước 1).
    const expandUnits = Math.min(plan.channelsToExpand.length * 2, plan.estimatedGeneralUnits);
    const enrichUnits = Math.max(plan.estimatedGeneralUnits - expandUnits, 0);
    return {
      topicId,
      quotaDay: plan.quotaDay,
      dryRun: true,
      steps: [
        {
          step: 'EXPAND',
          estimatedSearchCalls: 0,
          estimatedGeneralUnits: expandUnits,
          keywords: [],
          note: `${plan.channelsToExpand.length} kênh active chưa mở rộng đồ thị`,
        },
        {
          step: 'SEARCH',
          estimatedSearchCalls: plan.estimatedSearchCalls,
          estimatedGeneralUnits: 0,
          keywords: plan.keywordsToSearch,
          note: `${plan.keywordsToSearch.length} keyword trong ngân sách ngày`,
        },
        {
          step: 'ENRICH',
          estimatedSearchCalls: 0,
          estimatedGeneralUnits: enrichUnits,
          keywords: [],
          note: 'channels.list + playlistItems + videos.list cho kênh mới',
        },
        {
          step: 'AUTO-TRIAGE',
          estimatedSearchCalls: 0,
          estimatedGeneralUnits: 0,
          keywords: [],
          note: 'fit + learn_value + post-filter ngôn ngữ (0 quota). faceless_hint KHÔNG auto-reject.',
        },
        {
          step: 'REPORT',
          estimatedSearchCalls: 0,
          estimatedGeneralUnits: 0,
          keywords: [],
          note: 'ghi daily_reports + đẩy Telegram nếu đã bật',
        },
      ],
      totalSearchCalls: plan.estimatedSearchCalls,
      totalGeneralUnits: plan.estimatedGeneralUnits,
      canProceed: plan.canProceed,
      warnings: plan.blockers,
    };
  }

  // ── Reports ─────────────────────────────────────────────────────────────────

  async listReports(params: { topicId?: string; limit?: number }): Promise<StoredReport[]> {
    return this.spy.store
      .listDailyReports(params.topicId ?? null, params.limit ?? 30)
      .map((row) => reportFromRow(row as Row));
  }

  async getReport(reportId: string): Promise<StoredReport | null> {
    const row = this.spy.store.getDailyReport(reportId);
    return row ? reportFromRow(row as Row) : null;
  }

  async markDelivered(reportId: string, channel: string, ts: string): Promise<void> {
    this.spy.store.markDelivered(reportId, channel, ts);
  }

  // ── Studied ─────────────────────────────────────────────────────────────────

  async listStudied(topicId: string): Promise<StudiedChannel[]> {
    this.candidateCache = null;
    this.sourceCache = null;
    this.termLabelCache = null;
    // v3: Follow List = kênh active (migration đã gộp studied → active).
    return (this.spy.store.listTopicChannels(topicId, { status: 'active', limit: 200 }) as Row[])
      .map((row) => {
        const channelId = str(row, 'channel_id');
        const candidate = this.candidateById(channelId);
        return {
          channelId,
          title: candidate?.title ?? null,
          handle: candidate?.handle ?? null,
          spyRunId: nstr(row, 'spy_run_id'),
          status: str(row, 'status'),
          fitScore: nnum(row, 'fit_score'),
          learnValueScore: nnum(row, 'learn_value_score'),
          facelessScore: nnum(row, 'faceless_score'),
          facelessHint: nnum(row, 'faceless_hint'),
          decidedAt: nstr(row, 'decided_at'),
        };
      });
  }

  // ── Cold start (§1.2) — tự lực, không provider ngoài ────────────────────────

  async addManualCandidates(params: {
    topicId: string;
    inputs: string[];
  }): Promise<ManualCandidateResult> {
    const topic = await this.getTopic(params.topicId);
    if (!topic) throw new Error(`Topic '${params.topicId}' không tồn tại`);

    // Giữ nguyên văn dòng người dùng dán để báo lại chính xác dòng nào hỏng.
    const parsed = params.inputs
      .map((raw) => raw.trim())
      .filter((raw) => raw !== '')
      .map((raw) => ({ raw, token: parseChannelInput(raw) }));

    const notFound: string[] = parsed.filter((e) => e.token === null).map((e) => e.raw);

    // Dedupe theo token, giữ dòng đầu tiên làm nhãn báo lỗi.
    const byToken = new Map<string, string>();
    for (const entry of parsed) {
      if (entry.token && !byToken.has(entry.token)) byToken.set(entry.token, entry.raw);
    }
    const ids = [...byToken.keys()].filter((t) => !t.startsWith('@'));
    const handles = [...byToken.keys()].filter((t) => t.startsWith('@'));
    if (ids.length === 0 && handles.length === 0) return { added: 0, skippedKnown: 0, notFound };

    const known = new Set(
      (this.spy.store.listTopicChannels(params.topicId, { limit: 100_000 }) as Row[])
        .map((row) => str(row, 'channel_id')),
    );

    let added = 0;
    let skippedKnown = 0;

    const absorb = (channel: {
      channelId: string;
      title: string | null;
      description: string | null;
      subscriberCount: number | null;
      videoCount: number | null;
      viewCount: number | null;
      country: string | null;
      publishedAt: string | null;
    }): void => {
      if (known.has(channel.channelId)) {
        skippedKnown += 1;
        return;
      }
      this.spy.store.upsertCandidate({
        channelId: channel.channelId,
        title: channel.title,
        market: topic.market,
        discoveredVia: 'manual_user',
        subscriberCount: channel.subscriberCount,
        videoCount: channel.videoCount,
        viewCount: channel.viewCount,
        country: channel.country,
        publishedAt: channel.publishedAt,
        description: channel.description,
      });
      this.spy.store.upsertTopicChannel({
        topicId: params.topicId,
        channelId: channel.channelId,
        status: 'new',
      });
      this.spy.store.addTopicChannelSource({
        topicId: params.topicId,
        channelId: channel.channelId,
        relation: 'manual_user',
      });
      known.add(channel.channelId);
      added += 1;
    };

    // `spy.channelsByIds` đi qua đường Data API của SpyService (được bọc bởi
    // QuotaCountingDataApi) — cố ý không gọi thẳng adapter để quota vẫn vào sổ.
    // channels.list nhận tối đa 50 id/call.
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const result = await this.spy.channelsByIds(batch);
      for (const channel of result.channels) absorb(channel);
      for (const missing of result.missing) {
        notFound.push(byToken.get(missing) ?? missing);
      }
    }

    // Handle phải resolve từng cái một (`channels.list?forHandle=` không batch),
    // và chỉ cách này mới biết ĐÚNG handle nào trượt để báo lại.
    for (const handle of handles) {
      const result = await this.spy.channelsByIds([handle]);
      const channel = result.channels[0];
      if (!channel) {
        notFound.push(byToken.get(handle) ?? handle);
        continue;
      }
      absorb(channel);
    }

    return { added, skippedKnown, notFound };
  }


  async importCorpus(params: { topicId: string }): Promise<ImportCorpusResult> {
    // 0 quota: chỉ copy từ bảng `channels` (kênh đã spy) sang topic.
    const result = this.spy.loop.importCorpusChannelsToTopic(params.topicId);
    return { added: result.imported.length, skippedKnown: result.skipped.length };
  }
}

export function createSpyLoopAdapter(spy: SpyService): SpyLoopAdapter {
  return new SpyLoopService(spy);
}

/** Ngày quota hiện tại (Pacific) — dùng chung với scheduler. */
export { quotaDay };
