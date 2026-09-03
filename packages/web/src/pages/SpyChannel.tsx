import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  api,
  LOCAL_DESKTOP_WATCHLIST_ID,
  type SpyChannelSummary,
  type ChannelWatchSettings,
  type SpyCompetitorResponse,
  type SpyPublicVideoVphRead,
  type SpyPublicVphRead,
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

function watchSchedule(channel: SpyChannelSummary, globalWatchEnabled: boolean): string {
  if (channel.watchStatus === 'followed' && !globalWatchEnabled) {
    return 'Public watch is not currently collecting (global daily watch đang tắt).';
  }
  if (channel.nextDueAt) return `Lần thu thập public tiếp theo: ${displayDate(channel.nextDueAt)}`;
  return channel.watchStatus === 'paused'
    ? 'Public watch is not currently collecting (đã tạm dừng).'
    : 'Public watch is not currently collecting.';
}

function formatVph(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString();
}

function VphHeatmap({ data }: { data: SpyPublicVphRead }) {
  const timeline = data.vphTimeline || [];
  const days = [...new Set(timeline.flatMap((segment) => segment.end ? [segment.end.sampledAt.slice(0, 10)] : []))]
    .toSorted().slice(-14);
  const rows = data.vphSegments.slice(0, 20);
  if (days.length === 0 || rows.length === 0) return null;
  const max = Math.max(...timeline.flatMap((segment) => segment.value === null ? [] : [segment.value]), 1);
  return (
    <section class="spy-vph-subchart" aria-labelledby="spy-vph-heatmap-heading">
      <h3 id="spy-vph-heatmap-heading">Heatmap VPH theo video × ngày</h3>
      <div class="spy-vph-heatmap-wrap">
        <table class="spy-vph-heatmap table">
          <thead><tr><th>Video</th>{days.map((day) => <th key={day}>{day.slice(5)}</th>)}</tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={row.sourceVideoId}>
              <td title={row.title || row.sourceVideoId}>{row.title || row.sourceVideoId}</td>
              {days.map((day) => {
                const segment = timeline.filter((item) => item.sourceVideoId === row.sourceVideoId && item.end?.sampledAt.startsWith(day)).at(-1) ?? null;
                const intensity = segment?.value === null || !segment ? 0 : Math.max(0.12, segment.value / max);
                const label = segment?.value === null || !segment
                  ? 'Không đo'
                  : `${formatVph(segment.value)} VPH · ${segment.actualElapsedHours?.toFixed(1) ?? '—'}h · ${segment.comparability}`;
                return <td key={day} class={segment?.value === null || !segment ? 'spy-vph-heatmap-empty' : ''} title={label} style={segment?.value === null || !segment ? undefined : { background: `rgb(31 138 122 / ${intensity})` }}>{segment?.value === null || !segment ? '—' : formatVph(segment.value)}</td>;
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p class="muted small">Mỗi ô là đoạn đo kết thúc trong ngày đó. “—” nghĩa là không đo/không hợp lệ, không phải 0 views/hour.</p>
    </section>
  );
}

function VphScatter({ data }: { data: SpyPublicVphRead }) {
  const points = data.vphSegments.flatMap((segment) => {
    if (segment.value === null || !segment.end || !segment.publishedAt) return [];
    const ageHours = (Date.parse(segment.end.sampledAt) - Date.parse(segment.publishedAt)) / 3_600_000;
    return Number.isFinite(ageHours) && ageHours >= 0 ? [{ segment, ageHours }] : [];
  });
  if (points.length === 0) return null;
  const maxAge = Math.max(...points.map((item) => item.ageHours), 1);
  const maxVph = Math.max(...points.map((item) => item.segment.value ?? 0), 1);
  return (
    <section class="spy-vph-subchart" aria-labelledby="spy-vph-scatter-heading">
      <h3 id="spy-vph-scatter-heading">VPH theo tuổi video</h3>
      <div class="spy-vph-scatter" role="img" aria-label="Scatter: tuổi video theo trục ngang, VPH theo trục dọc">
        {points.map(({ segment, ageHours }) => (
          <span
            key={segment.sourceVideoId}
            class={segment.comparability.startsWith('comparable_') ? 'spy-vph-dot' : 'spy-vph-dot warn'}
            style={{ left: `${(ageHours / maxAge) * 92 + 4}%`, bottom: `${((segment.value ?? 0) / maxVph) * 82 + 6}%` }}
            title={`${segment.title || segment.sourceVideoId}: age ${ageHours.toFixed(1)}h, ${formatVph(segment.value)} VPH, ${segment.comparability}`}
          />
        ))}
        <span class="spy-vph-axis-x">Tuổi video → {maxAge.toFixed(0)}h</span>
        <span class="spy-vph-axis-y">VPH ↑ {formatVph(maxVph)}</span>
      </div>
      <p class="muted small">Mỗi điểm là một đoạn đo public; đây không phải CTR, impression hay dự báo breakout.</p>
    </section>
  );
}

function VphCohorts({ data }: { data: SpyPublicVphRead }) {
  return (
    <section class="spy-vph-subchart" aria-labelledby="spy-vph-cohort-heading">
      <h3 id="spy-vph-cohort-heading">Cohort theo tuổi video</h3>
      <table class="table spy-vph-table">
        <thead><tr><th>Tuổi</th><th>Mẫu comparable</th><th>Median VPH</th><th>P25–P75</th></tr></thead>
        <tbody>{data.aggregations.cohorts.map((cohort) => (
          <tr key={cohort.ageBucket}>
            <td>{cohort.ageBucket}</td><td>{cohort.sampleCount}</td>
            <td>{formatVph(cohort.medianVph)}</td>
            <td>{cohort.p25 === null || cohort.p75 === null ? 'Chưa đủ 3 mẫu' : `${formatVph(cohort.p25)} – ${formatVph(cohort.p75)}`}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

function VphChart({ data }: { data: SpyPublicVphRead | null }) {
  const [drilldown, setDrilldown] = useState<SpyPublicVideoVphRead | null>(null);
  const [drilldownId, setDrilldownId] = useState<string | null>(null);
  const [drilldownError, setDrilldownError] = useState<string | null>(null);
  if (!data) {
    return <p class="muted">Chưa có VPH vì kênh chưa nằm trong public watchlist.</p>;
  }
  if (data.segments.length === 0) {
    const coverage = data.coverage;
    const state = coverage.latestRunStatus === 'unavailable' || coverage.latestRunStatus === 'failed'
      ? `Lần collect gần nhất ${coverage.latestRunStatus}; không có dữ liệu giả thay thế.`
      : coverage.unavailablePointCount > 0
        ? 'Có mẫu missing/private/error; VPH được ngắt tại khoảng thiếu dữ liệu.'
        : 'Chưa đủ hai public observations hợp lệ trên cùng một video để dựng VPH.';
    return <p class="muted">{state}</p>;
  }
  const measured = data.segments.filter((segment) => segment.value !== null);
  const max = Math.max(...measured.map((segment) => segment.value ?? 0), 1);
  const openDrilldown = async (sourceVideoId: string) => {
    setDrilldownId(sourceVideoId);
    setDrilldownError(null);
    try {
      setDrilldown(await api.getSpyVideoVph(sourceVideoId, { window: data.requestedWindow }));
    } catch (error) {
      setDrilldown(null);
      setDrilldownError(error instanceof Error ? error.message : String(error));
    } finally {
      setDrilldownId(null);
    }
  };
  return (
    <div class="spy-vph-chart" aria-label="Public VPH chart">
      <div class="spy-vph-bars" role="img" aria-label="Biểu đồ VPH public theo video">
        {data.segments.slice(0, 12).map((segment) => {
          const height = segment.value === null ? 0 : Math.max(4, (segment.value / max) * 100);
          const title = [
            `videoId: ${segment.sourceVideoId}`,
            `VPH: ${formatVph(segment.value)} views/hour`,
            `window requested/actual: ${segment.requestedWindow}/${segment.actualElapsedHours?.toFixed(1) || '—'}h`,
            `start: ${segment.start ? `${segment.start.sampledAt} · ${segment.start.viewCount}` : '—'}`,
            `end: ${segment.end ? `${segment.end.sampledAt} · ${segment.end.viewCount}` : '—'}`,
            `provider: ${segment.providerUsed}; inspect: ${segment.inspectUsed ? 'yes' : 'no'}; ${segment.availability ?? 'unknown'} / ${segment.viewQuality ?? 'unknown'}`,
            `definition: ${segment.definitionVersion}; ${segment.comparability}`,
          ].join('\n');
          return (
            <div class="spy-vph-bar-wrap" key={segment.sourceVideoId} title={title}>
              <span class={segment.comparability.startsWith('comparable_') ? 'spy-vph-bar' : 'spy-vph-bar warn'} style={{ height: `${height}%` }} />
              <span class="spy-vph-bar-label">{formatVph(segment.value)}</span>
            </div>
          );
        })}
      </div>
      <div class="spy-vph-table-wrap">
        <table class="table spy-vph-table">
          <thead><tr><th>Video</th><th>VPH</th><th>Cửa sổ thật</th><th>Mẫu cuối</th><th>Trạng thái</th></tr></thead>
          <tbody>
            {data.segments.map((segment) => (
              <tr key={segment.sourceVideoId}>
                <td title={segment.title || segment.sourceVideoId}>
                  <button class="link-button" type="button" onClick={() => void openDrilldown(segment.sourceVideoId)}>
                    {drilldownId === segment.sourceVideoId ? 'Đang mở…' : segment.title || segment.sourceVideoId}
                  </button>
                </td>
                <td>{formatVph(segment.value)}</td>
                <td>{segment.actualElapsedHours === null ? '—' : `${segment.actualElapsedHours.toFixed(1)}h`}</td>
                <td>{segment.availability ?? '—'} · {segment.viewQuality ?? '—'}</td>
                <td>{segment.comparability.startsWith('comparable_') ? `${segment.requestedWindow} comparable` : segment.reason || segment.comparability}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <VphHeatmap data={data} />
      <VphScatter data={data} />
      <VphCohorts data={data} />
      {drilldownError && <p class="error">Không mở được video drilldown: {drilldownError}</p>}
      {drilldown && (
        <details class="spy-vph-drilldown" open>
          <summary>Raw observations — {drilldown.sourceVideoId}</summary>
          <p class="muted small">Public · yt-dlp · {drilldown.definitionVersion} · {drilldown.timezone}. Missing/private/error là gap, không phải view = 0.</p>
          <table class="table spy-vph-table">
            <thead><tr><th>Sample UTC</th><th>Views</th><th>Availability</th><th>Quality</th><th>Inspect</th></tr></thead>
            <tbody>{drilldown.rawPoints.map((point) => (
              <tr key={point.id}>
                <td>{point.sampledAt}</td><td>{point.viewCount ?? '—'}</td><td>{point.availability}</td><td>{point.viewQuality}</td><td>{point.inspectUsed ? 'yes' : 'no'}</td>
              </tr>
            ))}</tbody>
          </table>
        </details>
      )}
      <p class="muted small">
        Public · yt-dlp · {data.definitionVersion} · {data.timezone} · last run {displayDate(data.coverage.latestRunAt)} · {data.coverage.latestRunCompleteness ?? 'chưa có run'} · {data.coverage.inspectedVideoCount}/{data.coverage.rawPointCount} samples inspected · Data API: not used.
        {data.coverage.truncated ? ' Kết quả đang phân trang; chart này không đại diện toàn bộ lịch sử.' : ''}
      </p>
    </div>
  );
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

function ChannelCard({ channel, globalWatchEnabled }: { channel: SpyChannelSummary; globalWatchEnabled: boolean }) {
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
        {channel.watchStatus && <>
          <span>Completeness: {channel.lastObservationCompleteness ?? '—'} · status: {channel.lastObservationStatus ?? 'chưa có run'}</span>
          <span>24h comparable: {channel.comparableVph24hCount ?? 0} · median: {formatVph(channel.medianVph24h ?? null)} VPH</span>
        </>}
        <span>{watchSchedule(channel, globalWatchEnabled)}</span>
      </div>
    </li>
  );
}

export function SpyChannelsPage({ segment }: { segment: SpyWatchlistSegment }) {
  const [channels, setChannels] = useState<SpyChannelSummary[]>([]);
  const [watchSettings, setWatchSettings] = useState<ChannelWatchSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [result, settings] = await Promise.all([
        api.listSpyWatchlistChannels(LOCAL_DESKTOP_WATCHLIST_ID, segment),
        api.getChannelWatchSettings(),
      ]);
      setChannels(result.channels);
      setWatchSettings(settings);
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
            {channels.map((channel) => <ChannelCard key={channel.youtubeUcId} channel={channel} globalWatchEnabled={watchSettings?.enabled === true} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

export function SpyChannelPage({ youtubeUcId }: { youtubeUcId: string }) {
  const [channel, setChannel] = useState<SpyChannelSummary | null>(null);
  const [vph, setVph] = useState<SpyPublicVphRead | null>(null);
  const [vphWindow, setVphWindow] = useState<'1h' | '24h' | '7d'>('24h');
  const [includeNonComparable, setIncludeNonComparable] = useState(true);
  const [watchSettings, setWatchSettings] = useState<ChannelWatchSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'star' | 'unstar' | 'follow' | 'pause' | 'unfollow' | 'observe' | 'schedule' | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [saved, followed, settings] = await Promise.all([
        api.listSpyWatchlistChannels(LOCAL_DESKTOP_WATCHLIST_ID, 'saved'),
        api.listSpyWatchlistChannels(LOCAL_DESKTOP_WATCHLIST_ID, 'followed'),
        api.getChannelWatchSettings(),
      ]);
      const found = [...saved.channels, ...followed.channels].find((item) => item.youtubeUcId === youtubeUcId);
      setChannel(found ?? null);
      setWatchSettings(settings);
      if (!found) {
        setVph(null);
        setError('Không tìm thấy kênh trong local-desktop watchlist.');
      } else if (found.watchStatus) {
        setVph(await api.getSpyChannelVph(LOCAL_DESKTOP_WATCHLIST_ID, youtubeUcId, { window: vphWindow, includeNonComparable }));
      } else {
        // A saved-only channel is deliberately not a watched competitor, so
        // its relation-scoped VPH endpoint must not be probed (404 is valid).
        setVph(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [youtubeUcId, vphWindow, includeNonComparable]);

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
      } else if (kind === 'observe') {
        await api.observeSpyChannel(LOCAL_DESKTOP_WATCHLIST_ID, channel.youtubeUcId);
        await refresh();
      } else {
        await api.unfollowSpyChannel(LOCAL_DESKTOP_WATCHLIST_ID, channel.youtubeUcId);
        setChannel((current) => current ? { ...current, watchStatus: null, cadence: null, nextDueAt: null } : current);
        setVph(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(null);
    }
  };

  const toggleDailyScheduler = async () => {
    if (!watchSettings) return;
    setAction('schedule');
    setError(null);
    try {
      setWatchSettings(await api.updateChannelWatchSettings({ enabled: !watchSettings.enabled }));
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
          <button class="btn teal" type="button" disabled={action !== null || !watchSettings?.enabled} onClick={() => void runAction('observe')}>
            {action === 'observe' ? 'Đang lấy public sample…' : 'Collect public sample'}
          </button>
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
              <p class="muted">{watchSchedule(channel, watchSettings?.enabled === true)}</p>
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
            <h2 id="spy-channel-data-heading">VPH public theo video</h2>
            <p class="muted">
              VPH dùng chênh lệch view giữa hai lần inspect yt-dlp trên cùng một video. Đây không phải lifetime velocity hay CTR/impression.
            </p>
            <div class="spy-vph-filters" aria-label="VPH filters">
              <label>Cửa sổ
                <select value={vphWindow} onChange={(event) => setVphWindow(event.currentTarget.value as '1h' | '24h' | '7d')}>
                  <option value="24h">24 giờ</option><option value="1h">1 giờ (cần burst)</option><option value="7d">7 ngày</option>
                </select>
              </label>
              <label class="spy-vph-checkbox"><input type="checkbox" checked={includeNonComparable} onChange={(event) => setIncludeNonComparable(event.currentTarget.checked)} /> Hiện cửa sổ không comparable</label>
            </div>
            <VphChart data={vph} />
            <div class="spy-watch-settings">
              <span class={watchSettings?.enabled ? 'chip' : 'chip warn'}>
                Global daily watch: {watchSettings?.enabled ? `on · ${watchSettings.dailyHourLocal} ${watchSettings.timezone}` : 'off'}
              </span>
              <button class="btn secondary" type="button" disabled={action !== null || !watchSettings} onClick={() => void toggleDailyScheduler()}>
                {action === 'schedule' ? 'Đang cập nhật…' : watchSettings?.enabled ? 'Tắt global daily watch' : 'Bật global daily watch'}
              </button>
            </div>
            <p class="muted small">Thiết lập này áp dụng mọi kênh đang Follow với cadence daily; Pause ở từng kênh nếu chỉ muốn dừng một kênh.</p>
            <dl class="spy-channel-facts">
              <div><dt>Cadence</dt><dd>{channel.cadence || '—'}</dd></div>
              <div><dt>Last observed</dt><dd>{displayDate(channel.lastObservedAt)}</dd></div>
              <div><dt>Next due</dt><dd>{watchSettings?.enabled && channel.watchStatus === 'followed' && channel.nextDueAt ? displayDate(channel.nextDueAt) : '— (global watch off hoặc kênh paused)'}</dd></div>
            </dl>
          </section>
        </>
      )}
    </div>
  );
}
