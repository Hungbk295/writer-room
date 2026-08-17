import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  api,
  formatDuration,
  type SpyVideoRow,
  type WriterPackSummary,
} from '../api.ts';
import { href } from '../router.ts';
import { pct, useOperationPoll } from '../hooks.ts';
import { TranscriptPanel } from '../components/TranscriptPanel.tsx';
import { FormulaDiscoveryAction, InteractiveFormulaDiscoveryAction } from '../features/training/FormulaDiscoveryAction.tsx';

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

  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'ready' | 'missing'>('all');
  /** Empty = create new pack; otherwise merge into this Writer pack id. */
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [writerPacks, setWriterPacks] = useState<WriterPackSummary[]>([]);

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

  useEffect(() => {
    void api.listWriterPacks()
      .then((data) => setWriterPacks(data.packs))
      .catch(() => setWriterPacks([]));
  }, []);

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
      // 50% transcript per video (daemon default); explicit for clarity at the call site.
      const opts = selectedReadyIds.length > 0
        ? { videoIds: selectedReadyIds, transcriptFraction: 0.5 }
        : { limit: 5, transcriptFraction: 0.5 };
      const result = await api.exportSourcePack(id, opts);
      setPackPreview(result.markdown);
      setMeta({ wordCount: result.wordCount, warnings: result.warnings });

      if (toWriter) {
        const payload = {
          markdown: result.markdown,
          videoIds: result.videoIds,
          spyRunId: id,
          channelTitle: result.channelTitle,
          warnings: result.warnings,
        };
        const pack = mergeTargetId
          ? await api.mergeWriterPack(mergeTargetId, payload)
          : await api.createWriterPack({
            title: result.channelTitle || source,
            wordCount: result.wordCount,
            ...payload,
          });
        const label = pack.title || pack.channelTitle || pack.id.slice(0, 8);
        setNotice(
          mergeTargetId
            ? `Đã merge ${result.videoIds.length} video vào pack “${label}” (${pack.videoIds.length} video tổng).`
            : `Đã tạo pack Writer “${label}” (${result.videoIds.length} video).`,
        );
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
  const sorted = useMemo(
    () => videos.slice().sort((a, b) => Number(b.transcriptStatus === 'ok') - Number(a.transcriptStatus === 'ok')),
    [videos],
  );

  const filteredVideos = useMemo(() => {
    return sorted.filter((v) => {
      if (filterTab === 'ready' && v.transcriptStatus !== 'ok') return false;
      if (filterTab === 'missing' && v.transcriptStatus === 'ok') return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return v.title.toLowerCase().includes(q) || v.sourceVideoId.toLowerCase().includes(q);
      }
      return true;
    });
  }, [sorted, filterTab, searchQuery]);

  const active = videos.find((v) => v.id === activeId) ?? sorted[0] ?? null;

  return (
    <div class="spy-run-container">
      <div class="spy-run-header">
        <div class="spy-run-title-group">
          <h1>Kênh đã spy</h1>
          <div class="spy-run-meta-pills">
            <span class={`chip ${status === 'completed' ? 'ok' : 'warn'}`}>{status || 'ready'}</span>
            <a href={source} target="_blank" rel="noreferrer" class="chip info" style={{ textDecoration: 'none' }}>
              📺 {source.replace('https://www.youtube.com/', '')} ↗
            </a>
            <span class="chip"><strong>{videos.length}</strong> video</span>
            <span class="chip"><strong>{readyCount}</strong> transcript</span>
            <span class="chip" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.74rem' }} title={id}>
              ID: {id.slice(0, 8)}…
            </span>
          </div>
        </div>

        <a class="btn secondary" href={href({ name: 'spy' })}>← Danh sách Spy</a>
      </div>

      <div class="toolbar-actions">
        <div class="toolbar-group">
          <button class="btn secondary" type="button" disabled={busy || readyCount === 0} onClick={selectAllReady}>
            ✓ Chọn đã có transcript ({readyCount})
          </button>
          <button class="btn secondary" type="button" disabled={selected.size === 0} onClick={clearSelection}>
            ✕ Bỏ chọn ({selected.size})
          </button>
        </div>
        <div class="toolbar-group">
          <button
            class="btn teal"
            type="button"
            disabled={busy || selectedMissingCount === 0}
            onClick={() => void fetchSelectedMissing()}
          >
            {fetchingId === 'selected' ? 'Đang lấy…' : `⚡ Lấy transcript còn thiếu (${selectedMissingCount})`}
          </button>
          <button
            class="btn secondary"
            type="button"
            disabled={busy || skippedCount === 0}
            onClick={() => void fetchMoreSkipped(5)}
          >
            {fetchingId === 'bulk' ? 'Đang lấy…' : `+ Lấy thêm ${Math.min(5, skippedCount)}`}
          </button>
          <button
            class="btn secondary"
            type="button"
            disabled={busy || readyCount === 0}
            onClick={() => void refetchAll()}
            title="Ghi đè transcript"
          >
            {fetchingId === 'refetch' ? '…' : '🔄 Force fetch'}
          </button>
        </div>
      </div>

      {operation && (operation.status === 'queued' || operation.status === 'running') && (
        <div class="stack" style={{ marginBottom: '0.5rem' }}>
          <div class="muted">{operation.step} · {operation.progress}/{operation.total || '?'}</div>
          <div class="progress">
            <span style={{ width: `${pct(operation.progress, operation.total || 1)}%` }} />
          </div>
        </div>
      )}

      {error && <div class="banner error">{error}</div>}
      {notice && <div class="banner ok">{notice}</div>}

      <div class="spy-run-grid">
        {/* Left Pane: Video Feed */}
        <aside class="video-feed-pane">
          <div class="feed-search-bar">
            <input
              type="text"
              placeholder="🔍 Tìm tiêu đề video…"
              value={searchQuery}
              onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
            />
          </div>

          <div class="feed-filter-tabs">
            <button
              type="button"
              class={`feed-tab-btn ${filterTab === 'all' ? 'active' : ''}`}
              onClick={() => setFilterTab('all')}
            >
              Tất cả ({videos.length})
            </button>
            <button
              type="button"
              class={`feed-tab-btn ${filterTab === 'ready' ? 'active' : ''}`}
              onClick={() => setFilterTab('ready')}
            >
              Có transcript ({readyCount})
            </button>
            <button
              type="button"
              class={`feed-tab-btn ${filterTab === 'missing' ? 'active' : ''}`}
              onClick={() => setFilterTab('missing')}
            >
              Chưa có ({skippedCount})
            </button>
          </div>

          <div class="video-feed-list">
            {filteredVideos.length === 0 ? (
              <p class="muted" style={{ padding: '1rem', textAlign: 'center' }}>Không tìm thấy video phù hợp.</p>
            ) : (
              filteredVideos.map((video) => {
                const isActive = active?.id === video.id;
                const isChecked = selected.has(video.sourceVideoId);
                return (
                  <div
                    key={video.id}
                    class={`feed-item ${isActive ? 'is-active' : ''}`}
                    onClick={() => selectVideo(video.id)}
                  >
                    <div class="feed-item-checkbox" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(video.sourceVideoId)}
                      />
                    </div>

                    <div class="feed-item-thumb">
                      <img src={thumbSrc(video)} alt="" loading="lazy" />
                      {video.durationSec > 0 && (
                        <span class="duration-badge">{formatDuration(video.durationSec)}</span>
                      )}
                    </div>

                    <div class="feed-item-info">
                      <span class="feed-item-title">{video.title}</span>
                      <div class="feed-item-meta">
                        <span>{video.viewCount.toLocaleString()} views</span>
                        <span class={`chip ${statusChipClass(video.transcriptStatus)}`} style={{ fontSize: '0.72rem', padding: '0.1rem 0.4rem' }}>
                          {video.transcriptStatus === 'ok' ? `✓ ${video.transcriptCount || ''}` : video.transcriptStatus}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Pane: Video Inspector */}
        <section class="video-inspector-pane" ref={detailRef}>
          {active ? (
            <>
              <div class="inspector-hero">
                <div class="inspector-thumb-container">
                  <img src={thumbSrc(active)} alt={active.title} />
                </div>
                <div class="inspector-hero-body">
                  <h2>{active.title}</h2>
                  <div class="meta" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                    <span>👀 {active.viewCount.toLocaleString()} views</span>
                    <span>⏱ {formatDuration(active.durationSec)}</span>
                    {active.publishedAt && (
                      <span>📅 {new Date(active.publishedAt).toLocaleDateString()}</span>
                    )}
                    <span class={`chip ${statusChipClass(active.transcriptStatus)}`}>
                      transcript: {active.transcriptStatus}
                    </span>
                    <span class="chip">{active.frameStatus} frames</span>
                  </div>

                  <div class="inspector-hero-actions">
                    {active.transcriptStatus !== 'ok' && (
                      <button
                        class="btn teal"
                        type="button"
                        disabled={busy}
                        onClick={() => void fetchOne(active)}
                      >
                        {fetchingId === active.sourceVideoId ? 'Đang lấy…' : '⚡ Lấy transcript'}
                      </button>
                    )}
                    <a
                      class="btn secondary"
                      href={active.canonicalUrl || `https://www.youtube.com/watch?v=${active.sourceVideoId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Xem trên YouTube ↗
                    </a>
                    <FormulaDiscoveryAction video={active} />
                  </div>
                  <div class="row" style={{ marginTop: '0.5rem' }}>
                    <InteractiveFormulaDiscoveryAction video={active} />
                  </div>
                </div>
              </div>

              <div class="transcript-section">
                <TranscriptPanel
                  snapshotId={active.id}
                  transcriptStatus={active.transcriptStatus}
                  busy={busy}
                  onFetch={() => void fetchOne(active)}
                />
              </div>
            </>
          ) : (
            <div class="empty-transcript-card">
              <span style={{ fontSize: '2.5rem' }}>👈</span>
              <p class="muted">Chọn một video trong danh sách bên trái để kiểm tra thông tin và đọc transcript.</p>
            </div>
          )}
        </section>
      </div>

      <div class="selection-bar">
        <div class="meta">
          <strong>{selected.size}</strong> video đã chọn
          {selectedReadyIds.length > 0 && (
            <span class="muted">· {selectedReadyIds.length} video sẵn sàng</span>
          )}
          {meta && (
            <span class="muted">· tổng {meta.wordCount} từ</span>
          )}
        </div>
        <div class="row" style={{ gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label class="field" style={{ margin: 0, minWidth: '14rem' }}>
            <span class="muted" style={{ fontSize: '0.8rem' }}>Gửi Writer →</span>
            <select
              value={mergeTargetId}
              onChange={(e) => setMergeTargetId((e.target as HTMLSelectElement).value)}
              disabled={busy}
              title="Tạo pack mới hoặc merge vào pack có sẵn (multi-channel)"
            >
              <option value="">Tạo pack mới</option>
              {writerPacks.map((p) => (
                <option key={p.id} value={p.id}>
                  Merge → {p.title || p.channelTitle || p.id.slice(0, 8)}
                  {' · '}
                  {p.videoCount} video
                </option>
              ))}
            </select>
          </label>
          <button
            class="btn secondary"
            type="button"
            disabled={busy || (selectedReadyIds.length === 0 && readyCount === 0)}
            onClick={() => void exportPack(false)}
          >
            Xuất Source Pack (.md)
          </button>
          <button
            class="btn teal"
            type="button"
            disabled={busy || (selectedReadyIds.length === 0 && readyCount === 0)}
            onClick={() => void exportPack(true)}
          >
            {mergeTargetId ? '🔗 Merge vào pack' : '🚀 Gửi sang Writer'}
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
