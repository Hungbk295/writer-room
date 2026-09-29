/**
 * Màn 1 · Chọn tệp — "tệp nào?" (plan spy-analyst-workflow §G).
 * Mỗi ngách một thẻ: sàn view kênh nhỏ (số to, tiêu chí thắng) + so với 7 ngày
 * trước, cỡ mẫu, độ lặp tách ✅/⚠️/🆕, outlier 28 ngày, trạng thái luật dừng.
 * Dưới: sàn view theo ngày của các ngách chồng lên nhau. Bấm thẻ → Màn 2.
 */
import type { BoardScorecardRow } from '../../api.ts';
import { Panel } from '../../components/ui/Layout.tsx';
import { MultiLineChart, SERIES_COLORS, fmtInt, nicheLabel } from './lib.tsx';

function Delta({ cur, prev }: { cur: number | null; prev: number | null }) {
  if (cur === null || prev === null || prev <= 0) return <span class="muted">— so với 7 ngày trước</span>;
  const pct = ((cur - prev) / prev) * 100;
  const cls = pct > 3 ? 'ok' : pct < -3 ? 'error' : 'muted';
  const arrow = pct > 3 ? '↑' : pct < -3 ? '↓' : '=';
  return <span class={cls}>{arrow} {Math.abs(pct).toFixed(0)}% so với 7 ngày trước</span>;
}

function StopBadge({ stop }: { stop: BoardScorecardRow['stop'] }) {
  if (stop.ready) return <span class="spy-stop ready">Đủ tin cậy</span>;
  const need = stop.smallMeasured < stop.need
    ? `${stop.smallMeasured}/${stop.need} kênh nhỏ`
    : `thứ hạng ổn định ${stop.rankStableDays}/14 ngày`;
  return <span class="spy-stop">Chưa đủ · {need}</span>;
}

export function ScorecardScreen({ rows, onOpenNiche }: {
  rows: BoardScorecardRow[];
  onOpenNiche: (niche: string | null) => void;
}) {
  // Ngách có sàn cao nhất lên trước; "chưa gán" luôn cuối.
  const sorted = [...rows].sort((a, b) => {
    if (a.niche === null) return 1;
    if (b.niche === null) return -1;
    return (b.floorSmall ?? -1) - (a.floorSmall ?? -1);
  });
  const named = sorted.filter((r) => r.niche !== null);

  return (
    <div class="stack">
      <div class="spy-niche-cards">
        {sorted.map((r) => (
          <button key={r.niche ?? '_none'} class={`spy-niche-card ${r.niche === null ? 'is-none' : ''}`} onClick={() => onOpenNiche(r.niche)}>
            <div class="spy-niche-card-head">
              <strong>{nicheLabel(r.niche)}</strong>
              <StopBadge stop={r.stop} />
            </div>
            <div class="spy-niche-floor num">{fmtInt(r.floorSmall)}</div>
            <div class="muted spy-niche-sub">views sàn của kênh nhỏ · <Delta cur={r.floorSmall} prev={r.floorSmall7dAgo} /></div>
            <div class="spy-niche-stats">
              <div>
                <span class="muted">Cỡ mẫu</span>
                <b>{r.nSmallChannels} kênh</b>
                <span class="muted">{r.nSmallVideos} video</span>
              </div>
              <div title="Số kênh nhỏ khác nhau có outlier trong 28 ngày">
                <span class="muted">Độ lặp</span>
                <b>{r.repeat.total} kênh</b>
                <span class="muted">{r.repeat.reliable}✅ {r.repeat.thin}⚠️ {r.repeat.niche}🆕</span>
              </div>
              <div>
                <span class="muted">Outlier 28d</span>
                <b>{r.outliers28d}</b>
              </div>
            </div>
          </button>
        ))}
      </div>

      <Panel class="stack">
        <div>
          <strong>Sàn view kênh nhỏ theo ngày</strong>
          <p class="muted" style={{ margin: '0.2rem 0 0', fontSize: '0.78rem' }}>
            Mỗi kênh nhỏ một phiếu: median views của từng kênh, rồi median giữa các kênh.
          </p>
        </div>
        <MultiLineChart
          series={named.map((r) => ({
            label: nicheLabel(r.niche),
            points: r.history.map((h) => ({ day: h.day, value: h.floorSmall })),
          }))}
        />
        <div class="spy-legend">
          {named.map((r, i) => (
            <span key={r.niche ?? '_none'}>
              <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              {nicheLabel(r.niche)}
            </span>
          ))}
        </div>
      </Panel>
    </div>
  );
}
