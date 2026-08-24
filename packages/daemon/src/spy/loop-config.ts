/**
 * Đọc/ghi config spy-loop.json (file RIÊNG, KHÔNG đụng spy.json).
 * Schema NON-strict (z.object() không có .strict()) để không mất key khi viết.
 *
 * Route: GET /api/settings/spy-loop   PUT /api/settings/spy-loop
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureDir } from '../paths.ts';

// ─── Schema ───────────────────────────────────────────────────────────────────

const telegramConfigSchema = z.object({
  botToken: z.string().default(''),
  chatId: z.string().default(''),
  enabled: z.boolean().default(false),
});

export const spyLoopConfigSchema = z.object({
  enabled: z.boolean().default(false),
  tickHourLocal: z.string().default('15:30'),
  digestHourLocal: z.string().default('08:00'),
  timezone: z.string().default('Asia/Ho_Chi_Minh'),
  telegram: telegramConfigSchema.optional(),
});

export type SpyLoopConfig = z.infer<typeof spyLoopConfigSchema>;
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;

// ─── Public config: token là secret → mask ────────────────────────────────────

export interface PublicSpyLoopConfig extends Omit<SpyLoopConfig, 'telegram'> {
  telegram?: Omit<TelegramConfig, 'botToken'> & { botTokenSet: boolean };
}

function maskConfig(cfg: SpyLoopConfig): PublicSpyLoopConfig {
  const { telegram, ...rest } = cfg;
  return {
    ...rest,
    ...(telegram
      ? {
          telegram: {
            chatId: telegram.chatId,
            enabled: telegram.enabled,
            botTokenSet: Boolean(telegram.botToken),
          },
        }
      : {}),
  };
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

function configPath(dataDir: string): string {
  return join(dataDir, 'config', 'spy-loop.json');
}

export async function loadSpyLoopConfig(dataDir: string): Promise<SpyLoopConfig> {
  try {
    const raw = await readFile(configPath(dataDir), 'utf8');
    return spyLoopConfigSchema.parse(JSON.parse(raw));
  } catch {
    return spyLoopConfigSchema.parse({});
  }
}

export async function saveSpyLoopConfig(dataDir: string, patch: Partial<SpyLoopConfig>): Promise<SpyLoopConfig> {
  await ensureDir(join(dataDir, 'config'));
  const current = await loadSpyLoopConfig(dataDir);
  const merged: SpyLoopConfig = spyLoopConfigSchema.parse({
    ...current,
    ...patch,
    telegram: patch.telegram !== undefined
      ? { ...current.telegram, ...patch.telegram }
      : current.telegram,
  });
  await writeFile(configPath(dataDir), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

export async function handleGetSpyLoopConfig(dataDir: string): Promise<PublicSpyLoopConfig> {
  const cfg = await loadSpyLoopConfig(dataDir);
  return maskConfig(cfg);
}

export async function handlePutSpyLoopConfig(
  dataDir: string,
  body: Record<string, unknown>,
): Promise<PublicSpyLoopConfig> {
  // Chấp nhận partial update; validate bằng schema trước khi merge
  const patch: Partial<SpyLoopConfig> = {};
  if (typeof body['enabled'] === 'boolean') patch.enabled = body['enabled'];
  if (typeof body['tickHourLocal'] === 'string') patch.tickHourLocal = body['tickHourLocal'];
  if (typeof body['digestHourLocal'] === 'string') patch.digestHourLocal = body['digestHourLocal'];
  if (typeof body['timezone'] === 'string') patch.timezone = body['timezone'];
  if (body['telegram'] && typeof body['telegram'] === 'object') {
    const tg = body['telegram'] as Record<string, unknown>;
    patch.telegram = telegramConfigSchema.parse({
      botToken: typeof tg['botToken'] === 'string' ? tg['botToken'] : undefined,
      chatId: typeof tg['chatId'] === 'string' ? tg['chatId'] : undefined,
      enabled: typeof tg['enabled'] === 'boolean' ? tg['enabled'] : undefined,
    });
  }
  const saved = await saveSpyLoopConfig(dataDir, patch);
  return maskConfig(saved);
}
