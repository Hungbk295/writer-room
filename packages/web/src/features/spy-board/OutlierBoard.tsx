/**
 * Panel Outlier board — video outlier từ /dash/outliers, toggle scope
 * all|followed|external, filter theo keyword, group theo found_by_keyword
 * để thấy keyword nào đang sinh outlier. Click video → timeseries sparkline.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  api,
  type DashOutlierRow,
  type DashOutlierScope,
  type DashVideoDayPoint,
} from '../../api.ts';
import { Input } from '../../components/ui/Forms.tsx';
import { Chip } from '../../components/ui/Chip.tsx';
import { Panel, Row } from '../../components/ui/Layout.tsx';
import { IS_MOCK, fmtInt, fmtDay, relDate, Sparkline } from './lib.tsx';

const SCOPES: Array<{ key: DashOutlierScope; label: string }> = [
  { key: 'all', label: 'Tất cả' },
  { key: 'followed', label: 'Kênh follow' },
  { key: 'external', label: 'Kênh ngoài' },
];

function scopeChip(scope: string | null | undefined) {
  if (scope === 'followed') return <Chip variant="writer">followed</Chip>;
  if (scope === 'external') return <Chip variant="other">external</Chip>;
  return <Chip variant="default">{scope ?? '—'}</Chip>;
}

function scoreClass(score: number | null | undefined): string {
  if (score == null) return 'muted';
  if (score >= 8) return 'spy-score-hot';
  if (score >= 4) return 'spy-score-warm';
  return 'spy-score-cool';
}

export function OutlierBoardPanel({ topicId, refreshKey }: { topicId: string; refreshKey: number }) {
  const [scope, setScope] = useState<DashOutlierScope>('all');
  const [kwInput, setKwInput] = useState('');
  const [kw, setKw] = useState('');
  const [rows, setRows] = useState<DashOutlierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flat, setFlat] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [ts, setTs] = useState<DashVideoDayPoint[] | null>(null);
  const [tsLoading, setTsLoading] = useState(false);
  const [tsErr, setTsErr] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  const load = async (keyword: string, s: DashOutlierScope) => {
    setLoading(true);
    try {
      if (IS_MOCK) {
        const { MOCK_DASH_OUTLIERS } = await import('./mock.ts');
        setRows(
          MOCK_DASH_OUTLIERS.filter(
            (r) => (s === 'all' || r.scope === s) && (keyword === '' || r.found_by_keyword?.includes(keyword) || r.title.toLowerCase().includes(keyword.toLowerCase())),
          ),
        );
      } else {
        const res = await api.dashOutliers(topicId, {
          scope: s,
          ...(keyword ? { keyword } : {}),
          limit: 100,
        });
        setRows(res.data ?? []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelId(null);
    setTs(null);
    void load(kw, scope);
  }, [topicId, scope, refreshKey]);

  // Debounce filter theo keyword
  useEffect(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setKw(kwInput.trim()), 350);
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    };
  }, [kwInput]);

  useEffect(() => {
    if (!loading) void load(kw, scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw]);

  const groups = useMemo(() => {
    const map = new Map<string, DashOutlierRow[]>();
    for (const r of rows) {
      const k = r.found_by_keyword ?? '(không rõ keyword)';
      const arr = map.get(k);
      if (arr) arr.push(r);
      else map.set(k, [r]);
    }
    // group nhiều outlier nhất lên đầu
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [rows]);

  const openVideo = async (videoId: string) => {
    if (selId === videoId) {
      setSelId(null);
      setTs(null);
      return;
    }
    setSelId(videoId);
    setTs(null);
    setTsErr(null);
    setTsLoading(true);
    try {
      if (IS_MOCK) {
        const { mockVideoTs } = await import('./mock.ts');
        setTs(mockVideoTs(videoId));
      } else {
        const res = await api.dashVideoTimeseries(topicId, videoId);
        setTs(res.data ?? []);
      }
    } catch (err) {
      setTsErr(err instanceof Error ? err.message : String(err));
    } finally {
      setTsLoading(false);
    }
  };

  const renderCard = (r: DashOutlierRow) => (
    <button
      key={r.video_id}
      class={`spy-outlier-card ${selId === r.video_id ? 'is-sel' : ''}`}
      onClick={() => void openVideo(r.video_id)}
    >
      <div class="spy-outlier-thumb">
        <img
          src={`https://i.ytimg.com/vi/${r.video_id}/hqdefault.jpg`}
          alt=""
          loading="lazy"
          onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
        />
      </div>
      <div class="spy-outlier-main">
        <div class="spy-outlier-title">{r.title}</div>
        <div class="muted" style={{ fontSize: '0.72rem', display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{r.channel_title ?? r.channel_id ?? '?'}</span>
          {scopeChip(r.scope)}
          <span>{relDate(r.published_at)}</span>
          {flat && r.found_by_keyword && <Chip variant="default">{r.found_by_keyword}</Chip>}
        </div>
      </div>
      <div class="spy-outlier-score">
        <span class={`num ${scoreClass(r.outlier_score)}`} style={{ fontSize: '1.15rem', fontWeight: 700 }}>
          ×{r.outlier_score != null ? r.outlier_score.toFixed(1) : '—'}
        </span>
        <span class="num muted" style={{ fontSize: '0.72rem' }}>{fmtInt(r.latest_views)} views</span>
      </div>
    </button>
  );

  const selRow = rows.find((r) => r.video_id === selId) ?? null;

  return (
    <Panel class="stack" style={{ margin: '0 0 1rem' }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Outlier board</h2>
          <p class="muted" style={{ fontSize: '0.78rem', margin: '0.2rem 0 0' }}>
            {rows.length} outlier · group theo keyword để biết key nào đang sinh hit · click video xem timeseries
          </p>
        </div>
        <Row style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Input
            value={kwInput}
            onInput={(e) => setKwInput((e.target as HTMLInputElement).value)}
            placeholder="lọc theo keyword/title…"
            style={{ width: '11rem', height: '1.9rem', fontSize: '0.8rem' }}
          />
          <div class="feed-filter-tabs">
            {SCOPES.map((s) => (
              <button key={s.key} class={`feed-tab-btn ${scope === s.key ? 'active' : ''}`} onClick={() => setScope(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
          <button
            class="btn secondary"
            style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem', minHeight: 0, height: 'auto' }}
            onClick={() => setFlat((v) => !v)}
          >
            {flat ? 'Group theo keyword' : 'Bảng phẳng'}
          </button>
          <button class="btn secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem', minHeight: 0, height: 'auto' }}
            disabled={loading} onClick={() => void load(kw, scope)}>
            ⟳
          </button>
        </Row>
      </Row>

      {error && <p class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{error}</p>}

      {loading && rows.length === 0 && (
        <div class="stack" style={{ gap: '0.4rem' }}>
          {[0, 1].map((i) => <div key={i} class="spy-skel" />)}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <p class="muted" style={{ fontSize: '0.85rem' }}>
          Chưa có outlier{kw ? ` cho «${kw}»` : ''}{scope !== 'all' ? ` scope ${scope}` : ''}.
          Chạy run keyword hoặc nới filter để có thêm dữ liệu.
        </p>
      )}

      {flat
        ? <div class="spy-outlier-grid">{rows.map(renderCard)}</div>
        : groups.map(([g, list]) => (
            <div key={g} style={{ marginBottom: '0.6rem' }}>
              <Row style={{ gap: '0.4rem', alignItems: 'center', margin: '0.2rem 0 0.35rem' }}>
                <Chip variant="default">{g}</Chip>
                <span class="muted" style={{ fontSize: '0.72rem' }}>{list.length} outlier</span>
              </Row>
              <div class="spy-outlier-grid">{list.map(renderCard)}</div>
            </div>
          ))}

      {selRow && (
        <div style={{ border: '1px solid var(--teal)', borderRadius: '10px', padding: '0.7rem 0.9rem', background: 'rgba(31,138,122,0.05)' }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: '0.88rem' }}>{selRow.title}</strong>
            <button class="btn secondary" style={{ fontSize: '0.72rem', padding: '0.15rem 0.6rem', minHeight: 0, height: 'auto' }} onClick={() => { setSelId(null); setTs(null); }}>✕</button>
          </Row>
          <p class="muted" style={{ fontSize: '0.75rem', margin: '0.25rem 0 0.4rem' }}>
            {selRow.channel_title} · {fmtInt(selRow.latest_views)} views · ×{selRow.outlier_score?.toFixed(1) ?? '—'} vs baseline {fmtInt(selRow.baseline_median_views)}
            {selRow.found_by_keyword && <> · key «{selRow.found_by_keyword}»</>}
          </p>
          {tsLoading && <div class="spy-skel" />}
          {tsErr && <p class="error" style={{ margin: 0, fontSize: '0.78rem' }}>{tsErr}</p>}
          {ts && ts.length > 0 && (
            <>
              <Sparkline points={ts.map((p) => p.views)} width={560} height={70} />
              <div style={{ overflowX: 'auto' }}>
                <table class="spy-kw-table" style={{ marginTop: '0.4rem' }}>
                  <thead>
                    <tr><th>Ngày</th><th class="num">Views</th><th class="num">+24h</th><th class="num">Likes</th><th class="num">Cmt</th></tr>
                  </thead>
                  <tbody>
                    {ts.map((p) => (
                      <tr key={p.day}>
                        <td class="muted">{fmtDay(p.day)}</td>
                        <td class="num">{fmtInt(p.views)}</td>
                        <td class="num">{fmtInt(p.views_gained)}</td>
                        <td class="num">{fmtInt(p.likes)}</td>
                        <td class="num">{fmtInt(p.comments)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {ts && ts.length === 0 && <p class="muted" style={{ fontSize: '0.8rem' }}>Chưa có timeseries cho video này.</p>}
        </div>
      )}
    </Panel>
  );
}
