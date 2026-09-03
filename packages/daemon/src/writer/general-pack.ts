/**
 * General pack store (Write Loop v2 Phase 2/3).
 *
 * A general pack is ONE channel's craft file: taste DNA + one entry per video
 * saying how that video opened, what each beat added, what kind of example it
 * used (with a provenance tag), how it paid off, and what it deliberately did
 * not do. It replaces Taste RAG in the writer: retrieval by editorial-decision
 * embedding returned neighbours that were topically close and craft-irrelevant,
 * and it could not express "this example is a fictional character — do NOT copy
 * this move". A curated file can, and a human can audit it in one sitting.
 *
 * Two hard properties:
 *  - One file per channel. Merging channels averages two tastes into neither.
 *  - Pinned by content hash on every run (`generalPackHash`), so editing the file
 *    mid-flight can never silently change what an old run claims it used.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join, normalize } from 'node:path';
import { ensureDir, generalPackStagingRoot, generalPacksRoot } from '../paths.ts';

export interface GeneralPackSummary {
  /** Path relative to the general-packs root, e.g. `hieu-tv.md`. */
  path: string;
  /** `<!-- version: N -->` from the file header, when present. */
  version: number | null;
  title: string;
  wordCount: number;
  hash: string;
}

export interface GeneralPack extends GeneralPackSummary {
  markdown: string;
}

/** Refuse anything that could escape the general-packs directory. */
function resolveRelativePath(relPath: string): string | null {
  const cleaned = normalize(relPath).replace(/^[/\\]+/, '');
  if (!cleaned || cleaned.includes('..')) return null;
  if (!cleaned.endsWith('.md')) return null;
  return cleaned;
}

function parseVersion(markdown: string): number | null {
  const m = markdown.match(/<!--\s*version:\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function parseTitle(markdown: string, fallback: string): string {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim() || fallback;
}

export function hashGeneralPack(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

export async function listGeneralPacks(dataDir?: string): Promise<GeneralPackSummary[]> {
  const root = generalPacksRoot(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: GeneralPackSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      const markdown = await readFile(join(root, name), 'utf8');
      out.push({
        path: name,
        version: parseVersion(markdown),
        title: parseTitle(markdown, basename(name, '.md')),
        wordCount: markdown.split(/\s+/).filter(Boolean).length,
        hash: hashGeneralPack(markdown),
      });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function getGeneralPack(relPath: string, dataDir?: string): Promise<GeneralPack | null> {
  const cleaned = resolveRelativePath(relPath);
  if (!cleaned) return null;
  try {
    const markdown = await readFile(join(generalPacksRoot(dataDir), cleaned), 'utf8');
    return {
      path: cleaned,
      version: parseVersion(markdown),
      title: parseTitle(markdown, basename(cleaned, '.md')),
      wordCount: markdown.split(/\s+/).filter(Boolean).length,
      hash: hashGeneralPack(markdown),
      markdown,
    };
  } catch (err) {
    // ENOENT is a real absence and stays `null`; every other read failure
    // (permissions, I/O, a directory where a file was expected) is a problem the
    // caller must not mistake for "the file is not there". Without this split a
    // run reports the file as missing while it sits on disk, sending whoever
    // debugs it to the wrong place. Same split, same reason, as
    // `persona-pack.ts`'s `getPersonaPack` (eng review 2026-09-02); these two
    // siblings were left behind and caught by CEO review 2026-09-03.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `[general-pack] failed to read ${cleaned}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * ---------------------------------------------------------------------------
 * Write side (general-pack MCP). Everything below is new: the reader above
 * predates this MCP and never wrote to the store. Two hard rules carried over
 * from `hieu-tv.md`'s own header, enforced here in code instead of by hand:
 *
 *  - A general pack is CÁCH LÀM (how), never a fact store — validators here
 *    check PROVENANCE (is this quote real, is this example tagged), never
 *    "is this a good example". Taste is still a human call.
 *  - Every `quote`/`text` field claiming to be verbatim must be an exact
 *    substring (whitespace-normalized only — never case-folded, never
 *    ASR-corrected) of the transcript of the video it is attributed to.
 * ---------------------------------------------------------------------------
 */

/** The 11 provenance tags `hieu-tv.md` documents for Example entries. Fixed set —
 * an agent proposing a new tag is proposing to hide an ungrounded example. */
export const GENERAL_PACK_EXAMPLE_TAGS = [
  'SỐ LIỆU NGHIÊN CỨU/LỊCH SỬ — cần nguồn thật',
  'chuẩn ngành / lời khuyên phổ biến',
  'kinh nghiệm host',
  'quan sát gộp',
  'thậm xưng có dán nhãn',
  'tròn cho dễ tính',
  'lấy đại',
  'số minh hoạ',
  'thí nghiệm tưởng tượng',
  'lời đồn phổ biến, số không nguồn',
  'nhân vật hư cấu — KHÔNG bắt chước',
] as const;

export type GeneralPackExampleTag = (typeof GENERAL_PACK_EXAMPLE_TAGS)[number];

export function isGeneralPackExampleTag(value: unknown): value is GeneralPackExampleTag {
  return typeof value === 'string' && (GENERAL_PACK_EXAMPLE_TAGS as readonly string[]).includes(value);
}

function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * "Nguyên văn transcript" check. Whitespace-only normalization on purpose: the
 * file's own rule is "chép đúng ký tự, không sửa lỗi ASR" — folding case or
 * stripping punctuation here would let an agent silently clean up the exact
 * thing the rule forbids and still pass.
 */
export function quoteIsGrounded(quote: string, transcript: string): boolean {
  const q = normalizeForMatch(quote);
  return q.length > 0 && normalizeForMatch(transcript).includes(q);
}

export interface TasteDnaQuoteDraft {
  videoId: string;
  text: string;
}

export interface TasteDnaPrincipleDraft {
  title: string;
  note: string;
  quotes: TasteDnaQuoteDraft[];
}

export interface TasteDnaViolation {
  principleIndex: number;
  quoteIndex?: number;
  reason: string;
}

export interface TasteDnaWarning {
  principleIndex: number;
  reason: 'SINGLE_SOURCE';
  detail: string;
}

export interface TasteDnaValidationResult {
  ok: boolean;
  violations: TasteDnaViolation[];
  warnings: TasteDnaWarning[];
  quoteCharRatio: number;
}

/**
 * Channel-level TASTE DNA draft. `sourceVideoIds` must be >=3 (plan: "soạn tay
 * từ 3 script đại diện") so a principle backed by a single video cannot pass as
 * a channel invariant — it gets a SINGLE_SOURCE warning instead, for a human to
 * judge, not a hard failure (a channel can genuinely have only 3 good sources
 * at bootstrap).
 */
export function validateTasteDnaDraft(
  principles: TasteDnaPrincipleDraft[],
  sourceVideoIds: string[],
  transcripts: Record<string, string>,
): TasteDnaValidationResult {
  const violations: TasteDnaViolation[] = [];
  const warnings: TasteDnaWarning[] = [];
  let quoteChars = 0;
  let totalChars = 0;

  if (principles.length < 5 || principles.length > 8) {
    violations.push({ principleIndex: -1, reason: `principles.length phải trong khoảng 5-8, có ${principles.length}` });
  }
  if (sourceVideoIds.length < 3) {
    violations.push({ principleIndex: -1, reason: `sourceVideoIds phải >=3 video, có ${sourceVideoIds.length}` });
  }

  principles.forEach((principle, principleIndex) => {
    totalChars += principle.title.length + principle.note.length;
    if (principle.quotes.length === 0) {
      violations.push({ principleIndex, reason: 'principle không có quote nào' });
      return;
    }
    const videoIdsUsed = new Set<string>();
    principle.quotes.forEach((quote, quoteIndex) => {
      totalChars += quote.text.length;
      if (!sourceVideoIds.includes(quote.videoId)) {
        violations.push({ principleIndex, quoteIndex, reason: `videoId "${quote.videoId}" không nằm trong sourceVideoIds` });
        return;
      }
      const transcript = transcripts[quote.videoId];
      if (!transcript) {
        violations.push({ principleIndex, quoteIndex, reason: `thiếu transcript cho videoId "${quote.videoId}"` });
        return;
      }
      if (!quoteIsGrounded(quote.text, transcript)) {
        violations.push({ principleIndex, quoteIndex, reason: 'quote không phải substring nguyên văn transcript của video này' });
        return;
      }
      quoteChars += quote.text.length;
      videoIdsUsed.add(quote.videoId);
    });
    if (videoIdsUsed.size === 1 && sourceVideoIds.length > 1) {
      warnings.push({
        principleIndex,
        reason: 'SINGLE_SOURCE',
        detail: 'mọi quote của principle này cùng 1 video — chưa có bằng chứng đây là bất biến kênh chứ không phải đặc điểm 1 tập',
      });
    }
  });

  return { ok: violations.length === 0, violations, warnings, quoteCharRatio: totalChars > 0 ? quoteChars / totalChars : 0 };
}

export interface GeneralPackEntryBeatDraft {
  beat: string;
  quotes: string[];
  newInformation: string;
}

export interface GeneralPackEntryExampleDraft {
  text: string;
  tag: GeneralPackExampleTag;
  recurringAcrossBeats?: boolean;
}

export interface GeneralPackEntryDraft {
  videoId: string;
  title?: string;
  views?: number;
  durationMinutes?: number;
  hook: { quote: string; debt: string };
  beats: GeneralPackEntryBeatDraft[];
  examples: GeneralPackEntryExampleDraft[];
  payoff: { quote: string; note: string };
  boundary: { quote: string; note: string };
}

export interface EntryViolation {
  field: string;
  index?: number;
  reason: string;
}

export interface EntryValidationResult {
  ok: boolean;
  violations: EntryViolation[];
  quoteCharRatio: number;
}

/**
 * Per-video entry draft. Every quote is checked against ONE transcript — the
 * video the entry claims to be about — so a real quote attributed to the
 * wrong video still fails (not just "does this text exist somewhere").
 */
export function validateGeneralPackEntryDraft(draft: GeneralPackEntryDraft, transcript: string): EntryValidationResult {
  const violations: EntryViolation[] = [];
  let quoteChars = 0;
  let totalChars = 0;

  const checkQuote = (field: string, index: number | undefined, quote: string) => {
    totalChars += quote.length;
    if (!quote.trim()) {
      violations.push({ field, index, reason: 'quote rỗng' });
      return;
    }
    if (!quoteIsGrounded(quote, transcript)) {
      violations.push({ field, index, reason: 'quote không phải substring nguyên văn transcript của video này' });
      return;
    }
    quoteChars += quote.length;
  };

  checkQuote('hook.quote', undefined, draft.hook.quote);
  totalChars += draft.hook.debt.length;

  if (draft.beats.length < 2 || draft.beats.length > 8) {
    violations.push({ field: 'beats', reason: `beats.length phải trong khoảng 2-8, có ${draft.beats.length}` });
  }
  draft.beats.forEach((beat, index) => {
    totalChars += beat.beat.length + beat.newInformation.length;
    if (beat.quotes.length === 0) {
      violations.push({ field: 'beats.quotes', index, reason: 'beat không có quote nào' });
      return;
    }
    beat.quotes.forEach((quote) => checkQuote('beats.quotes', index, quote));
  });

  if (draft.examples.length === 0) {
    violations.push({ field: 'examples', reason: 'entry phải có ít nhất 1 example' });
  }
  draft.examples.forEach((example, index) => {
    totalChars += example.text.length;
    if (!isGeneralPackExampleTag(example.tag)) {
      violations.push({ field: 'examples.tag', index, reason: `tag "${example.tag}" không nằm trong 11 tag cố định` });
    }
  });

  checkQuote('payoff.quote', undefined, draft.payoff.quote);
  totalChars += draft.payoff.note.length;

  checkQuote('boundary.quote', undefined, draft.boundary.quote);
  totalChars += draft.boundary.note.length;

  return { ok: violations.length === 0, violations, quoteCharRatio: totalChars > 0 ? quoteChars / totalChars : 0 };
}

function renderQuoteBlock(quote: string): string {
  return quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Renders a validated TASTE DNA draft into the exact `hieu-tv.md` template shape. */
export function renderTasteDnaMarkdown(principles: TasteDnaPrincipleDraft[]): string {
  const body = principles
    .map((p, i) => {
      const quotes = p.quotes.map((q) => `${renderQuoteBlock(q.text)} (${q.videoId})`).join('\n');
      return `**${i + 1}. ${p.title}.** ${p.note}\n\n${quotes}`;
    })
    .join('\n\n');
  return `<!-- taste-dna -->\n## TASTE DNA (cấp kênh — đọc trước mọi entry)\n\n${body}\n`;
}

/** Renders a validated entry draft into the `Hook/Beat/Example/Payoff/Ranh giới`
 * template shape, prefixed with an anchor comment `pack_commit` uses to find and
 * replace this section on re-commit. */
export function renderEntryMarkdown(draft: GeneralPackEntryDraft): string {
  const headerBits = [draft.title ?? draft.videoId];
  if (typeof draft.views === 'number') headerBits.push(`${draft.views.toLocaleString('vi-VN')} views`);
  if (typeof draft.durationMinutes === 'number') headerBits.push(`~${draft.durationMinutes} phút`);
  const beats = draft.beats
    .map((b, i) => `### Beat ${i + 1} — ${b.beat}\n\n${b.quotes.map(renderQuoteBlock).join('\n')}\n\n**Mới**: ${b.newInformation}`)
    .join('\n\n');
  const examples = draft.examples
    .map((e) => `- ${e.text} — \`[${e.tag}]\`${e.recurringAcrossBeats ? ' — ví dụ chạy suốt' : ''}`)
    .join('\n');
  return [
    `<!-- video: ${draft.videoId} -->`,
    `## ${headerBits.join(' | ')}`,
    `\`${draft.videoId}\``,
    '',
    `### Hook\n\n${renderQuoteBlock(draft.hook.quote)}\n\n**Nợ gài**: ${draft.hook.debt}`,
    beats,
    `### Ví dụ + nhãn nguồn gốc\n\n${examples}`,
    `### Payoff\n\n${renderQuoteBlock(draft.payoff.quote)}\n\n${draft.payoff.note}`,
    `### Ranh giới\n\n${renderQuoteBlock(draft.boundary.quote)}\n\n${draft.boundary.note}`,
  ].join('\n\n');
}

interface StagedPiece<TDraft> {
  channel: string;
  draft: TDraft;
  validation: { ok: boolean; violations: unknown[]; quoteCharRatio: number };
  stagedAt: string;
}

function stagingChannelDir(channel: string, dataDir?: string): string {
  return join(generalPackStagingRoot(dataDir), channel);
}

function tasteDnaStagePath(channel: string, dataDir?: string): string {
  return join(stagingChannelDir(channel, dataDir), 'taste-dna.json');
}

function entryStagePath(channel: string, videoId: string, dataDir?: string): string {
  return join(stagingChannelDir(channel, dataDir), 'entries', `${videoId}.json`);
}

export interface StageTasteDnaResult {
  staged: boolean;
  violations: TasteDnaViolation[];
  warnings: TasteDnaWarning[];
  quoteCharRatio: number;
  previewMarkdown?: string;
}

/** Validates, then always writes the draft to staging (even on failure) so a
 * human/reviewer can see exactly what an agent got wrong instead of it vanishing. */
export async function stageTasteDna(
  channel: string,
  sourceVideoIds: string[],
  principles: TasteDnaPrincipleDraft[],
  transcripts: Record<string, string>,
  dataDir?: string,
): Promise<StageTasteDnaResult> {
  const result = validateTasteDnaDraft(principles, sourceVideoIds, transcripts);
  await ensureDir(stagingChannelDir(channel, dataDir));
  const piece: StagedPiece<{ sourceVideoIds: string[]; principles: TasteDnaPrincipleDraft[] }> = {
    channel,
    draft: { sourceVideoIds, principles },
    validation: result,
    stagedAt: new Date().toISOString(),
  };
  await writeFile(tasteDnaStagePath(channel, dataDir), JSON.stringify(piece, null, 2), 'utf8');
  return {
    staged: result.ok,
    violations: result.violations,
    warnings: result.warnings,
    quoteCharRatio: result.quoteCharRatio,
    previewMarkdown: result.ok ? renderTasteDnaMarkdown(principles) : undefined,
  };
}

export interface StageEntryResult {
  staged: boolean;
  violations: EntryViolation[];
  quoteCharRatio: number;
  previewMarkdown?: string;
}

export async function stageEntry(
  channel: string,
  draft: GeneralPackEntryDraft,
  transcript: string,
  dataDir?: string,
): Promise<StageEntryResult> {
  const result = validateGeneralPackEntryDraft(draft, transcript);
  await ensureDir(join(stagingChannelDir(channel, dataDir), 'entries'));
  const piece: StagedPiece<GeneralPackEntryDraft> = {
    channel,
    draft,
    validation: result,
    stagedAt: new Date().toISOString(),
  };
  await writeFile(entryStagePath(channel, draft.videoId, dataDir), JSON.stringify(piece, null, 2), 'utf8');
  return {
    staged: result.ok,
    violations: result.violations,
    quoteCharRatio: result.quoteCharRatio,
    previewMarkdown: result.ok ? renderEntryMarkdown(draft) : undefined,
  };
}

export interface StagingState {
  tasteDna: StagedPiece<{ sourceVideoIds: string[]; principles: TasteDnaPrincipleDraft[] }> | null;
  entries: Record<string, StagedPiece<GeneralPackEntryDraft>>;
}

export async function readStagingState(channel: string, dataDir?: string): Promise<StagingState> {
  let tasteDna: StagingState['tasteDna'] = null;
  try {
    tasteDna = JSON.parse(await readFile(tasteDnaStagePath(channel, dataDir), 'utf8'));
  } catch {
    /* not staged yet */
  }
  const entries: StagingState['entries'] = {};
  try {
    const dir = join(stagingChannelDir(channel, dataDir), 'entries');
    const names = await readdir(dir);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const piece = JSON.parse(await readFile(join(dir, name), 'utf8'));
        entries[basename(name, '.json')] = piece;
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* no entries staged yet */
  }
  return { tasteDna, entries };
}

async function clearStagedEntry(channel: string, videoId: string, dataDir?: string): Promise<void> {
  try {
    await unlink(entryStagePath(channel, videoId, dataDir));
  } catch {
    /* already gone */
  }
}

async function clearStagedTasteDna(channel: string, dataDir?: string): Promise<void> {
  try {
    await unlink(tasteDnaStagePath(channel, dataDir));
  } catch {
    /* already gone */
  }
}

function parseEntriesHeaderTotal(markdown: string): number | null {
  const m = markdown.match(/entries:\s*\d+\/(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** Splits a live pack file's body into: everything before the first
 * `<!-- taste-dna -->` / `<!-- video: -->` marker (kept verbatim — file header +
 * intro prose), the taste-dna section (if any), and a map of videoId -> section
 * text for every marked entry. Content with no markers at all (the hand-authored
 * v1/v2 `hieu-tv.md` shape) is treated as unmanaged trailing content and kept
 * verbatim after the managed sections — commit only ever APPENDS or REPLACES a
 * marked section, it never touches unmarked prose. */
function splitManagedSections(markdown: string): {
  preamble: string;
  tasteDna: string | null;
  entries: Map<string, string>;
  unmanagedTail: string;
} {
  const markerRe = /^<!--\s*(taste-dna|video:\s*([^\s>-]+))\s*-->/gm;
  const markers: Array<{ index: number; kind: 'taste-dna' | 'video'; videoId?: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(markdown))) {
    markers.push(m[1] === 'taste-dna' ? { index: m.index, kind: 'taste-dna' } : { index: m.index, kind: 'video', videoId: m[2] });
  }
  if (markers.length === 0) {
    return { preamble: markdown, tasteDna: null, entries: new Map(), unmanagedTail: '' };
  }
  const preamble = markdown.slice(0, markers[0]!.index);
  let tasteDna: string | null = null;
  const entries = new Map<string, string>();
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i]!.index;
    const end = i + 1 < markers.length ? markers[i + 1]!.index : markdown.length;
    const section = markdown.slice(start, end).trimEnd();
    if (markers[i]!.kind === 'taste-dna') tasteDna = section;
    else entries.set(markers[i]!.videoId!, section);
  }
  return { preamble, tasteDna, entries, unmanagedTail: '' };
}

export interface CommitGeneralPackOptions {
  includeTasteDna: boolean;
  videoIds: string[];
  reviewerNote: string;
}

export interface CommitGeneralPackResult {
  committed: true;
  path: string;
  previousHash: string | null;
  newHash: string;
  newVersion: number;
  entriesCommitted: number;
}

/**
 * Merges validated, staged pieces into the live channel file. Pure file-store
 * logic only — it deliberately does NOT know about `WriterRunV2`/`generalPackHash`
 * pins (that would create a circular import, since `writer-run-v2.ts` already
 * imports `getGeneralPack` from this file). The MCP layer is responsible for
 * checking whether any RUNNING run is pinned to the OLD hash before calling this.
 */
export async function commitGeneralPack(
  channel: string,
  opts: CommitGeneralPackOptions,
  dataDir?: string,
): Promise<CommitGeneralPackResult> {
  const relPath = `${channel}.md`;
  const existing = await getGeneralPack(relPath, dataDir);
  const staging = await readStagingState(channel, dataDir);

  if (opts.includeTasteDna) {
    if (!staging.tasteDna) throw new Error(`Chưa stage TASTE DNA cho kênh "${channel}"`);
    if (!staging.tasteDna.validation.ok) throw new Error(`TASTE DNA đang stage của "${channel}" chưa validate ok — sửa rồi stage lại trước khi commit`);
  }
  for (const videoId of opts.videoIds) {
    const staged = staging.entries[videoId];
    if (!staged) throw new Error(`Chưa stage entry cho video "${videoId}"`);
    if (!staged.validation.ok) throw new Error(`Entry "${videoId}" đang stage chưa validate ok — sửa rồi stage lại trước khi commit`);
  }
  if (!opts.reviewerNote.trim()) throw new Error('reviewerNote bắt buộc — ghi lại người duyệt đã soi gì (tag nguồn gốc Example, dòng Ranh giới)');

  const previous = splitManagedSections(existing?.markdown ?? '');
  const preamble = existing
    ? previous.preamble
    : `# ${channel} — Source Pack General\n\n`;

  const tasteDnaSection = opts.includeTasteDna
    ? renderTasteDnaMarkdown(staging.tasteDna!.draft.principles)
    : (previous.tasteDna ?? '');

  const entries = new Map(previous.entries);
  for (const videoId of opts.videoIds) {
    entries.set(videoId, renderEntryMarkdown(staging.entries[videoId]!.draft));
  }

  const entryCount = entries.size;
  const total = parseEntriesHeaderTotal(existing?.markdown ?? '') ?? entryCount;
  const newVersion = (existing?.version ?? 0) + 1;
  const header = `<!-- version: ${newVersion} | generated: ${new Date().toISOString()} | entries: ${entryCount}/${total} -->\n<!-- reviewer note: ${opts.reviewerNote.replace(/\n/g, ' ')} -->\n\n`;

  const body = [preamble.replace(/^#.*\n\n?/, `# ${channel} — Source Pack General\n\n`), header, tasteDnaSection, ...entries.values()]
    .filter(Boolean)
    .join('\n\n');

  const root = generalPacksRoot(dataDir);
  await ensureDir(root);
  await writeFile(join(root, relPath), body, 'utf8');

  if (opts.includeTasteDna) await clearStagedTasteDna(channel, dataDir);
  for (const videoId of opts.videoIds) await clearStagedEntry(channel, videoId, dataDir);

  return {
    committed: true,
    path: relPath,
    previousHash: existing?.hash ?? null,
    newHash: hashGeneralPack(body),
    newVersion,
    entriesCommitted: opts.videoIds.length + (opts.includeTasteDna ? 1 : 0),
  };
}
