/**
 * Helper dùng chung cho Spy Board — format số/ngày, chip trạng thái,
 * sparkline SVG (không thêm thư viện chart), và cờ mock ?mock=1
 * (cùng quy ước với pages/SpyLoop.tsx — query nằm trong hash).
 */
import { Chip } from '../../components/ui/Chip.tsx';
import type {
  KeywordStatus,
  SpyKeywordRun,
  SpyKeywordRunDetail,
  SpyKeywordRunStatus,
} from '../../api.ts';

function hashQuery(): URLSearchParams {
  if (typeof location === 'undefined') return new URLSearchParams();
  return new URLSearchParams(location.hash.replace(/^#\/?[^?]*/, ''));
}
export const IS_MOCK = hashQuery().has('mock');

export function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n * 10) / 10);
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('vi-VN');
}

export function relDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '—';
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return 'vừa xong';
  if (h < 24) return `${h} giờ trước`;
  return `${Math.floor(h / 24)} ngày trước`;
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

export function kwStatusChip(status: KeywordStatus | string) {
  const variant =
    status === 'active' ? 'default'
    : status === 'pending' ? 'warn'
    : status === 'rejected' ? 'bad'
    : 'other';
  const label =
    status === 'active' ? 'active'
    : status === 'pending' ? 'chờ duyệt'
    : status === 'paused' ? 'paused'
    : status === 'rejected' ? 'rejected'
    : status;
  return <Chip variant={variant}>{label}</Chip>;
}

export function runStatusChip(status: SpyKeywordRunStatus | string) {
  const variant =
    status === 'done' ? 'default'
    : status === 'running' ? 'writer'
    : status === 'failed' ? 'bad'
    : 'warn';
  return <Chip variant={variant}>{status}</Chip>;
}

/** Trend median_views so với lần chạy trước: ↑ xanh / ↓ đỏ / = xám. */
export function TrendBadge({ cur, prev }: { cur: number | null | undefined; prev: number | null | undefined }) {
  if (cur == null || prev == null || prev <= 0) return null;
  const pct = ((cur - prev) / prev) * 100;
  const cls = pct > 5 ? 'ok' : pct < -5 ? 'error' : 'muted';
  const arrow = pct > 5 ? '↑' : pct < -5 ? '↓' : '=';
  return (
    <span class={cls} style={{ fontSize: '0.75rem', fontVariantNumeric: 'tabular-nums' }}>
      {arrow} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

/** Sparkline SVG thuần — views theo ngày, không thư viện ngoài. */
export function Sparkline({ points, width = 320, height = 64 }: {
  points: number[];
  width?: number;
  height?: number;
}) {
  if (points.length === 0) return <p class="muted" style={{ fontSize: '0.8rem' }}>Chưa có snapshot.</p>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = points.length > 1 ? (width - 8) / (points.length - 1) : 0;
  const xy = points.map((v, i) => [
    4 + i * stepX,
    height - 6 - ((v - min) / span) * (height - 12),
  ] as const);
  const d = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = xy[xy.length - 1]!;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      style={{ display: 'block', maxWidth: '100%' }}
    >
      <path d={d} fill="none" stroke="var(--teal)" stroke-width="2" stroke-linejoin="round" />
      <circle cx={lastX} cy={lastY} r="3" fill="var(--teal-deep)" />
    </svg>
  );
}

/** Chuẩn hoá response GET /keywords/runs/:id — chấp nhận {run,items},
 *  envelope {data:{...run,items}} hoặc {data:{run,items}} tuỳ backend chốt. */
export function normalizeRunDetail(raw: unknown): SpyKeywordRunDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as Record<string, unknown>;
  const inner = (outer['data'] && typeof outer['data'] === 'object' ? outer['data'] : outer) as Record<string, unknown>;
  const run = (inner['run'] && typeof inner['run'] === 'object' ? inner['run'] : inner) as SpyKeywordRun;
  if (!run || typeof run.run_id !== 'string') return null;
  const items = Array.isArray(inner['items']) ? inner['items'] : [];
  return { ...run, items } as SpyKeywordRunDetail;
}

export const UNGROUPED = '__ungrouped__';

/** Gom keyword theo group_key; null → nhóm "Chưa gán". */
export function groupKeywords<K extends { group_key?: string | null }>(rows: K[]): Map<string, K[]> {
  const map = new Map<string, K[]>();
  for (const row of rows) {
    const key = row.group_key && row.group_key.trim() !== '' ? row.group_key : UNGROUPED;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}
