/**
 * Test LoopScheduler với fake clock và mock SpyLoopAdapter.
 */
import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test';
import { LoopScheduler, isPastLocalHHMM, msUntilLocalHHMM } from '../../src/spy/loop-scheduler.ts';
import type { SpyLoopAdapter, TickResult, TopicConfig, LoopStatus } from '../../src/spy/loop-contract.ts';
import type { SpyService, TopicSettings } from '@writer-room/spy';
import { DEFAULT_TOPIC_SETTINGS, quotaDay } from '@writer-room/spy';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeTopic(overrides: Partial<TopicConfig> = {}): TopicConfig {
  return {
    topicId: 'finance-vi',
    label: 'Tài chính cá nhân VI',
    market: 'vi',
    language: 'vi',
    status: 'active',
    ownChannelIds: [],
    briefMd: '',
    facelessRequired: true,
    dailySearchBudget: 20,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function makeStatus(overrides: Partial<LoopStatus> = {}): LoopStatus {
  return {
    topicId: 'finance-vi',
    topicLabel: 'Tài chính cá nhân VI',
    topicStatus: 'active',
    lastTick: null,
    nextTickAt: null,
    inboxTotal: 0,
    activeTotal: 0,
    pausedTotal: 0,
    keywordsPending: 0,
    quota: {
      searchUsed: 0,
      searchBudget: 20,
      searchRemainingDay: 100,
      generalUsed: 0,
      generalLimit: 10_000,
    },
    ...overrides,
  };
}

function makeTickResult(overrides: Partial<TickResult> = {}): TickResult {
  return {
    tickId: 'tick-001',
    topicId: 'finance-vi',
    quotaDay: '2026-08-20',
    status: 'done',
    dryRun: false,
    searchCallsUsed: 0,
    generalUnitsUsed: 0,
    newCandidates: 0,
    newShortlistedAuto: 0,
    pendingReview: 0,
    autoRejected: 0,
    keywordsSearched: [],
    keywordsHarvested: 0,
    error: null,
    durationSec: 0,
    ...overrides,
  };
}

function makeLoopAdapter(options: {
  topics?: TopicConfig[];
  statuses?: LoopStatus[];
  tickResult?: TickResult;
  /** Override một phần TopicSettings — scheduler đọc dailyAt/weeklyAt từ đây. */
  settings?: Partial<TopicSettings>;
} = {}): SpyLoopAdapter {
  return {
    listTopics: mock(async () => options.topics ?? []),
    getTopic: mock(async (id: string) => options.topics?.find((t) => t.topicId === id) ?? null),
    upsertTopic: mock(async (cfg) => makeTopic({ ...cfg, status: cfg.status ?? 'active' })),
    status: mock(async (_id?: string) => options.statuses ?? []),
    topicSettings: mock(async (_id: string) => ({ ...DEFAULT_TOPIC_SETTINGS, ...options.settings })),
    inbox: mock(async () => ({ items: [], total: 0, nextCursor: null })),
    decide: mock(async () => ({ updated: 0 })),
    listKeywords: mock(async () => []),
    addKeyword: mock(async (p: { topicId: string; term: string }) => ({
      topicId: p.topicId, termKey: p.term, displayTerm: p.term, relation: 'seed',
      status: 'pending' as const, yieldChannels: 0, lastSearchedAt: null,
      addedAt: '2026-08-20T00:00:00.000Z', addedBy: 'user',
    })),
    decideKeyword: mock(async () => ({ updated: 0 })),
    tick: mock(async (_params: { topicId: string }) => options.tickResult ?? makeTickResult()),
    planTick: mock(async (topicId: string) => ({
      topicId, quotaDay: '2026-08-20', dryRun: true as const, steps: [],
      totalSearchCalls: 0, totalGeneralUnits: 0, canProceed: true, warnings: [],
    })),
    listReports: mock(async () => []),
    getReport: mock(async () => null),
    markDelivered: mock(async () => undefined),
    listStudied: mock(async () => []),
    addManualCandidates: mock(async () => ({ added: 0, skippedKnown: 0, notFound: [] })),
    importCorpus: mock(async () => ({ added: 0, skippedKnown: 0 })),
  };
}

let root = '';
let scheduler: LoopScheduler | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'writer-room-sched-'));
  await mkdir(join(root, 'config'), { recursive: true });
});

afterEach(async () => {
  scheduler?.dispose();
  scheduler = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('lịch theo giờ địa phương', () => {
  const TZ = 'Asia/Ho_Chi_Minh'; // UTC+7, không có DST

  test('isPastLocalHHMM đúng trên cả ngày, không chỉ 1 giờ sau mốc', () => {
    // 15:30 VN = 08:30 UTC
    const at = (utc: string) => new Date(utc);
    expect(isPastLocalHHMM('15:30', TZ, at('2026-08-20T08:29:00.000Z'))).toBe(false); // 15:29 VN
    expect(isPastLocalHHMM('15:30', TZ, at('2026-08-20T08:30:00.000Z'))).toBe(true);  // 15:30 VN
    expect(isPastLocalHHMM('15:30', TZ, at('2026-08-20T09:00:00.000Z'))).toBe(true);  // 16:00 VN
    // Đây là ca mà bản cũ (msToDue > 23h) trả SAI: mở app lúc 21:00 VN.
    expect(isPastLocalHHMM('15:30', TZ, at('2026-08-20T14:00:00.000Z'))).toBe(true);  // 21:00 VN
    expect(isPastLocalHHMM('15:30', TZ, at('2026-08-20T16:55:00.000Z'))).toBe(true);  // 23:55 VN
    expect(isPastLocalHHMM('15:30', TZ, at('2026-08-20T17:05:00.000Z'))).toBe(false); // 00:05 VN hôm sau
  });

  test('msUntilLocalHHMM luôn trả lần kế tiếp trong (0, 24h]', () => {
    const ms = msUntilLocalHHMM('15:30', TZ, new Date('2026-08-20T14:00:00.000Z')); // 21:00 VN
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 3600 * 1000);
    // 21:00 → 15:30 hôm sau = 18h30
    expect(Math.round(ms / 60000)).toBe(18 * 60 + 30);
  });
});

describe('LoopScheduler', () => {
  test('start() và dispose() không crash', () => {
    scheduler = new LoopScheduler({
      loop: makeLoopAdapter(),
      spy: {} as unknown as SpyService,
      dataDir: root,
    });
    expect(() => scheduler!.start()).not.toThrow();
    expect(() => scheduler!.dispose()).not.toThrow();
  });

  test('không chạy tick khi spy-loop.json.enabled=false', async () => {
    await writeFile(
      join(root, 'config', 'spy-loop.json'),
      JSON.stringify({ enabled: false, tickHourLocal: '00:00', digestHourLocal: '00:01', timezone: 'Asia/Ho_Chi_Minh' }),
    );
    const loop = makeLoopAdapter({ topics: [makeTopic()] });
    scheduler = new LoopScheduler({
      loop,
      spy: {} as unknown as SpyService,
      dataDir: root,
      now: () => new Date('2026-08-20T18:10:00.000Z'),
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 80));
    expect((loop.tick as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test('catch-up on boot: chạy tick khi đã qua giờ due và chưa tick hôm nay', async () => {
    await writeFile(
      join(root, 'config', 'spy-loop.json'),
      JSON.stringify({ enabled: true, tickHourLocal: '00:30', digestHourLocal: '08:00', timezone: 'Asia/Ho_Chi_Minh' }),
    );
    const loop = makeLoopAdapter({
      topics: [makeTopic()],
      statuses: [makeStatus({ lastTick: null })],
      // v3: giờ daily đọc từ settings của topic (tickHourLocal chỉ là fallback
      // khi không đọc được settings) — due 00:30 phải nằm ở dailyAt.
      settings: { dailyAt: '00:30' },
    });
    scheduler = new LoopScheduler({
      loop,
      spy: {} as unknown as SpyService,
      dataDir: root,
      // 2026-08-20 01:10 VN = đã qua 00:30
      now: () => new Date('2026-08-20T18:10:00.000Z'),
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 150));
    expect((loop.tick as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('không chạy tick khi topic paused', async () => {
    await writeFile(
      join(root, 'config', 'spy-loop.json'),
      JSON.stringify({ enabled: true, tickHourLocal: '00:30', digestHourLocal: '08:00', timezone: 'Asia/Ho_Chi_Minh' }),
    );
    const loop = makeLoopAdapter({
      topics: [makeTopic({ status: 'paused' })],
      statuses: [makeStatus({ topicStatus: 'paused', lastTick: null })],
    });
    scheduler = new LoopScheduler({
      loop,
      spy: {} as unknown as SpyService,
      dataDir: root,
      now: () => new Date('2026-08-20T18:10:00.000Z'),
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    expect((loop.tick as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test('catch-up on boot vẫn chạy khi mở app muộn (21:00, tick 15:30)', async () => {
    // Regression: bản cũ suy "đã qua giờ" bằng msToDue > 23h, nên chỉ nhận ra
    // trong đúng 1 giờ sau mốc. Mở app lúc 21:00 thì không bao giờ catch-up —
    // đúng cái kịch bản design §2.2 sinh ra tính năng này để phục vụ.
    await writeFile(
      join(root, 'config', 'spy-loop.json'),
      JSON.stringify({ enabled: true, tickHourLocal: '15:30', digestHourLocal: '08:00', timezone: 'Asia/Ho_Chi_Minh' }),
    );
    const loop = makeLoopAdapter({ topics: [makeTopic()], statuses: [makeStatus({ lastTick: null })] });
    scheduler = new LoopScheduler({
      loop,
      spy: {} as unknown as SpyService,
      dataDir: root,
      now: () => new Date('2026-08-20T14:00:00.000Z'), // 21:00 VN, 5h30 sau giờ tick
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 150));
    expect((loop.tick as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('không catch-up khi chưa tới giờ tick hôm nay', async () => {
    await writeFile(
      join(root, 'config', 'spy-loop.json'),
      JSON.stringify({ enabled: true, tickHourLocal: '15:30', digestHourLocal: '08:00', timezone: 'Asia/Ho_Chi_Minh' }),
    );
    const loop = makeLoopAdapter({ topics: [makeTopic()], statuses: [makeStatus({ lastTick: null })] });
    scheduler = new LoopScheduler({
      loop,
      spy: {} as unknown as SpyService,
      dataDir: root,
      now: () => new Date('2026-08-20T03:00:00.000Z'), // 10:00 VN, trước 15:30
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 120));
    expect((loop.tick as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test('digest 08:00 khớp report theo quota-day Pacific, không theo ngày UTC', async () => {
    // Regression: bản cũ lọc bằng `new Date().toISOString().slice(0,10)` (ngày UTC)
    // trong khi `daily_reports.report_date` được ghi bằng quotaDay() (ngày Pacific).
    // Ở giờ digest hai thứ đó LỆCH NHAU ĐÚNG MỘT NGÀY, nên bộ lọc không khớp
    // report nào và digest im lặng không bao giờ gửi.
    //
    // 08:00 VN 22-08 = 01:00Z 22-08 = 18:00 PDT 21-08 → quota-day '2026-08-21'.
    // Tick 15:30 VN 21-08 = 08:30Z 21-08 = 01:30 PDT 21-08 → cũng '2026-08-21'.
    // Ngày UTC lúc đó là '2026-08-22' → khớp 0 report.
    const digestMoment = new Date('2026-08-22T01:00:00.000Z');
    expect(digestMoment.toISOString().slice(0, 10)).toBe('2026-08-22'); // cái bản cũ dùng
    expect(quotaDay(digestMoment)).toBe('2026-08-21');                  // cái đúng

    await writeFile(
      join(root, 'config', 'spy-loop.json'),
      JSON.stringify({
        enabled: true, tickHourLocal: '15:30', digestHourLocal: '08:00',
        timezone: 'Asia/Ho_Chi_Minh',
        telegram: { botToken: 'tok', chatId: '-100', enabled: true },
      }),
    );

    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      sent.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const loop = makeLoopAdapter({ topics: [makeTopic()], statuses: [makeStatus()] });
      loop.listReports = mock(async () => [{
        reportId: 'rpt-001',
        reportDate: '2026-08-21',   // quota-day của tick hôm trước
        topicId: 'finance-vi',
        summary: null,
        markdown: '📊 Spy Loop — Tài chính cá nhân VI — 2026-08-21',
        createdAt: '2026-08-21T08:47:00.000Z',
        deliveredJson: { telegram: '2026-08-21T08:47:30.000Z' },
      }]);
      // Tham số phải khai tường minh, nếu không `mock` suy ra tuple rỗng và
      // `mock.calls[0][1]` không typecheck được.
      const marked = mock(async (_reportId: string, _channel: string, _ts: string) => undefined);
      loop.markDelivered = marked;

      scheduler = new LoopScheduler({
        loop, spy: {} as unknown as SpyService, dataDir: root, now: () => digestMoment,
      });
      scheduler.start();
      await new Promise((r) => setTimeout(r, 200));

      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(marked.mock.calls.length).toBeGreaterThanOrEqual(1);
      // Đóng dấu bằng khoá RIÊNG của digest → không đụng idempotency của tick report.
      expect(marked.mock.calls[0]![1]).toBe('telegram_digest');
      expect(marked.mock.calls[0]![0]).toBe('rpt-001');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('digest không gửi lại report đã có dấu telegram_digest', async () => {
    await writeFile(
      join(root, 'config', 'spy-loop.json'),
      JSON.stringify({
        enabled: true, tickHourLocal: '15:30', digestHourLocal: '08:00',
        timezone: 'Asia/Ho_Chi_Minh',
        telegram: { botToken: 'tok', chatId: '-100', enabled: true },
      }),
    );
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      sent.push('x');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const loop = makeLoopAdapter({ topics: [makeTopic()], statuses: [makeStatus()] });
      loop.listReports = mock(async () => [{
        reportId: 'rpt-001', reportDate: '2026-08-21', topicId: 'finance-vi',
        summary: null, markdown: 'x', createdAt: '2026-08-21T08:47:00.000Z',
        deliveredJson: { telegram_digest: '2026-08-22T01:00:00.000Z' },
      }]);
      scheduler = new LoopScheduler({
        loop, spy: {} as unknown as SpyService, dataDir: root,
        now: () => new Date('2026-08-22T01:00:00.000Z'),
      });
      scheduler.start();
      await new Promise((r) => setTimeout(r, 200));
      expect(sent.length).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('isRunning lock ngăn double-tick', async () => {
    let resolveTickFn!: () => void;
    const slowTickMock = mock(async (_p: { topicId: string }) => {
      await new Promise<void>((resolve) => { resolveTickFn = resolve; });
      return makeTickResult({ tickId: 'tick-slow' });
    });
    const loop = makeLoopAdapter();
    const patchedLoop: SpyLoopAdapter = { ...loop, tick: slowTickMock };

    scheduler = new LoopScheduler({
      loop: patchedLoop,
      spy: {} as unknown as SpyService,
      dataDir: root,
    });

    expect(scheduler.isRunning('finance-vi')).toBe(false);
    const tickPromise = scheduler.runTick('finance-vi');
    expect(scheduler.isRunning('finance-vi')).toBe(true);

    // Chạy lại trong khi đang chạy → không tạo tick mới
    const result2 = await scheduler.runTick('finance-vi');
    expect(result2).toBeNull();

    resolveTickFn();
    await tickPromise;
    expect(scheduler.isRunning('finance-vi')).toBe(false);
  });

  test('v3: daily tick truyền mode=daily, weekly chỉ chạy đúng thứ của weekly_at', async () => {
    // 2026-08-20 = Thứ Năm; 2026-08-23 = Chủ nhật (CN). Settings mặc định
    // weeklyAt='CN 16:00' → weekly chỉ due ngày CN.
    await writeFile(
      join(root, 'config', 'spy-loop.json'),
      JSON.stringify({ enabled: true, tickHourLocal: '00:30', digestHourLocal: '08:00', timezone: 'Asia/Ho_Chi_Minh' }),
    );
    const loop = makeLoopAdapter({
      topics: [makeTopic()], statuses: [makeStatus()],
      settings: { dailyAt: '00:30' },
    });
    scheduler = new LoopScheduler({
      loop,
      spy: {} as unknown as SpyService,
      dataDir: root,
      // 21-08 (Thứ Sáu) 01:10 VN — qua daily 00:30, KHÔNG phải CN.
      now: () => new Date('2026-08-20T18:10:00.000Z'),
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 150));
    const fridayCalls = (loop.tick as ReturnType<typeof mock>).mock.calls;
    expect(fridayCalls.length).toBe(1);
    expect(fridayCalls[0]![0].mode).toBe('daily');
    scheduler.dispose();

    // CN 23-08 17:00 VN = 10:00Z — qua cả daily (mặc định 15:30 từ settings)
    // lẫn weekly (CN 16:00) → đúng 2 tick, mode khác nhau.
    const loop2 = makeLoopAdapter({ topics: [makeTopic()], statuses: [makeStatus()] });
    scheduler = new LoopScheduler({
      loop: loop2,
      spy: {} as unknown as SpyService,
      dataDir: root,
      now: () => new Date('2026-08-23T10:00:00.000Z'),
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 150));
    const sundayModes = (loop2.tick as ReturnType<typeof mock>).mock.calls.map((c) => c[0].mode);
    expect(sundayModes.sort()).toEqual(['daily', 'weekly']);
  });

  test('v3: bỏ qua nhịp đã tick trong quota-day (lastTickByMode), nhịp kia vẫn chạy', async () => {
    await writeFile(
      join(root, 'config', 'spy-loop.json'),
      JSON.stringify({ enabled: true, tickHourLocal: '00:30', digestHourLocal: '08:00', timezone: 'Asia/Ho_Chi_Minh' }),
    );
    // CN 23-08: daily đã chạy (quotaDay hôm nay), weekly chưa → chỉ weekly due.
    const todayQd = quotaDay(new Date('2026-08-23T10:00:00.000Z'));
    const loop = makeLoopAdapter({
      topics: [makeTopic()],
      statuses: [makeStatus({
        lastTickByMode: {
          daily: {
            tickId: 'tick-daily', quotaDay: todayQd, status: 'done',
            step: 'report', startedAt: '2026-08-23T08:31:00.000Z',
            finishedAt: '2026-08-23T08:40:00.000Z', error: null,
          },
        },
      })],
    });
    scheduler = new LoopScheduler({
      loop,
      spy: {} as unknown as SpyService,
      dataDir: root,
      now: () => new Date('2026-08-23T10:00:00.000Z'),
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 150));
    const modes = (loop.tick as ReturnType<typeof mock>).mock.calls.map((c) => c[0].mode);
    expect(modes).toEqual(['weekly']);
  });
});
