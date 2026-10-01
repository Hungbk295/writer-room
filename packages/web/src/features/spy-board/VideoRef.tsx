/**
 * Tham chiếu video dùng chung của Board: MỌI video hiện trên UI đều có ảnh
 * thumbnail + tiêu đề là link mở YouTube (theo yêu cầu JC 2026-09-29). Thumbnail
 * suy ra từ video ID nên video chưa có trong topic vẫn có ảnh; thiếu tiêu đề thì
 * hiện ID. Dạng 'row' = ảnh 16:9 + tên + kênh/views; 'chip' = ảnh nhỏ + tên một dòng.
 */
import type { BoardLabels, BoardVideoLabel } from '../../api.ts';
import { Icon, fmtNum } from './lib.tsx';

export const ytWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
export const ytChannelUrl = (id: string) => `https://www.youtube.com/channel/${id}`;
/** mqdefault = 320x180, đúng 16:9 (hqdefault có viền đen trên/dưới). */
export const ytThumb = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

function short(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

export function Thumb({ id, className }: { id: string; className?: string }) {
  return (
    <span class={`sb-vthumb ${className ?? ''}`.trim()}>
      <span class="sb-thumb-ph"><Icon name="image" size={20} /></span>
      <img src={ytThumb(id)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
    </span>
  );
}

export function VideoRef({ id, label, variant = 'row' }: {
  id: string;
  label?: BoardVideoLabel;
  variant?: 'row' | 'chip';
}) {
  const title = label?.title ?? id;
  const meta = label
    ? [label.channelTitle, label.views != null ? `${fmtNum(label.views)} views` : null].filter(Boolean).join(' · ')
    : '';
  return (
    <a
      class={`sb-vref sb-vref-${variant}`}
      href={ytWatchUrl(id)}
      target="_blank"
      rel="noreferrer"
      title={`${title} · ${id}`}
      onClick={(e) => e.stopPropagation()}
    >
      <Thumb id={id} />
      <span class="sb-vref-text">
        <span class="sb-vref-title">{variant === 'chip' ? short(title, 60) : title}</span>
        {variant === 'row' && meta && <span class="sb-vref-meta">{meta}</span>}
      </span>
    </a>
  );
}

/** Nhiều video: dạng chip xuống dòng tự nhiên. */
export function VideoRefs({ ids, labels }: { ids: string[]; labels: BoardLabels }) {
  return (
    <span class="sb-vrefs">
      {ids.map((id) => <VideoRef key={id} id={id} label={labels.videos[id]} variant="chip" />)}
    </span>
  );
}
