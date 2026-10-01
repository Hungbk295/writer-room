// packages/daemon/src/spy/board-routes.ts — Spy Board API (plan
// spy-analyst-workflow §F). Đọc: GET /api/spy/board/{metrics,scorecard,videos,
// channels,keywords,runs,runs/:id} — gọi thẳng board/queries.ts, CÙNG hàm với
// MCP spy_board_*, nên board và agent luôn thấy cùng số. Ghi: POST
// /api/spy/board/channels/niche (người gán ngách tay), POST /api/spy/board/deepdive
// (lượt Đào sâu — người bấm; agent không có đường ghi này).
//
// Tham số `niche`: bỏ trống = mọi ngách; `niche=_none` = "chưa gán" (NULL).

import {
  AGENT_TEMPLATES,
  agentTaskFromRow,
  createAgentTask,
  type AgentTemplate,
  DEEPDIVE_MAX_VIDEOS,
  hasComments,
  hasTranscript,
  boardChannels,
  boardKeywords,
  boardLabels,
  boardMetrics,
  boardRunDetail,
  boardRuns,
  boardScorecard,
  boardVideos,
  type BoardChannelSort,
  type BoardRunType,
  type BoardVideoSort,
  type BoardVideoView,
  type SpyService,
} from '@writer-room/spy';

export const NICHE_NONE = '_none';

const VIDEO_VIEWS: readonly BoardVideoView[] = ['outliers', 'rising', 'all'];
const VIDEO_SORTS: readonly BoardVideoSort[] = ['outlier_x', 'velocity_24h', 'views', 'published_at'];
const CHANNEL_SORTS: readonly BoardChannelSort[] = ['outliers_28d', 'subs', 'baseline', 'channel_age'];
const RUN_TYPES: readonly BoardRunType[] = ['track', 'discover', 'deepdive', 'weekly', 'setup'];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** undefined = mọi ngách; null = chưa gán. */
function parseNiche(raw: string | null): string | null | undefined {
  if (raw === null || raw === '') return undefined;
  return raw === NICHE_NONE ? null : raw;
}

function parseEnum<T extends string>(raw: string | null, name: string, allowed: readonly T[]): T | undefined {
  if (raw === null || raw === '') return undefined;
  if (!(allowed as readonly string[]).includes(raw)) throw `${name} phải là ${allowed.join('|')}`;
  return raw as T;
}

function parseInt0(raw: string | null, name: string, lo: number, hi: number): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) throw `${name} phải là số nguyên ${lo}..${hi}`;
  return n;
}

function parseBool(raw: string | null): boolean | undefined {
  if (raw === null || raw === '') return undefined;
  return raw === '1' || raw === 'true';
}

function requireTopic(url: URL, spy: SpyService): string {
  const topicId = url.searchParams.get('topic_id');
  if (!topicId) throw 'topic_id bắt buộc';
  if (!spy.store.getTopic(topicId)) throw `TOPIC_NOT_FOUND:${topicId}`;
  return topicId;
}

export async function handleSpyBoard(url: URL, req: Request, spy: SpyService): Promise<Response> {
  const db = spy.store.rawDb;
  const path = url.pathname.replace(/^\/api\/spy\/board\/?/, '');
  const method = req.method.toUpperCase();
  try {
    if (method === 'POST' && path === 'channels/niche') {
      let body: Record<string, unknown> = {};
      try { body = await req.json() as Record<string, unknown>; } catch { /* body rỗng */ }
      const topicId = typeof body['topicId'] === 'string' ? body['topicId'] : '';
      if (!topicId) return err('topicId bắt buộc');
      if (!spy.store.getTopic(topicId)) return err(`Topic '${topicId}' không tồn tại`, 404);
      const ids = Array.isArray(body['channelIds']) ? (body['channelIds'] as unknown[]).map(String) : [];
      if (ids.length === 0) return err('channelIds bắt buộc');
      const nicheRaw = body['niche'];
      if (nicheRaw !== null && (typeof nicheRaw !== 'string' || nicheRaw.trim() === '')) {
        return err('niche phải là chuỗi khác rỗng hoặc null (gỡ ngách)');
      }
      const niche = nicheRaw === null ? null : (nicheRaw as string).trim();
      return json({ changed: spy.store.assignChannelNiche(topicId, ids, niche) });
    }
    // POST /deepdive {topicId, videoIds[], note?, niche?, dryRun?} — kéo comment
    // + transcript; cái đã có thì bỏ qua (chống trùng). dryRun chỉ trả kế hoạch.
    if (method === 'POST' && path === 'deepdive') {
      let body: Record<string, unknown> = {};
      try { body = await req.json() as Record<string, unknown>; } catch { /* body rỗng */ }
      const topicId = typeof body['topicId'] === 'string' ? body['topicId'] : '';
      if (!topicId) return err('topicId bắt buộc');
      const topic = spy.store.getTopic(topicId);
      if (!topic) return err(`Topic '${topicId}' không tồn tại`, 404);
      const videoIds = Array.isArray(body['videoIds'])
        ? [...new Set((body['videoIds'] as unknown[]).map(String).map((v) => v.trim()).filter(Boolean))]
        : [];
      if (videoIds.length === 0) return err('videoIds bắt buộc');
      if (videoIds.length > DEEPDIVE_MAX_VIDEOS) return err(`Tối đa ${DEEPDIVE_MAX_VIDEOS} video mỗi lượt Đào sâu`);
      const plan = videoIds.map((videoId) => ({
        videoId,
        commentsPresent: hasComments(spy.store, videoId),
        transcriptPresent: hasTranscript(spy.store, videoId),
      }));
      const toWork = plan.filter((p) => !p.commentsPresent || !p.transcriptPresent).length;
      if (body['dryRun'] === true) return json({ dryRun: true, plan, toWork });
      if (String(topic['status']) === 'paused') return err('Topic đang paused', 409);
      if (spy.store.getRunningKeywordRun(topicId)) return err('Đã có lượt chạy đang chạy cho topic này', 409);
      if (toWork === 0) return json({ error: 'Mọi video đã có comment và transcript', plan }, 409);
      const note = typeof body['note'] === 'string' && body['note'].trim() !== '' ? body['note'].trim().slice(0, 500) : null;
      const niche = typeof body['niche'] === 'string' && body['niche'].trim() !== '' && body['niche'] !== NICHE_NONE
        ? body['niche'].trim()
        : null;
      const runId = spy.deepDives.startRun(topicId, videoIds, { note, groupKey: niche, triggeredBy: 'human' });
      return json({ runId, plan, toWork });
    }

    // POST /tasks {topicId, template, niche?, selection:{niches?,videoIds?,termKeys?}, note?}
    // — phiếu việc cho agent (plan §J): server soạn prompt, UI chỉ hiện + Copy.
    if (method === 'POST' && path === 'tasks') {
      let body: Record<string, unknown> = {};
      try { body = await req.json() as Record<string, unknown>; } catch { /* body rỗng */ }
      const template = String(body['template'] ?? '');
      if (!(AGENT_TEMPLATES as readonly string[]).includes(template)) {
        return err(`template phải là ${AGENT_TEMPLATES.join('|')}`);
      }
      const sel = (body['selection'] ?? {}) as Record<string, unknown>;
      const strs = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);
      const nicheRaw = body['niche'];
      try {
        const created = createAgentTask(spy.store, {
          topicId: String(body['topicId'] ?? ''),
          template: template as AgentTemplate,
          niche: nicheRaw === undefined ? undefined : nicheRaw === null || nicheRaw === NICHE_NONE ? null : String(nicheRaw),
          selection: {
            niches: Array.isArray(sel['niches'])
              ? (sel['niches'] as unknown[]).map((n) => (n === null || n === NICHE_NONE ? null : String(n)))
              : undefined,
            videoIds: strs(sel['videoIds']),
            termKeys: strs(sel['termKeys']),
          },
          note: typeof body['note'] === 'string' ? body['note'] : null,
        });
        return json(created);
      } catch (e) {
        const code = (e as { code?: string }).code;
        return err(e instanceof Error ? e.message : String(e), code === 'not_found' ? 404 : 400);
      }
    }

    if (method !== 'GET') return err('Method không hỗ trợ', 405);

    const taskDetail = path.match(/^tasks\/([^/]+)$/);
    if (taskDetail) {
      const row = spy.store.getAgentTask(decodeURIComponent(taskDetail[1]!));
      return row ? json({ data: agentTaskFromRow(row) }) : err('Không có phiếu này', 404);
    }

    const runDetail = path.match(/^runs\/([^/]+)$/);
    if (runDetail) {
      const detail = boardRunDetail(db, decodeURIComponent(runDetail[1]!));
      return detail ? json(detail) : err('Không có lượt chạy này', 404);
    }

    const topicId = requireTopic(url, spy);
    const q = (k: string) => url.searchParams.get(k);
    switch (path) {
      case 'metrics':
        return json({ data: boardMetrics(db, topicId) });
      case 'scorecard':
        return json(boardScorecard(db, topicId, { historyDays: parseInt0(q('history_days'), 'history_days', 7, 90) }));
      case 'videos':
        return json(boardVideos(db, topicId, {
          niche: parseNiche(q('niche')),
          view: parseEnum(q('view'), 'view', VIDEO_VIEWS),
          smallOnly: parseBool(q('small_only')),
          channelAgeMaxDays: parseInt0(q('channel_age_max_days'), 'channel_age_max_days', 1, 36_500),
          sort: parseEnum(q('sort'), 'sort', VIDEO_SORTS),
          limit: parseInt0(q('limit'), 'limit', 1, 500),
        }));
      case 'channels':
        return json(boardChannels(db, topicId, {
          niche: parseNiche(q('niche')),
          smallOnly: parseBool(q('small_only')),
          hasOutlier: parseBool(q('has_outlier')),
          sort: parseEnum(q('sort'), 'sort', CHANNEL_SORTS),
          limit: parseInt0(q('limit'), 'limit', 1, 500),
        }));
      case 'keywords':
        return json(boardKeywords(db, topicId, { niche: parseNiche(q('niche')) }));
      case 'labels': {
        const list = (k: string) => (q(k) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        return json({ data: boardLabels(db, topicId, list('video_ids'), list('channel_ids')) });
      }
      case 'tasks':
        return json({ data: spy.store.listAgentTasks(topicId, parseInt0(q('limit'), 'limit', 1, 200) ?? 50).map(agentTaskFromRow) });
      case 'runs':
        return json(boardRuns(db, topicId, {
          niche: parseNiche(q('niche')),
          type: parseEnum(q('type'), 'type', RUN_TYPES),
          limit: parseInt0(q('limit'), 'limit', 1, 500),
        }));
      default:
        return err(`Không có endpoint /api/spy/board/${path}`, 404);
    }
  } catch (e) {
    if (typeof e === 'string') {
      if (e.startsWith('TOPIC_NOT_FOUND:')) return err(`Topic '${e.slice(16)}' không tồn tại`, 404);
      return err(e);
    }
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}
