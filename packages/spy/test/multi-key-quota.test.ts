import { describe, expect, test } from 'bun:test';
import { QuotaLedger, KeyPool, keyId, QUOTA_LIMITS } from '../src/quota.ts';
import { SpyStore } from '../src/store.ts';
import { AppError } from '../src/errors.ts';
import { QuotaCountingDataApi } from '../src/adapters/quota-counting-data-api.ts';
import type { YouTubeDataApiPort, SearchHit } from '../src/adapters/data-api.ts';
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

  // -----------------------------------------------------------------------
  // QuotaLedger.markKeyExhausted — force a key to 0 remaining for today
  // -----------------------------------------------------------------------

  test('markKeyExhausted — forces remaining to 0 regardless of the client-side counter', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const kid = keyId('keyAAAA');

      // Client-side counter thinks there are 8 searches left.
      for (let i = 0; i < 92; i++) ledger.consumeForKey(kid, 'search.list');
      expect(ledger.remainingForKey(kid, 'search')).toBe(8);

      // Google actually already 403'd this key for real — mark it exhausted.
      ledger.markKeyExhausted(kid, 'search');
      expect(ledger.remainingForKey(kid, 'search')).toBe(0);
      expect(ledger.canAffordForKey(kid, 'search.list')).toBe(false);
    } finally {
      await teardown();
    }
  });

  test('markKeyExhausted — is a no-op (never goes negative) when already at/over limit', async () => {
    await setup();
    try {
      const ledger = new QuotaLedger(store);
      const kid = keyId('keyAAAA');
      for (let i = 0; i < 100; i++) ledger.consumeForKey(kid, 'search.list');
      ledger.markKeyExhausted(kid, 'search');
      expect(ledger.remainingForKey(kid, 'search')).toBe(0);
    } finally {
      await teardown();
    }
  });

  // -----------------------------------------------------------------------
  // QuotaCountingDataApi.search — rotation-on-real-quota-error (the bug)
  //
  // Repro: client-side counter says key1 still has headroom (8 remaining),
  // but Google's REAL quota for key1 is already exhausted. Before the fix,
  // the 403 from key1 propagated straight up and the caller fell back to
  // yt-dlp without ever trying key2/key3. The fix must retry the SAME
  // request on the next key with remaining quota and mark key1 exhausted.
  // -----------------------------------------------------------------------

  describe('QuotaCountingDataApi — key rotation on real Google quota errors', () => {
    class KeySensitiveFakeApi implements YouTubeDataApiPort {
      currentKey = '';
      /** keyIds (last 4 chars) that 403 with a real quota error on this API. */
      quotaExhaustedKeys = new Set<string>();
      /** keyIds that 403 with an invalid-key error. */
      invalidKeys = new Set<string>();
      searchAttempts: string[] = [];

      async search(_input: unknown): Promise<{ hits: SearchHit[]; nextPageToken: string | null }> {
        const kid = keyId(this.currentKey);
        this.searchAttempts.push(kid);
        if (this.quotaExhaustedKeys.has(kid)) {
          throw new AppError('quota_exceeded', `Key ...${kid} thật sự hết quota (403 quotaExceeded)`, { retryable: false });
        }
        if (this.invalidKeys.has(kid)) {
          throw new AppError('unauthorized', `Key ...${kid} sai (403 keyInvalid)`, { retryable: false });
        }
        return { hits: [], nextPageToken: null };
      }

      async fetchVideoStatistics() { return new Map(); }
      async fetchChannelStatistics() { return new Map(); }
    }

    function buildRig(keys: string[]) {
      const store2 = store; // shared per-test store from outer setup/teardown
      const ledger = new QuotaLedger(store2);
      const pool = new KeyPool(keys);
      ledger.setKeyPool(pool);
      const fake = new KeySensitiveFakeApi();
      const counting = new QuotaCountingDataApi(fake, ledger, () => true);
      counting.setKeyPool(pool, (key) => { fake.currentKey = key; });
      return { ledger, pool, fake, counting };
    }

    test('key1 403s (real quota) while client counter still says remaining → succeeds on key2, key1 marked exhausted', async () => {
      await setup();
      try {
        const keys = ['AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAZ4Yg', 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBCjmw', 'AIzaSyCCCCCCCCCCCCCCCCCCCCCCCCCCCCWDNw'];
        const { ledger, fake, counting, pool } = buildRig(keys);
        const kid1 = keyId(keys[0]!);
        const kid2 = keyId(keys[1]!);

        // Client-side ledger still thinks key1 has 8 search calls left.
        for (let i = 0; i < 92; i++) ledger.consumeForKey(kid1, 'search.list');
        expect(ledger.remainingForKey(kid1, 'search')).toBe(8);

        fake.quotaExhaustedKeys.add(kid1);

        const result = await counting.search({ q: 'x', type: 'video' });
        expect(result).toEqual({ hits: [], nextPageToken: null });

        // Rotated: attempted key1 first (still had client-side headroom), then key2.
        expect(fake.searchAttempts).toEqual([kid1, kid2]);
        // key1 is now marked exhausted for the rest of today regardless of the
        // client-side counter that was wrong.
        expect(ledger.remainingForKey(kid1, 'search')).toBe(0);
        expect(pool.currentKeyId).toBe(kid2);
      } finally {
        await teardown();
      }
    });

    test('all keys exhausted (real quota errors) → throws quota_exceeded with allKeysExhausted + triedKeyIds', async () => {
      await setup();
      try {
        const keys = ['AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAZ4Yg', 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBCjmw'];
        const { fake, counting } = buildRig(keys);
        fake.quotaExhaustedKeys.add(keyId(keys[0]!));
        fake.quotaExhaustedKeys.add(keyId(keys[1]!));

        await expect(counting.search({ q: 'x', type: 'video' })).rejects.toMatchObject({
          code: 'quota_exceeded',
          details: expect.objectContaining({
            allKeysExhausted: true,
            triedKeyIds: [keyId(keys[0]!), keyId(keys[1]!)],
          }),
        });
        expect(fake.searchAttempts).toEqual([keyId(keys[0]!), keyId(keys[1]!)]);
      } finally {
        await teardown();
      }
    });

    test('invalid key (keyInvalid) is skipped like a quota error and reported, but distinct code upstream', async () => {
      await setup();
      try {
        const keys = ['AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAZ4Yg', 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBCjmw'];
        const { fake, counting, pool } = buildRig(keys);
        fake.invalidKeys.add(keyId(keys[0]!));

        const result = await counting.search({ q: 'x', type: 'video' });
        expect(result).toEqual({ hits: [], nextPageToken: null });
        expect(fake.searchAttempts).toEqual([keyId(keys[0]!), keyId(keys[1]!)]);
        expect(pool.currentKeyId).toBe(keyId(keys[1]!));
      } finally {
        await teardown();
      }
    });

    test('a non-key-level error (e.g. 503/network) is NOT retried against another key', async () => {
      await setup();
      try {
        const keys = ['AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAZ4Yg', 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBCjmw'];
        const { fake, counting, ledger } = buildRig(keys);
        const kid1 = keyId(keys[0]!);

        fake.search = async () => {
          fake.searchAttempts.push(keyId(fake.currentKey));
          throw new AppError('provider_error', 'YouTube Data API 503', { retryable: true });
        };

        await expect(counting.search({ q: 'x', type: 'video' })).rejects.toMatchObject({ code: 'provider_error' });
        // Only the first (current) key was tried — no rotation for a non-key-level error.
        expect(fake.searchAttempts).toEqual([kid1]);
        // key1 must NOT be marked exhausted by an unrelated transport error — the
        // client-side ledger only reflects the one (optimistic, pre-request) charge.
        expect(ledger.remainingForKey(kid1, 'search')).toBe(99);
      } finally {
        await teardown();
      }
    });

    test('single-key mode (no pool) — no rotation possible, error propagates as-is', async () => {
      await setup();
      try {
        const ledger = new QuotaLedger(store);
        const fake = new KeySensitiveFakeApi();
        fake.currentKey = 'onlyKey';
        fake.quotaExhaustedKeys.add(keyId('onlyKey'));
        const counting = new QuotaCountingDataApi(fake, ledger, () => true);

        await expect(counting.search({ q: 'x', type: 'video' })).rejects.toMatchObject({ code: 'quota_exceeded' });
        expect(fake.searchAttempts).toEqual([keyId('onlyKey')]);
      } finally {
        await teardown();
      }
    });
  });

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
