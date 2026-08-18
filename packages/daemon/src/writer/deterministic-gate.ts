/**
 * Write Loop v2 — Phase 0: the deterministic gate.
 *
 * Every factual promise in the v2 flow is enforced HERE, in code, not by a
 * reviewer LLM's word. Run `7d626c50` is the reason: an LLM reviewer scored a
 * script 89/100 and concluded "the case is not fabricated" while the script had
 * invented an age, a job, a bank balance, a rent, and eight more numbers that
 * appear nowhere in the Source Pack (see `docs/plans/writer-editorial-pipeline-
 * learnings.md` §9). Run `86de3ca5` went further: the reviewer DID flag a
 * violation and the run still finished `passed: true, DONE`.
 *
 * Properties this module keeps, deliberately:
 *  - No LLM, no I/O, no clock. Pure function of its input, < 1s on a full script.
 *  - Exact-substring / exact-value matching only. No fuzzy matching — fuzziness is
 *    exactly what a fabricator needs to slip through (same reasoning as
 *    `training-core`'s `validateAnalysis` grounding check).
 *  - Two legal escape hatches, both narrow and both visible in the prose:
 *    a sentence that openly marks itself as hypothetical ("giả sử …") may carry
 *    unsourced numbers; and ordinary common knowledge (everyday time spans,
 *    canonical fractions, attributed conventions) is not a claim needing a
 *    source at all — see `isCommonKnowledgeClaim`. Neither hatch covers money,
 *    ages, multiples or dated facts, and fake *biography* stays blocked because
 *    proper nouns are checked separately and the WRITE prompt forbids naming a
 *    hypothetical person.
 *
 * What it does NOT do (documented gaps, covered by the editor layer in Phase 4):
 *  - Single-word Vietnamese numerals ("bốn năm trước", "tháng thứ tám"). Only
 *    digits and COMPOUND numerals ("hai mươi lăm triệu") are extracted — a
 *    single numeral word is far more often ordinary prose than fake specificity,
 *    and false positives here cost a repair round.
 *  - Whether a sourced number is used *honestly* (right subject, right year).
 *  - UNQUOTED, lowercase coined labels ("mặt sàn lối sống"). Measured against the
 *    real audit scripts, every generic repeated-phrase detector (n-gram repeats,
 *    naming-position n-grams) fires on clean scripts too — a gate that always
 *    fires is not a gate. Check 4 therefore counts only labels a reader can see
 *    as labels (quoted / capitalised) plus the ones the writer declares itself
 *    (`declaredCoinedLabels`, from the WRITE stage). Undeclared lowercase labels
 *    are the editor layer's job (Phase 4 Layer 1, learnings §12 checklist).
 */
import type { WriterVideoPlan } from './video-plan.ts';
import { countScriptWords, findIdentityLeak } from './script-checks.ts';

/** One fact the STUDY stage committed to, with the pack quote that backs it. */
export interface LedgerEntry {
  fact: string;
  videoId?: string;
  /** Must be an exact substring of the topic pack markdown. */
  quote: string;
}

export type GateViolationCode =
  /** A ledger entry quotes something that is not in the pack — the ledger itself lied. */
  | 'LEDGER_QUOTE_UNGROUNDED'
  /** A number in the script traces back to neither the ledger nor the pack. */
  | 'NUMBER_UNSOURCED'
  /** A capitalised name in the script appears in neither the ledger nor the pack. */
  | 'PROPER_NOUN_UNSOURCED'
  /** More than `MAX_COINED_LABELS` self-coined, repeated labels. */
  | 'COINED_LABEL_OVERLOAD'
  /** An outline beat has no declared anchor. */
  | 'BEAT_ANCHOR_MISSING'
  /** A declared anchor is not an exact substring of the script. */
  | 'BEAT_ANCHOR_UNGROUNDED'
  | 'WORD_BAND'
  | 'HOST_IDENTITY';

export interface GateViolation {
  code: GateViolationCode;
  detail: string;
  /** The offending fragment of the script, when there is one. */
  quote?: string;
}

export interface GateInput {
  script: string;
  /** Topic pack markdown — the ONLY warehouse of facts for a v2 run. */
  packMarkdown: string;
  /** STUDY-stage output. Absent for older runs → numbers are matched against the pack directly. */
  factsLedger?: LedgerEntry[];
  /** STUDY-stage outline; enables the beat-coverage check. */
  outline?: WriterVideoPlan;
  /** One verbatim script quote per outline beat, declared by the writer. */
  beatAnchors?: string[];
  wordRange?: { minWords: number; maxWords: number };
  forbiddenNames?: string[];
  /** Labels the writer itself declared coining, from the WRITE stage output. */
  declaredCoinedLabels?: string[];
}

export interface GateResult {
  passed: boolean;
  violations: GateViolation[];
}

/** §Phase 0 check 4 — three coined labels in one script is the failure mode seen in
 * the audit ("mặt sàn lối sống" / "chi tiêu danh tính" / "quyền nhúc nhích"). */
export const MAX_COINED_LABELS = 2;

/** A label has to actually be used as a label to count — one mention is a phrase. */
const COINED_LABEL_MIN_REPEATS = 3;

/**
 * The legal escape hatch (check 3). A sentence carrying one of these openly says
 * "this number is invented for illustration", which is a real editorial move in
 * the source channel ("tôi sẽ lấy một cái ví dụ thậm xưng…"). Anything unmarked is
 * a claim about the world and needs a source.
 */
const ASSUMPTION_MARKERS = [
  'giả sử',
  'giả dụ',
  'giả định',
  'ví dụ',
  'thử hình dung',
  'hình dung thử',
  'tạm lấy',
  'tạm tính',
  'cho dễ hình dung',
];

/**
 * Common-knowledge exemption (check 1b, added 2026-08-14 at the user's call:
 * "những kiến thức phổ thông để agent thoải mái writer").
 *
 * Without it the gate fires on ordinary prose — "quỹ dự phòng 3 tới 6 tháng",
 * "trả góp 0% trong 12 tháng" — and a gate that fires on clean writing gets
 * ignored. With it, the hole has to stay small enough that the fabrication case
 * it exists to stop still fails. Three constraints do that, all in code:
 *
 *  1. **Money and age are never common knowledge.** Every fabricated figure in
 *     run `7d626c50` was money (380.000 đồng, 9 / 2,5 / 6,5 / 2,2 / 1,5 / 13 / 25
 *     triệu) or an age (28 tuổi). Those are the specifics that make an invented
 *     case feel real, so they stay strict no matter how the sentence is worded.
 *     `lần` is excluded too — "25 lần chi phí năm" is a research figure.
 *  2. **Only rule-of-thumb SHAPES qualify.** Integers only: a decimal ("2,5") is
 *     a measurement, not a convention. Values above 100 stay strict, which is
 *     what keeps years — "nghiên cứu ở Mỹ vào năm 1994" — inside the
 *     must-be-sourced set, matching the rule that scientific/historical data may
 *     never be invented.
 *  3. **Anything beyond the universal constants needs a visible attribution.**
 *     "20 năm", "80%" pass only in a sentence that says where the convention
 *     comes from ("chuyên gia thường khuyên…", "thông thường…"). The reader can
 *     see the hedge — same philosophy as the assumption-marker escape.
 *
 * `MONEY_UNITS` lists the canonical spellings AND the short suffixes (`k` / `tr` /
 * `đ`), so a caller reaching `isCommonKnowledgeClaim` with a raw unit still gets the
 * strict money rule. `normalizeUnit` folds the short forms away before the gate sees
 * them; this set is the safety net if that ever stops being true.
 */
const MONEY_UNITS = new Set(['triệu', 'nghìn', 'ngàn', 'tỷ', 'tỉ', 'đồng', 'usd', 'đô', 'k', 'tr', 'đ']);
const NEVER_COMMON_UNITS = new Set([...MONEY_UNITS, 'tuổi', 'lần', 'người']);
const TIME_UNITS = new Set(['năm', 'tháng', 'tuần', 'ngày', 'giờ', 'phút']);

/** Tier 1 — no attribution needed. Too generic to ever be fake specificity. */
const UNIVERSAL_TIME_MAX = 12;
const CANONICAL_PERCENTS = new Set([0, 25, 50, 75, 100]);

/** Tier 2 — conventional wisdom; allowed only with one of these in the sentence. */
const COMMON_KNOWLEDGE_MARKERS = [
  'chuyên gia',
  'thường thì',
  'thông thường',
  'người ta thường',
  'người ta hay',
  'thường được',
  'thường khuyên',
  'lời khuyên',
  'phổ biến',
  'quy tắc',
  'nguyên tắc chung',
  'ai cũng biết',
  'nhìn chung',
  'đa số',
  'trung bình',
  'kinh điển',
];

/**
 * Units that turn a bare number into a factual claim.
 *
 * The short money suffixes (`k`, `tr`, `đ`) sit LAST on purpose: alternation in JS
 * is first-match-wins, so `tr` ahead of `triệu` would clip "13 triệu" down to
 * "13 tr" and lose the multiplier. Each carries a negative lookahead because they
 * are also the opening letters of very common Vietnamese words — without it `k`
 * fires inside "km"/"kg"/"kể", `tr` inside "trong"/"trăm"/"trở", and `đ` inside
 * "đến"/"được"/"đô". `\p{M}` is in the guard so a decomposed (NFD) input, where the
 * next code point is a combining mark rather than a letter, is rejected too.
 */
const NOT_LETTER = '(?![\\p{L}\\p{M}])';
const UNIT_PATTERN = 'triệu|nghìn|ngàn|tỷ|tỉ|đồng|usd|đô|tuổi|lần|%|phần trăm|năm|tháng|tuần|ngày|giờ|phút|người'
  + `|tr${NOT_LETTER}|đ${NOT_LETTER}|k${NOT_LETTER}`;

const DIGIT_CLAIM_RE = new RegExp(`(\\d[\\d.,]*)\\s*(${UNIT_PATTERN})`, 'giu');

/**
 * Vietnamese writes a date the other way round — "năm 1994", "thập niên 90" — so
 * the unit-first order needs its own pattern. Without it the single most
 * important class of must-be-sourced number (the year on a study or a historical
 * event) was invisible to the gate: "một nghiên cứu ở Mỹ năm 1994" extracted
 * nothing at all. Found while testing the common-knowledge exemption, 2026-08-14.
 */
const DATE_CLAIM_RE = /(năm|tháng|thế kỷ|thập niên|thập kỷ)\s+(\d[\d.,]*)/giu;

/** Vietnamese numeral words we can score. `mươi`/`mười` handle the tens. */
const NUMERAL_WORDS: Record<string, number> = {
  không: 0, một: 1, mốt: 1, hai: 2, ba: 3, bốn: 4, tư: 4, năm: 5, lăm: 5,
  sáu: 6, bảy: 7, bẩy: 7, tám: 8, chín: 9, mười: 10, mươi: 10, trăm: 100,
};

const WORD_CLAIM_RE = new RegExp(
  `((?:${Object.keys(NUMERAL_WORDS).join('|')})(?:\\s+(?:${Object.keys(NUMERAL_WORDS).join('|')})){1,4})\\s+(${UNIT_PATTERN})`,
  'giu',
);

/** Words that open a clause and are therefore capitalised without being names. */
const SENTENCE_BOUNDARY = /[.!?…:;\n"“”'’()\[\]—–\-*|]/;

interface NumericClaim {
  raw: string;
  value: number;
  unit: string;
  sentence: string;
}

function normalizeUnit(unit: string): string {
  const u = unit.toLowerCase().trim();
  if (u === 'tỉ') return 'tỷ';
  if (u === 'ngàn') return 'nghìn';
  if (u === 'phần trăm') return '%';
  if (u === 'đô') return 'usd';
  // Short money suffixes are spellings, not different units.
  if (u === 'k') return 'nghìn';
  if (u === 'tr') return 'triệu';
  if (u === 'đ') return 'đồng';
  return u;
}

/**
 * Vietnamese thousands separator is `.` and the decimal comma is `,` — so
 * "380.000" is 380000 and "2,5" is 2.5. Stripping both blindly (the naive
 * normalisation) would collapse "2,5 triệu" onto "25 triệu" and silently source a
 * fabricated number from a real one.
 */
function parseDigits(raw: string): number | null {
  const cleaned = raw.replace(/[.,]$/, '');
  if (!/\d/.test(cleaned)) return null;
  const commaDecimal = /,\d{1,2}$/.test(cleaned);
  let normalized = cleaned.replaceAll('.', '');
  normalized = commaDecimal ? normalized.replace(',', '.') : normalized.replaceAll(',', '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** "hai mươi lăm" → 25, "ba trăm" → 300, "mười lăm" → 15. Null when unscorable. */
export function parseVietnameseNumeral(phrase: string): number | null {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  let total = 0;
  let current = 0;
  let sawValue = false;
  for (const [i, word] of words.entries()) {
    const v = NUMERAL_WORDS[word];
    if (v === undefined) return null;
    if (word === 'trăm') {
      if (current === 0) return null;
      current *= 100;
      sawValue = true;
    } else if (word === 'mươi') {
      if (current === 0) return null;
      current *= 10;
      sawValue = true;
    } else if (word === 'mười') {
      // "mười lăm" = 15; "hai mười" is not idiomatic, treat as tens anyway.
      current = current === 0 ? 10 : current * 10;
      sawValue = true;
    } else {
      // A plain digit word: it either fills the units slot or starts a new group.
      if (i > 0 && (words[i - 1] === 'trăm' || words[i - 1] === 'mươi' || words[i - 1] === 'mười')) {
        current += v;
      } else if (current === 0) {
        current = v;
      } else {
        total += current;
        current = v;
      }
      sawValue = true;
    }
  }
  if (!sawValue) return null;
  return total + current;
}

/** Sentence split that keeps the sentence text (needed for the marker escape). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasAssumptionMarker(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return ASSUMPTION_MARKERS.some((m) => lower.includes(m));
}

function hasCommonKnowledgeMarker(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return COMMON_KNOWLEDGE_MARKERS.some((m) => lower.includes(m));
}

/**
 * True when a number is ordinary knowledge rather than a claim needing a source.
 * See `MONEY_UNITS`'s doc comment for why the three constraints are what they are.
 * Exported so the rule can be unit-tested on its own — this is the one place the
 * gate deliberately lets something through, so it gets its own tests.
 */
export function isCommonKnowledgeClaim(
  claim: { value: number; unit: string },
  sentence: string,
): boolean {
  const { value, unit } = claim;
  if (NEVER_COMMON_UNITS.has(unit)) return false;
  if (!Number.isInteger(value)) return false;
  if (value < 0 || value > 100) return false;

  if (unit === '%') {
    if (CANONICAL_PERCENTS.has(value)) return true;
    return hasCommonKnowledgeMarker(sentence);
  }
  if (TIME_UNITS.has(unit)) {
    if (value <= UNIVERSAL_TIME_MAX) return true;
    return hasCommonKnowledgeMarker(sentence);
  }
  return false;
}

/** Every (value, unit) claim in a text, digits and compound numerals alike. */
export function extractNumericClaims(text: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  for (const sentence of splitSentences(text)) {
    for (const m of sentence.matchAll(DIGIT_CLAIM_RE)) {
      const value = parseDigits(m[1] ?? '');
      if (value === null) continue;
      claims.push({ raw: m[0], value, unit: normalizeUnit(m[2] ?? ''), sentence });
    }
    for (const m of sentence.matchAll(WORD_CLAIM_RE)) {
      const value = parseVietnameseNumeral(m[1] ?? '');
      if (value === null) continue;
      claims.push({ raw: m[0], value, unit: normalizeUnit(m[2] ?? ''), sentence });
    }
    for (const m of sentence.matchAll(DATE_CLAIM_RE)) {
      const value = parseDigits(m[2] ?? '');
      if (value === null) continue;
      claims.push({ raw: m[0], value, unit: normalizeUnit(m[1] ?? ''), sentence });
    }
  }
  return claims;
}

/**
 * VND scale factors, keyed by the CANONICAL unit `normalizeUnit` produces.
 * `usd` / `đô` is deliberately absent: an exchange rate moves, so folding dollars
 * into đồng would invent matches ("4000 đô" ≈ "100 triệu" only at one moment in
 * time). Dollars keep their own unit and match only other dollars.
 */
const VND_SCALE: Record<string, number> = {
  đồng: 1,
  nghìn: 1_000,
  triệu: 1_000_000,
  tỷ: 1_000_000_000,
};

/**
 * The identity of a numeric claim, used to match a script number against the
 * ledger and the pack. Money is folded to đồng so that a writer is not forced to
 * copy the pack's *spelling* of an amount into a voiceover: "900 nghìn",
 * "900.000đ" and "0,9 triệu" are one claim, and the gate is left checking
 * fabrication rather than typography.
 *
 * The scaling happens HERE, downstream of `parseDigits`, and that ordering is the
 * whole safety argument: `parseDigits` has already resolved "2,5" → 2.5 and
 * "380.000" → 380000, so "2,5 triệu" (2_500_000) and "25 triệu" (25_000_000) stay
 * two different keys. Scaling before the separator/decimal split would collapse
 * them and source a fabricated figure from a real one — the exact bug
 * `parseDigits`'s comment warns about.
 *
 * `Math.round` only removes binary-float dust (0.1 * 1_000 is 100.00000000000001,
 * which would otherwise never equal the 100_000 written as "100 nghìn"); đồng is
 * the smallest unit in circulation, so there is nothing below it to lose.
 */
function claimKey(claim: { value: number; unit: string }): string {
  const unit = normalizeUnit(claim.unit);
  const scale = VND_SCALE[unit];
  if (scale === undefined) return `${claim.value}|${unit}`;
  return `${Math.round(claim.value * scale)}|đồng`;
}

/**
 * Capitalised name candidates that are NOT at a clause boundary. Vietnamese only
 * capitalises proper nouns mid-sentence, so this stays a usable signal without a
 * dictionary. Consecutive capitalised tokens are joined ("Quận 3", "Hồ Chí Minh").
 */
export function extractProperNouns(text: string): Array<{ name: string; sentence: string }> {
  const out: Array<{ name: string; sentence: string }> = [];
  for (const sentence of splitSentences(text)) {
    const tokens = sentence.split(/\s+/).filter(Boolean);
    let group: string[] = [];
    // The first token of a clause is capitalised by orthography, not by naming —
    // it is never evidence of a proper noun on its own.
    let atClauseStart = true;
    const flush = () => {
      if (group.length > 0) out.push({ name: group.join(' '), sentence });
      group = [];
    };
    for (const token of tokens) {
      const word = token.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
      const capitalised = /^\p{Lu}/u.test(word);
      // ALL-CAPS is a shout or an acronym in a title, not a name candidate.
      const isAllCaps = word.length > 1 && word === word.toUpperCase();
      if (capitalised && !atClauseStart && !isAllCaps) group.push(word);
      else flush();
      // Punctuation attached to this token (or an opening quote/bracket ahead of
      // the next word) starts a new clause.
      atClauseStart = SENTENCE_BOUNDARY.test(token.slice(-1));
    }
    flush();
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.toLowerCase().indexOf(needle.toLowerCase(), from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** Repeated self-coined labels: quoted phrases, or repeated capitalised phrases. */
export function extractCoinedLabels(script: string): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  const bump = (label: string) => {
    const key = label.trim().toLowerCase();
    if (key.length < 4) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const m of script.matchAll(/[“"']([^“”"'\n]{4,60})[”"']/gu)) bump(m[1] ?? '');
  for (const { name } of extractProperNouns(script)) {
    if (name.includes(' ')) bump(name);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= COINED_LABEL_MIN_REPEATS)
    .map(([label, count]) => ({ label, count }));
}

/**
 * The gate. Checks run in the order of the plan (§Phase 0) and every violation is
 * collected — a writer repairing the script should see the whole list once, not
 * discover it one round at a time.
 */
export function runDeterministicGate(input: GateInput): GateResult {
  const violations: GateViolation[] = [];
  const script = input.script.normalize('NFC');
  const pack = input.packMarkdown.normalize('NFC');
  const ledger = input.factsLedger ?? [];

  // ── 0. The ledger must itself be grounded in the pack ────────────────────
  const groundedLedger: LedgerEntry[] = [];
  for (const entry of ledger) {
    const quote = (entry.quote ?? '').normalize('NFC').trim();
    if (!quote || !pack.includes(quote)) {
      violations.push({
        code: 'LEDGER_QUOTE_UNGROUNDED',
        detail: `factsLedger entry "${entry.fact}" quotes text that is not an exact substring of the topic pack`,
        quote: quote || undefined,
      });
      continue;
    }
    groundedLedger.push({ ...entry, quote });
  }

  // Source of truth for facts: grounded ledger quotes when a ledger exists,
  // otherwise the pack itself (older runs / manual checks).
  const sourceText = groundedLedger.length > 0
    ? groundedLedger.map((e) => e.quote).join('\n')
    : pack;
  const sourceClaims = new Set(extractNumericClaims(sourceText).map(claimKey));
  // The pack is always allowed as a fallback source for numbers even with a
  // ledger present: the ledger is a *shortlist*, not an exhaustive index, and a
  // number quoted verbatim from the pack is by definition not fabricated.
  const packClaims = new Set(extractNumericClaims(pack).map(claimKey));

  // ── 1 + 3. Numeric claims, with the assumption-marker escape ─────────────
  const reportedNumbers = new Set<string>();
  for (const claim of extractNumericClaims(script)) {
    const key = claimKey(claim);
    if (sourceClaims.has(key) || packClaims.has(key)) continue;
    if (hasAssumptionMarker(claim.sentence)) continue;
    if (isCommonKnowledgeClaim(claim, claim.sentence)) continue;
    if (reportedNumbers.has(key)) continue;
    reportedNumbers.add(key);
    violations.push({
      code: 'NUMBER_UNSOURCED',
      detail:
        `"${claim.raw}" has no source: it is not in factsLedger/pack, its sentence is not marked `
        + 'as hypothetical (giả sử / ví dụ / thử hình dung / tạm lấy), and it does not qualify as '
        + 'common knowledge (money, ages and multiples never do)',
      quote: claim.sentence.slice(0, 200),
    });
  }

  // ── 2 + 3. Proper nouns ──────────────────────────────────────────────────
  const reportedNames = new Set<string>();
  const ledgerText = groundedLedger.map((e) => `${e.fact}\n${e.quote}`).join('\n');
  for (const { name, sentence } of extractProperNouns(script)) {
    if (name.length < 2) continue;
    if (pack.includes(name) || ledgerText.includes(name)) continue;
    if (hasAssumptionMarker(sentence)) continue;
    if (reportedNames.has(name)) continue;
    reportedNames.add(name);
    violations.push({
      code: 'PROPER_NOUN_UNSOURCED',
      detail:
        `proper noun "${name}" appears in neither the topic pack nor factsLedger — `
        + 'a hypothetical person must stay unnamed',
      quote: sentence.slice(0, 200),
    });
  }

  // ── 4. Coined labels ─────────────────────────────────────────────────────
  const detected = extractCoinedLabels(script);
  const coined = new Map(detected.map((c) => [c.label, c.count]));
  for (const declared of input.declaredCoinedLabels ?? []) {
    const label = declared.trim().toLowerCase();
    if (!label || coined.has(label)) continue;
    coined.set(label, countOccurrences(script, declared.trim()));
  }
  if (coined.size > MAX_COINED_LABELS) {
    violations.push({
      code: 'COINED_LABEL_OVERLOAD',
      detail:
        `${coined.size} self-coined repeated labels (max ${MAX_COINED_LABELS}): `
        + [...coined].map(([label, count]) => `"${label}" ×${count}`).join(', '),
    });
  }

  // ── 5. Beat coverage ─────────────────────────────────────────────────────
  if (input.outline) {
    const beats = input.outline.progression ?? [];
    const anchors = input.beatAnchors ?? [];
    for (const [i, beat] of beats.entries()) {
      const anchor = anchors[i]?.normalize('NFC').trim();
      if (!anchor) {
        violations.push({
          code: 'BEAT_ANCHOR_MISSING',
          detail: `beat ${i + 1} ("${beat.beat}") has no beatAnchor — the script may have skipped it`,
        });
        continue;
      }
      if (!script.includes(anchor)) {
        violations.push({
          code: 'BEAT_ANCHOR_UNGROUNDED',
          detail: `beatAnchor for beat ${i + 1} ("${beat.beat}") is not an exact substring of the script`,
          quote: anchor.slice(0, 200),
        });
      }
    }
    if (anchors.length > beats.length) {
      violations.push({
        code: 'BEAT_ANCHOR_MISSING',
        detail: `beatAnchors has ${anchors.length} entries for ${beats.length} beats — one anchor per beat`,
      });
    }
  }

  // ── 6. Word band + forbidden host names ──────────────────────────────────
  if (input.wordRange) {
    const words = countScriptWords(script);
    const { minWords, maxWords } = input.wordRange;
    if (words < minWords || words > maxWords) {
      violations.push({
        code: 'WORD_BAND',
        detail: `script is ${words} words — band is ${minWords}-${maxWords}`,
      });
    }
  }
  const leak = findIdentityLeak(script, input.forbiddenNames ?? []);
  if (leak) {
    violations.push({
      code: 'HOST_IDENTITY',
      detail: `script adopts source-host identity "${leak}"`,
    });
  }

  return { passed: violations.length === 0, violations };
}

/** One-line-per-violation rendering for prompts and `errorReason`. */
export function formatGateViolations(violations: GateViolation[]): string {
  return violations
    .map((v) => `- [${v.code}] ${v.detail}${v.quote ? `\n    …${v.quote}…` : ''}`)
    .join('\n');
}
