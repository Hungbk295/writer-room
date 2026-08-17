import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  api,
  type WriterPack,
  type WriterPackSummary,
  type WriterProfileSummary,
  type WriterRun,
  type WriterRunSummary,
} from '../api.ts';
import { href } from '../router.ts';
import { DeleteButton } from '../components/ui/DeleteButton.tsx';
import { EntityId } from '../components/ui/EntityId.tsx';

const AGENTS = ['codex', 'claude', 'grok', 'agy'] as const;

export function WriterPage() {
  const [packs, setPacks] = useState<WriterPackSummary[]>([]);
  const [profiles, setProfiles] = useState<WriterProfileSummary[]>([]);
  const [runs, setRuns] = useState<WriterRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [targetWords, setTargetWords] = useState('800');
  const [packId, setPackId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [agentId, setAgentId] = useState<string>('codex');
  const [starting, setStarting] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [rerunningRunId, setRerunningRunId] = useState<string | null>(null);

  // Load each list independently so one 404 (old daemon / missing route) does not
  // blank the other sections — that caused badge=2 while "Source Packs (0)".
  const refresh = useCallback(async () => {
    const errors: string[] = [];

    try {
      const packData = await api.listWriterPacks();
      setPacks(packData.packs);
      setPackId((prev) => prev || packData.packs[0]?.id || '');
    } catch (err) {
      setPacks([]);
      errors.push(`Packs: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const profileData = await api.listWriterProfiles();
      setProfiles(profileData.profiles);
      setProfileId((prev) => prev || profileData.profiles[0]?.id || '');
    } catch (err) {
      setProfiles([]);
      errors.push(`Profiles: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const runData = await api.listWriterRuns();
      setRuns(runData.runs);
    } catch {
      setRuns([]);
      // runs optional until FM2 routes are live
    }

    setError(errors.length > 0 ? errors.join(' · ') : null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const removePack = async (id: string) => {
    setError(null);
    await api.deleteWriterPack(id);
    setPacks((prev) => prev.filter((p) => p.id !== id));
  };

  const removeRun = async (id: string) => {
    setError(null);
    await api.deleteWriterRun(id);
    setRuns((prev) => prev.filter((r) => r.id !== id));
  };

  const seedProfile = async () => {
    setError(null);
    setSeeding(true);
    try {
      const p = await api.seedTrialProfile('Hieu Nguyen series (trial)');
      setProfiles((prev) => [
        {
          id: p.id,
          version: p.version,
          label: p.label,
          readiness: p.readiness,
          guidelineCount: p.guidelines.length,
          createdAt: p.createdAt,
        },
        ...prev,
      ]);
      setProfileId(p.id);
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} — restart daemon nếu route seed-trial chưa có`
          : String(err),
      );
    } finally {
      setSeeding(false);
    }
  };

  const startRun = async () => {
    setError(null);
    setStarting(true);
    try {
      const wordsRaw = targetWords.trim();
      const words = wordsRaw ? Number(wordsRaw) : undefined;
      if (wordsRaw && (!Number.isFinite(words) || (words ?? 0) < 80)) {
        setError('Target length phải ≥ 80 từ (hoặc để trống)');
        return;
      }
      const run = await api.startWriterRun({
        brief,
        title: title.trim() || undefined,
        targetWords: words,
        packId,
        profileId,
        agentId,
      });
      location.hash = href({ name: 'writer-run', id: run.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  /** Retry keeps the failed run for diagnosis and starts a new, separately pinned run. */
  const rerun = async (failed: WriterRunSummary) => {
    if (failed.status !== 'FAILED' || rerunningRunId) return;
    setError(null);
    setRerunningRunId(failed.id);
    try {
      const source = await api.getWriterRun(failed.id);
      const next = await api.startWriterRun({
        brief: source.brief,
        ...(source.requestedTitle ? { title: source.requestedTitle } : {}),
        ...(source.targetWords !== undefined ? { targetWords: source.targetWords } : {}),
        packId: source.packId,
        profileId: source.profileId,
        agentId: source.agentId,
      });
      // Do not overwrite the failed record: its error remains available for
      // diagnosis while the retry is a new Writer article/run.
      location.hash = href({ name: 'writer-run', id: next.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunningRunId(null);
    }
  };

  return (
    <div>
      <h1 class="page-title">Writer</h1>
      <p class="page-lead">
        Pack + Profile → plan decisions → Taste RAG → draft tự nhiên → hậu kiểm theo điểm
        → chỉ sửa khi dưới ngưỡng. Không biến toàn bộ Profile thành checklist viết bài.
      </p>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <h2>Viết bài mới</h2>
        {profiles.length === 0 ? (
          <div>
            <p class="muted">
              Chưa có Writer-ready Profile. Studio migrate (đầy đủ) hoặc seed profile thử
              để chạy thin slice ngay.
            </p>
            <button
              class="btn teal"
              type="button"
              disabled={seeding}
              onClick={() => void seedProfile()}
            >
              {seeding ? 'Đang tạo…' : 'Tạo profile thử (TRIAL)'}
            </button>
          </div>
        ) : packs.length === 0 ? (
          <p class="muted">
            Chưa có Source Pack. Mở Spy run → tick video có transcript → <strong>Gửi Writer</strong>.
            {error && ' Nếu badge Writer &gt; 0 mà list trống: restart daemon rồi F5.'}
          </p>
        ) : (
          <div class="stack" style={{ gap: '0.75rem' }}>
            <label class="field">
              <span>Tiêu đề</span>
              <input
                type="text"
                value={title}
                onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
                placeholder="Tiêu đề bài / working title…"
              />
            </label>
            <label class="field">
              <span>Brief</span>
              <textarea
                rows={3}
                value={brief}
                onInput={(e) => setBrief((e.target as HTMLTextAreaElement).value)}
                placeholder="Bài này nói gì, cho ai, góc nào…"
              />
            </label>
            <label class="field">
              <span>Độ dài mục tiêu (số từ)</span>
              <input
                type="number"
                min={80}
                max={20000}
                step={50}
                value={targetWords}
                onInput={(e) => setTargetWords((e.target as HTMLInputElement).value)}
                placeholder="vd. 800"
              />
              <span class="muted" style={{ fontSize: '0.85rem' }}>
                Agent nhắm ~số này (±20%). Để trống = chỉ yêu cầu tối thiểu ~80 từ.
              </span>
            </label>
            <label class="field">
              <span>Source Pack</span>
              <select value={packId} onChange={(e) => setPackId((e.target as HTMLSelectElement).value)}>
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || p.channelTitle} ({p.wordCount} từ)
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              <span>Profile (series)</span>
              <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  style={{ flex: '1 1 18rem' }}
                  value={profileId}
                  onChange={(e) => setProfileId((e.target as HTMLSelectElement).value)}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} · v{p.version} · {p.readiness} · {p.guidelineCount} guidelines
                    </option>
                  ))}
                </select>
                {profileId && <EntityId id={profileId} label="Profile ID" />}
                {profileId && (
                  <a class="btn secondary" href={href({ name: 'studio-profile', id: profileId })}>
                    Xem trong Studio
                  </a>
                )}
              </div>
            </label>
            <label class="field">
              <span>Agent</span>
              <select value={agentId} onChange={(e) => setAgentId((e.target as HTMLSelectElement).value)}>
                {AGENTS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </label>
            <button
              class="btn teal"
              type="button"
              disabled={starting || !brief.trim() || !packId || !profileId}
              onClick={() => void startRun()}
            >
              {starting ? 'Đang dispatch…' : 'Bắt đầu viết'}
            </button>
          </div>
        )}
      </section>

      <section class="panel">
        <h2>Runs ({runs.length})</h2>
        {runs.length === 0 ? (
          <p class="muted">Chưa có run.</p>
        ) : (
          <ul class="list">
            {runs.map((run) => (
              <li key={run.id} class="pack-row">
                <div>
                  <a href={href({ name: 'writer-run', id: run.id })}>
                    <strong>
                      {run.requestedTitle
                        || run.brief.slice(0, 80)
                        || run.id.slice(0, 8)}
                    </strong>
                  </a>
                  <div class="meta">
                    <span class="chip">{run.status}</span>
                    {run.targetWords != null && <span>~{run.targetWords} từ</span>}
                    <a href={href({ name: 'studio-profile', id: run.profileId })}>{run.profileLabel}</a>
                    <span>{run.packTitle}</span>
                    <span>{run.agentId}</span>
                    <span>{run.editCount} edits</span>
                    <span>{new Date(run.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <div class="row pack-row-actions" style={{ gap: '0.5rem' }}>
                  <a class="btn secondary" href={href({ name: 'writer-run', id: run.id })}>
                    Mở
                  </a>
                  {run.status === 'FAILED' && (
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
                    title={run.requestedTitle || run.brief || run.id}
                    onDelete={() => removeRun(run.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="panel">
        <h2>Source Packs ({packs.length})</h2>
        {packs.length === 0 ? (
          <div class="empty-state">
            <p class="muted">
              Chưa có pack. Mở Spy → <strong>Gửi Writer</strong>.
            </p>
            <a class="btn teal" href={href({ name: 'spy' })}>Đến Spy</a>
          </div>
        ) : (
          <ul class="list">
            {packs.map((pack) => (
              <li key={pack.id} class="pack-row">
                <div>
                  <a href={href({ name: 'writer-pack', id: pack.id })}>
                    <strong>{pack.title || pack.channelTitle || 'Source Pack'}</strong>
                  </a>
                  <div class="meta">
                    <span>{pack.wordCount.toLocaleString()} từ</span>
                    <span>{pack.videoCount} video</span>
                    <span>{new Date(pack.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <div class="row pack-row-actions" style={{ gap: '0.5rem' }}>
                  <a class="btn secondary" href={href({ name: 'writer-pack', id: pack.id })}>
                    Xem
                  </a>
                  <DeleteButton
                    title={pack.title || pack.channelTitle || 'pack'}
                    onDelete={() => removePack(pack.id)}
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

export function WriterPackPage({ id }: { id: string }) {
  const [pack, setPack] = useState<WriterPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  useEffect(() => {
    void api.getWriterPack(id)
      .then(setPack)
      .catch((err) => setError(err.message));
  }, [id]);

  const copy = async () => {
    if (!pack) return;
    await navigator.clipboard.writeText(pack.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    if (!pack) return;
    const blob = new Blob([pack.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pack.title || 'source-pack'}.md`.replace(/[^\w.-]+/g, '-');
    a.click();
    URL.revokeObjectURL(url);
  };

  const startRename = () => {
    if (!pack) return;
    setRenameDraft(pack.title || pack.channelTitle || '');
    setRenaming(true);
  };

  const submitRename = async (e: Event) => {
    e.preventDefault();
    if (!pack || !renameDraft.trim() || renameBusy) return;
    setRenameBusy(true);
    setError(null);
    try {
      const updated = await api.renameWriterPack(pack.id, renameDraft.trim());
      setPack(updated);
      setRenaming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenameBusy(false);
    }
  };

  if (error && !pack) {
    return (
      <div>
        <p class="error">{error}</p>
        <a class="btn secondary" href={href({ name: 'writer' })}>← Writer</a>
      </div>
    );
  }

  if (!pack) {
    return <p class="muted">Đang tải…</p>;
  }

  const displayName = pack.title || pack.channelTitle || 'Source Pack';

  return (
    <div>
      <div class="page-header">
        <div>
          <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {renaming ? (
              <form
                class="row"
                style={{ gap: '0.4rem', alignItems: 'center', flex: 1 }}
                onSubmit={submitRename}
              >
                <input
                  style={{ flex: 1, minWidth: '12rem' }}
                  value={renameDraft}
                  onInput={(e) => setRenameDraft((e.target as HTMLInputElement).value)}
                  autofocus
                />
                <button class="btn" type="submit" disabled={renameBusy || !renameDraft.trim()}>
                  {renameBusy ? 'Đang lưu…' : 'Lưu'}
                </button>
                <button
                  class="btn secondary"
                  type="button"
                  disabled={renameBusy}
                  onClick={() => setRenaming(false)}
                >
                  Huỷ
                </button>
              </form>
            ) : (
              <h1 class="page-title" style={{ marginBottom: 0 }}>{displayName}</h1>
            )}
          </div>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            {pack.channelTitle && `${pack.channelTitle} · `}
            {pack.wordCount.toLocaleString()} từ · {pack.videoIds.length} video
          </p>
        </div>
        <div class="row" style={{ gap: '0.5rem' }}>
          {!renaming && (
            <button class="btn secondary" type="button" onClick={startRename}>
              Đổi tên
            </button>
          )}
          <a class="btn secondary" href={href({ name: 'writer' })}>← Writer</a>
        </div>
      </div>

      {error && <p class="error">{error}</p>}

      <div class="row" style={{ margin: '1rem 0' }}>
        <button class="btn teal" type="button" onClick={() => void copy()}>
          {copied ? 'Đã copy' : 'Copy markdown'}
        </button>
        <button class="btn secondary" type="button" onClick={download}>
          Tải .md
        </button>
        {pack.spyRunId && (
          <a class="btn secondary" href={href({ name: 'spy-run', id: pack.spyRunId })}>
            Mở Spy run gốc
          </a>
        )}
      </div>

      {pack.warnings.length > 0 && (
        <p class="muted">Cảnh báo: {pack.warnings.join(' · ')}</p>
      )}

      <section class="panel">
        <pre class="pre">{pack.markdown}</pre>
      </section>
    </div>
  );
}


export function WriterRunPage({ id }: { id: string }) {
  const [run, setRun] = useState<WriterRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);

  const load = useCallback(async () => {
    const r = await api.getWriterRun(id);
    setRun(r);
  }, [id]);

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, [load]);

  // Poll while agent is writing
  useEffect(() => {
    if (!run || run.status !== 'RUNNING') return;
    const t = setInterval(() => {
      void load().catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [run?.status, load]);

  if (error && !run) {
    return (
      <div>
        <p class="error">{error}</p>
        <a class="btn secondary" href={href({ name: 'writer' })}>← Writer</a>
      </div>
    );
  }

  if (!run) {
    return <p class="muted">Đang tải…</p>;
  }

  const decisions = run.editorialDecisions ?? [];
  const videoPlan = run.videoPlan ?? null;
  const taste = run.tastePrecedents ?? [];
  const tasteWarnings = run.tasteRagWarnings ?? [];
  const qualityReviews = run.qualityReviews ?? [];
  const latestQualityReview = qualityReviews.at(-1);
  const phaseLabel =
    run.phase === 'PLANNING'
      ? 'đang plan decisions…'
      : run.phase === 'RETRIEVING'
        ? 'đang retrieve Taste…'
        : run.phase === 'DRAFTING'
          ? 'đang viết draft…'
          : run.phase === 'REVIEWING'
            ? 'đang hậu kiểm chất lượng…'
            : run.phase === 'REFINING'
              ? 'đang sửa có mục tiêu…'
              : run.phase === 'DONE'
                ? 'xong'
                : run.phase === 'FAILED'
                  ? 'lỗi'
                  : run.status === 'RUNNING'
                    ? 'đang chạy…'
                    : '';

  const rerun = async () => {
    if (run.status !== 'FAILED' || rerunning) return;
    setError(null);
    setRerunning(true);
    try {
      const next = await api.startWriterRun({
        brief: run.brief,
        ...(run.requestedTitle ? { title: run.requestedTitle } : {}),
        ...(run.targetWords !== undefined ? { targetWords: run.targetWords } : {}),
        packId: run.packId,
        profileId: run.profileId,
        agentId: run.agentId,
      });
      location.hash = href({ name: 'writer-run', id: next.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunning(false);
    }
  };

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Writer run</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            <span class="chip">{run.status}</span>
            {run.phase && (
              <>
                {' · '}
                <span class="chip">{run.phase}</span>
              </>
            )}
            {' · '}
            <a href={href({ name: 'studio-profile', id: run.profileId })}>
              {run.profileLabel} v{run.profileVersion}
            </a>
            {' · '}
            {run.packTitle}
            {' · '}
            {run.agentId}
          </p>
        </div>
        <div class="row" style={{ gap: '0.5rem' }}>
          {run.status === 'FAILED' && (
            <button class="btn teal" type="button" disabled={rerunning} onClick={() => void rerun()}>
              {rerunning ? 'Đang ReRun…' : '↻ ReRun bài mới'}
            </button>
          )}
          <a class="btn secondary" href={href({ name: 'writer' })}>← Writer</a>
        </div>
      </div>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <h2>Brief &amp; mục tiêu</h2>
        {run.requestedTitle && (
          <p>
            <strong>Tiêu đề:</strong> {run.requestedTitle}
          </p>
        )}
        <p>{run.brief}</p>
        <p class="meta">
          {run.targetWords != null && (
            <>
              target ~{run.targetWords} từ
              {' · '}
            </>
          )}
          profile pin <code>{run.profileHash.slice(0, 12)}…</code>
          {' · '}
          <EntityId id={run.profileId} label="Profile ID" />
          {' · '}
          pack <a href={href({ name: 'writer-pack', id: run.packId })}>{run.packId.slice(0, 8)}</a>
          {' · '}
          {decisions.length} decision{decisions.length === 1 ? '' : 's'}
          {' · '}
          {taste.length} Taste precedent{taste.length === 1 ? '' : 's'}
        </p>
        {run.errorCode && (
          <p class="error">
            error: {run.errorCode}
            {run.errorReason ? ` — ${run.errorReason}` : ''}
          </p>
        )}
      </section>

      {videoPlan && (
        <section class="panel">
          <h2>Video plan</h2>
          <p class="muted" style={{ marginTop: 0 }}>
            Hợp đồng nén ý trước khi viết — định hướng trí nhớ và tiến trình, không phải dàn bài bắt buộc.
          </p>
          <p>
            <strong>Ý người xem cần nhớ:</strong> {videoPlan.coreInsight}
          </p>
          <p>
            <strong>Điểm neo · {videoPlan.memoryAnchor.kind}:</strong>{' '}
            {videoPlan.memoryAnchor.value}
          </p>
          <h3>Tiến trình thông tin</h3>
          <ol class="list">
            {videoPlan.progression.map((beat, index) => (
              <li key={`${index}-${beat.beat}`}>
                <strong>{beat.beat}</strong>
                <p style={{ margin: '0.25rem 0' }}>
                  Mới: {beat.newInformation}
                </p>
                <p class="muted" style={{ margin: '0.25rem 0' }}>
                  Chuyển biến: {beat.characterOrArgumentChange}
                  {' · '}
                  Hình: {beat.visualAnchor}
                </p>
              </li>
            ))}
          </ol>
          <h3>Payoff</h3>
          <p style={{ marginBottom: '0.25rem' }}>
            <strong>Trả lời phần mở:</strong> {videoPlan.endingPayoff.resolvesOpening}
          </p>
          <p style={{ marginTop: 0 }}>
            <strong>Người xem làm được:</strong> {videoPlan.endingPayoff.audienceCanDo}
          </p>
          {videoPlan.cutList.length > 0 && (
            <p class="muted">
              <strong>Chủ động bỏ:</strong> {videoPlan.cutList.join(' · ')}
            </p>
          )}
        </section>
      )}

      {decisions.length > 0 && (
        <section class="panel">
          <h2>Editorial decisions → Taste ({decisions.length})</h2>
          <p class="muted" style={{ marginTop: 0 }}>
            LLM plan quyết định trước; code search QMD theo Situation Query của từng decision
            (không search theo title thuần).
          </p>
          <ul class="list">
            {decisions.map((d) => (
              <li key={d.id}>
                <strong>{d.decisionType}</strong>
                <p style={{ margin: '0.25rem 0' }}>{d.situation}</p>
                <div class="meta">
                  {d.geometryTags?.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                  {d.audience && <span>audience: {d.audience}</span>}
                </div>
                {d.query && (
                  <p class="muted" style={{ fontSize: '0.85rem', marginTop: '0.35rem' }}>
                    <code>lex:</code> {d.query.lex.slice(0, 120)}
                    {d.query.lex.length > 120 ? '…' : ''}
                  </p>
                )}
                {d.precedents.length > 0 ? (
                  <ul class="list" style={{ marginTop: '0.4rem' }}>
                    {d.precedents.map((p) => (
                      <li key={`${d.id}-${p.path}`}>
                        <span class="muted">precedent · </span>
                        {p.title}
                        <div class="meta">
                          <span>{p.source}</span>
                          <span>score {Math.round(p.score * 100)}%</span>
                          <span class="mono-small">{p.path}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p class="muted">Chưa có precedent (retrieve miss).</p>
                )}
              </li>
            ))}
          </ul>
          {tasteWarnings.length > 0 && (
            <p class="muted">Cảnh báo RAG: {tasteWarnings.join(' · ')}</p>
          )}
        </section>
      )}

      {run.status === 'RUNNING' && (
        <p class="muted">{phaseLabel || 'Agent đang chạy…'} (poll 2s).</p>
      )}

      {latestQualityReview && (
        <section class="panel">
          <h2>
            Hậu kiểm: {latestQualityReview.score}% / ngưỡng {latestQualityReview.threshold}%
          </h2>
          <p class={latestQualityReview.passed ? 'meta' : 'error'}>
            {latestQualityReview.passed
              ? `Đạt sau lượt ${latestQualityReview.round}`
              : `Chưa đạt sau lượt ${latestQualityReview.round}`}
          </p>
          {(latestQualityReview.hardGateViolations?.length ?? 0) > 0 && (
            <p class="error">
              Điều kiện chặn: {latestQualityReview.hardGateViolations!.join(', ')}. Điểm phong
              cách không thể bù vi phạm này.
            </p>
          )}
          {latestQualityReview.summary && <p>{latestQualityReview.summary}</p>}
          <p class="muted">
            Guideline không phù hợp được loại khỏi mẫu số. Một checkpoint riêng không tự động
            làm bài trượt; anti-pattern rõ ràng bị trừ điểm.
          </p>
          <ul class="list">
            {latestQualityReview.checkpoints
              .filter((checkpoint) => checkpoint.status === 'MISS' || checkpoint.status === 'PARTIAL')
              .map((checkpoint) => (
                <li key={`${latestQualityReview.round}-${checkpoint.refId}`}>
                  <strong>{checkpoint.status}</strong> · <code>{checkpoint.refId}</code>
                  <p style={{ margin: '0.25rem 0' }}>{checkpoint.note}</p>
                </li>
              ))}
            {latestQualityReview.antiPatterns
              .filter((antiPattern) => antiPattern.violated)
              .map((antiPattern) => (
                <li key={`${latestQualityReview.round}-${antiPattern.refId}`}>
                  <strong>ANTI</strong> · <code>{antiPattern.refId}</code>
                  <p style={{ margin: '0.25rem 0' }}>{antiPattern.note}</p>
                </li>
              ))}
          </ul>
        </section>
      )}

      {(run.currentTitle || run.draft) && (
        <section class="panel">
          <h2>{run.currentTitle || run.draft?.title}</h2>
          <pre class="pre" style={{ whiteSpace: 'pre-wrap' }}>
            {run.currentScript || run.draft?.script}
          </pre>
        </section>
      )}
    </div>
  );
}
