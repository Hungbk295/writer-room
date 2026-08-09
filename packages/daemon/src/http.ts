/** Spy daemon — local HTTP API + static UI for Tauri webview. */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentDefinition, TeamGuardConfig } from '@writer-room/shared';
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
import { createAgentHarness, type AgentHarness } from './harness.ts';
import { TEAM_CHANNEL } from './agents/index.ts';
import { ANALYZE_STAGE, registerTrainingSettleListener } from './training/aggregator.ts';
import { preflightVideo } from './training/preflight.ts';
import { runFormulaDiscovery } from './training/orchestrator.ts';
import { getFormula, listFormulas } from './training/storage.ts';

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
  harness: AgentHarness;
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

  const harness = await createAgentHarness({ dataDir: root, defaultProjectRoot: APP_ROOT });

  // Training (M1): register the ANALYZE-settle -> Formula-aggregation listener
  // exactly once per daemon process here, where `harness` and `spy` are already in
  // scope together (see `training/orchestrator.ts`'s wiring-note doc comment for why
  // this does NOT live on `harness.ts`).
  registerTrainingSettleListener(harness.pipeline.scheduler, { dataDir: root, spy });

  const webRoot = resolve(APP_ROOT, 'packages/web/dist');
  return { spy, harness, startedAt: Date.now(), webRoot };
}

export function createHandler(app: HttpApp): (req: Request) => Promise<Response> {
  const { spy, harness, startedAt, webRoot } = app;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    try {
      if (method === 'GET' && pathname === '/api/health') {
        const mcp = harness.teamMcpInfo();
        return json({
          ok: true,
          spy: SPY_FEATURE.enabled,
          agents: harness.listAgents().length,
          teamMcp: mcp ? { url: mcp.url } : null,
          uptimeMs: Date.now() - startedAt,
        });
      }

      // ── Agents ────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/agents') {
        // Re-seed defaults if config was wiped or first boot under old daemon data dir.
        const { ensureDefaultAgents } = await import('./agents/defaults.ts');
        ensureDefaultAgents(harness.config, APP_ROOT);
        return json({
          // Pipeline lane-scheduler clones (`ephemeral: true`) are internal
          // dispatch state, not agents a human configures — never surface them here.
          agents: harness.listAgents().filter((a) => a.ephemeral !== true),
          guards: harness.config.guards(),
          defaults: ['claude', 'codex', 'agy', 'grok'],
        });
      }

      if (method === 'POST' && pathname === '/api/agents/seed-defaults') {
        const { ensureDefaultAgents } = await import('./agents/defaults.ts');
        const agents = ensureDefaultAgents(harness.config, APP_ROOT);
        return json({ ok: true, agents, seeded: agents.map((a) => a.id) });
      }

      if ((method === 'PUT' || method === 'POST') && pathname === '/api/agents') {
        const body = await readBody(req);
        // Accept { agent: {...} } or the agent object at the top level (dna-spy style).
        const raw = (body['agent'] && typeof body['agent'] === 'object')
          ? body['agent']
          : body;
        if (!raw || typeof raw !== 'object' || !('id' in raw || 'name' in raw)) {
          return error('agent object bắt buộc (id/name/adapter/…)');
        }
        const agent = raw as AgentDefinition;
        if (!agent.id?.trim() && agent.name?.trim()) {
          agent.id = agent.name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'agent';
        }
        return json({ agent: harness.agents.save(agent) });
      }

      const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(pathname);
      if (method === 'DELETE' && agentMatch) {
        const ok = harness.agents.delete(decodeURIComponent(agentMatch[1]!));
        if (!ok) return error('agent không tồn tại', 404);
        return json({ ok: true, deleted: true });
      }

      if (method === 'POST' && pathname === '/api/agents/detect') {
        const body = await readBody(req);
        const adapter = String(body['adapter'] ?? '');
        const executable = typeof body['executable'] === 'string' ? body['executable'] : undefined;
        if (!adapter) return error('adapter bắt buộc');
        return json(await harness.agents.detect(adapter as AgentDefinition['adapter'], executable));
      }

      if (method === 'POST' && pathname === '/api/agents/prepare-launch') {
        const body = await readBody(req);
        const agentId = String(body['agentId'] ?? '');
        const cwd = typeof body['cwd'] === 'string' ? body['cwd'] : undefined;
        if (!agentId) return error('agentId bắt buộc');
        return json(await harness.agents.prepareLaunch(agentId, cwd));
      }

      if (method === 'POST' && pathname === '/api/agents/launch-preview') {
        const body = await readBody(req);
        const agentId = String(body['agentId'] ?? '');
        if (!agentId) return error('agentId bắt buộc');
        return json(harness.agents.launchPreview(agentId));
      }

      if (method === 'POST' && pathname === '/api/agents/readiness') {
        const body = await readBody(req);
        const agentId = String(body['agentId'] ?? '');
        const cwd = typeof body['cwd'] === 'string' ? body['cwd'] : undefined;
        if (!agentId) return error('agentId bắt buộc');
        return json(await harness.agents.launchReadiness(agentId, cwd));
      }

      if (method === 'PUT' && pathname === '/api/agents/guards') {
        const body = await readBody(req);
        return json({ guards: harness.config.setGuards(body as Partial<TeamGuardConfig>) });
      }

      // ── Team hub ──────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/team/mcp') {
        const info = harness.teamMcpInfo();
        if (!info) return error('MCP team server chưa sẵn sàng', 503);
        return json(info);
      }

      if (method === 'GET' && pathname === '/api/team/status') {
        return json({
          workflow: harness.workflow.status(),
          agents: harness.store.agentStates(),
          audit: harness.store.listAudit(50),
        });
      }

      if (method === 'GET' && pathname === '/api/team/messages') {
        const channel = url.searchParams.get('channel') || TEAM_CHANNEL;
        const afterCursor = Number(url.searchParams.get('afterCursor') || 0);
        const limit = Number(url.searchParams.get('limit') || 50);
        return json({
          messages: harness.store.read({
            channel,
            afterCursor: Number.isFinite(afterCursor) ? afterCursor : 0,
            limit: Number.isFinite(limit) ? limit : 50,
          }),
          latestCursor: harness.store.latestCursor(channel),
        });
      }

      if (method === 'POST' && pathname === '/api/team/messages') {
        const body = await readBody(req);
        const msg = harness.store.send({
          channel: String(body['channel'] ?? TEAM_CHANNEL),
          senderAgentId: String(body['senderAgentId'] ?? 'human'),
          body: String(body['body'] ?? ''),
          mentions: Array.isArray(body['mentions']) ? body['mentions'].map(String) : [],
          replyTo: typeof body['replyTo'] === 'string' ? body['replyTo'] : undefined,
          idempotencyKey: typeof body['idempotencyKey'] === 'string' ? body['idempotencyKey'] : undefined,
        });
        harness.workflow.handleNewMessage(msg);
        return json({ message: msg }, 201);
      }

      if (method === 'POST' && pathname === '/api/team/assign') {
        const body = await readBody(req);
        const agentId = String(body['agentId'] ?? '');
        const task = String(body['task'] ?? '');
        if (!agentId || !task.trim()) return error('agentId và task bắt buộc');
        const assignment = harness.store.setAssignment(agentId, task, String(body['assignedBy'] ?? 'human'));
        const turn = harness.workflow.requestTurn(agentId, 'assignment', undefined, {
          taskNote: task,
          orchestrated: body['orchestrated'] === true,
          persistentInteractive: body['persistentInteractive'] === true,
        });
        return json({ assignment, turn });
      }

      if (method === 'POST' && pathname === '/api/team/turn/complete') {
        const body = await readBody(req);
        const turnId = Number(body['turnId']);
        const exitCode = body['exitCode'] === null || body['exitCode'] === undefined
          ? null
          : Number(body['exitCode']);
        if (!Number.isInteger(turnId)) return error('turnId không hợp lệ');
        harness.workflow.turnComplete(turnId, {
          exitCode,
          resumeSessionRef: typeof body['resumeSessionRef'] === 'string' ? body['resumeSessionRef'] : undefined,
        });
        return json({ ok: true });
      }

      if (method === 'POST' && pathname === '/api/team/turn/heartbeat') {
        const body = await readBody(req);
        const turnId = Number(body['turnId']);
        if (!Number.isInteger(turnId)) return error('turnId không hợp lệ');
        return json(harness.workflow.heartbeat(turnId));
      }

      if (method === 'POST' && pathname === '/api/team/interrupt') {
        const body = await readBody(req);
        if (typeof body['turnId'] === 'number') {
          return json(harness.workflow.interruptTurn(body['turnId']));
        }
        const agentId = String(body['agentId'] ?? '');
        if (!agentId) return error('agentId hoặc turnId bắt buộc');
        return json(harness.workflow.interruptAgent(agentId));
      }

      if (method === 'POST' && pathname === '/api/team/stop-all') {
        return json(harness.workflow.stopAll());
      }

      if (method === 'POST' && pathname === '/api/team/reset') {
        harness.workflow.reset();
        return json({ ok: true, workflow: harness.workflow.status() });
      }

      // SSE: team events (spawnTurn, turnSettled, …)
      if (method === 'GET' && pathname === '/api/team/events') {
        const encoder = new TextEncoder();
        let unsub: (() => void) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: unknown) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            unsub = harness.subscribe(send);
            send({ kind: 'hello', at: Date.now(), agents: harness.listAgents().map((a) => a.id) });
            heartbeat = setInterval(() => {
              try { controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`)); } catch { /* closed */ }
            }, 15_000);
          },
          cancel() {
            unsub?.();
            if (heartbeat) clearInterval(heartbeat);
          },
        });
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        });
      }

      // ── Pipeline (M0.5) ───────────────────────────────────────
      // Manual/test dispatch entry point. Training/Writer orchestrators (M1+) will
      // call `harness.pipeline.scheduler.dispatchItem` directly instead of going
      // through HTTP — this route exists so the walking skeleton is exercisable
      // without a domain lane built on top of it yet.
      if (method === 'POST' && pathname === '/api/pipeline/items/dispatch') {
        const body = await readBody(req);
        const batchId = String(body['batchId'] ?? '');
        const itemId = String(body['itemId'] ?? '');
        const stage = String(body['stage'] ?? '');
        const templateId = String(body['templateId'] ?? '');
        const promptMarkdown = typeof body['promptMarkdown'] === 'string' ? body['promptMarkdown'] : '';
        const promptVersion = String(body['promptVersion'] ?? '');
        const attempt = Number(body['attempt']);
        if (!batchId || !itemId || !stage || !templateId || !promptMarkdown.trim()
          || !promptVersion || !Number.isInteger(attempt)) {
          return error('batchId, itemId, stage, templateId, promptMarkdown, promptVersion, attempt (số nguyên) đều bắt buộc');
        }
        const inputHashes = Array.isArray(body['inputHashes']) ? body['inputHashes'].map(String) : [];
        const result = await harness.pipeline.scheduler.dispatchItem({
          batchId, itemId, stage, attempt, templateId, promptMarkdown, promptVersion, inputHashes,
          envelope: body['envelope'] ?? {},
        });
        return json(result);
      }

      if (method === 'GET' && pathname === '/api/pipeline/health') {
        return json({
          ok: true,
          maxParallel: harness.pipeline.scheduler.getMaxParallel(),
          liveClones: harness.pipeline.scheduler.getLiveCloneCount(),
          ledgerRows: harness.pipeline.ledger.all().length,
        });
      }

      // ── Training (M1) ─────────────────────────────────────────
      if (method === 'POST' && pathname === '/api/training/preflight') {
        const body = await readBody(req);
        const videoSnapshotId = String(body['videoSnapshotId'] ?? '');
        if (!videoSnapshotId) return error('videoSnapshotId bắt buộc');
        return json(await preflightVideo(spy, harness.agents, videoSnapshotId));
      }

      if (method === 'POST' && pathname === '/api/training/formula-discovery') {
        const body = await readBody(req);
        const videoSnapshotId = String(body['videoSnapshotId'] ?? '');
        if (!videoSnapshotId) return error('videoSnapshotId bắt buộc');
        const batchId = typeof body['batchId'] === 'string' && body['batchId'].trim()
          ? body['batchId']
          : randomUUID();
        const result = await runFormulaDiscovery(
          { spy, agents: harness.agents, scheduler: harness.pipeline.scheduler },
          { batchId, videoSnapshotId },
        );
        return json({ batchId, ...result });
      }

      if (method === 'GET' && pathname === '/api/training/formulas') {
        return json({ formulas: await listFormulas() });
      }

      const formulaMatch = /^\/api\/training\/formulas\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && formulaMatch) {
        const formula = await getFormula(decodeURIComponent(formulaMatch[1]!));
        if (!formula) return error('Formula không tồn tại', 404);
        return json(formula);
      }

      if (method === 'GET' && pathname === '/api/training/formula-discovery/status') {
        const batchId = url.searchParams.get('batchId') ?? '';
        const videoSnapshotId = url.searchParams.get('videoSnapshotId') ?? '';
        if (!batchId || !videoSnapshotId) return error('batchId và videoSnapshotId bắt buộc');
        // `all()` already returns one row per turnKey, latest version wins (see
        // `StageLedger`'s constructor comment) — but more than one turnKey can match
        // this (batchId, itemId, stage) key (e.g. retried attempts), so still pick
        // the row with the latest `recordedAt` among matches.
        const rows = harness.pipeline.ledger.all().filter((row) =>
          row.batchId === batchId && row.itemId === videoSnapshotId && row.stage === ANALYZE_STAGE
        );
        if (rows.length === 0) return json({ found: false });
        const latest = rows.reduce((a, b) => (Date.parse(b.recordedAt) > Date.parse(a.recordedAt) ? b : a));
        return json({
          found: true,
          status: latest.outcome,
          errorCode: latest.errorCode,
          artifactHash: latest.artifactHash,
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

  const mcp = app.harness.teamMcpInfo();
  console.log(`Writer Room http://127.0.0.1:${server.port}`);
  console.log(`data: ${dataRoot()}`);
  console.log(`spy: ${SPY_FEATURE.enabled ? 'on' : 'off'}`);
  console.log(`agents: ${app.harness.listAgents().map((a) => a.id).join(', ')}`);
  console.log(`team-mcp: ${mcp?.url ?? 'off'}`);
  console.log(`ui: ${existsSync(app.webRoot) ? app.webRoot : '(run bun run ui:build)'}`);

  const shutdown = async () => {
    app.harness.dispose();
    await releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
