/**
 * faceless.ts — PHỎNG ĐOÁN (hint) kênh có faceless hay không, CHỈ từ văn bản.
 *
 * Quyết định 21-08 (user): bỏ toàn bộ detector mặt chạy local. Verdict "kênh này
 * có mặt người không" sẽ do agent vision chấm ở vòng thiết kế riêng
 * (seam: `FacelessVerdictPort` trong `loop/types.ts`).
 *
 * Hệ quả bắt buộc nhớ khi đọc file này:
 *   - `hint` là PHỎNG ĐOÁN từ chữ, sai lệch cao — KHÔNG BAO GIỜ được dùng để
 *     reject một kênh, và không được hiển thị như kết luận.
 *   - `topic_channels.faceless_score` (verdict) luôn NULL ở P0; hint ghi vào
 *     cột riêng `faceless_hint`.
 *
 * Hai bộ tín hiệu văn bản (vi + en) giữ nguyên từ bản trước — chúng vẫn có giá trị:
 *   text_host     : dấu hiệu kênh có host xuất hiện (vlog/podcast/reaction…)
 *   text_faceless : dấu hiệu kênh giải thích/thuyết minh + boilerplate mô tả
 *
 * Không tải ảnh, không tmpdir, không dhash, không I/O — hàm thuần, đồng bộ.
 */
import type { FacelessHintReason, FacelessHintResult } from './loop/types.ts';

// ---------------------------------------------------------------------------
// Text signal regexes (spy-autoloop-research/faceless.md)
// ---------------------------------------------------------------------------

const HOST_EN = /\b(vlog|day in (my|the) life|grwm|i tried|i tested|i spent|my (morning|night) routine|room tour|storytime|reacting to|reaction|podcast|interview|q&a|ama\b|face reveal|unboxing|haul|mukbang|let'?s talk|rant|irl\b)/i;
const HOST_VI = /(vlog|một ngày của (mình|tôi|em)|nhật ký|mình đã thử|trải nghiệm thực tế|tâm sự|chia sẻ (của )?(mình|tôi)|câu chuyện của (mình|tôi)|podcast|phỏng vấn|hỏi đáp|lộ mặt|reaction|ăn thử|mukbang|đập hộp|livestream|talkshow|du lịch cùng|cùng (mình|tôi|em))/i;

/**
 * Ngôi thứ nhất CHỈ tính khi kèm deixis ("như bạn thấy", "trên tay", "as you can
 * see") — kênh kể chuyện VN dùng "mình" rất nhiều mà vẫn faceless.
 */
const DEIXIS_VI = /(như (các )?bạn thấy|ở đây|đây là|cho bạn xem|camera|máy quay|trên tay)/i;
const DEIXIS_EN = /(as you can see|right here|behind me|on camera|look at this)/i;

const FL_EN = /(explained|what if|why (do|does|is)|the (truth|science|history) (of|behind)|top \d+|\d+ (facts|reasons|ways)|documentary|animated|whiteboard|doodle|narrated|ai voice|tts|no commentary)/i;
const FL_VI = /(giải thích|giải mã|bí ẩn|sự thật (về|đằng sau)|tại sao|vì sao|điều gì (sẽ )?xảy ra nếu|top \d+|\d+ (sự thật|điều|lý do|cách|bí mật)|thuyết minh|lồng tiếng|kể chuyện|đọc truyện|tóm tắt (phim|sách)|hoạt hình|doodle|vẽ tay|giọng (ai|đọc|máy)|tổng hợp|bản tin)/i;

/** Boilerplate mô tả (stock footage / TTS vendor / fair use) — tín hiệu mạnh. */
const BOILERPLATE = /(stock|storyblocks|pexels|pixabay|envato|artlist|epidemic sound|voice|giọng đọc) (by|bởi) ?(elevenlabs|murf|vbee|fpt\.ai|google tts)|fair.use/i;

/** Presenter tổng hợp: có "mặt" nhưng không phải người thật → kênh vẫn faceless. */
const SYNTHETIC = /(heygen|synthesia|d-id|ai avatar|vtuber|live2d|nhân vật ảo)/i;

/** Dưới ngưỡng này thì mẫu chữ quá mỏng để đoán bất cứ điều gì. */
const MIN_TITLE_SAMPLE = 6;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface FacelessHintInput {
  channelTitle: string;
  description?: string | null;
  /** Title của các video mới nhất (thường 12). Cần ≥6 mới đoán. */
  videoTitles?: string[];
  videoDescriptions?: string[];
  transcriptExcerpt?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function countMatches(texts: readonly string[], re: RegExp): number {
  return texts.filter((t) => re.test(t)).length;
}

// ---------------------------------------------------------------------------
// scoreFacelessHint
// ---------------------------------------------------------------------------

/**
 * Đoán "kênh này có faceless không" chỉ từ chữ.
 *
 * `hint = clamp01(0.5 + 0.5·text_faceless − 0.5·text_host)`
 *   → 0.5 là "không biết"; >0.5 nghiêng faceless; <0.5 nghiêng có host.
 *
 * Trả `hint: null` + `method: 'insufficient_sample'` khi có <6 video title.
 *
 * KHÔNG dùng kết quả này để reject kênh (§3 của plan) — chỉ để sắp xếp Inbox và
 * hiển thị kèm nhãn "đoán từ chữ".
 */
export function scoreFacelessHint(input: FacelessHintInput): FacelessHintResult {
  const reasons: FacelessHintReason[] = [];
  const titles = input.videoTitles ?? [];
  const descriptions = [input.description ?? '', ...(input.videoDescriptions ?? [])].filter(
    (t): t is string => Boolean(t),
  );
  const transcript = input.transcriptExcerpt ?? '';
  const allText = [...titles, ...descriptions, transcript, input.channelTitle].join(' ');

  // --- text_host ---
  const hitsHostTitles = countMatches(titles, HOST_EN) + countMatches(titles, HOST_VI);
  const hitsHostDesc = countMatches(descriptions, HOST_EN) + countMatches(descriptions, HOST_VI);
  const hasDeixis = DEIXIS_VI.test(allText) || DEIXIS_EN.test(allText);
  const nameBrand = /^[A-ZÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴ][a-z]+ [A-ZÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴ][a-z]+$/.test(input.channelTitle)
    ? 0.1
    : 0;
  const textHost = clamp01(
    hitsHostTitles * 0.15 + hitsHostDesc * 0.1 + (hasDeixis ? 0.25 : 0) + nameBrand,
  );
  if (hitsHostTitles > 0) {
    reasons.push({ kind: 'keyword', ref: 'host_titles', value: hitsHostTitles, weight: 0.15 });
  }
  if (hitsHostDesc > 0) {
    reasons.push({ kind: 'keyword', ref: 'host_descriptions', value: hitsHostDesc, weight: 0.1 });
  }
  if (hasDeixis) reasons.push({ kind: 'deixis', ref: 'text', value: 1, weight: 0.25 });
  if (nameBrand) reasons.push({ kind: 'name_brand', ref: 'channel_title', value: nameBrand, weight: 0.1 });

  // --- text_faceless ---
  const hitsFlTitles = countMatches(titles, FL_EN) + countMatches(titles, FL_VI);
  const hitsFlDesc = countMatches(descriptions, FL_EN) + countMatches(descriptions, FL_VI);
  const hasBoilerplate = BOILERPLATE.test(descriptions.join(' '));
  const isSynthetic = SYNTHETIC.test(allText);
  const textFaceless = clamp01(
    hitsFlTitles * 0.1 + hitsFlDesc * 0.1 + (hasBoilerplate ? 0.3 : 0) + (isSynthetic ? 0.5 : 0),
  );
  if (hitsFlTitles > 0) {
    reasons.push({ kind: 'keyword', ref: 'faceless_titles', value: hitsFlTitles, weight: 0.1 });
  }
  if (hitsFlDesc > 0) {
    reasons.push({ kind: 'keyword', ref: 'faceless_descriptions', value: hitsFlDesc, weight: 0.1 });
  }
  if (hasBoilerplate) reasons.push({ kind: 'boilerplate', ref: 'description', value: 1, weight: 0.3 });
  // Presenter tổng hợp (HeyGen/VTuber…) — "mặt" trên hình không phải người thật,
  // nên đây là tín hiệu ĐẨY VỀ faceless, không phải cổng chặn như bản detector cũ.
  if (isSynthetic) {
    reasons.push({ kind: 'synthetic_presenter', ref: 'text', value: 1, weight: 0.5 });
  }

  if (titles.length < MIN_TITLE_SAMPLE) {
    return { hint: null, reasons: reasons.slice(0, 8), method: 'insufficient_sample' };
  }

  const hint = clamp01(0.5 + 0.5 * textFaceless - 0.5 * textHost);
  return { hint, reasons: reasons.slice(0, 8), method: 'text_only' };
}
