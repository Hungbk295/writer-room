import { useEffect, useState } from 'preact/hooks';
import { api, type SpyRunSummary, type SpyVideoRow } from '../api.ts';
import { href } from '../router.ts';
import { pct, useOperationPoll } from '../hooks.ts';
import { CustomSelect, Field, Input } from '../components/ui/Forms.tsx';
import { DeleteButton } from '../components/ui/DeleteButton.tsx';

type SpyMode = 'video' | 'channel';

function thumbSrc(video: SpyVideoRow): string {
  return video.thumbnailUrl || `https://i.ytimg.com/vi/${video.sourceVideoId}/hqdefault.jpg`;
}

/** Client-side detect — khớp packages/spy evidence/youtube-url.ts */
function isYoutubeVideoUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
      return /^[A-Za-z0-9_-]{11}$/.test(id);
    }
    if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') {
      return false;
    }
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v') ?? '';
      return /^[A-Za-z0-9_-]{11}$/.test(id);
    }
    const match = /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname);
    return Boolean(match && /^[A-Za-z0-9_-]{11}$/.test(match[1]!));
  } catch {
    return false;
  }
}

export function SpyPage() {
  const [mode, setMode] = useState<SpyMode>('video');
  const [url, setUrl] = useState('');
  const [depth, setDepth] = useState<'metadata' | 'transcript'>('transcript');
  const [topN, setTopN] = useState(5);
  const [selectionMode, setSelectionMode] = useState<'popular' | 'latest'>('popular');
  const [scanLimit, setScanLimit] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [spyRunId, setSpyRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<SpyRunSummary[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runVideos, setRunVideos] = useState<Record<string, SpyVideoRow[]>>({});
  const [expandingRunId, setExpandingRunId] = useState<string | null>(null);

  const refresh = async () => {
    const data = await api.listSpyRuns();
    setRuns(data.runs);
  };

  useEffect(() => {
    void refresh().catch((err) => setError(err.message));
  }, []);

  const remove = async (id: string) => {
    setError(null);
    await api.deleteSpyRun(id);
    setRuns((prev) => prev.filter((r) => r.id !== id));
    setExpandedRunId((current) => current === id ? null : current);
    setRunVideos((current) => {
      const { [id]: _removed, ...remaining } = current;
      return remaining;
    });
  };

  const toggleChannelVideos = async (run: SpyRunSummary) => {
    if (expandedRunId === run.id) {
      setExpandedRunId(null);
      return;
    }
    setExpandedRunId(run.id);
    if (runVideos[run.id]) return;
    setExpandingRunId(run.id);
    try {
      const result = await api.getSpyRun(run.id);
      setRunVideos((current) => ({ ...current, [run.id]: result.videos }));
    } catch (err) {
      setExpandedRunId(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExpandingRunId(null);
    }
  };

  // Tự chuyển tab khi user dán URL video / kênh.
  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (isYoutubeVideoUrl(trimmed) && mode !== 'video') setMode('video');
  }, [url]);

  const { operation } = useOperationPoll(operationId, async (op) => {
    setBusy(false);
    if (op.status === 'completed' && spyRunId) {
      location.hash = href({ name: 'spy-run', id: spyRunId }).slice(1);
    } else if (op.status === 'failed') {
      setError(op.errorMessage || (mode === 'video' ? 'Spy video thất bại' : 'Spy channel thất bại'));
    }
    await refresh().catch(() => undefined);
  });

  const start = async (event: Event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Nhận diện theo URL: video → videoSpy; còn lại (kênh/playlist) → channelSpy.
      // Không phụ thuộc tab — tab chỉ gợi ý form fields (Top N / Scan).
      const asVideo = isYoutubeVideoUrl(url);
      if (asVideo !== (mode === 'video')) setMode(asVideo ? 'video' : 'channel');
      const started = asVideo
        ? await api.startVideo({ url, depth })
        : await api.startChannel({ url, depth, topN, selectionMode, scanLimit });
      setOperationId(started.operationId);
      setSpyRunId(started.spyRunId);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Spy</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            Spy một video hoặc cả kênh → transcript → Source Pack.
          </p>
        </div>
      </div>

      <form class="panel stack" onSubmit={start} style={{ marginTop: '1.25rem' }}>
        <div class="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            class={mode === 'video' ? 'btn teal' : 'btn secondary'}
            onClick={() => setMode('video')}
            disabled={busy}
          >
            1 video
          </button>
          <button
            type="button"
            class={mode === 'channel' ? 'btn teal' : 'btn secondary'}
            onClick={() => setMode('channel')}
            disabled={busy}
          >
            Cả kênh
          </button>
        </div>

        <h2>{mode === 'video' ? 'Spy 1 video' : 'Spy channel'}</h2>

        <Field label={mode === 'video' ? 'URL video' : 'URL kênh / playlist'}>
          <Input
            required
            placeholder={
              mode === 'video'
                ? 'https://www.youtube.com/watch?v=… hoặc youtu.be/…'
                : 'https://www.youtube.com/@handle'
            }
            value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          />
        </Field>

        <div class="spy-form-row">
          <Field label="Depth">
            <CustomSelect<'metadata' | 'transcript'>
              value={depth}
              onChange={(val) => setDepth(val)}
              options={[
                {
                  value: 'transcript',
                  label: 'transcript',
                  description: 'nguyên liệu Source Pack',
                },
                {
                  value: 'metadata',
                  label: 'metadata',
                  description: 'nhanh',
                },
              ]}
            />
          </Field>
          {mode === 'channel' && (
            <>
              <Field label="Lấy video">
                <div class="row" style={{ gap: '0.5rem', flexWrap: 'nowrap' }}>
                  <CustomSelect<'popular' | 'latest'>
                    value={selectionMode}
                    onChange={setSelectionMode}
                    options={[
                      { value: 'popular', label: 'Popular', description: 'nổi bật nhất' },
                      { value: 'latest', label: 'Latest', description: 'mới đăng' },
                    ]}
                  />
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    aria-label="Số video lấy"
                    value={topN}
                    onInput={(e) => setTopN(Number((e.target as HTMLInputElement).value))}
                    style={{ width: '5rem', flex: '0 0 5rem' }}
                  />
                </div>
              </Field>
              {selectionMode === 'popular' && (
                <Field label="Scan">
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={scanLimit}
                    onInput={(e) => setScanLimit(Number((e.target as HTMLInputElement).value))}
                  />
                </Field>
              )}
            </>
          )}
        </div>

        <div class="row">
          <button class="btn teal" disabled={busy || !url.trim()}>
            {busy ? 'Đang spy…' : mode === 'video' ? 'Spy video này' : 'Bắt đầu Spy channel'}
          </button>
        </div>

        {operation && (operation.status === 'queued' || operation.status === 'running') && (
          <div class="stack">
            <div class="muted">{operation.step} · {operation.progress}/{operation.total || '?'}</div>
            <div class="progress"><span style={{ width: `${pct(operation.progress, operation.total || 1)}%` }} /></div>
          </div>
        )}
        {error && <p class="error">{error}</p>}
      </form>

      <section class="panel">
        <h2>Đã spy</h2>
        {runs.length === 0 ? (
          <p class="muted">Chưa có run nào.</p>
        ) : (
          <ul class="list">
            {runs.map((run) => {
              const isExpanded = expandedRunId === run.id;
              const videos = runVideos[run.id] ?? [];
              return (
                <li key={run.id} class="spy-run-card">
                  <div class="spy-run-card-summary">
                    {run.kind === 'video' && run.thumbnailUrl && (
                      <img class="spy-run-card-thumb" src={run.thumbnailUrl} alt="" loading="lazy" />
                    )}
                    <div class="spy-run-card-copy">
                      <a href={href({ name: 'spy-run', id: run.id })}>
                        <strong>{run.displayTitle || run.canonicalSource}</strong>
                      </a>
                      <div class="meta">
                        <span class="chip">{run.kind === 'video' ? 'video' : 'channel'}</span>
                        <span class="chip">{run.status}</span>
                        {typeof run.videoCount === 'number' && (
                          <span>{run.videoCount} video</span>
                        )}
                        <span>{new Date(run.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                    <div class="row spy-run-card-actions" style={{ gap: '0.5rem' }}>
                      {run.kind === 'channel' && (
                        <button
                          type="button"
                          class="btn secondary spy-run-expand"
                          onClick={() => void toggleChannelVideos(run)}
                          aria-label={isExpanded ? 'Thu gọn danh sách video' : 'Mở danh sách video'}
                          aria-expanded={isExpanded}
                          title={isExpanded ? 'Thu gọn video' : 'Xem video trong kênh'}
                        >
                          <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path d={isExpanded ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} />
                          </svg>
                        </button>
                      )}
                      <a class="btn secondary" href={href({ name: 'spy-run', id: run.id })}>Mở</a>
                      <DeleteButton
                        title={run.displayTitle || run.canonicalSource}
                        onDelete={() => remove(run.id)}
                      />
                    </div>
                  </div>
                  {run.kind === 'channel' && isExpanded && (
                    <div class="spy-run-video-list" aria-label={`Video từ ${run.displayTitle || 'kênh'}`}>
                      {expandingRunId === run.id ? (
                        <p class="muted">Đang tải video…</p>
                      ) : videos.length === 0 ? (
                        <p class="muted">Run này chưa có video.</p>
                      ) : videos.map((video) => (
                        <a
                          key={video.id}
                          class="spy-run-video-preview"
                          href={href({ name: 'spy-run', id: run.id })}
                          title={video.title}
                        >
                          <img src={thumbSrc(video)} alt="" loading="lazy" />
                          <span>{video.title}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
