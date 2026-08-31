import { expect, test } from 'bun:test';
import { href, parseRoute } from '../src/router.ts';

test('parses saved and followed channel routes before the legacy spy run route', () => {
  expect(parseRoute('#/spy/saved')).toEqual({ name: 'spy-channels', segment: 'saved' });
  expect(parseRoute('#/spy/followed')).toEqual({ name: 'spy-channels', segment: 'followed' });
  expect(parseRoute('#/spy/channel/UC_test-1')).toEqual({ name: 'spy-channel', youtubeUcId: 'UC_test-1' });
  expect(parseRoute('#/spy/channels/saved')).toEqual({ name: 'spy-channels', segment: 'saved' });
  expect(parseRoute('#/spy/run-123')).toEqual({ name: 'spy-run', id: 'run-123' });
});

test('builds encoded public channel routes', () => {
  expect(href({ name: 'spy-channels', segment: 'followed' })).toBe('#/spy/followed');
  expect(href({ name: 'spy-channel', youtubeUcId: 'UC test/1' })).toBe('#/spy/channel/UC%20test%2F1');
});
