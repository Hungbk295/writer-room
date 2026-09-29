/**
 * Helper dùng chung cho Spy Board — format số/ngày, chip, hook tải dữ liệu,
 * biểu đồ SVG thuần (không thêm thư viện chart), và cờ mock ?mock=1 (cùng quy
 * ước với pages/SpyLoop.tsx — query nằm trong hash).
 */
import { useEffect, useState } from 'preact/hooks';
import { Chip } from '../../components/ui/Chip.tsx';
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

// ── Chip ────────────────────────────────────────────────────────────────────

const TIER_LABEL: Record<BoardTier, string> = {
  reliable: '✅ Tin cậy',
  thin: '⚠️ Mẫu mỏng',
  niche: '🆕 So với ngách',
};

/** Nhãn độ tin của mức thường. n = cỡ mẫu (số video khác / số video ngách). */
export function TierChip({ tier, n }: { tier: BoardTier | null; n?: number }) {
  if (!tier) return <Chip variant="other">chưa đo được</Chip>;
  const variant = tier === 'reliable' ? 'default' : tier === 'thin' ? 'warn' : 'writer';
  const title =
    tier === 'reliable' ? 'So với ≥10 video khác của kênh'
    : tier === 'thin' ? 'Kênh chỉ có 3–9 video khác — cân nhắc'
    : 'Kênh < 3 video — so với sàn view kênh nhỏ của ngách';
  return (
    <Chip variant={variant} title={title}>
      {TIER_LABEL[tier]}{tier === 'thin' && n !== undefined ? ` (n=${n})` : ''}
    </Chip>
  );
}

export function runStatusChip(status: string) {
  const variant =
    status === 'done' ? 'default'
    : status === 'running' ? 'writer'
    : status === 'failed' ? 'bad'
    : 'warn';
  return <Chip variant={variant}>{status}</Chip>;
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
  if (score >= 8) return 'spy-score-hot';
  if (score >= 4) return 'spy-score-warm';
  return 'spy-score-cool';
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
  if (state.loading && !state.data) return <div class="spy-skel" />;
  if (state.error) return <p class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{state.error}</p>;
  if (empty) return <p class="muted" style={{ margin: 0, fontSize: '0.82rem' }}>Chưa có dữ liệu.</p>;
  return null;
}

// ── Biểu đồ ─────────────────────────────────────────────────────────────────

/** Sparkline SVG thuần — views theo ngày. */
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
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" style={{ display: 'block', maxWidth: '100%' }}>
      <path d={d} fill="none" stroke="var(--teal)" stroke-width="2" stroke-linejoin="round" />
      <circle cx={lastX} cy={lastY} r="3" fill="var(--teal-deep)" />
    </svg>
  );
}

export const SERIES_COLORS = ['var(--teal)', 'var(--amber)', '#5b6fd6', 'var(--danger)', '#7a4fb3', 'var(--ink-soft)'];

/** Nhiều đường trên cùng trục (sàn view theo ngày của các ngách). Điểm null = đứt nét. */
export function MultiLineChart({ series, width = 900, height = 220 }: {
  series: Array<{ label: string; points: Array<{ day: string; value: number | null }> }>;
  width?: number;
  height?: number;
}) {
  const values = series.flatMap((s) => s.points.map((p) => p.value)).filter((v): v is number => v !== null);
  if (values.length === 0) return <p class="muted" style={{ fontSize: '0.8rem' }}>Chưa đủ dữ liệu để vẽ xu hướng.</p>;
  const padL = 44;
  const padB = 18;
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const n = Math.max(...series.map((s) => s.points.length));
  const x = (i: number) => padL + (n > 1 ? (i * (width - padL - 6)) / (n - 1) : 0);
  const y = (v: number) => height - padB - ((v - min) / span) * (height - padB - 8);
  const days = series[0]?.points.map((p) => p.day) ?? [];
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" style={{ display: 'block', height: 'auto' }}>
      {[0, 0.5, 1].map((f) => {
        const v = min + f * span;
        return (
          <g key={f}>
            <line x1={padL} x2={width - 6} y1={y(v)} y2={y(v)} stroke="var(--line)" />
            <text x={padL - 6} y={y(v) + 4} text-anchor="end" font-size="10" fill="var(--ink-soft)">{fmtNum(v)}</text>
          </g>
        );
      })}
      {days.length > 1 && [0, days.length - 1].map((i) => (
        <text key={i} x={x(i)} y={height - 4} text-anchor={i === 0 ? 'start' : 'end'} font-size="10" fill="var(--ink-soft)">
          {fmtDay(days[i])}
        </text>
      ))}
      {series.map((s, si) => {
        let d = '';
        let pen = false;
        s.points.forEach((p, i) => {
          if (p.value === null) { pen = false; return; }
          d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)} `;
          pen = true;
        });
        return <path key={s.label} d={d} fill="none" stroke={SERIES_COLORS[si % SERIES_COLORS.length]} stroke-width="2" stroke-linejoin="round" />;
      })}
    </svg>
  );
}
