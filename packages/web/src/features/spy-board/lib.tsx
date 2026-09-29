/**
 * Helper dùng chung cho Spy Board — format số/ngày, chip, hook tải dữ liệu,
 * biểu đồ SVG thuần (không thêm thư viện chart), và cờ mock ?mock=1 (cùng quy
 * ước với pages/SpyLoop.tsx — query nằm trong hash).
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { BOARD_NICHE_NONE, type BoardRunType, type BoardTier } from '../../api.ts';

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

// ── Ngách ───────────────────────────────────────────────────────────────────

/** null = "chưa gán" → tham số API '_none'. */
export function nicheParam(niche: string | null): string {
  return niche === null ? BOARD_NICHE_NONE : niche;
}

export function nicheLabel(niche: string | null): string {
  return niche === null ? 'Chưa gán ngách' : niche;
}

// ── Badge / icon ────────────────────────────────────────────────────────────

export type BadgeTone = 'success' | 'danger' | 'warning' | 'primary' | 'secondary';

/** Pill kiểu TailPanel: chữ đậm + nền nhạt cùng tông. */
export function Badge({ tone = 'secondary', title, children, class: cls }: {
  tone?: BadgeTone;
  title?: string;
  children?: ComponentChildren;
  class?: string;
}) {
  return <span class={`sb-badge ${tone} ${cls ?? ''}`.trim()} title={title}>{children}</span>;
}

const ICONS = {
  trending: 'M22 7l-8.5 8.5-5-5L2 17M16 7h6v6',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  repeat: 'M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  layers: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  image: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM9 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM21 15l-5-5L5 21',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  refresh: 'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16M16 16h5v5',
  up: 'M7 17L17 7M7 7h10v10',
  down: 'M7 7l10 10M17 7v10H7',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
  chevron: 'M6 9l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  play: 'M5 3l14 9-14 9V3z',
  check: 'M20 6L9 17l-5-5',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  sparkles: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z',
  bot: 'M12 8V4H8M4 12a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6zM2 15h2M20 15h2M9 14v2M15 14v2',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Ô icon 48×48 góc phải thẻ số liệu. */
export function IconBox({ tone, name }: { tone: 'success' | 'warning' | 'primary' | 'danger' | 'secondary'; name: IconName }) {
  return <span class={`sb-iconbox ${tone}`}><Icon name={name} /></span>;
}

const TIER_LABEL: Record<BoardTier, string> = {
  reliable: '✅ Tin cậy',
  thin: '⚠️ Mẫu mỏng',
  niche: '🆕 So với ngách',
};

/** Nhãn độ tin của mức thường. n = cỡ mẫu (số video khác / số video ngách). */
export function TierChip({ tier, n }: { tier: BoardTier | null; n?: number }) {
  if (!tier) return <Badge>chưa đo được</Badge>;
  const tone = tier === 'reliable' ? 'success' : tier === 'thin' ? 'warning' : 'primary';
  const title =
    tier === 'reliable' ? 'So với ≥10 video khác của kênh'
    : tier === 'thin' ? 'Kênh chỉ có 3–9 video khác — cân nhắc'
    : 'Kênh < 3 video — so với sàn view kênh nhỏ của ngách';
  return (
    <Badge tone={tone} title={title}>
      {TIER_LABEL[tier]}{tier === 'thin' && n !== undefined ? ` (n=${n})` : ''}
    </Badge>
  );
}

export function runStatusChip(status: string) {
  const tone =
    status === 'done' ? 'success'
    : status === 'running' ? 'primary'
    : status === 'failed' ? 'danger'
    : 'warning';
  return <Badge tone={tone}>{status}</Badge>;
}

export const RUN_TYPE_LABEL: Record<BoardRunType, string> = {
  track: 'Theo dõi',
  discover: 'Tìm mới',
  deepdive: 'Đào sâu',
  weekly: 'Tìm mới (tuần)',
  setup: 'Khởi tạo',
};

export function scoreClass(score: number | null | undefined): string {
  if (score == null) return 'muted';
  if (score >= 8) return 'sb-score-hot';
  if (score >= 4) return 'sb-score-warm';
  return 'sb-score-cool';
}

// ── Hook tải dữ liệu ────────────────────────────────────────────────────────

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Gọi `load` mỗi khi deps đổi; bỏ kết quả của lần gọi cũ. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let dead = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => { if (!dead) setState({ data, error: null, loading: false }); },
      (e: unknown) => { if (!dead) setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }); },
    );
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function LoadState({ state, empty }: { state: Loaded<unknown>; empty?: boolean }) {
  if (state.loading && !state.data) return <div class="sb-skel" />;
  if (state.error) return <div class="sb-alert">{state.error}</div>;
  if (empty) return <div class="sb-empty">Chưa có dữ liệu.</div>;
  return null;
}

// ── Biểu đồ ─────────────────────────────────────────────────────────────────

/** Sparkline SVG thuần — views theo ngày, có vùng gradient dưới đường. */
export function Sparkline({ points, width = 320, height = 64 }: {
  points: number[];
  width?: number;
  height?: number;
}) {
  if (points.length === 0) return <div class="sb-empty">Chưa có snapshot.</div>;
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
  const area = `${d} L${lastX.toFixed(1)},${height} L4,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" style={{ display: 'block', maxWidth: '100%' }}>
      <defs>
        <linearGradient id="sb-spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35" />
          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sb-spark-fill)" />
      <path d={d} fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" />
      <circle cx={lastX} cy={lastY} r="3" fill="#2563eb" />
    </svg>
  );
}

export const SERIES_COLORS = ['#3b82f6', '#16a34a', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'];

/** Đo bề rộng thật của khung chứa để chữ trục luôn 12px, kể cả trên mobile. */
function useWidth(fallback: number): [{ current: HTMLDivElement | null }, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.max(120, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Nhiều đường trên cùng trục (sàn view theo ngày của các ngách). Đường đầu tô gradient. Điểm null = đứt nét. */
export function MultiLineChart({ series, height = 280 }: {
  series: Array<{ label: string; points: Array<{ day: string; value: number | null }> }>;
  height?: number;
}) {
  const [ref, width] = useWidth(720);
  const values = series.flatMap((s) => s.points.map((p) => p.value)).filter((v): v is number => v !== null);
  if (values.length === 0) return <div class="sb-empty">Chưa đủ dữ liệu để vẽ xu hướng.</div>;
  const padL = 44;
  const padR = 10;
  const padT = 8;
  const padB = 26;
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const n = Math.max(...series.map((s) => s.points.length));
  const x = (i: number) => padL + (n > 1 ? (i * (width - padL - padR)) / (n - 1) : 0);
  const y = (v: number) => height - padB - ((v - min) / span) * (height - padB - padT);
  const days = series[0]?.points.map((p) => p.day) ?? [];
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const vlines = days.length > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (days.length - 1))) : [];
  return (
    <div ref={ref} class="sb-chart">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" style={{ display: 'block' }}>
        <defs>
          <linearGradient id="sb-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={SERIES_COLORS[0]} stop-opacity="0.35" />
            <stop offset="100%" stop-color={SERIES_COLORS[0]} stop-opacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((f) => {
          const v = min + f * span;
          return (
            <g key={f}>
              <line x1={padL} x2={width - padR} y1={y(v)} y2={y(v)} stroke="#e2e8f0" stroke-dasharray="3 3" />
              <text x={padL - 8} y={y(v) + 4} text-anchor="end" font-size="12" fill="#64748b">{fmtNum(v)}</text>
            </g>
          );
        })}
        {vlines.map((i, k) => (
          <g key={k}>
            <line x1={x(i)} x2={x(i)} y1={padT} y2={height - padB} stroke="#e2e8f0" stroke-dasharray="3 3" />
            {(width > 480 || k % 2 === 0) && (
              <text x={x(i)} y={height - 6} text-anchor={k === 0 ? 'start' : k === vlines.length - 1 ? 'end' : 'middle'} font-size="12" fill="#64748b">
                {fmtDay(days[i])}
              </text>
            )}
          </g>
        ))}
        {series.map((s, si) => {
          let d = '';
          let pen = false;
          let firstX = 0;
          let lastX = 0;
          s.points.forEach((p, i) => {
            if (p.value === null) { pen = false; return; }
            if (!d) firstX = x(i);
            lastX = x(i);
            d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)} `;
            pen = true;
          });
          const color = SERIES_COLORS[si % SERIES_COLORS.length];
          const gapless = s.points.every((p) => p.value !== null);
          return (
            <g key={s.label}>
              {si === 0 && gapless && d && (
                <path d={`${d}L${lastX.toFixed(1)},${y(min)} L${firstX.toFixed(1)},${y(min)} Z`} fill="url(#sb-area-fill)" />
              )}
              <path d={d} fill="none" stroke={color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
