import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, type Formula, type FormulaSummary } from '../api.ts';
import { href } from '../router.ts';

/** SDD §7.7: "A TRIAL Formula shows its badge everywhere it appears" — reused by
 * both the list row and the detail header so the rule holds in exactly one place. */
function statusBadgeClass(status: Formula['status']): string {
  if (status === 'TRIAL') return 'chip warn';
  if (status === 'VALIDATED') return 'chip ok';
  return 'chip';
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
              <li key={formula.id}>
                <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <a href={href({ name: 'training-formula', id: formula.id })}>
                    <strong>{formula.channelTitles.join(', ') || 'Formula'}</strong>
                  </a>
                  <span class={statusBadgeClass(formula.status)}>{formula.status}</span>
                </div>
                <div class="meta">
                  <span>{formula.scope}</span>
                  <span>{formula.videoCount} video</span>
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
              {formula.channelGroups.map((g) => g.channelTitle).join(', ') || 'Formula'}
            </h1>
            <span class={statusBadgeClass(formula.status)}>{formula.status}</span>
          </div>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            {formula.scope} · {formula.rules.length} rule · {new Date(formula.createdAt).toLocaleString()}
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
        <h2>Channel groups</h2>
        <ul class="list">
          {formula.channelGroups.map((g) => (
            <li key={g.channelTitle}>
              <strong>{g.channelTitle}</strong>
              <div class="meta">{g.videoSnapshotIds.length} video</div>
            </li>
          ))}
        </ul>
      </section>

      <section class="panel" style={{ marginTop: '1rem' }}>
        <h2>Rules ({formula.rules.length})</h2>
        <ul class="list">
          {formula.rules.map((rule) => (
            <li key={rule.id}>
              <strong>{rule.statement}</strong>
              <div class="stack" style={{ gap: '0.4rem', marginTop: '0.4rem' }}>
                {rule.evidence.map((ev, i) => (
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
                    <div class="meta" style={{ marginTop: '0.25rem' }}>
                      <span>segment: {ev.segmentId}</span>
                      {typeof ev.startSec === 'number' && <span>{ev.startSec}s–{ev.endSec}s</span>}
                    </div>
                  </blockquote>
                ))}
              </div>
            </li>
          ))}
        </ul>
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
    </div>
  );
}
