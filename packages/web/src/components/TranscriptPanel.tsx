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
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!snapshotId || transcriptStatus !== 'ok') {
      setSegments([]);
      setNextCursor(null);
      setMeta(null);
      setPlain('');
      setError(null);
      setSearch('');
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

  const handleCopy = async () => {
    const textToCopy = mode === 'plain'
      ? (plain || segments.map((s) => s.text).join(' '))
      : segments.map((s) => `[${formatTimestamp(s.startSec)}] ${s.text}`).join('\n');
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!snapshotId) {
    return (
      <div class="empty-transcript-card">
        <span style={{ fontSize: '2rem' }}>📺</span>
        <p class="muted" style={{ margin: 0 }}>Chọn một video bên trái để đọc transcript.</p>
      </div>
    );
  }

  if (transcriptStatus !== 'ok') {
    return (
      <div class="empty-transcript-card">
        <span style={{ fontSize: '2.2rem' }}>📝</span>
        <div>
          <h4 style={{ margin: '0 0 0.25rem', fontSize: '1.05rem', color: 'var(--ink)' }}>Chưa có transcript</h4>
          <p class="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
            Video này chưa được tải transcript nội dung ({transcriptStatus || 'skipped'}).
          </p>
        </div>
        {onFetch && (
          <button class="btn teal" type="button" disabled={busy} onClick={onFetch}>
            {busy ? 'Đang lấy transcript…' : '⚡ Lấy transcript video này'}
          </button>
        )}
      </div>
    );
  }

  const filteredSegments = search.trim()
    ? segments.filter((s) => s.text.toLowerCase().includes(search.toLowerCase()))
    : segments;

  return (
    <div class="transcript-viewer">
      <div class="transcript-header-bar">
        <div class="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
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
              Plain Text
            </button>
          </div>

          {meta && (
            <span class="chip" style={{ fontSize: '0.78rem' }}>
              {meta.count} đoạn · {meta.source || 'caption'}
            </span>
          )}
        </div>

        <div class="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
          {mode === 'timed' && (
            <input
              type="text"
              class="transcript-search-input"
              placeholder="🔍 Tìm trong transcript…"
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            />
          )}

          <button type="button" class="btn secondary" style={{ height: '34px', fontSize: '0.8rem', padding: '0 0.75rem' }} onClick={() => void handleCopy()}>
            {copied ? '✓ Đã copy' : '📋 Copy'}
          </button>
        </div>
      </div>

      {error && <p class="error">{error}</p>}
      {loading && segments.length === 0 && <p class="muted">Đang tải dữ liệu transcript…</p>}

      {mode === 'timed' ? (
        <div class="transcript-timeline">
          {filteredSegments.length === 0 && search ? (
            <p class="muted" style={{ padding: '1rem', textCenter: 'center' }}>Không tìm thấy từ khóa "{search}".</p>
          ) : (
            filteredSegments.map((seg) => (
              <div key={seg.id} class="timeline-row">
                <span class="timestamp-pill">{formatTimestamp(seg.startSec)}</span>
                <span class="timeline-text">{seg.text}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div class="transcript-plain-body">{plain || segments.map((s) => s.text).join(' ')}</div>
      )}

      {nextCursor != null && mode === 'timed' && (
        <button
          class="btn secondary"
          type="button"
          disabled={loading}
          onClick={() => void loadMore()}
          style={{ alignSelf: 'center', marginTop: '0.5rem' }}
        >
          {loading ? 'Đang tải thêm…' : 'Tải thêm đoạn tiếp theo'}
        </button>
      )}
    </div>
  );
}

