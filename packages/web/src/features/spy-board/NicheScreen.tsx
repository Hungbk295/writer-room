/**
 * Màn 2 · Ngách — "học video/kênh nào, đào sâu gì?" (plan spy-analyst-workflow §G).
 * Hàng số của ngách → tab con Outlier | Đang lên | Kênh nhỏ. Video có nhãn
 * mức thường ✅/⚠️/🆕; bấm video xem views theo ngày. Kênh: Theo dõi (vào hàng
 * chờ duyệt Inbox) và Gán ngách. Giao diện TailPanel — CSS ở board.css.
 */
import { useState } from 'preact/hooks';
import {
  api,
  type BoardChannelRow,
  type BoardScorecardRow,
  type BoardVideoRow,
  type BoardVideoView,
} from '../../api.ts';
import { loadChannels, loadVideos } from './data.ts';
import {
  Badge,
  Icon,
  IconBox,
  type IconName,
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
    <div class="sb-stack">
      {score && (
        <div class="sb-grid sb-grid-4">
          <Kpi label="Sàn view kênh nhỏ" value={fmtInt(score.floorSmall)} icon="trending" tone="success" />
          <Kpi label="Cỡ mẫu" value={`${score.nSmallChannels} kênh`} sub={`${score.nSmallVideos} video`} icon="users" tone="primary" />
          <Kpi
            label="Độ lặp"
            value={String(score.repeat.total)}
            sub={`${score.repeat.reliable}✅ ${score.repeat.thin}⚠️ ${score.repeat.niche}🆕`}
            icon="repeat"
            tone="warning"
          />
          <Kpi label="Outlier 28 ngày" value={String(score.outliers28d)} icon="zap" tone="secondary" />
        </div>
      )}

      <div class="sb-card sb-toolbar">
        <div class="sb-tabs">
          {SUB_TABS.map((t) => (
            <button key={t.key} class={`sb-nav-item ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <div class="sb-toolbar-checks">
          <label class="sb-check">
            <input type="checkbox" checked={smallOnly} onChange={(e) => setSmallOnly((e.target as HTMLInputElement).checked)} />
            Chỉ kênh nhỏ (&lt; 10K subs)
          </label>
          {tab !== 'channels' && (
            <label class="sb-check">
              <input type="checkbox" checked={youngChannels} onChange={(e) => setYoungChannels((e.target as HTMLInputElement).checked)} />
              Kênh &lt; 180 ngày tuổi
            </label>
          )}
        </div>
      </div>

      {tab === 'channels'
        ? <ChannelsTable topicId={topicId} niche={niche} niches={niches} smallOnly={smallOnly} refreshKey={refreshKey} onChanged={onChanged} />
        : <VideoGrid topicId={topicId} niche={niche} view={tab} smallOnly={smallOnly} youngChannels={youngChannels} refreshKey={refreshKey} />}
    </div>
  );
}

function Kpi({ label, value, sub, icon, tone }: {
  label: string;
  value: string;
  sub?: string;
  icon: IconName;
  tone: 'success' | 'primary' | 'warning' | 'secondary';
}) {
  return (
    <div class="sb-card sb-stat">
      <div class="sb-stat-top">
        <div class="sb-stat-main">
          <div class="sb-stat-label">{label}</div>
          <div class="sb-stat-value">{value}</div>
        </div>
        <IconBox tone={tone} name={icon} />
      </div>
      {sub && <div class="sb-stat-row"><span class="sb-hint">{sub}</span></div>}
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
    <div class="sb-stack">
      <LoadState state={state} empty={!state.loading && !state.error && rows.length === 0} />
      {rows.length > 0 && (
        <div class="sb-bar">
          <span class="sb-hint">
            {rows.length} video{state.data?.truncated ? ' (đã cắt bớt)' : ''} · {view === 'rising' ? 'xếp theo views tăng 24h' : 'xếp theo bội số outlier'}
          </span>
          <button
            class="sb-btn primary"
            disabled
            title="Đào sâu (kéo comment + transcript) là bước 6 — chưa làm"
          >
            <Icon name="layers" size={16} />Đào sâu {selected.size} video
          </button>
        </div>
      )}
      <div class="sb-grid sb-grid-videos">
        {rows.map((r) => (
          <article key={r.videoId} class={`sb-card sb-video sb-clickable ${open?.videoId === r.videoId ? 'is-sel' : ''}`} onClick={() => setOpen(open?.videoId === r.videoId ? null : r)}>
            <div class="sb-thumb">
              <span class="sb-thumb-ph"><Icon name="image" size={32} /></span>
              <img
                src={r.thumbnailUrl ?? `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`}
                alt=""
                loading="lazy"
                onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
              />
              <label class="sb-pick" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(r.videoId)}
                  onChange={() => toggle(r.videoId)}
                  aria-label="Chọn để đào sâu"
                />
              </label>
            </div>
            <h3 class="sb-video-title">{r.title}</h3>
            <div class="sb-video-meta">
              {r.channelTitle ?? r.channelId} • {fmtNum(r.subs)} subs
              {r.channelAgeDays !== null && <> • kênh {r.channelAgeDays} ngày</>} • {relDate(r.publishedAt)}
            </div>
            <div class="sb-video-value-row">
              {/* Video < 7 ngày không chấm outlier (plan §B4) — số chính của tab
                  Đang lên là views tăng 24h; bội số chỉ để tham khảo bên dưới. */}
              {view === 'rising'
                ? <span class="sb-video-value sb-up">+{fmtNum(r.velocity24h)}/24h</span>
                : <span class={`sb-video-value ${scoreClass(r.outlierX)}`}>{r.outlierX !== null ? `${r.outlierX.toFixed(1)}x` : '—'}</span>}
              <TierChip tier={r.tier} n={r.baselineN} />
            </div>
            <dl class="sb-kv">
              <div><dt>Views:</dt><dd>{fmtInt(r.views)}</dd></div>
              <div title="Mức thường đã dùng để chia"><dt>Mức thường:</dt><dd>{fmtNum(r.baselineViews)}</dd></div>
              {view === 'rising' && <div title="Chưa tính là outlier vì video < 7 ngày"><dt>Bội số hiện tại:</dt><dd>{r.outlierX !== null ? `${r.outlierX.toFixed(1)}x` : '—'}</dd></div>}
            </dl>
            {r.foundByKeyword && <div class="sb-video-kw"><Badge>{r.foundByKeyword}</Badge></div>}
          </article>
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
    <section class="sb-card">
      <div class="sb-bar">
        <h2 class="sb-h2">{video.title}</h2>
        <a class="sb-link" href={`https://www.youtube.com/watch?v=${video.videoId}`} target="_blank" rel="noreferrer">
          Mở YouTube ↗
        </a>
      </div>
      <LoadState state={state} />
      {state.data && <Sparkline points={state.data} width={640} height={80} />}
      <p class="sb-hint sb-card-sub">Views theo ngày (mỗi ngày một ảnh chụp).</p>
    </section>
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
    <div class="sb-stack">
      <LoadState state={state} empty={!state.loading && !state.error && rows.length === 0} />
      {notice && <div class="sb-alert ok">{notice}</div>}
      {error && <div class="sb-alert">{error}</div>}
      {rows.length > 0 && (
        <section class="sb-card sb-card-flush">
          <div class="sb-table-wrap">
            <table class="sb-table">
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
                      <a class="sb-link" href={`https://www.youtube.com/channel/${c.channelId}`} target="_blank" rel="noreferrer">{c.title ?? c.channelId}</a>
                      {c.dead && <Badge tone="danger" class="sb-ml">kênh chết</Badge>}
                    </td>
                    <td class="num">{fmtNum(c.subs)}</td>
                    <td class="num">{c.channelAgeDays !== null ? `${c.channelAgeDays} ngày` : '—'}</td>
                    <td>
                      <span class="sb-mr">{fmtNum(c.baselineViews)}</span>
                      {/* < 3 video khác: video của kênh được so với sàn ngách (🆕). */}
                      <TierChip tier={c.tier ?? (c.baselineN < 3 ? 'niche' : null)} n={c.baselineN} />
                    </td>
                    <td class="num">{c.outliers28d}</td>
                    <td class={`num ${scoreClass(c.bestOutlierX)}`}>{c.bestOutlierX !== null ? `${c.bestOutlierX.toFixed(1)}x` : '—'}</td>
                    <td>
                      {c.state === 'measured'
                        ? <button class="sb-btn secondary sm" disabled={busy === c.channelId} onClick={() => void follow(c)}>Theo dõi</button>
                        : <span class="sb-hint">{STATE_LABEL[c.state]}</span>}
                    </td>
                    <td>
                      <select
                        class="sb-select"
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
        </section>
      )}
    </div>
  );
}
