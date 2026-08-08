import { useEffect, useState } from 'preact/hooks';
import { api, formatTimestamp, type TranscriptSegment } from '../api.ts';

export function TranscriptPanel({
  snapshotId,
  transcriptStatus,
  onFetch,
  busy,
}: {
  snapshotId: string | null;
  transcriptStatus: string;
  onFetch?: () => void;
  busy?: boolean;
}) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [meta, setMeta] = useState<{ source: string | null; count: number; hasNormalized: boolean } | null>(null);
  const [mode, setMode] = useState<'timed' | 'plain'>('timed');
  const [plain, setPlain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshotId || transcriptStatus !== 'ok') {
      setSegments([]);
      setNextCursor(null);
      setMeta(null);
      setPlain('');
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const page = await api.getTranscript(snapshotId, 0, 500);
        if (cancelled) return;
        setSegments(page.segments);
        setNextCursor(page.nextCursor);
        setMeta({
          source: page.meta.source,
          count: page.meta.count,
          hasNormalized: page.meta.hasNormalized,
        });
        const text = await api.getTranscriptText(snapshotId);
        if (!cancelled) setPlain(text.text);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshotId, transcriptStatus]);

  const loadMore = async () => {
    if (!snapshotId || nextCursor == null) return;
    setLoading(true);
    try {
      const page = await api.getTranscript(snapshotId, nextCursor, 500);
      setSegments((prev) => [...prev, ...page.segments]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (!snapshotId) {
    return (
      <div class="transcript-pane empty-state">
        <p class="muted">Chọn một video bên trái để xem transcript.</p>
      </div>
    );
  }

  if (transcriptStatus !== 'ok') {
    return (
      <div class="transcript-pane empty-state">
        <p class="muted">
          Chưa có transcript
          {transcriptStatus && transcriptStatus !== 'skipped' ? ` (${transcriptStatus})` : ''}.
        </p>
        {onFetch && (
          <button class="btn teal" type="button" disabled={busy} onClick={onFetch}>
            {busy ? 'Đang lấy…' : 'Lấy transcript'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div class="transcript-pane">
      <div class="transcript-toolbar">
        <div class="meta">
          {meta && (
            <>
              <span class="chip">{meta.count} đoạn</span>
              {meta.source && <span class="chip">{meta.source}</span>}
              {meta.hasNormalized && <span class="chip">normalized</span>}
            </>
          )}
        </div>
        <div class="segmented">
          <button
            type="button"
            class={mode === 'timed' ? 'active' : ''}
            onClick={() => setMode('timed')}
          >
            Timed
          </button>
          <button
            type="button"
            class={mode === 'plain' ? 'active' : ''}
            onClick={() => setMode('plain')}
          >
            Plain
          </button>
        </div>
      </div>

      {error && <p class="error">{error}</p>}
      {loading && segments.length === 0 && <p class="muted">Đang tải transcript…</p>}

      {mode === 'timed' ? (
        <ul class="transcript-lines">
          {segments.map((seg) => (
            <li key={seg.id}>
              <time>{formatTimestamp(seg.startSec)}</time>
              <span>{seg.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div class="transcript-plain">{plain || segments.map((s) => s.text).join(' ')}</div>
      )}

      {nextCursor != null && mode === 'timed' && (
        <button class="btn secondary" type="button" disabled={loading} onClick={() => void loadMore()}>
          {loading ? '…' : 'Tải thêm'}
        </button>
      )}
    </div>
  );
}
