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
import { importFormulaDiscoveryResult, runFormulaDiscovery, startInteractiveFormulaDiscovery } from './training/orchestrator.ts';
import {
  deleteFormula,
  deleteTrainingLabRun,
  getFormula,
  getTrainingLabRun,
  listFormulas,
  listTrainingLabRuns,
} from './training/storage.ts';
import { DEFAULT_AGENT_IDS, registerTrainingLabSettleListener, startTrainingLabRun, type DefaultAgentId } from './training/training-lab.ts';
import {
  applyProposalDecision,
  createStudioSession,
  deleteStudioSession,
  getStudioSession,
  listRulePool,
  listStudioSessions,
  promoteCompound,
  rebuildCompound,
  recomputeClusters,
  saveStudioSession,
} from './training/studio.ts';
import { registerStudioSynthesizeSettleListener, startStudioSynthesize } from './training/studio-synthesize.ts';

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

/** Shared by every route that accepts a user-chosen agent id (Training Lab's
 * draft/critique agents, Studio's SYNTHESIZE agent) — factored out here (was inline
 * only at the Training Lab route) so a second call site did not have to re-copy the
 * same type guard. */
function isDefaultAgentId(v: unknown): v is DefaultAgentId {
  return typeof v === 'string' && (DEFAULT_AGENT_IDS as readonly string[]).includes(v);
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

  // Training Lab (M1.5, SDD §12a): register the DRAFT/CRITIQUE/REFINE-settle
  // calibration-loop listener exactly once per daemon process, right beside the M1
  // listener above — both subscribe to the same `onItemSettled` source and each
  // ignores events the other owns (see `training-lab.ts`'s doc comment).
  registerTrainingLabSettleListener(harness.pipeline.scheduler, { dataDir: root, spy });

  // Formula Studio SYNTHESIZE (P3, SDD §12b): registered once here too — no `spy`
  // needed, SYNTHESIZE's envelope is just cluster statements, never a transcript.
  registerStudioSynthesizeSettleListener(harness.pipeline.scheduler, { dataDir: root });

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

      // Interactive (PTY) Formula Discovery — semi-auto path (2026-08-10, user:
      // "tự mở agent terminal, gửi message, đợi session xong thì tôi sẽ tự tạo và
      // import kết quả", modeled on their own dna-spy semi-auto pattern). Does NOT
      // go through `LaneScheduler` — see `orchestrator.ts`'s doc comment on
      // `startInteractiveFormulaDiscovery` for why.
      if (method === 'POST' && pathname === '/api/training/formula-discovery/interactive') {
        const body = await readBody(req);
        const videoSnapshotId = String(body['videoSnapshotId'] ?? '');
        if (!videoSnapshotId) return error('videoSnapshotId bắt buộc');
        const rawTemplateId = body['templateId'];
        if (!isDefaultAgentId(rawTemplateId)) {
          return error(`templateId không hợp lệ — phải là một trong: ${DEFAULT_AGENT_IDS.join(', ')}`);
        }
        const result = await startInteractiveFormulaDiscovery(
          { spy, agents: harness.agents, dataDir: dataRoot() },
          { videoSnapshotId, templateId: rawTemplateId },
        );
        return json(result);
      }

      const formulaImportMatch = /^\/api\/training\/formulas\/([^/]+)\/import$/.exec(pathname);
      if (method === 'POST' && formulaImportMatch) {
        const result = await importFormulaDiscoveryResult(
          { spy, dataDir: dataRoot() },
          { formulaId: decodeURIComponent(formulaImportMatch[1]!) },
        );
        return json(result);
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
      if (method === 'DELETE' && formulaMatch) {
        const ok = await deleteFormula(decodeURIComponent(formulaMatch[1]!));
        if (!ok) return error('Formula không tồn tại', 404);
        return json({ ok: true });
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

      // ── Training Lab (M1.5) ───────────────────────────────────
      if (method === 'POST' && pathname === '/api/training/lab/start') {
        const body = await readBody(req);
        const formulaId = String(body['formulaId'] ?? '');
        if (!formulaId) return error('formulaId bắt buộc');
        const formula = await getFormula(formulaId);
        if (!formula) return error('Formula không tồn tại', 404);
        // The Training Lab critiques a draft against ONE pinned transcript (§12a), so it
        // needs a single source video. A COMPOUND Formula draws on several by
        // construction — that is not a uniformity gap but the reason the Studio has its
        // own multi-video-grounded test-write (§12b). Say so plainly instead of leaking
        // "includedArtifacts rỗng" at the user.
        if (formula.origin === 'COMPOUND') {
          return error('Formula ghép có nhiều video nguồn — dùng chức năng viết thử trong Studio, không phải Training Lab');
        }
        const videoSnapshotId = formula.videoSnapshotId ?? formula.includedArtifacts[0]?.videoSnapshotId;
        if (!videoSnapshotId) return error('Formula không xác định được video nguồn');
        // Agent choice per role (2026-08-10, user: "cần có thêm setup chọn loại agent
        // cho agent 1 và agent 2"). Default to 'grok' for callers that omit it
        // (matches the hardcoded behavior before this was configurable).
        const rawDraftAgent = body['draftAgent'];
        const rawCritiqueAgent = body['critiqueAgent'];
        if (rawDraftAgent !== undefined && !isDefaultAgentId(rawDraftAgent)) {
          return error(`draftAgent không hợp lệ — phải là một trong: ${DEFAULT_AGENT_IDS.join(', ')}`);
        }
        if (rawCritiqueAgent !== undefined && !isDefaultAgentId(rawCritiqueAgent)) {
          return error(`critiqueAgent không hợp lệ — phải là một trong: ${DEFAULT_AGENT_IDS.join(', ')}`);
        }
        const draftAgent: DefaultAgentId = isDefaultAgentId(rawDraftAgent) ? rawDraftAgent : 'grok';
        const critiqueAgent: DefaultAgentId = isDefaultAgentId(rawCritiqueAgent) ? rawCritiqueAgent : 'grok';
        const run = await startTrainingLabRun(
          { spy, scheduler: harness.pipeline.scheduler, dataDir: dataRoot() },
          { videoSnapshotId, startingFormula: formula, draftAgent, critiqueAgent },
        );
        return json(run, 201);
      }

      if (method === 'GET' && pathname === '/api/training/lab/runs') {
        return json({ runs: await listTrainingLabRuns() });
      }

      const labRunMatch = /^\/api\/training\/lab\/runs\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && labRunMatch) {
        const run = await getTrainingLabRun(decodeURIComponent(labRunMatch[1]!));
        if (!run) return error('Training Lab run không tồn tại', 404);
        return json(run);
      }
      if (method === 'DELETE' && labRunMatch) {
        const ok = await deleteTrainingLabRun(decodeURIComponent(labRunMatch[1]!));
        if (!ok) return error('Training Lab run không tồn tại', 404);
        return json({ ok: true });
      }

      // ── Formula Studio (SDD §12b, ADR-13) ─────────────────────
      // Everything down to `synthesize` is deterministic app code — no model call, no
      // token spent. SYNTHESIZE (P3, below) is the one route that dispatches an LLM
      // turn, and even then only proposes — the human still decides (ADR-13).
      if (method === 'GET' && pathname === '/api/studio/rule-pool') {
        const includeOlderVersions = url.searchParams.get('includeOlderVersions') === 'true';
        return json({ rules: await listRulePool(dataRoot(), { includeOlderVersions }) });
      }

      if (method === 'POST' && pathname === '/api/studio/sessions') {
        const body = await readBody(req);
        const genre = String(body['genre'] ?? '').trim();
        if (!genre) return error('genre bắt buộc — compound Formula thuộc về một thể loại, không phải một kênh');
        return json(await createStudioSession(genre, dataRoot()), 201);
      }

      if (method === 'GET' && pathname === '/api/studio/sessions') {
        return json({ sessions: await listStudioSessions(dataRoot()) });
      }

      const studioSessionMatch = /^\/api\/studio\/sessions\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && studioSessionMatch) {
        const session = await getStudioSession(decodeURIComponent(studioSessionMatch[1]!), dataRoot());
        if (!session) return error('Studio session không tồn tại', 404);
        return json(session);
      }
      if (method === 'DELETE' && studioSessionMatch) {
        const ok = await deleteStudioSession(decodeURIComponent(studioSessionMatch[1]!), dataRoot());
        if (!ok) return error('Studio session không tồn tại', 404);
        return json({ ok: true });
      }

      const studioActionMatch = /^\/api\/studio\/sessions\/([^/]+)\/(picks|promote|synthesize)$/.exec(pathname);
      if (method === 'POST' && studioActionMatch) {
        const session = await getStudioSession(decodeURIComponent(studioActionMatch[1]!), dataRoot());
        if (!session) return error('Studio session không tồn tại', 404);

        if (studioActionMatch[2] === 'picks') {
          const body = await readBody(req);
          const picks = Array.isArray(body['picks']) ? body['picks'] : null;
          if (!picks) return error('picks phải là mảng { formulaId, ruleId }');
          session.picks = picks.map((p: Record<string, unknown>) => ({
            formulaId: String(p['formulaId'] ?? ''),
            ruleId: String(p['ruleId'] ?? ''),
          }));
          // Re-cluster and rebuild on every pick change: both are cheap, deterministic
          // and derived, so recomputing keeps them from ever disagreeing with `picks`.
          await recomputeClusters(session, dataRoot());
          await rebuildCompound(session, dataRoot());
          await saveStudioSession(session, dataRoot());
          return json(session);
        }

        if (studioActionMatch[2] === 'synthesize') {
          const body = await readBody(req);
          const rawAgentId = body['agentId'];
          if (rawAgentId !== undefined && !isDefaultAgentId(rawAgentId)) {
            return error(`agentId không hợp lệ — phải là một trong: ${DEFAULT_AGENT_IDS.join(', ')}`);
          }
          try {
            // Returns immediately with `synthesizeStatus: 'RUNNING'` — the turn's
            // proposals arrive later via `registerStudioSynthesizeSettleListener`,
            // which the UI observes by polling `GET .../sessions/:id` (see that
            // listener's doc comment for why no separate status endpoint exists).
            const updated = await startStudioSynthesize(
              { scheduler: harness.pipeline.scheduler, dataDir: dataRoot() },
              session,
              isDefaultAgentId(rawAgentId) ? rawAgentId : undefined,
            );
            return json(updated);
          } catch (e) {
            return error(e instanceof Error ? e.message : 'ghép thất bại');
          }
        }

        try {
          await promoteCompound(session, dataRoot());
        } catch (e) {
          return error(e instanceof Error ? e.message : 'promote thất bại');
        }
        await saveStudioSession(session, dataRoot());
        return json(session);
      }

      const studioDecisionMatch = /^\/api\/studio\/sessions\/([^/]+)\/proposals\/([^/]+)\/decision$/.exec(pathname);
      if (method === 'POST' && studioDecisionMatch) {
        const session = await getStudioSession(decodeURIComponent(studioDecisionMatch[1]!), dataRoot());
        if (!session) return error('Studio session không tồn tại', 404);
        const proposalId = decodeURIComponent(studioDecisionMatch[2]!);

        const body = await readBody(req);
        const decision = body['decision'];
        if (decision !== 'ACCEPTED' && decision !== 'REJECTED') {
          return error('decision phải là ACCEPTED hoặc REJECTED');
        }
        const rawStatement = body['statement'];
        const statement = typeof rawStatement === 'string' ? rawStatement : undefined;

        try {
          applyProposalDecision(session, proposalId, decision, statement);
        } catch (e) {
          return error(e instanceof Error ? e.message : 'decision thất bại', 404);
        }
        // ADR-13: every decision immediately re-derives the compound Formula from
        // scratch (same "cheap, deterministic, derived" reasoning `picks` already
        // follows above) — there is no path where `proposals` and `compound` can
        // disagree, even transiently between requests.
        await rebuildCompound(session, dataRoot());
        await saveStudioSession(session, dataRoot());
        return json(session);
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
      if (method === 'DELETE' && spyRunMatch) {
        if (!SPY_FEATURE.enabled) return error('Spy đang tắt', 403);
        const ok = spy.deleteSpyRun(spyRunMatch[1]!);
        if (!ok) return error('Spy run không tồn tại', 404);
        return json({ ok: true });
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

      if (method === 'POST' && pathname === '/api/spy/video') {
        if (!SPY_FEATURE.enabled) return error('Spy đang tắt', 403);
        const body = await readBody(req);
        const urlValue = String(body['url'] ?? '');
        if (!urlValue) return error('url bắt buộc');
        const started = spy.videoSpy({
          url: urlValue,
          depth: body['depth'] === 'metadata' || body['depth'] === 'transcript'
            ? body['depth']
            : 'transcript',
          idempotencyKey: `http-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
