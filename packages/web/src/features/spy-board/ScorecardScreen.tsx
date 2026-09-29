/**
 * Màn 1 · Chọn tệp — "tệp nào?" (plan spy-analyst-workflow §G).
 * Mỗi ngách một thẻ số liệu: sàn view kênh nhỏ (số to, tiêu chí thắng) + so với
 * 7 ngày trước, cỡ mẫu, độ lặp tách ✅/⚠️/🆕, outlier 28 ngày, trạng thái luật dừng.
 * Dưới: biểu đồ sàn view theo ngày + bảng xếp hạng tệp. Bấm thẻ/hàng → Màn 2.
 */
import { useState } from 'preact/hooks';
import type { BoardScorecardRow } from '../../api.ts';
import { PromptComposer, validTemplates } from './PromptComposer.tsx';
import { Badge, Icon, IconBox, MultiLineChart, SERIES_COLORS, fmtInt, nicheLabel } from './lib.tsx';

function pctOf(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

function Delta({ cur, prev, withLabel }: { cur: number | null; prev: number | null; withLabel?: boolean }) {
  const pct = pctOf(cur, prev);
  if (pct === null) return <span class="sb-hint">— so với 7 ngày trước</span>;
  const tone = pct > 3 ? 'success' : pct < -3 ? 'danger' : 'secondary';
  return (
    <>
      <Badge tone={tone}>
        {pct > 3 && <Icon name="up" size={12} />}
        {pct < -3 && <Icon name="down" size={12} />}
        {pct >= -3 && pct <= 3 ? '=' : ''} {Math.abs(pct).toFixed(0)}%
      </Badge>
      {withLabel && <span class="sb-hint">so với 7 ngày trước</span>}
    </>
  );
}

function StopBadge({ stop }: { stop: BoardScorecardRow['stop'] }) {
  if (stop.ready) return <Badge tone="success">Đủ tin cậy</Badge>;
  const need = stop.smallMeasured < stop.need
    ? `${stop.smallMeasured}/${stop.need} kênh nhỏ`
    : `thứ hạng ổn định ${stop.rankStableDays}/14 ngày`;
  return <Badge tone="warning">Chưa đủ · {need}</Badge>;
}

export function ScorecardScreen({ topicId, rows, onOpenNiche }: {
  topicId: string;
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
  const [composing, setComposing] = useState(false);

  return (
    <div class="sb-stack">
      <div class="sb-bar">
        <span class="sb-hint">Bấm một thẻ để xem ngách; hoặc nhờ agent so sánh tất cả các tệp.</span>
        <button class="sb-btn secondary" onClick={() => setComposing(!composing)}>
          <Icon name="sparkles" size={16} />Soạn prompt: So sánh tệp
        </button>
      </div>
      {composing && (
        <PromptComposer
          topicId={topicId}
          templates={validTemplates('niches', {})}
          niche={undefined}
          selection={{}}
          summary={`Mọi ngách (${named.length}${sorted.length > named.length ? ' + chưa gán' : ''}) — agent tự đọc bảng điểm.`}
          onClose={() => setComposing(false)}
        />
      )}
      <div class="sb-grid sb-grid-4">
        {sorted.map((r) => (
          <button
            key={r.niche ?? '_none'}
            class={`sb-card sb-stat sb-clickable ${r.niche === null ? 'is-none' : ''}`}
            onClick={() => onOpenNiche(r.niche)}
          >
            <div class="sb-stat-top">
              <div class="sb-stat-main">
                <div class="sb-stat-label">{nicheLabel(r.niche)}</div>
                <div class="sb-stat-value">{fmtInt(r.floorSmall)}</div>
              </div>
              <IconBox tone={r.stop.ready ? 'success' : 'warning'} name="trending" />
            </div>
            <div class="sb-stat-row">
              <Delta cur={r.floorSmall} prev={r.floorSmall7dAgo} withLabel />
            </div>
            <div class="sb-stat-foot">
              <div class="sb-hint">views sàn của kênh nhỏ</div>
              <div class="sb-stat-meta">
                <span>{r.nSmallChannels} kênh · {r.nSmallVideos} video</span>
                <span title="Số kênh nhỏ khác nhau có outlier trong 28 ngày">
                  Độ lặp {r.repeat.total}: {r.repeat.reliable}✅ {r.repeat.thin}⚠️ {r.repeat.niche}🆕
                </span>
                <span>Outlier 28d: <b>{r.outliers28d}</b></span>
              </div>
              <StopBadge stop={r.stop} />
            </div>
          </button>
        ))}
      </div>

      <div class="sb-grid sb-grid-2">
        <section class="sb-card">
          <h2 class="sb-h2">Sàn view kênh nhỏ theo ngày</h2>
          <p class="sb-hint sb-card-sub">
            Mỗi kênh nhỏ một phiếu: median views của từng kênh, rồi median giữa các kênh.
          </p>
          <MultiLineChart
            series={named.map((r) => ({
              label: nicheLabel(r.niche),
              points: r.history.map((h) => ({ day: h.day, value: h.floorSmall })),
            }))}
          />
          <div class="sb-legend">
            {named.map((r, i) => (
              <span key={r.niche ?? '_none'}>
                <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                {nicheLabel(r.niche)}
              </span>
            ))}
          </div>
        </section>

        <section class="sb-card">
          <h2 class="sb-h2">Xếp hạng tệp</h2>
          <div class="sb-list">
            {sorted.map((r) => (
              <button key={r.niche ?? '_none'} class="sb-list-row" onClick={() => onOpenNiche(r.niche)}>
                <div class="sb-list-main">
                  <div class="sb-list-title">{nicheLabel(r.niche)}</div>
                  <div class="sb-list-sub">{r.nSmallChannels} kênh · {r.nSmallVideos} video</div>
                </div>
                <div class="sb-list-side">
                  <div class="sb-list-value">{fmtInt(r.floorSmall)}</div>
                  <RankDelta cur={r.floorSmall} prev={r.floorSmall7dAgo} />
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Delta dạng chữ + mũi tên như "Top Products" của TailPanel. */
function RankDelta({ cur, prev }: { cur: number | null; prev: number | null }) {
  const pct = pctOf(cur, prev);
  if (pct === null) return <span class="sb-delta flat">—</span>;
  const cls = pct > 3 ? 'up' : pct < -3 ? 'down' : 'flat';
  return (
    <span class={`sb-delta ${cls}`}>
      {cls === 'up' && <Icon name="up" size={12} />}
      {cls === 'down' && <Icon name="down" size={12} />}
      {cls === 'flat' ? '=' : ''} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}
