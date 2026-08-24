/**
 * Test sendTelegramReport với fetch mock.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { sendTelegramReport, markdownToHtml, chunkByParagraph } from '../../src/spy/report-telegram.ts';
import type { TelegramConfig } from '../../src/spy/loop-config.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_CFG: TelegramConfig = { botToken: 'test-token-123', chatId: '-1001234567890', enabled: true };

// ─── Unit tests: markdownToHtml, chunkByParagraph ─────────────────────────────

describe('markdownToHtml', () => {
  test('escape & < >', () => {
    expect(markdownToHtml('AT&T, a<b>c')).toBe('AT&amp;T, a&lt;b&gt;c');
  });

  test('**bold** → <b>bold</b>', () => {
    expect(markdownToHtml('**hello**')).toBe('<b>hello</b>');
  });

  test('`code` → <code>code</code>', () => {
    expect(markdownToHtml('`x = 1`')).toBe('<code>x = 1</code>');
  });

  test('multiline giữ nguyên newline', () => {
    const input = 'line1\nline2';
    expect(markdownToHtml(input)).toContain('line1');
    expect(markdownToHtml(input)).toContain('line2');
  });
});

describe('chunkByParagraph', () => {
  test('nội dung ngắn → 1 chunk', () => {
    const chunks = chunkByParagraph('Hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Hello world');
  });

  test('chia theo đoạn (double newline)', () => {
    const input = 'Para1\n\nPara2\n\nPara3';
    const chunks = chunkByParagraph(input);
    // Tất cả đoạn nhỏ → 1 chunk vì tổng < 4000
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.join('\n\n')).toContain('Para1');
    expect(chunks.join('\n\n')).toContain('Para3');
  });

  test('đoạn > 4000 chars → cắt cứng', () => {
    const longPara = 'A'.repeat(5000);
    const chunks = chunkByParagraph(longPara);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.length <= 4000)).toBe(true);
  });

  test('không có chunk rỗng', () => {
    const chunks = chunkByParagraph('\n\n\n\nHello\n\n\n\n');
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });
});

// ─── Integration: sendTelegramReport với fetch mock ───────────────────────────

describe('sendTelegramReport', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('ném lỗi khi botToken trống', async () => {
    await expect(
      sendTelegramReport('test', { botToken: '', chatId: '123', enabled: true }),
    ).rejects.toThrow('botToken');
  });

  test('ném lỗi khi chatId trống', async () => {
    await expect(
      sendTelegramReport('test', { botToken: 'tok', chatId: '', enabled: true }),
    ).rejects.toThrow('chatId');
  });

  test('ném lỗi khi enabled=false', async () => {
    await expect(
      sendTelegramReport('test', { botToken: 'tok', chatId: '123', enabled: false }),
    ).rejects.toThrow('chưa được bật');
  });

  test('gửi thành công — 1 chunk, gọi fetch 1 lần', async () => {
    let capturedBody = '';
    global.fetch = mock(async (_url: unknown, init?: { body?: string }) => {
      capturedBody = init?.body ?? '';
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    }) as unknown as typeof global.fetch;

    const result = await sendTelegramReport('Hello World', BASE_CFG);
    expect(result.chunks).toBe(1);
    expect(result.sentAt).toBeTruthy();

    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body['chat_id']).toBe(BASE_CFG.chatId);
    expect(body['parse_mode']).toBe('HTML');
    expect(body['disable_web_page_preview']).toBe(true);
    expect(typeof body['text']).toBe('string');
  });

  test('retry 1 lần khi 429 với retry_after', async () => {
    let attempt = 0;
    global.fetch = mock(async (_url: unknown) => {
      attempt++;
      if (attempt === 1) {
        return new Response(
          JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } }),
          { status: 429 },
        );
      }
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    }) as unknown as typeof global.fetch;

    const result = await sendTelegramReport('test retry', BASE_CFG);
    expect(result.chunks).toBe(1);
    expect(attempt).toBe(2);
  }, 5000);

  test('ném lỗi khi API trả 400', async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 })
    ) as unknown as typeof global.fetch;

    await expect(sendTelegramReport('test', BASE_CFG)).rejects.toThrow('400');
  });


  test('nội dung markdown được convert sang HTML (escape & < >)', async () => {
    let capturedBody = '';
    global.fetch = mock(async (_url: unknown, init?: { body?: string }) => {
      capturedBody = init?.body ?? '';
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    }) as unknown as typeof global.fetch;

    await sendTelegramReport('**Kênh A&B** có view > 1000', BASE_CFG);
    const body = JSON.parse(capturedBody) as { text: string };
    expect(body.text).toContain('<b>');
    expect(body.text).toContain('&amp;');
    expect(body.text).toContain('&gt;');
  });
});
