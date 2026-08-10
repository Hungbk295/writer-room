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
  applyProposalDecision,
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
        statement: 'Chốt bài bằng một khung khái niệm đã đặt tên',
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
        statement: 'Chốt bài bằng một khung khái niệm đã đặt tên',
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
      statement: 'Chốt bài bằng một khung khái niệm đã đặt tên',
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
      statement: 'Chốt bài bằng một khung khái niệm đã đặt tên',
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
      statement: 'Mở bài bằng một câu chuyện cá nhân, kèm số liệu',
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

  test('ACCEPTED with no statement keeps the LLM wording — rebuild yields a SYNTHESIZED rule', async () => {
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
  test('ACCEPTED with a statement equal to the original source wording yields CARRIED, not HUMAN_EDITED', async () => {
    const { session, proposalId } = await seedPendingProposal();
    const original = session.clusters[0]!.members[0]!.statement;
    applyProposalDecision(session, proposalId, 'ACCEPTED', original);
    await rebuildCompound(session, dir);

    expect(session.proposals[0]!.keptOriginal).toBe(true);
    expect(session.proposals[0]!.edited).toBe(false);
    expect(session.compound!.rules[0]!.mergeOrigin).toBe('CARRIED');
    expect(session.compound!.rules[0]!.statement).toBe(original);
  });

  test('ACCEPTED with a statement marks edited — rebuild yields a HUMAN_EDITED rule with the new wording', async () => {
    const { session, proposalId } = await seedPendingProposal();
    applyProposalDecision(session, proposalId, 'ACCEPTED', 'Mở bài bằng câu chuyện thật, gắn một con số cụ thể');
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
      statement: 'Đặt tên ẩn dụ riêng cho một khái niệm tài chính ("thuế ở lại thành phố") rồi lặp lại',
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
