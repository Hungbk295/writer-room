import { test, expect } from 'bun:test';
import { existsSync, realpathSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchTaskStore } from '../../src/research-task/store.ts';
import { ResearchTokenRegistry } from '../../src/research-task/tokens.ts';
import { McpResearchServer } from '../../src/research-task/mcp.ts';

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'research-lifecycle-'));
  const store = new ResearchTaskStore(join(root, 'task.sqlite'), join(root, 'artifacts'));
  const owner = { role: 'operator' as const, subject: 'owner-1' };
  const worker = { role: 'worker' as const, subject: 'w-1', profile: 'research' };
  const worker2 = { role: 'worker' as const, subject: 'w-2', profile: 'research' };
  const future = () => new Date(Date.now() + 3_600_000).toISOString();
  const task = store.create(owner, { commandId: 'create', taskId: 't1', mode: 'keyword', input: { q: 'x' } });
  return { root, store, owner, worker, worker2, future, task };
};

test('queue claim by profile without workerSubject; worker isolation', () => {
  const { store, owner, worker, worker2, future, task } = setup();
  try {
    store.bind(owner, 't1', { commandId: 'bind', expectedVersion: task.version, profile: 'research' });
    // A different worker subject on the same profile wins an open queue slot.
    const claimed = store.claim(worker2, { commandId: 'c', profile: 'research', sessionRef: 's2', leaseUntil: future() })!;
    expect(claimed.worker_subject).toBe('w-2');
    expect(claimed.phase).toBe('running');
    // The losing worker cannot mutate the task.
    expect(() => store.reserve(worker, 't1', { commandId: 'r', expectedVersion: claimed.version, roundIndex: 1, planHash: 'h', searchCost: 1 })).toThrow();
    // Second claim on an empty queue returns null, not an error.
    expect(store.claim(worker, { commandId: 'c2', profile: 'research', sessionRef: 's', leaseUntil: future() })).toBeNull();
  } finally { store.close(); }
});

test('expired lease locks out worker; operator mark_unknown then rebind to a new worker', () => {
  const { store, owner, worker, worker2, task } = setup();
  try {
    store.bind(owner, 't1', { commandId: 'bind', expectedVersion: task.version, workerSubject: 'w-1', profile: 'research' });
    store.claim(worker, { commandId: 'c', profile: 'research', sessionRef: 's1', leaseUntil: new Date(Date.now() + 60_000).toISOString() });
    // Expire the lease manually.
    store.db.query("UPDATE research_tasks SET lease_until=? WHERE id='t1'").run(new Date(Date.now() - 1000).toISOString());
    const stale = store.get(owner, 't1');
    expect(stale.leaseExpired).toBe(true);
    expect(() => store.heartbeat(worker, 't1', { commandId: 'hb', expectedVersion: stale.version, leaseUntil: new Date(Date.now() + 60_000).toISOString() })).toThrow();
    const unknown = store.transition(owner, 't1', { commandId: 'mu', expectedVersion: stale.version, action: 'mark_unknown' });
    expect(unknown.phase).toBe('unknown');
    const rebound = store.bind(owner, 't1', { commandId: 'rebind', expectedVersion: unknown.version, profile: 'research' });
    const reclaimed = store.claim(worker2, { commandId: 'c3', profile: 'research', sessionRef: 's3', leaseUntil: new Date(Date.now() + 60_000).toISOString() })!;
    expect(reclaimed.worker_subject).toBe('w-2');
    expect(rebound.phase).toBe('ready');
  } finally { store.close(); }
});

test('cancel ack releases outstanding reservation; budget not double-counted on duplicate command', () => {
  const { root, store, owner, worker, future, task } = setup();
  try {
    store.bind(owner, 't1', { commandId: 'bind', expectedVersion: task.version, profile: 'research' });
    const claimed = store.claim(worker, { commandId: 'c', profile: 'research', sessionRef: 's', leaseUntil: future() })!;
    const reserved = store.reserve(worker, 't1', { commandId: 'r1', expectedVersion: claimed.version, roundIndex: 1, planHash: 'h', searchCost: 5 });
    expect(reserved.budget.reservedSearch).toBe(5);
    // Duplicate command replays the stored receipt — no second reservation, no version bump.
    const replay = store.reserve(worker, 't1', { commandId: 'r1', expectedVersion: claimed.version, roundIndex: 1, planHash: 'h', searchCost: 5 });
    expect(replay.version).toBe(reserved.version);
    expect(store.list(owner)[0].budget.reservedSearch).toBe(5);
    const cancelReq = store.transition(owner, 't1', { commandId: 'cx', expectedVersion: replay.version, action: 'cancel' });
    const cancelled = store.transition(worker, 't1', { commandId: 'cxa', expectedVersion: cancelReq.version, action: 'cancel_ack' });
    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.budget.reservedSearch).toBe(0);
    writeFileSync(join(root, 'artifacts', 't1', 'late.txt'), 'x');
  } finally { store.close(); }
});

test('instruct is durable and applies at the next reserve boundary', () => {
  const { store, owner, worker, future, task } = setup();
  try {
    store.bind(owner, 't1', { commandId: 'bind', expectedVersion: task.version, profile: 'research' });
    const claimed = store.claim(worker, { commandId: 'c', profile: 'research', sessionRef: 's', leaseUntil: future() })!;
    store.instruct(owner, 't1', { commandId: 'i1', expectedVersion: claimed.version, instruction: 'đổi sang chủ đề B' });
    const reserved = store.reserve(worker, 't1', { commandId: 'r1', expectedVersion: claimed.version + 1, roundIndex: 1, planHash: 'h', searchCost: 1 });
    expect(reserved.pending_command).toBeNull();
    const types = store.events(owner, 't1').map((e: any) => e.type);
    expect(types).toContain('instruction_queued');
    expect(types).toContain('instruction_applied');
  } finally { store.close(); }
});

test('crash/restart: reopening the same db preserves state and the event cursor continues', () => {
  const { root, store, owner, worker, future, task } = setup();
  const dbPath = join(root, 'task.sqlite');
  try {
    store.bind(owner, 't1', { commandId: 'bind', expectedVersion: task.version, profile: 'research' });
    store.claim(worker, { commandId: 'c', profile: 'research', sessionRef: 's', leaseUntil: future() });
    const cursorBefore = (store.events(owner, 't1').at(-1) as any).cursor as number;
    store.close();
    const reopened = new ResearchTaskStore(dbPath, join(root, 'artifacts'));
    const after = reopened.get(owner, 't1');
    expect(after.phase).toBe('running');
    expect(after.worker_subject).toBe('w-1');
    reopened.reserve(worker, 't1', { commandId: 'r1', expectedVersion: after.version, roundIndex: 1, planHash: 'h', searchCost: 1 });
    const events = reopened.events(owner, 't1', cursorBefore);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e: any) => e.cursor > cursorBefore)).toBe(true);
    reopened.close();
  } catch (e) { try { store.close(); } catch {} throw e; }
});

test('hard gate: spyRunIds verified against source-of-truth; artifact drift blocks completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'research-gate-'));
  const runs: Record<string, { status: string; videoIds: string[] }> = {
    'spy-real': { status: 'completed', videoIds: ['v1'] },
    'spy-running': { status: 'running', videoIds: [] },
  };
  const store = new ResearchTaskStore(join(root, 'task.sqlite'), join(root, 'artifacts'), { spyRunInfo: (id) => runs[id] ?? null });
  const owner = { role: 'operator' as const, subject: 'o' };
  const worker = { role: 'worker' as const, subject: 'w', profile: 'research' };
  const future = () => new Date(Date.now() + 60_000).toISOString();
  try {
    const t = store.create(owner, { commandId: 'c', taskId: 't1', mode: 'k', input: {}, budget: { maxRounds: 2, maxUniqueVideos: 5, maxSearchCost: 5 } });
    store.bind(owner, 't1', { commandId: 'b', expectedVersion: t.version, profile: 'research' });
    const claimed = store.claim(worker, { commandId: 'cl', profile: 'research', sessionRef: 's', leaseUntil: future() })!;
    const r = store.reserve(worker, 't1', { commandId: 'r', expectedVersion: claimed.version, roundIndex: 1, planHash: 'h', searchCost: 1 });
    // Fabricated Spy run ref is rejected at settle time.
    expect(() => store.completeRound(worker, 't1', { commandId: 'bad', expectedVersion: r.version, roundIndex: 1, actualSearch: 1, spyRunIds: ['spy-fake'], videos: [] })).toThrow(/spy-fake/);
    // A run that exists but is not completed is also rejected.
    expect(() => store.completeRound(worker, 't1', { commandId: 'bad2', expectedVersion: r.version, roundIndex: 1, actualSearch: 1, spyRunIds: ['spy-running'], videos: [] })).toThrow(/not completed/);
    // A video not present in the run's manifest is rejected.
    expect(() => store.completeRound(worker, 't1', { commandId: 'bad3', expectedVersion: r.version, roundIndex: 1, actualSearch: 1, spyRunIds: ['spy-real'], videos: [{ videoId: 'v-ghost', spyRunId: 'spy-real' }] })).toThrow(/v-ghost/);
    const done = store.completeRound(worker, 't1', { commandId: 'rc', expectedVersion: r.version, roundIndex: 1, actualSearch: 1, spyRunIds: ['spy-real'], videos: [{ videoId: 'v1', spyRunId: 'spy-real' }] });
    writeFileSync(join(root, 'artifacts', 't1', 'manifest.json'), JSON.stringify({ spyRunIds: ['spy-real'] }));
    writeFileSync(join(root, 'artifacts', 't1', 'report.md'), 'report');
    const a1 = store.registerArtifact(worker, 't1', { commandId: 'a1', expectedVersion: done.version, roundIndex: 1, type: 'manifest', path: join(root, 'artifacts', 't1', 'manifest.json') });
    const a2 = store.registerArtifact(worker, 't1', { commandId: 'a2', expectedVersion: a1.version, roundIndex: 1, type: 'report', path: join(root, 'artifacts', 't1', 'report.md') });
    // Tamper the report after registration → completion must fail.
    writeFileSync(join(root, 'artifacts', 't1', 'report.md'), 'tampered');
    expect(() => store.completeTask(worker, 't1', { commandId: 'f', expectedVersion: a2.version })).toThrow(/drifted/);
    writeFileSync(join(root, 'artifacts', 't1', 'report.md'), 'report');
    expect(store.completeTask(worker, 't1', { commandId: 'f', expectedVersion: a2.version }).phase).toBe('completed');
  } finally { store.close(); }
});

test('token registry: legacy real-dir fixture heals profile/role drift, keeps issued tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'research-tokens-'));
  // Mirrors the actual writer-room-data/config/hermes-actors.json dev-1 provisioned.
  writeFileSync(join(root, 'actors.json'), JSON.stringify({ actors: [
    { role: 'operator', subject: 'hermes:wr-operator', token: 'op-token-aaaaaaaaaaaaaaaa' },
    { role: 'worker', subject: 'hermes:wr-researcher', profile: 'wr-researcher', token: 'wk-token-bbbbbbbbbbbbbbbb' },
    { role: 'worker', subject: 'hermes:wr-writer', profile: 'writer', token: 'ww-token-cccccccccccccccc' },
  ] }));
  const registry = new ResearchTokenRegistry(join(root, 'actors.json'));
  const op = registry.ensure({ role: 'operator', subject: 'hermes:wr-operator' });
  expect(op.token).toBe('op-token-aaaaaaaaaaaaaaaa');
  const healed = registry.ensure({ role: 'worker', subject: 'hermes:wr-researcher', profile: 'research' });
  expect((healed as { profile?: string }).profile).toBe('research');
  expect(healed.token).toBe('wk-token-bbbbbbbbbbbbbbbb');
  // wr-writer was provisioned as a worker — the Research surface revokes the
  // grant entirely (leader decision: no Research access for the writer
  // identity in P1/W1); its token stops resolving.
  expect(registry.revokeSubject('hermes:wr-writer')).toBe(true);
  expect(registry.revokeSubject('hermes:wr-writer')).toBe(false); // idempotent
  const reopened = new ResearchTokenRegistry(join(root, 'actors.json'));
  expect(reopened.resolve('wk-token-bbbbbbbbbbbbbbbb')).toEqual({ role: 'worker', subject: 'hermes:wr-researcher', profile: 'research' });
  expect(reopened.resolve('ww-token-cccccccccccccccc')).toBeNull();
  expect(reopened.resolve('nope')).toBeNull();
});

test('revoked wr-writer token is 401 on the Research MCP surface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-mcp-'));
  const store = new ResearchTaskStore(join(root, 'task.sqlite'), join(root, 'artifacts'));
  const registry = new ResearchTokenRegistry(join(root, 'actors.json'));
  // Simulate a legacy worker grant, then boot-time revocation.
  registry.ensure({ role: 'worker', subject: 'hermes:wr-writer', profile: 'writer' });
  const grant = registry.tokenFor('worker', 'hermes:wr-writer')!;
  registry.revokeSubject('hermes:wr-writer');
  const server = new McpResearchServer(store, registry);
  try {
    const res = await server.handleFetch(new Request('http://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${grant}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }));
    expect(res.status).toBe(401);
  } finally { store.close(); }
});

test('cross-repo: daemon seed queue === Hermes RESEARCH_QUEUE', () => {
  // The queue string is a two-repo contract: daemon seed (http.ts) must equal
  // wr-runtime.py RESEARCH_QUEUE. Fails loud if either side drifts.
  const daemonSrc = readFileSync(join(import.meta.dir, '../../src/http.ts'), 'utf8');
  const seed = daemonSrc.match(/subject:\s*'hermes:wr-researcher',\s*profile:\s*'([^']+)'/)?.[1];
  expect(seed).toBe('research');
  const hermesPy = join(import.meta.dir, '../../../../../hermes/scripts/wr-runtime.py');
  if (existsSync(hermesPy)) {
    const q = readFileSync(hermesPy, 'utf8').match(/RESEARCH_QUEUE\s*=\s*'([^']+)'/)?.[1];
    expect(q).toBe(seed);
  }
});

const rpc = async (server: McpResearchServer, token: string, method: string, params: unknown = {}) => {
  const res = await server.handleFetch(new Request('http://x/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  return res.json() as any;
};

test('MCP: token scopes the actor; tools/list and tools/call are both filtered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-mcp-'));
  const store = new ResearchTaskStore(join(root, 'task.sqlite'), join(root, 'artifacts'));
  const registry = new ResearchTokenRegistry(join(root, 'actors.json'));
  const op = registry.ensure({ role: 'operator', subject: 'owner-1' });
  const wk = registry.ensure({ role: 'worker', subject: 'w-1', profile: 'research' });
  const vw = registry.ensure({ role: 'viewer', subject: 'hermes:wr-writer' });
  const server = new McpResearchServer(store, registry);
  try {
    const unauth = await server.handleFetch(new Request('http://x/mcp', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' }));
    expect(unauth.status).toBe(401);
    const opTools = (await rpc(server, op.token, 'tools/list')).result.tools.map((t: any) => t.name);
    const wkTools = (await rpc(server, wk.token, 'tools/list')).result.tools.map((t: any) => t.name);
    expect(opTools).toContain('research_task_create');
    expect(opTools).not.toContain('research_task_claim');
    expect(wkTools).toContain('research_task_claim');
    expect(wkTools).not.toContain('research_task_create');
    // Viewer (writer identity) resolves but sees ZERO tools — no data access.
    const vwTools = (await rpc(server, vw.token, 'tools/list')).result.tools.map((t: any) => t.name);
    expect(vwTools).toEqual([]);
    for (const name of ['research_task_claim', 'research_task_list', 'research_task_get', 'research_task_events']) {
      const denied = await rpc(server, vw.token, 'tools/call', { name, arguments: { commandId: 'x', taskId: 't1', profile: 'research', sessionRef: 's', leaseUntil: new Date(Date.now() + 60_000).toISOString() } });
      expect(denied.error.code).toBe(-32602);
    }
    // A worker token calling an operator tool by name is rejected like an unknown tool.
    const denied = await rpc(server, wk.token, 'tools/call', { name: 'research_task_create', arguments: { commandId: 'x', mode: 'k', input: {} } });
    expect(denied.error.code).toBe(-32602);
    // Full lifecycle through the MCP surface.
    const created = JSON.parse((await rpc(server, op.token, 'tools/call', { name: 'research_task_create', arguments: { commandId: 'c1', taskId: 't1', mode: 'keyword', input: { q: 'x' }, budget: { maxRounds: 1, maxUniqueVideos: 2, maxSearchCost: 2 } } })).result.content[0].text);
    await rpc(server, op.token, 'tools/call', { name: 'research_task_bind', arguments: { commandId: 'b1', taskId: 't1', expectedVersion: created.task.version, profile: 'research' } });
    const claimed = JSON.parse((await rpc(server, wk.token, 'tools/call', { name: 'research_task_claim', arguments: { commandId: 'cl1', profile: 'research', sessionRef: 's1', leaseUntil: new Date(Date.now() + 60_000).toISOString() } })).result.content[0].text);
    expect(claimed.task.phase).toBe('running');
    const reserved = JSON.parse((await rpc(server, wk.token, 'tools/call', { name: 'research_round_reserve', arguments: { commandId: 'r1', taskId: 't1', expectedVersion: claimed.task.version, roundIndex: 1, planHash: 'h', searchCost: 1 } })).result.content[0].text);
    const roundDone = JSON.parse((await rpc(server, wk.token, 'tools/call', { name: 'research_round_complete', arguments: { commandId: 'rc1', taskId: 't1', expectedVersion: reserved.task.version, roundIndex: 1, actualSearch: 1, spyRunIds: ['spy-1'], videos: [{ videoId: 'v1', spyRunId: 'spy-1' }] } })).result.content[0].text);
    writeFileSync(join(root, 'artifacts', 't1', 'manifest.json'), JSON.stringify({ spyRunIds: ['spy-1'] }));
    writeFileSync(join(root, 'artifacts', 't1', 'report.md'), 'report');
    const a1 = JSON.parse((await rpc(server, wk.token, 'tools/call', { name: 'research_artifact_register', arguments: { commandId: 'a1', taskId: 't1', expectedVersion: roundDone.task.version, roundIndex: 1, type: 'manifest', path: join(root, 'artifacts', 't1', 'manifest.json') } })).result.content[0].text);
    const a2 = JSON.parse((await rpc(server, wk.token, 'tools/call', { name: 'research_artifact_register', arguments: { commandId: 'a2', taskId: 't1', expectedVersion: a1.artifact.version, roundIndex: 1, type: 'report', path: join(root, 'artifacts', 't1', 'report.md') } })).result.content[0].text);
    const done = JSON.parse((await rpc(server, wk.token, 'tools/call', { name: 'research_task_complete', arguments: { commandId: 'done', taskId: 't1', expectedVersion: a2.artifact.version } })).result.content[0].text);
    expect(done.task.phase).toBe('completed');
  } finally { store.close(); }
});

// ── P2: durable outbox (worker wake + operator/Telegram feed) ────────────────

test('outbox: bind wakes worker queue; ack with receipt dedupes; survives reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'research-outbox-'));
  const dbPath = join(root, 'task.sqlite');
  const artRoot = join(root, 'artifacts');
  const store = new ResearchTaskStore(dbPath, artRoot);
  const owner = { role: 'operator' as const, subject: 'owner-1' };
  const worker = { role: 'worker' as const, subject: 'w-1', profile: 'research' };
  try {
    const task = store.create(owner, { commandId: 'create', taskId: 't1', mode: 'keyword', input: {} });
    store.bind(owner, 't1', { commandId: 'bind', expectedVersion: task.version, profile: 'research' });
    // Worker queue sees the wake row for its profile.
    const wake = store.outboxPoll(worker, { audience: 'worker' });
    expect(wake.length).toBe(1);
    expect(wake[0]!.kind).toBe('worker_bound');
    expect(wake[0]!.taskId).toBe('t1');
    // Operator feed sees the same bind event on its own audience cursor.
    const feed = store.outboxPoll(owner, { audience: 'operator' });
    expect(feed.some((r) => r.kind === 'worker_bound')).toBe(true);
    // Cross-audience scoping: a worker cannot poll the operator feed.
    expect(() => store.outboxPoll(worker, { audience: 'operator' })).toThrow();
    expect(() => store.outboxPoll(owner, { audience: 'worker' })).toThrow();
    // Ack with receipt → undelivered set drains; replaying the ack is a no-op.
    const ack1 = store.outboxAck(worker, { audience: 'worker', throughCursor: wake[0]!.cursor, receipt: 'hermes-wake-1' });
    expect(ack1.delivered).toBe(1);
    expect(store.outboxPoll(worker, { audience: 'worker' })).toEqual([]);
    const ack2 = store.outboxAck(worker, { audience: 'worker', throughCursor: wake[0]!.cursor, receipt: 'hermes-wake-1' });
    expect(ack2.delivered).toBe(0);
  } finally { store.close(); }
  // Crash/restart: undelivered operator rows persist across reopen.
  const reopened = new ResearchTaskStore(dbPath, artRoot);
  try {
    const feed = reopened.outboxPoll(owner, { audience: 'operator' });
    expect(feed.length).toBeGreaterThan(0);
    expect(feed[0]!.cursor).toBeGreaterThan(0);
  } finally { reopened.close(); }
});

test('outbox: instruct/resume enqueue worker wake rows', () => {
  const { store, owner, worker, future, task } = setup();
  try {
    store.bind(owner, 't1', { commandId: 'bind', expectedVersion: task.version, workerSubject: 'w-1', profile: 'research' });
    const claimed = store.claim(worker, { commandId: 'c', profile: 'research', sessionRef: 's', leaseUntil: future() })!;
    store.outboxAck(worker, { audience: 'worker', throughCursor: 999_999 }); // drain
    store.instruct(owner, 't1', { commandId: 'i1', expectedVersion: claimed.version, instruction: 'focus keyword A' });
    const wake = store.outboxPoll(worker, { audience: 'worker' });
    expect(wake.map((r) => r.kind)).toEqual(['instruction_queued']);
  } finally { store.close(); }
});

// ── P2: real Spy quota binding (fail closed / partial-report path) ───────────

const setupQuota = (quota: { searchRemaining: number } | null) => {
  const root = mkdtempSync(join(tmpdir(), 'research-quota-'));
  const store = new ResearchTaskStore(join(root, 'task.sqlite'), join(root, 'artifacts'), { spyQuota: () => quota });
  const owner = { role: 'operator' as const, subject: 'owner-1' };
  const worker = { role: 'worker' as const, subject: 'w-1', profile: 'research' };
  const task = store.create(owner, { commandId: 'create', taskId: 't1', mode: 'keyword', input: {} });
  store.bind(owner, 't1', { commandId: 'bind', expectedVersion: task.version, profile: 'research' });
  const claimed = store.claim(worker, { commandId: 'c', profile: 'research', sessionRef: 's', leaseUntil: new Date(Date.now() + 3_600_000).toISOString() })!;
  return { store, owner, worker, claimed };
};

test('quota: reserve fails closed when Spy quota probe unavailable', () => {
  const { store, worker, claimed } = setupQuota(null);
  try {
    expect(() => store.reserve(worker, 't1', { commandId: 'r', expectedVersion: claimed.version, roundIndex: 1, planHash: 'h', searchCost: 1 }))
      .toThrow(/fail closed/i);
  } finally { store.close(); }
});

test('quota: reserve rejects a round exceeding real Spy quota; smaller round still fits', () => {
  const { store, worker, claimed } = setupQuota({ searchRemaining: 3 });
  try {
    expect(() => store.reserve(worker, 't1', { commandId: 'r-big', expectedVersion: claimed.version, roundIndex: 1, planHash: 'h', searchCost: 4 }))
      .toThrow(/quota depleted/i);
    const ok = store.reserve(worker, 't1', { commandId: 'r-ok', expectedVersion: claimed.version, roundIndex: 1, planHash: 'h', searchCost: 3 });
    expect(ok.budget.reservedSearch).toBe(3);
  } finally { store.close(); }
});

test('quota: outstanding reservations across OTHER tasks count against real Spy remaining', () => {
  const root = mkdtempSync(join(tmpdir(), 'research-quota-agg-'));
  const store = new ResearchTaskStore(join(root, 'task.sqlite'), join(root, 'artifacts'), { spyQuota: () => ({ searchRemaining: 5 }) });
  const owner = { role: 'operator' as const, subject: 'owner-1' };
  const worker = { role: 'worker' as const, subject: 'w-1', profile: 'research' };
  const future = () => new Date(Date.now() + 3_600_000).toISOString();
  try {
    // Task A reserves 3 of the 5 real units.
    const a = store.create(owner, { commandId: 'ca', taskId: 'ta', mode: 'keyword', input: {} });
    store.bind(owner, 'ta', { commandId: 'ba', expectedVersion: a.version, profile: 'research' });
    const claimA = store.claim(worker, { commandId: 'cla', profile: 'research', sessionRef: 's', leaseUntil: future() })!;
    store.reserve(worker, 'ta', { commandId: 'ra', expectedVersion: claimA.version, roundIndex: 1, planHash: 'h', searchCost: 3 });
    // Task B: 2 free units remain — a 3-call round must be rejected even though
    // the raw ledger still shows 5.
    const b = store.create(owner, { commandId: 'cb', taskId: 'tb', mode: 'keyword', input: {} });
    store.bind(owner, 'tb', { commandId: 'bb', expectedVersion: b.version, profile: 'research' });
    const claimB = store.claim(worker, { commandId: 'clb', profile: 'research', sessionRef: 's2', leaseUntil: future() })!;
    expect(claimB.id).toBe('tb');
    expect(() => store.reserve(worker, 'tb', { commandId: 'rb', expectedVersion: claimB.version, roundIndex: 1, planHash: 'h', searchCost: 3 }))
      .toThrow(/quota depleted/i);
    const ok = store.reserve(worker, 'tb', { commandId: 'rb2', expectedVersion: claimB.version, roundIndex: 1, planHash: 'h', searchCost: 2 });
    expect(ok.budget.reservedSearch).toBe(2);
  } finally { store.close(); }
});

test('daemon projects artifactDir on get/claim; registerArtifact enforces the per-task dir', () => {
  const { root, store, owner, worker, future, task } = setup();
  try {
    // The projection is the daemon-issued canonical path — a worker never
    // guesses WRITER_ROOM_DATA_DIR or its own cwd.
    expect(task.artifactDir).toBe(realpathSync(join(root, 'artifacts', 't1')));
    store.bind(owner, 't1', { commandId: 'bind', expectedVersion: task.version, profile: 'research' });
    const claimed = store.claim(worker, { commandId: 'c', profile: 'research', sessionRef: 's', leaseUntil: future() })!;
    expect(claimed.artifactDir).toBe(task.artifactDir);
    const reserved = store.reserve(worker, 't1', { commandId: 'r', expectedVersion: claimed.version, roundIndex: 1, planHash: 'h', searchCost: 1 });
    // A file inside the projected dir registers fine.
    writeFileSync(join(task.artifactDir, 'note.md'), 'ok');
    const reg = store.registerArtifact(worker, 't1', { commandId: 'a', expectedVersion: reserved.version, roundIndex: 1, type: 'other', path: join(task.artifactDir, 'note.md') });
    expect(reg.sha256).toHaveLength(64);
    // Root-level artifact dir (sibling of the task dir) is now out of scope.
    writeFileSync(join(root, 'artifacts', 'loose.md'), 'x');
    expect(() => store.registerArtifact(worker, 't1', { commandId: 'a2', expectedVersion: reg.version, roundIndex: 1, type: 'other', path: join(root, 'artifacts', 'loose.md') })).toThrow(/outside task dir/);
    // Another task's dir is out of scope too.
    const other = store.create(owner, { commandId: 'c2', taskId: 't2', mode: 'k', input: {} });
    writeFileSync(join(other.artifactDir, 'their.md'), 'x');
    expect(() => store.registerArtifact(worker, 't1', { commandId: 'a3', expectedVersion: reg.version, roundIndex: 1, type: 'other', path: join(other.artifactDir, 'their.md') })).toThrow(/outside task dir/);
  } finally { store.close(); }
});

test('artifact supersede: re-register same path heals a drifted/stale row with audit', () => {
  const root = mkdtempSync(join(tmpdir(), 'research-supersede-'));
  const store = new ResearchTaskStore(join(root, 'task.sqlite'), join(root, 'artifacts'), { spyRunInfo: () => ({ status: 'completed', videoIds: [] }) });
  const owner = { role: 'operator' as const, subject: 'o' };
  const worker = { role: 'worker' as const, subject: 'w', profile: 'research' };
  const future = () => new Date(Date.now() + 60_000).toISOString();
  try {
    const t = store.create(owner, { commandId: 'c', taskId: 't1', mode: 'k', input: {}, budget: { maxRounds: 1, maxUniqueVideos: 5, maxSearchCost: 5 } });
    store.bind(owner, 't1', { commandId: 'b', expectedVersion: t.version, profile: 'research' });
    const claimed = store.claim(worker, { commandId: 'cl', profile: 'research', sessionRef: 's', leaseUntil: future() })!;
    const r = store.reserve(worker, 't1', { commandId: 'r', expectedVersion: claimed.version, roundIndex: 1, planHash: 'h', searchCost: 1 });
    const done = store.completeRound(worker, 't1', { commandId: 'rc', expectedVersion: r.version, roundIndex: 1, actualSearch: 1, spyRunIds: ['spy-1'], videos: [] });
    const dir = t.artifactDir;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ spyRunIds: ['spy-1'] }));
    writeFileSync(join(dir, 'report.md'), 'report v1');
    const a1 = store.registerArtifact(worker, 't1', { commandId: 'a1', expectedVersion: done.version, roundIndex: 1, type: 'manifest', path: join(dir, 'manifest.json') });
    const a2 = store.registerArtifact(worker, 't1', { commandId: 'a2', expectedVersion: a1.version, roundIndex: 1, type: 'report', path: join(dir, 'report.md') });
    // Agent rewrites the report → drift → completion blocked.
    writeFileSync(join(dir, 'report.md'), 'report v2 (regenerated)');
    expect(() => store.completeTask(worker, 't1', { commandId: 'f', expectedVersion: a2.version })).toThrow(/drifted/);
    // Supersede: same path re-registers, heals the stale row, audited.
    const a3 = store.registerArtifact(worker, 't1', { commandId: 'a3', expectedVersion: a2.version, roundIndex: 1, type: 'report', path: join(dir, 'report.md') });
    expect(a3.artifactId).toBe(a2.artifactId); // same row, new hash
    const ev = store.events(owner, 't1').map((e: any) => e.type);
    expect(ev).toContain('artifact_superseded');
    expect(store.completeTask(worker, 't1', { commandId: 'f2', expectedVersion: a3.version }).phase).toBe('completed');
  } finally { store.close(); }
});

test('rebind of a cancel_requested orphan preserves the cancel intent', () => {
  const { store, owner, worker, worker2, task } = setup();
  try {
    store.bind(owner, 't1', { commandId: 'bind', expectedVersion: task.version, workerSubject: 'w-1', profile: 'research' });
    store.claim(worker, { commandId: 'c', profile: 'research', sessionRef: 's1', leaseUntil: new Date(Date.now() + 60_000).toISOString() });
    const running = store.get(owner, 't1');
    const cancelReq = store.transition(owner, 't1', { commandId: 'cx', expectedVersion: running.version, action: 'cancel' });
    expect(cancelReq.phase).toBe('cancel_requested');
    // Worker dies; lease expires; operator rebinds the orphan.
    store.db.query("UPDATE research_tasks SET lease_until=? WHERE id='t1'").run(new Date(Date.now() - 1000).toISOString());
    const rebound = store.bind(owner, 't1', { commandId: 'rebind', expectedVersion: cancelReq.version, profile: 'research' });
    expect(rebound.phase).toBe('cancel_requested'); // NOT reset to ready
    // The next worker claims it — phase stays cancel_requested until ack.
    const reclaimed = store.claim(worker2, { commandId: 'c2', profile: 'research', sessionRef: 's2', leaseUntil: new Date(Date.now() + 60_000).toISOString() })!;
    expect(reclaimed.phase).toBe('cancel_requested');
    expect(reclaimed.worker_subject).toBe('w-2');
    const cancelled = store.transition(worker2, 't1', { commandId: 'ack', expectedVersion: reclaimed.version, action: 'cancel_ack' });
    expect(cancelled.phase).toBe('cancelled');
  } finally { store.close(); }
});
