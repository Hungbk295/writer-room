export interface RankableVideo {
  sourceVideoId: string;
  viewCount: number;
  durationSec: number;
  publishedAt: string | null;
}

export function velocity(video: RankableVideo, now = new Date()): number {
  if (!video.publishedAt) return video.viewCount;
  const published = new Date(video.publishedAt).getTime();
  if (!Number.isFinite(published)) return video.viewCount;
  const days = Math.max(1, (now.getTime() - published) / 86_400_000);
  return video.viewCount / days;
}

export function rankVideos<T extends RankableVideo>(
  videos: readonly T[],
  options: { topN: number; minDurationSec: number; rankBy: 'views' | 'velocity'; now?: Date },
): T[] {
  return videos
    .filter((video) => video.durationSec >= options.minDurationSec)
    .toSorted((left, right) =>
      options.rankBy === 'velocity'
        ? velocity(right, options.now) - velocity(left, options.now)
        : right.viewCount - left.viewCount,
    )
    .slice(0, options.topN);
}
