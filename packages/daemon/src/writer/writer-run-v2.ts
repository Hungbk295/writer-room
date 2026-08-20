/**
 * Write Loop v2 — the writer flow (plan Phase 3 + Phase 4).
 *
 * Two model calls, then three layers of checking:
 *
 *   1) STUDY  (`study-v2`)       — read the WHOLE topic pack, map what each source
 *                                  video already covers, name the gap, commit to an
 *                                  outline and a facts ledger of verbatim pack quotes.
 *   2) WRITE  (`write-v2`)       — write the piece in one pass from outline + ledger +
 *                                  the channel's general pack (craft, never facts).
 *   3) GATE   (code)             — `deterministic-gate.ts`. No model.
 *   4) EDIT   (`edit-review-v2`) — a DIFFERENT agent, seeing only title/outline/script
 *                                  (+ gate violations), reporting defects with exact
 *                                  quotes. It cannot see the pack, so it cannot be
 *                                  talked into agreeing the facts are fine.
 *   5) REPAIR (`repair-v2`)      — one round, in place, then the gate runs again.
 *                                  Clean → DONE. Still red → FAILED_GATE, a human looks.
 *
 * What v2 removes on purpose, with the evidence:
 *  - Profile + rubric review. Run `86de3ca5` finished `passed: true, DONE` with its
 *    own reviewer reporting a violation; a scored rubric let style points pay for a
 *    factual failure. Here `DONE` is unreachable while the gate is red — not by
 *    policy, by control flow.
 *  - Taste RAG. Retrieval by editorial-decision embedding returned topically-near,
 *    craft-irrelevant neighbours; the general pack states the moves outright.
 *  - The 3-round refine loop. Round 2+ of "fix your violations" teaches an agent to
 *    perform compliance. One repair, then a human.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FormulaArtifact } from '@writer-room/training-core';
import { normalizeFormula } from '@writer-room/training-core';
import { DEFAULT_AGENT_IDS, type DefaultAgentId } from '../agents/defaults.ts';
import { createJobDoneNotification } from '../notifications.ts';
import { writerRoot } from '../paths.ts';
import type { DispatchItemResult, ItemSettledResult, LaneScheduler } from '../pipeline/lane-scheduler.ts';
import { getFormula } from '../training/storage.ts';
import { getWriterPack, type WriterPack } from '../writer-packs.ts';
import {
  formatGateViolations,
  runDeterministicGate,
  type GateResult,
  type LedgerEntry,
} from './deterministic-gate.ts';
import { getChannelStyle } from './channel-style.ts';
import { getGeneralPack } from './general-pack.ts';
import { getWriterRunV2, listWriterRunsV2, saveWriterRunV2 } from './run-store-v2.ts';
import { countScriptWords, findIdentityLeak, forbiddenHostNames, targetWordRange } from './script-checks.ts';
import { validateWriterVideoPlan, type WriterVideoPlan } from './video-plan.ts';

export { DEFAULT_AGENT_IDS, type DefaultAgentId };

export const STUDY_STAGE = 'study-v2';
export const WRITE_STAGE = 'write-v2';
export const EDIT_REVIEW_STAGE = 'edit-review-v2';
export const REPAIR_STAGE = 'repair-v2';

/**
 * Restyle runs OUTSIDE the five-stage loop above: it starts from a run that is
 * already `DONE`, never changes `status` or `finalScript`, and writes each result
 * to its own versioned file. It therefore has its OWN settle listener — the main
 * one returns early on any run that is not `RUNNING`, which is exactly every run
 * a restyle can be dispatched from.
 */
export const RESTYLE_STAGE = 'restyle-v1';

/**
 * Writer v2 is deliberately a live, human-observable PTY workflow. The author
 * keeps one writable pane from STUDY through WRITE/REPAIR; the editor receives
 * a distinct pane so a review is never accidentally delivered to the writer's
 * session, even when the operator selected the same base agent for both roles.
 */
const AUTHOR_PTY_SESSION_GROUP = 'writer-v2-author';
const EDITOR_PTY_SESSION_GROUP = 'writer-v2-editor';
const RESTYLE_PTY_SESSION_GROUP = 'writer-v2-restyle';

const STUDY_PROMPT_VERSION = 'writer-v2-study-v2-sidecar-source';
const WRITE_PROMPT_VERSION = 'writer-v2-write-v3-exact-length';
const EDIT_REVIEW_PROMPT_VERSION = 'writer-v2-edit-review-v2';
const REPAIR_PROMPT_VERSION = 'writer-v2-repair-v1';
const RESTYLE_PROMPT_VERSION = 'writer-v2-restyle-v1';

/** The one item id every stage of a v2 run uses (one run = one piece). */
export const WRITER_V2_ITEM_ID = 'piece';

/** Absolute default band (plan §0): a script, not a slice of the source's length. */
export const DEFAULT_WORD_RANGE = { minWords: 800, maxWords: 1500 } as const;

/** A ledger this short is a writer that did not really read the pack. */
const MIN_LEDGER_FACTS = 3;

export interface StudyCoverageEntry {
  videoId: string;
  mainClaim: string;
  angle: string;
}

export interface StudyArtifact {
  coverageMap: StudyCoverageEntry[];
  gap: string;
  outline: WriterVideoPlan;
  factsLedger: LedgerEntry[];
}

export interface WriterV2Draft {
  title: string;
  script: string;
  /** 3-5 lines: what changed vs the STUDY outline, and which general-pack entry taught it. */
  outlineChanges: string[];
  /** One verbatim script quote per outline beat. */
  beatAnchors: string[];
  /** Labels the writer knowingly coined (gate check 4 counts them). */
  coinedLabels?: string[];
}

export type EditorDefectSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface EditorDefect {
  /** Exact substring of the script — checked, so a defect cannot be about prose that isn't there. */
  quote: string;
  severity: EditorDefectSeverity;
  note: string;
}

/**
 * One restyle result. A run accumulates these; `finalScript` stays the sourced
 * original, so a styled version is always an addition, never a replacement.
 */
export interface StyledVersion {
  version: number;
  /** Relative path in the channel-styles root, e.g. `nhan-vat-xuyen-suot.md`. */
  styleId: string;
  styleVersion: number | null;
  styleHash: string;
  agentId: DefaultAgentId;
  /** Relative to dataDir, e.g. `writer/styled/<runId>/v1.md`. */
  path: string;
  words: number;
  createdAt: string;
}

export type WriterV2Phase =
  | 'STUDY'
  | 'WRITE'
  | 'GATE'
  | 'EDIT_REVIEW'
  | 'REPAIR'
  | 'DONE'
  | 'FAILED';

export interface WriterRunV2 {
  id: string;
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'FAILED_GATE';
  phase: WriterV2Phase;
  brief: string;
  requestedTitle?: string;
  targetWords?: number;
  /** Who this channel talks to — stated, because STUDY picks a gap against it. */
  audience?: string;
  /** Topic pack — the ONLY source of facts. Required. */
  packId: string;
  packTitle: string;
  /** e.g. `hieu-tv.md`, relative to the general-packs root. Required. */
  generalPackPath: string;
  generalPackHash: string;
  generalPackVersion: number | null;
  /** Style contract (replaces the Profile pin). */
  formulaId: string;
  formulaVersion: number;
  formulaHash: string;
  agentId: DefaultAgentId;
  /** Layer 1 must not be the writer grading itself. */
  editorAgentId: DefaultAgentId;
  study: StudyArtifact | null;
  draft: WriterV2Draft | null;
  /** One entry per gate run (after WRITE, and again after REPAIR). */
  gateResults: GateResult[];
  editorDefects: EditorDefect[] | null;
  finalScript: string | null;
  /** True once a repair round has been dispatched — the cap is one. */
  repairAttempted?: boolean;
  /** Set while a restyle turn is in flight. All three restyle fields are optional
   * so every run written before restyle existed still reads back unchanged. */
  restyling?: { version: number; styleId: string; startedAt: string };
  /** Last restyle failure. Never touches `status`/`errorCode` — the run itself is
   * still the DONE run it was; only the side operation failed. */
  restyleError?: { code: string; reason: string; at: string };
  styled?: StyledVersion[];
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
  errorReason?: string;
}

async function notifyWriterV2Done(run: WriterRunV2, dataDir: string): Promise<void> {
  try {
    await createJobDoneNotification({
      kind: 'writer-v2',
      jobId: run.id,
      title: 'Writer v2 đã hoàn tất',
      detail: run.requestedTitle ?? run.draft?.title ?? run.packTitle,
    }, dataDir);
  } catch (err) {
    console.error('[notifications] không tạo được thông báo Writer v2:', (err as Error).message);
  }
}

interface WriterV2Deps {
  scheduler: LaneScheduler;
  dataDir: string;
}

function envelopeHash(envelope: unknown): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function pinFormulaHash(formula: FormulaArtifact): string {
  return createHash('sha256').update(JSON.stringify(formula)).digest('hex');
}

/**
 * The style contract as the writer sees it: rule statements only.
 *
 * `training-core`'s `toTrainingDraftView` is the same projection but documents
 * itself as NOT-for-Writer, because a Formula statement can be source-bound and v1
 * required a migrated Profile instead. v2 reverses that on purpose: a Formula that
 * has been through the lab (rule verdicts) and a Studio merge IS the style
 * contract, and the anti-fabrication half of what a Profile used to promise is now
 * enforced by the gate rather than by prose in a rubric.
 */
export function formulaContractView(formula: FormulaArtifact): {
  id: string;
  version: number;
  label: string;
  rules: Array<{ id: string; statement: string; role?: string }>;
} {
  const current = normalizeFormula(formula);
  return {
    id: current.id,
    version: current.version,
    label: current.origin === 'COMPOUND' ? (current.genre ?? '') : (current.channelTitle ?? ''),
    rules: current.rules.map((r) => ({
      id: r.id,
      statement: r.statement,
      ...(r.role ? { role: r.role } : {}),
    })),
  };
}

/** Video ids a pack covers — from the record, falling back to the markdown. */
export function packVideoIds(pack: WriterPack): string[] {
  if (pack.videoIds?.length) return [...new Set(pack.videoIds)];
  const ids = [...pack.markdown.matchAll(/- videoId:\s*`([^`]+)`/g)].map((m) => m[1]!);
  return [...new Set(ids)];
}

function wordRangeFor(run: Pick<WriterRunV2, 'targetWords'>): { minWords: number; maxWords: number } {
  return run.targetWords !== undefined
    ? targetWordRange(run.targetWords)
    : { ...DEFAULT_WORD_RANGE };
}

// ── Validators ────────────────────────────────────────────────────────────

export function validateStudyArtifact(
  parsed: unknown,
  opts: { packMarkdown: string; videoIds: string[] },
): { ok: true; study: StudyArtifact } | { ok: false; errorCode: string; reason: string } {
  const p = parsed as Partial<StudyArtifact> | null;
  if (!p || typeof p !== 'object') {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'study output is not an object' };
  }

  const plan = validateWriterVideoPlan(p.outline);
  if (!plan.ok) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `outline: ${plan.reason}` };
  }

  const gap = typeof p.gap === 'string' ? p.gap.trim() : '';
  if (!gap) {
    return {
      ok: false,
      errorCode: 'AGENT_SCHEMA',
      reason: 'gap must be a non-empty string — say what none of the source videos did',
    };
  }

  if (!Array.isArray(p.coverageMap) || p.coverageMap.length === 0) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'coverageMap must be a non-empty array' };
  }
  const coverageMap: StudyCoverageEntry[] = [];
  for (const [i, raw] of p.coverageMap.entries()) {
    const entry = raw as Partial<StudyCoverageEntry> | null;
    const videoId = typeof entry?.videoId === 'string' ? entry.videoId.trim() : '';
    const mainClaim = typeof entry?.mainClaim === 'string' ? entry.mainClaim.trim() : '';
    const angle = typeof entry?.angle === 'string' ? entry.angle.trim() : '';
    if (!videoId || !mainClaim || !angle) {
      return {
        ok: false,
        errorCode: 'AGENT_SCHEMA',
        reason: `coverageMap[${i}] needs non-empty videoId, mainClaim and angle`,
      };
    }
    coverageMap.push({ videoId, mainClaim, angle });
  }
  const covered = new Set(coverageMap.map((c) => c.videoId));
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

  if (!Array.isArray(p.factsLedger) || p.factsLedger.length < MIN_LEDGER_FACTS) {
    return {
      ok: false,
      errorCode: 'STUDY_LEDGER',
      reason:
        `factsLedger needs at least ${MIN_LEDGER_FACTS} entries (got `
        + `${Array.isArray(p.factsLedger) ? p.factsLedger.length : 0}) — these are the only facts the `
        + 'writing stage may use, so a thin ledger means a thin piece',
    };
  }
  const pack = opts.packMarkdown.normalize('NFC');
  const factsLedger: LedgerEntry[] = [];
  for (const [i, raw] of p.factsLedger.entries()) {
    const entry = raw as Partial<LedgerEntry> | null;
    const fact = typeof entry?.fact === 'string' ? entry.fact.trim() : '';
    const quote = typeof entry?.quote === 'string' ? entry.quote.normalize('NFC').trim() : '';
    if (!fact || !quote) {
      return { ok: false, errorCode: 'STUDY_LEDGER', reason: `factsLedger[${i}] needs a fact and a quote` };
    }
    if (!pack.includes(quote)) {
      return {
        ok: false,
        errorCode: 'STUDY_LEDGER',
        reason:
          `factsLedger[${i}] ("${fact}") quotes text that is not an exact substring of the topic pack. `
          + 'Copy the characters verbatim — do not clean up punctuation, casing or spacing.',
      };
    }
    const videoId = typeof entry?.videoId === 'string' ? entry.videoId.trim() : '';
    if (videoId && opts.videoIds.length > 0 && !opts.videoIds.includes(videoId)) {
      return {
        ok: false,
        errorCode: 'STUDY_LEDGER',
        reason: `factsLedger[${i}] cites videoId "${videoId}", which is not in this pack`,
      };
    }
    factsLedger.push({ fact, quote, ...(videoId ? { videoId } : {}) });
  }

  return { ok: true, study: { coverageMap, gap, outline: plan.videoPlan, factsLedger } };
}

export function validateWriterV2Draft(
  parsed: unknown,
  opts: {
    outline: WriterVideoPlan;
    wordRange: { minWords: number; maxWords: number };
    forbiddenNames: string[];
    requireOutlineChanges: boolean;
  },
): { ok: true; draft: WriterV2Draft } | { ok: false; errorCode: string; reason: string } {
  const p = parsed as Partial<WriterV2Draft> | null;
  if (!p || typeof p !== 'object') {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'output is not an object' };
  }
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  const script = typeof p.script === 'string' ? p.script.trim() : '';
  if (!title) return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'title missing or empty' };
  if (!script) return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'script missing or empty' };

  const words = countScriptWords(script);
  const { minWords, maxWords } = opts.wordRange;
  if (words < minWords || words > maxWords) {
    return {
      ok: false,
      errorCode: 'DRAFT_LENGTH',
      reason:
        `script is ${words} words — band is ${minWords}-${maxWords}. `
        + 'Overwrite out/result.json at the right length; do not leave this file and reply "done".',
    };
  }

  const leak = findIdentityLeak(script, opts.forbiddenNames);
  if (leak) {
    return {
      ok: false,
      errorCode: 'DRAFT_IDENTITY',
      reason:
        `script adopts the source-pack host identity "${leak}". This series is not that host — `
        + 'keep the pack facts, drop the persona. Overwrite out/result.json.',
    };
  }

  const outlineChanges = Array.isArray(p.outlineChanges)
    ? p.outlineChanges.map(String).map((s) => s.trim()).filter(Boolean)
    : [];
  if (opts.requireOutlineChanges && outlineChanges.length === 0) {
    return {
      ok: false,
      errorCode: 'AGENT_SCHEMA',
      reason:
        'outlineChanges is empty — write 3-5 lines saying what you changed against the STUDY outline '
        + 'and which general-pack entry taught you that move (say so explicitly if you changed nothing)',
    };
  }

  const beats = opts.outline.progression;
  const beatAnchors = Array.isArray(p.beatAnchors) ? p.beatAnchors.map(String) : [];
  if (beatAnchors.length !== beats.length) {
    return {
      ok: false,
      errorCode: 'BEAT_ANCHORS',
      reason:
        `beatAnchors has ${beatAnchors.length} entries but the outline has ${beats.length} beats — `
        + 'exactly one verbatim script quote per beat, in beat order',
    };
  }
  const normalizedScript = script.normalize('NFC');
  for (const [i, anchor] of beatAnchors.entries()) {
    const a = anchor.normalize('NFC').trim();
    if (!a) {
      return { ok: false, errorCode: 'BEAT_ANCHORS', reason: `beatAnchors[${i}] is empty` };
    }
    if (!normalizedScript.includes(a)) {
      return {
        ok: false,
        errorCode: 'BEAT_ANCHORS',
        reason:
          `beatAnchors[${i}] (beat "${beats[i]!.beat}") is not an exact substring of the script. `
          + 'Copy the sentence you actually wrote, character for character.',
      };
    }
  }

  const coinedLabels = Array.isArray(p.coinedLabels)
    ? p.coinedLabels.map(String).map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    ok: true,
    draft: {
      title,
      script,
      outlineChanges,
      beatAnchors: beatAnchors.map((a) => a.normalize('NFC').trim()),
      ...(coinedLabels.length > 0 ? { coinedLabels } : {}),
    },
  };
}

export function validateEditorReview(
  parsed: unknown,
  script: string,
): { ok: true; defects: EditorDefect[] } | { ok: false; errorCode: string; reason: string } {
  const p = parsed as { defects?: unknown } | null;
  if (!p || typeof p !== 'object') {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'editor output is not an object' };
  }
  if (!Array.isArray(p.defects)) {
    return {
      ok: false,
      errorCode: 'AGENT_SCHEMA',
      reason: 'defects must be an array (use [] when the piece is genuinely clean)',
    };
  }
  const hay = script.normalize('NFC');
  const defects: EditorDefect[] = [];
  for (const [i, raw] of p.defects.entries()) {
    const d = raw as Partial<EditorDefect> | null;
    const quote = typeof d?.quote === 'string' ? d.quote.normalize('NFC').trim() : '';
    const note = typeof d?.note === 'string' ? d.note.trim() : '';
    const severity = d?.severity;
    if (!quote || !note) {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `defects[${i}] needs a quote and a note` };
    }
    if (severity !== 'HIGH' && severity !== 'MEDIUM' && severity !== 'LOW') {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `defects[${i}].severity must be HIGH/MEDIUM/LOW` };
    }
    if (!hay.includes(quote)) {
      return {
        ok: false,
        errorCode: 'AGENT_UNGROUNDED',
        reason:
          `defects[${i}] quotes "${quote.slice(0, 60)}…", which is not an exact substring of the script. `
          + 'Quote the prose you are objecting to, verbatim.',
      };
    }
    defects.push({ quote, severity, note });
  }
  return { ok: true, defects };
}

// ── Prompts ───────────────────────────────────────────────────────────────

function buildStudyPrompt(opts: {
  title: string;
  brief: string;
  audience: string;
  formulaLabel: string;
  videoIds: string[];
}): string {
  return [
    '# Writer v2 — STUDY (read the pack, pick the gap, commit to facts)',
    '',
    'You are NOT writing the piece in this turn. First read the WHOLE normal Markdown',
    'source file `input/topic-pack.md`; it is the authoritative topic pack and source of',
    'facts. Then read `input/envelope.json` for the compact contract, title/brief and',
    'pack metadata. The assignment message gives absolute paths if this PTY has an older',
    'working directory — use those absolute paths, not a guessed relative directory.',
    'Do not open Chrome, a browser, Playwright or `file://`: the local Markdown file is',
    'the complete pack and is deliberately prepared for the filesystem Read tool.',
    '',
    `## Audience: ${opts.audience}`,
    `## Style formula: ${opts.formulaLabel}`,
    '',
    '## Title',
    opts.title,
    '',
    '## Brief',
    opts.brief,
    '',
    '## What to produce',
    '',
    '1. `coverageMap` — one entry per source video in the pack, saying what it actually',
    `   claims and from which angle. All ${opts.videoIds.length} pack video(s) must appear:`,
    `   ${opts.videoIds.join(', ') || '(see the pack)'}.`,
    '2. `gap` — one thing none of those videos did, that this audience would want. This is',
    '   the reason for the piece to exist. Not a new topic; a missing angle.',
    '3. `outline` — the compression contract for the piece: `coreInsight`, one',
    '   `memoryAnchor`, 2-8 `progression` beats (each with `newInformation`,',
    '   `characterOrArgumentChange`, `visualAnchor`), `endingPayoff`, `cutList`.',
    '   Every beat must add something new; a beat that restates an earlier beat under a',
    '   new heading is a rejected outline.',
    '4. `factsLedger` — every fact the piece is allowed to use, each with a quote copied',
    '   VERBATIM from the pack (an exact substring — do not tidy punctuation or spacing)',
    `   and the \`videoId\` it came from. At least ${MIN_LEDGER_FACTS} entries.`,
    '',
    '**This is the whole factual budget of the piece.** The writing stage will not see',
    'the pack — only this ledger. A number or a case that is not in the ledger cannot be',
    'used later, so put in what you will actually need.',
    '',
    'The quotes are checked programmatically against the pack; a paraphrase is rejected.',
    '',
    'Write JSON to `out/result.json`:',
    '',
    '```json',
    '{',
    '  "coverageMap": [ { "videoId": "...", "mainClaim": "...", "angle": "..." } ],',
    '  "gap": "...",',
    '  "outline": {',
    '    "coreInsight": "...",',
    '    "memoryAnchor": { "kind": "name|equation|contrast|image", "value": "..." },',
    '    "progression": [ { "beat": "...", "newInformation": "...",',
    '      "characterOrArgumentChange": "...", "visualAnchor": "..." } ],',
    '    "endingPayoff": { "resolvesOpening": "...", "audienceCanDo": "..." },',
    '    "cutList": ["..."]',
    '  },',
    '  "factsLedger": [ { "fact": "...", "videoId": "...", "quote": "<verbatim pack substring>" } ]',
    '}',
    '```',
  ].join('\n');
}

function buildWritePrompt(opts: {
  title: string;
  brief: string;
  audience: string;
  beatCount: number;
  ledgerCount: number;
  wordRange: { minWords: number; maxWords: number };
  forbiddenNames: string[];
  generalPackPath: string;
}): string {
  return [
    '# Writer v2 — WRITE (one pass, outline + ledger + the channel general pack)',
    '',
    'Read `input/envelope.json` for the style formula, outline and facts ledger. Then read',
    'the WHOLE normal Markdown general pack at `input/general-pack.md`. It is deliberately',
    'a separate file so it remains readable by line. The assignment message gives absolute',
    'paths if this PTY has an older working directory — use those paths when needed.',
    'Do not use Chrome, a browser, Playwright or `file://`; read the staged local Markdown',
    'file with the filesystem Read tool.',
    '',
    `## Title\n${opts.title}`,
    '',
    `## Brief\n${opts.brief}`,
    '',
    `## Audience: ${opts.audience}`,
    `## Length: ${opts.wordRange.minWords}-${opts.wordRange.maxWords} words`,
    'Before writing `out/result.json`, count ONLY `script` with',
    '`script.trim().split(/\\s+/).length`. Do not estimate or count JSON fields,',
    'notes, anchors or the prompt. The count must be inside this band before you reply',
    '"done" or call `team_turn_complete`.',
    '',
    '## What each input is for',
    '',
    `- **General pack** (\`${opts.generalPackPath}\`): HOW this channel makes moves — hook`,
    '  shapes, example strategy, payoff shapes, taste DNA, and what it deliberately',
    '  refuses to do. **Never a source of facts.** Do not take a number, a case, a person',
    '  or a story from it. Entries tagged `[nhân vật hư cấu — KHÔNG bắt chước]` are',
    '  examples of a move NOT to copy.',
    '- **factsLedger**: the ONLY facts you may state. Every number, name, place, study or',
    '  case in your script must trace to an entry here.',
    '- **outline**: the compression contract. Follow the beats; do not print field names.',
    '',
    '## Hard rules',
    '',
    '1. **Facts only from `factsLedger`.** This is checked in code against the pack after',
    '   you finish, so an invented specific does not survive.',
    '2. **Common knowledge is free — you do not need the ledger for it.** Everyday time',
    '   spans ("3 tới 6 tháng", "trả góp 12 tháng"), canonical fractions (0%, 25%, 50%,',
    '   100%), and widely-known conventions written with a visible attribution ("chuyên',
    '   gia thường khuyên…", "thông thường…", "quy tắc phổ biến là…") all pass. Write',
    '   naturally; do not hedge ordinary knowledge as if it were a fabricated claim.',
    '   **But money, ages, multiples and dated facts are never common knowledge** — every',
    '   figure in đồng/nghìn/triệu/tỷ, every age, every "N lần", and every year or study',
    '   must come from `factsLedger`. That is the exact line between craft and invention.',
    '3. If the craft calls for a concrete human example the ledger does not have, use an',
    '   openly hypothetical one and MARK it: "giả sử…", "ví dụ…", "thử hình dung…",',
    '   "tạm lấy…". Never give a hypothetical person a name, an age and a place — that is',
    '   a fabricated biography, not an illustration.',
    '3. At most 2 coined labels in the whole piece, and list them in `coinedLabels`. Plain',
    '   language beats a new term.',
    `4. You are not the pack's host. Forbidden identities: ${
      opts.forbiddenNames.length ? opts.forbiddenNames.map((n) => `"${n}"`).join(', ') : '(none)'
    }.`,
    '5. Vietnamese prose. Do not mention, enumerate or visibly perform the rules.',
    '',
    '## Before you write',
    '',
    'Write `outlineChanges`: 3-5 lines saying what you changed against the STUDY outline',
    'and which general-pack entry taught you that move. If you changed nothing, say so.',
    '',
    '## After you write',
    '',
    `Write the WHOLE script in one pass, then declare \`beatAnchors\`: exactly ${opts.beatCount}`,
    'quotes, one per outline beat, in beat order, each copied VERBATIM from your own',
    'script. These are checked as exact substrings — they are how the system knows a beat',
    'did not quietly get dropped.',
    '',
    `Facts available: ${opts.ledgerCount}. Beats: ${opts.beatCount}.`,
    '',
    'Write JSON to `out/result.json`:',
    '',
    '```json',
    '{ "title": "...", "script": "...", "outlineChanges": ["..."],',
    '  "beatAnchors": ["..."], "coinedLabels": [] }',
    '```',
  ].join('\n');
}

function buildWriteContinuationPrompt(opts: {
  previousWordCount: number;
  wordRange: { minWords: number; maxWords: number };
}): string {
  return [
    '',
    '## Continue a failed WRITE turn',
    '',
    'This is not a new article and not a new STUDY task. The prior WRITE turn stopped',
    'after leaving a draft. Read `input/previous-draft.md`, preserve its grounded',
    'material where it works, then rewrite it into a complete corrected submission.',
    `The prior draft has ${opts.previousWordCount} script words; this run requires exactly`,
    `${opts.wordRange.minWords}-${opts.wordRange.maxWords} words by the whitespace count`,
    'described above. Rebuild `title`, `script`, `outlineChanges`, `beatAnchors` and',
    '`coinedLabels` in `out/result.json`; do not merely add an explanation or a patch.',
  ].join('\n');
}

function buildEditReviewPrompt(opts: { hasGateViolations: boolean }): string {
  return [
    '# Writer v2 — EDIT REVIEW (read it as a viewer, then as an editor)',
    '',
    'Read `input/envelope.json`. You get the title, the outline the piece was written',
    'against, the script, and nothing else' + (opts.hasGateViolations
      ? ' except the violations a deterministic gate already found.'
      : '.'),
    'You deliberately do NOT get the source material or the writer\'s own notes: your job',
    'is the reading experience, not agreeing with the writer.',
    '',
    '## Checklist (in this order)',
    '',
    '1. Retell the piece in ONE sentence from memory. If you cannot, the memory anchor is weak.',
    '2. For each section, answer "what is the new information here?". If two sections give',
    '   the same answer, the progression is flat.',
    '3. Try deleting or swapping 2-3 sections. If the piece barely changes, the structure is',
    '   a taxonomy, not a journey.',
    '4. Does the ending pay the debt the hook created — the same number, question or image?',
    '5. **Read the last 20% again on its own.** A one-pass script decays there: repetition,',
    '   summary instead of payoff, an ending that restates rather than resolves.',
    '6. Is the prose dry — all rule, no life? That is a real MEDIUM defect, not a nitpick.',
    '7. **Recompute every number.** Redo every sum, difference, product, quotient, running',
    '   total and percentage in the piece — including the ones that look already sourced. A',
    '   figure can be wrong inside the source material itself, and the gate only checks that',
    '   a number HAS a source, never that it is CORRECT. From a real run: "20 triệu/tháng,',
    '   lợi nhuận 8%/năm, sau 7 năm được 1,7 đến gần 2 tỷ" — the contributions alone are',
    '   1,68 tỷ (20 × 84 months) and the true future value is about 2,24 tỷ. That number came',
    '   straight from the source video, the gate passed it, and one editor missed it too.',
    '8. **Repeated parallel structure.** Are there three consecutive sentences opening on the',
    '   same mould, far enough that it reads machine-written? Listing three action steps is',
    '   valid and normal — flag only when it sounds formulaic, not when it is merely parallel.',
    '9. **Metaphor.** Is the governing metaphor used to reason FURTHER, or only to sound good?',
    '   And is any single image reused often enough to have become a formula?',
    '10. **Steelman.** Is the opposing side built in its STRONGEST form before it is answered,',
    '    or only propped up so it falls over easily?',
    '11. **Ending — logic.** If the piece closes on a set of questions or a test, do they all',
    '    run in the SAME direction of pass/fail? From a real run: a piece closed on 4',
    '    questions that did not, so the rule "answer no to any one of them" inverted —',
    '    answering "no" to the question about the 30% threshold was in fact the safe signal.',
    '12. **Ending — image.** Does the final sentence close the CONCRETE image the opening set',
    '    up, or does it dissolve into an abstract proposition?',
    '',
    '## Output rules',
    '',
    '- Each defect quotes the exact prose it is about, copied VERBATIM from the script',
    '  (checked programmatically; a paraphrase is rejected).',
    '- `severity`: HIGH (the piece fails without this fix) / MEDIUM (materially weaker) /',
    '  LOW (worth a touch).',
    '- Do NOT propose rewriting the whole piece, and do not rewrite it yourself. Point at',
    '  what is wrong, in place.',
    '- An empty `defects` array is a valid, respected answer. Do not invent defects to look',
    '  thorough.',
    '- The checklist is where to look, not a defect quota. Twelve items passing clean is a',
    '  clean piece, not a review you did badly.',
    '',
    'Write JSON to `out/result.json`:',
    '',
    '```json',
    '{ "defects": [ { "quote": "...", "severity": "HIGH", "note": "..." } ] }',
    '```',
  ].join('\n');
}

function buildRepairPrompt(opts: {
  beatCount: number;
  wordRange: { minWords: number; maxWords: number };
  forbiddenNames: string[];
  gateViolations: string;
  defectCount: number;
}): string {
  return [
    '# Writer v2 — REPAIR (one round, in place)',
    '',
    'Read `input/envelope.json`: your script, the outline, the gate violations, and the',
    "editor's defects. Fix exactly those. Keep everything that already works — this is a",
    'repair, not a rewrite.',
    '',
    '## Gate violations (code, not opinion — these are not negotiable)',
    '',
    opts.gateViolations || '(none)',
    '',
    `## Editor defects: ${opts.defectCount}`,
    '',
    '## Hard rules',
    '',
    '1. Every number/name/case must still trace to `factsLedger`. Three valid fixes for an',
    '   unsourced number: delete it, mark its sentence as openly hypothetical ("giả sử…"),',
    '   or — if it is genuinely common knowledge (an everyday time span, a canonical',
    '   fraction, a widely-known convention) — attribute it in the prose ("chuyên gia',
    '   thường khuyên…", "thông thường…"). Inventing a source is not a fix. Money, ages,',
    '   "N lần" and years never qualify as common knowledge; those must come from the',
    '   ledger or go.',
    '2. A hypothetical person stays unnamed.',
    `3. Length stays in ${opts.wordRange.minWords}-${opts.wordRange.maxWords} words.`,
    `4. Forbidden host identities: ${
      opts.forbiddenNames.length ? opts.forbiddenNames.map((n) => `"${n}"`).join(', ') : '(none)'
    }.`,
    `5. Re-declare all ${opts.beatCount} \`beatAnchors\` against the REPAIRED script — if you`,
    '   edited an anchor sentence, quote the new wording.',
    '',
    'This is the ONLY repair round. After it, the gate runs again and the run either',
    'finishes or stops for a human. Do not perform compliance; actually fix the facts.',
    '',
    'Write JSON to `out/result.json`:',
    '',
    '```json',
    '{ "title": "...", "script": "...", "outlineChanges": ["..."],',
    '  "beatAnchors": ["..."], "coinedLabels": [] }',
    '```',
  ].join('\n');
}

// ── Dispatch helpers ──────────────────────────────────────────────────────

async function readCommittedArtifact<T>(dataDir: string, event: ItemSettledResult): Promise<T> {
  const path = join(
    dataDir, 'workspaces', 'pipeline', event.batchId, event.itemId,
    'attempts', String(event.attempt), event.stage,
    'artifacts', `${event.stage}-v${event.attempt}.json`,
  );
  const raw = await readFile(path, 'utf8');
  if (event.artifactHash) {
    const actualHash = createHash('sha256').update(raw).digest('hex');
    if (actualHash !== event.artifactHash) {
      throw new Error(
        `[writer-v2] artifact hash mismatch for ${event.itemId}/${event.stage} `
        + `(ledger ${event.artifactHash}, disk ${actualHash})`,
      );
    }
  }
  return JSON.parse(raw) as T;
}

async function failRun(
  deps: WriterV2Deps,
  run: WriterRunV2,
  errorCode: string,
  errorReason?: string,
  status: 'FAILED' | 'FAILED_GATE' = 'FAILED',
): Promise<void> {
  run.status = status;
  run.phase = status === 'FAILED_GATE' ? 'GATE' : 'FAILED';
  run.errorCode = errorCode;
  if (errorReason) run.errorReason = errorReason;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);
}

async function handleDispatchFailure(
  deps: WriterV2Deps,
  run: WriterRunV2,
  dispatch: DispatchItemResult,
  fallbackCode: string,
): Promise<void> {
  if (dispatch.status === 'RUNNING') return;
  await failRun(deps, run, dispatch.reason ?? fallbackCode);
}

/** Pick an editor that is not the writer — Layer 1 must be a second opinion. */
export function defaultEditorAgent(writerAgent: DefaultAgentId): DefaultAgentId {
  const other = DEFAULT_AGENT_IDS.find((id) => id !== writerAgent);
  return (other ?? writerAgent) as DefaultAgentId;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function startWriterRunV2(
  deps: WriterV2Deps,
  input: {
    brief: string;
    title?: string;
    audience?: string;
    targetWords?: number;
    packId: string;
    generalPack: string;
    formulaId: string;
    agentId?: DefaultAgentId;
    editorAgentId?: DefaultAgentId;
  },
): Promise<WriterRunV2> {
  const brief = input.brief.trim();
  if (!brief) throw new Error('brief bắt buộc');
  if (!input.packId?.trim()) throw new Error('packId bắt buộc — v2 luôn cần topic pack');
  if (!input.generalPack?.trim()) throw new Error('generalPack bắt buộc — vd "hieu-tv.md"');
  if (!input.formulaId?.trim()) throw new Error('formulaId bắt buộc — formula là hợp đồng style của v2');

  const pack = await getWriterPack(input.packId, deps.dataDir);
  if (!pack) throw new Error('Source Pack không tồn tại');

  const generalPack = await getGeneralPack(input.generalPack, deps.dataDir);
  if (!generalPack) throw new Error(`General pack không tồn tại: ${input.generalPack}`);

  const formula = await getFormula(input.formulaId, deps.dataDir);
  if (!formula) throw new Error('Formula không tồn tại');

  let targetWords: number | undefined;
  if (input.targetWords !== undefined && input.targetWords !== null) {
    const n = Number(input.targetWords);
    if (!Number.isFinite(n) || n < 200) throw new Error('targetWords phải ≥ 200 (số từ)');
    if (n > 20_000) throw new Error('targetWords quá lớn (max 20000)');
    targetWords = Math.round(n);
  }

  const agentId: DefaultAgentId =
    input.agentId && (DEFAULT_AGENT_IDS as readonly string[]).includes(input.agentId)
      ? input.agentId
      : 'codex';
  const editorAgentId: DefaultAgentId =
    input.editorAgentId && (DEFAULT_AGENT_IDS as readonly string[]).includes(input.editorAgentId)
      ? input.editorAgentId
      : defaultEditorAgent(agentId);

  const now = new Date().toISOString();
  const normalized = normalizeFormula(formula);
  const run: WriterRunV2 = {
    id: randomUUID(),
    status: 'RUNNING',
    phase: 'STUDY',
    brief,
    ...(input.title?.trim() ? { requestedTitle: input.title.trim() } : {}),
    ...(targetWords !== undefined ? { targetWords } : {}),
    ...(input.audience?.trim() ? { audience: input.audience.trim() } : {}),
    packId: pack.id,
    packTitle: pack.title || pack.channelTitle || 'Source Pack',
    generalPackPath: generalPack.path,
    generalPackHash: generalPack.hash,
    generalPackVersion: generalPack.version,
    formulaId: normalized.id,
    formulaVersion: normalized.version,
    formulaHash: pinFormulaHash(formula),
    agentId,
    editorAgentId,
    study: null,
    draft: null,
    gateResults: [],
    editorDefects: null,
    finalScript: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveWriterRunV2(run, deps.dataDir);

  await dispatchStudy(deps, run, pack, formula);
  return (await getWriterRunV2(run.id, deps.dataDir)) ?? run;
}

const DEFAULT_AUDIENCE =
  'người đi làm ở Việt Nam, thu nhập trung bình trở lên, muốn hiểu tiền và lựa chọn sống — '
  + 'không tìm mẹo làm giàu';

async function dispatchStudy(
  deps: WriterV2Deps,
  run: WriterRunV2,
  pack: WriterPack,
  formula: FormulaArtifact,
): Promise<void> {
  const videoIds = packVideoIds(pack);
  const title = run.requestedTitle ?? run.brief;
  const audience = run.audience ?? DEFAULT_AUDIENCE;
  // Keep the envelope compact. The large topic pack is staged as line-readable
  // Markdown next to it; embedding it as a JSON string would escape every newline
  // and create one unreadable physical line for agent Read tools.
  const envelope = {
    contract: {
      role: 'Writer v2 — STUDY stage',
      audience,
      formula: formulaContractView(formula),
      packRole: 'the only source of facts',
      generalPackRole: 'not visible in this stage — craft comes later',
    },
    title,
    brief: run.brief,
    topicPack: {
      id: pack.id,
      title: pack.title,
      channelTitle: pack.channelTitle,
      videoIds,
      channelIsNotNarrator: true,
      contentFile: 'input/topic-pack.md',
      warnings: pack.warnings,
    },
    instructions: {
      coverageMap: 'one entry per pack video: what it claims, from which angle',
      gap: 'one thing none of them did, that this audience wants',
      outline: 'the compression contract (WriterVideoPlan shape)',
      factsLedger: `at least ${MIN_LEDGER_FACTS} facts, each with a verbatim pack quote`,
    },
  };

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: WRITER_V2_ITEM_ID,
    stage: STUDY_STAGE,
    attempt: 1,
    templateId: run.agentId,
    promptMarkdown: buildStudyPrompt({
      title,
      brief: run.brief,
      audience,
      formulaLabel: formulaContractView(formula).label || run.packTitle,
      videoIds,
    }),
    envelope,
    inputFiles: [{ path: 'topic-pack.md', content: pack.markdown }],
    inputHashes: [envelopeHash(envelope), contentHash(pack.markdown)],
    promptVersion: STUDY_PROMPT_VERSION,
    sessionGroup: AUTHOR_PTY_SESSION_GROUP,
    interactivePty: true,
    validateContent: (parsed) => {
      const v = validateStudyArtifact(parsed, { packMarkdown: pack.markdown, videoIds });
      return v.ok ? { ok: true as const } : { ok: false as const, errorCode: v.errorCode, reason: v.reason };
    },
  });
  await handleDispatchFailure(deps, run, dispatch, 'STUDY_DISPATCH_FAILED');
}

interface WriteContinuation {
  previousDraft: string;
  previousWordCount: number;
}

/** Keep each staged line safely readable even if an earlier agent wrote one huge
 * paragraph. Newlines are whitespace for the draft reference, so this cannot
 * change its word count or meaning for the continuing writer. */
function lineReadableDraft(markdown: string, maxLineChars = 4_000): string {
  return markdown
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.length <= maxLineChars) return [line];
      const words = line.split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        if (current && current.length + word.length + 1 > maxLineChars) {
          lines.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) lines.push(current);
      return lines;
    })
    .join('\n');
}

async function dispatchWrite(
  deps: WriterV2Deps,
  run: WriterRunV2,
  options: { attempt?: number; continuation?: WriteContinuation } = {},
): Promise<void> {
  const study = run.study;
  if (!study) throw new Error('[writer-v2] dispatchWrite called before study was set');
  const pack = await getWriterPack(run.packId, deps.dataDir);
  const generalPack = await getGeneralPack(run.generalPackPath, deps.dataDir);
  const formula = await getFormula(run.formulaId, deps.dataDir);
  if (!pack || !generalPack || !formula) {
    await failRun(deps, run, 'WRITER_V2_INPUT_MISSING', 'pack, general pack or formula disappeared before WRITE');
    return;
  }
  if (generalPack.hash !== run.generalPackHash) {
    await failRun(
      deps,
      run,
      'GENERAL_PACK_CHANGED',
      `General pack "${run.generalPackPath}" đã bị sửa sau khi run bắt đầu (hash pin ${run.generalPackHash.slice(0, 12)}…). `
      + 'Tạo run mới để dùng bản mới.',
    );
    return;
  }

  const forbiddenNames = forbiddenHostNames({ channelTitle: pack.channelTitle, title: pack.title });
  const wordRange = wordRangeFor(run);
  const audience = run.audience ?? DEFAULT_AUDIENCE;
  const continuation = options.continuation;
  const envelope = {
    contract: {
      role: 'Writer v2 — WRITE stage',
      audience,
      formula: formulaContractView(formula),
      forbiddenHostNames: forbiddenNames,
      wordRange,
    },
    title: run.requestedTitle ?? run.brief,
    brief: run.brief,
    outline: study.outline,
    factsLedger: study.factsLedger,
    gap: study.gap,
    generalPack: {
      path: generalPack.path,
      version: generalPack.version,
      hash: generalPack.hash,
      role: 'HOW this channel makes moves. Never a source of facts, cases or numbers.',
      contentFile: 'input/general-pack.md',
    },
    instructions: {
      facts: 'only from factsLedger; unsourced specifics must be openly hypothetical and unnamed',
      coinedLabels: 'at most 2, declared',
      beatAnchors: 'one verbatim script quote per outline beat, in order',
      outlineChanges: '3-5 lines: what changed vs the outline, learned from which general-pack entry',
    },
    ...(continuation
      ? {
          continuation: {
            previousDraftFile: 'input/previous-draft.md',
            previousWordCount: continuation.previousWordCount,
            instruction: 'rewrite the previous draft into a full valid submission; do not continue with prose only',
          },
        }
      : {}),
  };
  const stagedPreviousDraft = continuation ? lineReadableDraft(continuation.previousDraft) : undefined;

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: WRITER_V2_ITEM_ID,
    stage: WRITE_STAGE,
    attempt: options.attempt ?? 1,
    templateId: run.agentId,
    promptMarkdown: `${buildWritePrompt({
      title: run.requestedTitle ?? run.brief,
      brief: run.brief,
      audience,
      beatCount: study.outline.progression.length,
      ledgerCount: study.factsLedger.length,
      wordRange,
      forbiddenNames,
      generalPackPath: generalPack.path,
    })}${continuation
      ? buildWriteContinuationPrompt({ previousWordCount: continuation.previousWordCount, wordRange })
      : ''}`,
    envelope,
    inputFiles: [
      { path: 'general-pack.md', content: generalPack.markdown },
      ...(stagedPreviousDraft ? [{ path: 'previous-draft.md', content: stagedPreviousDraft }] : []),
    ],
    inputHashes: [
      envelopeHash(envelope),
      contentHash(generalPack.markdown),
      ...(stagedPreviousDraft ? [contentHash(stagedPreviousDraft)] : []),
    ],
    promptVersion: WRITE_PROMPT_VERSION,
    sessionGroup: AUTHOR_PTY_SESSION_GROUP,
    interactivePty: true,
    // A timed-out CLI pane may be stuck mid-prompt. Keep the visible author pane
    // identity, but launch this recovery turn with a clean CLI context.
    ...(continuation ? { freshContext: true } : {}),
    validateContent: (parsed) => {
      const v = validateWriterV2Draft(parsed, {
        outline: study.outline,
        wordRange,
        forbiddenNames,
        requireOutlineChanges: true,
      });
      return v.ok ? { ok: true as const } : { ok: false as const, errorCode: v.errorCode, reason: v.reason };
    },
  });
  await handleDispatchFailure(deps, run, dispatch, 'WRITE_DISPATCH_FAILED');
}

/**
 * Continue exactly the WRITE portion of a failed v2 run. STUDY is already
 * committed, so this creates WRITE attempt 2 from the orphaned attempt-1 draft
 * rather than reading the topic pack again or starting a second article.
 */
export async function continueWriterRunV2(
  deps: WriterV2Deps,
  runId: string,
): Promise<WriterRunV2> {
  const run = await getWriterRunV2(runId, deps.dataDir);
  if (!run) throw new Error('Writer v2 run không tồn tại');
  if (run.status === 'RUNNING') {
    throw new Error(`Run đang ${run.phase}; chờ turn hiện tại settle trước khi tiếp tục`);
  }
  if (run.status !== 'FAILED' || run.phase !== 'FAILED') {
    throw new Error(`Chỉ tiếp tục được Writer v2 run FAILED ở WRITE (hiện: ${run.status}/${run.phase})`);
  }
  if (!run.study || run.draft) {
    throw new Error('Run này không phải lỗi WRITE sau STUDY; hãy dùng ReRun bài mới');
  }

  const previousResultPath = join(
    deps.dataDir,
    'workspaces',
    'pipeline',
    run.id,
    WRITER_V2_ITEM_ID,
    'attempts',
    '1',
    WRITE_STAGE,
    'out',
    'result.json',
  );
  let previous: Partial<WriterV2Draft> | null;
  try {
    previous = JSON.parse(await readFile(previousResultPath, 'utf8')) as Partial<WriterV2Draft>;
  } catch {
    throw new Error('Không đọc được bản nháp WRITE dở dang; hãy dùng ReRun bài mới');
  }
  const previousDraft = typeof previous?.script === 'string' ? previous.script.trim() : '';
  if (!previousDraft) {
    throw new Error('Bản nháp WRITE dở dang không có `script`; hãy dùng ReRun bài mới');
  }

  run.status = 'RUNNING';
  run.phase = 'WRITE';
  run.errorCode = undefined;
  run.errorReason = undefined;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);

  await dispatchWrite(deps, run, {
    attempt: 2,
    continuation: {
      previousDraft,
      previousWordCount: countScriptWords(previousDraft),
    },
  });
  return (await getWriterRunV2(run.id, deps.dataDir)) ?? run;
}

/**
 * Layer 0. Pure code, so it is also safe to call from a test or a CLI against an
 * old run. Returns the result AND appends it to the run's history.
 */
export async function runGateForRun(
  deps: WriterV2Deps,
  run: WriterRunV2,
): Promise<GateResult> {
  const pack = await getWriterPack(run.packId, deps.dataDir);
  const draft = run.draft;
  if (!pack || !draft) {
    const result: GateResult = {
      passed: false,
      violations: [{ code: 'NUMBER_UNSOURCED', detail: 'gate ran without a pack or a draft' }],
    };
    run.gateResults.push(result);
    return result;
  }
  const result = runDeterministicGate({
    script: draft.script,
    packMarkdown: pack.markdown,
    ...(run.study ? { factsLedger: run.study.factsLedger, outline: run.study.outline } : {}),
    beatAnchors: draft.beatAnchors,
    wordRange: wordRangeFor(run),
    forbiddenNames: forbiddenHostNames({ channelTitle: pack.channelTitle, title: pack.title }),
    ...(draft.coinedLabels ? { declaredCoinedLabels: draft.coinedLabels } : {}),
  });
  run.gateResults.push(result);
  return result;
}

async function dispatchEditReview(deps: WriterV2Deps, run: WriterRunV2): Promise<void> {
  const draft = run.draft;
  const study = run.study;
  if (!draft || !study) throw new Error('[writer-v2] dispatchEditReview called too early');
  const gate = run.gateResults.at(-1);
  const violations = gate?.violations ?? [];

  // Envelope is deliberately minimal: title, outline, script, gate violations. No
  // pack, no general pack, no writer self-report. An editor that can see the
  // writer's reasoning starts grading the reasoning.
  const envelope = {
    title: draft.title,
    outline: study.outline,
    script: draft.script,
    ...(violations.length > 0
      ? { gateViolations: violations.map((v) => ({ code: v.code, detail: v.detail, quote: v.quote })) }
      : {}),
  };

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: WRITER_V2_ITEM_ID,
    stage: EDIT_REVIEW_STAGE,
    attempt: 1,
    templateId: run.editorAgentId,
    promptMarkdown: buildEditReviewPrompt({ hasGateViolations: violations.length > 0 }),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: EDIT_REVIEW_PROMPT_VERSION,
    sessionGroup: EDITOR_PTY_SESSION_GROUP,
    interactivePty: true,
    freshContext: true,
    validateContent: (parsed) => {
      const v = validateEditorReview(parsed, draft.script);
      return v.ok ? { ok: true as const } : { ok: false as const, errorCode: v.errorCode, reason: v.reason };
    },
  });
  await handleDispatchFailure(deps, run, dispatch, 'EDIT_REVIEW_DISPATCH_FAILED');
}

async function dispatchRepair(deps: WriterV2Deps, run: WriterRunV2): Promise<void> {
  const draft = run.draft;
  const study = run.study;
  if (!draft || !study) throw new Error('[writer-v2] dispatchRepair called too early');
  const pack = await getWriterPack(run.packId, deps.dataDir);
  if (!pack) {
    await failRun(deps, run, 'WRITER_V2_INPUT_MISSING', 'pack disappeared before REPAIR');
    return;
  }
  const violations = run.gateResults.at(-1)?.violations ?? [];
  const defects = run.editorDefects ?? [];
  const forbiddenNames = forbiddenHostNames({ channelTitle: pack.channelTitle, title: pack.title });
  const wordRange = wordRangeFor(run);

  const envelope = {
    draft: { title: draft.title, script: draft.script },
    outline: study.outline,
    factsLedger: study.factsLedger,
    gateViolations: violations,
    defects,
    wordRange,
    forbiddenHostNames: forbiddenNames,
  };

  run.repairAttempted = true;
  await saveWriterRunV2(run, deps.dataDir);

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: WRITER_V2_ITEM_ID,
    stage: REPAIR_STAGE,
    attempt: 1,
    templateId: run.agentId,
    promptMarkdown: buildRepairPrompt({
      beatCount: study.outline.progression.length,
      wordRange,
      forbiddenNames,
      gateViolations: formatGateViolations(violations),
      defectCount: defects.length,
    }),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: REPAIR_PROMPT_VERSION,
    sessionGroup: AUTHOR_PTY_SESSION_GROUP,
    interactivePty: true,
    validateContent: (parsed) => {
      const v = validateWriterV2Draft(parsed, {
        outline: study.outline,
        wordRange,
        forbiddenNames,
        // The repair turn is about fixing prose, not re-justifying the outline.
        requireOutlineChanges: false,
      });
      return v.ok ? { ok: true as const } : { ok: false as const, errorCode: v.errorCode, reason: v.reason };
    },
  });
  await handleDispatchFailure(deps, run, dispatch, 'REPAIR_DISPATCH_FAILED');
}

/**
 * Layer 0 → Layer 1 → Layer 2 → Layer 0, driven by settle events.
 *
 * `DONE` is set in exactly one place, and only when the latest gate result passed.
 * That is the structural fix for run `86de3ca5` (a `DONE` run whose own reviewer
 * had reported a violation).
 */
export function registerWriterV2SettleListener(
  scheduler: LaneScheduler,
  deps: { dataDir: string },
): () => void {
  const fullDeps: WriterV2Deps = { scheduler, dataDir: deps.dataDir };
  return scheduler.onItemSettled((event) => {
    if (
      event.stage !== STUDY_STAGE
      && event.stage !== WRITE_STAGE
      && event.stage !== EDIT_REVIEW_STAGE
      && event.stage !== REPAIR_STAGE
    ) return;
    void handleWriterV2Settle(fullDeps, event).catch((err) => {
      console.error('[writer-v2] settle failed:', (err as Error).message);
    });
  });
}

async function handleWriterV2Settle(deps: WriterV2Deps, event: ItemSettledResult): Promise<void> {
  const run = await getWriterRunV2(event.batchId, deps.dataDir);
  if (!run) return;
  if (run.status !== 'RUNNING') return;

  if (event.outcome !== 'COMMITTED' || !event.artifactHash) {
    await failRun(
      deps,
      run,
      event.errorCode ?? `${event.stage.toUpperCase().replaceAll('-', '_')}_FAILED`,
      event.errorReason,
    );
    return;
  }

  switch (event.stage) {
    case STUDY_STAGE: {
      const pack = await getWriterPack(run.packId, deps.dataDir);
      if (!pack) {
        await failRun(deps, run, 'WRITER_V2_INPUT_MISSING', 'pack disappeared after STUDY');
        return;
      }
      const parsed = await readCommittedArtifact<unknown>(deps.dataDir, event);
      const validated = validateStudyArtifact(parsed, {
        packMarkdown: pack.markdown,
        videoIds: packVideoIds(pack),
      });
      if (!validated.ok) {
        await failRun(deps, run, validated.errorCode, validated.reason);
        return;
      }
      run.study = validated.study;
      run.phase = 'WRITE';
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, deps.dataDir);
      await dispatchWrite(deps, run);
      return;
    }

    case WRITE_STAGE:
    case REPAIR_STAGE: {
      const study = run.study;
      if (!study) {
        await failRun(deps, run, 'WRITER_V2_INPUT_MISSING', 'study missing when a draft settled');
        return;
      }
      const pack = await getWriterPack(run.packId, deps.dataDir);
      if (!pack) {
        await failRun(deps, run, 'WRITER_V2_INPUT_MISSING', 'pack disappeared after a draft');
        return;
      }
      const parsed = await readCommittedArtifact<unknown>(deps.dataDir, event);
      const validated = validateWriterV2Draft(parsed, {
        outline: study.outline,
        wordRange: wordRangeFor(run),
        forbiddenNames: forbiddenHostNames({ channelTitle: pack.channelTitle, title: pack.title }),
        requireOutlineChanges: event.stage === WRITE_STAGE,
      });
      if (!validated.ok) {
        await failRun(deps, run, validated.errorCode, validated.reason);
        return;
      }
      run.draft = validated.draft;
      run.phase = 'GATE';
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, deps.dataDir);

      // Layer 0.
      const gate = await runGateForRun(deps, run);
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, deps.dataDir);

      if (event.stage === REPAIR_STAGE) {
        // After a repair only the gate runs again: a second editor round teaches
        // compliance theatre, and the human is the right next reader.
        if (gate.passed) {
          run.status = 'DONE';
          run.phase = 'DONE';
          run.finalScript = validated.draft.script;
          run.updatedAt = new Date().toISOString();
          await saveWriterRunV2(run, deps.dataDir);
          await notifyWriterV2Done(run, deps.dataDir);
          return;
        }
        await failRun(
          deps,
          run,
          'WRITER_V2_GATE',
          `Gate vẫn đỏ sau một vòng sửa:\n${formatGateViolations(gate.violations)}`,
          'FAILED_GATE',
        );
        return;
      }

      // First pass: the editor always runs, clean gate or not — it sees what code
      // cannot (flat progression, a dead last 20%, an ending that doesn't pay).
      run.phase = 'EDIT_REVIEW';
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, deps.dataDir);
      await dispatchEditReview(deps, run);
      return;
    }

    case EDIT_REVIEW_STAGE: {
      const draft = run.draft;
      if (!draft) {
        await failRun(deps, run, 'WRITER_V2_INPUT_MISSING', 'draft missing when the editor settled');
        return;
      }
      const parsed = await readCommittedArtifact<unknown>(deps.dataDir, event);
      const validated = validateEditorReview(parsed, draft.script);
      if (!validated.ok) {
        await failRun(deps, run, validated.errorCode, validated.reason);
        return;
      }
      run.editorDefects = validated.defects;
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, deps.dataDir);

      const gate = run.gateResults.at(-1);
      const gateClean = gate?.passed ?? false;
      if (gateClean && validated.defects.length === 0) {
        run.status = 'DONE';
        run.phase = 'DONE';
        run.finalScript = draft.script;
        run.updatedAt = new Date().toISOString();
        await saveWriterRunV2(run, deps.dataDir);
        await notifyWriterV2Done(run, deps.dataDir);
        return;
      }

      run.phase = 'REPAIR';
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, deps.dataDir);
      await dispatchRepair(deps, run);
      return;
    }

    default:
      return;
  }
}

// ── Restyle ───────────────────────────────────────────────────────────────
//
// A side operation on a finished run, not a sixth stage. The invariants that
// make it safe to run on a `DONE` record:
//
//   - `run.status` and `run.finalScript` are NEVER written here, on any branch,
//     success or failure. The sourced original stays exactly as the gate left it.
//   - It has its OWN settle listener. `handleWriterV2Settle` returns early unless
//     the run is `RUNNING`, so a restyle settle would be silently dropped by it —
//     and `restyle-v1` must stay out of that listener's stage whitelist.
//   - It never calls `handleDispatchFailure`: that helper fails the whole run, and
//     treats `WAITING_LANE` (legitimate backpressure) as an error.
//   - `attempt` is the styled-version number, and the style file's hash is in
//     `inputHashes`. Both feed `computeTurnKey`, so restyling the same run with a
//     different style — or the same style twice — gets a genuinely new turn
//     instead of re-attaching to the previous one.

/** Where a styled version lives, relative to `dataDir`. */
function styledRelPath(runId: string, version: number): string {
  return `writer/styled/${runId}/v${version}.md`;
}

/**
 * Path to the agent's raw `out/result.json` for a restyle turn — present even when
 * the turn was INTERRUPTED before the ledger commit step copied it into `artifacts/`.
 * Used by `recoverInterruptedRestyles` after a daemon reboot: `reconcileOnBoot` marks
 * the ledger row INTERRUPTED but never fires `onItemSettled`, so without this the run
 * would stay `restyling` forever — the exact failure `studio-synthesize.ts` documents
 * for its own SYNTHESIZE turn.
 *
 * `attempt` is the styled-version number for this stage (see `dispatchRestyle`).
 */
function restyleOutResultPath(dataDir: string, runId: string, version: number): string {
  return join(
    dataDir,
    'workspaces',
    'pipeline',
    runId,
    WRITER_V2_ITEM_ID,
    'attempts',
    String(version),
    RESTYLE_STAGE,
    'out',
    'result.json',
  );
}

function buildRestylePrompt(opts: {
  styleTitle: string;
  wordRange: { minWords: number; maxWords: number };
  ledgerCount: number;
  forbiddenNames: string[];
}): string {
  return [
    '# Writer v2 — RESTYLE (same piece, different voice)',
    '',
    'Read the finished script at `input/source.md`, then read the channel style at',
    '`input/style.md`. `input/envelope.json` holds the compact contract: the facts',
    'ledger the original was written against, the length band, and the forbidden host',
    'names. The assignment message gives absolute paths if this PTY has an older',
    'working directory — use those paths. Do not open Chrome, a browser, Playwright or',
    '`file://`; both inputs are staged as line-readable local Markdown.',
    '',
    `## Style: ${opts.styleTitle}`,
    `## Length: ${opts.wordRange.minWords}-${opts.wordRange.maxWords} words`,
    'Count ONLY `script`, with `script.trim().split(/\\s+/).length`, before you write',
    '`out/result.json`.',
    '',
    '## What this turn is',
    '',
    'This is a VOICE rewrite, not a new article. The argument already exists and it is',
    'already sourced. Keep its claims, keep the order it makes them in, and keep every',
    'fact. What changes is how it sounds: person and address, the shape of the beats,',
    'the images, the ending contract — whatever `input/style.md` prescribes. Where the',
    'style contradicts the original\'s voice, the style wins; where it would contradict',
    'a fact, the fact wins.',
    '',
    '## Hard rules',
    '',
    '1. **Do not change a single fact.** No number, organisation name, survey sample,',
    '   study or year may be altered, rounded, re-attributed or "improved". If the',
    '   original says 43%, the restyle says 43%.',
    '2. **Do not add facts.** Everything factual must already be in `factsLedger` or in',
    `   the source script. Facts available: ${opts.ledgerCount}. Nothing new gets invented`,
    '   to make a scene land better.',
    `3. You are not the source pack's host. Forbidden identities: ${
      opts.forbiddenNames.length ? opts.forbiddenNames.map((n) => `"${n}"`).join(', ') : '(none)'
    }.`,
    '4. Vietnamese prose. Do not mention, enumerate or visibly perform the style rules.',
    '',
    '## If the style asks for a recurring fictional character',
    '',
    'Some styles carry a named character through the piece. That is allowed, and these',
    'three laws are not negotiable:',
    '',
    '1. **The character\'s arithmetic must actually be right.** Every figure you give the',
    '   character has to add up, and any ratio you state about them has to fall inside a',
    '   band the ledger supports. `1,3 triệu × 10 kỳ = 13 triệu` — do the multiplication.',
    '   `6,5/15 = 43%` — and only write that if the ledger has a `40–45%` band to land in.',
    '2. **Keep the source\'s multiple when you localise a number.** A real failure: the',
    '   source moved from `600 đô` to `4000 đô`, a 6,67× jump; the rewrite localised it as',
    '   `15 → 70 triệu`, only 4,67×, and quietly changed what the piece claims. The correct',
    '   localisation is `15 → 100 triệu`. Compute the source ratio first, then pick the',
    '   local numbers to match it.',
    '3. **A fictional character NEVER speaks a quote from `factsLedger`.** Testimony from a',
    '   real person keeps its real subject — it stays attributed to whoever actually said',
    '   it. Your character may only ENCOUNTER it: read it, hear it, recognise themself in',
    '   it. The moment an invented person utters a sourced line, the piece is fabricating',
    '   evidence.',
    '',
    'Write JSON to `out/result.json`:',
    '',
    '```json',
    '{ "title": "...", "script": "..." }',
    '```',
  ].join('\n');
}

/**
 * Deliberately the THINNEST validator in this file: non-empty fields, the length
 * band, and the host-identity leak. No gate, no ledger check, no character-maths
 * check.
 *
 * The reason is the retry loop behind it. A `validateContent` failure sends the
 * agent back to rewrite, up to `DEFAULT_MAX_CONTENT_RETRIES` times, with the
 * violation quoted at it — which is precisely the "perform compliance until the
 * checker shuts up" loop this whole design avoids (see the file header on why the
 * 3-round refine loop was removed). The character-arithmetic and no-new-facts laws
 * are stated in the prompt and read by a human on the styled file; they are not
 * turned into an auto-retry whip.
 */
export function validateRestyleOutput(
  parsed: unknown,
  opts: { wordRange: { minWords: number; maxWords: number }; forbiddenNames: string[] },
): { ok: true; title: string; script: string } | { ok: false; errorCode: string; reason: string } {
  const p = parsed as { title?: unknown; script?: unknown } | null;
  if (!p || typeof p !== 'object') {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'restyle output is not an object' };
  }
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  const script = typeof p.script === 'string' ? p.script.trim() : '';
  if (!title) return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'title missing or empty' };
  if (!script) return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'script missing or empty' };

  const words = countScriptWords(script);
  const { minWords, maxWords } = opts.wordRange;
  if (words < minWords || words > maxWords) {
    return {
      ok: false,
      errorCode: 'RESTYLE_LENGTH',
      reason:
        `script is ${words} words — band is ${minWords}-${maxWords}. `
        + 'Overwrite out/result.json at the right length; do not leave this file and reply "done".',
    };
  }

  const leak = findIdentityLeak(script, opts.forbiddenNames);
  if (leak) {
    return {
      ok: false,
      errorCode: 'RESTYLE_IDENTITY',
      reason:
        `script adopts the source-pack host identity "${leak}". This channel is not that host — `
        + 'keep the facts, drop the persona. Overwrite out/result.json.',
    };
  }

  return { ok: true, title, script };
}

/**
 * Validate a raw restyle payload against THIS run's own band and host names.
 * Shared by the settle path and the boot-recovery path so the two can never drift
 * into accepting different things.
 */
async function validateRestyleForRun(
  dataDir: string,
  run: WriterRunV2,
  parsed: unknown,
): Promise<ReturnType<typeof validateRestyleOutput>> {
  const pack = await getWriterPack(run.packId, dataDir);
  return validateRestyleOutput(parsed, {
    wordRange: wordRangeFor(run),
    forbiddenNames: pack ? forbiddenHostNames({ channelTitle: pack.channelTitle, title: pack.title }) : [],
  });
}

/**
 * Commit ONE validated styled version onto a run: write the versioned markdown file,
 * append the `StyledVersion` entry, clear the in-flight flag, save.
 *
 * The single place a styled version is ever committed — `handleRestyleSettle` (normal
 * path) and `recoverInterruptedRestyles` (post-reboot path) both go through here, so
 * a run recovered at boot is byte-for-byte the same record as one settled live.
 *
 * `run.status`, `run.phase` and `run.finalScript` are NOT touched, ever. A styled
 * version is an addition to a finished run, never a replacement for what the gate
 * approved.
 */
async function commitStyledVersion(
  dataDir: string,
  run: WriterRunV2,
  opts: { version: number; styleId: string; title: string; script: string },
): Promise<void> {
  const { version, styleId, title, script } = opts;
  const style = await getChannelStyle(styleId, dataDir);
  const dir = join(writerRoot(dataDir), 'styled', run.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `v${version}.md`), `# ${title}\n\n${script}\n`, 'utf8');

  run.styled = [
    ...(run.styled ?? []),
    {
      version,
      styleId,
      styleVersion: style?.version ?? null,
      styleHash: style?.hash ?? '',
      agentId: run.agentId,
      path: styledRelPath(run.id, version),
      words: countScriptWords(script),
      createdAt: new Date().toISOString(),
    },
  ];
  delete run.restyling;
  run.restyleError = undefined;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, dataDir);
}

/** Record a restyle failure WITHOUT touching `run.status`, `phase` or `finalScript`. */
async function recordRestyleError(
  dataDir: string,
  run: WriterRunV2,
  code: string,
  reason: string,
): Promise<void> {
  run.restyleError = { code, reason, at: new Date().toISOString() };
  delete run.restyling;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, dataDir);
}

/**
 * Rewrite a finished run's `finalScript` in a channel style, as a new version.
 *
 * The run must be `DONE` — restyle is not a way to rescue a red gate, and the
 * original it starts from must be one a human could already ship.
 */
export async function startRestyle(
  deps: WriterV2Deps,
  runId: string,
  styleId: string,
): Promise<WriterRunV2> {
  const run = await getWriterRunV2(runId, deps.dataDir);
  if (!run) throw new Error('Writer v2 run không tồn tại');
  if (run.status !== 'DONE') {
    throw new Error(`Chỉ restyle được run đã DONE (hiện: ${run.status}/${run.phase})`);
  }
  if (!run.finalScript) {
    throw new Error('Run này không có finalScript để restyle');
  }
  if (run.restyling) {
    throw new Error(
      `Run đang restyle v${run.restyling.version} theo "${run.restyling.styleId}"; chờ turn đó settle trước`,
    );
  }
  const style = await getChannelStyle(styleId, deps.dataDir);
  if (!style) throw new Error(`Channel style không tồn tại: ${styleId}`);

  const version = (run.styled?.length ?? 0) + 1;
  run.restyling = { version, styleId: style.path, startedAt: new Date().toISOString() };
  run.restyleError = undefined;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);

  await dispatchRestyle(deps, run, style, version);
  return (await getWriterRunV2(run.id, deps.dataDir)) ?? run;
}

async function dispatchRestyle(
  deps: WriterV2Deps,
  run: WriterRunV2,
  style: { path: string; title: string; hash: string; markdown: string },
  version: number,
): Promise<void> {
  const source = run.finalScript;
  if (!source) throw new Error('[writer-v2] dispatchRestyle called without a finalScript');
  const pack = await getWriterPack(run.packId, deps.dataDir);
  const forbiddenNames = pack
    ? forbiddenHostNames({ channelTitle: pack.channelTitle, title: pack.title })
    : [];
  const wordRange = wordRangeFor(run);
  const factsLedger = run.study?.factsLedger ?? [];

  // Compact envelope only. Both pieces of prose are staged as ordinary Markdown
  // beside it — a JSON string field would escape every newline into one enormous
  // physical line that agent Read tools cannot paginate.
  const envelope = {
    contract: {
      role: 'Writer v2 — RESTYLE stage',
      instruction: 'same argument, same facts, different voice',
    },
    factsLedger,
    packTitle: run.packTitle,
    wordRange,
    forbiddenHostNames: forbiddenNames,
    sourceFile: 'input/source.md',
    styleFile: 'input/style.md',
  };

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: WRITER_V2_ITEM_ID,
    stage: RESTYLE_STAGE,
    // `attempt` is the styled-version number: it is part of the turn key, so
    // version 2 can never re-attach to version 1's turn.
    attempt: version,
    templateId: run.agentId,
    promptMarkdown: buildRestylePrompt({
      styleTitle: style.title,
      wordRange,
      ledgerCount: factsLedger.length,
      forbiddenNames,
    }),
    envelope,
    inputFiles: [
      { path: 'source.md', content: source },
      { path: 'style.md', content: style.markdown },
    ],
    inputHashes: [envelopeHash(envelope), contentHash(source), style.hash],
    promptVersion: RESTYLE_PROMPT_VERSION,
    sessionGroup: RESTYLE_PTY_SESSION_GROUP,
    interactivePty: true,
    // The author pane of the original run may have died days ago, and its CLI
    // context is about writing the piece, not restyling it.
    freshContext: true,
    validateContent: (parsed) => {
      const v = validateRestyleOutput(parsed, { wordRange, forbiddenNames });
      return v.ok ? { ok: true as const } : { ok: false as const, errorCode: v.errorCode, reason: v.reason };
    },
  });

  if (dispatch.status !== 'RUNNING') {
    await recordRestyleError(
      deps.dataDir,
      run,
      dispatch.reason ?? 'RESTYLE_DISPATCH_FAILED',
      `Không dispatch được restyle v${version} (${dispatch.status})`,
    );
  }
}

/**
 * The restyle settle path, deliberately separate from `registerWriterV2SettleListener`.
 *
 * Restyle always settles on a run whose status is `DONE`, and the main handler
 * returns early on anything that is not `RUNNING` — so sharing that listener would
 * mean either dropping every restyle result or weakening the guard that keeps a
 * finished run finished.
 */
export function registerWriterV2RestyleListener(
  scheduler: LaneScheduler,
  deps: { dataDir: string },
): () => void {
  return scheduler.onItemSettled((event) => {
    if (event.stage !== RESTYLE_STAGE) return;
    void handleRestyleSettle(deps.dataDir, event).catch((err) => {
      console.error('[writer-v2] restyle settle failed:', (err as Error).message);
    });
  });
}

async function handleRestyleSettle(dataDir: string, event: ItemSettledResult): Promise<void> {
  const run = await getWriterRunV2(event.batchId, dataDir);
  if (!run) return;
  // A settle for a restyle nobody is waiting for (stale listener, restarted daemon,
  // an event for an older version) is ignored rather than recorded.
  if (!run.restyling || run.restyling.version !== event.attempt) return;
  const version = run.restyling.version;
  const styleId = run.restyling.styleId;

  if (event.outcome !== 'COMMITTED' || !event.artifactHash) {
    await recordRestyleError(
      dataDir,
      run,
      event.errorCode ?? 'RESTYLE_FAILED',
      event.errorReason ?? `restyle v${version} không hoàn tất`,
    );
    return;
  }

  const parsed = await readCommittedArtifact<unknown>(dataDir, event);
  const validated = await validateRestyleForRun(dataDir, run, parsed);
  if (!validated.ok) {
    await recordRestyleError(dataDir, run, validated.errorCode, validated.reason);
    return;
  }

  // `status` and `finalScript` are untouched inside `commitStyledVersion` on purpose —
  // the styled file is an addition to a finished run, never a replacement for what the
  // gate approved.
  await commitStyledVersion(dataDir, run, {
    version,
    styleId,
    title: validated.title,
    script: validated.script,
  });
}

/**
 * Boot recovery for restyles that were in flight when the daemon went down.
 *
 * `reconcileOnBoot` (`pipeline/lane-scheduler.ts`) marks every non-terminal ledger row
 * INTERRUPTED but never fires `onItemSettled`, and `registerWriterV2RestyleListener`
 * only ever reacts to that event — so a run whose restyle was live across a restart
 * would keep `run.restyling` forever and the UI would show "đang restyle" with nothing
 * behind it. Worse, the agent often DID finish and left a perfectly good
 * `out/result.json` on disk that nobody would ever pick up. Same failure and same
 * fallback as `recoverStudioSynthesizeFromDisk` in `training/studio-synthesize.ts`.
 *
 * Two outcomes per stuck run, and only two:
 *  - `out/result.json` reads, parses and validates → committed exactly as a live settle
 *    would have committed it.
 *  - anything else (absent, torn, invalid JSON, out of band, identity leak) →
 *    `restyleError = { code: 'RESTYLE_INTERRUPTED', … }` so a human sees why and can
 *    press Restyle again.
 *
 * In BOTH outcomes `run.status`, `run.phase` and `run.finalScript` are left exactly as
 * they were. A restyle is a side operation on an already-finished run; a daemon crash
 * during one must never be able to change the verdict the gate reached.
 *
 * Fire-and-forget at boot: one bad run must not stop the rest, so every run is wrapped
 * on its own and a failure is logged and stepped over.
 */
export async function recoverInterruptedRestyles(dataDir: string): Promise<void> {
  const summaries = await listWriterRunsV2(dataDir);
  for (const summary of summaries) {
    try {
      const run = await getWriterRunV2(summary.id, dataDir);
      if (!run?.restyling) continue;
      const { version, styleId } = run.restyling;

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(restyleOutResultPath(dataDir, run.id, version), 'utf8'));
      } catch (err) {
        await recordRestyleError(
          dataDir,
          run,
          'RESTYLE_INTERRUPTED',
          `Restyle v${version} bị ngắt (daemon restart) và không đọc được out/result.json: ${(err as Error).message}`,
        );
        continue;
      }

      const validated = await validateRestyleForRun(dataDir, run, parsed);
      if (!validated.ok) {
        await recordRestyleError(
          dataDir,
          run,
          'RESTYLE_INTERRUPTED',
          `Restyle v${version} bị ngắt (daemon restart); out/result.json có nhưng không hợp lệ (${validated.errorCode}): ${validated.reason}`,
        );
        continue;
      }

      await commitStyledVersion(dataDir, run, {
        version,
        styleId,
        title: validated.title,
        script: validated.script,
      });
      console.log(`[writer-v2] cứu được restyle v${version} của run ${run.id} sau khi daemon restart`);
    } catch (err) {
      console.error(
        `[writer-v2] recoverInterruptedRestyles bỏ qua run ${summary.id}:`,
        (err as Error).message,
      );
    }
  }
}

/** Read one styled version's markdown back, for a route. `null` when absent. */
export async function readStyledVersion(
  runId: string,
  version: number,
  dataDir: string,
): Promise<string | null> {
  // Both segments are joined into a filesystem path, so both are checked here
  // rather than trusting whatever a route parsed out of a URL.
  if (!Number.isInteger(version) || version < 1) return null;
  if (!runId || runId.includes('/') || runId.includes('\\') || runId.includes('..')) return null;
  try {
    return await readFile(join(writerRoot(dataDir), 'styled', runId, `v${version}.md`), 'utf8');
  } catch {
    return null;
  }
}
