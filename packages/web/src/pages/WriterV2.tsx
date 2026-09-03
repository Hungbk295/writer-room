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
  type ChannelProfile,
  type ChannelStyleSummary,
  type FormulaSummary,
  type GateResult,
  type GeneralPackSummary,
  type WriterPackSummary,
  type WriterRunV2,
  type WriterRunV2Summary,
} from '../api.ts';
import { href } from '../router.ts';
import { EntityId } from '../components/ui/EntityId.tsx';
import { SourcePackExplorer } from '../components/SourcePackExplorer.tsx';
import { WriterProgressBar } from '../components/WriterProgressBar.tsx';

const AGENTS = ['codex', 'claude', 'grok', 'agy'] as const;

const PHASE_LABEL: Record<string, string> = {
  CONFIGURING: 'Đang cấu hình',
  READY: 'Đã chuẩn bị — chờ duyệt',
  STUDY: '1. Đọc pack (STUDY)',
  WRITE: '2. Viết (WRITE)',
  GATE: '3. Gate tất định',
  EDIT_REVIEW: '4. Biên tập soi',
  REPAIR: '5. Sửa một vòng',
  DONE: 'Xong',
  FAILED: 'Hỏng',
};

/**
 * First real sentence of a style file — skips the `#` title, the `<!-- version -->`
 * marker, quotes and bullets, so what is left is prose describing the voice.
 * Returns null when the file opens straight into structure.
 */
function styleBlurbOf(markdown: string): string | null {
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('<!--') || line.startsWith('>')) continue;
    if (line.startsWith('-') || line.startsWith('*') || line.startsWith('|')) continue;
    return line.length > 160 ? `${line.slice(0, 157)}…` : line;
  }
  return null;
}

function statusClass(status: WriterRunV2['status']): string {
  if (status === 'DONE') return 'chip ok';
  if (status === 'RUNNING') return 'chip warn';
  if (status === 'DRAFT') return 'chip';
  return 'chip bad';
}

export function WriterV2Page() {
  const [runs, setRuns] = useState<WriterRunV2Summary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await api.listWriterPostsV2();
      setRuns(d.posts);
      setError(null);
    } catch (err) {
      setRuns([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    setError(null);
    setCreating(true);
    try {
      const post = await api.createWriterPostV2();
      location.hash = href({ name: 'writer-v2-run', id: post.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Writer v2</h1>
          <p class="page-lead">
            Mỗi post là một writer room: tạo nháp trước, cấu hình và review trong post, rồi mới Run.
          </p>
        </div>
        <div class="row" style={{ gap: '0.5rem' }}>
          <button class="btn teal" type="button" disabled={creating} onClick={() => void create()}>
            {creating ? 'Đang tạo…' : 'Create writer post'}
          </button>
          <a class="btn secondary" href={href({ name: 'writer' })}>Source Packs →</a>
        </div>
      </div>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <h2>Writer posts ({runs.length})</h2>
        <ul class="list">
          {runs.map((run) => (
            <li key={run.id}>
              <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                <div>
                  <a href={href({ name: 'writer-v2-run', id: run.id })}>
                    <strong>{run.requestedTitle || run.brief || 'Untitled writer post'}</strong>
                  </a>
                  <div class="meta" style={{ marginTop: '0.15rem', display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span class={statusClass(run.status)}>{run.status}</span>
                    <span>{PHASE_LABEL[run.phase] ?? run.phase}</span>
                    {run.channelId && <span class="chip">Kênh: {run.channelId}</span>}
                    <span class="chip" style={{ fontSize: '0.72rem', padding: '0.1rem 0.45rem' }}>
                      {run.phase === 'DONE' ? '100%' : run.phase === 'EDIT_REVIEW' ? '85%' : run.phase === 'GATE' ? '75%' : run.phase === 'WRITE' ? '52%' : run.phase === 'STUDY' ? '22%' : run.phase === 'READY' ? '10%' : '5%'}
                    </span>
                    {run.styledCount > 0 && (
                      <span class="chip teal" style={{ fontSize: '0.72rem', padding: '0.1rem 0.45rem' }}>
                        🎨 {run.styledCount} styled
                      </span>
                    )}
                    {run.hasPostmortem && <span class="chip teal">📝 đã tổng kết</span>}
                    <span>{new Date(run.updatedAt).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            </li>
          ))}
          {runs.length === 0 && <li class="muted">Chưa có writer post nào.</li>}
        </ul>
      </section>
    </div>
  );
}

function HookPanel({
  run,
  configurationDirty,
  onRun,
}: {
  run: WriterRunV2;
  configurationDirty: boolean;
  onRun: (next: WriterRunV2) => void;
}) {
  const questions = run.hookClarify?.questions ?? [];
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const saved = run.hookClarify?.answers ?? [];
    setAnswers(questions.map((_, i) => saved[i] ?? ''));
  }, [questions.join('\n')]);

  const draft = run.status === 'DRAFT';
  const generating = Boolean(run.generatingHook);
  const canClarify = draft && Boolean(run.requestedTitle?.trim()) && !configurationDirty && !generating && !busy;
  const canSuggest = draft && questions.length > 0 && answers.length === questions.length
    && answers.every((a) => a.trim()) && !generating && !busy && !configurationDirty;
  // Every reason `canSuggest` can be false, in the order the user hits them.
  const unanswered = questions.length > 0 && answers.filter((a) => a.trim()).length < questions.length;
  const suggestBlockedReason = !draft
    ? 'Chỉ gợi ý hook khi post còn ở DRAFT.'
    : configurationDirty
      ? 'Save configuration trước khi gợi ý hook.'
      : generating || busy
        ? null
        : unanswered
          ? `Trả lời cả ${questions.length} câu trên rồi mới gợi ý được (đang thiếu ${questions.length - answers.filter((a) => a.trim()).length}).`
          : null;
  const errorText = localError ?? (
    run.hookError ? `${run.hookError.code}: ${run.hookError.reason}` : null
  );

  const clarify = async () => {
    if (!canClarify) return;
    setLocalError(null);
    setBusy(true);
    try {
      onRun(await api.startHookClarify(run.id));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const suggest = async () => {
    if (!canSuggest) return;
    setLocalError(null);
    setBusy(true);
    try {
      onRun(await api.startHookSuggest(run.id, answers.map((a) => a.trim())));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (selectedId: string) => {
    if (!draft || generating || busy) return;
    setLocalError(null);
    setBusy(true);
    try {
      onRun(await api.selectWriterHook(run.id, selectedId));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="panel" style={{ marginTop: '1rem' }}>
      <h2>Hook mở bài</h2>
      <p class="muted" style={{ marginTop: '0.35rem' }}>
        Agent hỏi vài câu cho rõ title, rồi gợi ý 3–5 hook. Chọn một mới được Run.
      </p>

      {run.generatingHook && (
        <p style={{ marginTop: '0.5rem' }}>
          <span class="chip warn">
            {run.generatingHook.step === 'clarify' ? '⏳ Đang hỏi làm rõ title…' : '⏳ Đang gợi ý hook…'}
          </span>
        </p>
      )}
      {errorText && <p class="error" style={{ fontSize: '0.85rem' }}>{errorText}</p>}

      {run.selectedHook && (
        <div style={{ marginTop: '0.6rem' }}>
          <span class="chip ok">Đã chọn · {run.selectedHook.typeLabel}</span>
          <p style={{ marginTop: '0.4rem', fontSize: '0.95rem' }}>{run.selectedHook.text}</p>
        </div>
      )}

      {questions.length > 0 && draft && !run.hookCandidates && (
        <div class="stack" style={{ gap: '0.65rem', marginTop: '0.75rem' }}>
          {questions.map((q, i) => (
            <label class="field" key={`${i}-${q.slice(0, 24)}`}>
              <span>{q}</span>
              <textarea
                rows={2}
                value={answers[i] ?? ''}
                disabled={generating || busy}
                onInput={(e) => {
                  const value = (e.target as HTMLTextAreaElement).value;
                  setAnswers((prev) => {
                    const next = [...prev];
                    next[i] = value;
                    return next;
                  });
                }}
              />
            </label>
          ))}
          <button
            class="btn teal"
            type="button"
            disabled={!canSuggest}
            title={suggestBlockedReason ?? 'Gợi ý 3–5 hook từ thư viện hook đối thủ'}
            onClick={() => void suggest()}
          >
            {busy && run.generatingHook?.step === 'suggest' ? 'Đang gợi ý…' : 'Gợi ý hook'}
          </button>
          {/* A disabled button with no stated reason is a dead end, and this one
              sits on the only path into a run. The Run button already explains
              itself the same way. */}
          {suggestBlockedReason && (
            <span class="muted" style={{ fontSize: '0.85rem' }}>{suggestBlockedReason}</span>
          )}
        </div>
      )}

      {(run.hookCandidates ?? []).length > 0 && (
        <ul class="list" style={{ marginTop: '0.75rem' }}>
          {(run.hookCandidates ?? []).map((c) => {
            const selected = run.selectedHook?.id === c.id;
            return (
              <li key={c.id}>
                <button
                  class={selected ? 'btn teal' : 'btn secondary'}
                  type="button"
                  disabled={!draft || generating || busy}
                  style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal' }}
                  onClick={() => void pick(c.id)}
                >
                  <strong>{c.typeLabel}</strong>
                  <div style={{ marginTop: '0.25rem', fontWeight: 400 }}>{c.text}</div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {draft && (
        <div class="row" style={{ gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
          <button class="btn secondary" type="button" disabled={!canClarify} onClick={() => void clarify()}>
            {questions.length > 0 ? 'Hỏi lại title' : 'Làm rõ title'}
          </button>
          {configurationDirty && (
            <span class="muted" style={{ fontSize: '0.85rem' }}>Save configuration trước khi hỏi hook.</span>
          )}
          {!run.requestedTitle?.trim() && (
            <span class="muted" style={{ fontSize: '0.85rem' }}>Cần Title đã Save.</span>
          )}
        </div>
      )}
    </section>
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
  const [packs, setPacks] = useState<WriterPackSummary[]>([]);
  const [channels, setChannels] = useState<ChannelProfile[]>([]);
  const [generalPacks, setGeneralPacks] = useState<GeneralPackSummary[]>([]);
  const [formulas, setFormulas] = useState<FormulaSummary[]>([]);
  const [title, setTitle] = useState('');
  const [channelId, setChannelId] = useState('');
  const [brief, setBrief] = useState('');
  const [audience, setAudience] = useState('');
  const [targetWords, setTargetWords] = useState('');
  const [packId, setPackId] = useState('');
  const [generalPack, setGeneralPack] = useState('');
  const [formulaId, setFormulaId] = useState('');
  const [agentId, setAgentId] = useState<string>('codex');
  const [editorAgentId, setEditorAgentId] = useState<string>('claude');
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [exploringSourcePack, setExploringSourcePack] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [runningRoom, setRunningRoom] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const [copiedScript, setCopiedScript] = useState(false);
  const [styles, setStyles] = useState<ChannelStyleSummary[]>([]);
  const [styleId, setStyleId] = useState('');
  // One-line gist of the picked style, read from its markdown so the dropdown
  // says something about the voice instead of only naming it.
  const [styleBlurb, setStyleBlurb] = useState<string | null>(null);
  const [restyling, setRestyling] = useState(false);
  // Deliberately NOT `setError`: that one blanks the whole run page, and a failed
  // restyle must not hide the article the user already has.
  const [restyleError, setRestyleError] = useState<string | null>(null);
  const [openStyledVersion, setOpenStyledVersion] = useState<number | null>(null);
  const [styledMarkdown, setStyledMarkdown] = useState<string | null>(null);
  const [loadingStyled, setLoadingStyled] = useState(false);
  const [copiedStyled, setCopiedStyled] = useState(false);
  const [startingPostmortem, setStartingPostmortem] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([api.listWriterPacks(), api.listGeneralPacks(), api.listFormulas(), api.listChannelProfiles()])
      .then(([packData, generalData, formulaData, channelData]) => {
        if (!alive) return;
        setPacks(packData.packs);
        setGeneralPacks(generalData.packs);
        setFormulas(formulaData.formulas);
        setChannels(channelData.channels);
      })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .listChannelStyles()
      .then((d) => {
        if (!alive) return;
        setStyles(d.styles);
        setStyleId((prev) => prev || d.styles[0]?.path || '');
      })
      .catch(() => { if (alive) setStyles([]); });
    return () => { alive = false; };
  }, []);

  // Best-effort only: a failed blurb fetch must never surface as a restyle error.
  useEffect(() => {
    if (!styleId) {
      setStyleBlurb(null);
      return;
    }
    let alive = true;
    setStyleBlurb(null);
    void api
      .getChannelStyle(styleId)
      .then((d) => { if (alive) setStyleBlurb(styleBlurbOf(d.markdown)); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [styleId]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const data = await api.getWriterPostV2(id);
        if (!alive) return;
        setRun(data);
        // A restyle runs while the run stays DONE, so status alone can't drive the poll.
        if (data.status === 'RUNNING' || data.restyling || data.generatingHook || data.reviewingPostmortem) {
          timer = window.setTimeout(() => void tick(), 2000);
        }
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

  useEffect(() => {
    if (!run) return;
    setTitle(run.requestedTitle ?? '');
    setChannelId(run.channelId ?? '');
    setBrief(run.brief);
    setAudience(run.audience ?? '');
    setTargetWords(run.targetWords === undefined ? '' : String(run.targetWords));
    setPackId(run.packId);
    setGeneralPack(run.generalPackPath);
    setFormulaId(run.formulaId);
    setAgentId(run.agentId);
    setEditorAgentId(run.editorAgentId);
    const profile = channels.find((channel) => channel.id === run.channelId);
    if (profile?.defaultStyle) setStyleId(profile.defaultStyle);
  }, [run?.id, channels]);

  if (!run && error) {
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
  const configurationDirty = run.status === 'DRAFT' && (
    channelId !== (run.channelId ?? '')
    || title.trim() !== (run.requestedTitle ?? '')
    || brief.trim() !== run.brief
    || audience.trim() !== (run.audience ?? '')
    || targetWords.trim() !== (run.targetWords === undefined ? '' : String(run.targetWords))
    || packId !== run.packId
    || generalPack !== run.generalPackPath
    || formulaId !== run.formulaId
    || agentId !== run.agentId
    || editorAgentId !== run.editorAgentId
  );
  const canRunRoom = run.status === 'DRAFT'
    && run.phase === 'READY'
    && !configurationDirty
    && Boolean(run.selectedHook)
    && !run.generatingHook;
  // The server either commits a valid orphan STUDY artifact and advances to
  // WRITE, or explicitly retries STUDY when the interrupted turn wrote none.
  // Boot recovery may also leave study set + FAILED with no draft — Continue
  // then dispatches WRITE on the same post.
  const canRecoverStudy = !run.study && (
    (run.status === 'RUNNING' && run.phase === 'STUDY')
    || (run.status === 'FAILED' && run.phase === 'FAILED')
  );
  const canContinueAfterStudy = Boolean(run.study) && !run.draft && (
    (run.status === 'FAILED' && run.phase === 'FAILED')
    || (run.status === 'RUNNING' && run.phase === 'WRITE')
  );
  const canContinueWrite = canRecoverStudy
    || canContinueAfterStudy
    || (run.status === 'FAILED' && run.phase === 'FAILED' && Boolean(run.study) && !run.draft);
  // Restyle rewrites a finished article; there is nothing to rewrite before DONE.
  const canRestyle = run.status === 'DONE' && Boolean(run.finalScript);
  const displayedRestyleError = restyleError ?? (
    !restyling && run.restyleError
      ? `${run.restyleError.code}: ${run.restyleError.reason}`
      : null
  );
  const styledVersions = [...(run.styled ?? [])].sort((a, b) => b.version - a.version);

  const chooseChannel = (nextId: string) => {
    setChannelId(nextId);
    const profile = channels.find((channel) => channel.id === nextId);
    if (!profile) return;
    if (profile.audience) setAudience(profile.audience);
    if (profile.defaultGeneralPack) setGeneralPack(profile.defaultGeneralPack);
    if (profile.defaultFormulaId) setFormulaId(profile.defaultFormulaId);
    if (profile.defaultStyle) setStyleId(profile.defaultStyle);
  };

  const rerun = async () => {
    if (!canRerun || rerunning) return;
    setError(null);
    setRerunning(true);
    try {
      const next = await api.startWriterRunV2({
        channelId: run.channelId ?? '',
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

  const runRoom = async () => {
    if (!canRunRoom || runningRoom) return;
    setError(null);
    setRunningRoom(true);
    try {
      const next = await api.runWriterPostV2(run.id);
      setRun(next);
      setPollKey((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningRoom(false);
    }
  };

  const saveConfiguration = async () => {
    if (run.status !== 'DRAFT' || saving) return;
    setError(null);
    setSaving(true);
    try {
      const next = await api.updateWriterPostV2(run.id, {
        channelId,
        brief,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        ...(targetWords.trim() ? { targetWords: Number(targetWords) } : {}),
        packId,
        generalPack,
        formulaId,
        agentId,
        editorAgentId,
      });
      setRun(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const createEditableCopy = async () => {
    if (run.status === 'DRAFT' || duplicating) return;
    setError(null);
    setDuplicating(true);
    let createdId: string | null = null;
    try {
      const post = await api.createWriterPostV2();
      createdId = post.id;
      const copy = await api.updateWriterPostV2(post.id, {
        channelId: run.channelId ?? '',
        brief: run.brief,
        title: run.requestedTitle || run.brief || 'Bản nháp Writer v2',
        ...(run.audience ? { audience: run.audience } : {}),
        ...(run.targetWords !== undefined ? { targetWords: run.targetWords } : {}),
        packId: run.packId,
        generalPack: run.generalPackPath,
        formulaId: run.formulaId,
        agentId: run.agentId,
        editorAgentId: run.editorAgentId,
      });
      location.hash = href({ name: 'writer-v2-run', id: copy.id });
    } catch (err) {
      if (createdId) await api.deleteWriterRunV2(createdId).catch(() => undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDuplicating(false);
    }
  };

  const downloadTextFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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

  const exportArticleTxt = () => {
    if (!script) return;
    const baseName = (run.requestedTitle || run.brief || 'writer-post').trim();
    const safeName = baseName.replace(/[^\w\s\u00C0-\u1EF9.-]/gi, '_').replace(/\s+/g, '-').slice(0, 80) || 'writer-post';
    downloadTextFile(script, `${safeName}.txt`);
  };

  const startPostmortem = async () => {
    if (run.status !== 'DONE' || startingPostmortem || run.postmortem || run.reviewingPostmortem) return;
    setError(null); setStartingPostmortem(true);
    try {
      const next = await api.startWriterPostmortem(run.id);
      setRun(next);
      setPollKey((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setStartingPostmortem(false); }
  };

  const restyle = async () => {
    if (!canRestyle || restyling || !styleId || run.restyling) return;
    setRestyleError(null);
    setRestyling(true);
    try {
      const next = await api.restyleWriterRunV2(run.id, styleId);
      setRun(next);
      if (!next.restyling && next.restyleError) {
        setRestyleError(`${next.restyleError.code}: ${next.restyleError.reason}`);
      }
      // The run stays DONE while restyling, so the poll must be restarted by hand.
      setPollKey((value) => value + 1);
    } catch (err) {
      setRestyleError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestyling(false);
    }
  };

  const openStyled = async (version: number) => {
    if (openStyledVersion === version) {
      setOpenStyledVersion(null);
      setStyledMarkdown(null);
      return;
    }
    setOpenStyledVersion(version);
    setStyledMarkdown(null);
    setCopiedStyled(false);
    setRestyleError(null);
    setLoadingStyled(true);
    try {
      const d = await api.getWriterRunV2Styled(run.id, version);
      setStyledMarkdown(d.markdown);
    } catch (err) {
      setRestyleError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingStyled(false);
    }
  };

  const copyStyled = async () => {
    if (!styledMarkdown) return;
    try {
      await navigator.clipboard.writeText(styledMarkdown);
      setCopiedStyled(true);
    } catch (err) {
      setRestyleError(`Không copy được bản styled: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const exportStyledTxt = (version: number, styleName: string) => {
    if (!styledMarkdown) return;
    const baseName = (run.requestedTitle || run.brief || 'writer-post').trim();
    const safeName = baseName.replace(/[^\w\s\u00C0-\u1EF9.-]/gi, '_').replace(/\s+/g, '-').slice(0, 60) || 'writer-post';
    const safeStyle = styleName.replace(/[^\w\s\u00C0-\u1EF9.-]/gi, '_').replace(/\s+/g, '-');
    downloadTextFile(styledMarkdown, `${safeName}_styled-v${version}-${safeStyle}.txt`);
  };

  return (
    <div>
      <div class="page-header">
        <div>
          <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <h1 class="page-title writer-v2-post-title" style={{ marginBottom: 0 }}>
              {run.requestedTitle || run.brief || 'Untitled writer post'}
            </h1>
            <span class={statusClass(run.status)}>{run.status}</span>
            <EntityId id={run.id} label="ID run" />
          </div>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            {PHASE_LABEL[run.phase] ?? run.phase} · writer: {run.agentId} · editor: {run.editorAgentId}
          </p>
          <WriterProgressBar run={run} />
        </div>
        <div class="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {run.status === 'DRAFT' && (
            <button
              class="btn teal"
              type="button"
              disabled={!canRunRoom || runningRoom || saving}
              title={
                !canRunRoom && run.status === 'DRAFT' && run.phase === 'READY' && !run.selectedHook
                  ? 'Chọn một hook trước khi Run'
                  : canRunRoom
                    ? 'Dispatch STUDY bằng đúng configuration đã Save'
                    : 'Save đủ configuration trước khi Run'
              }
              onClick={() => void runRoom()}
            >
              {runningRoom ? 'Đang đưa vào lane…' : '▶ Run Writer v2'}
            </button>
          )}
          {canRestyle && styles.length === 0 && (
            <span class="muted" style={{ fontSize: '0.85rem' }}>
              Chưa có style kênh — tạo một file <code>.md</code> trong{' '}
              <code>writer-room-data/channel-styles/</code>.
            </span>
          )}
          {canRestyle && styles.length > 0 && (
            <>
              <select
                class="inline-select"
                value={styleId}
                disabled={restyling || Boolean(run.restyling)}
                onChange={(e) => setStyleId((e.target as HTMLSelectElement).value)}
                title="Style giọng kênh dùng để viết lại"
              >
                {styles.map((s) => (
                  <option key={s.path} value={s.path}>
                    {s.title}{s.version ? ` · v${s.version}` : ''} · {s.wordCount} từ
                  </option>
                ))}
              </select>
              <a
                class="btn secondary"
                href={href({ name: 'channel-styles', path: styleId || undefined })}
                title="Đọc toàn văn style trước khi restyle"
              >
                📖 Đọc style
              </a>
              <button
                class="btn teal"
                type="button"
                disabled={restyling || Boolean(run.restyling) || !styleId}
                onClick={() => void restyle()}
              >
                {restyling || run.restyling ? 'Đang restyle…' : '🎨 Restyle'}
              </button>
              {styleBlurb && (
                <p class="muted" style={{ margin: 0, flexBasis: '100%', fontSize: '0.82rem' }}>
                  {styleBlurb}
                </p>
              )}
            </>
          )}
          {run.status === 'DONE' && (
            <button
              class="btn secondary"
              type="button"
              disabled={startingPostmortem || Boolean(run.reviewingPostmortem) || Boolean(run.postmortem)}
              onClick={() => void startPostmortem()}
            >
              {run.reviewingPostmortem || startingPostmortem
                ? 'Đang tổng kết…'
                : run.postmortem ? '✓ Đã tổng kết' : '📝 Tổng kết sau bài'}
            </button>
          )}
          {canContinueWrite && (
            <button
              class="btn teal"
              type="button"
              disabled={continuing || rerunning}
              title={
                canRecoverStudy
                  ? 'Cứu artifact STUDY dở hoặc chạy lại STUDY trên cùng post'
                  : 'Tiếp tục WRITE từ STUDY đã cứu / bản nháp dở sau khi daemon restart'
              }
              onClick={() => void continueWrite()}
            >
              {continuing
                ? 'Đang tiếp tục…'
                : canRecoverStudy
                  ? '↻ Cứu/tiếp tục STUDY'
                  : canContinueAfterStudy
                    ? '▶ Tiếp tục WRITE (sau khôi phục)'
                    : '▶ Tiếp tục WRITE'}
            </button>
          )}
          {canRerun && (
            <button class="btn teal" type="button" disabled={rerunning || continuing} onClick={() => void rerun()}>
              {rerunning ? 'Đang ReRun…' : '↻ ReRun bài mới'}
            </button>
          )}
          <a class="btn secondary" href={href({ name: 'writer-v2' })}>← Writer v2</a>
          {displayedRestyleError && (
            <p class="error" style={{ margin: 0, flexBasis: '100%', fontSize: '0.85rem' }}>{displayedRestyleError}</p>
          )}
        </div>
      </div>

      {error && <p class="error">{error}</p>}

      {run.errorReason && (
        <p class="error" style={{ whiteSpace: 'pre-wrap' }}>{run.errorCode}: {run.errorReason}</p>
      )}

      <section class="panel" style={{ marginTop: '1rem' }}>
          <h2>Post configuration</h2>
          <div class="stack" style={{ gap: '0.85rem', marginTop: '0.75rem' }}>
            <div class="field">
              <span>Hồ sơ kênh</span>
              <div class="field-action-group">
                <select
                  value={channelId}
                  disabled={run.status !== 'DRAFT'}
                  onChange={(e) => chooseChannel((e.target as HTMLSelectElement).value)}
                >
                  <option value="">Chọn kênh xuất bản…</option>
                  {channelId && !channels.some((channel) => channel.id === channelId) && (
                    <option value={channelId}>{channelId} (không còn hồ sơ)</option>
                  )}
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>{channel.displayName} · {channel.topic}</option>
                  ))}
                </select>
                <a class="btn secondary" href={href({ name: 'publishing-channels', id: channelId || undefined })}>
                  Quản lý kênh
                </a>
              </div>
              {channels.length === 0 && (
                <span class="muted small">Chưa có Hồ sơ kênh. Tạo một kênh trước khi Save configuration.</span>
              )}
            </div>
            <label class="field">
              <span>Title</span>
              <input
                value={title}
                disabled={run.status !== 'DRAFT'}
                onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
              />
            </label>
            <label class="field">
              <span>Brief</span>
              <textarea
                rows={3}
                value={brief}
                disabled={run.status !== 'DRAFT'}
                onInput={(e) => setBrief((e.target as HTMLTextAreaElement).value)}
              />
            </label>
            <label class="field">
              <span>Audience</span>
              <input
                value={audience}
                disabled={run.status !== 'DRAFT'}
                onInput={(e) => setAudience((e.target as HTMLInputElement).value)}
              />
            </label>
            <div class="form-grid-3">
              <div class="field">
                <span>Topic / Source Pack</span>
                <div class="field-action-group">
                  <select
                    value={packId}
                    disabled={run.status !== 'DRAFT'}
                    onChange={(e) => setPackId((e.target as HTMLSelectElement).value)}
                  >
                    <option value="">Chọn Source Pack…</option>
                    {packId && !packs.some((pack) => pack.id === packId) && (
                      <option value={packId}>{run.packTitle || packId}</option>
                    )}
                    {packs.map((pack) => (
                      <option key={pack.id} value={pack.id}>{pack.title} · {pack.videoCount} video</option>
                    ))}
                  </select>
                  {run.status === 'DRAFT' && (
                    <button class="btn secondary" type="button" onClick={() => setExploringSourcePack(true)}>
                      Explore
                    </button>
                  )}
                </div>
              </div>
              <label class="field">
                <span>General Pack</span>
                <select
                  value={generalPack}
                  disabled={run.status !== 'DRAFT'}
                  onChange={(e) => setGeneralPack((e.target as HTMLSelectElement).value)}
                >
                  <option value="">Chọn General Pack…</option>
                  {generalPack && !generalPacks.some((pack) => pack.path === generalPack) && (
                    <option value={generalPack}>{generalPack}</option>
                  )}
                  {generalPacks.map((pack) => (
                    <option key={pack.path} value={pack.path}>
                      {pack.title}{pack.version ? ` · v${pack.version}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label class="field">
                <span>Formula</span>
                <select
                  value={formulaId}
                  disabled={run.status !== 'DRAFT'}
                  onChange={(e) => setFormulaId((e.target as HTMLSelectElement).value)}
                >
                  <option value="">Chọn Formula…</option>
                  {formulaId && !formulas.some((formula) => formula.id === formulaId) && (
                    <option value={formulaId}>{formulaId} · v{run.formulaVersion}</option>
                  )}
                  {formulas.map((formula) => (
                    <option key={formula.id} value={formula.id}>{formula.label} · v{formula.version}</option>
                  ))}
                </select>
              </label>
            </div>
            <div class="form-grid-3">
              <label class="field">
                <span>Writer agent</span>
                <select
                  value={agentId}
                  disabled={run.status !== 'DRAFT'}
                  onChange={(e) => setAgentId((e.target as HTMLSelectElement).value)}
                >
                  {AGENTS.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
                </select>
              </label>
              <label class="field">
                <span>Editor agent</span>
                <select
                  value={editorAgentId}
                  disabled={run.status !== 'DRAFT'}
                  onChange={(e) => setEditorAgentId((e.target as HTMLSelectElement).value)}
                >
                  {AGENTS.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
                </select>
              </label>
              <label class="field">
                <span>Target words</span>
                <input
                  type="number"
                  min={200}
                  max={20000}
                  value={targetWords}
                  disabled={run.status !== 'DRAFT'}
                  onInput={(e) => setTargetWords((e.target as HTMLInputElement).value)}
                />
              </label>
            </div>
            {run.status === 'DRAFT' && agentId === editorAgentId && (
              <p class="muted" style={{ margin: 0 }}>Writer và editor đang dùng cùng một agent.</p>
            )}
            {run.status === 'DRAFT' ? (
              <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button class="btn secondary" type="button" disabled={saving} onClick={() => void saveConfiguration()}>
                  {saving ? 'Đang lưu…' : run.phase === 'CONFIGURING' ? 'Save configuration' : 'Update configuration'}
                </button>
                <span class={run.phase === 'READY' ? 'chip ok' : 'chip warn'}>
                  {configurationDirty
                    ? 'Có thay đổi chưa Save — Run bị khóa'
                    : run.phase === 'READY' ? 'READY — đã pin, chờ review' : 'CONFIGURING — Run bị khóa'}
                </span>
              </div>
            ) : (
              <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  class="btn secondary"
                  type="button"
                  disabled={duplicating}
                  onClick={() => void createEditableCopy()}
                >
                  {duplicating ? 'Đang tạo bản nháp…' : 'Tạo bản nháp để sửa'}
                </button>
                <span class="chip">Config của run này đã khóa</span>
              </div>
            )}
          </div>

          <h3 style={{ marginTop: '1rem' }}>Pinned configuration</h3>
          <div class="meta" style={{ alignItems: 'flex-start' }}>
            <span>Kênh: {run.channelId || '—'}{run.editorialHash ? ` · sổ tay ${run.editorialHash.slice(0, 12)}…` : ''}</span>
            <span>Source: {run.packId || '—'}{run.packHash ? ` · sha256 ${run.packHash}` : ''}</span>
            <span>General: {run.generalPackPath || '—'}{run.generalPackVersion ? ` · v${run.generalPackVersion}` : ''}{run.generalPackHash ? ` · sha256 ${run.generalPackHash}` : ''}</span>
            <span>Formula: {run.formulaId || '—'}{run.formulaVersion ? ` · v${run.formulaVersion}` : ''}{run.formulaHash ? ` · sha256 ${run.formulaHash}` : ''}</span>
            {run.procedureId && <span>Quy trình: {run.procedureId} · sha256 {run.procedureHash?.slice(0, 12)}…</span>}
          </div>
          <p class="muted" style={{ marginBottom: 0 }}>
            {run.status === 'DRAFT'
              ? <>Create và Save không chạy agent. Làm rõ title, chọn hook, rồi mới <strong>Run Writer v2</strong>.</>
              : <>Run đã bắt đầu nên config này là read-only. Tạo bản nháp mới nếu cần thay đổi mà không làm sai lịch sử run.</>}
          </p>
      </section>

      <HookPanel
        run={run}
        configurationDirty={configurationDirty}
        onRun={(next) => {
          setRun(next);
          setPollKey((value) => value + 1);
        }}
      />

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
            <div
              style={{
                position: 'absolute',
                top: '0.7rem',
                right: '0.7rem',
                display: 'flex',
                gap: '0.4rem',
                alignItems: 'center',
              }}
            >
              <button
                class="btn"
                type="button"
                onClick={() => void copyArticle()}
                style={{
                  background: 'rgba(255, 255, 255, 0.12)',
                  borderColor: 'rgba(255, 255, 255, 0.28)',
                  color: '#e8edf5',
                }}
              >
                {copiedScript ? '✓ Đã copy' : '⧉ Copy bài viết'}
              </button>
              <button
                class="btn"
                type="button"
                onClick={exportArticleTxt}
                style={{
                  background: 'rgba(255, 255, 255, 0.12)',
                  borderColor: 'rgba(255, 255, 255, 0.28)',
                  color: '#e8edf5',
                }}
                title="Tải bài viết về máy dạng file .txt"
              >
                ⬇ Export .txt
              </button>
            </div>
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

      {run.status === 'DONE' && (
        <section class="panel" style={{ marginTop: '1rem' }}>
          <h2>Tổng kết sau bài</h2>
          {run.reviewingPostmortem && <p><span class="chip warn">Agent biên tập đang rút 1–3 kinh nghiệm bền vững…</span></p>}
          {run.postmortemError && <p class="error">{run.postmortemError.code}: {run.postmortemError.reason}</p>}
          {!run.postmortem && !run.reviewingPostmortem && (
            <p class="muted">Bấm “Tổng kết sau bài” ở đầu trang. Kết quả chỉ vào hộp chờ, chưa tự sửa sổ tay.</p>
          )}
          {run.postmortem && (
            <>
              <p class="muted small">Do {run.postmortem.agentId} đề xuất · {new Date(run.postmortem.createdAt).toLocaleString()}</p>
              <div class="lesson-list">
                {run.postmortem.lessons.map((lesson, index) => (
                  <div class="lesson-card" key={index}>
                    <span class={`chip lesson-${lesson.kind.toLowerCase()}`}>
                      {lesson.kind === 'KEEP' ? 'Nên giữ' : lesson.kind === 'AVOID' ? 'Nên tránh' : 'Nên thử'}
                    </span>
                    <strong>{lesson.text}</strong>
                    <p class="muted small">{lesson.reason}</p>
                  </div>
                ))}
              </div>
              {run.channelId && (
                <a class="btn secondary" href={href({ name: 'publishing-channels', id: run.channelId })}>
                  Duyệt trong Kênh & kinh nghiệm →
                </a>
              )}
            </>
          )}
        </section>
      )}

      {canRestyle && (
        <section class="panel" style={{ marginTop: '1rem' }}>
          <h2>5. Bản styled ({styledVersions.length})</h2>
          {run.restyling && (
            <p style={{ marginTop: '0.5rem' }}>
              <span class="chip warn">
                ⏳ Đang restyle v{run.restyling.version} theo {run.restyling.styleId}…
              </span>
            </p>
          )}
          {run.restyleError && (
            <p class="error" style={{ fontSize: '0.85rem' }}>
              {run.restyleError.code}: {run.restyleError.reason}
            </p>
          )}
          {styledVersions.length === 0 && !run.restyling ? (
            <p class="muted">
              Chưa có bản nào. Chọn một style kênh ở trên rồi bấm <strong>🎨 Restyle</strong> — bài gốc
              không bị đụng, mỗi lần bấm ra một version mới để so giọng.
            </p>
          ) : (
            <ul class="list">
              {styledVersions.map((s) => (
                <li key={s.version}>
                  <button
                    class="btn secondary"
                    type="button"
                    style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => void openStyled(s.version)}
                  >
                    v{s.version} · {s.styleId} · {s.words} từ · {new Date(s.createdAt).toLocaleString()}
                  </button>
                  {openStyledVersion === s.version && (
                    <div style={{ position: 'relative', marginTop: '0.5rem' }}>
                      {loadingStyled ? (
                        <p class="muted">Đang tải…</p>
                      ) : styledMarkdown !== null && (
                        <>
                          <pre class="pre" style={{ margin: 0, paddingTop: '3.8rem' }}>{styledMarkdown}</pre>
                          <div
                            style={{
                              position: 'absolute',
                              top: '0.7rem',
                              right: '0.7rem',
                              display: 'flex',
                              gap: '0.4rem',
                              alignItems: 'center',
                            }}
                          >
                            <button
                              class="btn"
                              type="button"
                              onClick={() => void copyStyled()}
                              style={{
                                background: 'rgba(255, 255, 255, 0.12)',
                                borderColor: 'rgba(255, 255, 255, 0.28)',
                                color: '#e8edf5',
                              }}
                            >
                              {copiedStyled ? '✓ Đã copy' : '⧉ Copy bản styled'}
                            </button>
                            <button
                              class="btn"
                              type="button"
                              onClick={() => exportStyledTxt(s.version, s.styleId)}
                              style={{
                                background: 'rgba(255, 255, 255, 0.12)',
                                borderColor: 'rgba(255, 255, 255, 0.28)',
                                color: '#e8edf5',
                              }}
                              title="Tải bản styled về máy dạng file .txt"
                            >
                              ⬇ Export .txt
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
