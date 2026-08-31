import { afterEach, expect, test } from 'bun:test';
import { api } from '../src/api.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: unknown, requests: Array<{ input: string; init?: RequestInit }>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

test('uses the C1 watchlist list contract with local-desktop and segment', async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  mockFetch({ channels: [], nextCursor: null }, requests);

  await api.listSpyWatchlistChannels('local-desktop', 'saved');

  expect(requests[0]?.input).toBe('/api/spy/watchlists/local-desktop/channels?segment=saved');
  expect(requests[0]?.init?.method).toBeUndefined();
});

test('uses the C1 star and competitor mutation methods without operation polling', async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  mockFetch({ youtubeUcId: 'UC_test', starred: true, watchStatus: 'followed', cadence: 'daily', lastObservedAt: null }, requests);

  await api.starSpyChannel('UC_test');
  await api.unstarSpyChannel('UC_test');
  await api.followSpyChannel('local-desktop', 'UC_test', { cadence: 'daily', watchStatus: 'followed' });
  await api.pauseSpyChannel('local-desktop', 'UC_test');
  await api.unfollowSpyChannel('local-desktop', 'UC_test');

  expect(requests.map((request) => [request.input, request.init?.method])).toEqual([
    ['/api/spy/channels/UC_test/star', 'PUT'],
    ['/api/spy/channels/UC_test/star', 'DELETE'],
    ['/api/spy/watchlists/local-desktop/competitors/UC_test', 'PUT'],
    ['/api/spy/watchlists/local-desktop/competitors/UC_test', 'PATCH'],
    ['/api/spy/watchlists/local-desktop/competitors/UC_test', 'DELETE'],
  ]);
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({});
  expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ cadence: 'daily', watchStatus: 'followed' });
  expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({ watchStatus: 'paused' });
});
