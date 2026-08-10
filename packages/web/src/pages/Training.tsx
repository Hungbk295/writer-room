import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, type Formula, type FormulaRule, type FormulaSummary } from '../api.ts';
import { href } from '../router.ts';

/** ADR-14: `origin` replaced `scope`. Shown in Vietnamese because it is the one
 * thing that tells the user whether a Formula came from one video, from refining
 * one, or from a Studio merge. */
export function originLabel(origin: Formula['origin']): string {
  if (origin === 'COMPOUND') return 'Ghép (thể loại)';
  if (origin === 'REFINED') return 'Đã tinh chỉnh';
  return '1 video';
}

/** Distinct source videos behind a compound Formula — derived, never stored, so it
 * cannot disagree with `rules` (mirrors `sourceVideoCount` in training-core). */
export function compoundVideoCount(formula: Formula): number {
  return new Set(formula.rules.flatMap((r) => (r.sources ?? []).map((s) => s.videoSnapshotId))).size;
}

/** SDD §7.7: "A TRIAL Formula shows its badge everywhere it appears" — reused by
 * both the list row and the detail header so the rule holds in exactly one place. */
export function statusBadgeClass(status: Formula['status']): string {
  if (status === 'TRIAL') return 'chip warn';
  if (status === 'VALIDATED') return 'chip ok';
  return 'chip';
}

/** The exact rule + evidence rendering style established here for the M1 Formula
 * detail view — reused as-is by the Training Lab round view (SDD §12a UI) so "the
 * formula agent 1 trích xuất" (part 1) and "formula sau khi căn chỉnh" (part 4)
 * both look identical to this canonical Formula rendering, not a re-invented style. */
export function RuleList({ rules }: { rules: FormulaRule[] }) {
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
    return <p class="muted" style={{ margin: 0 }}>Không có rule.</p>;
  }
  return (
    <ul class="list">
      {rules.map((rule) => (
        <li key={rule.id}>
          <strong>{rule.statement}</strong>
          <div class="meta" style={{ marginTop: '0.15rem' }}>
            <span class="muted">{rule.id}</span>
          </div>
          <div class="stack" style={{ gap: '0.4rem', marginTop: '0.4rem' }}>
            {(rule.evidence || []).map((ev, i) => {
              const segIds = ev.segmentIds || ((ev as any).segmentId ? [(ev as any).segmentId] : []);
              return (
                <blockquote
                  key={`${rule.id}-${i}`}
                  style={{
                    margin: 0,
                    padding: '0.5rem 0.75rem',
                    borderLeft: '3px solid var(--teal)',
                    background: 'rgba(31, 138, 122, 0.06)',
                    borderRadius: '6px',
                  }}
                >
                  <code>{ev.quote}</code>
                  {segIds.length > 0 && (
                    <div class="meta" style={{ marginTop: '0.25rem' }}>
                      <span>segment{segIds.length > 1 ? 's' : ''}: {segIds.join(', ')}</span>
                      {typeof ev.startSec === 'number' && <span>{ev.startSec}s–{ev.endSec}s</span>}
                    </div>
                  )}
                </blockquote>
              );
            })}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function FormulasPage() {
  const [formulas, setFormulas] = useState<FormulaSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await api.listFormulas();
    setFormulas(data.formulas);
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setError(err.message));
  }, [refresh]);

  return (
    <div>
      <h1 class="page-title">Formula</h1>
      <p class="page-lead">
        Pattern/style rút ra từ transcript video, kèm bằng chứng trích dẫn — bấm{' '}
        <strong>Tìm Formula</strong> trên một video đã có transcript trong Spy để tạo mới.
      </p>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <h2>Formula ({formulas.length})</h2>
        {formulas.length === 0 ? (
          <div class="empty-state">
            <p class="muted">
              Chưa có Formula nào. Mở một video có transcript trong Spy, bấm{' '}
              <strong>🧪 Tìm Formula</strong>.
            </p>
            <a class="btn teal" href={href({ name: 'spy' })}>Đến Spy</a>
          </div>
        ) : (
          <ul class="list">
            {formulas.map((formula) => (
              <li
                key={formula.id}
                style={{ cursor: 'pointer' }}
                onClick={() => { location.hash = href({ name: 'training-formula', id: formula.id }); }}
              >
                <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <a
                    href={href({ name: 'training-formula', id: formula.id })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <strong>{formula.label}</strong>
                  </a>
                  <span class={statusBadgeClass(formula.status)}>{formula.status}</span>
                </div>
                <div class="meta">
                  <span>{originLabel(formula.origin)}</span>
                  {formula.version > 1 && <span>v{formula.version}</span>}
                  <span>{formula.videoCount} video</span>
                  <span>{formula.ruleCount} rule</span>
                  <span>{new Date(formula.createdAt).toLocaleString()}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function FormulaPage({ id }: { id: string }) {
  const [formula, setFormula] = useState<Formula | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getFormula(id)
      .then(setFormula)
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) {
    return (
      <div>
        <p class="error">{error}</p>
        <a class="btn secondary" href={href({ name: 'training-formulas' })}>← Formula</a>
      </div>
    );
  }

  if (!formula) {
    return <p class="muted">Đang tải…</p>;
  }

  return (
    <div>
      <div class="page-header">
        <div>
          <div class="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
            <h1 class="page-title" style={{ marginBottom: 0 }}>
              {formula.genre ?? formula.channelTitle ?? 'Formula'}
            </h1>
            <span class={statusBadgeClass(formula.status)}>{formula.status}</span>
          </div>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            {originLabel(formula.origin)}
            {formula.version > 1 ? ` · v${formula.version}` : ''} · {formula.rules.length} rule ·{' '}
            {new Date(formula.createdAt).toLocaleString()}
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'training-formulas' })}>← Formula</a>
      </div>

      {formula.warnings.length > 0 && (
        <div class="stack" style={{ margin: '0.75rem 0' }}>
          {formula.warnings.map((w) => (
            <p key={w} class="muted" style={{ margin: 0 }}>
              <span class="chip warn">Cảnh báo</span> {w}
            </p>
          ))}
        </div>
      )}

      <section class="panel">
        <h2>Nguồn</h2>
        {formula.origin === 'COMPOUND' ? (
          <p class="muted" style={{ margin: 0 }}>
            Formula thể loại "{formula.genre}" — ghép từ {compoundVideoCount(formula)} video.
            Mỗi rule bên dưới ghi rõ nó đến từ video nào.
          </p>
        ) : (
          <p class="muted" style={{ margin: 0 }}>
            {formula.channelTitle ?? 'Không rõ kênh'} · 1 video
            {formula.lineage.parentFormulaId ? ' · đã tinh chỉnh từ bản trước' : ''}
          </p>
        )}
      </section>

      <section class="panel" style={{ marginTop: '1rem' }}>
        <h2>Rules ({formula.rules.length})</h2>
        <RuleList rules={formula.rules} />
      </section>

      <section class="panel" style={{ marginTop: '1rem' }}>
        <h2>Included artifacts ({formula.includedArtifacts.length})</h2>
        <ul class="list">
          {formula.includedArtifacts.map((a) => (
            <li key={a.videoSnapshotId}>
              <div class="meta">
                <span>video: {a.videoSnapshotId}</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>hash: {a.analysisArtifactHash.slice(0, 16)}…</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section class="panel" style={{ marginTop: '1rem' }}>
        <h2>Training Lab</h2>
        <p class="muted" style={{ marginTop: 0 }}>
          Chạy vòng lặp viết lại → chấm → căn chỉnh (tối đa 3 vòng) trên video nguồn của
          Formula này, xem toàn bộ lịch sử ở tab Training Lab.
        </p>
        <StartTrainingLabAction formulaId={formula.id} />
      </section>
    </div>
  );
}

type LabTriggerPhase = 'idle' | 'starting' | 'done' | 'failed';

/** Trigger for starting a Training Lab run FROM an existing Formula (SDD §12a UI —
 * "you start a run from an EXISTING Formula"). Same done-state UX precedent as
 * `FormulaDiscoveryAction`'s "Xem Formula →" link: after the POST succeeds, show a
 * link the user clicks rather than an automatic redirect. */
function StartTrainingLabAction({ formulaId }: { formulaId: string }) {
  const [phase, setPhase] = useState<LabTriggerPhase>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setPhase('starting');
    setError(null);
    try {
      const run = await api.startTrainingLabRun(formulaId);
      setRunId(run.id);
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  };

  if (phase === 'idle') {
    return (
      <button class="btn secondary" type="button" onClick={() => void start()}>
        🔬 Bắt đầu Training Lab
      </button>
    );
  }

  if (phase === 'starting') {
    return <span class="chip warn">🔬 Đang khởi động…</span>;
  }

  if (phase === 'done') {
    return (
      <div class="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
        <span class="chip ok">🔬 Đã bắt đầu</span>
        {runId && (
          <a class="btn teal" href={href({ name: 'training-lab-run', id: runId })}>
            Xem tiến trình →
          </a>
        )}
      </div>
    );
  }

  // phase === 'failed'
  return (
    <div class="stack" style={{ gap: '0.35rem' }}>
      <p class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{error}</p>
      <button class="btn secondary" type="button" onClick={() => setPhase('idle')}>Thử lại</button>
    </div>
  );
}
