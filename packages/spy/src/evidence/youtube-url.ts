import { AppError } from '../errors.ts';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch (error) {
    throw new AppError('invalid_input', 'URL YouTube không hợp lệ', { cause: error });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('invalid_input', 'URL YouTube phải dùng http hoặc https');
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new AppError('invalid_input', 'Host không phải YouTube');
  }
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  return url;
}

export function youtubeVideoId(raw: string): string | null {
  const url = parseUrl(raw);
  let id = '';
  if (url.hostname === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] ?? '';
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v') ?? '';
  } else {
    const match = /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname);
    id = match?.[1] ?? '';
  }
  return VIDEO_ID.test(id) ? id : null;
}

export function canonicalVideoUrl(raw: string): { canonicalUrl: string; sourceIdentity: string } {
  const id = youtubeVideoId(raw);
  if (!id) throw new AppError('invalid_input', 'URL phải trỏ tới đúng một video YouTube');
  return { canonicalUrl: `https://www.youtube.com/watch?v=${id}`, sourceIdentity: `youtube:video:${id}` };
}

export function canonicalChannelUrl(raw: string): { canonicalUrl: string; sourceIdentity: string } {
  const url = parseUrl(raw);
  if (youtubeVideoId(raw)) {
    throw new AppError('invalid_input', 'URL video đơn không hợp lệ cho Channel Spy — dùng URL kênh/playlist');
  }
  const playlist = url.searchParams.get('list');
  if (playlist) {
    return {
      canonicalUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(playlist)}`,
      sourceIdentity: `youtube:playlist:${playlist}`,
    };
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) throw new AppError('invalid_input', 'URL channel trống');
  const terminal = segments.at(-1);
  if (terminal === 'videos' || terminal === 'shorts' || terminal === 'streams' || terminal === 'playlists') {
    segments.pop();
  }
  const basePath = `/${segments.join('/')}`;
  if (!/^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)$/.test(basePath)) {
    throw new AppError('invalid_input', 'URL phải là channel, user, handle hoặc playlist YouTube');
  }
  return {
    canonicalUrl: `https://www.youtube.com${basePath}/videos`,
    sourceIdentity: `youtube:channel:${basePath.toLowerCase()}`,
  };
}
