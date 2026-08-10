/**
 * Formula Studio backend (SDD §12b, ADR-13/14) — session state, rule pool, and the
 * human-gated merge. Everything here is deterministic app code: no agent, no model
 * call, no token spent, which is exactly the point of the P2 slice.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FormulaArtifact } from '@writer-room/training-core';
import { getFormula, listFormulas, saveFormula } from '../../src/training/storage.ts';
import {
  createStudioSession,
  getStudioSession,
  listRulePool,
  listStudioSessions,
  promoteCompound,
  rebuildCompound,
  recomputeClusters,
  saveStudioSession,
} from '../../src/training/studio.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-studio-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function formula(
  overrides: Partial<FormulaArtifact> & { id: string; videoSnapshotId: string },
): FormulaArtifact {
  return {
    status: 'TRIAL',
    origin: 'ANALYZED',
    version: 1,
    channelTitle: 'Sói Tài Chính',
    rules: [
      {
        id: 'rule-1',
        statement: 'Mở bài bằng một câu chuyện cá nhân có số liệu cụ thể',
        evidence: [{ segmentIds: ['seg-1'], quote: 'hồi đó tôi kiếm được 3 triệu' }],
      },
    ],
    includedArtifacts: [],
    lineage: {},
    warnings: [],
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('listRulePool', () => {
  test('flattens rules across Formulas, newest first', async () => {
    await saveFormula(formula({ id: 'f1', videoSnapshotId: 'v1' }), dir);
    await saveFormula(
      formula({ id: 'f2', videoSnapshotId: 'v2', channelTitle: 'Kênh Khác', createdAt: '2026-08-10T01:00:00.000Z' }),
      dir,
    );

    const pool = await listRulePool(dir);
    expect(pool).toHaveLength(2);
    expect(pool[0]!.videoSnapshotId).toBe('v2');
    expect(pool[0]!.channelTitle).toBe('Kênh Khác');
    expect(pool[0]!.evidenceCount).toBe(1);
  });

  test('shows only the latest version per video by default', async () => {
    await saveFormula(formula({ id: 'f1', videoSnapshotId: 'v1', version: 1 }), dir);
    await saveFormula(
      formula({
        id: 'f2',
        videoSnapshotId: 'v1',
        version: 2,
        origin: 'REFINED',
        lineage: { parentFormulaId: 'f1' },
        rules: [
          {
            id: 'rule-1',
            statement: 'Mở bài bằng câu chuyện cá nhân, số liệu để tròn',
            evidence: [{ segmentIds: ['seg-1'], quote: 'hồi đó tôi kiếm được 3 triệu' }],
          },
        ],
      }),
      dir,
    );

    const pool = await listRulePool(dir);
    expect(pool).toHaveLength(1);
    expect(pool[0]!.formulaVersion).toBe(2);
    expect(pool[0]!.formulaOrigin).toBe('REFINED');
  });

  test('includeOlderVersions surfaces every version for before/after comparison', async () => {
    await saveFormula(formula({ id: 'f1', videoSnapshotId: 'v1', version: 1 }), dir);
    await saveFormula(formula({ id: 'f2', videoSnapshotId: 'v1', version: 2, origin: 'REFINED' }), dir);

    const pool = await listRulePool(dir, { includeOlderVersions: true });
    expect(pool).toHaveLength(2);
    expect(pool.map((r) => r.formulaVersion).sort()).toEqual([1, 2]);
  });

  test('never offers a COMPOUND Formula back as pickable input', async () => {
    await saveFormula(formula({ id: 'f1', videoSnapshotId: 'v1' }), dir);
    await saveFormula(
      formula({
        id: 'compound-1',
        videoSnapshotId: 'v1',
        origin: 'COMPOUND',
        genre: 'kể chuyện tài chính',
        version: 9,
      }),
      dir,
    );

    const pool = await listRulePool(dir);
    expect(pool.every((r) => r.formulaOrigin !== 'COMPOUND')).toBe(true);
    expect(pool).toHaveLength(1);
  });

  test('reads a legacy pre-ADR-14 Formula via normalizeFormula', async () => {
    const legacy = {
      id: 'old-1',
      status: 'TRIAL',
      scope: 'SINGLE_CHANNEL',
      channelGroups: [{ channelTitle: 'Kênh Cũ', videoSnapshotIds: ['v-old'] }],
      rules: [{ id: 'rule-1', statement: 'Rule cũ', evidence: [{ segmentIds: ['s1'], quote: 'q' }] }],
      includedArtifacts: [],
      warnings: [],
      createdAt: '2026-08-09T00:00:00.000Z',
    };
    await saveFormula(legacy as unknown as FormulaArtifact, dir);

    const pool = await listRulePool(dir);
    expect(pool).toHaveLength(1);
    expect(pool[0]!.videoSnapshotId).toBe('v-old');
    expect(pool[0]!.channelTitle).toBe('Kênh Cũ');
    expect(pool[0]!.formulaOrigin).toBe('ANALYZED');
  });
});

describe('session + merge', () => {
  async function seedTwoSimilar(): Promise<void> {
    await saveFormula(
      formula({
        id: 'f1',
        videoSnapshotId: 'v1',
        rules: [
          {
            id: 'rule-1',
            statement: 'Mở bài bằng một câu chuyện cá nhân có số liệu cụ thể',
            evidence: [{ segmentIds: ['seg-1'], quote: 'hồi đó tôi kiếm được 3 triệu' }],
          },
          {
            id: 'rule-2',
            statement: 'Chốt bài bằng khung ba khái niệm đã đặt tên',
            evidence: [{ segmentIds: ['seg-2'], quote: 'ba thứ bạn cần nhớ' }],
          },
        ],
      }),
      dir,
    );
    await saveFormula(
      formula({
        id: 'f2',
        videoSnapshotId: 'v2',
        channelTitle: 'Kênh Khác',
        rules: [
          {
            id: 'rule-9',
            statement: 'Mở bài bằng câu chuyện cá nhân kèm số liệu cụ thể',
            evidence: [{ segmentIds: ['seg-7'], quote: 'lương tôi 45 triệu' }],
          },
        ],
      }),
      dir,
    );
  }

  test('picking two similar rules yields one SIMILAR cluster awaiting a proposal', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('kể chuyện tài chính cá nhân', dir);
    session.picks = [
      { formulaId: 'f1', ruleId: 'rule-1' },
      { formulaId: 'f2', ruleId: 'rule-9' },
    ];
    await recomputeClusters(session, dir);

    expect(session.clusters).toHaveLength(1);
    expect(session.clusters[0]!.kind).toBe('SIMILAR');
    expect(session.clusters[0]!.members).toHaveLength(2);

    // No proposal accepted yet, so the merge decision is still outstanding and the
    // compound stays empty — the LLM/human step is NOT skipped.
    await rebuildCompound(session, dir);
    expect(session.compound!.rules).toHaveLength(0);
  });

  test('a SINGLE cluster is carried through with full provenance, no LLM needed', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-2' }];
    await recomputeClusters(session, dir);
    await rebuildCompound(session, dir);

    expect(session.compound!.origin).toBe('COMPOUND');
    expect(session.compound!.status).toBe('DRAFT');
    expect(session.compound!.rules).toHaveLength(1);
    const rule = session.compound!.rules[0]!;
    expect(rule.mergeOrigin).toBe('CARRIED');
    expect(rule.sources).toHaveLength(1);
    expect(rule.sources![0]!.videoSnapshotId).toBe('v1');
    expect(rule.sources![0]!.sourceRuleId).toBe('rule-2');
  });

  test('an accepted proposal becomes a SYNTHESIZED rule inheriting every source evidence', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [
      { formulaId: 'f1', ruleId: 'rule-1' },
      { formulaId: 'f2', ruleId: 'rule-9' },
    ];
    await recomputeClusters(session, dir);

    const cluster = session.clusters[0]!;
    session.proposals = [
      {
        id: 'p-1',
        clusterId: cluster.id,
        statement: 'Mở bài bằng câu chuyện cá nhân có số liệu cụ thể',
        sources: cluster.members.map((m) => ({
          videoSnapshotId: m.videoSnapshotId,
          channelTitle: m.channelTitle,
          sourceFormulaId: m.sourceFormulaId,
          sourceRuleId: m.sourceRuleId,
          evidence: m.evidence,
        })),
        decision: 'ACCEPTED',
      },
    ];
    await rebuildCompound(session, dir);

    expect(session.compound!.rules).toHaveLength(1);
    const rule = session.compound!.rules[0]!;
    expect(rule.mergeOrigin).toBe('SYNTHESIZED');
    expect(rule.sources).toHaveLength(2);
    // Evidence from BOTH source rules — this is what keeps a merged rule grounded.
    expect(rule.evidence).toHaveLength(2);
    expect(session.compound!.warnings).toHaveLength(0); // 2 videos → not single-source
  });

  test('cluster ids survive an unrelated extra pick, so approved proposals do not shift', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [
      { formulaId: 'f1', ruleId: 'rule-1' },
      { formulaId: 'f2', ruleId: 'rule-9' },
    ];
    await recomputeClusters(session, dir);
    const idBefore = session.clusters[0]!.id;

    session.picks.push({ formulaId: 'f1', ruleId: 'rule-2' });
    await recomputeClusters(session, dir);

    const same = session.clusters.find((c) => c.members.length === 2);
    expect(same!.id).toBe(idBefore);
  });

  test('a one-video compound is warned about rather than silently presented as cross-video', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-2' }];
    await recomputeClusters(session, dir);
    await rebuildCompound(session, dir);

    expect(session.compound!.warnings.some((w) => w.includes('SINGLE_SOURCE'))).toBe(true);
  });

  test('promote writes the compound into the shared store as TRIAL; a DRAFT never appears there', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('kể chuyện tài chính cá nhân', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-2' }];
    await recomputeClusters(session, dir);
    await rebuildCompound(session, dir);
    await saveStudioSession(session, dir);

    // Before promotion the in-progress merge is invisible to the Formula store.
    expect((await listFormulas(dir)).some((f) => f.origin === 'COMPOUND')).toBe(false);

    await promoteCompound(session, dir);
    await saveStudioSession(session, dir);

    const stored = await getFormula(session.compound!.id, dir);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('TRIAL');
    expect(stored!.origin).toBe('COMPOUND');
    expect(stored!.genre).toBe('kể chuyện tài chính cá nhân');
    expect(stored!.lineage.studioSessionId).toBe(session.id);
  });

  test('rebuilding after an edit drops a promoted compound back to DRAFT', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-2' }];
    await recomputeClusters(session, dir);
    await rebuildCompound(session, dir);
    await promoteCompound(session, dir);
    expect(session.compound!.status).toBe('TRIAL');

    session.picks.push({ formulaId: 'f2', ruleId: 'rule-9' });
    await recomputeClusters(session, dir);
    await rebuildCompound(session, dir);

    expect(session.compound!.status).toBe('DRAFT');
    expect(session.compound!.version).toBe(2);
  });

  test('promoting an empty compound is refused', async () => {
    const session = await createStudioSession('thể loại rỗng', dir);
    await recomputeClusters(session, dir);
    await rebuildCompound(session, dir);
    await expect(promoteCompound(session, dir)).rejects.toThrow();
  });

  test('a pick whose Formula no longer resolves is dropped, never faked', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [
      { formulaId: 'f1', ruleId: 'rule-2' },
      { formulaId: 'khong-ton-tai', ruleId: 'rule-1' },
    ];
    await recomputeClusters(session, dir);

    expect(session.clusters).toHaveLength(1);
    expect(session.clusters[0]!.members[0]!.sourceFormulaId).toBe('f1');
  });

  test('sessions round-trip to disk and list newest first', async () => {
    const a = await createStudioSession('thể loại A', dir);
    const b = await createStudioSession('thể loại B', dir);
    b.picks = [{ formulaId: 'f1', ruleId: 'rule-1' }];
    await saveStudioSession(b, dir);

    const reloaded = await getStudioSession(a.id, dir);
    expect(reloaded!.genre).toBe('thể loại A');

    const sessions = await listStudioSessions(dir);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.id).toBe(b.id);
    expect(sessions[0]!.pickCount).toBe(1);
    expect(sessions[0]!.status).toBe('EMPTY');
  });
});
