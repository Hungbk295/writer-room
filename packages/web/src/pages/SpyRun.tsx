import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  api,
  formatDuration,
  type SpyVideoRow,
} from '../api.ts';
import { href } from '../router.ts';
import { pct, useOperationPoll } from '../hooks.ts';
import { TranscriptPanel } from '../components/TranscriptPanel.tsx';

function thumbSrc(video: SpyVideoRow): string {
  return video.thumbnailUrl
    || `https://i.ytimg.com/vi/${video.sourceVideoId}/hqdefault.jpg`;
}

function statusChipClass(status: string): string {
  if (status === 'ok') return '';
  if (status === 'skipped' || status === 'pending') return 'warn';
  return 'bad';
}

export function SpyRunPage({ id }: { id: string }) {
  const [videos, setVideos] = useState<SpyVideoRow[]>([]);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [packPreview, setPackPreview] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ wordCount: number; warnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);

  const selectVideo = (videoId: string) => {
    setActiveId(videoId);
    if (typeof window !== 'undefined' && window.innerWidth <= 900) {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const reload = useCallback(async () => {
    const data = await api.getSpyRun(id);
    setVideos(data.videos);
    setSource(data.run.canonicalSource);
    setStatus(data.run.status);
    setActiveId((prev) => {
      if (prev && data.videos.some((v) => v.id === prev)) return prev;
      return data.videos[0]?.id ?? null;
    });
  }, [id]);

  useEffect(() => {
    void reload().catch((err) => setError(err.message));
  }, [reload]);

  const { operation } = useOperationPoll(operationId, async (op) => {
    setBusy(false);
    setFetchingId(null);
    setOperationId(null);
    if (op.status === 'failed') {
      setError(op.errorMessage || 'Lấy transcript thất bại');
    }
    await reload().catch(() => undefined);
  });

  const startFetch = async (videoIds: string[], force = false) => {
    if (videoIds.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const started = await api.fetchTranscripts({ videoIds, force });
      setOperationId(started.operationId);
    } catch (err) {
      setBusy(false);
      setFetchingId(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const fetchOne = async (video: SpyVideoRow) => {
    setFetchingId(video.sourceVideoId);
    await startFetch([video.sourceVideoId]);
  };

  const fetchSelectedMissing = async () => {
    const missing = videos
      .filter((v) => selected.has(v.sourceVideoId) && v.transcriptStatus !== 'ok')
      .map((v) => v.sourceVideoId);
    setFetchingId('selected');
    await startFetch(missing);
  };

  const fetchMoreSkipped = async (count = 5) => {
    const skipped = videos
      .filter((v) => v.transcriptStatus !== 'ok')
      .slice(0, count)
      .map((v) => v.sourceVideoId);
    setFetchingId('bulk');
    await startFetch(skipped);
  };

  const refetchAll = async () => {
    const ready = videos.filter((v) => v.transcriptStatus === 'ok').map((v) => v.sourceVideoId);
    setFetchingId('refetch');
    await startFetch(ready, true);
  };

  const toggleSelect = (sourceVideoId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sourceVideoId)) next.delete(sourceVideoId);
      else next.add(sourceVideoId);
      return next;
    });
  };

  const selectAllReady = () => {
    setSelected(new Set(videos.filter((v) => v.transcriptStatus === 'ok').map((v) => v.sourceVideoId)));
  };

  const clearSelection = () => setSelected(new Set());

  const selectedReadyIds = useMemo(
    () => videos
      .filter((v) => selected.has(v.sourceVideoId) && v.transcriptStatus === 'ok')
      .map((v) => v.sourceVideoId),
    [videos, selected],
  );

  const selectedMissingCount = useMemo(
    () => videos.filter((v) => selected.has(v.sourceVideoId) && v.transcriptStatus !== 'ok').length,
    [videos, selected],
  );

  const exportPack = async (toWriter: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const opts = selectedReadyIds.length > 0
        ? { videoIds: selectedReadyIds }
        : { limit: 5 };
      const result = await api.exportSourcePack(id, opts);
      setPackPreview(result.markdown);
      setMeta({ wordCount: result.wordCount, warnings: result.warnings });

      if (toWriter) {
        const pack = await api.createWriterPack({
          title: result.channelTitle || source,
          markdown: result.markdown,
          videoIds: result.videoIds,
          spyRunId: id,
          channelTitle: result.channelTitle,
          wordCount: result.wordCount,
          warnings: result.warnings,
        });
        setNotice(`Đã gửi Writer (${result.videoIds.length} video).`);
        location.hash = href({ name: 'writer-pack', id: pack.id }).slice(1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const skippedCount = videos.filter((v) => v.transcriptStatus !== 'ok').length;
  const readyCount = videos.length - skippedCount;
  const sorted = videos
    .slice()
    .sort((a, b) => Number(b.transcriptStatus === 'ok') - Number(a.transcriptStatus === 'ok'));

  const active = videos.find((v) => v.id === activeId) ?? sorted[0] ?? null;

  return (
    <div class="spy-run-page">
      <div class="page-header">
        <div>
          <h1 class="page-title">Kênh đã spy</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            <a href={source} target="_blank" rel="noreferrer" class="link-btn">
              {source} ↗
            </a>
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'spy' })}>← Spy</a>
      </div>

      <div class="meta" style={{ marginBottom: '1.25rem', alignItems: 'center' }}>
        <span class={`chip ${status === 'completed' ? 'ok' : 'warn'}`}>{status}</span>
        <span><strong>{videos.length}</strong> video</span>
        <span><strong>{readyCount}</strong> transcript</span>
        <span class="chip" style={{ opacity: 0.75, fontFamily: 'var(--font-mono)', fontSize: '0.74rem' }} title={id}>
          ID: {id.slice(0, 8)}…
        </span>
      </div>

      <div class="toolbar-actions">
        <div class="toolbar-group">
          <button class="btn secondary" type="button" disabled={busy || readyCount === 0} onClick={selectAllReady}>
            Chọn đã có transcript
          </button>
          <button class="btn secondary" type="button" disabled={selected.size === 0} onClick={clearSelection}>
            Bỏ chọn
          </button>
        </div>
        <div class="toolbar-group">
          <button
            class="btn teal"
            type="button"
            disabled={busy || selectedMissingCount === 0}
            onClick={() => void fetchSelectedMissing()}
          >
            {fetchingId === 'selected' ? 'Đang lấy…' : `Lấy transcript còn thiếu (${selectedMissingCount})`}
          </button>
          <button
            class="btn secondary"
            type="button"
            disabled={busy || skippedCount === 0}
            onClick={() => void fetchMoreSkipped(5)}
          >
            {fetchingId === 'bulk' ? 'Đang lấy…' : `Lấy thêm ${Math.min(5, skippedCount)}`}
          </button>
          <button
            class="btn secondary"
            type="button"
            disabled={busy || readyCount === 0}
            onClick={() => void refetchAll()}
            title="Ghi đè transcript (vd. bản caption cuộn cũ)"
          >
            {fetchingId === 'refetch' ? '…' : 'Lấy lại (force)'}
          </button>
        </div>
      </div>

      {operation && (operation.status === 'queued' || operation.status === 'running') && (
        <div class="stack" style={{ marginBottom: '1rem' }}>
          <div class="muted">{operation.step} · {operation.progress}/{operation.total || '?'}</div>
          <div class="progress">
            <span style={{ width: `${pct(operation.progress, operation.total || 1)}%` }} />
          </div>
        </div>
      )}

      {error && <p class="error">{error}</p>}
      {notice && <p class="ok">{notice}</p>}

      <div class="video-split">
        <aside class="video-list-pane panel">
          <h2>Video ({sorted.length})</h2>
          {sorted.length === 0 ? (
            <p class="muted">Chưa có video.</p>
          ) : (
            <ul class="video-list">
              {sorted.map((video) => {
                const isActive = active?.id === video.id;
                const isChecked = selected.has(video.sourceVideoId);
                return (
                  <li
                    key={video.id}
                    class={`video-row ${isActive ? 'active' : ''}`}
                    onClick={() => selectVideo(video.id)}
                  >
                    <label class="video-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(video.sourceVideoId)}
                      />
                    </label>
                    <div class="video-row-main">
                      <img
                        class="thumb"
                        src={thumbSrc(video)}
                        alt=""
                        loading="lazy"
                        width={104}
                        height={58}
                      />
                      <div class="video-row-body">
                        <strong>{video.title}</strong>
                        <div class="meta">
                          <span>{video.viewCount.toLocaleString()} views</span>
                          <span>{formatDuration(video.durationSec)}</span>
                          <span class={`chip ${statusChipClass(video.transcriptStatus)}`}>
                            {video.transcriptStatus}
                            {video.transcriptCount ? ` · ${video.transcriptCount}` : ''}
                          </span>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section class="video-detail-pane panel" ref={detailRef}>
          {active ? (
            <>
              <div class="detail-hero">
                <img class="thumb thumb-lg" src={thumbSrc(active)} alt="" />
                <div class="detail-hero-body">
                  <h2>{active.title}</h2>
                  <div class="meta">
                    <span>{active.viewCount.toLocaleString()} views</span>
                    <span>{formatDuration(active.durationSec)}</span>
                    {active.publishedAt && (
                      <span>{new Date(active.publishedAt).toLocaleDateString()}</span>
                    )}
                    <span class={`chip ${statusChipClass(active.transcriptStatus)}`}>
                      transcript: {active.transcriptStatus}
                    </span>
                    <span class="chip">{active.frameStatus} frames</span>
                    {active.transcriptSource && (
                      <span class="chip">{active.transcriptSource}</span>
                    )}
                  </div>
                  <div class="detail-hero-actions">
                    {active.transcriptStatus !== 'ok' && (
                      <button
                        class="btn teal"
                        type="button"
                        disabled={busy}
                        onClick={() => void fetchOne(active)}
                      >
                        {fetchingId === active.sourceVideoId ? '…' : 'Lấy transcript'}
                      </button>
                    )}
                    <a
                      class="btn secondary"
                      href={active.canonicalUrl || `https://www.youtube.com/watch?v=${active.sourceVideoId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      YouTube ↗
                    </a>
                  </div>
                </div>
              </div>

              <h3 class="transcript-heading">Transcript</h3>
              <TranscriptPanel
                snapshotId={active.id}
                transcriptStatus={active.transcriptStatus}
                busy={busy}
                onFetch={() => void fetchOne(active)}
              />
            </>
          ) : (
            <p class="muted">Chọn video để xem chi tiết.</p>
          )}
        </section>
      </div>

      <div class="selection-bar">
        <div class="meta">
          <strong>{selected.size}</strong> đã chọn
          {selectedReadyIds.length > 0 && (
            <span class="muted">· {selectedReadyIds.length} có transcript</span>
          )}
          {meta && (
            <span class="muted">· pack {meta.wordCount} từ</span>
          )}
        </div>
        <div class="row">
          <button
            class="btn secondary"
            type="button"
            disabled={busy || (selectedReadyIds.length === 0 && readyCount === 0)}
            onClick={() => void exportPack(false)}
          >
            Xuất Source Pack
          </button>
          <button
            class="btn teal"
            type="button"
            disabled={busy || (selectedReadyIds.length === 0 && readyCount === 0)}
            onClick={() => void exportPack(true)}
          >
            Gửi Writer
          </button>
        </div>
      </div>

      {packPreview && (
        <section class="panel" style={{ marginTop: '1rem' }}>
          <h2>Source Pack preview</h2>
          <pre class="pre">{packPreview}</pre>
        </section>
      )}
    </div>
  );
}
