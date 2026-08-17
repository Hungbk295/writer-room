/**
 * Persistent in-app notifications for terminal job completion.
 *
 * A notification is created only by an explicit final `DONE` transition, never
 * by polling a run that happens to already be done. The stable kind/jobId file
 * name makes creation idempotent across retries and daemon restarts.
 */
import { open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from './paths.ts';

export type JobNotificationKind = 'training-lab' | 'writer' | 'writer-v2';

export interface JobDoneNotification {
  /** Stable dedupe key: one terminal DONE notification for one job. */
  id: string;
  kind: JobNotificationKind;
  jobId: string;
  title: string;
  detail: string;
  createdAt: string;
  readAt: string | null;
}

function notificationsDir(dataDir: string): string {
  return join(dataDir, 'notifications');
}

function notificationId(kind: JobNotificationKind, jobId: string): string {
  return `job-done:${kind}:${jobId}`;
}

function notificationPath(kind: JobNotificationKind, jobId: string, dataDir: string): string {
  // Job ids are application-generated UUIDs. Keep a conservative path guard so
  // this store remains safe if a future caller ever accepts an external id.
  if (!/^[a-z0-9-]+$/i.test(jobId)) throw new Error('notification jobId không hợp lệ');
  return join(notificationsDir(dataDir), `${kind}-${jobId}.json`);
}

async function readNotification(path: string): Promise<JobDoneNotification> {
  return JSON.parse(await readFile(path, 'utf8')) as JobDoneNotification;
}

/** Creates one notification for a job's final DONE transition, or returns its prior record. */
export async function createJobDoneNotification(
  input: Omit<JobDoneNotification, 'id' | 'createdAt' | 'readAt'>,
  dataDir: string,
): Promise<JobDoneNotification> {
  const dir = notificationsDir(dataDir);
  await ensureDir(dir);
  const path = notificationPath(input.kind, input.jobId, dataDir);
  const notification: JobDoneNotification = {
    ...input,
    id: notificationId(input.kind, input.jobId),
    createdAt: new Date().toISOString(),
    readAt: null,
  };

  try {
    // Exclusive create is the idempotency boundary: two concurrent settle paths
    // cannot produce two notifications for the same final job.
    const file = await open(path, 'wx');
    try {
      await file.writeFile(`${JSON.stringify(notification, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    return notification;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readNotification(path);
    throw err;
  }
}

export async function listJobNotifications(dataDir: string): Promise<JobDoneNotification[]> {
  const dir = notificationsDir(dataDir);
  await ensureDir(dir);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const notifications = await Promise.all(names
    .filter((name) => name.endsWith('.json'))
    .map(async (name) => {
      try {
        return await readNotification(join(dir, name));
      } catch {
        return null;
      }
    }));
  return notifications
    .filter((notification): notification is JobDoneNotification => notification !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

export async function markJobNotificationRead(
  id: string,
  dataDir: string,
): Promise<JobDoneNotification | null> {
  const notification = (await listJobNotifications(dataDir)).find((candidate) => candidate.id === id);
  if (!notification) return null;
  if (notification.readAt) return notification;

  const updated: JobDoneNotification = { ...notification, readAt: new Date().toISOString() };
  await writeFile(notificationPath(updated.kind, updated.jobId, dataDir), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  return updated;
}
