// packages/daemon/src/spy/keyword-routes.ts — Spy Keyword Run API (v14,
// plan spy-keyword-run-board §2). Mount 1 dòng trong http.ts dưới
// /api/spy/keywords — giống dash-routes.ts: file tự chứa helper, chỉ
// parse/validate rồi gọi SpyService.store/keywordRuns.
//
// HITL: mọi đổi status keyword đi qua store.decideKeyword → decisions
// actor='human' (bulk do NGƯỜI bấm nút). Máy chỉ ghi pending/rejected.
// Run chạy nền (không giữ HTTP) — pattern giống POST /loop/tick.

import {
  AppError,
  KEYWORD_RESEARCH_DAYS,
  dashKeywordRunDetail,
  dashKeywordRuns,
  normalizeTermKey,
  type SpyService,
  type TopicKeywordRow,
} from '@writer-room/spy';

// ── Helpers http nhỏ (bản sao của http.ts/dash-routes.ts — file tự chứa) ─────

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

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** int trong [lo, hi]; ném string mô tả lỗi. */
function intParam(v: unknown, name: string, lo: number, hi: number, def: number): number {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw `${name} phải là số nguyên ${lo}..${hi}`;
  return n;
}

const KEYWORD_DECIDE_STATUSES = ['active', 'paused', 'rejected', 'pending'] as const;
const KEYWORD_RUN_STATUSES = ['pending', 'active', 'paused', 'rejected'] as const;

/** topic phải tồn tại — ném 'TOPIC_NOT_FOUND:' (giống dash) → 404. */
function requireTopicRow(spy: SpyService, topicId: string): Record<string, unknown> {
  const row = spy.store.getTopic(topicId);
  if (!row) throw `TOPIC_NOT_FOUND:${topicId}`;
  return row as Record<string, unknown>;
}

/** Map term_key → row cho mọi keyword của topic (đủ mọi status). */
function keywordMap(spy: SpyService, topicId: string): Map<string, TopicKeywordRow> {
  return new Map(
    spy.store.listKeywordsByStatus(topicId, ['pending', 'active', 'paused', 'rejected'])
      .map((k) => [k.termKey, k]),
  );
}

// ── Dispatcher — http.ts mount: pathname.startsWith('/api/spy/keywords') ──────

export async function handleSpyKeywords(
  url: URL,
  req: Request,
  spy: SpyService,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/spy\/keywords\/?/, '');
  const method = req.method;
  try {
    // POST /bulk {topicId, terms[], group?, activate?} — thêm nhiều keyword
    // một lần; idempotent theo term_key (normalizeTermKey). Luôn upsert
    // status='pending' trước, activate=true → decideKeyword 'active'
    // (decisions actor='human').
    if (method === 'POST' && path === 'bulk') {
      const body = await readBody(req);
      const topicId = typeof body['topicId'] === 'string' ? body['topicId'] : '';
      const terms = Array.isArray(body['terms'])
        ? (body['terms'] as unknown[]).map(String)
        : [];
      if (!topicId || terms.length === 0) return err('topicId, terms[] bắt buộc');
      requireTopicRow(spy, topicId);
      const activate = body['activate'] === true;
      const group = typeof body['group'] === 'string' && body['group'].trim() !== ''
        ? body['group'].trim()
        : undefined;
      const reason = typeof body['reason'] === 'string' ? body['reason'] : 'bulk_add';

      const existing = keywordMap(spy, topicId);
      const added: string[] = [];
      const reactivated: string[] = [];
      const skipped: Array<{ term: string; reason: string }> = [];
      const seen = new Set<string>();

      for (const raw of terms) {
        const term = raw.trim();
        const termKey = term === '' ? '' : normalizeTermKey(term);
        if (termKey === '') {
          skipped.push({ term: raw, reason: 'term rỗng hoặc không hợp lệ' });
          continue;
        }
        if (seen.has(termKey)) {
          skipped.push({ term, reason: 'trùng trong payload' });
          continue;
        }
        seen.add(termKey);

        const row = existing.get(termKey);
        if (!row) {
          spy.store.upsertTopicKeyword({
            topicId,
            termKey,
            displayTerm: term,
            relation: 'bulk',
            evidenceJson: '{}',
            status: 'pending',
            origin: 'user',
            addedBy: 'user',
            groupKey: group ?? null,
          });
          added.push(termKey);
          if (activate) spy.store.decideKeyword(topicId, termKey, 'active', reason);
          continue;
        }

        // Keyword đã có: chỉ đè group (người đặt lại), KHÔNG upsert —
        // upsert sẽ xoá evidence_json đang có của nó.
        if (group !== undefined && row.groupKey !== group) {
          spy.store.setKeywordGroup(topicId, termKey, group);
        }
        if (activate) {
          if (row.status === 'active') {
            skipped.push({ term, reason: 'đã active' });
          } else {
            spy.store.decideKeyword(topicId, termKey, 'active', reason);
            reactivated.push(termKey);
          }
        } else if (row.status === 'rejected' || row.status === 'paused') {
          // Re-add = người đưa về chờ duyệt lại — ghi decision, không sửa lén.
          spy.store.decideKeyword(topicId, termKey, 'pending', reason);
          reactivated.push(termKey);
        } else {
          skipped.push({ term, reason: `đã tồn tại (${row.status})` });
        }
      }
      return json({ ok: true, added, reactivated, skipped });
    }

    // POST /decide {topic_id, term_keys[], to_status, reason?} — quyết định
    // người trên nhiều keyword; per-term decideKeyword ghi decisions.
    if (method === 'POST' && path === 'decide') {
      const body = await readBody(req);
      const topicId = typeof body['topic_id'] === 'string' ? body['topic_id'] : '';
      const termKeys = Array.isArray(body['term_keys'])
        ? (body['term_keys'] as unknown[]).map(String)
        : [];
      const toStatus = typeof body['to_status'] === 'string' ? body['to_status'] : '';
      const reason = typeof body['reason'] === 'string' ? body['reason'] : null;
      if (!topicId || termKeys.length === 0 || !toStatus) {
        return err('topic_id, term_keys[], to_status bắt buộc');
      }
      if (!(KEYWORD_DECIDE_STATUSES as readonly string[]).includes(toStatus)) {
        return err(`to_status phải là ${KEYWORD_DECIDE_STATUSES.join('|')}`);
      }
      requireTopicRow(spy, topicId);
      const existing = keywordMap(spy, topicId);
      const missing = termKeys.filter((k) => !existing.has(k));
      if (missing.length > 0) {
        return err(`term_keys không thuộc topic: ${missing.join(', ')}`);
      }
      for (const termKey of termKeys) {
        spy.store.decideKeyword(topicId, termKey, toStatus, reason);
      }
      return json({ ok: true, updated: termKeys.length });
    }

    // POST /run {topicId, termKeys?|group?|status='active', note?,
    //   publishedAfterDays=28, maxResults=50, scanChannelsCap=10, dryRun?}
    // v16: keyword đã search trong KEYWORD_RESEARCH_DAYS ngày bị khoá — không
    // tính vào ước tính quota, lượt chạy ghi nó là skipped_dedup.
    // Resolve keyword → preflight → tạo keyword_runs row + chạy nền.
    if (method === 'POST' && path === 'run') {
      const body = await readBody(req);
      const topicId = typeof body['topicId'] === 'string' ? body['topicId'] : '';
      if (!topicId) return err('topicId bắt buộc');
      const topic = requireTopicRow(spy, topicId);

      const termKeysRaw = Array.isArray(body['termKeys'])
        ? (body['termKeys'] as unknown[]).map(String).map((t) => normalizeTermKey(t.trim()))
        : undefined;
      const group = typeof body['group'] === 'string' ? body['group'] : undefined;
      const status = body['status'] === undefined
        ? 'active'
        : typeof body['status'] === 'string' &&
            (KEYWORD_RUN_STATUSES as readonly string[]).includes(body['status'])
          ? body['status']
          : null;
      if (status === null) {
        return err(`status phải là ${KEYWORD_RUN_STATUSES.join('|')}`);
      }
      const params = {
        publishedAfterDays: intParam(body['publishedAfterDays'], 'publishedAfterDays', 1, 365, 28),
        maxResults: intParam(body['maxResults'], 'maxResults', 1, 50, 50),
        scanChannelsCap: intParam(body['scanChannelsCap'], 'scanChannelsCap', 0, 50, 10),
      };

      const keywords = spy.keywordRuns.resolveKeywords(topicId, {
        termKeys: termKeysRaw && termKeysRaw.length > 0 ? termKeysRaw : undefined,
        group,
        status,
      });
      if (keywords.length === 0) {
        return err('Không có keyword nào khớp bộ lọc');
      }

      const nowMs = Date.now();
      const locked = keywords.filter((k) => k.lastCheckedAt
        && nowMs - Date.parse(k.lastCheckedAt) < KEYWORD_RESEARCH_DAYS * 86_400_000);
      const estimatedSearchCalls = keywords.length - locked.length; // 1 keyword = 1 search.list
      const quotaRemaining = spy.quota.remaining('search');
      const lockedOut = locked.map((k) => ({ termKey: k.termKey, lastCheckedAt: k.lastCheckedAt }));

      if (body['dryRun'] === true) {
        return json({
          dryRun: true,
          keywords: keywords.map((k) => k.termKey),
          locked: lockedOut,
          estimatedSearchCalls,
          quotaRemaining,
        });
      }
      if (estimatedSearchCalls === 0) {
        return json({
          error: `Mọi keyword đã được search trong ${KEYWORD_RESEARCH_DAYS} ngày qua`,
          locked: lockedOut,
        }, 409);
      }
      const note = typeof body['note'] === 'string' && body['note'].trim() !== ''
        ? body['note'].trim().slice(0, 500)
        : null;
      // Ngách của thẻ: group truyền vào, hoặc nhóm chung của mọi keyword.
      const groups = new Set(keywords.map((k) => k.groupKey ?? null));
      const runGroup = group ?? (groups.size === 1 ? [...groups][0] ?? null : null);

      // Preflight theo spec: paused → 409, run đang chạy → 409, quota → 429.
      if (String(topic['status']) === 'paused') {
        return err('Topic đang paused', 409);
      }
      if (spy.store.getRunningKeywordRun(topicId)) {
        return err('Đã có keyword run đang chạy cho topic này', 409);
      }
      if (quotaRemaining < estimatedSearchCalls) {
        return json({
          error: `Quota search không đủ: cần ${estimatedSearchCalls}, còn ${quotaRemaining}`,
          remaining: quotaRemaining,
        }, 429);
      }

      const runId = spy.keywordRuns.startRun(topicId, keywords, params, JSON.stringify({
        termKeys: termKeysRaw ?? null,
        group: group ?? null,
        status,
        ...params,
      }), { note, groupKey: runGroup, triggeredBy: 'human' });
      return json({
        runId,
        keywords: keywords.map((k) => k.termKey),
        locked: lockedOut,
        estimatedSearchCalls,
        quotaRemaining,
      });
    }

    // GET /runs?topic_id&limit — lịch sử run (dùng chung mapper dash).
    if (method === 'GET' && path === 'runs') {
      const topicId = url.searchParams.get('topic_id') ?? '';
      if (!topicId) throw 'topic_id bắt buộc';
      requireTopicRow(spy, topicId);
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 20 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw 'limit 1..500';
      return json({ runs: dashKeywordRuns(spy.store.rawDb, topicId, { limit }) });
    }

    // GET /runs/:runId — một run kèm items.
    const runMatch = path.match(/^runs\/([^/]+)$/);
    if (method === 'GET' && runMatch) {
      const detail = dashKeywordRunDetail(spy.store.rawDb, decodeURIComponent(runMatch[1]!));
      if (!detail) return err('Keyword run không tồn tại', 404);
      return json(detail);
    }

    return err('Endpoint không tồn tại', 404);
  } catch (e) {
    if (e instanceof AppError) {
      const status = e.code === 'not_found' ? 404
        : e.code === 'conflict' ? 409
          : e.code === 'quota_exceeded' ? 429
            : 400;
      return err(e.message, status);
    }
    if (typeof e === 'string') {
      if (e.startsWith('TOPIC_NOT_FOUND:')) {
        return err(`Topic không tồn tại: ${e.slice('TOPIC_NOT_FOUND:'.length)}`, 404);
      }
      return err(e, 400);
    }
    throw e;
  }
}
