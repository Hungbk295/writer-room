/**
 * loop/language.ts — Post-filter ngôn ngữ cho kênh ứng viên (plan §2.1 bước 3).
 *
 * Ngưỡng cố ý, chỉ một cách hiểu — đừng "cải tiến" mà không sửa plan trước:
 *
 *   1. CHỈ reject khi ≥50% trong 12 video mới nhất THỰC SỰ có
 *      `defaultAudioLanguage`/`defaultLanguage`, VÀ ngôn ngữ chiếm đa số trong
 *      nhóm đã khai báo ≠ `topic.language` → rejected(lang_mismatch).
 *   2. Trường trống hoặc thưa (<50% video khai báo): chạy heuristic rẻ trên
 *      title CHỈ để GHI `lang_detected` + `lang_confidence`. Dù confidence cao
 *      hay thấp cũng KHÔNG reject — để người duyệt quyết (status giữ 'new').
 *   3. TUYỆT ĐỐI không reject dựa trên `snippet.country` hay `relevanceLanguage`.
 *      Cả hai chỉ là prior yếu: `relevanceLanguage` chỉ nghiêng kết quả search
 *      chứ không lọc, và rất nhiều kênh VI không khai country hoặc khai US.
 *
 * Không I/O, không phụ thuộc store — thuần để test được từng ngưỡng.
 */

// ---------------------------------------------------------------------------
// Input/Output
// ---------------------------------------------------------------------------

export interface LanguageSampleVideo {
  title?: string | null;
  /** videos.list snippet.defaultAudioLanguage — tín hiệu mạnh nhất khi có. */
  defaultAudioLanguage?: string | null;
  /** videos.list snippet.defaultLanguage — fallback khi audio lang trống. */
  defaultLanguage?: string | null;
}

export interface LanguageVerdict {
  /** true CHỈ ở nhánh 1 (khai báo đủ dày + đa số lệch topic). */
  reject: boolean;
  /** 'lang_mismatch' khi reject, ngược lại null. */
  reason: 'lang_mismatch' | null;
  langDetected: string | null;
  langConfidence: number | null;
  /**
   * 'declared_fields'      — ≥50% video khai báo, kết luận từ metadata thật.
   * 'title_heuristic'      — khai báo thưa, đoán từ title, chỉ để ghi.
   * 'insufficient_sample'  — <6 title và khai báo thưa, không kết luận gì.
   */
  method: 'declared_fields' | 'title_heuristic' | 'insufficient_sample';
  /**
   * true CHỈ khi một ngôn ngữ chiếm QUÁ BÁN số video đã khai báo. Hoà (3/3) hay
   * plurality không quá bán đều là false → không bao giờ reject.
   */
  decisive: boolean;
  /** Số video có khai báo ngôn ngữ trong mẫu. */
  declaredCount: number;
  /** Phân bố ngôn ngữ đã khai báo, vd {en: 3, vi: 3} — để người duyệt tự nhìn. */
  declaredCounts: Record<string, number>;
  /**
   * Field nào cung cấp bằng chứng — reject phải nói được nó dựa vào ĐÂU.
   * null khi không có khai báo nào.
   */
  evidenceField: 'defaultAudioLanguage' | 'defaultLanguage' | null;
  /** Tách theo field để audit được: {defaultAudioLanguage: n, defaultLanguage: m}. */
  declaredByField: { defaultAudioLanguage: number; defaultLanguage: number };
  /** Kích thước mẫu thực tế (≤12). */
  sampleSize: number;
}

/** Số video gần nhất được xét — cố định theo plan. */
export const LANGUAGE_SAMPLE_SIZE = 12;
/** Tỷ lệ video phải khai báo ngôn ngữ thì mới được phép reject. */
export const DECLARED_RATIO_THRESHOLD = 0.5;
/** Dưới ngưỡng title này thì heuristic không đủ mẫu. */
export const MIN_TITLE_SAMPLE = 6;
/** Chỉ để báo cáo — KHÔNG phải ngưỡng reject (heuristic không bao giờ reject). */
export const MIN_HEURISTIC_CONFIDENCE = 0.8;

// ---------------------------------------------------------------------------
// Stopwords / script ranges cho heuristic title
// ---------------------------------------------------------------------------

/** Ký tự có dấu riêng của tiếng Việt (không trùng với es/pt/fr thông thường). */
const VI_DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/giu;

const STOPWORDS: Record<string, readonly string[]> = {
  // Từ chức năng phổ biến nhất — đủ để phân biệt trên tập title ngắn.
  vi: ['và', 'của', 'là', 'có', 'cho', 'với', 'để', 'trong', 'không', 'những', 'người', 'được', 'này', 'khi', 'như'],
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'for', 'how', 'why', 'what', 'you', 'your', 'this', 'that', 'with', 'on', 'it'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'para', 'con', 'por', 'como', 'una', 'un', 'es'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'em', 'para', 'com', 'por', 'como', 'uma', 'um', 'não'],
  id: ['dan', 'yang', 'di', 'ke', 'dari', 'untuk', 'dengan', 'ini', 'itu', 'tidak', 'apa', 'bisa', 'saya'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'que', 'pour', 'dans', 'avec', 'est', 'une', 'un', 'pourquoi'],
  de: ['der', 'die', 'das', 'und', 'ist', 'für', 'mit', 'von', 'nicht', 'ein', 'eine', 'wie', 'warum'],
};

/** Chữ viết riêng biệt → nhận ra gần như chắc chắn mà không cần từ điển. */
const SCRIPTS: ReadonlyArray<{ lang: string; re: RegExp }> = [
  { lang: 'ja', re: /[぀-ゟ゠-ヿ]/gu },   // kana (kanji dùng chung với zh)
  { lang: 'ko', re: /[가-힯]/gu },
  { lang: 'th', re: /[฀-๿]/gu },
  { lang: 'hi', re: /[ऀ-ॿ]/gu },
  { lang: 'ar', re: /[؀-ۿ]/gu },
  { lang: 'ru', re: /[Ѐ-ӿ]/gu },
  { lang: 'zh', re: /[一-鿿]/gu },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 'vi-VN' → 'vi'. Trả null cho giá trị vô nghĩa: rỗng, 'zxx' (không có nội dung
 * ngôn ngữ), 'und' (undetermined) — coi như KHÔNG khai báo, không tính vào 50%.
 */
export function normalizeLangCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  if (!base || base === 'zxx' || base === 'und' || base === 'mul') return null;
  return base;
}

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/**
 * Heuristic rẻ: tỷ lệ ký tự dấu tiếng Việt + tỷ lệ từ chức năng, cộng nhận diện
 * chữ viết cho ngôn ngữ ngoài Latin. KHÔNG dùng để reject (§2.1).
 */
export function detectLanguageFromTitles(titles: readonly string[]): {
  lang: string | null;
  confidence: number;
} {
  const text = titles.join(' \n ').toLowerCase();
  if (!text.trim()) return { lang: null, confidence: 0 };

  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = countMatches(text, /\p{L}/gu);
  if (tokens.length === 0 || letters === 0) return { lang: null, confidence: 0 };

  const scores = new Map<string, number>();

  // Chữ viết riêng: tỷ lệ ký tự thuộc block, nhân 2 vì đây là bằng chứng mạnh.
  for (const { lang, re } of SCRIPTS) {
    const ratio = countMatches(text, re) / letters;
    if (ratio > 0.05) scores.set(lang, ratio * 2);
  }

  // Từ chức năng.
  for (const [lang, words] of Object.entries(STOPWORDS)) {
    const set = new Set(words);
    const hits = tokens.filter((t) => set.has(t)).length;
    if (hits > 0) scores.set(lang, (scores.get(lang) ?? 0) + hits / tokens.length);
  }

  // Dấu tiếng Việt — phân biệt vi với mọi ngôn ngữ Latin khác.
  const viDiacriticRatio = countMatches(text, VI_DIACRITICS) / letters;
  if (viDiacriticRatio > 0.01) {
    scores.set('vi', (scores.get('vi') ?? 0) + viDiacriticRatio * 1.5);
  }

  if (scores.size === 0) return { lang: null, confidence: 0 };

  let bestLang: string | null = null;
  let best = 0;
  let total = 0;
  for (const [lang, score] of scores) {
    total += score;
    if (score > best) { best = score; bestLang = lang; }
  }
  if (!bestLang || total <= 0) return { lang: null, confidence: 0 };

  // Confidence = phần áp đảo tương đối × độ mạnh tuyệt đối của bằng chứng.
  const share = best / total;
  const strength = Math.min(1, best / 0.18);
  return { lang: bestLang, confidence: Math.round(share * strength * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * Áp đúng ba quy tắc ở đầu file lên 12 video mới nhất của một kênh.
 * `topicLanguage` là `topics.language` (vd 'vi').
 */
export function evaluateChannelLanguage(
  videos: readonly LanguageSampleVideo[],
  topicLanguage: string,
): LanguageVerdict {
  const sample = videos.slice(0, LANGUAGE_SAMPLE_SIZE);
  const topicLang = normalizeLangCode(topicLanguage) ?? topicLanguage.toLowerCase();
  const titles = sample.map((v) => v.title ?? '').filter((t) => t.trim().length > 0);

  const declared: string[] = [];
  const declaredByField = { defaultAudioLanguage: 0, defaultLanguage: 0 };
  for (const video of sample) {
    const audio = normalizeLangCode(video.defaultAudioLanguage);
    const written = normalizeLangCode(video.defaultLanguage);
    const lang = audio ?? written;
    if (!lang) continue;
    declared.push(lang);
    if (audio) declaredByField.defaultAudioLanguage++;
    else declaredByField.defaultLanguage++;
  }
  const evidenceField: LanguageVerdict['evidenceField'] =
    declaredByField.defaultAudioLanguage > 0
      ? 'defaultAudioLanguage'
      : declaredByField.defaultLanguage > 0
        ? 'defaultLanguage'
        : null;

  // --- Nhánh 1: khai báo đủ dày → được phép kết luận (và reject) ---
  if (sample.length > 0 && declared.length / sample.length >= DECLARED_RATIO_THRESHOLD) {
    const counts = new Map<string, number>();
    for (const lang of declared) counts.set(lang, (counts.get(lang) ?? 0) + 1);

    let top: string | null = null;
    let topCount = 0;
    for (const [lang, n] of counts) {
      if (n > topCount) { top = lang; topCount = n; }
    }

    // MAJORITY THẬT SỰ, không phải plurality: phải quá bán số video đã khai báo.
    // Vòng lặp "n > topCount" một mình chỉ cho ra phần tử nhiều nhất, và khi hoà
    // thì phần tử duyệt trước thắng — mẫu 3 en / 3 vi trong topic vi sẽ ra
    // majority='en' rồi REJECT một kênh Việt hoàn toàn hợp lệ. Hoà thì không có
    // kết luận nào cả, để người duyệt xử lý.
    const decisive = topCount * 2 > declared.length;
    if (!decisive) {
      return {
        reject: false,
        reason: null,
        // Không công bố "ngôn ngữ" nào khi dữ liệu không chỉ ra ngôn ngữ nào.
        langDetected: null,
        langConfidence: null,
        method: 'declared_fields',
        decisive: false,
        declaredCount: declared.length,
        declaredCounts: Object.fromEntries(counts),
        evidenceField,
        declaredByField,
        sampleSize: sample.length,
      };
    }

    const majority = top!;
    const confidence = Math.round((topCount / declared.length) * 100) / 100;
    const mismatch = majority !== topicLang;
    return {
      reject: mismatch,
      reason: mismatch ? 'lang_mismatch' : null,
      langDetected: majority,
      langConfidence: confidence,
      method: 'declared_fields',
      decisive: true,
      declaredCount: declared.length,
      declaredCounts: Object.fromEntries(counts),
      evidenceField,
      declaredByField,
      sampleSize: sample.length,
    };
  }

  // --- Nhánh 2: khai báo thưa → chỉ GHI, không bao giờ reject ---
  const heuristic = detectLanguageFromTitles(titles);
  const enoughTitles = titles.length >= MIN_TITLE_SAMPLE;
  return {
    reject: false,
    reason: null,
    langDetected: heuristic.lang,
    langConfidence: heuristic.lang === null ? null : heuristic.confidence,
    method: enoughTitles ? 'title_heuristic' : 'insufficient_sample',
    decisive: false,
    declaredCount: declared.length,
    declaredCounts: {},
    evidenceField,
    declaredByField,
    sampleSize: sample.length,
  };
}
