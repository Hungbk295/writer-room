/** Separate, kill-switched public competitor watcher.  Never reuse spy-loop.json. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureDir } from '../paths.ts';

/** Keep bad persisted/user input from crashing the scheduler's Intl calls. */
export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export const channelWatchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  timezone: z.string().refine(isValidIanaTimeZone, 'timezone phải là IANA timezone hợp lệ').default('Asia/Ho_Chi_Minh'),
  dailyHourLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('15:30'),
  playlistLimit: z.number().int().min(1).max(100).default(30),
  inspectCap: z.number().int().min(1).max(30).default(20),
  /** Hard upper bound per followed relation; prevents one channel blocking all daily work. */
  perRelationWallClockMs: z.number().int().min(1_000).max(10 * 60 * 1_000).default(8 * 60 * 1_000),
});

export type ChannelWatchConfig = z.infer<typeof channelWatchConfigSchema>;

function configPath(dataDir: string): string {
  return join(dataDir, 'config', 'channel-intelligence.json');
}

export async function loadChannelWatchConfig(dataDir: string): Promise<ChannelWatchConfig> {
  try {
    return channelWatchConfigSchema.parse(JSON.parse(await readFile(configPath(dataDir), 'utf8')));
  } catch {
    return channelWatchConfigSchema.parse({});
  }
}

export async function saveChannelWatchConfig(dataDir: string, patch: Partial<ChannelWatchConfig>): Promise<ChannelWatchConfig> {
  await ensureDir(join(dataDir, 'config'));
  const current = await loadChannelWatchConfig(dataDir);
  const next = channelWatchConfigSchema.parse({ ...current, ...patch });
  await writeFile(configPath(dataDir), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
