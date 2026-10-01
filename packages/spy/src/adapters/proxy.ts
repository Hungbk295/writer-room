import { AppError } from '../errors.ts';

/**
 * proxyYT — điểm vào duy nhất để mọi traffic YouTube (yt-dlp search/metadata/
 * transcript, thumbnail i.ytimg.com, YouTube Data API) chạy qua một proxy.
 *
 * Cấu hình theo thứ tự ưu tiên:
 *   1. `youtubeProxy` trong config/spy.json (spy_config_set / PUT /api/settings/spy)
 *   2. env `WRITER_ROOM_YT_PROXY`
 *   3. env `YOUTUBE_PROXY`
 *
 * Format chấp nhận (đầu vào của user, ví dụ `IPV6: 15.235.176.217:8772:user:pass`):
 *   - `<HOST>:<PORT>:<USER>:<PASS>`       → http://USER:PASS@HOST:PORT
 *   - `<HOST>:<PORT>`                    → http://HOST:PORT
 *   - `[<IPv6>]:<PORT>:<USER>:<PASS>`    → http://USER:PASS@[IPv6]:PORT
 *   - `<USER>:<PASS>@<HOST>:<PORT>`      → http://USER:PASS@HOST:PORT
 *   - URL đầy đủ `scheme://…` (http/https/socks4/socks5/socks5h) — giữ nguyên
 *   - Nhãn provider đứng trước (`IPV4:`, `IPV6:`, `HTTP:`, `SOCKS5:`) được bỏ
 */

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const PROVIDER_LABEL = /^(ipv4|ipv6|ip|https?|socks4|socks5h?)\s*:\s*/i;
const BRACKETED_HOST = /^\[([0-9a-fA-F:]+)\]:(\d{1,5})(?::([^:]*)(?::(.*))?)?$/;
const PLAIN_HOST = /^([^:]+):(\d{1,5})(?::([^:]*)(?::(.*))?)?$/;

function buildUrl(host: string, port: string, user?: string, pass?: string): string {
  if (!host) throw new AppError('invalid_input', 'Proxy thiếu host');
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new AppError('invalid_input', `Proxy port không hợp lệ: ${port}`);
  }
  const bracketedHost = host.includes(':') ? `[${host}]` : host;
  const auth = user !== undefined && user !== ''
    ? `${encodeURIComponent(user)}:${encodeURIComponent(pass ?? '')}@`
    : '';
  return `http://${auth}${bracketedHost}:${port}`;
}

/**
 * proxyYT(raw) → proxy URL chuẩn hoá (`http://user:pass@host:port`) hoặc
 * `null` khi input rỗng. Throw `invalid_input` khi format sai.
 */
export function proxyYT(raw: string | null | undefined): string | null {
  const input = (raw ?? '').trim();
  if (!input) return null;

  if (SCHEME_URL.test(input)) {
    try {
      return new URL(input).toString();
    } catch (error) {
      throw new AppError('invalid_input', `Proxy URL không hợp lệ: ${maskProxy(input)}`, { cause: error });
    }
  }

  const cleaned = input.replace(PROVIDER_LABEL, '');

  // user:pass@host:port (không scheme)
  if (cleaned.includes('@')) {
    try {
      return new URL(`http://${cleaned}`).toString();
    } catch (error) {
      throw new AppError('invalid_input', `Proxy URL không hợp lệ: ${maskProxy(input)}`, { cause: error });
    }
  }

  const match = BRACKETED_HOST.exec(cleaned) ?? PLAIN_HOST.exec(cleaned);
  if (!match) {
    throw new AppError(
      'invalid_input',
      `Proxy không đúng format <host>:<port>:<user>:<pass>: ${maskProxy(input)}`,
    );
  }
  return buildUrl(match[1]!, match[2]!, match[3], match[4]);
}

/** Proxy URL hiệu lực: config → env; trả null khi chưa cấu hình. */
export function resolveYouTubeProxy(configured?: string | null): string | null {
  return proxyYT(
    configured ?? process.env.WRITER_ROOM_YT_PROXY ?? process.env.YOUTUBE_PROXY,
  );
}

/** Args cho yt-dlp — rỗng khi không có proxy. */
export function proxyArgs(proxyUrl: string | null | undefined): string[] {
  return proxyUrl ? ['--proxy', proxyUrl] : [];
}

/**
 * fetch đi qua proxy (Bun `RequestInit.proxy`). Không proxy → fetch thường.
 * CHÚ Ý: option `proxy` là extension của Bun — dưới Node thuần nó bị bỏ qua.
 */
export function fetchViaProxy(
  input: string | URL | Request,
  init: BunFetchRequestInit = {},
  proxyUrl?: string | null,
): Promise<Response> {
  if (!proxyUrl) return fetch(input, init);
  return fetch(input, { ...init, proxy: proxyUrl });
}

/** Ẩn password khỏi log/UI — giữ scheme, user, host, port. */
export function maskProxy(proxyUrl: string | null | undefined): string | null {
  if (!proxyUrl) return null;
  try {
    const url = new URL(proxyUrl.startsWith('http') || proxyUrl.startsWith('socks') ? proxyUrl : `http://${proxyUrl}`);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return proxyUrl.replace(/:[^:@/]+@/, ':***@');
  }
}
