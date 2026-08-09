import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentManager } from '../../src/agents/index.ts';
import { StageLedger, type PipelineLedgerRow } from '../../src/pipeline/ledger.ts';
import { LaneScheduler } from '../../src/pipeline/lane-scheduler.ts';
import type { TeamWorkflow } from '../../src/team/workflow.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-pipeline-ledger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('StageLedger', () => {
  test('append + findByTurnKey round-trip, last row per turnKey wins after reload', () => {
    const path = join(dir, 'ledger.jsonl');
    const ledger = new StageLedger(path);
    const row: PipelineLedgerRow = {
      turnKey: 'tk-1', itemId: 'item-1', stage: 'analyze', attempt: 1,
      status: 'non-terminal', turnId: '10', recordedAt: new Date().toISOString(),
      batchId: 'batch-1', outcome: 'RUNNING',
    };
    ledger.append(row);
    expect(ledger.findByTurnKey('tk-1')?.status).toBe('non-terminal');

    ledger.updateStatus('tk-1', { status: 'terminal', outcome: 'COMMITTED', artifactHash: 'abc123' });
    expect(ledger.findByTurnKey('tk-1')?.status).toBe('terminal');
    expect(ledger.findByTurnKey('tk-1')?.outcome).toBe('COMMITTED');

    // Reload from disk — the JSONL file is append-only, so both lines are on disk,
    // but the in-memory index (and a fresh instance's) must resolve to the latest.
    const reloaded = new StageLedger(path);
    expect(reloaded.findByTurnKey('tk-1')?.outcome).toBe('COMMITTED');
    expect(reloaded.all()).toHaveLength(1);
  });

  test('updateStatus throws for an unknown turnKey', () => {
    const ledger = new StageLedger(join(dir, 'ledger.jsonl'));
    expect(() => ledger.updateStatus('missing', { status: 'terminal' })).toThrow();
  });
});

describe('LaneScheduler.reconcileOnBoot', () => {
  test('a non-terminal row left by a prior process is marked INTERRUPTED', () => {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const staleRow: PipelineLedgerRow = {
      turnKey: 'tk-crash-1', itemId: 'item-x', stage: 'analyze', attempt: 1,
      status: 'non-terminal', turnId: '42', recordedAt: new Date(Date.now() - 60_000).toISOString(),
      batchId: 'batch-x', outcome: 'RUNNING',
    };
    // Simulate a prior-process crash: write the ledger file directly, bypassing the class.
    writeFileSync(ledgerPath, `${JSON.stringify(staleRow)}\n`);

    const ledger = new StageLedger(ledgerPath);
    // reconcileOnBoot only touches the ledger — fake the harness deps it never uses.
    const fakeWorkflow = { onTurnSettled: () => () => {} } as unknown as TeamWorkflow;
    const fakeAgents = {} as unknown as AgentManager;
    const scheduler = new LaneScheduler({ agents: fakeAgents, workflow: fakeWorkflow, ledger, dataDir: dir });

    expect(ledger.findByTurnKey('tk-crash-1')?.status).toBe('non-terminal');
    scheduler.reconcileOnBoot();

    const row = ledger.findByTurnKey('tk-crash-1');
    expect(row?.status).toBe('terminal');
    expect(row?.outcome).toBe('INTERRUPTED');

    // Idempotent: calling it again does nothing further (row is already terminal).
    scheduler.reconcileOnBoot();
    expect(ledger.all()).toHaveLength(1);
    scheduler.dispose();
  });

  test('a terminal row is left untouched', () => {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const committedRow: PipelineLedgerRow = {
      turnKey: 'tk-done-1', itemId: 'item-y', stage: 'analyze', attempt: 1,
      status: 'terminal', turnId: '43', recordedAt: new Date().toISOString(),
      batchId: 'batch-y', outcome: 'COMMITTED', artifactHash: 'deadbeef',
    };
    writeFileSync(ledgerPath, `${JSON.stringify(committedRow)}\n`);
    const ledger = new StageLedger(ledgerPath);
    const fakeWorkflow = { onTurnSettled: () => () => {} } as unknown as TeamWorkflow;
    const fakeAgents = {} as unknown as AgentManager;
    const scheduler = new LaneScheduler({ agents: fakeAgents, workflow: fakeWorkflow, ledger, dataDir: dir });

    scheduler.reconcileOnBoot();
    expect(ledger.findByTurnKey('tk-done-1')?.outcome).toBe('COMMITTED');
    scheduler.dispose();
  });
});
