import { useEffect, useState } from 'preact/hooks';
import { api, type SpyRunSummary } from '../api.ts';
import { href } from '../router.ts';
import { pct, useOperationPoll } from '../hooks.ts';

export function SpyPage() {
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
    setRuns(data.runs.filter((r) => r.kind === 'channel'));
  };

  useEffect(() => {
    void refresh().catch((err) => setError(err.message));
  }, []);

  const { operation } = useOperationPoll(operationId, async (op) => {
    setBusy(false);
    if (op.status === 'completed' && spyRunId) {
      location.hash = href({ name: 'spy-run', id: spyRunId }).slice(1);
    } else if (op.status === 'failed') {
      setError(op.errorMessage || 'Spy channel thất bại');
    }
    await refresh().catch(() => undefined);
  });

  const start = async (event: Event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const started = await api.startChannel({ url, depth, topN, scanLimit });
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
          <h1 class="page-title">Spy channel</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            Thu hoạch kênh → transcript → Source Pack.
          </p>
        </div>
      </div>

      <form class="panel stack" onSubmit={start} style={{ marginTop: '1.25rem' }}>
        <h2>Kênh mới</h2>
        <label>
          URL kênh / playlist
          <input
            required
            placeholder="https://www.youtube.com/@handle"
            value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          />
        </label>
        <div class="row">
          <label>
            Depth
            <select value={depth} onChange={(e) => setDepth((e.target as HTMLSelectElement).value as typeof depth)}>
              <option value="metadata">metadata — nhanh</option>
              <option value="transcript">transcript — nguyên liệu Source Pack</option>
            </select>
          </label>
          <label>
            Top N
            <input type="number" min={1} max={20} value={topN} onInput={(e) => setTopN(Number((e.target as HTMLInputElement).value))} />
          </label>
          <label>
            Scan
            <input type="number" min={1} max={500} value={scanLimit} onInput={(e) => setScanLimit(Number((e.target as HTMLInputElement).value))} />
          </label>
        </div>
        <div class="row">
          <button class="btn teal" disabled={busy || !url.trim()}>
            {busy ? 'Đang spy…' : 'Bắt đầu Spy'}
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
        <h2>Kênh đã spy</h2>
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
                    <span class="chip">{run.status}</span>
                    {typeof run.videoCount === 'number' && (
                      <span>{run.videoCount} video</span>
                    )}
                    <span>{new Date(run.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <a class="btn secondary" href={href({ name: 'spy-run', id: run.id })}>Mở</a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
