#!/usr/bin/env bun
/**
 * `writer:regate` — a REPORT on a script that was restyled outside the pipeline.
 *
 *   bun writer:regate <runId> <path-to-restyled.txt|.md>
 *
 * Why this exists: a v2 run ends at `finalScript`, and a human then rewrites that
 * script by hand — new address form, a named character carried through every beat,
 * different heading shapes. The rewrite never passes through STUDY → WRITE → GATE
 * again, so nothing re-reads it against the Source Pack. This CLI re-reads it and
 * PRINTS what it sees, grouped so a reader can scan it in one pass.
 *
 * It NEVER blocks. Every path ends in `process.exit(0)` — violations, a missing run,
 * a missing file, bad arguments. That is a design choice, not an oversight: a
 * legitimate restyle breaks checks the gate enforces on generated prose (see the
 * outline/beatAnchors note in section 1), so a non-zero exit here would teach the
 * reader to ignore the report, and would let some future script treat it as a gate.
 * The gate itself (`writer/deterministic-gate.ts`) is untouched by this file, and no
 * new `GateViolationCode` is introduced — everything below is reporting only.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dataRoot } from './paths.ts';
import {
  extractNumericClaims,
  extractProperNouns,
  runDeterministicGate,
  type GateViolation,
  type LedgerEntry,
} from './writer/deterministic-gate.ts';
import { getWriterRunV2 } from './writer/run-store-v2.ts';
import { countScriptWords, forbiddenHostNames, targetWordRange } from './writer/script-checks.ts';
import { getWriterPack } from './writer-packs.ts';

const DEFAULT_TARGET_WORDS = 2300;

/** Relative tolerance for "this number can be derived from those numbers". */
const DERIVE_TOLERANCE = 0.01;

/** Hard ceiling on the 3-number search (per number under test). */
const MAX_TRIPLE_COMBOS = 200_000;

/** Section 4 is a reading aid, not a check — it has to stay short enough to read. */
const MAX_REPEAT_ROWS = 15;
/** Two mentions is a coincidence; three is a habit. Same bar as the single-word list. */
const REPEAT_MIN_COUNT = 3;
const MAX_METAPHOR_ROWS = 10;

/**
 * Money scale, VND. Written here on purpose instead of imported: the gate's own
 * unit handling is private to it, and this file must not reach into it — a report
 * that shares internals with the gate would drift into being a second gate.
 * `k` / `tr` are included because a restyle sometimes leaves the shorthand behind
 * (section 3 flags those separately).
 */
const MONEY_SCALE: Record<string, number> = {
  đồng: 1,
  đ: 1,
  nghìn: 1e3,
  ngàn: 1e3,
  k: 1e3,
  triệu: 1e6,
  tr: 1e6,
  tỷ: 1e9,
  tỉ: 1e9,
};

/** Verbs that put words in someone's mouth (section 6). */
const SPEECH_VERBS = ['nói', 'kể', 'viết', 'thừa nhận', 'tự nhủ', 'chia sẻ', 'tâm sự', 'thú nhận'];

/**
 * Function words. Section 4 drops any n-gram made only of these — otherwise the
 * whole list is "của một", "là không", and the reader stops looking at it.
 */
const STOPWORDS = new Set([
  'của', 'là', 'và', 'một', 'những', 'trong', 'cho', 'với', 'không', 'mà', 'thì',
  'bạn', 'anh', 'chị', 'các', 'có', 'được', 'đã', 'sẽ', 'đang', 'này', 'đó', 'ấy',
  'ra', 'vào', 'lên', 'nó', 'cũng', 'vì', 'khi', 'để', 'ở', 'từ', 'tôi', 'mình',
  'người', 'ai', 'gì', 'nếu', 'nhưng', 'còn', 'chỉ', 'đến', 'tới', 'hơn', 'rất',
  'thêm', 'đi', 'làm', 'lại', 'nữa', 'sau', 'trước', 'trên', 'dưới', 'bằng', 'như',
  'hoặc', 'hay', 'rồi', 'nên', 'phải', 'bị', 'do', 'mỗi', 'nhiều', 'ít', 'thứ',
  'cái', 'con', 'chưa', 'vẫn', 'đều', 'thật', 'sự', 'việc', 'khác', 'nào', 'mấy',
]);

// ── Number model ──────────────────────────────────────────────────────────

/**
 * One number as it appears in a text, folded onto a comparable (value, unit).
 * Money collapses to `vnd`, counts (`lần`, bare digits) collapse to `count`, and
 * everything else keeps the unit the gate assigned it.
 */
interface NumberNode {
  /** As written, for printing back to the reader. */
  raw: string;
  value: number;
  unit: string;
  /** Index of the blank-line-separated block this occurrence sits in. */
  block: number;
  sentence: string;
}

function normalizeNode(value: number, unit: string): { value: number; unit: string } {
  const scale = MONEY_SCALE[unit];
  if (scale !== undefined) return { value: value * scale, unit: 'vnd' };
  // A count is a multiplier, not a quantity — "10 kỳ" and "mười lần" are the same role.
  if (unit === 'lần' || unit === 'kỳ' || unit === 'count') return { value, unit: 'count' };
  return { value, unit };
}

function nodeKey(node: { value: number; unit: string }): string {
  return `${node.value}|${node.unit}`;
}

/** Same Vietnamese digit grouping the gate uses: `.` groups thousands, `,` is decimal. */
function parseDigits(raw: string): number | null {
  const cleaned = raw.replace(/[.,]$/, '');
  if (!/\d/.test(cleaned)) return null;
  const commaDecimal = /,\d{1,2}$/.test(cleaned);
  let normalized = cleaned.replaceAll('.', '');
  normalized = commaDecimal ? normalized.replace(',', '.') : normalized.replaceAll(',', '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * A unit right after the digits means the gate already extracted this number as a
 * claim — the bare-count scan must not pick it up a second time. The short money
 * suffixes carry a not-a-letter guard for the same reason the gate's pattern does:
 * bare `tr` / `k` / `đ` otherwise fire inside "trong", "kể", "đến".
 */
const UNIT_AHEAD_RE = /^\s*(triệu|nghìn|ngàn|tỷ|tỉ|đồng|usd|đô|tuổi|lần|%|phần trăm|năm|tháng|tuần|ngày|giờ|phút|người|tr(?![\p{L}\p{M}])|k(?![\p{L}\p{M}])|đ(?![\p{L}\p{M}]))/iu;
const DATE_WORD_BEHIND_RE = /(năm|tháng|thế kỷ|thập niên|thập kỷ)\s*$/iu;

/**
 * Bare digits — a number with no unit after it ("qua 10 kỳ", "chia 3 lần đầu").
 * The gate ignores these (rightly: no unit, no claim), but a restyle derives real
 * figures from them, so the report needs them as MULTIPLIERS. Only plausible counts
 * qualify (integers 2..1000): "1" makes every number trivially derivable as `x × 1`,
 * and a big bare number ("130.000") is a quantity that lost its unit, not a count.
 */
function extractBareCounts(block: string, blockIndex: number, sentences: string[]): NumberNode[] {
  const out: NumberNode[] = [];
  for (const m of block.matchAll(/\d[\d.,]*/gu)) {
    const at = m.index ?? 0;
    const raw = m[0];
    if (UNIT_AHEAD_RE.test(block.slice(at + raw.length))) continue;
    if (DATE_WORD_BEHIND_RE.test(block.slice(Math.max(0, at - 12), at))) continue;
    const value = parseDigits(raw);
    if (value === null || !Number.isInteger(value) || value < 2 || value > 1000) continue;
    const sentence = sentences.find((s) => s.includes(raw)) ?? block;
    out.push({ raw, value, unit: 'count', block: blockIndex, sentence });
  }
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitBlocks(text: string): string[] {
  return text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
}

/** Every number in `text`, block by block, normalized and ready to compare. */
function collectNumbers(text: string): NumberNode[] {
  const out: NumberNode[] = [];
  for (const [blockIndex, block] of splitBlocks(text).entries()) {
    for (const claim of extractNumericClaims(block)) {
      const norm = normalizeNode(claim.value, claim.unit);
      out.push({ raw: claim.raw.trim(), ...norm, block: blockIndex, sentence: claim.sentence });
    }
    out.push(...extractBareCounts(block, blockIndex, splitSentences(block)));
  }
  return out;
}

// ── Derivation search (section 2) ─────────────────────────────────────────

interface Candidate {
  value: number;
  unit: string;
  formula: string;
}

interface Derivation {
  /** Which test found it — printed so the reader can weigh how strong it is. */
  test: string;
  formula: string;
  note?: string;
}

function close(candidate: number, target: number): boolean {
  if (!Number.isFinite(candidate)) return false;
  if (target === 0) return candidate === 0;
  return Math.abs(candidate - target) <= Math.abs(target) * DERIVE_TOLERANCE;
}

/**
 * Every value reachable from an ordered pair. Two shapes only, both ones a reader
 * could do in their head:
 *  - same unit: sum, difference, and the ratio (a share, printed as % or a multiple)
 *  - quantity × / ÷ a count: "1,3 triệu mỗi kỳ × 10 kỳ"
 */
function* pairCandidates(a: NumberNode, b: NumberNode): Generator<Candidate> {
  if (a.unit === b.unit) {
    yield { value: a.value + b.value, unit: a.unit, formula: `${a.raw} + ${b.raw}` };
    yield { value: a.value - b.value, unit: a.unit, formula: `${a.raw} − ${b.raw}` };
    if (b.value !== 0) {
      yield { value: a.value / b.value, unit: 'count', formula: `${a.raw} / ${b.raw}` };
      yield { value: (a.value / b.value) * 100, unit: '%', formula: `${a.raw} / ${b.raw}` };
    }
  }
  if (b.unit === 'count' && b.value >= 2 && a.unit !== 'count') {
    yield { value: a.value * b.value, unit: a.unit, formula: `${a.raw} × ${b.raw}` };
    yield { value: a.value / b.value, unit: a.unit, formula: `${a.raw} / ${b.raw}` };
  }
}

interface PercentRate {
  value: number;
  label: string;
  source: string;
}

/** Percentages the STUDY stage committed to — the legal rates a restyle may apply. */
function ledgerRates(ledger: LedgerEntry[]): PercentRate[] {
  const out: PercentRate[] = [];
  const seen = new Set<string>();
  for (const entry of ledger) {
    for (const claim of extractNumericClaims(entry.quote ?? '')) {
      if (claim.unit !== '%') continue;
      const key = `${claim.value}|${entry.fact}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value: claim.value, label: claim.raw.trim(), source: entry.fact });
    }
  }
  return out;
}

interface DeriveContext {
  packNumbers: NumberNode[];
  rates: PercentRate[];
}

interface DeriveOptions {
  skipPackTest?: boolean;
  /** Search steps that were skipped, printed next to the number so nothing is cut silently. */
  warnings?: string[];
  /** Numbers already judged fabricated — they may not back another number. */
  excludeKeys?: Set<string>;
}

/**
 * Can `target` be reached from `pool`? Tests run in order and stop at the first hit,
 * cheapest and most convincing first.
 */
function findDerivation(
  target: NumberNode,
  pool: NumberNode[],
  ctx: DeriveContext,
  opts: DeriveOptions = {},
): Derivation | null {
  const targetKey = nodeKey(target);
  const operands = pool.filter(
    (n) => nodeKey(n) !== targetKey && !opts.excludeKeys?.has(nodeKey(n)),
  );

  // (a) the pack already carries this exact quantity, just in another context —
  // the gate misses it because it compares (value, unit) as written and the restyle
  // changed the unit ("0,39 triệu" in the pack vs "390.000 đồng" in the script).
  if (!opts.skipPackTest) {
    const inPack = ctx.packNumbers.find((n) => nodeKey(n) === targetKey);
    if (inPack) {
      return {
        test: 'a) có trong pack',
        formula: `"${inPack.raw}"`,
        note: `có trong pack, khác ngữ cảnh: …${inPack.sentence.slice(0, 110)}…`,
      };
    }
  }

  // (b) two numbers the reader already has.
  for (const a of operands) {
    for (const b of operands) {
      if (a === b) continue;
      for (const cand of pairCandidates(a, b)) {
        if (cand.unit === target.unit && close(cand.value, target.value)) {
          return { test: 'b) tổ hợp 2 số', formula: `${cand.formula} = ${target.raw}` };
        }
      }
    }
  }

  // (c) three numbers of the same unit, summed. Distinct values only, repetition
  // allowed (a script says "1,3 triệu" twice and means two payments).
  const sameUnit = [...new Set(operands.filter((n) => n.unit === target.unit).map((n) => n.value))];
  const byValue = new Map(
    operands.filter((n) => n.unit === target.unit).map((n) => [n.value, n.raw] as const),
  );
  const n = sameUnit.length;
  const combos = (n * (n + 1) * (n + 2)) / 6;
  if (combos > MAX_TRIPLE_COMBOS) {
    // Skipping the step is fine; skipping it QUIETLY is not — a reader would take the
    // number's "BỊA THẲNG" verdict as a full search when it never ran.
    opts.warnings?.push(
      `phép thử c) tổ hợp 3 số: đã bỏ qua vì quá nhiều tổ hợp (${n} số cùng đơn vị → `
      + `${combos.toLocaleString('vi-VN')} > ${MAX_TRIPLE_COMBOS.toLocaleString('vi-VN')})`,
    );
  } else {
    for (let i = 0; i < n; i += 1) {
      for (let j = i; j < n; j += 1) {
        for (let k = j; k < n; k += 1) {
          const sum = sameUnit[i]! + sameUnit[j]! + sameUnit[k]!;
          if (!close(sum, target.value)) continue;
          const parts = [sameUnit[i]!, sameUnit[j]!, sameUnit[k]!].map((v) => byValue.get(v) ?? String(v));
          return { test: 'c) tổ hợp 3 số', formula: `${parts.join(' + ')} = ${target.raw}` };
        }
      }
    }
  }

  // (d) a percentage from the facts ledger applied to another number in reach.
  for (const rate of ctx.rates) {
    for (const x of operands) {
      if (x.unit !== target.unit) continue;
      if (!close((rate.value / 100) * x.value, target.value)) continue;
      return {
        test: 'd) % của một số khác',
        formula: `${rate.label} × ${x.raw} = ${target.raw}`,
        note: `rate ${rate.label} từ factsLedger: ${rate.source}`,
      };
    }
  }

  return null;
}

// ── Rendering helpers ─────────────────────────────────────────────────────

function heading(title: string): void {
  console.log('');
  console.log('─'.repeat(78));
  console.log(title);
  console.log('─'.repeat(78));
}

function cut(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// ── Sections ──────────────────────────────────────────────────────────────

function reportGate(violations: GateViolation[], words: number, band: { minWords: number; maxWords: number }): void {
  heading('MỤC 1 — GATE GỐC (deterministic-gate, không có outline/beatAnchors)');
  console.log(`Độ dài: ${words} từ · band ${band.minWords}-${band.maxWords}`);
  console.log(
    'Đã CỐ Ý bỏ hai check outline + beatAnchors: bản restyle viết lại từng câu nên anchor',
  );
  console.log(
    'do WRITE khai báo không còn là substring của script — hai check đó chỉ báo "đã viết lại",',
  );
  console.log('không nói gì về sự thật, nên chạy chúng ở đây chỉ tạo nhiễu.');
  console.log('');
  if (violations.length === 0) {
    console.log('Không có vi phạm nào.');
    return;
  }
  const byCode = new Map<string, number>();
  for (const v of violations) byCode.set(v.code, (byCode.get(v.code) ?? 0) + 1);
  console.log(`Tổng ${violations.length} vi phạm:`);
  for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code.padEnd(26)} ${count}`);
  }
  const others = violations.filter((v) => v.code !== 'NUMBER_UNSOURCED');
  if (others.length > 0) {
    console.log('');
    console.log('Không phải NUMBER_UNSOURCED (Mục 2 chỉ soi số):');
    for (const v of others) {
      console.log(`  · [${v.code}] ${cut(v.detail, 160)}`);
      if (v.quote) console.log(`      …${cut(v.quote, 110)}…`);
    }
  }
}

interface NumberVerdict {
  node: NumberNode;
  derivation: Derivation | null;
  /** A whole-script hit that failed the proximity rule — reported, never promoted. */
  farHit: Derivation | null;
  warnings: string[];
}

function reportNumbers(
  violations: GateViolation[],
  scriptNumbers: NumberNode[],
  ctx: DeriveContext,
): void {
  heading('MỤC 2 — NUMBER_UNSOURCED: SUY RA ĐƯỢC vs BỊA THẲNG');
  const flagged = violations.filter((v) => v.code === 'NUMBER_UNSOURCED');
  if (flagged.length === 0) {
    console.log('Không có NUMBER_UNSOURCED nào.');
    return;
  }
  console.log(
    'Mỗi số bị gắt được thử suy lại từ các số NẰM CÙNG ĐOẠN với nó (đoạn = khối cách',
  );
  console.log(
    'nhau bằng dòng trống, tính trên mọi lần số đó xuất hiện). Người đọc chỉ cộng trừ',
  );
  console.log(
    'được những số đang nằm trước mắt; nếu nới ra cả script thì hai số bất kỳ ở hai đầu',
  );
  console.log('bài luôn ghép ra được số thứ ba — trường hợp đó in ở cuối mục, không xếp vào',
  );
  console.log('nhóm SUY RA ĐƯỢC. Một số bịa cũng không được dùng làm nguyên liệu để suy ra');
  console.log('số khác.');
  console.log('');

  const targets: NumberNode[] = [];
  for (const v of flagged) {
    const raw = /^"(.+?)" has no source/.exec(v.detail)?.[1]?.trim();
    const node = raw ? scriptNumbers.find((x) => x.raw === raw) : undefined;
    if (!node) {
      console.log(`  ⚠ không map được vi phạm về số: ${cut(v.detail, 120)}`);
      continue;
    }
    targets.push(node);
  }

  const classify = (excludeKeys: Set<string>): NumberVerdict[] =>
    targets.map((node) => {
      const key = nodeKey(node);
      const blocks = new Set(scriptNumbers.filter((x) => nodeKey(x) === key).map((x) => x.block));
      const near = scriptNumbers.filter((x) => blocks.has(x.block));
      const warnings: string[] = [];
      const derivation = findDerivation(node, near, ctx, { warnings, excludeKeys });
      const farHit = derivation
        ? null
        : findDerivation(node, scriptNumbers, ctx, { skipPackTest: true, warnings, excludeKeys });
      return { node, derivation, farHit, warnings };
    });

  // A number derived FROM a fabricated number is still fabricated — otherwise one
  // invented figure launders the next one ("43% = 2,8 triệu / 6,5 triệu" reads as a
  // derivation while 2,8 triệu is itself made up). So: classify, drop whatever came
  // out fabricated from the operand pool, classify again, until the set stops growing.
  let excluded = new Set<string>();
  let verdicts = classify(excluded);
  for (let round = 0; round < 4; round += 1) {
    const next = new Set(excluded);
    for (const v of verdicts) if (!v.derivation) next.add(nodeKey(v.node));
    if (next.size === excluded.size) break;
    excluded = next;
    verdicts = classify(excluded);
  }

  const derived = verdicts.filter((v) => v.derivation);
  const invented = verdicts.filter((v) => !v.derivation);

  console.log(`SUY RA ĐƯỢC — ${derived.length} số (bỏ qua được):`);
  if (derived.length === 0) console.log('  (không có)');
  for (const { node, derivation, warnings } of derived) {
    console.log(`  ✓ ${node.raw}  ←  ${derivation!.formula}   [${derivation!.test}]`);
    if (derivation!.note) console.log(`      ${derivation!.note}`);
    for (const w of new Set(warnings)) console.log(`      ⚠ ${w}`);
  }

  console.log('');
  console.log(`BỊA THẲNG — ${invented.length} số (cần soi):`);
  if (invented.length === 0) console.log('  (không có)');
  for (const { node, farHit, warnings } of invented) {
    console.log(`  ✗ ${node.raw}`);
    console.log(`      ${cut(node.sentence)}`);
    if (farHit) {
      console.log(`      (có tổ hợp khớp nhưng các số nằm rải rác cả bài: ${farHit.formula} — không tính)`);
    }
    for (const w of new Set(warnings)) console.log(`      ⚠ ${w}`);
  }
}

function reportStyle(script: string): void {
  heading('MỤC 3 — LỆCH STYLE BỀ MẶT');
  let ban = 0;
  for (const m of script.matchAll(/(?<!\p{L})bạn(?!\p{L})/giu)) {
    const at = m.index ?? 0;
    // "bạn bè" / "người bạn" are nouns, not the address form.
    if (/^\s*bè/iu.test(script.slice(at + 3))) continue;
    if (/người\s*$/iu.test(script.slice(Math.max(0, at - 8), at))) continue;
    ban += 1;
  }
  const anhChi = [...script.matchAll(/(?<!\p{L})anh\s+chị(?!\p{L})/giu)].length;
  console.log(`Xưng hô: "bạn" ×${ban} · "anh chị" ×${anhChi}`);

  const shorthand = [...script.matchAll(/(\d[\d.,]*)\s*(k|tr)(?!\p{L})/giu)];
  console.log('');
  console.log(`Số viết tắt còn sót (voiceover không đọc được): ${shorthand.length}`);
  const lines = script.split('\n');
  for (const m of shorthand) {
    const at = m.index ?? 0;
    const line = lines.findIndex((_, i) =>
      lines.slice(0, i + 1).join('\n').length > at) + 1;
    console.log(`  · "${m[0]}" (dòng ${line || 1}): …${cut(script.slice(Math.max(0, at - 50), at + 50), 110)}…`);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Section 4 is a READING AID, not a check. The gate's own header records why: measured
 * against the real audit scripts, every generic repeated-phrase detector fires on clean
 * scripts too, so `deterministic-gate.ts` counts only labels a reader can see as labels.
 * The general n-gram sweep therefore lives here, where a human filters it, and it must
 * never become a pass/fail signal.
 */
function reportRepeats(script: string, packMarkdown: string): void {
  heading('MỤC 4 — LẶP CỤM / ẨN DỤ (báo cáo để người đọc lọc, không phải check)');
  const tokens = tokenize(script);
  // The pack, tokenized the same way, so a phrase can be tested against it as words
  // rather than as raw text (punctuation and casing differ between the two).
  const packNormalized = ` ${tokenize(packMarkdown).join(' ')} `;
  // Names the script itself introduces. A phrase built only from a name and function
  // words ("của đức") is the character walking through the piece, not a coined label —
  // Mục 1 already reports the names.
  const properTokens = new Set<string>();
  for (const { name } of extractProperNouns(script)) {
    for (const t of tokenize(name)) properTokens.add(t);
  }
  const counts = new Map<string, number>();
  // Count inside a segment, never across one. A flat token stream glues the end of one
  // sentence to the start of the next and invents phrases nobody wrote ("…một đồng lãi
  // nào. Đức trả…" → "đồng đức ×4").
  const segments = script
    .split(/[.!?…:;\n"“”'’()\[\]—–]+/u)
    .map(tokenize)
    .filter((seg) => seg.length > 0);
  for (let size = 2; size <= 4; size += 1) {
    for (const seg of segments) {
      for (let i = 0; i + size <= seg.length; i += 1) {
        const gram = seg.slice(i, i + size);
        if (gram.every((t) => STOPWORDS.has(t) || properTokens.has(t))) continue;
        // Numbers repeat by design ("1,3 triệu" every time the case is re-stated) and
        // they already have their own section — here they only crowd out real phrases.
        if (gram.some((t) => /\d/.test(t))) continue;
        const key = gram.join(' ');
        // Same rule as the single-word list below: a phrase that is in the pack is the
        // topic's own vocabulary. This is a piece about trả góp, so "trả góp ×21" says
        // nothing; what the writer coined on their own is the only readable signal.
        if (packNormalized.includes(` ${key} `)) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const rows = [...counts.entries()]
    .filter(([, c]) => c >= REPEAT_MIN_COUNT)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  console.log(`Cụm 2–4 từ lặp ≥ ${REPEAT_MIN_COUNT} lần và KHÔNG có trong pack: ${rows.length} cụm`);
  for (const [gram, count] of rows.slice(0, MAX_REPEAT_ROWS)) {
    console.log(`  ${String(count).padStart(3)}× ${gram}`);
  }
  if (rows.length > MAX_REPEAT_ROWS) {
    console.log(`  … đã cắt, còn ${rows.length - MAX_REPEAT_ROWS} cụm nữa không in.`);
  }

  // Repeated single words that are NOT in the pack: the writer's own metaphor
  // vocabulary ("guồng", "bánh xe"). A repeated word from the pack is just the topic.
  const packLower = packMarkdown.toLowerCase();
  const wordCounts = new Map<string, number>();
  for (const t of tokens) wordCounts.set(t, (wordCounts.get(t) ?? 0) + 1);
  const everCapitalised = new Set<string>();
  const everLower = new Set<string>();
  for (const m of script.matchAll(/\p{L}+/gu)) {
    (/^\p{Lu}/u.test(m[0]) ? everCapitalised : everLower).add(m[0].toLowerCase());
  }
  const metaphors = [...wordCounts.entries()]
    .filter(([w, c]) =>
      c >= REPEAT_MIN_COUNT
      && w.length >= 4
      && !STOPWORDS.has(w)
      && !packLower.includes(w)
      // Always-capitalised words are names — Mục 1 already reports those.
      && !(everCapitalised.has(w) && !everLower.has(w)))
    .sort((a, b) => b[1] - a[1]);
  console.log('');
  console.log(`Từ đơn lặp ≥ ${REPEAT_MIN_COUNT} lần và KHÔNG có trong pack (ẩn dụ/nhãn tự đặt): ${metaphors.length}`);
  for (const [word, count] of metaphors.slice(0, MAX_METAPHOR_ROWS)) {
    console.log(`  ${String(count).padStart(3)}× ${word}`);
  }
  if (metaphors.length > MAX_METAPHOR_ROWS) {
    console.log(`  … đã cắt, còn ${metaphors.length - MAX_METAPHOR_ROWS} từ nữa không in.`);
  }
}

function reportSentences(script: string): void {
  heading('MỤC 5 — PHÂN PHỐI ĐỘ DÀI CÂU');
  const lines = script.split('\n').map((l) => l.trim()).filter(Boolean);
  const body: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    const words = line.split(/\s+/).filter(Boolean).length;
    const ends = /[.?!…]$/u.test(line);
    const allCaps = /\p{L}/u.test(line) && line === line.toUpperCase();
    // Headings first, or they land in the histogram as very short "sentences".
    if (!ends || allCaps || (words < 8 && !ends)) {
      dropped += 1;
      continue;
    }
    body.push(line);
  }
  const sentences = splitSentences(body.join('\n'));
  const lengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  console.log(`Đã lọc ${dropped} dòng heading/không kết câu, còn ${body.length} dòng thân bài.`);
  if (lengths.length === 0) {
    console.log('Không còn câu nào để đo.');
    return;
  }
  const median = lengths.length % 2 === 1
    ? lengths[(lengths.length - 1) / 2]!
    : Math.round((lengths[lengths.length / 2 - 1]! + lengths[lengths.length / 2]!) / 2);
  console.log(`Tổng ${lengths.length} câu · min ${lengths[0]} / trung vị ${median} / max ${lengths.at(-1)} từ`);
  console.log(`Câu ≤ 5 từ: ${lengths.filter((l) => l <= 5).length} · câu ≥ 40 từ: ${lengths.filter((l) => l >= 40).length}`);
}

/**
 * Section 6 — a real person's testimony moved into a fictional character's mouth.
 * Nobody upstream can see this: the gate finds the quote in the pack and passes it,
 * and the editor never gets the pack so it cannot know the words were someone's.
 * Heuristic, hence a warning and not a verdict.
 */
function reportQuoteLeak(script: string, packMarkdown: string, ledger: LedgerEntry[]): void {
  heading('MỤC 6 — PERSONA_QUOTE_LEAK (heuristic)');
  const hay = script.normalize('NFC');
  const pack = packMarkdown.normalize('NFC');
  let warnings = 0;
  for (const entry of ledger) {
    const quote = (entry.quote ?? '').normalize('NFC').trim();
    if (quote.length < 20) continue;
    const at = hay.indexOf(quote);
    if (at === -1) continue;
    const from = Math.max(0, at - 80);
    const window = hay.slice(from, at);
    const verb = SPEECH_VERBS.find((v) => window.toLowerCase().includes(v));
    if (!verb) continue;
    // The 80-char cut can land inside a word; that half-word is not a name candidate.
    // Only drop the first token when it really is a fragment — dropping it blindly
    // loses the name in the exact shape this check exists for ("…, Đức tự viết…").
    const sliced = from > 0 && /\p{L}/u.test(hay[from] ?? '') && /\p{L}/u.test(hay[from - 1] ?? '');
    const tokens = [...window.matchAll(/\p{L}+/gu)].map((m) => m[0]).slice(sliced ? 1 : 0);
    const name = tokens.find((t) => /^\p{Lu}/u.test(t) && t !== t.toUpperCase() && !pack.includes(t));
    if (!name) continue;
    warnings += 1;
    console.log(`  ⚠ "${name}" + động từ phát ngôn "${verb}" đứng ngay trước một quote của người thật.`);
    console.log(`      trước quote: …${cut(window, 110)}`);
    console.log(`      quote (ledger): "${cut(quote, 110)}"`);
    console.log(`      fact: ${cut(entry.fact, 110)}`);
  }
  if (warnings === 0) {
    console.log('Không thấy quote nào của người thật bị gán cho một cái tên ngoài pack.');
  } else {
    console.log('');
    console.log(`${warnings} cảnh báo. Đây là heuristic: người đọc phán, không phải gate.`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────

function usage(): void {
  console.log('Cách dùng: bun writer:regate <runId> <đường-dẫn-bản-restyle.txt|.md>');
  console.log('Chỉ báo cáo, không chặn — luôn thoát 0.');
}

async function main(): Promise<void> {
  const [runId, scriptPath] = process.argv.slice(2);
  if (!runId || !scriptPath) {
    console.log('runId và đường dẫn bản restyle đều bắt buộc');
    usage();
    return;
  }

  const dataDir = dataRoot();
  const run = await getWriterRunV2(runId, dataDir);
  if (!run) {
    console.log(`Run v2 không tồn tại: ${runId}`);
    return;
  }
  if (!run.study) {
    console.log(`Run ${runId} chưa có STUDY — không có factsLedger để soi. Dừng ở đây.`);
    return;
  }
  const pack = await getWriterPack(run.packId, dataDir);
  if (!pack) {
    console.log(`Source Pack không tồn tại: ${run.packId}`);
    return;
  }
  let script: string;
  try {
    script = await readFile(resolve(scriptPath), 'utf8');
  } catch {
    console.log(`Không đọc được file bản restyle: ${scriptPath}`);
    return;
  }
  if (!script.trim()) {
    console.log(`File bản restyle rỗng: ${scriptPath}`);
    return;
  }

  const ledger = run.study.factsLedger ?? [];
  const band = targetWordRange(run.targetWords ?? DEFAULT_TARGET_WORDS);

  console.log('═'.repeat(78));
  console.log(`REGATE — báo cáo bản restyle (không chặn, luôn thoát 0)`);
  console.log(`run ${run.id} · pack ${pack.title} (${run.packId})`);
  console.log(`file ${resolve(scriptPath)}`);
  console.log(`ledger ${ledger.length} fact · target ${run.targetWords ?? DEFAULT_TARGET_WORDS} từ`);
  console.log('═'.repeat(78));

  const gate = runDeterministicGate({
    script,
    packMarkdown: pack.markdown,
    factsLedger: ledger,
    wordRange: band,
    forbiddenNames: forbiddenHostNames(pack),
    // outline + beatAnchors deliberately omitted — see reportGate().
  });

  reportGate(gate.violations, countScriptWords(script), band);
  reportNumbers(gate.violations, collectNumbers(script), {
    packNumbers: collectNumbers(pack.markdown),
    rates: ledgerRates(ledger),
  });
  reportStyle(script);
  reportRepeats(script, pack.markdown);
  reportSentences(script);
  reportQuoteLeak(script, pack.markdown, ledger);

  console.log('');
  console.log('─'.repeat(78));
  console.log('Hết báo cáo. Không có gì bị chặn — mọi quyết định là của người đọc.');
}

await main();
// Always 0, by design: this tool reports, it never gates. See the file header.
process.exit(0);
