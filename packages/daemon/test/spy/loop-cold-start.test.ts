/**
 * Cold start tự lực (design §1.2) — hai đường thay cho provider dữ liệu ngoài
 * đã bị gỡ khỏi cả plan lẫn code:
 *
 *   1. `POST /api/spy/loop/candidates/manual` — dán URL / @handle / UC-id.
 *   2. `POST /api/spy/loop/import-corpus`     — nạp kênh đã spy sẵn, 0 quota.
 *
 * Test chạy được KHÔNG cần API key: đường (2) không chạm Data API, còn đường (1)
 * chạy qua một `YouTubeDataApiPort` giả tiêm vào `SpyService`, nên resolve THẬT
 * mà không cần key.
 *
 * H4 (hard gate): phải có bằng chứng đường dashboard persist `manual_user` xuống
 * ĐẾN ROW. Gate không nhận "đọc code thấy đúng" thay cho fixture, và cũng không
 * nhận assert trên DTO — DTO là thứ do chính adapter dựng ra, nó không chứng minh
 * được cái gì nằm trong SQLite. Vì vậy test cuối gọi ROUTE THẬT qua
 * `createHandler`, rồi mở lại file .sqlite bằng `Database(path, {readonly:true})`
 * và đọc thẳng cột.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '@writer-room/spy';
import type { ChannelStatistics, YouTubeDataApiPort } from '@writer-room/spy';
import { createHandler, type HttpApp } from '../../src/http.ts';
import { createSpyLoopAdapter, parseChannelInput } from '../../src/spy/loop-contract.ts';

let root = '';
let spy: SpyService | undefined;

afterEach(async () => {
  spy?.store.close();
  spy = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function bootSpy(): Promise<SpyService> {
  root = await mkdtemp(join(tmpdir(), 'writer-room-cold-start-'));
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'spy'), { recursive: true });
  const service = new SpyService({ dataRoot: join(root, 'spy') });
  await service.init();
  spy = service;
  return service;
}

/** ChannelStatistics đầy đủ trường — fake port phải trả đúng hình dạng thật. */
function fakeChannel(channelId: string, title: string): ChannelStatistics {
  return {
    channelId,
    title,
    description: 'Kênh giả lập cho test',
    subscriberCount: 12_345,
    videoCount: 42,
    viewCount: 6_000_000,
    uploadsPlaylistId: channelId.replace(/^UC/, 'UU'),
    publishedAt: '2025-03-01T00:00:00.000Z',
    country: 'VN',
  };
}

/**
 * `SpyService` bọc adapter tiêm vào bằng `QuotaCountingDataApi(hasKey: () => true)`,
 * nên fake này vừa resolve được kênh vừa đi qua đúng đường ghi sổ quota của
 * production — không phải một lối tắt vòng qua decorator.
 */
function fakeDataApi(channels: Map<string, ChannelStatistics>): YouTubeDataApiPort {
  return {
    fetchVideoStatistics: async () => new Map(),
    fetchChannelStatistics: async (ids) => {
      const out = new Map<string, ChannelStatistics>();
      for (const id of ids) {
        const hit = channels.get(id);
        if (hit) out.set(id, hit);
      }
      return out;
    },
    resolveChannelByHandle: async (handle) => channels.get(handle) ?? null,
  };
}

describe('Spy Loop cold start', () => {
  test('parseChannelInput nhận URL, @handle và UC-id; từ chối phần còn lại', () => {
    // UC-id trần
    expect(parseChannelInput('UC3pBgNay1YGUCvQmYMW6-lw')).toBe('UC3pBgNay1YGUCvQmYMW6-lw');
    expect(parseChannelInput('  UC3pBgNay1YGUCvQmYMW6-lw  ')).toBe('UC3pBgNay1YGUCvQmYMW6-lw');
    // handle trần
    expect(parseChannelInput('@soitaichinh247')).toBe('@soitaichinh247');
    // URL /channel/
    expect(parseChannelInput('https://www.youtube.com/channel/UC3pBgNay1YGUCvQmYMW6-lw'))
      .toBe('UC3pBgNay1YGUCvQmYMW6-lw');
    expect(parseChannelInput('https://www.youtube.com/channel/UC3pBgNay1YGUCvQmYMW6-lw/videos'))
      .toBe('UC3pBgNay1YGUCvQmYMW6-lw');
    // URL /@handle, có/không scheme, có query
    expect(parseChannelInput('https://www.youtube.com/@soitaichinh247')).toBe('@soitaichinh247');
    expect(parseChannelInput('youtube.com/@soitaichinh247/videos?x=1')).toBe('@soitaichinh247');
    expect(parseChannelInput('https://m.youtube.com/@soitaichinh247')).toBe('@soitaichinh247');
    // Legacy /c/ và /user/ — thử như handle, đó là cách duy nhất còn lại
    expect(parseChannelInput('https://www.youtube.com/c/SoiTaiChinh')).toBe('@SoiTaiChinh');
    expect(parseChannelInput('https://www.youtube.com/user/SoiTaiChinh')).toBe('@SoiTaiChinh');

    // Không suy ra được gì → null (route báo lại trong `notFound`)
    expect(parseChannelInput('')).toBeNull();
    expect(parseChannelInput('   ')).toBeNull();
    expect(parseChannelInput('chỉ là chữ')).toBeNull();
    expect(parseChannelInput('https://vimeo.com/@someone')).toBeNull();
    expect(parseChannelInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  test('importCorpus nạp kênh đã spy vào topic — 0 quota, idempotent', async () => {
    const service = await bootSpy();
    const loop = createSpyLoopAdapter(service);

    service.store.upsertTopic({
      topicId: 'finance-vi',
      label: 'Tài chính cá nhân VI',
      market: 'vi',
      language: 'vi',
    });

    for (const [index, channelId] of ['UCcorpus0000000000000a', 'UCcorpus0000000000000b'].entries()) {
      service.store.upsertChannel({
        channelId,
        title: `Kênh corpus ${index + 1}`,
        subscriberCount: 1000 * (index + 1),
        videoCount: 10 + index,
        totalViewCount: 500_000,
        fetchedAt: new Date().toISOString(),
      });
    }

    const quotaBefore = JSON.stringify(service.quota.status());

    const first = await loop.importCorpus({ topicId: 'finance-vi' });
    expect(first).toEqual({ added: 2, skippedKnown: 0 });

    // Chạy lại không nhân đôi — kênh đã có trong topic thì bỏ qua.
    const second = await loop.importCorpus({ topicId: 'finance-vi' });
    expect(second).toEqual({ added: 0, skippedKnown: 2 });

    // Tuyệt đối không tốn quota: chỉ đọc/ghi SQLite. Khẳng định này là về việc
    // KHÔNG có call nào xảy ra, không phải về cách decorator ghi sổ — nên nó
    // đúng bất kể quy tắc bọc adapter của SpyService có đổi hay không.
    expect(JSON.stringify(service.quota.status())).toBe(quotaBefore);

    // Kênh vào thẳng Inbox với hợp đồng faceless đúng của P0.
    const inbox = await loop.inbox({ topicId: 'finance-vi' });
    expect(inbox.total).toBe(2);
    expect(inbox.items).toHaveLength(2);
    for (const item of inbox.items) {
      expect(item.status).toBe('new');
      expect(item.facelessScore).toBeNull();     // verdict — chưa có vòng vision
      expect(item.facelessSignals).toEqual([]);
      expect(item.facelessHint).toBeNull();      // chưa enrich → chưa có cả phỏng đoán
      expect(item.facelessHintReasons).toEqual([]);
      expect(item.foundVia.relation).toBe('corpus_import');
      expect(item.url).toBe(`https://www.youtube.com/channel/${item.channelId}`);
    }
    expect(inbox.items.map((i) => i.title).sort())
      .toEqual(['Kênh corpus 1', 'Kênh corpus 2']);
  });

  test('InboxItem mang provenance, thumbnail và lý do điểm thật từ store', async () => {
    const service = await bootSpy();
    const loop = createSpyLoopAdapter(service);
    service.store.upsertTopic({
      topicId: 'finance-vi', label: 'Tài chính cá nhân VI', market: 'vi', language: 'vi',
    });

    const channelId = 'UCenriched000000000000a';
    service.store.upsertCandidate({
      channelId, title: 'Tiền Khôn', market: 'vi', discoveredVia: 'search_video',
      subscriberCount: 84_200, videoCount: 47, viewCount: null,
      country: 'VN', publishedAt: '2025-09-10T00:00:00.000Z', description: null,
    });
    // Provenance: kênh này ra từ keyword nào — thứ candidate_channels không ghi.
    service.store.addTopicChannelSource({
      topicId: 'finance-vi', channelId, relation: 'search_video', termKey: 'lai-kep',
    });
    // Provenance lưu term_key bỏ dấu; Inbox phải hiện lại display term có dấu.
    service.store.upsertTopicKeyword({
      topicId: 'finance-vi', termKey: 'lai-kep', displayTerm: 'lãi kép', relation: 'seed',
    });
    service.store.upsertTopicChannel({
      topicId: 'finance-vi',
      channelId,
      fitScore: 82,
      fitReasonsJson: JSON.stringify([{ factor: 'anchor_match', detail: 'tài chính × 8', points: 30 }]),
      facelessScore: null,                       // verdict — P0 luôn null
      facelessHint: 0.91,
      facelessHintReasonsJson: JSON.stringify({
        method: 'text_only',
        reasons: [{ kind: 'keyword', ref: 'faceless_titles', value: 0.8, weight: 0.4 }],
      }),
      thumbnailsJson: JSON.stringify([
        'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
        'https://i.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg',
      ]),
      learnValueScore: 87,
      learnValueReasonsJson: JSON.stringify({
        method: 'deterministic',
        sampleSize: 14,
        reasons: [{ factor: 'outperform_baseline', points: 34, max: 40, detail: 'median 3.1× kênh của mình', method: 'deterministic', sampleSize: 14 }],
      }),
      status: 'new',
      langDetected: 'vi',
      langConfidence: 0.97,
    });

    const [item] = (await loop.inbox({ topicId: 'finance-vi' })).items;
    if (!item) throw new Error('Inbox rỗng — fixture sai');

    // Provenance thật: keyword nào tìm ra kênh này.
    expect(item.foundVia).toEqual({ relation: 'search_video', term: 'lãi kép', fromChannelId: null });
    // Thumbnail thật, trần 6.
    expect(item.thumbnails).toEqual([
      'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
      'https://i.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg',
    ]);
    // Hợp đồng faceless: verdict null, hint có, và method đi kèm ra tới UI.
    expect(item.facelessScore).toBeNull();
    expect(item.facelessHint).toBeCloseTo(0.91);
    expect(item.facelessHintReasons[0]).toContain('chỉ đọc chữ');
    expect(item.facelessHintReasons.some((r) => r.includes('faceless_titles'))).toBe(true);
    // §7: không con số nào được thiếu nhãn nguồn.
    expect(item.learnValueScore).toBe(87);
    expect(item.learnValueReasons[0]).toContain('mẫu 14');
    expect(item.learnValueReasons.some((r) => r.includes('outperform_baseline'))).toBe(true);
    expect(item.fitReasons.some((r) => r.includes('anchor_match'))).toBe(true);
    expect(item.langDetected).toBe('vi');
  });

  test('langEvidence: chỉ declared_fields mới được coi là căn cứ loại kênh (G7)', async () => {
    const service = await bootSpy();
    const loop = createSpyLoopAdapter(service);
    service.store.upsertTopic({
      topicId: 'finance-vi', label: 'Tài chính cá nhân VI', market: 'vi', language: 'vi',
    });

    // (a) Bằng chứng cứng: đa số video TỰ KHAI defaultAudioLanguage=en → reject được.
    service.store.upsertTopicChannel({
      topicId: 'finance-vi', channelId: 'UCdeclared00000000000a', status: 'new',
      langDetected: 'en', langConfidence: 1,
      langEvidenceJson: JSON.stringify({
        method: 'declared_fields', evidenceField: 'defaultAudioLanguage',
        declaredByField: { defaultAudioLanguage: 12, defaultLanguage: 0 },
        declaredCount: 12, sampleSize: 12, majority: 'en',
      }),
    });
    // (b) Phỏng đoán từ title — KHÔNG BAO GIỜ được đọc như lý do reject.
    service.store.upsertTopicChannel({
      topicId: 'finance-vi', channelId: 'UCheuristic0000000000b', status: 'new',
      langDetected: 'en', langConfidence: 0.6,
      langEvidenceJson: JSON.stringify({
        method: 'title_heuristic', evidenceField: null,
        declaredByField: { defaultAudioLanguage: 1, defaultLanguage: 0 },
        declaredCount: 1, sampleSize: 9, majority: 'en',
      }),
    });
    // (c) Không đủ mẫu.
    service.store.upsertTopicChannel({
      topicId: 'finance-vi', channelId: 'UCthin00000000000000c', status: 'new',
      langEvidenceJson: JSON.stringify({
        method: 'insufficient_sample', evidenceField: null, declaredByField: {},
        declaredCount: 0, sampleSize: 2, majority: null,
      }),
    });

    const byId = new Map(
      (await loop.inbox({ topicId: 'finance-vi' })).items.map((i) => [i.channelId, i]),
    );

    const declared = byId.get('UCdeclared00000000000a')!;
    expect(declared.langEvidence?.canJustifyRejection).toBe(true);
    expect(declared.langEvidence?.evidenceField).toBe('defaultAudioLanguage');
    // Lý do phải nêu ĐÍCH DANH field, không chỉ nói "sai ngôn ngữ".
    expect(declared.langEvidence?.summary).toContain('defaultAudioLanguage');
    expect(declared.langEvidence?.summary).toContain('12/12');

    const heuristic = byId.get('UCheuristic0000000000b')!;
    expect(heuristic.langEvidence?.canJustifyRejection).toBe(false);
    expect(heuristic.langEvidence?.summary).toContain('không dùng để reject');

    const thin = byId.get('UCthin00000000000000c')!;
    expect(thin.langEvidence?.canJustifyRejection).toBe(false);
    expect(thin.langEvidence?.method).toBe('insufficient_sample');

    // Boolean tính sẵn phải LUÔN tái tính được từ `method` còn nguyên trong
    // payload — nếu luật đổi, không ai bị kẹt với một cờ không kiểm chứng nổi.
    for (const item of byId.values()) {
      if (!item.langEvidence) continue;
      expect(typeof item.langEvidence.method).toBe('string');
      expect(item.langEvidence.canJustifyRejection)
        .toBe(item.langEvidence.method === 'declared_fields');
    }

    // Kênh chưa có bằng chứng nào → null, không phải object rỗng giả vờ biết.
    service.store.upsertTopicChannel({ topicId: 'finance-vi', channelId: 'UCnone000000000000000d', status: 'new' });
    const none = (await loop.inbox({ topicId: 'finance-vi' })).items
      .find((i) => i.channelId === 'UCnone000000000000000d')!;
    expect(none.langEvidence).toBeNull();
  });

  test('addManualCandidates báo lại nguyên văn dòng không parse được, không gọi API', async () => {
    const service = await bootSpy();
    const loop = createSpyLoopAdapter(service);
    service.store.upsertTopic({
      topicId: 'finance-vi', label: 'Tài chính cá nhân VI', market: 'vi', language: 'vi',
    });

    const quotaBefore = JSON.stringify(service.quota.status());
    const result = await loop.addManualCandidates({
      topicId: 'finance-vi',
      inputs: ['  ', 'chỉ là chữ', 'https://vimeo.com/@ai-do'],
    });

    expect(result.added).toBe(0);
    expect(result.skippedKnown).toBe(0);
    expect(result.notFound).toEqual(['chỉ là chữ', 'https://vimeo.com/@ai-do']);
    // Không dòng nào resolve được → route thoát trước khi chạm Data API, nên
    // không có call nào và không có quota nào. Cũng độc lập với quy tắc bọc.
    expect(JSON.stringify(service.quota.status())).toBe(quotaBefore);
  });

  test('addManualCandidates từ chối topic không tồn tại trước khi tiêu quota', async () => {
    const service = await bootSpy();
    const loop = createSpyLoopAdapter(service);
    await expect(
      loop.addManualCandidates({ topicId: 'không-có', inputs: ['UC3pBgNay1YGUCvQmYMW6-lw'] }),
    ).rejects.toThrow(/không tồn tại/);
  });

  test('H4 — route dashboard persist manual_user XUỐNG ROW (đọc lại readonly)', async () => {
    root = await mkdtemp(join(tmpdir(), 'writer-room-cold-start-'));
    await mkdir(join(root, 'config'), { recursive: true });
    await mkdir(join(root, 'spy'), { recursive: true });

    const CHANNEL_ID = 'UCmanual00000000000001';
    const HANDLE = '@kenhthucong';
    const HANDLE_ID = 'UCmanual00000000000002';
    const catalogue = new Map<string, ChannelStatistics>([
      [CHANNEL_ID, fakeChannel(CHANNEL_ID, 'Kênh Dán Tay')],
      [HANDLE, fakeChannel(HANDLE_ID, 'Kênh Theo Handle')],
    ]);

    const service = new SpyService({
      dataRoot: join(root, 'spy'),
      dataApi: fakeDataApi(catalogue),
    });
    await service.init();
    spy = service;
    service.store.upsertTopic({
      topicId: 'finance-vi', label: 'Tài chính cá nhân VI', market: 'vi', language: 'vi',
    });

    // ROUTE THẬT: dựng handler như production, chỉ stub những nhánh route này
    // không đụng tới. `loop` và SPY_FEATURE là toàn bộ thứ nó dùng.
    const app: HttpApp = {
      spy: service,
      spyMcp: null,
      harness: {} as unknown as HttpApp['harness'],
      startedAt: Date.now(),
      webRoot: '',
      loopScheduler: null,
      loop: createSpyLoopAdapter(service),
    };
    const handler = createHandler(app);

    const response = await handler(new Request('http://127.0.0.1:4187/api/spy/loop/candidates/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topicId: 'finance-vi',
        inputs: [
          `https://www.youtube.com/channel/${CHANNEL_ID}`,  // URL
          HANDLE,                                            // @handle
          'không phải kênh',                                 // rác → notFound
        ],
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      added: 2, skippedKnown: 0, notFound: ['không phải kênh'],
    });

    // Đóng service để SQLite checkpoint xong rồi mới mở connection thứ hai.
    service.store.close();
    spy = undefined;

    // ── Bằng chứng ở TẦNG ROW, không phải DTO ────────────────────────────────
    const db = new Database(join(root, 'spy', 'spy.sqlite'), { readonly: true });
    try {
      for (const id of [CHANNEL_ID, HANDLE_ID]) {
        const candidate = db
          .query('SELECT discovered_via FROM candidate_channels WHERE channel_id = ?')
          .get(id) as { discovered_via: string } | null;
        expect(candidate).not.toBeNull();
        expect(candidate!.discovered_via).toBe('manual_user');

        const source = db
          .query('SELECT relation FROM topic_channel_sources WHERE topic_id = ? AND channel_id = ?')
          .get('finance-vi', id) as { relation: string } | null;
        expect(source).not.toBeNull();
        expect(source!.relation).toBe('manual_user');

        const topicChannel = db
          .query('SELECT status FROM topic_channels WHERE topic_id = ? AND channel_id = ?')
          .get('finance-vi', id) as { status: string } | null;
        expect(topicChannel).not.toBeNull();
        expect(topicChannel!.status).toBe('new');
      }

      // Không nhãn nào khác lọt vào từ đường này.
      const labels = db
        .query('SELECT DISTINCT discovered_via FROM candidate_channels')
        .all() as Array<{ discovered_via: string }>;
      expect(labels.map((r) => r.discovered_via).sort()).toEqual(['manual_user']);

      // Route đi qua `spy.channelsByIds` chính là để quota vào sổ. Nếu ai đó đổi
      // sang gọi thẳng adapter thì dòng này rỗng và test đỏ.
      const quota = db
        .query("SELECT bucket, calls FROM api_quota_usage WHERE bucket = 'general'")
        .all() as Array<{ bucket: string; calls: number }>;
      expect(quota.length).toBe(1);
      expect(quota[0]!.calls).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test('undo: decide(status=new) đưa kênh trở lại hàng chờ duyệt', async () => {
    const service = await bootSpy();
    const loop = createSpyLoopAdapter(service);
    service.store.upsertTopic({
      topicId: 'finance-vi', label: 'Tài chính cá nhân VI', market: 'vi', language: 'vi',
    });
    service.store.upsertChannel({
      channelId: 'UCcorpus0000000000000a', title: 'Kênh corpus 1',
      subscriberCount: 1000, videoCount: 10, totalViewCount: 1, fetchedAt: new Date().toISOString(),
    });
    await loop.importCorpus({ topicId: 'finance-vi' });

    await loop.decide({ topicId: 'finance-vi', channelIds: ['UCcorpus0000000000000a'], status: 'rejected' });
    expect((await loop.inbox({ topicId: 'finance-vi', status: 'new' })).items).toHaveLength(0);
    expect((await loop.inbox({ topicId: 'finance-vi', status: 'rejected' })).items).toHaveLength(1);

    // Phím `u` trên dashboard — không cần endpoint riêng.
    await loop.decide({ topicId: 'finance-vi', channelIds: ['UCcorpus0000000000000a'], status: 'new' });
    const back = await loop.inbox({ topicId: 'finance-vi', status: 'new' });
    expect(back.items.map((i) => i.channelId)).toEqual(['UCcorpus0000000000000a']);
  });
});
