import { useEffect, useState } from 'preact/hooks';
import { api, type SpyRunSummary } from '../api.ts';
import { href } from '../router.ts';
import { pct, useOperationPoll } from '../hooks.ts';
import { CustomSelect, Field, Input } from '../components/ui/Forms.tsx';
import { DeleteButton } from '../components/ui/DeleteButton.tsx';

type SpyMode = 'video' | 'channel';

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
  const [scanLimit, setScanLimit] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [spyRunId, setSpyRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<SpyRunSummary[]>([]);

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
        : await api.startChannel({ url, depth, topN, scanLimit });
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
              <Field label="Top N">
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={topN}
                  onInput={(e) => setTopN(Number((e.target as HTMLInputElement).value))}
                />
              </Field>
              <Field label="Scan">
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={scanLimit}
                  onInput={(e) => setScanLimit(Number((e.target as HTMLInputElement).value))}
                />
              </Field>
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
            {runs.map((run) => (
              <li key={run.id} class="pack-row">
                <div>
                  <a href={href({ name: 'spy-run', id: run.id })}>
                    <strong>{run.canonicalSource}</strong>
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
                <div class="row pack-row-actions" style={{ gap: '0.5rem' }}>
                  <a class="btn secondary" href={href({ name: 'spy-run', id: run.id })}>Mở</a>
                  <DeleteButton
                    title={run.canonicalSource}
                    onDelete={() => remove(run.id)}
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
