/** Spy daemon — local HTTP API + static UI for Tauri webview. */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SpyService } from '@writer-room/spy';
import { acquireLock, releaseLock } from './lock.ts';
import {
  APP_ROOT,
  dataRoot,
  ensureDir,
  spyRoot,
  writerExportsRoot,
} from './paths.ts';
import { SPY_FEATURE } from './features.ts';
import {
  createWriterPack,
  deleteWriterPack,
  getWriterPack,
  listWriterPacks,
} from './writer-packs.ts';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function contentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

export interface HttpApp {
  spy: SpyService;
  startedAt: number;
  webRoot: string;
}

export async function createHttpApp(): Promise<HttpApp> {
  const root = dataRoot();
  await ensureDir(root);
  await ensureDir(spyRoot(root));
  await ensureDir(join(root, 'config'));
  await ensureDir(writerExportsRoot(root));

  const spy = new SpyService({ dataRoot: spyRoot(root) });
  await spy.init();

  const webRoot = resolve(APP_ROOT, 'packages/web/dist');
  return { spy, startedAt: Date.now(), webRoot };
}

export function createHandler(app: HttpApp): (req: Request) => Promise<Response> {
  const { spy, startedAt, webRoot } = app;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    try {
      if (method === 'GET' && pathname === '/api/health') {
        return json({
          ok: true,
          spy: SPY_FEATURE.enabled,
          uptimeMs: Date.now() - startedAt,
        });
      }

      // ── Settings ──────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/settings/spy') {
        const publicCfg = spy.getPublicConfig();
        return json({
          ...publicCfg,
          dataRoot: dataRoot(),
          spyRoot: spyRoot(),
        });
      }

      if (method === 'PUT' && pathname === '/api/settings/spy') {
        const body = await readBody(req);
        const patch: {
          youtubeDataApiKey?: string | null;
          concurrency?: number;
          sampling?: {
            mode?: 'sequential' | 'scene' | 'spread' | 'random';
            frameCount?: number;
            intervalSec?: number;
            dhashThreshold?: number;
          };
        } = {};
        if ('youtubeDataApiKey' in body) {
          patch.youtubeDataApiKey = body['youtubeDataApiKey'] == null
            ? null
            : String(body['youtubeDataApiKey']);
        }
        if (typeof body['concurrency'] === 'number') {
          patch.concurrency = body['concurrency'];
        }
        if (body['sampling'] && typeof body['sampling'] === 'object') {
          const raw = body['sampling'] as Record<string, unknown>;
          const modes = new Set(['sequential', 'scene', 'spread', 'random']);
          const sampling: NonNullable<typeof patch.sampling> = {};
          if (typeof raw['mode'] === 'string' && modes.has(raw['mode'])) {
            sampling.mode = raw['mode'] as 'sequential' | 'scene' | 'spread' | 'random';
          }
          if (typeof raw['frameCount'] === 'number') sampling.frameCount = raw['frameCount'];
          if (typeof raw['intervalSec'] === 'number') sampling.intervalSec = raw['intervalSec'];
          if (typeof raw['dhashThreshold'] === 'number') sampling.dhashThreshold = raw['dhashThreshold'];
          patch.sampling = sampling;
        }
        await spy.updateConfig(patch);
        return json({
          ok: true,
          ...spy.getPublicConfig(),
          dataRoot: dataRoot(),
          spyRoot: spyRoot(),
        });
      }

      // ── Writer packs ──────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/writer/packs') {
        return json({ packs: await listWriterPacks() });
      }

      if (method === 'POST' && pathname === '/api/writer/packs') {
        const body = await readBody(req);
        const markdown = String(body['markdown'] ?? '');
        if (!markdown.trim()) return error('markdown bắt buộc');
        const pack = await createWriterPack({
          title: typeof body['title'] === 'string' ? body['title'] : undefined,
          markdown,
          videoIds: Array.isArray(body['videoIds']) ? body['videoIds'].map(String) : [],
          spyRunId: typeof body['spyRunId'] === 'string' ? body['spyRunId'] : undefined,
          channelTitle: typeof body['channelTitle'] === 'string' ? body['channelTitle'] : undefined,
          wordCount: typeof body['wordCount'] === 'number' ? body['wordCount'] : undefined,
          warnings: Array.isArray(body['warnings']) ? body['warnings'].map(String) : [],
        });
        return json(pack, 201);
      }

      const writerPackMatch = /^\/api\/writer\/packs\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && writerPackMatch) {
        const pack = await getWriterPack(writerPackMatch[1]!);
        if (!pack) return error('Pack không tồn tại', 404);
        return json(pack);
      }
      if (method === 'DELETE' && writerPackMatch) {
        const ok = await deleteWriterPack(writerPackMatch[1]!);
        if (!ok) return error('Pack không tồn tại', 404);
        return json({ ok: true });
      }

      // ── Spy runs ──────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/spy/runs') {
        const runs = spy.store.listSpyRuns(undefined, 100).map((run) => ({
          ...run,
          videoCount: spy.store.listVideoSnapshots(run.id).length,
        }));
        return json({ runs });
      }

      const spyRunMatch = /^\/api\/spy\/runs\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && spyRunMatch) {
        const result = spy.getResult(spyRunMatch[1]!);
        return json({
          run: {
            ...result.run,
            videoCount: result.videos.length,
          },
          videos: result.videos,
        });
      }

      const packMatch = /^\/api\/spy\/runs\/([^/]+)\/source-pack$/.exec(pathname);
      if (method === 'POST' && packMatch) {
        const body = await readBody(req);
        const pack = spy.exportSourcePack({
          spyRunId: packMatch[1]!,
          limit: typeof body['limit'] === 'number' ? body['limit'] : 5,
          videoIds: Array.isArray(body['videoIds'])
            ? body['videoIds'].map(String)
            : undefined,
        });
        return json(pack);
      }

      const opMatch = /^\/api\/spy\/operations\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && opMatch) {
        return json(spy.getStatus(opMatch[1]!));
      }

      // ── Snapshot assets ───────────────────────────────────────
      const thumbMatch = /^\/api\/spy\/snapshots\/([^/]+)\/thumbnail$/.exec(pathname);
      if (method === 'GET' && thumbMatch) {
        const snapshot = spy.store.getVideoSnapshot(thumbMatch[1]!);
        if (!snapshot?.thumbnail) return error('Thumbnail không tồn tại', 404);
        const path = await spy.artifacts.resolve(snapshot.thumbnail);
        return new Response(Bun.file(path), {
          headers: {
            'Content-Type': snapshot.thumbnail.mimeType || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }

      const transcriptTextMatch = /^\/api\/spy\/snapshots\/([^/]+)\/transcript\/text$/.exec(pathname);
      if (method === 'GET' && transcriptTextMatch) {
        return json(spy.getTranscriptText(transcriptTextMatch[1]!));
      }

      const transcriptMatch = /^\/api\/spy\/snapshots\/([^/]+)\/transcript$/.exec(pathname);
      if (method === 'GET' && transcriptMatch) {
        const cursor = Number(url.searchParams.get('cursor') || 0);
        const limit = Number(url.searchParams.get('limit') || 500);
        return json(spy.getTranscript(
          transcriptMatch[1]!,
          Number.isFinite(cursor) ? cursor : 0,
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 2000) : 500,
        ));
      }

      if (method === 'POST' && pathname === '/api/spy/channel') {
        if (!SPY_FEATURE.enabled) return error('Spy đang tắt', 403);
        const body = await readBody(req);
        const urlValue = String(body['url'] ?? '');
        if (!urlValue) return error('url bắt buộc');
        const started = spy.channelSpy({
          url: urlValue,
          depth: body['depth'] === 'metadata' || body['depth'] === 'transcript'
            ? body['depth']
            : 'transcript',
          topN: typeof body['topN'] === 'number' ? body['topN'] : 5,
          scanLimit: typeof body['scanLimit'] === 'number' ? body['scanLimit'] : 60,
          rankBy: 'velocity',
          minDurationSec: 0,
          idempotencyKey: `http-channel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        return json(started);
      }

      if (method === 'POST' && pathname === '/api/spy/transcripts') {
        if (!SPY_FEATURE.enabled) return error('Spy đang tắt', 403);
        const body = await readBody(req);
        const videoIds = Array.isArray(body['videoIds'])
          ? body['videoIds'].map(String).filter(Boolean)
          : undefined;
        const spyRunId = typeof body['spyRunId'] === 'string' ? body['spyRunId'] : undefined;
        if ((!videoIds || videoIds.length === 0) && !spyRunId) {
          return error('Cần videoIds hoặc spyRunId');
        }
        const started = spy.fetchTranscripts({
          videoIds: videoIds?.length ? videoIds : undefined,
          spyRunId,
          topN: typeof body['topN'] === 'number' ? body['topN'] : undefined,
          force: body['force'] === true,
          idempotencyKey: `http-transcript-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        return json(started);
      }

      // Static UI (Tauri webview / local)
      if (method === 'GET') {
        if (!existsSync(webRoot)) {
          return new Response(
            `<!doctype html><meta charset="utf-8"><title>Writer Room</title>
             <body style="font-family:system-ui;padding:2rem;line-height:1.5">
             <h1>Writer Room</h1>
             <p>UI chưa build. Chạy:</p>
             <pre>bun install && bun run ui:build && bun run daemon</pre>
             <p>Hoặc mở app: <code>bun run app:macos</code></p>
             </body>`,
            { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }
        let filePath = join(webRoot, pathname === '/' ? 'index.html' : pathname);
        if (!existsSync(filePath) || pathname === '/' || !pathname.includes('.')) {
          filePath = join(webRoot, 'index.html');
        }
        const file = Bun.file(filePath);
        return new Response(file, {
          headers: { 'Content-Type': contentType(filePath) },
        });
      }

      return error('Not found', 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /không tồn tại|not found/i.test(message) ? 404 : 500;
      return error(message, status);
    }
  };
}

export async function startHttpServer(port = Number(process.env.WRITER_ROOM_PORT || 4187)) {
  await ensureDir(dataRoot());
  const lock = await acquireLock(port);
  if (!lock.ok) {
    console.error(`Daemon đã chạy: http://127.0.0.1:${lock.existing.port} (pid ${lock.existing.pid})`);
    process.exit(1);
  }

  const app = await createHttpApp();
  const handler = createHandler(app);
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    idleTimeout: 120,
    fetch(req) {
      return handler(req);
    },
  });

  console.log(`Writer Room http://127.0.0.1:${server.port}`);
  console.log(`data: ${dataRoot()}`);
  console.log(`spy: ${SPY_FEATURE.enabled ? 'on' : 'off'}`);
  console.log(`ui: ${existsSync(app.webRoot) ? app.webRoot : '(run bun run ui:build)'}`);

  const shutdown = async () => {
    await releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
