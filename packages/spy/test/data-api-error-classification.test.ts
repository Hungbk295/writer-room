import { afterEach, describe, expect, test } from 'bun:test';
import { AppError } from '../src/errors.ts';
import { YouTubeDataApiAdapter } from '../src/adapters/data-api.ts';

/**
 * Google trả HTTP 403 cho NHIỀU lý do khác nhau (quota thật hết / key sai /
 * API chưa bật) — chỉ nhìn `response.status` không phân biệt được. Trước khi
 * sửa, `fetch()` trong data-api.ts ném `provider_error` chung cho MỌI 403,
 * nên caller (QuotaCountingDataApi/globalVideoSearch) không có cách nào biết
 * "key này hết quota, rotate sang key khác" khác với "đừng thử lại nữa".
 */
describe('YouTubeDataApiAdapter — Google error classification', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchOnce(status: number, body: unknown) {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  }

  test('403 quotaExceeded → AppError quota_exceeded, retryable false', async () => {
    mockFetchOnce(403, { error: { message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } });
    const adapter = new YouTubeDataApiAdapter('AIzaSyTestKeyEndingInZ4Yg');

    await expect(adapter.fetchVideoStatistics(['abc123def45'])).rejects.toMatchObject({
      code: 'quota_exceeded',
      retryable: false,
    });
  });

  test('403 dailyLimitExceeded → also classified as quota_exceeded', async () => {
    mockFetchOnce(403, { error: { message: 'daily limit exceeded', errors: [{ reason: 'dailyLimitExceeded' }] } });
    const adapter = new YouTubeDataApiAdapter('AIzaSyTestKeyEndingInCjmw');

    await expect(adapter.fetchVideoStatistics(['abc123def45'])).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  test('403 rateLimitExceeded → also classified as quota_exceeded (short-term, still "try another key")', async () => {
    mockFetchOnce(403, { error: { message: 'rate limit', errors: [{ reason: 'rateLimitExceeded' }] } });
    const adapter = new YouTubeDataApiAdapter('AIzaSyTestKeyEndingInWDNw');

    await expect(adapter.fetchVideoStatistics(['abc123def45'])).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  test('403 keyInvalid → AppError unauthorized, distinct from quota_exceeded', async () => {
    mockFetchOnce(403, { error: { message: 'API key not valid', errors: [{ reason: 'keyInvalid' }] } });
    const adapter = new YouTubeDataApiAdapter('bad-key');

    await expect(adapter.fetchVideoStatistics(['abc123def45'])).rejects.toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
  });

  test('403 accessNotConfigured → AppError unauthorized', async () => {
    mockFetchOnce(403, { error: { message: 'API not enabled', errors: [{ reason: 'accessNotConfigured' }] } });
    const adapter = new YouTubeDataApiAdapter('some-key');

    await expect(adapter.fetchVideoStatistics(['abc123def45'])).rejects.toMatchObject({ code: 'unauthorized' });
  });

  test('403 with unrecognized reason → falls back to generic provider_error (not retryable)', async () => {
    mockFetchOnce(403, { error: { message: 'forbidden for some other reason', errors: [{ reason: 'somethingElse' }] } });
    const adapter = new YouTubeDataApiAdapter('some-key');

    await expect(adapter.fetchVideoStatistics(['abc123def45'])).rejects.toMatchObject({
      code: 'provider_error',
      retryable: false,
    });
  });

  test('500 → provider_error, retryable true (unrelated to key rotation)', async () => {
    mockFetchOnce(500, { error: { message: 'internal' } });
    const adapter = new YouTubeDataApiAdapter('some-key');

    await expect(adapter.fetchVideoStatistics(['abc123def45'])).rejects.toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
  });

  test('403 with a non-JSON body still classifies by status alone (no throw from body parsing)', async () => {
    globalThis.fetch = (async () => new Response('not json', { status: 403 })) as unknown as typeof fetch;
    const adapter = new YouTubeDataApiAdapter('some-key');

    await expect(adapter.fetchVideoStatistics(['abc123def45'])).rejects.toBeInstanceOf(AppError);
  });
});
