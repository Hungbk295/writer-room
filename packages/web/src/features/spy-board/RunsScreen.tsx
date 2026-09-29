/**
 * Màn 4 · Lượt chạy — "có tốn quota vô ích không?" (plan spy-analyst-workflow §G).
 * Sổ lượt chạy gộp Theo dõi (tự động) + Tìm mới/Đào sâu (người bấm). Bấm một
 * thẻ → từng keyword/video, kể cả mục bị bỏ qua và lý do. Giao diện TailPanel
 * (list kiểu Recent Orders) — CSS ở board.css.
 */
import { useState } from 'preact/hooks';
import type { BoardRunCard, BoardRunType } from '../../api.ts';
import { loadRunDetail, loadRuns } from './data.ts';
import {
  Badge,
  LoadState,
  RUN_TYPE_LABEL,
  fmtInt,
  nicheLabel,
  relDate,
  runStatusChip,
  useLoad,
} from './lib.tsx';

const TYPE_FILTERS: Array<{ key: BoardRunType | ''; label: string }> = [
  { key: '', label: 'Tất cả' },
  { key: 'discover', label: 'Tìm mới' },
  { key: 'track', label: 'Theo dõi' },
  { key: 'weekly', label: 'Tìm mới (tuần)' },
  { key: 'deepdive', label: 'Đào sâu' },
];

const TRIGGER_LABEL: Record<string, string> = { human: 'anh bấm', loop: 'máy', agent: 'agent' };

const SKIP_LABEL: Record<string, string> = {
  comments_present: 'đã có comment',
  transcript_present: 'đã có transcript',
};

/** skip_reason có thể ghép nhiều lý do bằng dấu phẩy (Đào sâu). */
function skipLabel(reason: string | null): string {
  if (!reason) return '';
  return reason.split(',').map((part) => {
    const m = part.match(/^searched_at:(.+)$/);
    if (m) return `đã search ${relDate(m[1])}`;
    return SKIP_LABEL[part] ?? part;
  }).join(' · ');
}

export function RunsScreen({ topicId, refreshKey }: { topicId: string; refreshKey: number }) {
  const [type, setType] = useState<BoardRunType | ''>('');
  const state = useLoad(() => loadRuns(topicId, type || undefined), [topicId, type, refreshKey]);
  const [open, setOpen] = useState<string | null>(null);
  const rows = state.data?.data ?? [];

  return (
    <div class="sb-stack">
      <div class="sb-tabs">
        {TYPE_FILTERS.map((t) => (
          <button key={t.key} class={`sb-nav-item ${type === t.key ? 'active' : ''}`} onClick={() => setType(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <LoadState state={state} empty={!state.loading && !state.error && rows.length === 0} />
      {rows.length > 0 && (
        <section class="sb-card sb-card-flush">
          <div class="sb-list sb-list-flush">
            {rows.map((c) => (
              <RunCard key={c.runId} card={c} open={open === c.runId} onToggle={() => setOpen(open === c.runId ? null : c.runId)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function RunCard({ card, open, onToggle }: { card: BoardRunCard; open: boolean; onToggle: () => void }) {
  const sub = [
    RUN_TYPE_LABEL[card.type],
    card.niche !== null ? `ngách ${nicheLabel(card.niche)}` : null,
    TRIGGER_LABEL[card.triggeredBy] ?? card.triggeredBy,
    relDate(card.startedAt),
    card.nNew !== null ? `${fmtInt(card.nNew)} video mới` : null,
    card.newChannels > 0 ? `${card.newChannels} kênh đề xuất` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div class={`sb-run ${open ? 'is-open' : ''}`}>
      <button class="sb-list-row" onClick={onToggle} aria-expanded={open}>
        <div class="sb-list-main">
          <div class="sb-list-title">{card.note ?? '—'}</div>
          <div class="sb-list-sub">{sub}</div>
          {card.error && <div class="sb-run-error">{card.error}</div>}
        </div>
        <div class="sb-list-side">
          <div class="sb-list-value">{card.searchCalls} search · {fmtInt(card.units)} unit</div>
          <div class="sb-badges">
            {card.nSkipped ? <Badge tone="warning">{card.nSkipped} bỏ qua</Badge> : null}
            {runStatusChip(card.status)}
          </div>
        </div>
      </button>
      {open && <RunItems runId={card.runId} />}
    </div>
  );
}

function RunItems({ runId }: { runId: string }) {
  const state = useLoad(() => loadRunDetail(runId), [runId]);
  const items = state.data?.items ?? [];
  return (
    <div class="sb-run-body">
      <LoadState state={state} empty={!state.loading && !state.error && items.length === 0} />
      {items.length > 0 && (
        <div class="sb-table-wrap">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Mục</th>
                <th>Trạng thái</th>
                <th class="num">Kết quả</th>
                <th class="num">Mới</th>
                <th class="num">Median views</th>
                <th class="num">Outlier</th>
                <th>Lý do bỏ qua / lỗi</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.target}>
                  <td>{i.target}</td>
                  <td>{i.status === 'skipped_dedup' ? <Badge tone="warning">bỏ qua (trùng)</Badge> : runStatusChip(i.status)}</td>
                  <td class="num">{fmtInt(i.nResults)}</td>
                  <td class="num">{fmtInt(i.nNew)}</td>
                  <td class="num">{fmtInt(i.medianViews)}</td>
                  <td class="num">{fmtInt(i.outliersFound)}</td>
                  <td class="sb-hint">{skipLabel(i.skipReason) || i.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
