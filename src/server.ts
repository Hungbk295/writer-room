import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Orchestrator } from './orchestrator.ts';
import { APP_ROOT } from './store.ts';

const orchestrator = new Orchestrator();
await orchestrator.init();

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function errorResponse(error: unknown, status = 400): Response {
  return json({ error: (error as Error).message || String(error) }, status);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try { return await request.json() as Record<string, unknown>; }
  catch { throw new Error('request body must be valid JSON'); }
}

async function staticFile(name: 'index.html' | 'app.js' | 'styles.css'): Promise<Response> {
  const types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
  return new Response(await readFile(join(APP_ROOT, 'public', name)), {
    headers: { 'Content-Type': types[name], 'Cache-Control': name === 'index.html' ? 'no-store' : 'public, max-age=60' },
  });
}

const port = Number(process.env.WRITER_ROOM_PORT || 4187);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === 'GET' && path === '/api/health') return json(await orchestrator.health());
      if (request.method === 'GET' && path === '/api/models') return json(orchestrator.models());
      if (request.method === 'GET' && path === '/api/prompts') return json(await orchestrator.promptDefaults());
      if (request.method === 'GET' && path === '/api/agents') return json(orchestrator.agents());
      if (request.method === 'PUT' && path === '/api/agents') return json(orchestrator.saveAgents((await body(request)).agents));
      if (request.method === 'GET' && path === '/api/runs') return json(await orchestrator.store.listStates());
      if (request.method === 'POST' && path === '/api/runs') return json(await orchestrator.create(await body(request)), 201);
      if (request.method === 'GET' && path === '/api/articles') {
        return json(orchestrator.articles(url.searchParams.get('query') || '', url.searchParams.get('archived') === '1'));
      }
      if (request.method === 'POST' && path === '/api/articles/backup') return json(orchestrator.backupLibrary());
      const articleMatch = path.match(/^\/api\/articles\/([a-z0-9-]+)(?:\/(archive|restore|export))?$/);
      if (articleMatch) {
        const articleId = articleMatch[1]!;
        const action = articleMatch[2];
        if (request.method === 'GET' && !action) return json(orchestrator.article(articleId));
        if (request.method === 'POST' && action === 'export') return json(orchestrator.exportArticle(articleId));
        if (request.method === 'POST' && action) {
          orchestrator.archiveArticle(articleId, action === 'archive');
          return json({ ok: true });
        }
      }

      const match = path.match(/^\/api\/runs\/([a-z0-9-]+)(?:\/(human|continue|accept|rerun|retry|retry-snapshot|retry-current-agent|logs|export-draft))?$/);
      if (match) {
        const id = match[1]!;
        const action = match[2];
        if (request.method === 'GET' && !action) return json(await orchestrator.store.details(id));
        if (request.method === 'DELETE' && !action) return json(await orchestrator.cancel(id));
        if (request.method === 'POST' && action === 'human') return json(await orchestrator.submitHuman(id, await body(request)));
        if (request.method === 'POST' && action === 'continue') {
          const value = await body(request);
          return json(await orchestrator.continueRound(id, value.note));
        }
        if (request.method === 'POST' && action === 'accept') {
          const value = await body(request);
          return json(await orchestrator.acceptCurrent(id, value.reason));
        }
        if (request.method === 'POST' && action === 'rerun') return json(await orchestrator.rerun(id));
        if (request.method === 'POST' && action === 'export-draft') {
          const value = await body(request);
          return json(await orchestrator.exportDraft(id, (value.round ?? 'init') as string | number));
        }
        if (request.method === 'POST' && action === 'retry') return json(await orchestrator.retry(id));
        if (request.method === 'POST' && action === 'retry-snapshot') return json(await orchestrator.retrySnapshot(id));
        if (request.method === 'POST' && action === 'retry-current-agent') return json(await orchestrator.retryWithCurrentAgent(id));
        if (request.method === 'GET' && action === 'logs') return json(await orchestrator.store.recentLogs(id));
      }

      if (request.method === 'GET' && (path === '/' || path === '/index.html')) return staticFile('index.html');
      if (request.method === 'GET' && path === '/app.js') return staticFile('app.js');
      if (request.method === 'GET' && path === '/styles.css') return staticFile('styles.css');
      return errorResponse(new Error('not found'), 404);
    } catch (error) {
      const message = (error as Error).message || String(error);
      const status = /not found|missing artifact/i.test(message) ? 404 : /already has an active task|stage=/.test(message) ? 409 : 400;
      return errorResponse(error, status);
    }
  },
});

console.log(`Writer Room running at http://${server.hostname}:${server.port}`);
console.log(`Runs: ${orchestrator.store.root}`);
