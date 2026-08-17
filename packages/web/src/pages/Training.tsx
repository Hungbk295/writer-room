import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  api, DEFAULT_AGENT_OPTIONS, type DefaultAgentId, type Formula, type FormulaRule, type FormulaSummary,
} from '../api.ts';
import { href } from '../router.ts';
import { isTauri } from '../components/terminal/terminalApi.ts';
import { DeleteButton } from '../components/ui/DeleteButton.tsx';
import { EntityId } from '../components/ui/EntityId.tsx';

/** ADR-14: `origin` replaced `scope`. Shown in Vietnamese because it is the one
 * thing that tells the user whether a Formula came from one video, from refining
 * one, or from a Studio merge. */
export function originLabel(origin: Formula['origin']): string {
  if (origin === 'COMPOUND') return 'Ghép (thể loại)';
  if (origin === 'REFINED') return 'Đã tinh chỉnh';
  return '1 video';
}

/** List/detail title: rename → video title → genre → channel. */
export function formulaDisplayName(formula: Formula | FormulaSummary): string {
  if ('label' in formula && formula.label?.trim()) return formula.label.trim();
  if (formula.title?.trim()) return formula.title.trim();
  if ('videoTitle' in formula && formula.videoTitle?.trim()) return formula.videoTitle.trim();
  if (formula.origin === 'COMPOUND' && 'genre' in formula && formula.genre?.trim()) {
    return formula.genre.trim();
  }
  if ('channelTitle' in formula && formula.channelTitle?.trim()) return formula.channelTitle.trim();
  return 'Formula';
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
    <div class="stack" style={{ gap: '0.6rem' }}>
      {!rules.some((rule) => rule.role === 'payoff') && (
        <p class="error" style={{ margin: 0 }}>
          ⚠ Formula này chưa có PAYOFF được đánh dấu và dẫn chứng. Hãy chạy Training Lab để bổ sung.
        </p>
      )}
      <ul class="list">
        {rules.map((rule) => (
          <li key={rule.id}>
            <strong>{rule.statement}</strong>
            <div class="meta" style={{ marginTop: '0.15rem' }}>
              <EntityId id={rule.id} label="Rule ID" />
              {rule.role && <span class={rule.role === 'payoff' ? 'chip ok' : 'chip'}>{rule.role.toUpperCase()}</span>}
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
    </div>
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

  const remove = async (id: string) => {
    setError(null);
    await api.deleteFormula(id);
    setFormulas((prev) => prev.filter((f) => f.id !== id));
  };

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
              <li key={formula.id} class="pack-row">
                <div style={{ cursor: 'pointer' }} onClick={() => { location.hash = href({ name: 'training-formula', id: formula.id }); }}>
                  <a
                    href={href({ name: 'training-formula', id: formula.id })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <strong>{formula.label}</strong>
                  </a>
                  <div class="meta" style={{ marginTop: '0.2rem' }}>
                    <EntityId id={formula.id} label="Formula ID" />
                    <span>{originLabel(formula.origin)}</span>
                    {formula.version > 1 && <span>v{formula.version}</span>}
                    <span>{formula.videoCount} video</span>
                    <span>{formula.ruleCount} rule</span>
                    <span>{new Date(formula.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <div class="row pack-row-actions" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <span class={statusBadgeClass(formula.status)}>{formula.status}</span>
                  <a class="btn secondary" href={href({ name: 'training-formula', id: formula.id })}>
                    Mở
                  </a>
                  <DeleteButton
                    title={formula.label}
                    onDelete={() => remove(formula.id)}
                  />
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
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  useEffect(() => {
    void api.getFormula(id)
      .then(setFormula)
      .catch((err) => setError(err.message));
  }, [id]);

  const startRename = () => {
    if (!formula) return;
    setRenameDraft(formulaDisplayName(formula));
    setRenaming(true);
  };

  const submitRename = async (e: Event) => {
    e.preventDefault();
    if (!formula || !renameDraft.trim() || renameBusy) return;
    setRenameBusy(true);
    setError(null);
    try {
      const updated = await api.renameFormula(formula.id, renameDraft.trim());
      setFormula(updated);
      setRenaming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenameBusy(false);
    }
  };

  if (error && !formula) {
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

  const displayName = formulaDisplayName(formula);

  return (
    <div>
      <div class="page-header">
        <div>
          <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {renaming ? (
              <form class="row" style={{ gap: '0.4rem', alignItems: 'center', flex: 1 }} onSubmit={submitRename}>
                <input
                  style={{ flex: 1, minWidth: '12rem' }}
                  value={renameDraft}
                  onInput={(e) => setRenameDraft((e.target as HTMLInputElement).value)}
                  autofocus
                />
                <button class="btn" type="submit" disabled={renameBusy || !renameDraft.trim()}>
                  {renameBusy ? 'Đang lưu…' : 'Lưu'}
                </button>
                <button class="btn secondary" type="button" disabled={renameBusy} onClick={() => setRenaming(false)}>
                  Huỷ
                </button>
              </form>
            ) : (
              <>
                <h1 class="page-title" style={{ marginBottom: 0 }}>
                  {displayName}
                </h1>
                <span class={statusBadgeClass(formula.status)}>{formula.status}</span>
              </>
            )}
            <EntityId id={formula.id} label="Formula ID" />
          </div>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            {originLabel(formula.origin)}
            {formula.version > 1 ? ` · v${formula.version}` : ''} · {formula.rules.length} rule ·{' '}
            {new Date(formula.createdAt).toLocaleString()}
          </p>
        </div>
        <div class="row" style={{ gap: '0.5rem' }}>
          {!renaming && (
            <button class="btn secondary" type="button" onClick={startRename}>
              Đổi tên
            </button>
          )}
          <a class="btn secondary" href={href({ name: 'training-formulas' })}>← Formula</a>
        </div>
      </div>

      {error && <p class="error">{error}</p>}

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
            {formula.videoTitle ?? displayName}
            {formula.channelTitle ? ` · ${formula.channelTitle}` : ''}
            {' · 1 video'}
            {formula.lineage.parentFormulaId ? ' · đã tinh chỉnh từ bản trước' : ''}
          </p>
        )}
      </section>

      {formula.status === 'DRAFT' ? (
        <section class="panel" style={{ marginTop: '1rem' }}>
          <h2>Chờ import</h2>
          <ImportFormulaResultAction formulaId={formula.id} onImported={setFormula} />
        </section>
      ) : (
        <>
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
                    <EntityId id={a.videoSnapshotId} label="Video ID" />
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
        </>
      )}
    </div>
  );
}

type ImportPhase = 'idle' | 'importing' | 'error';

/** Second half of the semi-auto "PTY tương tác" flow (2026-08-10, user's own
 * dna-spy pattern) — `FormulaDiscoveryAction`/`InteractiveFormulaDiscoveryAction`
 * (Spy video page) pre-creates this Formula as `DRAFT` with empty `rules` and opens
 * an interactive terminal; this button is what the user clicks once that session has
 * written `out/result.json` by hand. No polling — importing is a deliberate, one-shot
 * user action, not something to auto-retry in the background. */
function ImportFormulaResultAction({ formulaId, onImported }: { formulaId: string; onImported: (f: Formula) => void }) {
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setPhase('importing');
    setError(null);
    try {
      const result = await api.importFormulaDiscoveryResult(formulaId);
      if (result.status === 'IMPORTED' && result.formula) {
        onImported(result.formula);
        return;
      }
      setError(result.reason ?? `Import thất bại (${result.status})`);
      setPhase('error');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  return (
    <div class="stack" style={{ gap: '0.5rem' }}>
      <p class="muted" style={{ margin: 0 }}>
        Formula này đang chờ kết quả từ phiên PTY tương tác (mở ở trang video trong Spy).
        Sau khi phiên ghi xong <code>out/result.json</code>, bấm nút bên dưới để import.
      </p>
      {error && <p class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{error}</p>}
      <button
        class="btn secondary"
        type="button"
        disabled={phase === 'importing'}
        style={{ alignSelf: 'flex-start' }}
        onClick={() => void run()}
      >
        {phase === 'importing' ? '📥 Đang import…' : '📥 Import kết quả'}
      </button>
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
  // Default 'grok' for both — matches the hardcoded behavior before agent choice was
  // configurable (2026-08-10, user: "cần có thêm setup chọn loại agent cho agent 1
  // và agent 2"), so an untouched dropdown reproduces the prior default exactly.
  const [draftAgent, setDraftAgent] = useState<DefaultAgentId>('grok');
  const [critiqueAgent, setCritiqueAgent] = useState<DefaultAgentId>('grok');
  // Write Loop v2 Phase 1: 2 rounds is the default (round 3 never added anything
  // across 9 real runs); 1 is there for a quick read on a fresh formula.
  const [maxRounds, setMaxRounds] = useState<number>(2);

  const start = async () => {
    setPhase('starting');
    setError(null);
    if (!isTauri()) {
      setError('Training Lab chạy bằng PTY tương tác. Hãy mở Writer Room qua `bun run app:macos`, không chạy trên browser thuần.');
      setPhase('failed');
      return;
    }
    try {
      const run = await api.startTrainingLabRun(formulaId, draftAgent, critiqueAgent, maxRounds);
      setRunId(run.id);
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  };

  if (phase === 'idle') {
    return (
      <div class="stack" style={{ gap: '0.6rem' }}>
        <div class="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
          <label class="stack" style={{ gap: '0.25rem' }}>
            <span class="muted" style={{ fontSize: '0.82rem' }}>Agent 1 (chấm + căn chỉnh)</span>
            <select
              value={critiqueAgent}
              onChange={(e) => setCritiqueAgent((e.target as HTMLSelectElement).value as DefaultAgentId)}
            >
              {DEFAULT_AGENT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          <label class="stack" style={{ gap: '0.25rem' }}>
            <span class="muted" style={{ fontSize: '0.82rem' }}>Agent 2 (viết)</span>
            <select
              value={draftAgent}
              onChange={(e) => setDraftAgent((e.target as HTMLSelectElement).value as DefaultAgentId)}
            >
              {DEFAULT_AGENT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          <label class="stack" style={{ gap: '0.25rem' }}>
            <span class="muted" style={{ fontSize: '0.82rem' }}>Số vòng</span>
            <select
              value={String(maxRounds)}
              onChange={(e) => setMaxRounds(Number((e.target as HTMLSelectElement).value))}
            >
              <option value="2">2 vòng (mặc định)</option>
              <option value="1">1 vòng</option>
            </select>
          </label>
        </div>
        <button class="btn secondary" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => void start()}>
          🔬 Bắt đầu Training Lab
        </button>
      </div>
    );
  }

  if (phase === 'starting') {
    return <span class="chip warn">🔬 Đang khởi động…</span>;
  }

  if (phase === 'done') {
    return (
      <div class="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
        <span class="chip ok">🔬 Đã bắt đầu</span>
        {runId && <EntityId id={runId} label="ID phiên train" />}
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
