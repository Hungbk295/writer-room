import { useEffect, useState } from 'preact/hooks';
import {
  api,
  DEFAULT_AGENT_OPTIONS,
  type CritiqueArtifact,
  type CritiquePattern,
  type DefaultAgentId,
  type TrainingLabRound,
  type TrainingLabRun,
  type TrainingLabRunSummary,
} from '../api.ts';
import { href } from '../router.ts';
import { useTrainingLabRunPoll } from '../hooks.ts';
import { RuleList } from './Training.tsx';
import { describeErrorCode } from '../features/training/FormulaDiscoveryAction.tsx';
import { DeleteButton } from '../components/ui/DeleteButton.tsx';
import { EntityId, shortEntityId } from '../components/ui/EntityId.tsx';

function agentLabel(id: DefaultAgentId): string {
  return DEFAULT_AGENT_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

/** Same badge convention as `Training.tsx`'s `statusBadgeClass` (SDD §7.7 spirit) —
 * applied here to `TrainingLabRun.status` (`RUNNING`/`DONE`/`FAILED`), a different
 * enum from `Formula.status` so it gets its own small mapping rather than reusing
 * that function's cases. */
function runStatusBadgeClass(status: TrainingLabRun['status']): string {
  if (status === 'DONE') return 'chip ok';
  if (status === 'FAILED') return 'chip bad';
  return 'chip warn';
}

function roundStatusBadgeClass(status: TrainingLabRound['status']): string {
  if (status === 'DONE') return 'chip ok';
  if (status === 'FAILED') return 'chip bad';
  return 'chip warn';
}

/** SDD §12a UI: the tab's landing view — "lists videos that have a Training Lab
 * run". `maxRounds` isn't on the summary shape (backend doesn't send it in the list
 * route), so round progress is shown as "N / tối đa 3 vòng" using the fixed §12a
 * constant as static copy rather than a fetched field. */
export function TrainingLabPage() {
  const [runs, setRuns] = useState<TrainingLabRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const data = await api.listTrainingLabRuns();
    setRuns(data.runs);
  };

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const remove = async (id: string) => {
    setError(null);
    await api.deleteTrainingLabRun(id);
    setRuns((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div>
      <h1 class="page-title">Training Lab</h1>
      <p class="page-lead">
        Vòng lặp viết lại → chấm → căn chỉnh cho từng video đã có Formula — tối đa 3 vòng mỗi video.
      </p>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <h2>Video đã train ({runs.length})</h2>
        {runs.length === 0 ? (
          <div class="empty-state">
            <p class="muted">
              Chưa có video nào chạy Training Lab. Mở một Formula và bấm{' '}
              <strong>🔬 Bắt đầu Training Lab</strong>.
            </p>
            <a class="btn teal" href={href({ name: 'training-formulas' })}>Đến Formula</a>
          </div>
        ) : (
          <ul class="list">
            {runs.map((run) => {
              const label = run.channelTitle || run.videoSnapshotId;
              return (
                <li key={run.id} class="pack-row">
                  <div
                    style={{ cursor: 'pointer' }}
                    onClick={() => { location.hash = href({ name: 'training-lab-run', id: run.id }); }}
                  >
                    <a
                      href={href({ name: 'training-lab-run', id: run.id })}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <strong>{label}</strong>
                    </a>
                    <div class="meta" style={{ marginTop: '0.2rem' }}>
                      <EntityId id={run.id} label="ID phiên train" />
                      <EntityId id={run.videoSnapshotId} label="ID video" />
                      <span>{run.roundCount} / tối đa 3 vòng</span>
                      <span>agent 1: {agentLabel(run.critiqueAgent)} · agent 2: {agentLabel(run.draftAgent)}</span>
                      <span>{new Date(run.updatedAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <div class="row pack-row-actions" style={{ gap: '0.5rem', alignItems: 'center' }}>
                    <span class={runStatusBadgeClass(run.status)}>{run.status}</span>
                    <a class="btn secondary" href={href({ name: 'training-lab-run', id: run.id })}>
                      Mở
                    </a>
                    <DeleteButton
                      title={label}
                      onDelete={() => remove(run.id)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function evidenceStyle(tone: 'ok' | 'bad'): Record<string, string> {
  const color = tone === 'ok' ? 'var(--ok)' : 'var(--danger)';
  const background = tone === 'ok' ? 'rgba(31, 122, 77, 0.06)' : 'rgba(180, 35, 24, 0.06)';
  return {
    margin: '0',
    padding: '0.5rem 0.75rem',
    borderLeft: `3px solid ${color}`,
    background,
    borderRadius: '6px',
  };
}

/** One `CritiquePattern` — same evidence rendering language (blockquote/`<code>`) as
 * `Training.tsx`'s `RuleList`, tinted by `tone` so positive vs negative reads at a
 * glance (SDD §12a: "make the positive/negative split visually obvious"). */
function PatternList({ patterns, tone }: { patterns: CritiquePattern[]; tone: 'ok' | 'bad' }) {
  if (!patterns || !Array.isArray(patterns) || patterns.length === 0) {
    return <p class="muted" style={{ fontSize: '0.85rem', margin: 0 }}>Không có.</p>;
  }
  return (
    <ul class="list">
      {patterns.map((p) => (
        <li key={p.id}>
          <strong>{p.description}</strong>
          <div class="meta" style={{ marginTop: '0.15rem' }}>
            <EntityId id={p.id} label="ID nhận xét" />
            {p.ruleId && <EntityId id={p.ruleId} label="Rule ID" />}
          </div>
          <div class="stack" style={{ gap: '0.4rem', marginTop: '0.4rem' }}>
            {(p.sourceEvidence || []).map((ev, i) => {
              const segIds = ev.segmentIds || ((ev as any).segmentId ? [(ev as any).segmentId] : []);
              return (
                <blockquote key={`src-${i}`} style={evidenceStyle(tone)}>
                  <code>{ev.quote}</code>
                  <div class="meta" style={{ marginTop: '0.25rem' }}>
                    <span>từ transcript gốc{segIds.length ? ` · segment${segIds.length > 1 ? 's' : ''}: ${segIds.join(', ')}` : ''}</span>
                  </div>
                </blockquote>
              );
            })}
            {(p.draftEvidence || []).map((ev, i) => (
              <blockquote key={`draft-${i}`} style={evidenceStyle(tone)}>
                <code>{ev.quote}</code>
                <div class="meta" style={{ marginTop: '0.25rem' }}>
                  <span>từ bài viết</span>
                </div>
              </blockquote>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Part 3 of the round — "chấm điểm" per the user's own words, split into two
 * clearly separated lists (positive/negative), never a numeric score (SDD §12a:
 * "Grading is qualitative pattern-matching, not a numeric score"). */
const VERDICT_CHIP: Record<string, string> = {
  KEEP: 'chip ok',
  SUSPECT: 'chip warn',
  DROP_BEFORE_MERGE: 'chip bad',
};

const REGRESSION_STATUS_CHIP: Record<string, string> = {
  fixed: 'chip ok',
  'still-present': 'chip bad',
  partial: 'chip warn',
};

function CritiqueView({ critique }: { critique: CritiqueArtifact }) {
  return (
    <div>
      <div class="training-detail-grid">
        <div>
          <span class="chip ok">Positive patterns ({critique.positivePatterns.length})</span>
          <div style={{ marginTop: '0.5rem' }}>
            <PatternList patterns={critique.positivePatterns} tone="ok" />
          </div>
        </div>
        <div>
          <span class="chip bad">Negative patterns ({critique.negativePatterns.length})</span>
          <div style={{ marginTop: '0.5rem' }}>
            <PatternList patterns={critique.negativePatterns} tone="bad" />
          </div>
        </div>
      </div>
      {critique.regressionCheck && critique.regressionCheck.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <p class="muted" style={{ margin: '0 0 0.35rem', fontSize: '0.82rem' }}>
            Đối chiếu với issue vòng trước (agent tự báo cáo, chưa được kiểm chứng):
          </p>
          <ul class="list">
            {critique.regressionCheck.map((r) => (
              <li key={r.patternId}>
                <span class={REGRESSION_STATUS_CHIP[r.status] ?? 'chip'}>{r.status}</span>
                <span style={{ marginLeft: '0.5rem', fontSize: '0.85rem' }}>{r.note}</span>
                <div class="meta" style={{ marginTop: '0.15rem' }}>
                  <EntityId id={r.patternId} label="ID nhận xét" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One round's four sections, exactly matching the user's own breakdown: "1. phần
 * formula agent 1 trích xuất từ script, 2. Phần agent 2 viết lại, 3. chấm điểm, 4.
 * formula sau khi đã căn chỉnh lại." A `FAILED` round shows its error and renders
 * nothing past whatever stage actually completed (SDD §12a: no partial re-run, no
 * pretending a later stage is still pending once the round has failed). */
function RoundBlock({ round, runId }: { round: TrainingLabRound; runId: string }) {
  const failed = round.status === 'FAILED';
  const roundRef = `${runId}:round:${round.round}`;
  return (
    <section class="panel">
      <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Vòng {round.round}</h2>
          <EntityId
            id={roundRef}
            label="ID vòng"
            displayId={`${shortEntityId(runId)}/r${round.round}`}
          />
        </div>
        <span class={roundStatusBadgeClass(round.status)}>{round.status}</span>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <h3>1. Formula (agent 1 trích xuất)</h3>
        <div class="meta" style={{ margin: '0 0 0.5rem' }}>
          <span>Phiên bản v{round.formulaVersionIn.version}</span>
          <EntityId id={round.formulaVersionIn.id} label="Formula ID" />
        </div>
        <RuleList rules={round.formulaVersionIn.rules} />
      </div>

      <div style={{ marginTop: '1.25rem' }}>
        <h3>2. Bài viết (agent 2)</h3>
        {round.draft ? (
          <>
            <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              <strong>{round.draft.title}</strong>
              {round.draftArtifactHash && (
                <EntityId id={round.draftArtifactHash} label="Mã bản viết" />
              )}
            </div>
            <pre class="pre">{round.draft.script}</pre>
            <div class="row" style={{ gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              {round.draft.appliedRules.map((r) => (
                <span key={r} class="chip">{r}</span>
              ))}
            </div>
          </>
        ) : round.status === 'DRAFTING' ? (
          <p class="muted">Đang viết…</p>
        ) : null}
      </div>

      {(round.critique || round.status === 'CRITIQUING') && (
        <div style={{ marginTop: '1.25rem' }}>
          <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <h3>3. Chấm (agent 1 phê bình)</h3>
            {round.critiqueArtifactHash && (
              <EntityId id={round.critiqueArtifactHash} label="Mã bản chấm" />
            )}
          </div>
          {round.critique ? (
            <CritiqueView critique={round.critique} />
          ) : (
            <p class="muted">Đang chấm…</p>
          )}
        </div>
      )}

      {(round.formulaVersionOut || round.status === 'REFINING') && (
        <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px dashed var(--line)' }}>
          <h3>4. Formula sau khi căn chỉnh</h3>
          {round.formulaVersionOut ? (
            <>
              <div class="meta" style={{ margin: '0 0 0.5rem' }}>
                <span>Phiên bản v{round.formulaVersionOut.version} (từ v{round.formulaVersionIn.version})</span>
                <EntityId id={round.formulaVersionOut.id} label="Formula ID" />
              </div>
              <RuleList rules={round.formulaVersionOut.rules} />
              {((round.ruleChanges?.length ?? 0) > 0 || (round.notARuleProblem?.length ?? 0) > 0) && (
                <div class="training-detail-grid" style={{ marginTop: '0.75rem' }}>
                  <div>
                    <span class="chip">Sửa rule ({round.ruleChanges?.length ?? 0})</span>
                    <ul class="list" style={{ marginTop: '0.4rem' }}>
                      {(round.ruleChanges ?? []).map((c, i) => (
                        <li key={i} style={{ fontSize: '0.85rem' }}>
                          <strong>{c.action}</strong> {c.ruleId}: {c.statement}
                          <div class="meta" style={{ marginTop: '0.15rem' }}>
                            <span>vì: {c.sourcePatternIds.join(', ')}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <span class="chip warn">Không phải lỗi rule ({round.notARuleProblem?.length ?? 0})</span>
                    <ul class="list" style={{ marginTop: '0.4rem' }}>
                      {(round.notARuleProblem ?? []).map((n) => (
                        <li key={n.patternId} style={{ fontSize: '0.85rem' }}>
                          <strong>{n.patternId}</strong>: {n.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              {round.changeLog && round.changeLog.length > 0 && (
                <div style={{ marginTop: '0.75rem' }}>
                  <p class="muted" style={{ margin: '0 0 0.35rem', fontSize: '0.82rem' }}>
                    Lý do thay đổi (agent tự giải thích, chưa được kiểm chứng):
                  </p>
                  <ul class="list">
                    {round.changeLog.map((line, i) => (
                      <li key={i} style={{ fontSize: '0.85rem' }}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p class="muted">Đang tinh chỉnh…</p>
          )}
        </div>
      )}

      {failed && (
        <div style={{ marginTop: '1.25rem' }}>
          <p class="error" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {describeErrorCode(round.errorCode, round.errorReason)}
          </p>
        </div>
      )}
    </section>
  );
}

/** SDD §12a UI — the core deliverable: one run, ALL rounds, live via
 * `useTrainingLabRunPoll` so an in-progress run fills in without a manual refresh. */
export function TrainingLabRunPage({ id }: { id: string }) {
  const { run, error } = useTrainingLabRunPoll(id);

  if (error) {
    return (
      <div>
        <p class="error">{error}</p>
        <a class="btn secondary" href={href({ name: 'training-lab' })}>← Training Lab</a>
      </div>
    );
  }

  if (!run) {
    return <p class="muted">Đang tải…</p>;
  }

  const latestRound = run.rounds[run.rounds.length - 1];
  const lastRefined = [...run.rounds].reverse().find((r) => r.formulaVersionOut)?.formulaVersionOut ?? null;

  return (
    <div>
      <div class="page-header">
        <div>
          <div class="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
            <h1 class="page-title" style={{ marginBottom: 0 }}>
              {run.channelTitle || run.videoSnapshotId}
            </h1>
            <span class={runStatusBadgeClass(run.status)}>{run.status}</span>
            <EntityId id={run.id} label="ID phiên train" />
          </div>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            Vòng {latestRound ? latestRound.round : 0}/{run.maxRounds} · video: {run.videoSnapshotId} ·
            agent 1: {agentLabel(run.critiqueAgent)} · agent 2: {agentLabel(run.draftAgent)} · cập nhật{' '}
            {new Date(run.updatedAt).toLocaleString()}
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'training-lab' })}>← Training Lab</a>
      </div>

      <div class="stack" style={{ marginTop: '1rem' }}>
        {run.rounds.map((round) => (
          <RoundBlock key={round.round} round={round} runId={run.id} />
        ))}
      </div>

      {run.status === 'DONE' && lastRefined && (
        <section class="panel" style={{ marginTop: '1rem' }}>
          <p class="ok" style={{ margin: 0, fontWeight: 600 }}>
            ✅ Hoàn tất — Formula cuối: v{lastRefined.version}
          </p>
          {run.ruleVerdicts && run.ruleVerdicts.length > 0 && (
            <div style={{ marginTop: '0.75rem' }}>
              <h3 style={{ marginBottom: '0.35rem' }}>Kết luận từng rule (đọc trước khi merge)</h3>
              <p class="muted" style={{ margin: '0 0 0.5rem', fontSize: '0.82rem' }}>
                Tính từ dữ liệu thật của run: rule nào draft có áp, rule nào bị pattern tiêu cực
                trỏ vào. Lab không tự xoá rule — người quyết khi merge.
              </p>
              <ul class="list">
                {run.ruleVerdicts.map((v) => (
                  <li key={v.ruleId}>
                    <span class={VERDICT_CHIP[v.verdict]}>{v.verdict}</span>
                    <span style={{ marginLeft: '0.5rem', fontSize: '0.85rem' }}>{v.statement}</span>
                    <div class="meta" style={{ marginTop: '0.15rem' }}>
                      <span>{v.ruleId}</span>
                      <span>áp dụng {v.exercised} vòng</span>
                      <span>bị chê {v.hurtCount} lần</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
