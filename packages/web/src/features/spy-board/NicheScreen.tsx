/**
 * Màn 2 · Ngách — "học video/kênh nào, đào sâu gì?" (plan spy-analyst-workflow §G).
 * Hàng số của ngách → tab con Outlier | Đang lên | Kênh nhỏ. Video có nhãn
 * mức thường ✅/⚠️/🆕; bấm video xem views theo ngày. Kênh: Theo dõi (vào hàng
 * chờ duyệt Inbox) và Gán ngách.
 */
import { useState } from 'preact/hooks';
import {
  api,
  type BoardChannelRow,
  type BoardScorecardRow,
  type BoardVideoRow,
  type BoardVideoView,
} from '../../api.ts';
import { Chip } from '../../components/ui/Chip.tsx';
import { Panel, Row } from '../../components/ui/Layout.tsx';
import { loadChannels, loadVideos } from './data.ts';
import {
  IS_MOCK,
  LoadState,
  Sparkline,
  TierChip,
  fmtInt,
  fmtNum,
  nicheLabel,
  relDate,
  scoreClass,
  useLoad,
} from './lib.tsx';

type SubTab = BoardVideoView | 'channels';

const SUB_TABS: Array<{ key: SubTab; label: string }> = [
  { key: 'outliers', label: 'Outlier' },
  { key: 'rising', label: 'Đang lên (< 7 ngày)' },
  { key: 'channels', label: 'Kênh' },
];

export function NicheScreen({ topicId, niche, niches, score, refreshKey, onChanged }: {
  topicId: string;
  niche: string | null;
  niches: Array<string | null>;
  score: BoardScorecardRow | null;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<SubTab>('outliers');
  const [smallOnly, setSmallOnly] = useState(true);
  const [youngChannels, setYoungChannels] = useState(false);

  return (
    <div class="stack">
      {score && (
        <div class="spy-kpi-row">
          <Kpi label="Sàn view kênh nhỏ" value={fmtInt(score.floorSmall)} />
          <Kpi label="Cỡ mẫu" value={`${score.nSmallChannels} kênh`} sub={`${score.nSmallVideos} video`} />
          <Kpi
            label="Độ lặp"
            value={String(score.repeat.total)}
            sub={`${score.repeat.reliable}✅ ${score.repeat.thin}⚠️ ${score.repeat.niche}🆕`}
          />
          <Kpi label="Outlier 28 ngày" value={String(score.outliers28d)} />
        </div>
      )}

      <Row style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div class="feed-filter-tabs">
          {SUB_TABS.map((t) => (
            <button key={t.key} class={`feed-tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <label class="spy-check">
          <input type="checkbox" checked={smallOnly} onChange={(e) => setSmallOnly((e.target as HTMLInputElement).checked)} />
          Chỉ kênh nhỏ (&lt; 10K subs)
        </label>
        {tab !== 'channels' && (
          <label class="spy-check">
            <input type="checkbox" checked={youngChannels} onChange={(e) => setYoungChannels((e.target as HTMLInputElement).checked)} />
            Kênh &lt; 180 ngày tuổi
          </label>
        )}
      </Row>

      {tab === 'channels'
        ? <ChannelsTable topicId={topicId} niche={niche} niches={niches} smallOnly={smallOnly} refreshKey={refreshKey} onChanged={onChanged} />
        : <VideoGrid topicId={topicId} niche={niche} view={tab} smallOnly={smallOnly} youngChannels={youngChannels} refreshKey={refreshKey} />}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div class="spy-kpi">
      <span class="muted">{label}</span>
      <b class="num">{value}</b>
      {sub && <span class="muted">{sub}</span>}
    </div>
  );
}

// ── Video ───────────────────────────────────────────────────────────────────

function VideoGrid({ topicId, niche, view, smallOnly, youngChannels, refreshKey }: {
  topicId: string;
  niche: string | null;
  view: BoardVideoView;
  smallOnly: boolean;
  youngChannels: boolean;
  refreshKey: number;
}) {
  const state = useLoad(
    () => loadVideos(topicId, niche, { view, smallOnly, youngChannels }),
    [topicId, niche, view, smallOnly, youngChannels, refreshKey],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<BoardVideoRow | null>(null);
  const rows = state.data?.data ?? [];

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <div class="stack">
      <LoadState state={state} empty={!state.loading && !state.error && rows.length === 0} />
      {rows.length > 0 && (
        <Row style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span class="muted" style={{ fontSize: '0.78rem' }}>
            {rows.length} video{state.data?.truncated ? ' (đã cắt bớt)' : ''} · {view === 'rising' ? 'xếp theo views tăng 24h' : 'xếp theo bội số outlier'}
          </span>
          <button
            class="btn teal spy-btn-sm"
            disabled
            title="Đào sâu (kéo comment + transcript) là bước 6 — chưa làm"
          >
            Đào sâu {selected.size} video
          </button>
        </Row>
      )}
      <div class="spy-outlier-grid">
        {rows.map((r) => (
          <div key={r.videoId} class={`spy-outlier-card ${open?.videoId === r.videoId ? 'is-sel' : ''}`} onClick={() => setOpen(open?.videoId === r.videoId ? null : r)}>
            <input
              type="checkbox"
              checked={selected.has(r.videoId)}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggle(r.videoId)}
              aria-label="Chọn để đào sâu"
            />
            <div class="spy-outlier-thumb">
              <img
                src={r.thumbnailUrl ?? `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`}
                alt=""
                loading="lazy"
                onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
              />
            </div>
            <div class="spy-outlier-main">
              <div class="spy-outlier-title">{r.title}</div>
              <div class="muted spy-card-meta">
                <span>{r.channelTitle ?? r.channelId}</span>
                <span>{fmtNum(r.subs)} subs</span>
                {r.channelAgeDays !== null && <span>kênh {r.channelAgeDays} ngày</span>}
                <span>{relDate(r.publishedAt)}</span>
              </div>
              <div class="spy-card-meta">
                <TierChip tier={r.tier} n={r.baselineN} />
                {r.foundByKeyword && <Chip variant="default">{r.foundByKeyword}</Chip>}
              </div>
            </div>
            <div class="spy-outlier-score">
              {view === 'rising'
                ? <span class="num spy-score-cool" style={{ fontSize: '1.05rem', fontWeight: 700 }}>+{fmtNum(r.velocity24h)}/24h</span>
                : <span class={`num ${scoreClass(r.outlierX)}`} style={{ fontSize: '1.15rem', fontWeight: 700 }}>
                    {r.outlierX !== null ? `${r.outlierX.toFixed(1)}x` : '—'}
                  </span>}
              <span class="num muted" style={{ fontSize: '0.72rem' }}>{fmtInt(r.views)} views</span>
              <span class="num muted" style={{ fontSize: '0.68rem' }} title="Mức thường đã dùng để chia">
                thường {fmtNum(r.baselineViews)}
              </span>
            </div>
          </div>
        ))}
      </div>
      {open && <VideoTrend topicId={topicId} video={open} />}
    </div>
  );
}

function VideoTrend({ topicId, video }: { topicId: string; video: BoardVideoRow }) {
  const state = useLoad(async () => {
    if (IS_MOCK) {
      const v = video.views ?? 0;
      return Array.from({ length: 10 }, (_, i) => Math.round((v * (i + 1)) / 10));
    }
    const res = await api.dashVideoTimeseries(topicId, video.videoId);
    return (res.data ?? []).map((p) => p.views);
  }, [topicId, video.videoId]);
  return (
    <Panel class="stack">
      <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ fontSize: '0.88rem' }}>{video.title}</strong>
        <a href={`https://www.youtube.com/watch?v=${video.videoId}`} target="_blank" rel="noreferrer" style={{ fontSize: '0.78rem' }}>
          Mở YouTube ↗
        </a>
      </Row>
      <LoadState state={state} />
      {state.data && <Sparkline points={state.data} width={640} height={80} />}
      <p class="muted" style={{ margin: 0, fontSize: '0.75rem' }}>Views theo ngày (mỗi ngày một ảnh chụp).</p>
    </Panel>
  );
}

// ── Kênh ────────────────────────────────────────────────────────────────────

const STATE_LABEL: Record<BoardChannelRow['state'], string> = {
  following: 'Đang theo dõi',
  pending: 'Chờ duyệt (Inbox)',
  paused: 'Tạm dừng',
  measured: 'Chỉ đo',
};

function ChannelsTable({ topicId, niche, niches, smallOnly, refreshKey, onChanged }: {
  topicId: string;
  niche: string | null;
  niches: Array<string | null>;
  smallOnly: boolean;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [bump, setBump] = useState(0);
  const state = useLoad(() => loadChannels(topicId, niche, smallOnly), [topicId, niche, smallOnly, refreshKey, bump]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = state.data?.data ?? [];

  const act = async (id: string, fn: () => Promise<string>) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      setBump((b) => b + 1);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const follow = (c: BoardChannelRow) => act(c.channelId, async () => {
    if (IS_MOCK) return `(mock) Đã đưa ${c.title} vào hàng chờ duyệt`;
    const res = await api.addManualCandidates(topicId, [c.channelId]);
    return res.added > 0 ? `Đã đưa ${c.title ?? c.channelId} vào hàng chờ duyệt (tab Inbox)` : `${c.title ?? c.channelId} đã có trong sổ`;
  });

  const assign = (c: BoardChannelRow, value: string) => act(c.channelId, async () => {
    const target = value === '_none' ? null : value;
    if (IS_MOCK) return `(mock) Đã gán ${c.title} → ${nicheLabel(target)}`;
    await api.boardAssignNiche(topicId, [c.channelId], target);
    return `Đã gán ${c.title ?? c.channelId} → ${nicheLabel(target)}`;
  });

  return (
    <div class="stack">
      <LoadState state={state} empty={!state.loading && !state.error && rows.length === 0} />
      {notice && <p class="ok" style={{ margin: 0, fontSize: '0.82rem' }}>{notice}</p>}
      {error && <p class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{error}</p>}
      {rows.length > 0 && (
        <div class="spy-table-wrap">
          <table class="spy-kw-table">
            <thead>
              <tr>
                <th>Kênh</th>
                <th class="num">Subs</th>
                <th class="num">Tuổi kênh</th>
                <th>Mức thường</th>
                <th class="num">Outlier 28d</th>
                <th class="num">Cao nhất</th>
                <th>Trạng thái</th>
                <th>Ngách</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.channelId}>
                  <td>
                    <a href={`https://www.youtube.com/channel/${c.channelId}`} target="_blank" rel="noreferrer">{c.title ?? c.channelId}</a>
                    {c.dead && <Chip variant="bad" style={{ marginLeft: '0.35rem' }}>kênh chết</Chip>}
                  </td>
                  <td class="num">{fmtNum(c.subs)}</td>
                  <td class="num">{c.channelAgeDays !== null ? `${c.channelAgeDays} ngày` : '—'}</td>
                  <td>
                    <span class="num">{fmtNum(c.baselineViews)}</span>{' '}
                    {/* < 3 video khác: video của kênh được so với sàn ngách (🆕). */}
                    <TierChip tier={c.tier ?? (c.baselineN < 3 ? 'niche' : null)} n={c.baselineN} />
                  </td>
                  <td class="num">{c.outliers28d}</td>
                  <td class={`num ${scoreClass(c.bestOutlierX)}`}>{c.bestOutlierX !== null ? `${c.bestOutlierX.toFixed(1)}x` : '—'}</td>
                  <td>
                    {c.state === 'measured'
                      ? <button class="btn secondary spy-btn-sm" disabled={busy === c.channelId} onClick={() => void follow(c)}>Theo dõi</button>
                      : <span class="muted">{STATE_LABEL[c.state]}</span>}
                  </td>
                  <td>
                    <select
                      class="input spy-select-sm"
                      value={c.niche ?? '_none'}
                      disabled={busy === c.channelId}
                      onChange={(e) => void assign(c, (e.target as HTMLSelectElement).value)}
                    >
                      {niches.map((n) => <option key={n ?? '_none'} value={n ?? '_none'}>{nicheLabel(n)}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
