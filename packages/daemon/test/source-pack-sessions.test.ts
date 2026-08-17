import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSourcePackSession,
  getSourcePackSession,
  listSourcePackSessions,
  markSourcePackSessionPacked,
  saveSourcePackSession,
} from '../src/source-pack-sessions.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-source-pack-sessions-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Source Pack explorer sessions', () => {
  test('persists a unique shortlist and records the pack it produced', async () => {
    const session = await createSourcePackSession('  Office jobs  ', dir);
    const saved = await saveSourcePackSession(session.id, {
      picks: [
        {
          videoId: 'abc123',
          title: 'One',
          channelTitle: 'Channel A',
          canonicalUrl: 'https://www.youtube.com/watch?v=abc123',
          viewCount: 100,
          durationSec: 65,
          publishedAt: null,
        },
        // A repeated search result must not cause a duplicated transcript in
        // the final factual pack.
        {
          videoId: 'abc123',
          title: 'One duplicate',
          channelTitle: 'Channel A',
          canonicalUrl: 'https://www.youtube.com/watch?v=abc123',
          viewCount: 100,
          durationSec: 65,
          publishedAt: null,
        },
      ],
    }, dir);

    expect(saved?.name).toBe('Office jobs');
    expect(saved?.picks).toHaveLength(1);

    await markSourcePackSessionPacked(session.id, 'writer-pack-1', dir);
    const loaded = await getSourcePackSession(session.id, dir);
    expect(loaded?.lastWriterPackId).toBe('writer-pack-1');

    const listed = await listSourcePackSessions(dir);
    expect(listed).toEqual([expect.objectContaining({
      id: session.id,
      name: 'Office jobs',
      pickCount: 1,
      lastWriterPackId: 'writer-pack-1',
    })]);
  });
});
