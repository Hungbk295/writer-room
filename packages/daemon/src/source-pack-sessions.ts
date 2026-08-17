/**
 * Source Pack explorer sessions.
 *
 * A session is deliberately only a persisted shortlist of YouTube videos. It is
 * not a Writer Pack yet: no keyword analysis, title brainstorming, or comments
 * live here. Pressing Pack turns this shortlist into the immutable Writer Pack
 * consumed by Write Loop v2.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, writerRoot } from './paths.ts';

export interface SourcePackVideoPick {
  videoId: string;
  title: string;
  channelTitle: string;
  canonicalUrl: string;
  thumbnailUrl?: string | null;
  viewCount: number;
  durationSec: number;
  publishedAt: string | null;
}

export interface SourcePackSession {
  id: string;
  name: string;
  picks: SourcePackVideoPick[];
  lastWriterPackId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourcePackSessionSummary {
  id: string;
  name: string;
  pickCount: number;
  lastWriterPackId?: string;
  updatedAt: string;
}

function root(dataDir?: string): string {
  return join(writerRoot(dataDir), 'source-pack-sessions');
}

function filePath(id: string, dataDir?: string): string {
  return join(root(dataDir), `${id}.json`);
}

function normalizePick(raw: SourcePackVideoPick): SourcePackVideoPick {
  const videoId = String(raw.videoId ?? '').trim();
  if (!videoId) throw new Error('Video trong Source Pack phải có videoId');
  return {
    videoId,
    title: String(raw.title ?? videoId).trim() || videoId,
    channelTitle: String(raw.channelTitle ?? '').trim(),
    canonicalUrl: String(raw.canonicalUrl ?? `https://www.youtube.com/watch?v=${videoId}`).trim(),
    thumbnailUrl: typeof raw.thumbnailUrl === 'string' ? raw.thumbnailUrl : null,
    viewCount: Number.isFinite(raw.viewCount) ? Math.max(0, Math.floor(raw.viewCount)) : 0,
    durationSec: Number.isFinite(raw.durationSec) ? Math.max(0, Math.floor(raw.durationSec)) : 0,
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
  };
}

function normalizePicks(picks: SourcePackVideoPick[]): SourcePackVideoPick[] {
  const seen = new Set<string>();
  const output: SourcePackVideoPick[] = [];
  for (const raw of picks) {
    const pick = normalizePick(raw);
    if (seen.has(pick.videoId)) continue;
    seen.add(pick.videoId);
    output.push(pick);
  }
  return output;
}

async function persist(session: SourcePackSession, dataDir?: string): Promise<void> {
  await ensureDir(root(dataDir));
  await writeFile(filePath(session.id, dataDir), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

export async function getSourcePackSession(id: string, dataDir?: string): Promise<SourcePackSession | null> {
  try {
    const raw = JSON.parse(await readFile(filePath(id, dataDir), 'utf8')) as SourcePackSession;
    if (!raw?.id || !raw?.name || !Array.isArray(raw.picks)) return null;
    return {
      id: raw.id,
      name: raw.name,
      picks: normalizePicks(raw.picks),
      ...(raw.lastWriterPackId ? { lastWriterPackId: raw.lastWriterPackId } : {}),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  } catch {
    return null;
  }
}

export async function listSourcePackSessions(dataDir?: string): Promise<SourcePackSessionSummary[]> {
  await ensureDir(root(dataDir));
  const entries = await readdir(root(dataDir)).catch(() => [] as string[]);
  const sessions = (await Promise.all(entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => getSourcePackSession(name.slice(0, -'.json'.length), dataDir))))
    .filter((session): session is SourcePackSession => session !== null)
    .map((session) => ({
      id: session.id,
      name: session.name,
      pickCount: session.picks.length,
      ...(session.lastWriterPackId ? { lastWriterPackId: session.lastWriterPackId } : {}),
      updatedAt: session.updatedAt,
    }));
  return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function createSourcePackSession(name = 'Source Pack mới', dataDir?: string): Promise<SourcePackSession> {
  const now = new Date().toISOString();
  const session: SourcePackSession = {
    id: randomUUID(),
    name: name.trim() || 'Source Pack mới',
    picks: [],
    createdAt: now,
    updatedAt: now,
  };
  await persist(session, dataDir);
  return session;
}

export async function saveSourcePackSession(
  id: string,
  patch: { name?: string; picks?: SourcePackVideoPick[] },
  dataDir?: string,
): Promise<SourcePackSession | null> {
  const current = await getSourcePackSession(id, dataDir);
  if (!current) return null;
  const name = patch.name === undefined ? current.name : patch.name.trim();
  if (!name) throw new Error('Tên Source Pack không được rỗng');
  const next: SourcePackSession = {
    ...current,
    name,
    picks: patch.picks === undefined ? current.picks : normalizePicks(patch.picks),
    updatedAt: new Date().toISOString(),
  };
  await persist(next, dataDir);
  return next;
}

export async function markSourcePackSessionPacked(
  id: string,
  writerPackId: string,
  dataDir?: string,
): Promise<SourcePackSession | null> {
  const current = await getSourcePackSession(id, dataDir);
  if (!current) return null;
  const next: SourcePackSession = {
    ...current,
    lastWriterPackId: writerPackId,
    updatedAt: new Date().toISOString(),
  };
  await persist(next, dataDir);
  return next;
}

export async function deleteSourcePackSession(id: string, dataDir?: string): Promise<boolean> {
  try {
    await unlink(filePath(id, dataDir));
    return true;
  } catch {
    return false;
  }
}
