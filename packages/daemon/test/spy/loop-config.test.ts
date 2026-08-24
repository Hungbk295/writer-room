/**
 * Hard gate G4 + G6 — `plan/codex/spy-autoloop-hardgate.md`.
 *
 * G4 tồn tại vì một cái bẫy có thật, không phải giả định:
 *   - `spyConfigSchema` (packages/spy/src/schema.ts) là `.strict()`
 *   - `loadConfig()` (packages/spy/src/index.ts) NUỐT lỗi parse và rơi về default rỗng
 *   → viết một key lạ (`loop`, `telegram`, …) vào `config/spy.json` sẽ làm
 *     `youtubeDataApiKey` biến mất IM LẶNG ở lần boot sau.
 * Vì vậy config của loop phải nằm ở FILE RIÊNG `config/spy-loop.json`, và test
 * này đi qua ĐÚNG đường ghi mà route `PUT /api/settings/spy-loop` dùng
 * (`handlePutSpyLoopConfig`), không phải một helper viết riêng cho test.
 *
 * G6: `EXPOSED_TOOL_NAMES` trong `spy-mcp.ts` là gate DUY NHẤT — `SCOPES` đã chứa
 * `spy.start` nên scope không chặn được mutation. Tool mutation của loop phải
 * vừa vắng mặt trong `tools/list`, vừa bị từ chối khi gọi thẳng.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '@writer-room/spy';
import {
  handleGetSpyLoopConfig,
  handlePutSpyLoopConfig,
  loadSpyLoopConfig,
} from '../../src/spy/loop-config.ts';
import { McpSpyServer } from '../../src/spy-mcp.ts';

const SENTINEL_KEY = 'sentinel-key';

/** Sampling KHÔNG mặc định — để chứng minh cả phần còn lại của spy.json cũng nguyên vẹn. */
const NON_DEFAULT_SAMPLING = { mode: 'scene', frameCount: 7, intervalSec: 2.5, dhashThreshold: 12 };

let root = '';
let servers: McpSpyServer[] = [];
let services: SpyService[] = [];

afterEach(async () => {
  for (const server of servers) server.stop();
  for (const service of services) service.store.close();
  servers = [];
  services = [];
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function makeDataRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'writer-room-loop-config-'));
  await mkdir(join(dir, 'config'), { recursive: true });
  await mkdir(join(dir, 'spy'), { recursive: true });
  return dir;
}

function spyConfigPath(dataRoot: string): string {
  return join(dataRoot, 'config', 'spy.json');
}
function spyLoopConfigPath(dataRoot: string): string {
  return join(dataRoot, 'config', 'spy-loop.json');
}

/** `SpyService` nhận `<data>/spy`; nó tự đọc `<data>/config/spy.json`. */
function freshSpyService(dataRoot: string): SpyService {
  const service = new SpyService({ dataRoot: join(dataRoot, 'spy') });
  services.push(service);
  return service;
}

async function callMcp(
  info: { url: string; token: string },
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<{
  result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> };
  error?: { code: number; message: string };
}> {
  const response = await fetch(info.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> };
    error?: { code: number; message: string };
  }>;
}

describe('Spy Loop config — hard gate', () => {
  test('G4 preserves spy key: lưu cài đặt loop KHÔNG được xoá youtubeDataApiKey', async () => {
    root = await makeDataRoot();

    // ── Fixture: spy.json hợp lệ, có key sentinel + sampling khác mặc định ────
    await writeFile(
      spyConfigPath(root),
      `${JSON.stringify(
        { youtubeDataApiKey: SENTINEL_KEY, concurrency: 2, sampling: NON_DEFAULT_SAMPLING },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const spyJsonBefore = await readFile(spyConfigPath(root), 'utf8');

    // Service ban đầu đọc được key → chứng minh fixture đúng trước khi ghi loop.
    const before = freshSpyService(root);
    await before.init();
    expect(before.getPublicConfig()).toMatchObject({ hasApiKey: true, apiKeyLast4: '-key' });
    expect(before.getPublicConfig().sampling).toMatchObject(NON_DEFAULT_SAMPLING);

    // ── Đường ghi THẬT của route PUT /api/settings/spy-loop ──────────────────
    const saved = await handlePutSpyLoopConfig(root, {
      enabled: true,
      tickHourLocal: '15:30',
      digestHourLocal: '08:00',
      timezone: 'Asia/Ho_Chi_Minh',
      telegram: { botToken: 'bot-token-abc', chatId: '-1001234567890', enabled: true },
    });

    // ── spy.json phải nguyên vẹn TỪNG BYTE ───────────────────────────────────
    const spyJsonAfter = await readFile(spyConfigPath(root), 'utf8');
    expect(spyJsonAfter).toBe(spyJsonBefore);
    const parsedSpyJson = JSON.parse(spyJsonAfter) as Record<string, unknown>;
    expect(parsedSpyJson['youtubeDataApiKey']).toBe(SENTINEL_KEY);
    expect(parsedSpyJson['sampling']).toEqual(NON_DEFAULT_SAMPLING);
    // Không có key lạ nào lọt vào — đây chính là thứ làm .strict() nuốt cả file.
    expect(Object.keys(parsedSpyJson).sort()).toEqual(['concurrency', 'sampling', 'youtubeDataApiKey']);

    // ── Chỉ spy-loop.json đổi; và nó KHÔNG chứa API key ──────────────────────
    const loopJson = JSON.parse(await readFile(spyLoopConfigPath(root), 'utf8')) as Record<string, unknown>;
    expect(loopJson).toMatchObject({
      enabled: true,
      tickHourLocal: '15:30',
      digestHourLocal: '08:00',
      timezone: 'Asia/Ho_Chi_Minh',
    });
    expect(loopJson['telegram']).toMatchObject({ chatId: '-1001234567890', enabled: true });
    expect(JSON.stringify(loopJson)).not.toContain(SENTINEL_KEY);
    expect(loopJson['youtubeDataApiKey']).toBeUndefined();

    // Đọc lại qua chính loader của daemon → giá trị loop đúng như đã gửi.
    const reloaded = await loadSpyLoopConfig(root);
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.tickHourLocal).toBe('15:30');
    expect(reloaded.telegram?.botToken).toBe('bot-token-abc');
    // Bề mặt public che token.
    const publicLoop = await handleGetSpyLoopConfig(root);
    expect(publicLoop.telegram).toMatchObject({ botTokenSet: true, chatId: '-1001234567890' });
    expect(JSON.stringify(publicLoop)).not.toContain('bot-token-abc');

    // ── Service MỚI dựng từ cùng data root vẫn thấy key ──────────────────────
    const after = freshSpyService(root);
    await after.init();
    const publicCfg = after.getPublicConfig();
    expect(publicCfg.hasApiKey).toBe(true);
    expect(publicCfg.apiKeyLast4).toBe('-key');
    expect(publicCfg.sampling).toMatchObject(NON_DEFAULT_SAMPLING);

    // Ghi lần hai (partial patch) cũng không được đụng spy.json.
    await handlePutSpyLoopConfig(root, { enabled: false });
    expect(await readFile(spyConfigPath(root), 'utf8')).toBe(spyJsonBefore);
    expect((await loadSpyLoopConfig(root)).enabled).toBe(false);
    // Patch một phần không được làm mất Telegram đã lưu.
    expect((await loadSpyLoopConfig(root)).telegram?.botToken).toBe('bot-token-abc');

    expect(saved.enabled).toBe(true);
  });

  test('G6 MCP allowlist: mutation tool của loop không lộ và không gọi được', async () => {
    root = await makeDataRoot();
    const spy = freshSpyService(root);
    await spy.init();
    const server = new McpSpyServer(spy);
    servers.push(server);
    const info = await server.start();

    // (1) tools/list không được liệt kê tool mutation.
    const listed = await callMcp(info, 1, 'tools/list');
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('spy_loop_decide');
    expect(names).not.toContain('spy_loop_tick');
    // Read tool của loop thì phải có — chứng minh vắng mặt ở trên là chủ ý,
    // không phải vì cả họ spy_loop_* chưa tồn tại.
    expect(names).toContain('spy_loop_inbox');
    expect(names).toContain('spy_loop_status');

    const countRows = (table: 'topic_channels' | 'loop_ticks'): number => {
      // `tools/call` chạy qua HTTP nên phải đếm bằng đường công khai của store.
      if (table === 'topic_channels') {
        return Object.values(spy.store.countTopicChannelsByStatus('finance-vi'))
          .reduce((sum, n) => sum + n, 0);
      }
      return spy.store.getLastTick('finance-vi') === null ? 0 : 1;
    };
    const channelsBefore = countRows('topic_channels');
    const ticksBefore = countRows('loop_ticks');

    // (2) Gọi thẳng bằng JSON-RPC đã xác thực → phải bị từ chối -32602.
    for (const [index, toolName] of ['spy_loop_decide', 'spy_loop_tick'].entries()) {
      const denied = await callMcp(info, 10 + index, 'tools/call', {
        name: toolName,
        arguments: { topic_id: 'finance-vi', channel_ids: ['UCtest'], status: 'shortlisted' },
      });
      expect(denied.result).toBeUndefined();
      expect(denied.error?.code).toBe(-32602);
      expect(denied.error?.message).toContain('tool not found');
    }

    // (3) Không có gì bị ghi vào DB bởi những lời gọi bị từ chối đó.
    expect(countRows('topic_channels')).toBe(channelsBefore);
    expect(countRows('loop_ticks')).toBe(ticksBefore);
  });
});
