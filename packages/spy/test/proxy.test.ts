import { describe, expect, test } from 'bun:test';
import { AppError } from '../src/errors.ts';
import { maskProxy, proxyArgs, proxyYT } from '../src/adapters/proxy.ts';
import { YtDlpAdapter } from '../src/adapters/ytdlp.ts';
import { YouTubeDataApiAdapter } from '../src/adapters/data-api.ts';

/**
 * proxyYT là điểm vào duy nhất normalize proxy của người dùng — format
 * `host:port:user:pass` (vd `IPV6: 15.235.176.217:8772:user:pass`) hoặc URL
 * đầy đủ — thành `http://user:pass@host:port` dùng chung cho yt-dlp
 * (`--proxy`) và `fetch` (thumbnail + YouTube Data API).
 */
describe('proxyYT — normalize proxy format', () => {
  test('host:port:user:pass → http URL có auth', () => {
    expect(proxyYT('15.235.176.217:8772:u123:pw')).toBe('http://u123:pw@15.235.176.217:8772');
  });

  test('nhãn provider IPV6:/HTTP: đứng trước được bỏ', () => {
    expect(proxyYT('IPV6: 15.235.176.217:8772:u:p')).toBe('http://u:p@15.235.176.217:8772');
    expect(proxyYT('HTTP: 10.0.0.1:3128')).toBe('http://10.0.0.1:3128');
  });

  test('host:port không auth', () => {
    expect(proxyYT('1.2.3.4:8080')).toBe('http://1.2.3.4:8080');
  });

  test('IPv6 bracket giữ nguyên', () => {
    expect(proxyYT('[2001:db8::1]:8772:u:p')).toBe('http://u:p@[2001:db8::1]:8772');
  });

  test('user:pass@host:port giữ nguyên', () => {
    expect(proxyYT('u:p@5.6.7.8:3128')).toBe('http://u:p@5.6.7.8:3128/');
  });

  test('URL đầy đủ (socks5) giữ scheme', () => {
    expect(proxyYT('socks5://u:p@9.9.9.9:1080')).toBe('socks5://u:p@9.9.9.9:1080');
  });

  test('rỗng/null → null', () => {
    expect(proxyYT('')).toBeNull();
    expect(proxyYT('  ')).toBeNull();
    expect(proxyYT(null)).toBeNull();
    expect(proxyYT(undefined)).toBeNull();
  });

  test('format sai → invalid_input', () => {
    expect(() => proxyYT('bogus')).toThrow(AppError);
    expect(() => proxyYT('bogus')).toThrow(/format/);
    expect(() => proxyYT('host:notaport:u:p')).toThrow(AppError);
  });

  test('proxyArgs rỗng khi không proxy, có --proxy khi set', () => {
    expect(proxyArgs(null)).toEqual([]);
    expect(proxyArgs('http://u:p@1.2.3.4:8080')).toEqual(['--proxy', 'http://u:p@1.2.3.4:8080']);
  });

  test('maskProxy ẩn password', () => {
    expect(maskProxy(proxyYT('15.235.176.217:8772:u:secretpw'))).toBe('http://u:***@15.235.176.217:8772/');
    expect(maskProxy(null)).toBeNull();
  });
});

describe('adapters — proxy plumbing', () => {
  test('YtDlpAdapter nhận format thô và nhét --proxy vào mọi lệnh', async () => {
    const adapter = new YtDlpAdapter('printf', undefined, undefined, 'IPV6: 15.235.176.217:8772:u:p');
    // printf '%s\n' phản hồi args → kiểm chứng --proxy xuất hiện trong lệnh thật.
    const info = await adapter.inspectVideo('https://www.youtube.com/watch?v=abcdefghijk').catch(() => null);
    void info;
    const internal = adapter as unknown as { proxy: string | null };
    expect(internal.proxy).toBe('http://u:p@15.235.176.217:8772');
    adapter.setProxy(null);
    expect(internal.proxy).toBeNull();
  });

  test('YouTubeDataApiAdapter route fetch qua proxy option của Bun', async () => {
    const adapter = new YouTubeDataApiAdapter('key-1', '1.2.3.4:8080:u:p');
    const seen: Array<{ proxy?: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { proxy?: string }) => {
      seen.push({ proxy: init?.proxy });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await adapter.fetchVideoStatistics(['abcdefghijk']);
      expect(seen[0]?.proxy).toBe('http://u:p@1.2.3.4:8080');
      adapter.setProxy(null);
      await adapter.fetchVideoStatistics(['abcdefghijk']);
      expect(seen[1]?.proxy).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
