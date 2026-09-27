import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
    writeFileSync(join(root, 'artifacts', 'late.txt'), 'x');
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
    writeFileSync(join(root, 'artifacts', 'manifest.json'), JSON.stringify({ spyRunIds: ['spy-real'] }));
    writeFileSync(join(root, 'artifacts', 'report.md'), 'report');
    const a1 = store.registerArtifact(worker, 't1', { commandId: 'a1', expectedVersion: done.version, roundIndex: 1, type: 'manifest', path: join(root, 'artifacts', 'manifest.json') });
    const a2 = store.registerArtifact(worker, 't1', { commandId: 'a2', expectedVersion: a1.version, roundIndex: 1, type: 'report', path: join(root, 'artifacts', 'report.md') });
    // Tamper the report after registration → completion must fail.
    writeFileSync(join(root, 'artifacts', 'report.md'), 'tampered');
    expect(() => store.completeTask(worker, 't1', { commandId: 'f', expectedVersion: a2.version })).toThrow(/drifted/);
    writeFileSync(join(root, 'artifacts', 'report.md'), 'report');
    expect(store.completeTask(worker, 't1', { commandId: 'f', expectedVersion: a2.version }).phase).toBe('completed');
  } finally { store.close(); }
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
    writeFileSync(join(root, 'artifacts', 'manifest.json'), JSON.stringify({ spyRunIds: ['spy-1'] }));
    writeFileSync(join(root, 'artifacts', 'report.md'), 'report');
    const a1 = JSON.parse((await rpc(server, wk.token, 'tools/call', { name: 'research_artifact_register', arguments: { commandId: 'a1', taskId: 't1', expectedVersion: roundDone.task.version, roundIndex: 1, type: 'manifest', path: join(root, 'artifacts', 'manifest.json') } })).result.content[0].text);
    const a2 = JSON.parse((await rpc(server, wk.token, 'tools/call', { name: 'research_artifact_register', arguments: { commandId: 'a2', taskId: 't1', expectedVersion: a1.artifact.version, roundIndex: 1, type: 'report', path: join(root, 'artifacts', 'report.md') } })).result.content[0].text);
    const done = JSON.parse((await rpc(server, wk.token, 'tools/call', { name: 'research_task_complete', arguments: { commandId: 'done', taskId: 't1', expectedVersion: a2.artifact.version } })).result.content[0].text);
    expect(done.task.phase).toBe('completed');
  } finally { store.close(); }
});
