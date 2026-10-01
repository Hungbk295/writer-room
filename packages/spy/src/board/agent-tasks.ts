/**
 * board/agent-tasks.ts — phiếu việc cho agent (plan spy-analyst-workflow §J).
 *
 * UI: người chọn dữ liệu + mẫu việc → createAgentTask soạn prompt (MỘT chỗ,
 * server) → người dán vào CLI. Agent đọc bằng spy_board_* rồi nộp bằng
 * spy_board_submit → submitAgentTask kiểm tra:
 *   1. khuôn JSON của mẫu (zod strict — thiếu/thừa trường, sai kiểu → từ chối),
 *   2. mọi ID trích dẫn có thật trong topic (video / keyword / kênh / ngách),
 *   3. trích comment phải có thật trong video_comments của video đó,
 *   4. phiếu còn 'pending' (mỗi phiếu đúng một kết quả).
 * Sai bất kỳ điểm nào → AppError('invalid_input') kèm đường dẫn trường, KHÔNG
 * ghi gì — agent sửa và nộp lại. Agent không đổi keyword/kênh: người áp dụng
 * đề xuất trên UI.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { AppError } from '../errors.ts';
import type { SpyStore } from '../store.ts';

type Row = Record<string, unknown>;

export const AGENT_TEMPLATES = [
  'compare_niches',
  'outlier_patterns',
  'audience_pains',
  'keyword_ideas',
  'next_steps',
] as const;
export type AgentTemplate = typeof AGENT_TEMPLATES[number];

export const AGENT_TEMPLATE_LABEL: Record<AgentTemplate, string> = {
  compare_niches: 'So sánh tệp',
  outlier_patterns: 'Phân tích outlier',
  audience_pains: 'Nỗi đau khán giả',
  keyword_ideas: 'Đề xuất keyword',
  next_steps: 'Lượt tiếp theo',
};

export interface AgentSelection {
  /** null = "chưa gán ngách". */
  niches?: Array<string | null>;
  videoIds?: string[];
  termKeys?: string[];
}

// ── Khuôn kết quả mỗi mẫu ──────────────────────────────────────────────────

const reason = z.string().trim().min(3).max(600);
const vid = z.string().trim().min(1).max(64);
const ids = (min: number, max: number) => z.array(vid).min(min).max(max);

const RESULT_SCHEMAS = {
  compare_niches: z.object({
    ranking: z.array(z.object({
      niche: z.string().trim().min(1).max(120),
      verdict: z.enum(['choose', 'maybe', 'drop']),
      reason,
    }).strict()).min(1).max(10),
    pick: z.string().trim().min(1).max(120).nullable(),
    missingEvidence: z.array(z.string().trim().min(3).max(300)).max(10),
  }).strict(),
  outlier_patterns: z.object({
    patterns: z.array(z.object({
      name: z.string().trim().min(2).max(120),
      description: reason,
      videoIds: ids(1, 50),
    }).strict()).min(1).max(10),
    titleTemplates: z.array(z.string().trim().min(3).max(200)).max(15),
  }).strict(),
  audience_pains: z.object({
    pains: z.array(z.object({
      pain: z.string().trim().min(3).max(300),
      frequency: z.enum(['high', 'medium', 'low']),
      quotes: z.array(z.object({ videoId: vid, text: z.string().trim().min(8).max(600) }).strict()).min(1).max(8),
    }).strict()).min(1).max(15),
    questions: z.array(z.string().trim().min(3).max(300)).max(15),
  }).strict(),
  keyword_ideas: z.object({
    stop: z.array(z.object({ termKey: z.string().trim().min(1).max(200), reason }).strict()).max(30),
    try: z.array(z.object({
      term: z.string().trim().min(2).max(120),
      reason,
      evidenceVideoIds: ids(1, 20),
    }).strict()).max(30),
  }).strict(),
  next_steps: z.object({
    discover: z.array(z.object({
      termKey: z.string().trim().min(1).max(200),
      reason,
      priority: z.number().int().min(1).max(5),
    }).strict()).max(20),
    deepdive: z.array(z.object({ videoId: vid, reason, priority: z.number().int().min(1).max(5) }).strict()).max(20),
    follow: z.array(z.object({ channelId: z.string().trim().min(1).max(64), reason }).strict()).max(20),
  }).strict(),
} satisfies Record<AgentTemplate, z.ZodTypeAny>;

export type AgentResult<T extends AgentTemplate> = z.infer<typeof RESULT_SCHEMAS[T]>;

/** Ví dụ khuôn đưa vào prompt — agent thấy đúng hình dạng phải nộp. */
const RESULT_EXAMPLES: Record<AgentTemplate, unknown> = {
  compare_niches: {
    ranking: [{ niche: '<group_key>', verdict: 'choose|maybe|drop', reason: 'sàn view …, độ lặp …, cỡ mẫu …' }],
    pick: '<group_key hoặc null nếu chưa đủ bằng chứng>',
    missingEvidence: ['thiếu gì để chốt, vd: ngách B mới 6/20 kênh nhỏ'],
  },
  outlier_patterns: {
    patterns: [{ name: 'tên ngắn của mẫu', description: 'tiêu đề/cấu trúc/góc kể chung', videoIds: ['<video_id>', '<video_id>'] }],
    titleTemplates: ['I Tried {X} for 30 Days — Real Numbers'],
  },
  audience_pains: {
    pains: [{ pain: 'nỗi đau diễn đạt ngắn', frequency: 'high|medium|low', quotes: [{ videoId: '<video_id>', text: '<trích NGUYÊN VĂN một đoạn comment>' }] }],
    questions: ['câu hỏi khán giả lặp lại'],
  },
  keyword_ideas: {
    stop: [{ termKey: '<term_key đang có>', reason: 'tỉ lệ mới …, outlier …' }],
    try: [{ term: 'keyword mới nên thử', reason: 'vì sao', evidenceVideoIds: ['<video_id>'] }],
  },
  next_steps: {
    discover: [{ termKey: '<term_key đang có>', reason: 'vì sao chạy lại/chạy mới', priority: 1 }],
    deepdive: [{ videoId: '<video_id>', reason: 'vì sao đáng đào', priority: 1 }],
    follow: [{ channelId: '<channel_id>', reason: 'vì sao nên theo dõi' }],
  },
};

const TASK_TEXT: Record<AgentTemplate, string[]> = {
  compare_niches: [
    'Gọi spy_board_scorecard để lấy sàn view kênh nhỏ, cỡ mẫu, độ lặp (✅/⚠️/🆕), outlier 28 ngày, luật dừng của từng ngách.',
    'Với ngách đứng đầu, gọi spy_board_videos (view=outliers, small_only=true) để kiểm tra outlier có lặp ở nhiều kênh khác nhau không.',
    'Xếp hạng các ngách theo tiêu chí thắng: kênh nhỏ (<10K subs) có sàn view cao nhất, và bằng chứng không dựa trên một outlier lẻ.',
    'Chỉ đặt pick khi ngách đó đạt luật dừng; nếu chưa, pick=null và nêu missingEvidence.',
  ],
  outlier_patterns: [
    'Gọi spy_board_videos để đọc các video đã chọn (outlier_x, tier, kênh, tuổi, keyword).',
    'Nếu cần, gọi spy_board_video_material để đọc transcript/comment (tối đa 5 video mỗi lần).',
    'Tìm điểm chung về tiêu đề, góc kể, cấu trúc. Mỗi pattern phải chỉ ra videoIds trong số video đã chọn; ưu tiên pattern lặp ở nhiều kênh khác nhau.',
  ],
  audience_pains: [
    'Gọi spy_board_video_material cho các video đã chọn (tối đa 5 mỗi lần) để đọc comment đã lưu.',
    'Gom comment thành các nỗi đau / thắc mắc lặp lại. Mỗi nỗi đau kèm quotes trích NGUYÊN VĂN từ comment (server sẽ đối chiếu, trích sai sẽ bị từ chối).',
    'Nếu video chưa có comment, bỏ qua video đó và nói rõ trong câu trả lời cho người dùng.',
  ],
  keyword_ideas: [
    'Gọi spy_board_keywords cho ngách để xem tỉ lệ mới, số outlier tìm ra, lần search cuối của từng keyword.',
    'Gọi spy_board_videos (view=outliers) để lấy tiêu đề outlier làm nguồn keyword mới.',
    'stop: keyword đã cạn (tỉ lệ mới thấp, không sinh outlier). try: keyword mới rút từ tiêu đề outlier, kèm evidenceVideoIds.',
  ],
  next_steps: [
    'Gọi spy_board_scorecard, spy_board_keywords, spy_board_videos, spy_board_channels và spy_board_runs cho ngách để nắm tình hình.',
    'Đề xuất lượt tiếp theo theo thứ tự ưu tiên (1 = cao nhất): keyword nên Tìm mới (chỉ term_key đang có, không bị khoá 3 ngày), video nên Đào sâu, kênh nên Theo dõi.',
    'Mục tiêu: đạt luật dừng nhanh nhất với ít quota nhất — ưu tiên việc giúp tăng cỡ mẫu kênh nhỏ và kiểm chứng độ lặp.',
  ],
};

// ── Tạo phiếu ──────────────────────────────────────────────────────────────

export interface CreateAgentTaskInput {
  topicId: string;
  template: AgentTemplate;
  niche?: string | null;
  selection: AgentSelection;
  note?: string | null;
}

function requireSelection(input: CreateAgentTaskInput): void {
  const s = input.selection;
  const nVideos = s.videoIds?.length ?? 0;
  if ((input.template === 'outlier_patterns') && nVideos < 2) {
    throw new AppError('invalid_input', 'Phân tích outlier cần chọn ít nhất 2 video');
  }
  if (input.template === 'audience_pains' && nVideos < 1) {
    throw new AppError('invalid_input', 'Nỗi đau khán giả cần chọn ít nhất 1 video (đã Đào sâu)');
  }
  if ((input.template === 'keyword_ideas' || input.template === 'next_steps') && input.niche === undefined) {
    throw new AppError('invalid_input', 'Mẫu này cần chọn một ngách');
  }
  if (nVideos > 50) throw new AppError('invalid_input', 'Tối đa 50 video mỗi phiếu');
}

export function buildAgentPrompt(task: {
  promptId: string;
  topicId: string;
  template: AgentTemplate;
  niche: string | null | undefined;
  selection: AgentSelection;
  note: string | null;
}): string {
  const nicheArg = task.niche === undefined ? null : task.niche === null ? '_none' : task.niche;
  const lines: string[] = [
    `[Spy Board · phiếu ${task.promptId} · ${AGENT_TEMPLATE_LABEL[task.template]}]`,
    `Topic: ${task.topicId}${nicheArg ? ` · Ngách: ${nicheArg}${nicheArg === '_none' ? ' (chưa gán)' : ''}` : ''}`,
  ];
  const s = task.selection;
  if (s.niches?.length) lines.push(`Ngách đã chọn: ${s.niches.map((n) => n ?? '_none').join(', ')}`);
  if (s.videoIds?.length) lines.push(`Video đã chọn (${s.videoIds.length}): ${s.videoIds.join(', ')}`);
  if (s.termKeys?.length) lines.push(`Keyword đã chọn (${s.termKeys.length}): ${s.termKeys.join(', ')}`);
  if (task.note) lines.push(`Ghi chú của người dùng: ${task.note}`);
  lines.push(
    '',
    'Dùng MCP Writer Room Spy (tool spy_board_*). Truyền topic_id như trên' + (nicheArg ? ` và niche="${nicheArg}".` : '.'),
    'Gọi spy_board_metrics trước để hiểu đúng định nghĩa chỉ số.',
    '',
    'Việc cần làm:',
    ...TASK_TEXT[task.template].map((t, i) => `${i + 1}. ${t}`),
    '',
    'Quy tắc:',
    '- Chỉ dùng dữ liệu đọc từ tool; mọi nhận định kèm ID làm bằng chứng. Không bịa ID.',
    '- Không tự Tìm mới / Đào sâu / đổi keyword hay kênh — chỉ đề xuất; người dùng áp dụng trên UI.',
    '- Tóm tắt cho người dùng bằng tiếng Việt, nói rõ dữ liệu tính đến lúc nào (dataAsOf) và cỡ mẫu.',
    '',
    `Kết thúc: gọi spy_board_submit với prompt_id="${task.promptId}" và result đúng khuôn JSON sau (không thêm trường):`,
    JSON.stringify(RESULT_EXAMPLES[task.template], null, 2),
    'Nếu tool trả lỗi, sửa đúng chỗ báo lỗi rồi gọi lại. Phiếu chỉ nhận một kết quả.',
  );
  return lines.join('\n');
}

export function createAgentTask(store: SpyStore, input: CreateAgentTaskInput): { promptId: string; promptText: string } {
  if (!store.getTopic(input.topicId)) throw new AppError('not_found', `Topic '${input.topicId}' không tồn tại`);
  if (!(AGENT_TEMPLATES as readonly string[]).includes(input.template)) {
    throw new AppError('invalid_input', `template phải là ${AGENT_TEMPLATES.join('|')}`);
  }
  requireSelection(input);
  const promptId = `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  const promptText = buildAgentPrompt({
    promptId, topicId: input.topicId, template: input.template, niche: input.niche, selection: input.selection, note,
  });
  store.createAgentTask({
    promptId,
    topicId: input.topicId,
    template: input.template,
    niche: input.niche ?? null,
    selectionJson: JSON.stringify(input.selection),
    note,
    promptText,
    createdAt: new Date().toISOString(),
  });
  return { promptId, promptText };
}

// ── Kiểm tra + nộp ─────────────────────────────────────────────────────────

function existing(db: Database, sql: string, topicId: string, values: readonly string[]): Set<string> {
  const out = new Set<string>();
  const uniq = [...new Set(values)];
  for (let i = 0; i < uniq.length; i += 400) {
    const chunk = uniq.slice(i, i + 400);
    const rows = db.prepare(sql.replace('{IN}', chunk.map(() => '?').join(','))).all(topicId, ...chunk) as Row[];
    for (const r of rows) out.add(String(r['id']));
  }
  return out;
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

export function validateAgentResult(
  store: SpyStore,
  task: { topicId: string; template: AgentTemplate; selection: AgentSelection },
  raw: unknown,
): unknown {
  const parsed = RESULT_SCHEMAS[task.template].safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.slice(0, 8)
      .map((i) => `${i.path.join('.') || '(gốc)'}: ${i.message}`).join('; ');
    throw new AppError('invalid_input', `Sai khuôn ${task.template}: ${msg}`);
  }
  const db = store.rawDb;
  const t = task.topicId;
  const errors: string[] = [];
  const checkIds = (label: string, values: Array<{ path: string; id: string }>, ...sqls: string[]) => {
    if (values.length === 0) return;
    const found = new Set<string>();
    for (const sql of sqls) for (const id of existing(db, sql, t, values.map((v) => v.id))) found.add(id);
    for (const v of values) if (!found.has(v.id)) errors.push(`${v.path}: ${label} '${v.id}' không có trong topic ${t}`);
  };
  const VIDEO_SQL = 'SELECT video_id AS id FROM topic_videos WHERE topic_id=? AND video_id IN ({IN})';
  const TERM_SQL = 'SELECT term_key AS id FROM topic_keywords WHERE topic_id=? AND term_key IN ({IN})';
  // Kênh có thể ở sổ theo dõi hoặc chỉ ở sổ đo — tra cả hai (hai câu riêng để bind đúng).
  const CHANNEL_SQLS = [
    'SELECT channel_id AS id FROM topic_channels WHERE topic_id=? AND channel_id IN ({IN})',
    'SELECT channel_id AS id FROM measured_channels WHERE topic_id=? AND channel_id IN ({IN})',
  ];
  const selected = new Set(task.selection.videoIds ?? []);
  const mustBeSelected = (path: string, id: string) => {
    if (selected.size > 0 && !selected.has(id)) errors.push(`${path}: video '${id}' không nằm trong các video đã chọn`);
  };

  const r = parsed.data as Record<string, unknown>;
  switch (task.template) {
    case 'compare_niches': {
      const d = r as AgentResult<'compare_niches'>;
      const niches = new Set(
        (db.prepare(`SELECT DISTINCT group_key AS g FROM topic_keywords WHERE topic_id=? AND group_key IS NOT NULL
          UNION SELECT DISTINCT group_key FROM topic_channels WHERE topic_id=?1 AND group_key IS NOT NULL
          UNION SELECT DISTINCT group_key FROM measured_channels WHERE topic_id=?1 AND group_key IS NOT NULL`)
          .all(t) as Row[]).map((x) => String(x['g'])),
      );
      niches.add('_none');
      d.ranking.forEach((x, i) => { if (!niches.has(x.niche)) errors.push(`ranking.${i}.niche: ngách '${x.niche}' không tồn tại`); });
      if (d.pick !== null && !d.ranking.some((x) => x.niche === d.pick)) errors.push(`pick: '${d.pick}' phải nằm trong ranking`);
      break;
    }
    case 'outlier_patterns': {
      const d = r as AgentResult<'outlier_patterns'>;
      const refs = d.patterns.flatMap((p, i) => p.videoIds.map((id, j) => ({ path: `patterns.${i}.videoIds.${j}`, id })));
      checkIds('video', refs, VIDEO_SQL);
      refs.forEach((x) => mustBeSelected(x.path, x.id));
      break;
    }
    case 'audience_pains': {
      const d = r as AgentResult<'audience_pains'>;
      const refs = d.pains.flatMap((p, i) => p.quotes.map((q, j) => ({ path: `pains.${i}.quotes.${j}`, id: q.videoId, text: q.text })));
      checkIds('video', refs, VIDEO_SQL);
      refs.forEach((x) => mustBeSelected(`${x.path}.videoId`, x.id));
      const commentsOf = new Map<string, string[]>();
      for (const q of refs) {
        if (!commentsOf.has(q.id)) commentsOf.set(q.id, store.listVideoComments(q.id, 2000).map((c) => norm(c.text)));
        const needle = norm(q.text).replace(/^["“'…. ]+|["”'…. ]+$/g, '');
        if (!commentsOf.get(q.id)!.some((c) => c.includes(needle))) {
          errors.push(`${q.path}.text: không tìm thấy đoạn trích này trong comment đã lưu của video '${q.id}' — trích nguyên văn`);
        }
      }
      break;
    }
    case 'keyword_ideas': {
      const d = r as AgentResult<'keyword_ideas'>;
      checkIds('keyword', d.stop.map((x, i) => ({ path: `stop.${i}.termKey`, id: x.termKey })), TERM_SQL);
      checkIds('video', d.try.flatMap((x, i) => x.evidenceVideoIds.map((id, j) => ({ path: `try.${i}.evidenceVideoIds.${j}`, id }))), VIDEO_SQL);
      break;
    }
    case 'next_steps': {
      const d = r as AgentResult<'next_steps'>;
      checkIds('keyword', d.discover.map((x, i) => ({ path: `discover.${i}.termKey`, id: x.termKey })), TERM_SQL);
      checkIds('video', d.deepdive.map((x, i) => ({ path: `deepdive.${i}.videoId`, id: x.videoId })), VIDEO_SQL);
      checkIds('kênh', d.follow.map((x, i) => ({ path: `follow.${i}.channelId`, id: x.channelId })), ...CHANNEL_SQLS);
      break;
    }
  }
  if (errors.length > 0) {
    throw new AppError('invalid_input', `Kết quả có ${errors.length} lỗi: ${errors.slice(0, 10).join('; ')}`);
  }
  return parsed.data;
}

export function submitAgentTask(
  store: SpyStore,
  promptId: string,
  result: unknown,
  submittedBy = 'agent',
): { promptId: string; template: AgentTemplate; status: 'submitted' } {
  const row = store.getAgentTask(promptId);
  if (!row) throw new AppError('not_found', `Phiếu '${promptId}' không tồn tại — kiểm tra prompt_id trong prompt`);
  if (String(row['status']) !== 'pending') {
    throw new AppError('conflict', `Phiếu '${promptId}' đã có kết quả — mỗi phiếu chỉ nhận một lần`);
  }
  const template = String(row['template']) as AgentTemplate;
  const clean = validateAgentResult(store, {
    topicId: String(row['topic_id']),
    template,
    selection: JSON.parse(String(row['selection_json'])) as AgentSelection,
  }, result);
  if (!store.submitAgentTask(promptId, JSON.stringify(clean), submittedBy, new Date().toISOString())) {
    throw new AppError('conflict', `Phiếu '${promptId}' vừa được nộp bởi lượt khác`);
  }
  return { promptId, template, status: 'submitted' };
}

// ── Đọc ────────────────────────────────────────────────────────────────────

export interface AgentTaskRow {
  promptId: string;
  topicId: string;
  template: AgentTemplate;
  label: string;
  niche: string | null;
  selection: AgentSelection;
  note: string | null;
  promptText: string;
  status: 'pending' | 'submitted';
  createdAt: string;
  result: unknown | null;
  submittedBy: string | null;
  submittedAt: string | null;
}

export function agentTaskFromRow(r: Row): AgentTaskRow {
  const template = String(r['template']) as AgentTemplate;
  return {
    promptId: String(r['prompt_id']),
    topicId: String(r['topic_id']),
    template,
    label: AGENT_TEMPLATE_LABEL[template] ?? template,
    niche: r['niche'] === null ? null : String(r['niche']),
    selection: JSON.parse(String(r['selection_json'])) as AgentSelection,
    note: r['note'] === null ? null : String(r['note']),
    promptText: String(r['prompt_text']),
    status: String(r['status']) as 'pending' | 'submitted',
    createdAt: String(r['created_at']),
    result: r['result_json'] === null ? null : JSON.parse(String(r['result_json'])),
    submittedBy: r['submitted_by'] === null ? null : String(r['submitted_by']),
    submittedAt: r['submitted_at'] === null ? null : String(r['submitted_at']),
  };
}

/**
 * Tư liệu của video cho agent: comment đã lưu (nhiều like trước) + transcript
 * ghép từ segment của snapshot. Chỉ đọc — không gọi YouTube. Tối đa 5 video.
 */
export function boardVideoMaterial(
  store: SpyStore,
  topicId: string,
  videoIds: string[],
  opts: { commentsPerVideo?: number; transcriptChars?: number } = {},
) {
  if (videoIds.length < 1 || videoIds.length > 5) throw new AppError('invalid_input', 'video_ids phải có 1..5 phần tử');
  const perVideo = Math.min(Math.max(opts.commentsPerVideo ?? 60, 1), 200);
  const maxChars = Math.min(Math.max(opts.transcriptChars ?? 6000, 500), 20_000);
  const db = store.rawDb;
  return videoIds.map((videoId) => {
    const v = db.prepare('SELECT title, channel_id, latest_views FROM topic_videos WHERE topic_id=? AND video_id=?')
      .get(topicId, videoId) as Row | null;
    const comments = store.listVideoComments(videoId, 2000)
      .sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
      .slice(0, perVideo)
      .map((c) => ({ text: c.text, likes: c.likeCount, isReply: c.parentCommentId !== null }));
    const full = store.listTranscriptSegmentsBySourceVideoId(videoId).map((s) => s.text).join(' ');
    return {
      videoId,
      inTopic: v !== null,
      title: v ? String(v['title']) : null,
      channelId: v ? String(v['channel_id']) : null,
      views: v ? Number(v['latest_views'] ?? 0) : null,
      commentsStored: store.listVideoComments(videoId, 2000).length,
      comments,
      transcript: full ? full.slice(0, maxChars) : null,
      transcriptTruncated: full.length > maxChars,
    };
  });
}
