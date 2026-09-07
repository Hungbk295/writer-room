/**
 * Writer STUDY orchestration boundary.
 *
 * The public Writer lifecycle remains in `writer-run-v2.ts`; this module owns
 * the STUDY turn contract and is the only place where future DIVERGE/RESEARCH/
 * CONFRONT selection, stage input allowlists, checkpoint resume, and model-call
 * budgets may be implemented. It intentionally does not import the lifecycle
 * module, so that dependency stays one-way.
 *
 * For now `dispatchLegacyStudy` preserves the existing single-call STUDY byte
 * for byte. This commit is a refactor seam only, not the three-sub-call wiring.
 */
import { createHash } from 'node:crypto';
import type {
  DispatchItemResult,
  LaneScheduler,
} from '../pipeline/lane-scheduler.ts';
import type { WriterPack } from '../writer-packs.ts';
import type { LedgerEntry } from './deterministic-gate.ts';
import type { SelectedHook } from './hook-doi-thu.ts';
import {
  parseCoverageSequence,
  validateWriterVideoPlan,
  type WriterBeatSequenceToken,
  type WriterVideoPlan,
} from './video-plan.ts';

export const STUDY_STAGE = 'study-v2';
export const STUDY_PROMPT_VERSION = 'writer-v2-study-v2-sidecar-source-parts-hook-beat-grammar-v2-no-formula';
export const STUDY_SOURCE_PART_MAX_BYTES = 16_000;

/** A ledger this short is a writer that did not really read the pack. */
export const MIN_LEDGER_FACTS = 3;

export interface StudyCoverageEntry {
  videoId: string;
  mainClaim: string;
  angle: string;
  /** The mode sequence of this source video, in order (SDD 006 §4); may be empty. */
  sequence: WriterBeatSequenceToken[];
}

export interface StudyArtifact {
  coverageMap: StudyCoverageEntry[];
  gap: string;
  outline: WriterVideoPlan;
  factsLedger: LedgerEntry[];
}

/**
 * An explicit allowlist at the lifecycle/orchestrator seam. Passing individual
 * fields instead of WriterRunV2 prevents a future STUDY stage from gaining new
 * inputs merely because the persisted run model grew another property.
 *
 * No `formula` field (SDD 006 §2/§7): Formula is no longer an input of STUDY.
 */
export interface LegacyStudyDispatchInput {
  scheduler: LaneScheduler;
  batchId: string;
  itemId: string;
  templateId: string;
  sessionGroup: string;
  title: string;
  brief: string;
  audience: string;
  packTitle: string;
  selectedHook?: SelectedHook;
  pack: WriterPack;
  /** Forwarded verbatim to `dispatchItem` — see `DispatchItemParams.substrate`. */
  substrate?: 'terminal' | 'external';
  attempt?: number;
  freshContext?: boolean;
  /** When STUDY reads a generated Topic Pack, only these transcript-derived spans may enter factsLedger. */
  allowedFactQuotes?: readonly string[];
}

function envelopeHash(envelope: unknown): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Video ids a pack covers — from the record, falling back to the markdown. */
export function packVideoIds(pack: WriterPack): string[] {
  if (pack.videoIds?.length) return [...new Set(pack.videoIds)];
  const ids = [...pack.markdown.matchAll(/- videoId:\s*`([^`]+)`/g)].map((match) => match[1]!);
  return [...new Set(ids)];
}

export function validateStudyArtifact(
  parsed: unknown,
  opts: { packMarkdown: string; videoIds: string[]; allowedFactQuotes?: readonly string[] },
): { ok: true; study: StudyArtifact } | { ok: false; errorCode: string; reason: string } {
  const candidate = parsed as Partial<StudyArtifact> | null;
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'study output is not an object' };
  }

  const gap = typeof candidate.gap === 'string' ? candidate.gap.trim() : '';
  if (!gap) {
    return {
      ok: false,
      errorCode: 'AGENT_SCHEMA',
      reason: 'gap must be a non-empty string — say what none of the source videos did',
    };
  }

  if (!Array.isArray(candidate.coverageMap) || candidate.coverageMap.length === 0) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'coverageMap must be a non-empty array' };
  }
  const coverageMap: StudyCoverageEntry[] = [];
  for (const [index, raw] of candidate.coverageMap.entries()) {
    const entry = raw as Partial<StudyCoverageEntry> | null;
    const videoId = typeof entry?.videoId === 'string' ? entry.videoId.trim() : '';
    const mainClaim = typeof entry?.mainClaim === 'string' ? entry.mainClaim.trim() : '';
    const angle = typeof entry?.angle === 'string' ? entry.angle.trim() : '';
    if (!videoId || !mainClaim || !angle) {
      return {
        ok: false,
        errorCode: 'AGENT_SCHEMA',
        reason: `coverageMap[${index}] needs non-empty videoId, mainClaim and angle`,
      };
    }
    const sequenceResult = parseCoverageSequence(entry?.sequence, index);
    if (!sequenceResult.ok) {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: sequenceResult.reason };
    }
    coverageMap.push({ videoId, mainClaim, angle, sequence: sequenceResult.sequence });
  }

  const plan = validateWriterVideoPlan(candidate.outline, {
    sourceSequences: coverageMap.map((entry) => entry.sequence),
  });
  if (!plan.ok) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `outline: ${plan.reason}` };
  }

  const covered = new Set(coverageMap.map((entry) => entry.videoId));
  const missing = opts.videoIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      errorCode: 'STUDY_COVERAGE',
      reason:
        `coverageMap is missing pack video(s): ${missing.join(', ')} — every source video must be `
        + 'accounted for before you can claim a gap',
    };
  }

  if (!Array.isArray(candidate.factsLedger) || candidate.factsLedger.length < MIN_LEDGER_FACTS) {
    return {
      ok: false,
      errorCode: 'STUDY_LEDGER',
      reason:
        `factsLedger needs at least ${MIN_LEDGER_FACTS} entries (got `
        + `${Array.isArray(candidate.factsLedger) ? candidate.factsLedger.length : 0}) — these are the only facts the `
        + 'writing stage may use, so a thin ledger means a thin piece',
    };
  }
  const pack = opts.packMarkdown.normalize('NFC');
  const factsLedger: LedgerEntry[] = [];
  for (const [index, raw] of candidate.factsLedger.entries()) {
    const entry = raw as Partial<LedgerEntry> | null;
    const fact = typeof entry?.fact === 'string' ? entry.fact.trim() : '';
    const quote = typeof entry?.quote === 'string' ? entry.quote.normalize('NFC').trim() : '';
    if (!fact || !quote) {
      return {
        ok: false,
        errorCode: 'STUDY_LEDGER',
        reason: `factsLedger[${index}] needs a fact and a quote`,
      };
    }
    if (!pack.includes(quote)) {
      return {
        ok: false,
        errorCode: 'STUDY_LEDGER',
        reason:
          `factsLedger[${index}] ("${fact}") quotes text that is not an exact substring of the topic pack. `
          + 'Copy the characters verbatim — do not clean up punctuation, casing or spacing.',
      };
    }
    if (
      opts.allowedFactQuotes
      && !opts.allowedFactQuotes.some((authorized) => authorized.normalize('NFC').includes(quote))
    ) {
      return {
        ok: false,
        errorCode: 'STUDY_LEDGER',
        reason:
          `factsLedger[${index}].quote is not inside an authorized positive ResearchMap evidence span; `
          + 'Topic Pack labels, rejected claims and contradiction-only quotes are not factual sources',
      };
    }
    const videoId = typeof entry?.videoId === 'string' ? entry.videoId.trim() : '';
    if (videoId && opts.videoIds.length > 0 && !opts.videoIds.includes(videoId)) {
      return {
        ok: false,
        errorCode: 'STUDY_LEDGER',
        reason: `factsLedger[${index}] cites videoId "${videoId}", which is not in this pack`,
      };
    }
    // A generated Topic Pack contains model-authored labels alongside exact evidence.
    // Do not let another model turn those labels into factual capability: code makes
    // the authorized quote itself the fact passed to WRITE.
    factsLedger.push({ fact: opts.allowedFactQuotes ? quote : fact, quote, ...(videoId ? { videoId } : {}) });
  }

  return { ok: true, study: { coverageMap, gap, outline: plan.videoPlan, factsLedger } };
}

function buildStudyPrompt(opts: {
  title: string;
  brief: string;
  audience: string;
  videoIds: string[];
  selectedHook?: SelectedHook;
}): string {
  return [
    '# Writer v2 — STUDY (read the pack, pick the gap, commit to facts)',
    '',
    'You are NOT writing the piece in this turn. First read EVERY Markdown file listed',
    'in `input/envelope.json` at `topicPack.contentFiles`, in the listed order. These',
    'files are consecutive byte-exact parts of the authoritative topic pack; together',
    'they are the only source of facts. Then use the compact contract, title/brief and',
    'pack metadata. The assignment message gives absolute paths if this PTY has an older',
    'working directory — use those absolute paths, not a guessed relative directory.',
    'Do not open Chrome, a browser, Playwright or `file://`: the local Markdown file is',
    'the complete pack and is deliberately prepared for the filesystem Read tool.',
    '',
    `## Audience: ${opts.audience}`,
    '',
    '## Title',
    opts.title,
    '',
    '## Brief',
    opts.brief,
    '',
    ...(opts.selectedHook
      ? [
          '## Selected opening hook (human-picked — do not replace)',
          `Type: ${opts.selectedHook.typeLabel} (\`${opts.selectedHook.type}\`)`,
          opts.selectedHook.text,
          'Beat 1 must plant this debt. `endingPayoff.resolvesOpening` must pay THIS debt,',
          'not a different image or question. Do not copy placeholder figures like `[X]%`',
          'into `factsLedger` — only pack-verbatim quotes belong there.',
          '',
        ]
      : []),
    '## Beat grammar — Mode (how a beat is played)',
    '',
    'Every beat commits to exactly one `mode`. Short reference (the writing stage sees the',
    'full mode pack with real quotes; you only need to pick, not perform, the mode):',
    '',
    '| mode | must have | forbidden |',
    '|---|---|---|',
    '| `canh` | a time or place, one object, one action | a conclusion inside the scene |',
    '| `mo-so` | a number from the ledger and the arithmetic exposed | storytelling |',
    '| `phan-bac` | the strongest counter-argument, stated before the answer | answering before it is built |',
    '| `cuc-tri` | a stated formula/threshold pushed to an absurd input or assumption | a new variable not in the piece |',
    '| `zoom-chu` | one word from a sentence that already appeared | inventing a slogan to dissect |',
    '| `doi-y` | visibly changing your mind, admitting a misread, or changing plan | using it at the last beat or more than once |',
    '',
    '## Beat grammar — Phép lật (lateral turn)',
    '',
    'Every beat also commits to one `turn`, applied to that beat\'s `familiarObject`:',
    '',
    '| turn | what it does |',
    '|---|---|',
    '| `doi-don-vi` | measure in a different unit (money measures value, not effort) |',
    '| `doi-chu-the` | swap who the real subject is (you do not own the car; the bank rents you a job) |',
    '| `doi-thang` | change scale (a dead cow means raising 20; a billion a month breaks the formula) |',
    '| `doi-ten` | rename the thing (a level-3 savings rate is really a 2%-a-year loss) |',
    '| `doi-thoi-diem` | move the vantage point in time (from 10 years later, or from signing day) |',
    '| `doi-cau-hoi` | change the question itself (earning money for what → living for what) |',
    '',
    '## Beat grammar — Khuôn (the one thread of the whole piece)',
    '',
    'Pick exactly one `frame.kind` for the whole piece:',
    '',
    '| frame | rule |',
    '|---|---|',
    '| `nhan-vat` | a character: name, age, job, then stop; a foil at the open and the close; the character never speaks a ledger quote |',
    '| `an-du` | a metaphor that keeps working under pressure and returns at the payoff |',
    '| `con-so` | one ledger number that runs through every beat and closes at the payoff |',
    '',
    '## What to produce, in this order',
    '',
    '1. `coverageMap` — one entry per source video in the pack: what it actually claims,',
    `   from which angle, and its \`sequence\` — the order of \`mode\`s that video itself`,
    '   plays, from the list above (use `khac` for a beat that is not one of the six).',
    `   All ${opts.videoIds.length} pack video(s) must appear: ${opts.videoIds.join(', ') || '(see the pack)'}.`,
    '2. `gap` — one thing none of those videos did, that this audience would want. This is',
    '   the reason for the piece to exist. Not a new topic; a missing angle.',
    '3. `outline.endingPayoff` — write this BEFORE the beats. First `directAnswer`: the',
    '   straight, literal answer to the hook\'s question. The piece must refuse to end on',
    '   this. Then `reframedQuestion`: the hook\'s question, changed into the question the',
    '   piece actually answers. Then `resolvesOpening`, stated against `reframedQuestion`,',
    '   not against `directAnswer`.',
    '4. `outline.frame` — the one thread (`nhan-vat`/`an-du`/`con-so`) that runs through',
    '   every beat and closes at the payoff.',
    '5. `outline.progression` — 2-8 beats. Work BACKWARD from the ending to the hook. Each',
    '   beat states `familiarObject` (the ordinary thing the turn is applied to), `turn`,',
    '   `mode`, and `whyNotEarlier` (why this beat could not have stood earlier), plus the',
    '   existing `newInformation`, `characterOrArgumentChange`, `visualAnchor`. No two',
    '   adjacent beats may share a `mode` or a `turn`. A `mode` may repeat at most twice in',
    '   the whole outline; `doi-y` at most once, and never as the last beat. Do not let the',
    '   outline\'s own `mode` sequence copy 3 beats in a row from any `coverageMap[].sequence`',
    '   — you are compressing what the source videos taught, not replaying how they told it.',
    '6. `factsLedger` — every fact the piece is allowed to use, each with a quote copied',
    '   VERBATIM from the pack (an exact substring — do not tidy punctuation or spacing)',
    `   and the \`videoId\` it came from. At least ${MIN_LEDGER_FACTS} entries.`,
    '',
    '**This is the whole factual budget of the piece.** The writing stage will not see',
    'the pack — only this ledger. A number or a case that is not in the ledger cannot be',
    'used later, so put in what you will actually need.',
    '',
    'The quotes are checked programmatically against the pack; a paraphrase is rejected.',
    'The beat-grammar rules above are also checked programmatically: adjacent-mode/turn',
    'reuse, mode overuse, a missing `frame`, and an ending that answers the hook directly',
    'are all rejected outlines.',
    '',
    'Write JSON to `out/result.json`:',
    '',
    '```json',
    '{',
    '  "coverageMap": [',
    '    { "videoId": "...", "mainClaim": "...", "angle": "...",',
    '      "sequence": ["canh", "mo-so", "khac"] }',
    '  ],',
    '  "gap": "...",',
    '  "outline": {',
    '    "coreInsight": "...",',
    '    "memoryAnchor": { "kind": "name|equation|contrast|image", "value": "..." },',
    '    "frame": { "kind": "nhan-vat|an-du|con-so", "value": "..." },',
    '    "progression": [ { "beat": "...", "newInformation": "...",',
    '      "characterOrArgumentChange": "...", "visualAnchor": "...",',
    '      "mode": "canh|mo-so|phan-bac|cuc-tri|zoom-chu|doi-y",',
    '      "turn": "doi-don-vi|doi-chu-the|doi-thang|doi-ten|doi-thoi-diem|doi-cau-hoi",',
    '      "familiarObject": "...", "whyNotEarlier": "..." } ],',
    '    "endingPayoff": { "directAnswer": "...", "reframedQuestion": "...",',
    '      "resolvesOpening": "...", "audienceCanDo": "..." },',
    '    "cutList": ["..."]',
    '  },',
    '  "factsLedger": [ { "fact": "...", "videoId": "...", "quote": "<verbatim pack substring>" } ]',
    '}',
    '```',
  ].join('\n');
}

/**
 * Split a large source into UTF-8-safe, byte-exact consecutive parts. Agent Read
 * paginates by physical line, so a single transcript paragraph can exceed its
 * per-call token ceiling even when offset/limit requests only one line. Joining
 * the returned strings always reconstructs the canonical source exactly: no
 * whitespace is inserted, removed or normalized, preserving verbatim evidence.
 */
export function splitExactSourceParts(
  content: string,
  maxBytes = STUDY_SOURCE_PART_MAX_BYTES,
): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new Error('maxBytes must be an integer >= 4');
  }
  if (content.length === 0) return [''];
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (current && currentBytes + charBytes > maxBytes) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) parts.push(current);
  return parts;
}

/** Preserve the existing one-call STUDY dispatch behind the new boundary. */
export async function dispatchLegacyStudy(
  input: LegacyStudyDispatchInput,
): Promise<DispatchItemResult> {
  const videoIds = packVideoIds(input.pack);
  const sourceParts = splitExactSourceParts(input.pack.markdown);
  const partNumberWidth = Math.max(3, String(sourceParts.length).length);
  const sourceFiles = sourceParts.map((content, index) => ({
    path:
      `topic-pack/part-${String(index + 1).padStart(partNumberWidth, '0')}`
      + `-of-${String(sourceParts.length).padStart(partNumberWidth, '0')}.md`,
    content,
  }));
  // Keep the envelope compact. The large topic pack is staged as line-readable
  // Markdown next to it; embedding it as a JSON string would escape every newline
  // and create one unreadable physical line for agent Read tools.
  const envelope = {
    contract: {
      role: 'Writer v2 — STUDY stage',
      audience: input.audience,
      packRole: 'the only source of facts',
      generalPackRole: 'not visible in this stage — craft comes later',
    },
    title: input.title,
    brief: input.brief,
    ...(input.selectedHook ? { selectedHook: input.selectedHook } : {}),
    topicPack: {
      id: input.pack.id,
      title: input.pack.title,
      channelTitle: input.pack.channelTitle,
      videoIds,
      channelIsNotNarrator: true,
      contentFiles: sourceFiles.map((file) => `input/${file.path}`),
      reconstruction: 'concatenate contentFiles in listed order with no separator',
      warnings: input.pack.warnings,
    },
    instructions: {
      coverageMap: 'one entry per pack video: what it claims, from which angle',
      gap: 'one thing none of them did, that this audience wants',
      outline: 'the compression contract (WriterVideoPlan shape)',
      factsLedger: `at least ${MIN_LEDGER_FACTS} facts, each with a verbatim pack quote`,
      ...(input.allowedFactQuotes
        ? { factsBoundary: 'factsLedger quotes may come only from <quote> evidence spans marked SUPPORTS/QUALIFIES' }
        : {}),
    },
  };

  return input.scheduler.dispatchItem({
    batchId: input.batchId,
    itemId: input.itemId,
    stage: STUDY_STAGE,
    attempt: input.attempt ?? 1,
    templateId: input.templateId,
    ...(input.substrate !== undefined ? { substrate: input.substrate } : {}),
    promptMarkdown: buildStudyPrompt({
      title: input.title,
      brief: input.brief,
      audience: input.audience,
      videoIds,
      ...(input.selectedHook ? { selectedHook: input.selectedHook } : {}),
    }),
    envelope,
    inputFiles: sourceFiles,
    inputHashes: [envelopeHash(envelope), contentHash(input.pack.markdown)],
    promptVersion: STUDY_PROMPT_VERSION,
    // The coordinator counts explicit dispatches (including per-source research).
    // A scheduler content-retry would be invisible to that lifecycle, so one
    // dispatch could quietly become three model calls. Retrying stays explicit:
    // STUDY attempt 2 is owned by `continueWriterRunV2`.
    maxContentRetries: 0,
    sessionGroup: input.sessionGroup,
    interactivePty: true,
    freshContext: input.freshContext,
    validateContent: (parsed) => {
      const validation = validateStudyArtifact(parsed, {
        packMarkdown: input.pack.markdown,
        videoIds,
        ...(input.allowedFactQuotes ? { allowedFactQuotes: input.allowedFactQuotes } : {}),
      });
      return validation.ok
        ? { ok: true as const }
        : {
            ok: false as const,
            errorCode: validation.errorCode,
            reason: validation.reason,
          };
    },
  });
}
