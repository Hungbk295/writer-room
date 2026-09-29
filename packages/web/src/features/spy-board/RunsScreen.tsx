/**
 * Màn 4 · Lượt chạy — "có tốn quota vô ích không?" (plan spy-analyst-workflow §G).
 * Sổ lượt chạy gộp Theo dõi (tự động) + Tìm mới/Đào sâu (người bấm). Bấm một
 * thẻ → từng keyword/video, kể cả mục bị bỏ qua và lý do.
 */
import { useState } from 'preact/hooks';
import type { BoardRunCard, BoardRunType } from '../../api.ts';
import { Chip } from '../../components/ui/Chip.tsx';
import { loadRunDetail, loadRuns } from './data.ts';
import {
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

function skipLabel(reason: string | null): string {
  if (!reason) return '';
  const m = reason.match(/^searched_at:(.+)$/);
  if (m) return `đã search ${relDate(m[1])}`;
  if (reason === 'comments_present') return 'đã có comment';
  return reason;
}

export function RunsScreen({ topicId, refreshKey }: { topicId: string; refreshKey: number }) {
  const [type, setType] = useState<BoardRunType | ''>('');
  const state = useLoad(() => loadRuns(topicId, type || undefined), [topicId, type, refreshKey]);
  const [open, setOpen] = useState<string | null>(null);
  const rows = state.data?.data ?? [];

  return (
    <div class="stack">
      <div class="feed-filter-tabs">
        {TYPE_FILTERS.map((t) => (
          <button key={t.key} class={`feed-tab-btn ${type === t.key ? 'active' : ''}`} onClick={() => setType(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <LoadState state={state} empty={!state.loading && !state.error && rows.length === 0} />
      <div class="stack" style={{ gap: '0.5rem' }}>
        {rows.map((c) => (
          <RunCard key={c.runId} card={c} open={open === c.runId} onToggle={() => setOpen(open === c.runId ? null : c.runId)} />
        ))}
      </div>
    </div>
  );
}

function RunCard({ card, open, onToggle }: { card: BoardRunCard; open: boolean; onToggle: () => void }) {
  return (
    <div class={`spy-run-row ${open ? 'is-open' : ''}`}>
      <button class="spy-run-row-head" onClick={onToggle}>
        <div class="spy-run-row-title">
          <Chip variant={card.type === 'track' ? 'other' : 'writer'}>{RUN_TYPE_LABEL[card.type]}</Chip>
          <strong>{card.note ?? '—'}</strong>
        </div>
        <div class="muted spy-card-meta">
          {runStatusChip(card.status)}
          <span>{relDate(card.startedAt)}</span>
          {card.niche !== null && <span>ngách {nicheLabel(card.niche)}</span>}
          <span>{TRIGGER_LABEL[card.triggeredBy] ?? card.triggeredBy}</span>
          <span>{card.searchCalls} search · {fmtInt(card.units)} unit</span>
          {card.nNew !== null && <span>{fmtInt(card.nNew)} video mới</span>}
          {card.newChannels > 0 && <span>{card.newChannels} kênh đề xuất</span>}
          {card.nSkipped ? <span class="spy-lock">{card.nSkipped} bỏ qua</span> : null}
        </div>
        {card.error && <p class="error" style={{ margin: 0, fontSize: '0.78rem' }}>{card.error}</p>}
      </button>
      {open && <RunItems runId={card.runId} />}
    </div>
  );
}

function RunItems({ runId }: { runId: string }) {
  const state = useLoad(() => loadRunDetail(runId), [runId]);
  const items = state.data?.items ?? [];
  return (
    <div class="spy-run-row-body">
      <LoadState state={state} empty={!state.loading && !state.error && items.length === 0} />
      {items.length > 0 && (
        <div class="spy-table-wrap">
          <table class="spy-kw-table">
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
                  <td>{i.status === 'skipped_dedup' ? <Chip variant="warn">bỏ qua (trùng)</Chip> : runStatusChip(i.status)}</td>
                  <td class="num">{fmtInt(i.nResults)}</td>
                  <td class="num">{fmtInt(i.nNew)}</td>
                  <td class="num">{fmtInt(i.medianViews)}</td>
                  <td class="num">{fmtInt(i.outliersFound)}</td>
                  <td class="muted">{skipLabel(i.skipReason) || i.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
