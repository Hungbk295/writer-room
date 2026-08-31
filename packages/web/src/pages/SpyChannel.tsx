import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  api,
  LOCAL_DESKTOP_WATCHLIST_ID,
  type SpyChannelSummary,
  type SpyCompetitorResponse,
  type SpyWatchlistSegment,
} from '../api.ts';
import { href } from '../router.ts';
import { EntityId } from '../components/ui/EntityId.tsx';

function channelLabel(channel: SpyChannelSummary): string {
  return channel.title?.trim() || channel.handle?.trim() || channel.youtubeUcId;
}

function channelHref(channel: SpyChannelSummary): string {
  return href({ name: 'spy-channel', youtubeUcId: channel.youtubeUcId });
}

function displayDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function watchSchedule(channel: SpyChannelSummary): string {
  if (channel.nextDueAt) return `Lần thu thập public tiếp theo: ${displayDate(channel.nextDueAt)}`;
  return channel.watchStatus === 'paused'
    ? 'Public watch is not currently collecting (đã tạm dừng).'
    : 'Public watch is not currently collecting.';
}

function applyCompetitorResponse(channel: SpyChannelSummary, response: SpyCompetitorResponse): SpyChannelSummary {
  return {
    ...channel,
    watchStatus: response.watchStatus,
    cadence: response.cadence,
    lastObservedAt: response.lastObservedAt,
    nextDueAt: response.nextDueAt ?? null,
  };
}

function CompetitorStatus({ channel }: { channel: SpyChannelSummary }) {
  if (channel.watchStatus === 'followed') {
    return <span class="chip">Followed · {channel.cadence || 'daily'}</span>;
  }
  if (channel.watchStatus === 'paused') return <span class="chip warn">Paused</span>;
  return <span class="chip">Not followed</span>;
}

function ChannelCard({ channel }: { channel: SpyChannelSummary }) {
  return (
    <li class="spy-channel-card">
      <div class="spy-channel-card-main">
        {channel.thumbnailUrl && <img class="spy-channel-thumb" src={channel.thumbnailUrl} alt="" loading="lazy" />}
        <div class="spy-channel-card-copy">
          <a href={channelHref(channel)}>
            <strong>{channelLabel(channel)}</strong>
          </a>
          {channel.handle && <span class="muted">{channel.handle}</span>}
          <div class="meta">
            {channel.starred && <span class="chip">★ Saved</span>}
            <CompetitorStatus channel={channel} />
            <EntityId id={channel.youtubeUcId} label="UC" />
          </div>
        </div>
        <a class="btn secondary" href={channelHref(channel)}>Mở kênh</a>
      </div>
      <div class="spy-channel-card-facts">
        <span>Last public observation: {displayDate(channel.lastObservedAt)}</span>
        <span>{watchSchedule(channel)}</span>
      </div>
    </li>
  );
}

export function SpyChannelsPage({ segment }: { segment: SpyWatchlistSegment }) {
  const [channels, setChannels] = useState<SpyChannelSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listSpyWatchlistChannels(LOCAL_DESKTOP_WATCHLIST_ID, segment);
      setChannels(result.channels);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [segment]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saved = segment === 'saved';
  return (
    <div class="spy-channel-page">
      <div class="page-header">
        <div>
          <p class="eyebrow">Spy · local-desktop</p>
          <h1 class="page-title">{saved ? 'Đã lưu nghiên cứu' : 'Đối thủ đang theo dõi'}</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            {saved
              ? 'Các kênh đã Star để quay lại nghiên cứu. Star chỉ là bookmark local.'
              : 'Các kênh trong public watch list. Follow không yêu cầu OAuth hoặc “Kênh của tôi”.'}
          </p>
        </div>
        <div class="row">
          <a class="btn secondary" href={href({ name: 'spy-channels', segment: saved ? 'followed' : 'saved' })}>
            {saved ? 'Đối thủ đang theo dõi' : 'Đã lưu nghiên cứu'}
          </a>
          <a class="btn secondary" href={href({ name: 'spy' })}>← Spy</a>
        </div>
      </div>

      <section class="panel" aria-labelledby="spy-channel-list-heading">
        <div class="section-heading">
          <div>
            <h2 id="spy-channel-list-heading">{saved ? 'Saved research' : 'Followed competitors'}</h2>
            <p class="muted">{channels.length} kênh</p>
          </div>
          <span class="chip">Watchlist: {LOCAL_DESKTOP_WATCHLIST_ID}</span>
        </div>

        {loading && (
          <p class="muted" role="status" aria-live="polite" aria-busy="true">Đang tải danh sách kênh…</p>
        )}
        {error && (
          <div class="banner error" role="alert">
            <span>Không tải được danh sách kênh: {error}</span>
            <button class="btn secondary" type="button" onClick={() => void refresh()}>Thử lại</button>
          </div>
        )}
        {!loading && !error && channels.length === 0 && (
          <div class="empty-state">
            <strong>{saved ? 'Chưa có kênh được lưu.' : 'Chưa có đối thủ được theo dõi.'}</strong>
            <p class="muted">
              {saved
                ? 'Hoàn tất Spy channel để xác định UC… rồi chọn Star.'
                : 'Mở Saved research, chọn một kênh đã resolved rồi chọn Follow.'}
            </p>
            <a class="btn teal" href={saved ? href({ name: 'spy' }) : href({ name: 'spy-channels', segment: 'saved' })}>
              {saved ? 'Bắt đầu Spy channel' : 'Mở Saved research'}
            </a>
          </div>
        )}
        {!loading && !error && channels.length > 0 && (
          <ul class="list spy-channel-list">
            {channels.map((channel) => <ChannelCard key={channel.youtubeUcId} channel={channel} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

export function SpyChannelPage({ youtubeUcId }: { youtubeUcId: string }) {
  const [channel, setChannel] = useState<SpyChannelSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'star' | 'unstar' | 'follow' | 'pause' | 'unfollow' | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [saved, followed] = await Promise.all([
        api.listSpyWatchlistChannels(LOCAL_DESKTOP_WATCHLIST_ID, 'saved'),
        api.listSpyWatchlistChannels(LOCAL_DESKTOP_WATCHLIST_ID, 'followed'),
      ]);
      const found = [...saved.channels, ...followed.channels].find((item) => item.youtubeUcId === youtubeUcId);
      setChannel(found ?? null);
      if (!found) setError('Không tìm thấy kênh trong local-desktop watchlist.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [youtubeUcId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (kind: NonNullable<typeof action>) => {
    if (!channel) return;
    setAction(kind);
    setError(null);
    try {
      if (kind === 'star') {
        const result = await api.starSpyChannel(channel.youtubeUcId);
        setChannel((current) => current ? { ...current, starred: result.starred, starredAt: result.starredAt ?? null } : current);
      } else if (kind === 'unstar') {
        const result = await api.unstarSpyChannel(channel.youtubeUcId);
        setChannel((current) => current ? { ...current, starred: result.starred, starredAt: null } : current);
      } else if (kind === 'follow') {
        const result = await api.followSpyChannel(LOCAL_DESKTOP_WATCHLIST_ID, channel.youtubeUcId, {
          cadence: 'daily',
          watchStatus: 'followed',
        });
        setChannel((current) => current ? applyCompetitorResponse(current, result) : current);
      } else if (kind === 'pause') {
        const result = await api.pauseSpyChannel(LOCAL_DESKTOP_WATCHLIST_ID, channel.youtubeUcId);
        setChannel((current) => current ? applyCompetitorResponse(current, result) : current);
      } else {
        await api.unfollowSpyChannel(LOCAL_DESKTOP_WATCHLIST_ID, channel.youtubeUcId);
        setChannel((current) => current ? { ...current, watchStatus: null, cadence: null, nextDueAt: null } : current);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(null);
    }
  };

  const renderActions = (current: SpyChannelSummary) => (
    <div class="row spy-channel-actions" aria-label="Channel actions">
      {current.starred ? (
        <button class="btn secondary" type="button" disabled={action !== null} onClick={() => void runAction('unstar')}>
          {action === 'unstar' ? 'Bỏ lưu…' : '★ Đã lưu'}
        </button>
      ) : (
        <button class="btn teal" type="button" disabled={action !== null} onClick={() => void runAction('star')}>
          {action === 'star' ? 'Đang lưu…' : '☆ Star / Lưu nghiên cứu'}
        </button>
      )}
      {current.watchStatus === 'followed' && (
        <>
          <button class="btn secondary" type="button" disabled={action !== null} onClick={() => void runAction('pause')}>
            {action === 'pause' ? 'Tạm dừng…' : 'Pause watch'}
          </button>
          <button class="btn danger" type="button" disabled={action !== null} onClick={() => void runAction('unfollow')}>
            {action === 'unfollow' ? 'Unfollow…' : 'Unfollow'}
          </button>
        </>
      )}
      {current.watchStatus === 'paused' && (
        <>
          <button class="btn teal" type="button" disabled={action !== null} onClick={() => void runAction('follow')}>
            {action === 'follow' ? 'Đang theo dõi…' : 'Follow lại'}
          </button>
          <button class="btn danger" type="button" disabled={action !== null} onClick={() => void runAction('unfollow')}>
            {action === 'unfollow' ? 'Unfollow…' : 'Unfollow'}
          </button>
        </>
      )}
      {!current.watchStatus && (
        <button class="btn teal" type="button" disabled={action !== null} onClick={() => void runAction('follow')}>
          {action === 'follow' ? 'Đang theo dõi…' : 'Follow public watch'}
        </button>
      )}
    </div>
  );

  return (
    <div class="spy-channel-page">
      <div class="page-header">
        <div>
          <p class="eyebrow">Spy · channel workspace</p>
          <h1 class="page-title">{channel ? channelLabel(channel) : 'Public channel'}</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            Saved research và public competitor watch trên local-desktop.
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'spy-channels', segment: channel?.watchStatus ? 'followed' : 'saved' })}>← Danh sách kênh</a>
      </div>

      {loading && <p class="muted" role="status" aria-live="polite" aria-busy="true">Đang tải channel summary…</p>}
      {error && !channel && (
        <section class="panel" role="alert">
          <p class="error">{error}</p>
          <button class="btn secondary" type="button" onClick={() => void refresh()}>Thử lại</button>
        </section>
      )}
      {error && channel && <div class="banner error" role="alert">{error}</div>}

      {!loading && channel && (
        <>
          <section class="panel spy-channel-hero" aria-labelledby="spy-channel-summary-heading">
            <div>
              <div class="meta">
                {channel.handle && <span class="chip">{channel.handle}</span>}
                {channel.starred && <span class="chip">★ Saved research</span>}
                <CompetitorStatus channel={channel} />
                <EntityId id={channel.youtubeUcId} label="UC" />
              </div>
              <h2 id="spy-channel-summary-heading">{channelLabel(channel)}</h2>
              <p class="muted">{watchSchedule(channel)}</p>
              <a
                class="btn secondary"
                href={channel.canonicalUrl || `https://www.youtube.com/channel/${encodeURIComponent(channel.youtubeUcId)}`}
                target="_blank"
                rel="noreferrer"
              >
                Mở trên YouTube ↗
              </a>
            </div>
            {renderActions(channel)}
          </section>

          <section class="spy-channel-detail-grid" aria-label="Channel role and provenance">
            <div class="panel">
              <p class="eyebrow">Role</p>
              <h2>Public competitor</h2>
              <p class="muted">Placeholder: vai trò local của kênh này chưa phải ownership claim và không phải “Kênh của tôi”.</p>
            </div>
            <div class="panel">
              <p class="eyebrow">Provenance</p>
              <h2>Spy public source</h2>
              <p class="muted">Placeholder: channel identity được giữ bằng UC…; observation provenance sẽ xuất hiện khi public watch có dữ liệu.</p>
            </div>
          </section>

          <section class="panel spy-channel-placeholder" aria-labelledby="spy-channel-data-heading">
            <p class="eyebrow">Public observations</p>
            <h2 id="spy-channel-data-heading">Chưa có biểu đồ VPH trong C1</h2>
            <p class="muted">
              VPH charts và video drilldown sẽ dùng DTO public observations ở milestone sau. Màn hình này không suy diễn metric từ một snapshot.
            </p>
            <dl class="spy-channel-facts">
              <div><dt>Cadence</dt><dd>{channel.cadence || '—'}</dd></div>
              <div><dt>Last observed</dt><dd>{displayDate(channel.lastObservedAt)}</dd></div>
              <div><dt>Next due</dt><dd>{channel.nextDueAt ? displayDate(channel.nextDueAt) : '—'}</dd></div>
            </dl>
          </section>
        </>
      )}
    </div>
  );
}
