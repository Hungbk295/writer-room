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
import { getProfile } from '../../src/training/profile-store.ts';
import { getFormula, listFormulas, saveFormula } from '../../src/training/storage.ts';
import {
  applyProposalDecision,
  classifyPick,
  createStudioSession,
  getStudioSession,
  listRulePool,
  listStudioSessions,
  promoteCompound,
  publishProfile,
  rebuildCompound,
  recomputeClusters,
  saveStudioSession,
  setSourceFormulas,
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
      formula({
        id: 'f2',
        videoSnapshotId: 'v2',
        channelTitle: 'Kênh Khác',
        videoTitle: 'Video Khác',
        title: 'Video Khác',
        createdAt: '2026-08-10T01:00:00.000Z',
      }),
      dir,
    );

    const pool = await listRulePool(dir);
    expect(pool).toHaveLength(2);
    expect(pool[0]!.videoSnapshotId).toBe('v2');
    expect(pool[0]!.channelTitle).toBe('Kênh Khác');
    expect(pool[0]!.formulaTitle).toBe('Video Khác');
    expect(pool[0]!.evidenceCount).toBe(1);
  });

  test('formulaIds scopes the pool to selected sources only', async () => {
    await saveFormula(formula({ id: 'f1', videoSnapshotId: 'v1' }), dir);
    await saveFormula(
      formula({ id: 'f2', videoSnapshotId: 'v2', channelTitle: 'Kênh Khác', createdAt: '2026-08-10T01:00:00.000Z' }),
      dir,
    );

    const pool = await listRulePool(dir, { formulaIds: ['f1'] });
    expect(pool).toHaveLength(1);
    expect(pool[0]!.formulaId).toBe('f1');
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

describe('setSourceFormulas', () => {
  test('scopes session and drops picks outside the new source set', async () => {
    await saveFormula(formula({ id: 'f1', videoSnapshotId: 'v1' }), dir);
    await saveFormula(
      formula({
        id: 'f2',
        videoSnapshotId: 'v2',
        channelTitle: 'Kênh Khác',
        rules: [
          {
            id: 'rule-9',
            statement: 'Khác hẳn',
            evidence: [{ segmentIds: ['seg-9'], quote: 'quote khác' }],
          },
        ],
      }),
      dir,
    );

    const session = await createStudioSession('soi-tc', dir);
    expect(session.sourceFormulaIds).toEqual([]);

    await setSourceFormulas(session, ['f1', 'f2'], dir);
    session.picks = [
      { formulaId: 'f1', ruleId: 'rule-1' },
      { formulaId: 'f2', ruleId: 'rule-9' },
    ];
    await recomputeClusters(session, dir);
    expect(session.picks).toHaveLength(2);

    await setSourceFormulas(session, ['f1'], dir);
    expect(session.sourceFormulaIds).toEqual(['f1']);
    expect(session.picks).toEqual([{ formulaId: 'f1', ruleId: 'rule-1' }]);
  });

  test('rejects COMPOUND as a source', async () => {
    await saveFormula(
      formula({
        id: 'compound-1',
        videoSnapshotId: 'v1',
        origin: 'COMPOUND',
        genre: 'x',
      }),
      dir,
    );
    const session = await createStudioSession('g', dir);
    await expect(setSourceFormulas(session, ['compound-1'], dir)).rejects.toThrow(/COMPOUND/);
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

  test('a SINGLE cluster does NOT auto-enter the compound (2026-08-10 design change) — it needs a proposal too, same as SIMILAR', async () => {
    // Old P2 behavior auto-carried a SINGLE cluster verbatim (no LLM, no human
    // decision) — but "nothing else resembled it" said nothing about whether its
    // wording was already generic, and real data showed video-specific nouns/quotes
    // baked into exactly these statements. So SINGLE now needs a SYNTHESIZE proposal
    // (`studio-synthesize.ts`) and a human decision, exactly like SIMILAR — see
    // `rebuildCompound`'s doc comment in `studio.ts`.
    await seedTwoSimilar();
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-2' }];
    await recomputeClusters(session, dir);
    expect(session.clusters).toHaveLength(1);
    expect(session.clusters[0]!.kind).toBe('SINGLE');

    await rebuildCompound(session, dir);
    expect(session.compound!.rules).toHaveLength(0);
  });

  test('accepting a proposal for a SINGLE cluster produces a SYNTHESIZED compound rule with full provenance', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-2' }];
    await recomputeClusters(session, dir);

    const cluster = session.clusters[0]!;
    session.proposals = [
      {
        id: 'p-single',
        clusterId: cluster.id,
        instruction: 'Chốt bài bằng một khung khái niệm đã đặt tên',
        priority: 'OPTIONAL',
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
        instruction: 'Mở bài bằng câu chuyện cá nhân có số liệu cụ thể',
        priority: 'OPTIONAL',
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

  test('an empty in-progress compound (nothing accepted yet) is NOT warned SINGLE_SOURCE — there is nothing to warn about yet', async () => {
    // Regression guard for a bug this change would otherwise introduce: with SINGLE
    // no longer auto-carried, an all-pending session now legitimately has ZERO
    // compound rules, and `sourceVideoCount([]) === 0 < 2` must not be read as "every
    // rule came from one video" about a compound that has no rules at all.
    await seedTwoSimilar();
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-2' }];
    await recomputeClusters(session, dir);
    await rebuildCompound(session, dir);

    expect(session.compound!.rules).toHaveLength(0);
    expect(session.compound!.warnings).toHaveLength(0);
  });

  test('a one-video compound IS warned once a rule actually enters it', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-2' }];
    await recomputeClusters(session, dir);

    const cluster = session.clusters[0]!;
    session.proposals = [
      {
        id: 'p-single',
        clusterId: cluster.id,
        instruction: 'Chốt bài bằng một khung khái niệm đã đặt tên',
        priority: 'OPTIONAL',
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
    expect(session.compound!.warnings.some((w) => w.includes('SINGLE_SOURCE'))).toBe(true);
  });

  test('promote writes the compound into the shared store as TRIAL; a DRAFT never appears there', async () => {
    await seedTwoSimilar();
    const session = await createStudioSession('kể chuyện tài chính cá nhân', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-2' }];
    await recomputeClusters(session, dir);
    // The SINGLE cluster needs an accepted proposal now (2026-08-10) — no more
    // automatic carry-through, see the `rebuildCompound` tests above.
    const cluster = session.clusters[0]!;
    session.proposals = [{
      id: 'p-single',
      clusterId: cluster.id,
      instruction: 'Chốt bài bằng một khung khái niệm đã đặt tên',
      priority: 'OPTIONAL',
      sources: cluster.members.map((m) => ({
        videoSnapshotId: m.videoSnapshotId,
        channelTitle: m.channelTitle,
        sourceFormulaId: m.sourceFormulaId,
        sourceRuleId: m.sourceRuleId,
        evidence: m.evidence,
      })),
      decision: 'ACCEPTED',
    }];
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
    const cluster = session.clusters[0]!;
    session.proposals = [{
      id: 'p-single',
      clusterId: cluster.id,
      instruction: 'Chốt bài bằng một khung khái niệm đã đặt tên',
      priority: 'OPTIONAL',
      sources: cluster.members.map((m) => ({
        videoSnapshotId: m.videoSnapshotId,
        channelTitle: m.channelTitle,
        sourceFormulaId: m.sourceFormulaId,
        sourceRuleId: m.sourceRuleId,
        evidence: m.evidence,
      })),
      decision: 'ACCEPTED',
    }];
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

  test('sessions round-trip to disk', async () => {
    const a = await createStudioSession('thể loại A', dir);
    const b = await createStudioSession('thể loại B', dir);
    b.picks = [{ formulaId: 'f1', ruleId: 'rule-1' }];
    await saveStudioSession(b, dir);

    const reloaded = await getStudioSession(a.id, dir);
    expect(reloaded!.genre).toBe('thể loại A');

    const sessions = await listStudioSessions(dir);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === b.id)!.pickCount).toBe(1);
    expect(sessions.find((s) => s.id === a.id)!.pickCount).toBe(0);
    expect(sessions.every((s) => s.status === 'EMPTY')).toBe(true);
  });

  /**
   * Regression guard for a genuinely flaky failure (~1 run in 4): two sessions
   * created back-to-back land in the SAME millisecond, so their `updatedAt` compare
   * equal and a stable sort falls back to `readdir` order — i.e. filesystem order,
   * which is not deterministic. The previous version of the test above asserted "b is
   * first", which the data simply cannot guarantee; the real invariant worth holding
   * is that the order never changes between reads. `listStudioSessions` now breaks
   * timestamp ties on `id`.
   */
  test('listing order is deterministic even when timestamps tie', async () => {
    const created = await Promise.all([
      createStudioSession('thể loại A', dir),
      createStudioSession('thể loại B', dir),
      createStudioSession('thể loại C', dir),
    ]);
    const timestamps = new Set(created.map((s) => s.updatedAt));
    // Not asserted as a precondition — if the machine is slow enough to tick between
    // creations the tie never happens and the test still passes, just proving less.
    void timestamps;

    const first = (await listStudioSessions(dir)).map((s) => s.id);
    const second = (await listStudioSessions(dir)).map((s) => s.id);
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
  });

  test('getStudioSession fills in synthesizeStatus/synthesizeAttempt defaults for a session written before P3', async () => {
    // Simulates a real P2-era session file on disk — no `synthesize*` fields at all —
    // the exact case `getStudioSession`'s read-time default-fill exists for. Creates
    // a real session first (so it lands at the real on-disk path via `trainingRoot`,
    // not a guessed one) then overwrites it with the pre-P3 shape.
    const created = await createStudioSession('thể loại cũ', dir);
    const legacy = {
      id: created.id,
      genre: 'thể loại cũ',
      picks: [],
      clusters: [],
      proposals: [],
      compound: null,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    };
    const { writeFile: write } = await import('node:fs/promises');
    await write(join(dir, 'training', 'studio-sessions', `${created.id}.json`), JSON.stringify(legacy), 'utf8');

    const reloaded = await getStudioSession(created.id, dir);
    expect(reloaded!.synthesizeStatus).toBe('IDLE');
    expect(reloaded!.synthesizeAttempt).toBe(0);
  });
});

describe('applyProposalDecision', () => {
  async function seedPendingProposal(): Promise<{ session: Awaited<ReturnType<typeof createStudioSession>>; proposalId: string }> {
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
        ],
      }),
      dir,
    );
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-1' }];
    await recomputeClusters(session, dir);
    const cluster = session.clusters[0]!;
    session.proposals = [{
      id: 'p-1',
      clusterId: cluster.id,
      instruction: 'Mở bài bằng một câu chuyện cá nhân, kèm số liệu',
      priority: 'OPTIONAL',
      sources: cluster.members.map((m) => ({
        videoSnapshotId: m.videoSnapshotId,
        channelTitle: m.channelTitle,
        sourceFormulaId: m.sourceFormulaId,
        sourceRuleId: m.sourceRuleId,
        evidence: m.evidence,
      })),
      decision: 'PENDING',
    }];
    return { session, proposalId: 'p-1' };
  }

  test('ACCEPTED with no edit keeps the LLM wording — rebuild yields a SYNTHESIZED rule', async () => {
    const { session, proposalId } = await seedPendingProposal();
    applyProposalDecision(session, proposalId, 'ACCEPTED');
    await rebuildCompound(session, dir);

    expect(session.proposals[0]!.decision).toBe('ACCEPTED');
    expect(session.proposals[0]!.edited).toBeUndefined();
    expect(session.compound!.rules).toHaveLength(1);
    expect(session.compound!.rules[0]!.mergeOrigin).toBe('SYNTHESIZED');
  });

  /**
   * The human's escape hatch when SYNTHESIZE genericizes a rule into something worse:
   * put the original wording back. That is "keep the original", not an edit, so it
   * must report `CARRIED` — otherwise `CARRIED` has no code path at all and rots as a
   * dead enum value, and the badge misreports what the human actually decided.
   */
  test('ACCEPTED with an instruction equal to the original source wording yields CARRIED, not HUMAN_EDITED', async () => {
    const { session, proposalId } = await seedPendingProposal();
    const original = session.clusters[0]!.members[0]!.statement;
    applyProposalDecision(session, proposalId, 'ACCEPTED', { instruction: original });
    await rebuildCompound(session, dir);

    expect(session.proposals[0]!.keptOriginal).toBe(true);
    expect(session.proposals[0]!.edited).toBe(false);
    expect(session.compound!.rules[0]!.mergeOrigin).toBe('CARRIED');
    expect(session.compound!.rules[0]!.statement).toBe(original);
  });

  test('ACCEPTED with an instruction marks edited — rebuild yields a HUMAN_EDITED rule with the new wording', async () => {
    const { session, proposalId } = await seedPendingProposal();
    applyProposalDecision(session, proposalId, 'ACCEPTED', {
      instruction: 'Mở bài bằng câu chuyện thật, gắn một con số cụ thể',
    });
    await rebuildCompound(session, dir);

    expect(session.proposals[0]!.edited).toBe(true);
    expect(session.compound!.rules).toHaveLength(1);
    expect(session.compound!.rules[0]!.mergeOrigin).toBe('HUMAN_EDITED');
    expect(session.compound!.rules[0]!.statement).toBe('Mở bài bằng câu chuyện thật, gắn một con số cụ thể');
  });

  test('REJECTED never enters the compound', async () => {
    const { session, proposalId } = await seedPendingProposal();
    applyProposalDecision(session, proposalId, 'REJECTED');
    await rebuildCompound(session, dir);

    expect(session.proposals[0]!.decision).toBe('REJECTED');
    expect(session.compound!.rules).toHaveLength(0);
  });

  test('an unknown proposal id is refused, never silently ignored', async () => {
    const { session } = await seedPendingProposal();
    expect(() => applyProposalDecision(session, 'khong-ton-tai', 'ACCEPTED')).toThrow();
  });
});

describe('promoteCompound — topic-leak warnings (advisory only)', () => {
  test('a rule statement that still quotes a video verbatim is promoted anyway, with a TOPIC_LEAK warning', async () => {
    await saveFormula(
      formula({
        id: 'f1',
        videoSnapshotId: 'v1',
        rules: [
          {
            id: 'rule-1',
            statement: 'Đặt tên ẩn dụ riêng cho một khái niệm tài chính rồi lặp lại',
            evidence: [{ segmentIds: ['seg-1'], quote: 'thuế ở lại thành phố' }],
          },
        ],
      }),
      dir,
    );
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-1' }];
    await recomputeClusters(session, dir);
    const cluster = session.clusters[0]!;
    session.proposals = [{
      id: 'p-1',
      clusterId: cluster.id,
      // Deliberately still leaks a verbatim quote — proves promote does not block on it.
      instruction: 'Đặt tên ẩn dụ riêng cho một khái niệm tài chính ("thuế ở lại thành phố") rồi lặp lại',
      priority: 'OPTIONAL',
      sources: cluster.members.map((m) => ({
        videoSnapshotId: m.videoSnapshotId,
        channelTitle: m.channelTitle,
        sourceFormulaId: m.sourceFormulaId,
        sourceRuleId: m.sourceRuleId,
        evidence: m.evidence,
      })),
      decision: 'ACCEPTED',
    }];
    await rebuildCompound(session, dir);

    const promoted = await promoteCompound(session, dir);
    expect(promoted.compound!.status).toBe('TRIAL'); // not blocked
    expect(promoted.compound!.warnings.some((w) => w.startsWith('TOPIC_LEAK:') && w.includes('thuế ở lại thành phố'))).toBe(true);
  });
});

describe('classifyPick', () => {
  test('tags an already-picked rule and it round-trips to disk', async () => {
    await saveFormula(formula({ id: 'f1', videoSnapshotId: 'v1' }), dir);
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-1' }];

    classifyPick(session, { formulaId: 'f1', ruleId: 'rule-1' }, 'PROFILE');
    await saveStudioSession(session, dir);

    const reloaded = await getStudioSession(session.id, dir);
    expect(reloaded!.picks[0]!.classification).toBe('PROFILE');
  });

  test('a ref that was never picked into the session is refused, never silently ignored', async () => {
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-1' }];
    expect(() => classifyPick(session, { formulaId: 'f1', ruleId: 'khong-ton-tai' }, 'PROFILE')).toThrow();
  });
});

describe('publishProfile', () => {
  /** Seeds a session with ONE formula's ONE rule, picked + classified PROFILE, and
   * an ACCEPTED proposal — the thin path (§2.5: 1 formula -> 1 profile), cluster
   * size 1 throughout. */
  async function seedPublishableSession(): Promise<{
    session: Awaited<ReturnType<typeof createStudioSession>>;
  }> {
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
        ],
      }),
      dir,
    );
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [{ formulaId: 'f1', ruleId: 'rule-1' }];
    await recomputeClusters(session, dir);
    expect(session.clusters).toHaveLength(1);
    expect(session.clusters[0]!.kind).toBe('SINGLE'); // thin path: cluster size 1

    classifyPick(session, { formulaId: 'f1', ruleId: 'rule-1' }, 'PROFILE');
    const cluster = session.clusters[0]!;
    session.proposals = [
      {
        id: 'p-1',
        clusterId: cluster.id,
        instruction: 'Mở bài bằng một trải nghiệm cá nhân gắn với một con số cụ thể',
        when: 'Chủ đề có sẵn một câu chuyện/case cá nhân đáng kể',
        avoidWhen: 'Chủ đề thuần lý thuyết, không có case cụ thể',
        priority: 'CORE',
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
    return { session };
  }

  test('thin path (1 formula -> 1 profile): publishes an immutable TRIAL profile with full guideline shape + provenance', async () => {
    const { session } = await seedPublishableSession();

    const result = await publishProfile(
      session,
      {
        label: 'Kể chuyện tài chính cá nhân',
        scope: { language: 'vi', genre: 'tài chính cá nhân', contentModes: ['short-form'] },
        editorialPromise: 'Luôn mở bằng một trải nghiệm thật',
        antiPatterns: ['Hài hước ép buộc'],
      },
      dir,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe('WRITER_READY_PROFILE');
    expect(result.profile.readiness).toBe('TRIAL'); // ADR-FM13: always TRIAL, never auto-VALIDATED
    expect(result.profile.version).toBe(1);
    expect(result.profile.label).toBe('Kể chuyện tài chính cá nhân');
    expect(result.profile.guidelines).toHaveLength(1);
    const guideline = result.profile.guidelines[0]!;
    expect(guideline.instruction).toBe('Mở bài bằng một trải nghiệm cá nhân gắn với một con số cụ thể');
    expect(guideline.when).toBe('Chủ đề có sẵn một câu chuyện/case cá nhân đáng kể');
    expect(guideline.avoidWhen).toBe('Chủ đề thuần lý thuyết, không có case cụ thể');
    expect(guideline.priority).toBe('CORE');
    expect(guideline.sourceRuleIds).toEqual(['f1:rule-1']);

    // Immutable + persisted: a fresh read from the store shows the same content.
    const stored = await getProfile(result.profile.id, dir);
    expect(stored).toEqual(result.profile);
  });

  test('no ACCEPTED + PROFILE-classified proposal at all -> PROFILE_EMPTY, nothing written', async () => {
    const session = await createStudioSession('thể loại A', dir);
    const result = await publishProfile(
      session,
      { label: 'Rỗng', scope: { language: 'vi', contentModes: [] } },
      dir,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('PROFILE_EMPTY');
  });

  test('an ACCEPTED proposal whose pick was classified something other than PROFILE is excluded, not published', async () => {
    const { session } = await seedPublishableSession();
    // Re-classify the only pick as TASTE instead of PROFILE — the accepted proposal
    // now has zero PROFILE-classified members behind it.
    classifyPick(session, { formulaId: 'f1', ruleId: 'rule-1' }, 'TASTE');

    const result = await publishProfile(
      session,
      { label: 'Không đủ điều kiện', scope: { language: 'vi', contentModes: [] } },
      dir,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('PROFILE_EMPTY');
  });

  test('a cluster with mixed classification (one PROFILE member, one not) is excluded entirely', async () => {
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
    const session = await createStudioSession('thể loại A', dir);
    session.picks = [
      { formulaId: 'f1', ruleId: 'rule-1' },
      { formulaId: 'f2', ruleId: 'rule-9' },
    ];
    await recomputeClusters(session, dir);
    expect(session.clusters).toHaveLength(1); // SIMILAR — both statements near-duplicate
    const cluster = session.clusters[0]!;

    // Only ONE of the two members is classified PROFILE.
    classifyPick(session, { formulaId: 'f1', ruleId: 'rule-1' }, 'PROFILE');
    classifyPick(session, { formulaId: 'f2', ruleId: 'rule-9' }, 'SOURCE_ONLY');

    session.proposals = [
      {
        id: 'p-1',
        clusterId: cluster.id,
        instruction: 'Mở bài bằng một trải nghiệm cá nhân gắn với một con số cụ thể',
        priority: 'OPTIONAL',
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

    const result = await publishProfile(
      session,
      { label: 'Không đủ điều kiện', scope: { language: 'vi', contentModes: [] } },
      dir,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('PROFILE_EMPTY');
  });

  /**
   * The gate case (plan §2.4 "Leak check chặn"): unlike `promoteCompound`'s
   * advisory-only scan, a leaking guideline must BLOCK publish outright — a Profile
   * is what the Writer actually reads, so nothing leaking gets through silently.
   */
  test('a leaking instruction blocks publish (PROFILE_LEAK_DETECTED) — nothing is written to the profile store', async () => {
    const { session } = await seedPublishableSession();
    // Overwrite the accepted proposal's instruction with one that still leaks a
    // verbatim source quote — proves publish (unlike promote) blocks on it.
    session.proposals[0]!.instruction =
      'Đặt tên ẩn dụ riêng cho một khái niệm tài chính ("thuế ở lại thành phố") rồi lặp lại';

    const result = await publishProfile(
      session,
      { label: 'Dính leak', scope: { language: 'vi', contentModes: [] } },
      dir,
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.errorCode !== 'PROFILE_LEAK_DETECTED') throw new Error('expected PROFILE_LEAK_DETECTED');
    expect(result.leaks.length).toBeGreaterThan(0);
    expect(result.leaks[0]!.kind).toBe('VERBATIM_QUOTE');

    // Nothing should have landed in the profile store — a blocked publish must not
    // leave a partial artifact behind.
    const { listProfiles } = await import('../../src/training/profile-store.ts');
    expect(await listProfiles(dir)).toEqual([]);
  });

  test('a leak in `when`/`avoidWhen` also blocks publish, not just `instruction`', async () => {
    const { session } = await seedPublishableSession();
    session.proposals[0]!.when = 'Chỉ áp dụng khi kể lại câu "thuế ở lại thành phố"';

    const result = await publishProfile(
      session,
      { label: 'Dính leak ở when', scope: { language: 'vi', contentModes: [] } },
      dir,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('PROFILE_LEAK_DETECTED');
  });
});
