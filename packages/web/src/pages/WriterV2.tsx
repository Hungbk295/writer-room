/**
 * Write Loop v2 UI — list + start form + one run's detail.
 *
 * Deliberately plain: the point of this screen is that a human can see WHY a run
 * finished or stopped — the facts ledger it committed to, what the deterministic
 * gate found, what a second agent objected to — not to look finished. The v1
 * Writer screen stays where it is; the two flows run side by side.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  api,
  type FormulaSummary,
  type GateResult,
  type GeneralPackSummary,
  type WriterPackSummary,
  type WriterRunV2,
  type WriterRunV2Summary,
} from '../api.ts';
import { href } from '../router.ts';
import { DeleteButton } from '../components/ui/DeleteButton.tsx';
import { EntityId } from '../components/ui/EntityId.tsx';
import { SourcePackExplorer } from '../components/SourcePackExplorer.tsx';

const AGENTS = ['codex', 'claude', 'grok', 'agy'] as const;

const PHASE_LABEL: Record<string, string> = {
  STUDY: '1. Đọc pack (STUDY)',
  WRITE: '2. Viết (WRITE)',
  GATE: '3. Gate tất định',
  EDIT_REVIEW: '4. Biên tập soi',
  REPAIR: '5. Sửa một vòng',
  DONE: 'Xong',
  FAILED: 'Hỏng',
};

function statusClass(status: WriterRunV2['status']): string {
  if (status === 'DONE') return 'chip ok';
  if (status === 'RUNNING') return 'chip warn';
  return 'chip bad';
}

export function WriterV2Page() {
  const [packs, setPacks] = useState<WriterPackSummary[]>([]);
  const [generalPacks, setGeneralPacks] = useState<GeneralPackSummary[]>([]);
  const [formulas, setFormulas] = useState<FormulaSummary[]>([]);
  const [runs, setRuns] = useState<WriterRunV2Summary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [audience, setAudience] = useState('');
  const [targetWords, setTargetWords] = useState('');
  const [packId, setPackId] = useState('');
  const [generalPack, setGeneralPack] = useState('');
  const [formulaId, setFormulaId] = useState('');
  const [agentId, setAgentId] = useState<string>('codex');
  const [editorAgentId, setEditorAgentId] = useState<string>('claude');
  const [starting, setStarting] = useState(false);
  const [exploringSourcePack, setExploringSourcePack] = useState(false);
  const [rerunningRunId, setRerunningRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const errors: string[] = [];
    try {
      const d = await api.listWriterPacks();
      setPacks(d.packs);
      setPackId((prev) => prev || d.packs[0]?.id || '');
    } catch (err) {
      errors.push(`Packs: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const d = await api.listGeneralPacks();
      setGeneralPacks(d.packs);
      setGeneralPack((prev) => prev || d.packs[0]?.path || '');
    } catch (err) {
      errors.push(`General packs: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const d = await api.listFormulas();
      setFormulas(d.formulas);
      setFormulaId((prev) => prev || d.formulas[0]?.id || '');
    } catch (err) {
      errors.push(`Formulas: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const d = await api.listWriterRunsV2();
      setRuns(d.runs);
    } catch {
      setRuns([]);
    }
    setError(errors.length > 0 ? errors.join(' · ') : null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      const run = await api.startWriterRunV2({
        brief: brief.trim() || title.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        ...(targetWords.trim() ? { targetWords: Number(targetWords) } : {}),
        packId,
        generalPack,
        formulaId,
        agentId,
        editorAgentId,
      });
      location.hash = href({ name: 'writer-v2-run', id: run.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  /** A failed attempt stays visible; ReRun always starts a distinct new article. */
  const rerun = async (failed: WriterRunV2Summary) => {
    if ((failed.status !== 'FAILED' && failed.status !== 'FAILED_GATE') || rerunningRunId) return;
    setError(null);
    setRerunningRunId(failed.id);
    try {
      // The list intentionally carries only its display fields. Reload the
      // failed record so audience and every original input are preserved.
      const source = await api.getWriterRunV2(failed.id);
      const next = await api.startWriterRunV2({
        brief: source.brief,
        ...(source.requestedTitle ? { title: source.requestedTitle } : {}),
        ...(source.audience ? { audience: source.audience } : {}),
        ...(source.targetWords !== undefined ? { targetWords: source.targetWords } : {}),
        packId: source.packId,
        generalPack: source.generalPackPath,
        formulaId: source.formulaId,
        agentId: source.agentId,
        editorAgentId: source.editorAgentId,
      });
      location.hash = href({ name: 'writer-v2-run', id: next.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunningRunId(null);
    }
  };

  const canStart = Boolean((brief.trim() || title.trim()) && packId && generalPack && formulaId) && !starting;

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Writer v2</h1>
          <p class="page-lead">
            Hai lượt gọi: đọc pack → viết. Sau đó gate tất định (code) → biên tập (agent khác) →
            sửa một vòng → gate lại. Không qua gate thì không có DONE.
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'writer' })}>Writer v1 →</a>
      </div>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <h2>Bài mới</h2>
        <div class="stack" style={{ gap: '0.85rem', marginTop: '0.75rem' }}>
          <label class="field">
            <span>Tiêu đề</span>
            <input
              type="text"
              placeholder="Tiêu đề bài / working title…"
              value={title}
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            />
          </label>

          <label class="field">
            <span>Brief</span>
            <textarea
              rows={3}
              placeholder="Bài này nói gì, cho ai, góc nào…"
              value={brief}
              onInput={(e) => setBrief((e.target as HTMLTextAreaElement).value)}
            />
          </label>

          <label class="field">
            <span>Khán giả (để STUDY chọn gap theo đúng người xem của mình)</span>
            <input
              type="text"
              placeholder="vd. Người làm văn phòng, nhà đầu tư mới…"
              value={audience}
              onInput={(e) => setAudience((e.target as HTMLInputElement).value)}
            />
          </label>

          <div class="form-grid-3">
            <div class="field">
              <span>Topic pack (nguồn dữ kiện duy nhất)</span>
              <div class="field-action-group">
                <select
                  value={packId}
                  onChange={(e) => setPackId((e.target as HTMLSelectElement).value)}
                  disabled={packs.length === 0}
                >
                  {packs.length === 0 ? (
                    <option value="">Chưa có Source Pack</option>
                  ) : packs.map((p) => (
                    <option key={p.id} value={p.id}>{p.title} · {p.videoCount} video</option>
                  ))}
                </select>
                <button
                  class="btn secondary"
                  type="button"
                  onClick={() => setExploringSourcePack(true)}
                  title="Tìm video, lấy transcript và tạo Topic pack"
                >
                  Explore
                </button>
              </div>
            </div>

            <label class="field">
              <span>General pack (cách làm, không phải dữ kiện)</span>
              <select value={generalPack} onChange={(e) => setGeneralPack((e.target as HTMLSelectElement).value)}>
                {generalPacks.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.title}{p.version ? ` · v${p.version}` : ''} · {p.wordCount} từ
                  </option>
                ))}
              </select>
            </label>

            <label class="field">
              <span>Formula (hợp đồng style)</span>
              <select value={formulaId} onChange={(e) => setFormulaId((e.target as HTMLSelectElement).value)}>
                {formulas.map((f) => (
                  <option key={f.id} value={f.id}>{f.label} · v{f.version} · {f.ruleCount} rule</option>
                ))}
              </select>
            </label>
          </div>

          <div class="form-grid-3">
            <label class="field">
              <span>Agent viết</span>
              <select value={agentId} onChange={(e) => setAgentId((e.target as HTMLSelectElement).value)}>
                {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>

            <label class="field">
              <span>Agent biên tập (nên khác agent viết)</span>
              <select
                value={editorAgentId}
                onChange={(e) => setEditorAgentId((e.target as HTMLSelectElement).value)}
              >
                {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>

            <label class="field">
              <span>Số từ (bỏ trống = 800–1500)</span>
              <input
                type="number"
                min={80}
                max={20000}
                step={50}
                value={targetWords}
                placeholder="1100"
                onInput={(e) => setTargetWords((e.target as HTMLInputElement).value)}
              />
            </label>
          </div>

          {agentId === editorAgentId && (
            <p class="muted" style={{ margin: 0, fontSize: '0.82rem' }}>
              ⚠️ Cùng một agent vừa viết vừa chấm — lớp 1 mất tác dụng đối chứng.
            </p>
          )}
          {generalPacks.length === 0 && (
            <p class="muted" style={{ margin: 0, fontSize: '0.82rem' }}>
              Chưa có general pack nào. Đặt file markdown vào <code>writer-room-data/general-packs/</code>.
            </p>
          )}
          {packs.length === 0 && (
            <p class="muted" style={{ margin: 0, fontSize: '0.82rem' }}>
              Chưa có Topic pack. Chọn <strong>Explore</strong> để tìm video, lấy transcript và Pack chúng lại.
            </p>
          )}
          <button
            class="btn teal"
            type="button"
            disabled={!canStart}
            style={{ alignSelf: 'flex-start', height: '42px', padding: '0 1.5rem', fontWeight: 600 }}
            onClick={() => void start()}
          >
            {starting ? 'Đang khởi động…' : '✍️ Bắt đầu'}
          </button>
        </div>
      </section>

      {exploringSourcePack && (
        <SourcePackExplorer
          onClose={() => setExploringSourcePack(false)}
          onPacked={(pack) => {
            setPacks((prev) => [pack, ...prev.filter((item) => item.id !== pack.id)]);
            setPackId(pack.id);
            setExploringSourcePack(false);
          }}
        />
      )}

      <section class="panel" style={{ marginTop: '1rem' }}>
        <h2>Runs ({runs.length})</h2>
        <ul class="list">
          {runs.map((run) => (
            <li key={run.id}>
              <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                <div>
                  <a href={href({ name: 'writer-v2-run', id: run.id })}>
                    <strong>{run.requestedTitle || run.brief}</strong>
                  </a>
                  <div class="meta" style={{ marginTop: '0.15rem' }}>
                    <span class={statusClass(run.status)}>{run.status}</span>
                    <span>{PHASE_LABEL[run.phase] ?? run.phase}</span>
                    <span>{run.packTitle}</span>
                    <span>{run.generalPackPath}</span>
                    <span>gate: {run.gateViolationCount} lỗi</span>
                    <span>defect: {run.defectCount}</span>
                    <span>{new Date(run.updatedAt).toLocaleString()}</span>
                  </div>
                </div>
                <div class="row" style={{ gap: '0.5rem' }}>
                  {(run.status === 'FAILED' || run.status === 'FAILED_GATE') && (
                    <button
                      class="btn teal"
                      type="button"
                      disabled={rerunningRunId !== null}
                      onClick={() => void rerun(run)}
                    >
                      {rerunningRunId === run.id ? 'Đang ReRun…' : '↻ ReRun'}
                    </button>
                  )}
                  <DeleteButton
                    onDelete={async () => {
                      await api.deleteWriterRunV2(run.id);
                      setRuns((prev) => prev.filter((r) => r.id !== run.id));
                    }}
                  />
                </div>
              </div>
            </li>
          ))}
          {runs.length === 0 && <li class="muted">Chưa có run nào.</li>}
        </ul>
      </section>
    </div>
  );
}

function GateView({ result, index }: { result: GateResult; index: number }) {
  return (
    <div style={{ marginTop: '0.5rem' }}>
      <span class={result.passed ? 'chip ok' : 'chip bad'}>
        Gate lần {index + 1}: {result.passed ? 'sạch' : `${result.violations.length} lỗi`}
      </span>
      {result.violations.length > 0 && (
        <ul class="list" style={{ marginTop: '0.4rem' }}>
          {result.violations.map((v, i) => (
            <li key={i} style={{ fontSize: '0.85rem' }}>
              <span class="chip bad">{v.code}</span>
              <span style={{ marginLeft: '0.5rem' }}>{v.detail}</span>
              {v.quote && <div class="muted" style={{ fontSize: '0.8rem', marginTop: '0.15rem' }}>…{v.quote}…</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WriterV2RunPage({ id }: { id: string }) {
  const [run, setRun] = useState<WriterRunV2 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const [copiedScript, setCopiedScript] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const data = await api.getWriterRunV2(id);
        if (!alive) return;
        setRun(data);
        if (data.status === 'RUNNING') timer = window.setTimeout(() => void tick(), 2000);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, pollKey]);

  if (error) {
    return (
      <div>
        <p class="error">{error}</p>
        <a class="btn secondary" href={href({ name: 'writer-v2' })}>← Writer v2</a>
      </div>
    );
  }
  if (!run) return <p class="muted">Đang tải…</p>;

  const script = run.finalScript ?? run.draft?.script ?? null;
  const canRerun = run.status === 'FAILED' || run.status === 'FAILED_GATE';
  // This is the recoverable shape: STUDY committed, but WRITE never committed.
  // The server also checks that the orphaned draft file exists and is readable.
  const canContinueWrite = run.status === 'FAILED' && run.phase === 'FAILED' && Boolean(run.study) && !run.draft;

  const rerun = async () => {
    if (!canRerun || rerunning) return;
    setError(null);
    setRerunning(true);
    try {
      const next = await api.startWriterRunV2({
        brief: run.brief,
        ...(run.requestedTitle ? { title: run.requestedTitle } : {}),
        ...(run.audience ? { audience: run.audience } : {}),
        ...(run.targetWords !== undefined ? { targetWords: run.targetWords } : {}),
        packId: run.packId,
        generalPack: run.generalPackPath,
        formulaId: run.formulaId,
        agentId: run.agentId,
        editorAgentId: run.editorAgentId,
      });
      location.hash = href({ name: 'writer-v2-run', id: next.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunning(false);
    }
  };

  const continueWrite = async () => {
    if (!canContinueWrite || continuing) return;
    setError(null);
    setContinuing(true);
    try {
      const next = await api.continueWriterRunV2(run.id);
      setRun(next);
      // Restart the detail-page poll without losing the current route or run id.
      setPollKey((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setContinuing(false);
    }
  };

  const copyArticle = async () => {
    if (!script) return;
    try {
      await navigator.clipboard.writeText(script);
      setCopiedScript(true);
    } catch (err) {
      setError(`Không copy được bài viết: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div>
      <div class="page-header">
        <div>
          <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <h1 class="page-title" style={{ marginBottom: 0 }}>{run.requestedTitle || run.brief}</h1>
            <span class={statusClass(run.status)}>{run.status}</span>
            <EntityId id={run.id} label="ID run" />
          </div>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            {PHASE_LABEL[run.phase] ?? run.phase} · pack: {run.packTitle} · general: {run.generalPackPath}
            {run.generalPackVersion ? ` v${run.generalPackVersion}` : ''} · formula v{run.formulaVersion} ·
            viết: {run.agentId} · biên tập: {run.editorAgentId}
          </p>
        </div>
        <div class="row" style={{ gap: '0.5rem' }}>
          {canContinueWrite && (
            <button class="btn teal" type="button" disabled={continuing || rerunning} onClick={() => void continueWrite()}>
              {continuing ? 'Đang tiếp tục WRITE…' : '▶ Tiếp tục WRITE'}
            </button>
          )}
          {canRerun && (
            <button class="btn teal" type="button" disabled={rerunning || continuing} onClick={() => void rerun()}>
              {rerunning ? 'Đang ReRun…' : '↻ ReRun bài mới'}
            </button>
          )}
          <a class="btn secondary" href={href({ name: 'writer-v2' })}>← Writer v2</a>
        </div>
      </div>

      {run.errorReason && (
        <p class="error" style={{ whiteSpace: 'pre-wrap' }}>{run.errorCode}: {run.errorReason}</p>
      )}

      {run.study && (
        <section class="panel" style={{ marginTop: '1rem' }}>
          <h2>1. STUDY</h2>
          <p style={{ marginTop: '0.5rem' }}><strong>Gap:</strong> {run.study.gap}</p>
          <h3>Video nguồn đã phủ gì</h3>
          <ul class="list">
            {run.study.coverageMap.map((c) => (
              <li key={c.videoId} style={{ fontSize: '0.85rem' }}>
                <strong>{c.videoId}</strong>: {c.mainClaim} <span class="muted">— góc: {c.angle}</span>
              </li>
            ))}
          </ul>
          <h3>Outline</h3>
          <p style={{ fontSize: '0.9rem' }}>{run.study.outline.coreInsight}</p>
          <ul class="list">
            {run.study.outline.progression.map((b, i) => (
              <li key={i} style={{ fontSize: '0.85rem' }}>
                <strong>{b.beat}</strong> — mới: {b.newInformation}
              </li>
            ))}
          </ul>
          <h3>Facts ledger ({run.study.factsLedger.length})</h3>
          <ul class="list">
            {run.study.factsLedger.map((f, i) => (
              <li key={i} style={{ fontSize: '0.85rem' }}>
                <strong>{f.fact}</strong>
                <div class="muted" style={{ fontSize: '0.8rem' }}>“{f.quote}” {f.videoId ? `· ${f.videoId}` : ''}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {run.draft && (
        <section class="panel" style={{ marginTop: '1rem' }}>
          <h2>2. Bài viết</h2>
          <p><strong>{run.draft.title}</strong></p>
          {run.draft.outlineChanges.length > 0 && (
            <>
              <h3>Đổi gì so với outline</h3>
              <ul class="list">
                {run.draft.outlineChanges.map((line, i) => (
                  <li key={i} style={{ fontSize: '0.85rem' }}>{line}</li>
                ))}
              </ul>
            </>
          )}
          <div style={{ position: 'relative' }}>
            <pre class="pre" style={{ margin: 0, paddingTop: '3.8rem' }}>{script}</pre>
            <button
              class="btn"
              type="button"
              onClick={() => void copyArticle()}
              style={{
                position: 'absolute',
                top: '0.7rem',
                right: '0.7rem',
                background: 'rgba(255, 255, 255, 0.12)',
                borderColor: 'rgba(255, 255, 255, 0.28)',
                color: '#e8edf5',
              }}
            >
              {copiedScript ? '✓ Đã copy' : '⧉ Copy bài viết'}
            </button>
          </div>
          <div class="row" style={{ gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            {run.draft.beatAnchors.map((a, i) => (
              <span key={i} class="chip">beat {i + 1}: {a.slice(0, 40)}…</span>
            ))}
          </div>
        </section>
      )}

      {run.gateResults.length > 0 && (
        <section class="panel" style={{ marginTop: '1rem' }}>
          <h2>3. Gate tất định (code, không phải ý kiến)</h2>
          {run.gateResults.map((g, i) => <GateView key={i} result={g} index={i} />)}
        </section>
      )}

      {run.editorDefects && (
        <section class="panel" style={{ marginTop: '1rem' }}>
          <h2>4. Biên tập ({run.editorDefects.length} defect)</h2>
          {run.editorDefects.length === 0 ? (
            <p class="muted">Không thấy lỗi nào.</p>
          ) : (
            <ul class="list">
              {run.editorDefects.map((d, i) => (
                <li key={i} style={{ fontSize: '0.85rem' }}>
                  <span class={d.severity === 'HIGH' ? 'chip bad' : d.severity === 'MEDIUM' ? 'chip warn' : 'chip'}>
                    {d.severity}
                  </span>
                  <span style={{ marginLeft: '0.5rem' }}>{d.note}</span>
                  <div class="muted" style={{ fontSize: '0.8rem', marginTop: '0.15rem' }}>“{d.quote}”</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
