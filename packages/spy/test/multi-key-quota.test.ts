import { describe, expect, test } from 'bun:test';
import { QuotaLedger, KeyPool, keyId, QUOTA_LIMITS } from '../src/quota.ts';
import { SpyStore } from '../src/store.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Multi-key quota rotation', () => {
  let dir: string;
  let store: SpyStore;

  const setup = async () => {
    dir = await mkdtemp(join(tmpdir(), 'spy-multikey-'));
    store = new SpyStore(join(dir, 'spy.sqlite'));
    return store;
  };

  const teardown = async () => {
    store?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  };

  // -----------------------------------------------------------------------
  // KeyPool basics
  // -----------------------------------------------------------------------

  test('KeyPool — empty pool', () => {
    const pool = new KeyPool([]);
    expect(pool.isEmpty).toBe(true);
    expect(pool.size).toBe(0);
    expect(pool.currentKey).toBeUndefined();
  });

  test('KeyPool — filters blank keys', () => {
    const pool = new KeyPool(['key1', '', '  ', 'key2']);
    expect(pool.size).toBe(2);
    expect(pool.allKeyIds).toEqual([keyId('key1'), keyId('key2')]);
  });

  test('keyId — last 4 chars', () => {
    expect(keyId('AIzaSyAsODzXmH6phEvXI-5lOIvrvZ9DpTkZ4Yg')).toBe('Z4Yg');
    expect(keyId('AIzaSyAsODzXmH6phEvXI-5lOIvrvZ9DpTkZ4Yg')).toHaveLength(4);
    expect(keyId('ab')).toBe('ab'); // short key fallback
  });

  // -----------------------------------------------------------------------
  // effectiveLimit scales with number of keys
  // -----------------------------------------------------------------------

  test('effectiveLimit — single key = base limit', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      expect(ledger.effectiveLimit('search')).toBe(100);
      expect(ledger.effectiveLimit('general')).toBe(10_000);
    } finally {
      await teardown();
    }
  });

  test('effectiveLimit — 3 keys = 3× base limit', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const pool = new KeyPool(['keyA', 'keyB', 'keyC']);
      ledger.setKeyPool(pool);
      expect(ledger.effectiveLimit('search')).toBe(300);
      expect(ledger.effectiveLimit('general')).toBe(30_000);
    } finally {
      await teardown();
    }
  });

  test('effectiveLimit — 5 keys = 5× base limit', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const pool = new KeyPool(['k1', 'k2', 'k3', 'k4', 'k5']);
      ledger.setKeyPool(pool);
      expect(ledger.effectiveLimit('search')).toBe(500);
      expect(ledger.effectiveLimit('general')).toBe(50_000);
    } finally {
      await teardown();
    }
  });

  // -----------------------------------------------------------------------
  // remaining / canAfford use effective limit
  // -----------------------------------------------------------------------

  test('remaining — reflects effective limit with 3 keys', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const pool = new KeyPool(['keyA', 'keyB', 'keyC']);
      ledger.setKeyPool(pool);

      // Fresh: 300 remaining
      expect(ledger.remaining('search')).toBe(300);

      // Consume 150 aggregate → 150 remaining
      store.addQuotaUsage('search', '2026-09-13', 150, 150);
      // remaining uses quotaDay() which is Pacific time, so force a known day
      const now = new Date('2026-09-13T20:00:00Z'); // Pacific = 2026-09-13
      store.addQuotaUsage('search', '2026-09-13', 0, 0); // ensure row exists
      // Use direct store to set known values
      expect(ledger.remaining('search', now)).toBe(150);
    } finally {
      await teardown();
    }
  });

  test('canAfford — true when aggregate < effective limit', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const pool = new KeyPool(['keyA', 'keyB', 'keyC']);
      ledger.setKeyPool(pool);

      // With 3 keys: can afford 200 search calls (200 < 300)
      expect(ledger.canAfford('search.list', 200)).toBe(true);
      // Can't afford 301
      expect(ledger.canAfford('search.list', 301)).toBe(false);
    } finally {
      await teardown();
    }
  });

  // -----------------------------------------------------------------------
  // Per-key consume
  // -----------------------------------------------------------------------

  test('consumeForKey — tracks per key independently', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const pool = new KeyPool(['keyA', 'keyB']);
      ledger.setKeyPool(pool);

      const kidA = keyId('keyA');
      const kidB = keyId('keyB');

      // Consume 50 on key A
      for (let i = 0; i < 50; i++) {
        ledger.consumeForKey(kidA, 'search.list');
      }
      expect(ledger.remainingForKey(kidA, 'search')).toBe(50);
      expect(ledger.remainingForKey(kidB, 'search')).toBe(100);

      // Aggregate remaining = 200 - 50 = 150
      expect(ledger.remaining('search')).toBe(150);
    } finally {
      await teardown();
    }
  });

  test('consumeForKey — throws when key exhausted', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);

      const kid = keyId('keyA');

      // Exhaust key A
      for (let i = 0; i < 100; i++) {
        ledger.consumeForKey(kid, 'search.list');
      }

      // 101st call should throw
      expect(() => ledger.consumeForKey(kid, 'search.list')).toThrow('hết quota');
    } finally {
      await teardown();
    }
  });

  // -----------------------------------------------------------------------
  // KeyPool.pickAvailableKey — auto rotation
  // -----------------------------------------------------------------------

  test('pickAvailableKey — rotates when current key exhausted', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const pool = new KeyPool(['keyAAAA', 'keyBBBB']);
      ledger.setKeyPool(pool);

      // Exhaust key A
      const kidA = keyId('keyAAAA');
      for (let i = 0; i < 100; i++) {
        ledger.consumeForKey(kidA, 'search.list');
      }

      // Pick should skip A and return B
      const picked = pool.pickAvailableKey(ledger, 'search.list');
      expect(picked).toBe('keyBBBB');
    } finally {
      await teardown();
    }
  });

  test('pickAvailableKey — returns null when all keys exhausted', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const pool = new KeyPool(['keyAAAA', 'keyBBBB']);
      ledger.setKeyPool(pool);

      // Exhaust both
      for (const k of ['keyAAAA', 'keyBBBB']) {
        const kid = keyId(k);
        for (let i = 0; i < 100; i++) {
          ledger.consumeForKey(kid, 'search.list');
        }
      }

      expect(pool.pickAvailableKey(ledger, 'search.list')).toBeNull();
    } finally {
      await teardown();
    }
  });

  // -----------------------------------------------------------------------
  // status / statusPerKey
  // -----------------------------------------------------------------------

  test('status — shows effective limit × numKeys', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const pool = new KeyPool(['keyA', 'keyB', 'keyC']);
      ledger.setKeyPool(pool);

      const s = ledger.status();
      const searchBucket = s.buckets.find((b) => b.bucket === 'search')!;
      expect(searchBucket.limit).toBe(300);
      expect(searchBucket.remaining).toBe(300);
      expect(s.note).toContain('3 key');
    } finally {
      await teardown();
    }
  });

  test('statusPerKey — breakdown per key', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const pool = new KeyPool(['keyA', 'keyB']);
      ledger.setKeyPool(pool);

      // Consume some on key A
      ledger.consumeForKey(keyId('keyA'), 'search.list', 30);

      const perKey = ledger.statusPerKey(['keyA', 'keyB']);
      expect(perKey.keys).toHaveLength(2);
      expect(perKey.totalSearchRemaining).toBe(170); // 70 + 100

      const keyAStatus = perKey.keys.find((k) => k.keyId === keyId('keyA'))!;
      const searchA = keyAStatus.buckets.find((b) => b.bucket === 'search')!;
      expect(searchA.used).toBe(30);
      expect(searchA.remaining).toBe(70);
    } finally {
      await teardown();
    }
  });

  // -----------------------------------------------------------------------
  // Store per-key methods
  // -----------------------------------------------------------------------

  test('store — addQuotaUsagePerKey updates both per-key and aggregate', async () => {
    await setup();
    try {
      const day = '2026-09-13';
      store.addQuotaUsagePerKey('AAAA', 'search', day, 10, 10);
      store.addQuotaUsagePerKey('BBBB', 'search', day, 20, 20);

      // Per-key
      expect(store.getQuotaUsagePerKey('AAAA', 'search', day).units).toBe(10);
      expect(store.getQuotaUsagePerKey('BBBB', 'search', day).units).toBe(20);

      // Aggregate = sum
      expect(store.getQuotaUsage('search', day).units).toBe(30);

      // List
      const list = store.listQuotaUsagePerKey(day);
      expect(list).toHaveLength(2);
    } finally {
      await teardown();
    }
  });
});
