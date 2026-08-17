import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJobDoneNotification,
  listJobNotifications,
  markJobNotificationRead,
} from '../src/notifications.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-notifications-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('job completion notifications', () => {
  test('dedupes a job and persists its read state', async () => {
    const input = {
      kind: 'training-lab' as const,
      jobId: '0f93d2b3-7ccd-4aa7-b4dd-a4f7cd2c617f',
      title: 'Training Lab đã hoàn tất',
      detail: 'Kênh thử nghiệm · 2/2 vòng',
    };
    const first = await createJobDoneNotification(input, dir);
    const duplicate = await createJobDoneNotification(input, dir);

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.createdAt).toBe(first.createdAt);
    expect((await listJobNotifications(dir)).length).toBe(1);

    const read = await markJobNotificationRead(first.id, dir);
    expect(read?.readAt).toBeTruthy();
    expect((await listJobNotifications(dir))[0]?.readAt).toBe(read?.readAt);
  });
});
