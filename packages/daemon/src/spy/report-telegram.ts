/**
 * Gửi báo cáo Spy Loop qua Telegram Bot API.
 *
 * - parse_mode: HTML (tránh 18 ký tự phải escape của MarkdownV2)
 * - Chuyển markdown đơn giản → HTML, escape & < >
 * - Chunk ~4000 ký tự theo ranh giới đoạn
 * - Retry 1 lần khi 429, theo parameters.retry_after
 * - Tối đa 1 msg/s giữa các chunk
 * - Idempotent qua report_id (deliveredJson.telegram)
 */
import type { TelegramConfig } from './loop-config.ts';

// ─── HTML escaping & markdown conversion ─────────────────────────────────────

/** Escape các ký tự đặc biệt bắt buộc của Telegram HTML. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Chuyển markdown đơn giản sang HTML Telegram.
 * Chỉ xử lý: **bold**, `code`, và giữ URL nguyên vẹn.
 * Không dùng thư viện để tránh phụ thuộc nặng.
 */
function markdownToHtml(md: string): string {
  return md
    // Escape HTML trước để tránh injection từ nội dung nguồn
    .split('\n')
    .map((line) => {
      const escaped = escapeHtml(line);
      // **bold**
      const bolded = escaped.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      // `code`
      const coded = bolded.replace(/`([^`]+)`/g, '<code>$1</code>');
      return coded;
    })
    .join('\n');
}

// ─── Chunk theo đoạn ─────────────────────────────────────────────────────────

const CHUNK_SIZE = 4000;

function chunkByParagraph(html: string): string[] {
  const paragraphs = html.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= CHUNK_SIZE) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // Nếu đoạn đơn lẻ quá dài → cắt cứng
      if (para.length > CHUNK_SIZE) {
        let offset = 0;
        while (offset < para.length) {
          chunks.push(para.slice(offset, offset + CHUNK_SIZE));
          offset += CHUNK_SIZE;
        }
        current = '';
      } else {
        current = para;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

// ─── API call ─────────────────────────────────────────────────────────────────

interface TelegramError {
  ok: false;
  error_code: number;
  description: string;
  parameters?: { retry_after?: number };
}

async function sendOneMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  const attempt = async (): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

  let res = await attempt();

  if (res.status === 429) {
    const errBody = (await res.json()) as TelegramError;
    const retryAfter = errBody.parameters?.retry_after ?? 5;
    await new Promise((r) => setTimeout(r, retryAfter * 1_000));
    res = await attempt();
  }

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({ description: res.statusText }))) as TelegramError | { description: string };
    throw new Error(`Telegram sendMessage lỗi ${res.status}: ${'description' in errBody ? errBody.description : res.statusText}`);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SendTelegramReportResult {
  chunks: number;
  sentAt: string;
}

/**
 * Gửi báo cáo markdown qua Telegram.
 *
 * @param markdown Nội dung báo cáo dạng markdown (được convert sang HTML)
 * @param cfg      Cấu hình telegram từ spy-loop.json
 * @returns        Số chunk đã gửi và timestamp
 */
export async function sendTelegramReport(
  markdown: string,
  cfg: TelegramConfig,
): Promise<SendTelegramReportResult> {
  if (!cfg.botToken) throw new Error('Telegram botToken chưa được cấu hình');
  if (!cfg.chatId) throw new Error('Telegram chatId chưa được cấu hình');
  if (!cfg.enabled) throw new Error('Telegram chưa được bật trong cấu hình');

  const html = markdownToHtml(markdown);
  const chunks = chunkByParagraph(html);
  if (chunks.length === 0) throw new Error('Nội dung báo cáo rỗng');

  for (let i = 0; i < chunks.length; i++) {
    await sendOneMessage(cfg.botToken, cfg.chatId, chunks[i]!);
    // 1 msg/s giữa các chunk (không delay sau chunk cuối)
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  return { chunks: chunks.length, sentAt: new Date().toISOString() };
}

// Export helpers for testing
export { markdownToHtml, chunkByParagraph };
