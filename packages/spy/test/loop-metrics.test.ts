/**
 * loop-metrics.test.ts — hàm thuần của pipeline v3-lean (plan §3, §6 tiêu chí 3).
 *
 * baselineOf / outlierScore / viewsGained24h / harvestNgrams không I/O — test
 * chỉ đưa dữ liệu vào và so kết quả.
 */
import { describe, expect, test } from 'bun:test';
import {
  baselineOf,
  harvestNgrams,
  outlierScore,
  viewsGained24h,
  type BaselineVideoInput,
} from '../src/loop/metrics.ts';
import { DEFAULT_TOPIC_SETTINGS } from '../src/store.ts';

const S = DEFAULT_TOPIC_SETTINGS;

function vid(views: number | null, extra: Partial<BaselineVideoInput> = {}): BaselineVideoInput {
  return { views, durationSec: 600, publishedAt: '2026-08-20T00:00:00.000Z', ...extra };
}

describe('baselineOf', () => {
  test('median trên video đủ dài, bỏ Shorts và video thiếu view', () => {
    const videos = [
      vid(1_000), vid(2_000), vid(3_000),
      vid(999_999, { durationSec: 30 }),  // Short — loại khỏi baseline
      vid(null),                         // thiếu view — loại
    ];
    const b = baselineOf(videos, { ...S, baselineMinN: 3 });
    expect(b.medianViews).toBe(2_000);
    expect(b.n).toBe(3);
    expect(b.maxViews).toBe(3_000);
    expect(b.reliable).toBe(true);
    expect(b.dead).toBe(false);
    expect(b.lottery).toBe(false);
  });

  test('cửa sổ baselineWindow chỉ lấy video MỚI NHẤT', () => {
    // 5 video, window=3 → lấy 3 video có publishedAt mới nhất (views 10,20,30).
    const videos = [
      vid(10, { publishedAt: '2026-08-19T00:00:00.000Z' }),
      vid(20, { publishedAt: '2026-08-18T00:00:00.000Z' }),
      vid(30, { publishedAt: '2026-08-17T00:00:00.000Z' }),
      vid(999_000, { publishedAt: '2026-01-01T00:00:00.000Z' }), // cũ → ngoài window
      vid(888_000, { publishedAt: '2025-12-01T00:00:00.000Z' }), // cũ → ngoài window
    ];
    const b = baselineOf(videos, { ...S, baselineWindow: 3, baselineMinN: 3 });
    expect(b.n).toBe(3);
    expect(b.medianViews).toBe(20);
    expect(b.maxViews).toBe(30);
  });

  test('reliable=false khi n < baselineMinN — không kết luận dead/lottery', () => {
    // median thấp nhưng mẫu mỏng → không được gọi là dead.
    const b = baselineOf([vid(10), vid(20)], { ...S, baselineMinN: 10 });
    expect(b.reliable).toBe(false);
    expect(b.dead).toBe(false);
    expect(b.lottery).toBe(false);
    expect(b.medianViews).toBe(15);
    expect(b.n).toBe(2);
  });

  test('dead khi median < deadMedian (đủ mẫu)', () => {
    const videos = Array.from({ length: 10 }, () => vid(100));
    const b = baselineOf(videos, { ...S, baselineMinN: 10, deadMedian: 500 });
    expect(b.reliable).toBe(true);
    expect(b.dead).toBe(true);
  });

  test('lottery khi max/median > lotteryRatio (đủ mẫu)', () => {
    const videos = [
      ...Array.from({ length: 9 }, () => vid(1_000)),
      vid(60_000), // 1 video viral → max/median = 60 > 50
    ];
    const b = baselineOf(videos, { ...S, baselineMinN: 10, lotteryRatio: 50 });
    expect(b.reliable).toBe(true);
    expect(b.lottery).toBe(true);
    expect(b.dead).toBe(false);
  });

  test('median=0 → dead chứ không lottery (tỷ lệ vô nghĩa)', () => {
    const videos = [...Array.from({ length: 9 }, () => vid(0)), vid(500)];
    const b = baselineOf(videos, { ...S, baselineMinN: 10 });
    expect(b.dead).toBe(true);
    expect(b.lottery).toBe(false);
  });

  test('kênh không có video hợp lệ → n=0, mọi cờ false', () => {
    const b = baselineOf([vid(null), vid(100, { durationSec: 10 })], S);
    expect(b).toEqual({ medianViews: null, n: 0, maxViews: null, reliable: false, dead: false, lottery: false });
  });
});

describe('outlierScore', () => {
  const baseline = { medianViews: 1_000, reliable: true };

  test('views / baseline_median, làm tròn 2 chữ số', () => {
    expect(outlierScore(3_000, baseline)).toBe(3);
    expect(outlierScore(3_333, baseline)).toBe(3.33);
  });

  test('NULL khi baseline chưa tin cậy hoặc median rỗng/không dương', () => {
    expect(outlierScore(9_000, { medianViews: 1_000, reliable: false })).toBeNull();
    expect(outlierScore(9_000, { medianViews: null, reliable: true })).toBeNull();
    expect(outlierScore(9_000, { medianViews: 0, reliable: true })).toBeNull();
  });

  test('NULL khi views rỗng', () => {
    expect(outlierScore(null, baseline)).toBeNull();
    expect(outlierScore(undefined, baseline)).toBeNull();
  });
});

describe('viewsGained24h', () => {
  test('NULL khi <2 snapshot (acceptance §6.3 — video mới không có tốc độ)', () => {
    expect(viewsGained24h([])).toBeNull();
    expect(viewsGained24h([{ day: '2026-08-20', views: 1_000 }])).toBeNull();
  });

  test('delta view giữa 2 snapshot liền nhau', () => {
    // listVideoDailyViews trả DESC — hàm tự sort nên thứ tự vào không quan trọng.
    expect(viewsGained24h([
      { day: '2026-08-19', views: 1_000 },
      { day: '2026-08-20', views: 1_500 },
    ])).toBe(500);
  });

  test('chuẩn hoá theo số ngày giữa 2 snapshot — bỏ lỡ ngày quét không phình số', () => {
    // 3 ngày cách nhau, +900 view → 300/ngày, không phải 900.
    expect(viewsGained24h([
      { day: '2026-08-17', views: 1_000 },
      { day: '2026-08-20', views: 1_900 },
    ])).toBe(300);
  });

  test('kẹp tối thiểu 1 ngày — snapshot trùng ngày không chia cho 0', () => {
    // Trùng ngày: phần tử đứng TRƯỚC sau sort (stable) là "latest".
    expect(viewsGained24h([
      { day: '2026-08-20', views: 1_200 },
      { day: '2026-08-20', views: 1_000 },
    ])).toBe(200);
  });

  test('snapshot hỏng (day lạ, view NaN) bị lọc trước khi đếm', () => {
    expect(viewsGained24h([
      { day: 'không-phải-ngày', views: 1 },
      { day: '2026-08-20', views: 1_500 },
    ])).toBeNull();
  });
});

describe('harvestNgrams', () => {
  const v = (videoId: string, title: string) => ({ videoId, title });

  test('cụm xuất hiện ở ≥minChannels nhóm → hit; ít hơn bị loại', () => {
    const map = new Map([
      ['chA', [v('v1', 'Cách vay trả góp mua xe'), v('v2', 'vay trả góp lãi suất')]],
      ['chB', [v('v3', 'Nên vay trả góp không'), v('v4', 'mẹo khác')]],
      ['chC', [v('v5', 'vay trả góp ngân hàng')]],
    ]);
    const hits = harvestNgrams(map, 2);
    const term = hits.find((h) => h.termKey === 'vay_tra_gop');
    expect(term).toBeDefined();
    expect(term!.nChannels).toBe(3);
    expect(term!.nVideos).toBe(4);
    expect(term!.sampleVideoIds.length).toBeGreaterThan(0);
    // minChannels=4 → không hit nào đủ phủ
    expect(harvestNgrams(map, 4)).toEqual([]);
  });

  test('một kênh lặp cùng cụm nhiều lần vẫn chỉ tính 1 nhóm', () => {
    const map = new Map([
      ['chA', [v('v1', 'vay trả góp'), v('v2', 'vay trả góp xe máy'), v('v3', 'vay trả góp online')]],
    ]);
    // minChannels=2 → pattern của MỘT kênh không đủ tư cách làm keyword.
    expect(harvestNgrams(map, 2)).toEqual([]);
    const hits = harvestNgrams(map, 1);
    const term = hits.find((h) => h.termKey === 'vay_tra_gop');
    expect(term!.nChannels).toBe(1);
    expect(term!.nVideos).toBe(3);
  });

  test('termKey normalize bỏ dấu + lowercase; display là dạng hay gặp nhất', () => {
    const map = new Map([
      ['chA', [v('v1', 'Lãi Kép nhanh'), v('v2', 'lãi kép đầu tư')]],
      ['chB', [v('v3', 'lãi kép cho người mới')]],
    ]);
    const hits = harvestNgrams(map, 2);
    const term = hits.find((h) => h.termKey === 'lai_kep');
    expect(term).toBeDefined();
    // 'lãi kép' xuất hiện 2 lần, 'Lãi Kép' 1 lần → display lowercase.
    expect(term!.display).toBe('lãi kép');
  });

  test('stopword không được làm thành phần n-gram', () => {
    const map = new Map([
      ['chA', [v('v1', 'cách để vay mua nhà')]],
      ['chB', [v('v2', 'cách để vay mua xe')]],
    ]);
    // 'cách để' chứa stopword 'để' → không thành cụm.
    expect(harvestNgrams(map, 2).find((h) => h.termKey.includes('de'))).toBeUndefined();
  });

  test('n-gram tối đa 3 từ; sắp xếp theo nChannels rồi nVideos', () => {
    const map = new Map([
      ['chA', [v('v1', 'vay mua nhà trả góp'), v('v2', 'mẹo vay mua nhà')]],
      ['chB', [v('v3', 'vay mua nhà trả góp')]],
    ]);
    const hits = harvestNgrams(map, 2);
    const bigram = hits.find((h) => h.termKey === 'vay_mua_nha');
    const trigram = hits.find((h) => h.termKey === 'mua_nha_tra');
    expect(bigram).toBeDefined();
    expect(trigram).toBeDefined();
    // Không hit nào dài quá 3 từ (termKey nối bằng '_').
    expect(Math.max(...hits.map((h) => h.termKey.split('_').length))).toBe(3);
    // 'mua_nha', 'vay_mua', 'vay_mua_nha' cùng nChannels=2, nVideos=3
    // → tie-break theo termKey (alphabet): 'mua_nha' đứng trước.
    expect(hits[0]!.termKey).toBe('mua_nha');
  });

  test('weekly W4: key mỗi video một nhóm → nChannels = số video chứa cụm', () => {
    const map = new Map([
      ['vid1', [v('vid1', 'vay trả góp mua xe')]],
      ['vid2', [v('vid2', 'vay trả góp mua nhà')]],
      ['vid3', [v('vid3', 'kênh khác')]],
    ]);
    const hits = harvestNgrams(map, 2);
    const term = hits.find((h) => h.termKey === 'vay_tra_gop');
    expect(term!.nChannels).toBe(2);
    expect(term!.sampleVideoIds.sort()).toEqual(['vid1', 'vid2']);
  });
});
