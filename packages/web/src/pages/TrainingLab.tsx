import { useEffect, useState } from 'preact/hooks';
import {
  api,
  type CritiqueArtifact,
  type CritiquePattern,
  type TrainingLabRound,
  type TrainingLabRun,
  type TrainingLabRunSummary,
} from '../api.ts';
import { href } from '../router.ts';
import { useTrainingLabRunPoll } from '../hooks.ts';
import { RuleList } from './Training.tsx';
import { describeErrorCode } from '../features/training/FormulaDiscoveryAction.tsx';

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

  useEffect(() => {
    void api.listTrainingLabRuns()
      .then((d) => setRuns(d.runs))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

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
            {runs.map((run) => (
              <li
                key={run.id}
                style={{ cursor: 'pointer' }}
                onClick={() => { location.hash = href({ name: 'training-lab-run', id: run.id }); }}
              >
                <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <a
                    href={href({ name: 'training-lab-run', id: run.id })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <strong>{run.channelTitle || run.videoSnapshotId}</strong>
                  </a>
                  <span class={runStatusBadgeClass(run.status)}>{run.status}</span>
                </div>
                <div class="meta">
                  <span>video: {run.videoSnapshotId}</span>
                  <span>{run.roundCount} / tối đa 3 vòng</span>
                  <span>{new Date(run.updatedAt).toLocaleString()}</span>
                </div>
              </li>
            ))}
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
          {p.ruleId && (
            <div class="meta" style={{ marginTop: '0.15rem' }}>
              <span class="muted">rule: {p.ruleId}</span>
            </div>
          )}
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
function CritiqueView({ critique }: { critique: CritiqueArtifact }) {
  return (
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
  );
}

/** One round's four sections, exactly matching the user's own breakdown: "1. phần
 * formula agent 1 trích xuất từ script, 2. Phần agent 2 viết lại, 3. chấm điểm, 4.
 * formula sau khi đã căn chỉnh lại." A `FAILED` round shows its error and renders
 * nothing past whatever stage actually completed (SDD §12a: no partial re-run, no
 * pretending a later stage is still pending once the round has failed). */
function RoundBlock({ round }: { round: TrainingLabRound }) {
  const failed = round.status === 'FAILED';
  return (
    <section class="panel">
      <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Vòng {round.round}</h2>
        <span class={roundStatusBadgeClass(round.status)}>{round.status}</span>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <h3>1. Formula (agent 1 trích xuất)</h3>
        <p class="muted" style={{ margin: '0 0 0.5rem' }}>
          Phiên bản v{round.formulaVersionIn.version}
        </p>
        <RuleList rules={round.formulaVersionIn.rules} />
      </div>

      <div style={{ marginTop: '1.25rem' }}>
        <h3>2. Bài viết (agent 2)</h3>
        {round.draft ? (
          <>
            <p style={{ margin: '0 0 0.5rem' }}><strong>{round.draft.title}</strong></p>
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
          <h3>3. Chấm (agent 1 phê bình)</h3>
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
              <p class="muted" style={{ margin: '0 0 0.5rem' }}>
                Phiên bản v{round.formulaVersionOut.version} (từ v{round.formulaVersionIn.version})
              </p>
              <RuleList rules={round.formulaVersionOut.rules} />
            </>
          ) : (
            <p class="muted">Đang tinh chỉnh…</p>
          )}
        </div>
      )}

      {failed && (
        <div style={{ marginTop: '1.25rem' }}>
          <p class="error" style={{ margin: 0 }}>{describeErrorCode(round.errorCode)}</p>
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
          </div>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            Vòng {latestRound ? latestRound.round : 0}/{run.maxRounds} · video: {run.videoSnapshotId} · cập nhật{' '}
            {new Date(run.updatedAt).toLocaleString()}
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'training-lab' })}>← Training Lab</a>
      </div>

      <div class="stack" style={{ marginTop: '1rem' }}>
        {run.rounds.map((round) => (
          <RoundBlock key={round.round} round={round} />
        ))}
      </div>

      {run.status === 'DONE' && lastRefined && (
        <section class="panel" style={{ marginTop: '1rem' }}>
          <p class="ok" style={{ margin: 0, fontWeight: 600 }}>
            ✅ Hoàn tất — Formula cuối: v{lastRefined.version}
          </p>
        </section>
      )}
    </div>
  );
}
