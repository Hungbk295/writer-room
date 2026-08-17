import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  api,
  type SourcePackSession,
  type SourcePackSessionSummary,
  type SourcePackVideoPick,
  type WriterPack,
} from '../api.ts';
import { pct, useOperationPoll } from '../hooks.ts';

interface SourcePackExplorerProps {
  onClose: () => void;
  onPacked: (pack: WriterPack) => void;
}

function formatViews(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return value.toLocaleString();
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Minimal DNA-Spy-style research surface for factual Writer source packs.
 * Its contract is intentionally narrow: search → tick → Done → Pack.
 */
export function SourcePackExplorer({ onClose, onPacked }: SourcePackExplorerProps) {
  const [sessions, setSessions] = useState<SourcePackSessionSummary[]>([]);
  const [session, setSession] = useState<SourcePackSession | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SourcePackVideoPick[]>([]);
  const [searching, setSearching] = useState(false);
  const [done, setDone] = useState(false);
  const [buildOperationId, setBuildOperationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    const data = await api.listSourcePackSessions();
    setSessions(data.sessions);
    return data.sessions;
  }, []);

  const loadSession = useCallback(async (id: string) => {
    setError(null);
    const loaded = await api.getSourcePackSession(id);
    setSession(loaded);
    setDone(false);
  }, []);

  // Opening Explore is usable immediately: load the latest saved shortlist or
  // create the first one before the editor begins searching.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listed = await refreshSessions();
        const next = listed[0]
          ? await api.getSourcePackSession(listed[0].id)
          : await api.createSourcePackSession();
        if (cancelled) return;
        if (listed.length === 0) setSessions([{
          id: next.id,
          name: next.name,
          pickCount: 0,
          updatedAt: next.updatedAt,
        }]);
        setSession(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [refreshSessions]);

  const pickedIds = useMemo(() => new Set(session?.picks.map((pick) => pick.videoId) ?? []), [session]);
  const resultCount = results.filter((result) => pickedIds.has(result.videoId)).length;

  const save = async (next: SourcePackSession) => {
    setSession(next);
    try {
      const persisted = await api.saveSourcePackSession(next.id, {
        name: next.name,
        picks: next.picks,
      });
      setSession(persisted);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const createSession = async () => {
    setError(null);
    try {
      const created = await api.createSourcePackSession();
      await refreshSessions();
      setSession(created);
      setResults([]);
      setDone(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteCurrentSession = async () => {
    if (!session || !window.confirm(`Xoá shortlist “${session.name}”?`)) return;
    try {
      await api.deleteSourcePackSession(session.id);
      const listed = await refreshSessions();
      const next = listed[0]
        ? await api.getSourcePackSession(listed[0].id)
        : await api.createSourcePackSession();
      if (listed.length === 0) {
        setSessions([{
          id: next.id,
          name: next.name,
          pickCount: 0,
          updatedAt: next.updatedAt,
        }]);
      }
      setSession(next);
      setResults([]);
      setDone(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const search = async () => {
    const keyword = query.trim();
    if (!keyword || searching) return;
    setSearching(true);
    setError(null);
    try {
      const found = await api.searchSourcePackVideos(keyword);
      setResults(found.videos);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const togglePick = (pick: SourcePackVideoPick) => {
    if (!session || buildOperationId) return;
    const exists = pickedIds.has(pick.videoId);
    const picks = exists
      ? session.picks.filter((item) => item.videoId !== pick.videoId)
      : [...session.picks, pick];
    setDone(false);
    void save({ ...session, picks });
  };

  const toggleAllResults = () => {
    if (!session || results.length === 0 || buildOperationId) return;
    const allPicked = results.every((result) => pickedIds.has(result.videoId));
    const picks = allPicked
      ? session.picks.filter((pick) => !results.some((result) => result.videoId === pick.videoId))
      : [...session.picks, ...results.filter((result) => !pickedIds.has(result.videoId))];
    setDone(false);
    void save({ ...session, picks });
  };

  const removePick = (videoId: string) => {
    if (!session || buildOperationId) return;
    setDone(false);
    void save({ ...session, picks: session.picks.filter((pick) => pick.videoId !== videoId) });
  };

  const startPack = async () => {
    if (!session || !done || session.picks.length === 0 || buildOperationId) return;
    setError(null);
    try {
      const started = await api.buildSourcePack(session.id);
      setBuildOperationId(started.operationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const { operation: buildOperation, error: pollError } = useOperationPoll(buildOperationId, (operation) => {
    void (async () => {
      setBuildOperationId(null);
      if (operation.status !== 'completed' || !operation.resultRef) {
        setError(operation.errorMessage || 'Không thể đóng gói Source Pack');
        return;
      }
      try {
        const pack = await api.getWriterPack(operation.resultRef);
        onPacked(pack);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  const busy = searching || buildOperationId !== null;

  return (
    <div
      class="modal-backdrop source-pack-explorer-backdrop"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget && !buildOperationId) onClose(); }}
    >
      <section class="source-pack-explorer" role="dialog" aria-modal="true" aria-label="Khám phá Source Pack">
        <header class="source-pack-explorer-header">
          <div>
            <h2>Explore Source Pack</h2>
            <p>Chỉ tìm video, lấy transcript và đóng gói nguồn dữ kiện.</p>
          </div>
          <button class="icon-btn" type="button" onClick={onClose} disabled={Boolean(buildOperationId)} aria-label="Đóng">
            ✕
          </button>
        </header>

        {error && <div class="banner error">{error}</div>}
        {pollError && <div class="banner error">{pollError}</div>}

        <div class="source-pack-explorer-grid">
          <section class="source-pack-search-pane">
            <div class="source-pack-session-bar">
              <select
                value={session?.id ?? ''}
                onChange={(event) => void loadSession((event.target as HTMLSelectElement).value)}
                disabled={busy || sessions.length === 0}
                aria-label="Source Pack đã lưu"
              >
                {sessions.map((item) => (
                  <option key={item.id} value={item.id}>{item.name} ({item.pickCount})</option>
                ))}
              </select>
              <button class="btn secondary" type="button" onClick={() => void createSession()} disabled={busy}>＋ New</button>
              <button class="icon-btn danger" type="button" onClick={() => void deleteCurrentSession()} disabled={busy || !session} title="Xoá shortlist">
                🗑
              </button>
            </div>

            <div class="source-pack-search-bar">
              <input
                value={query}
                placeholder="Search keyword trên YouTube…"
                onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void search(); }}
                disabled={busy}
              />
              <button class="btn teal" type="button" onClick={() => void search()} disabled={busy || !query.trim()}>
                {searching ? 'Đang tìm…' : '🔍 Tìm'}
              </button>
            </div>

            {results.length === 0 ? (
              <p class="muted source-pack-empty">Nhập keyword rồi Tìm. Tick các video muốn lấy transcript vào Source Pack.</p>
            ) : (
              <>
                <div class="source-pack-batch-bar">
                  <button class="btn secondary" type="button" onClick={toggleAllResults} disabled={busy}>
                    {results.every((result) => pickedIds.has(result.videoId)) ? '✕ Bỏ tất cả' : '✓ Tick tất cả'}
                  </button>
                  <span class="muted">{resultCount}/{results.length} đã chọn</span>
                </div>
                <div class="source-pack-results">
                  {results.map((result) => {
                    const picked = pickedIds.has(result.videoId);
                    return (
                      <label class={`source-pack-result ${picked ? 'picked' : ''}`} key={result.videoId}>
                        <input type="checkbox" checked={picked} disabled={busy} onChange={() => togglePick(result)} />
                        {result.thumbnailUrl ? <img src={result.thumbnailUrl} alt="" loading="lazy" /> : <span class="source-pack-thumb-placeholder">▶</span>}
                        <span class="source-pack-result-copy">
                          <strong>{result.title}</strong>
                          <small>
                            {result.channelTitle || 'YouTube'} · {formatDuration(result.durationSec)} · 👁 {formatViews(result.viewCount)}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          <section class="source-pack-picks-pane">
            {!session ? (
              <p class="muted">Đang mở Source Pack…</p>
            ) : (
              <>
                <div class="source-pack-name-row">
                  <input
                    value={session.name}
                    onInput={(event) => setSession({ ...session, name: (event.target as HTMLInputElement).value })}
                    onBlur={() => void save(session)}
                    disabled={busy}
                    aria-label="Tên Source Pack"
                  />
                  {session.lastWriterPackId && <span class="chip ok">đã Pack</span>}
                </div>

                <div class="source-pack-picks-heading">
                  <h3>📋 Video đã chọn ({session.picks.length})</h3>
                  <span class="muted">được giữ lại khi tìm keyword khác</span>
                </div>
                {session.picks.length === 0 ? (
                  <p class="muted source-pack-empty">Tick video ở cột trái để gom vào Source Pack.</p>
                ) : (
                  <div class="source-pack-picks">
                    {session.picks.map((pick) => (
                      <article class="source-pack-pick" key={pick.videoId}>
                        <div>
                          <a href={pick.canonicalUrl} target="_blank" rel="noreferrer">{pick.title}</a>
                          <p>{pick.channelTitle || 'YouTube'} · 👁 {formatViews(pick.viewCount)}</p>
                        </div>
                        <button class="icon-btn danger" type="button" onClick={() => removePick(pick.videoId)} disabled={busy} aria-label={`Bỏ ${pick.title}`}>✕</button>
                      </article>
                    ))}
                  </div>
                )}

                {buildOperation && (
                  <div class="source-pack-progress">
                    <strong>{buildOperation.step}</strong>
                    <div class="progress"><span style={{ width: `${pct(buildOperation.progress, buildOperation.total || 1)}%` }} /></div>
                  </div>
                )}

                <footer class="source-pack-footer">
                  <label class="field-checkbox">
                    <input
                      type="checkbox"
                      checked={done}
                      disabled={busy || session.picks.length === 0}
                      onChange={(event) => setDone((event.target as HTMLInputElement).checked)}
                    />
                    Đã chọn xong video
                  </label>
                  <button class="btn teal" type="button" disabled={!done || session.picks.length === 0 || busy} onClick={() => void startPack()}>
                    {buildOperationId ? 'Đang lấy transcript…' : `📦 Pack ${session.picks.length} video`}
                  </button>
                </footer>
              </>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
