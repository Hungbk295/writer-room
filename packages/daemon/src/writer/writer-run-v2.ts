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
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
} from './deterministic-gate.ts';
import { getChannelStyle } from './channel-style.ts';
import {
  appendEditorialSuggestions,
  getChannelProfile,
  getEditorialNotebook,
  type LessonKind,
} from './channel-profile.ts';
import { getGeneralPack } from './general-pack.ts';
import { clearHookState } from './hook-board.ts';
import { getApprovedPersonaPack, type PersonaPack } from './persona-pack.ts';
import { getReusableProcedure } from './reusable-procedure.ts';
import type { HookCandidate, HookClarify, SelectedHook } from './hook-doi-thu.ts';
import { deleteWriterRunV2, getWriterRunV2, listWriterRunsV2, saveWriterRunV2 } from './run-store-v2.ts';
import { countScriptWords, findIdentityLeak, forbiddenHostNames, targetWordRange } from './script-checks.ts';
import {
  dispatchLegacyStudy,
  packVideoIds,
  STUDY_STAGE,
  validateStudyArtifact,
  type StudyArtifact,
} from './study-orchestrator.ts';
import type { WriterVideoPlan } from './video-plan.ts';

export { DEFAULT_AGENT_IDS, type DefaultAgentId };
export {
  packVideoIds,
  splitExactSourceParts,
  STUDY_STAGE,
  validateStudyArtifact,
} from './study-orchestrator.ts';
export type { StudyArtifact, StudyCoverageEntry } from './study-orchestrator.ts';

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
/** Human-triggered side operation on a DONE article. It proposes durable lessons;
 * it never edits the channel notebook directly. */
export const POSTMORTEM_STAGE = 'writer-postmortem-v1';

/**
 * Writer v2 is deliberately a live, human-observable PTY workflow. The author
 * keeps one writable pane from STUDY through WRITE/REPAIR; the editor receives
 * a distinct pane so a review is never accidentally delivered to the writer's
 * session, even when the operator selected the same base agent for both roles.
 */
const AUTHOR_PTY_SESSION_GROUP = 'writer-v2-author';
const EDITOR_PTY_SESSION_GROUP = 'writer-v2-editor';
const RESTYLE_PTY_SESSION_GROUP = 'writer-v2-restyle';
const POSTMORTEM_PTY_SESSION_GROUP = 'writer-v2-postmortem';

const WRITE_PROMPT_VERSION = 'writer-v2-write-v3-exact-length-hook-v1';
const EDIT_REVIEW_PROMPT_VERSION = 'writer-v2-edit-review-v2-hook-v1';
const REPAIR_PROMPT_VERSION = 'writer-v2-repair-v1';
const RESTYLE_PROMPT_VERSION = 'writer-v2-restyle-v1';
const POSTMORTEM_PROMPT_VERSION = 'writer-v2-postmortem-v1';

/** The one item id every stage of a v2 run uses (one run = one piece). */
export const WRITER_V2_ITEM_ID = 'piece';

/** Absolute default band (plan §0): a script, not a slice of the source's length. */
export const DEFAULT_WORD_RANGE = { minWords: 800, maxWords: 1500 } as const;

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

export interface PostmortemLesson {
  kind: LessonKind;
  text: string;
  reason: string;
}

export interface WriterPostmortem {
  lessons: PostmortemLesson[];
  agentId: DefaultAgentId;
  createdAt: string;
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
  | 'CONFIGURING'
  | 'READY'
  | 'STUDY'
  | 'WRITE'
  | 'GATE'
  | 'EDIT_REVIEW'
  | 'REPAIR'
  | 'DONE'
  | 'FAILED';

export interface WriterRunV2 {
  id: string;
  /** DRAFT means the human has prepared and pinned a room, but no agent/lane was used. */
  status: 'DRAFT' | 'RUNNING' | 'DONE' | 'FAILED' | 'FAILED_GATE';
  phase: WriterV2Phase;
  brief: string;
  requestedTitle?: string;
  targetWords?: number;
  /** Who this channel talks to — stated, because STUDY picks a gap against it. */
  audience?: string;
  /** Publishing-channel identity. Optional only so pre-feature run JSON remains readable. */
  channelId?: string;
  /** Human-authored channel notebook pin. Injected into WRITE, never STUDY. */
  editorialPath?: string;
  editorialHash?: string;
  /** Optional native SKILL.md chosen by the channel profile and pinned for WRITE. */
  procedureId?: string;
  procedureHash?: string;
  /** Topic pack — the ONLY source of facts. Required. */
  packId: string;
  packTitle: string;
  /** Pinned topic-pack content hash. Blank only for legacy/configuring drafts. */
  packHash?: string;
  /** e.g. `hieu-tv.md`, relative to the general-packs root. Required. */
  generalPackPath: string;
  generalPackHash: string;
  generalPackVersion: number | null;
  /** Content hash of `writer/persona-pack.md`, pinned at WRITE dispatch time —
   * only when the file exists. Optional so every run written before persona
   * packs existed still reads back unchanged; a `null`/undefined value means
   * "this run's WRITE stage ran without a persona pack", not "unknown". */
  personaPackHash?: string;
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
  /** A DONE-side operation: agent suggestions remain proposals until the owner approves them. */
  reviewingPostmortem?: { attempt: number; startedAt: string };
  postmortemAttempt?: number;
  postmortem?: WriterPostmortem;
  postmortemError?: { code: string; reason: string; at: string };
  /**
   * Pre-write hook loop. Optional on every run written before this existed.
   * Status stays DRAFT while any of these are in flight.
   */
  generatingHook?: { step: 'clarify' | 'suggest'; attempt: number; startedAt: string };
  hookTurnAttempt?: number;
  hookClarify?: HookClarify;
  hookCandidates?: HookCandidate[];
  selectedHook?: SelectedHook;
  hookLibraryHash?: string;
  hookError?: { code: string; reason: string; at: string };
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

/** Director-board role pill: who (if anyone) owns the live turn. */
export type WriterV2ActiveRoleKind = 'author' | 'critic' | 'gate' | 'none';

export interface WriterV2ActiveRole {
  kind: WriterV2ActiveRoleKind;
  /** e.g. `Author: codex`, `Critic: claude`, `Gate`, or `—`. */
  label: string;
  agentId?: string;
}

export interface WriterV2ProgressView {
  /** Weighted overall percent in 0–100 (see `computeWriterV2Progress`). */
  progressPercent: number;
  activeRole: WriterV2ActiveRole;
}

/**
 * Weighted phase progress (Director Board pattern).
 *
 * Ranges:
 *   0–10 CONFIGURING/READY · 10–35 STUDY · 35–70 WRITE ·
 *   70–80 GATE · 80–95 EDIT_REVIEW/REPAIR · 95–100 DONE
 */
export function computeWriterV2Progress(
  run: Pick<
    WriterRunV2,
    | 'status'
    | 'phase'
    | 'agentId'
    | 'editorAgentId'
    | 'study'
    | 'draft'
    | 'gateResults'
    | 'editorDefects'
    | 'restyling'
  >,
): WriterV2ProgressView {
  const author = (agentId: string): WriterV2ActiveRole => ({
    kind: 'author',
    label: `Author: ${agentId}`,
    agentId,
  });
  const critic = (agentId: string): WriterV2ActiveRole => ({
    kind: 'critic',
    label: `Critic: ${agentId}`,
    agentId,
  });
  const gateRole: WriterV2ActiveRole = { kind: 'gate', label: 'Gate' };
  const none: WriterV2ActiveRole = { kind: 'none', label: '—' };

  if (run.restyling) {
    return { progressPercent: 97, activeRole: author(run.agentId) };
  }

  let progressPercent: number;
  switch (run.phase) {
    case 'CONFIGURING':
      progressPercent = 5;
      break;
    case 'READY':
      progressPercent = 10;
      break;
    case 'STUDY':
      progressPercent = 22;
      break;
    case 'WRITE':
      progressPercent = 52;
      break;
    case 'GATE':
      progressPercent = 75;
      break;
    case 'EDIT_REVIEW':
      progressPercent = 85;
      break;
    case 'REPAIR':
      progressPercent = 90;
      break;
    case 'DONE':
      progressPercent = 100;
      break;
    case 'FAILED':
      if (!run.study) progressPercent = 15;
      else if (!run.draft) progressPercent = 40;
      else if ((run.editorDefects?.length ?? 0) > 0) progressPercent = 88;
      else if ((run.gateResults.at(-1)?.violations.length ?? 0) > 0) progressPercent = 75;
      else progressPercent = 50;
      break;
    default:
      progressPercent = 0;
  }

  if (run.status === 'FAILED_GATE') progressPercent = 75;
  if (run.status === 'DONE' && run.phase === 'DONE') progressPercent = 100;

  let activeRole: WriterV2ActiveRole = none;
  if (run.status === 'RUNNING') {
    switch (run.phase) {
      case 'STUDY':
      case 'WRITE':
      case 'REPAIR':
        activeRole = author(run.agentId);
        break;
      case 'EDIT_REVIEW':
        activeRole = critic(run.editorAgentId);
        break;
      case 'GATE':
        activeRole = gateRole;
        break;
      default:
        activeRole = none;
    }
  }

  return { progressPercent, activeRole };
}

/** Attach progress fields for API responses without persisting them. */
export function withWriterV2Progress<T extends WriterRunV2>(
  run: T,
): T & WriterV2ProgressView {
  return { ...run, ...computeWriterV2Progress(run) };
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

function wordRangeFor(run: Pick<WriterRunV2, 'targetWords'>): { minWords: number; maxWords: number } {
  return run.targetWords !== undefined
    ? targetWordRange(run.targetWords)
    : { ...DEFAULT_WORD_RANGE };
}

// ── Validators ────────────────────────────────────────────────────────────

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

function buildWritePrompt(opts: {
  title: string;
  brief: string;
  audience: string;
  beatCount: number;
  ledgerCount: number;
  wordRange: { minWords: number; maxWords: number };
  forbiddenNames: string[];
  generalPackPath: string;
  editorialPath?: string;
  procedurePath?: string;
  personaPackPath?: string;
  selectedHook?: SelectedHook;
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
    ...(opts.selectedHook
      ? [
          '## Selected opening hook (human-picked — open with this)',
          `Type: ${opts.selectedHook.typeLabel} (\`${opts.selectedHook.type}\`)`,
          opts.selectedHook.text,
          'The first sentences must be this opening (you may smooth wording). Do not paste',
          'placeholders like `[X]%` or `[N] năm` into the script — replace them with a',
          'ledger figure or drop the number. Say in `outlineChanges` whether you kept the',
          'hook or adjusted it for sourced figures.',
          '',
        ]
      : []),
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
    ...(opts.personaPackPath
      ? [`- **Persona pack** (\`${opts.personaPackPath}\`): WHO the narrator is — see below.`]
      : []),
    ...(opts.editorialPath
      ? [
          `- **Sổ tay biên tập** (\`${opts.editorialPath}\`, staged at \`input/editorial.md\`):`,
          '  the durable decisions of THIS publishing channel — audience, priorities, refusals',
          '  and lessons approved from earlier articles. Follow it, but never use it as a fact source.',
        ]
      : []),
    ...(opts.procedurePath
      ? [
          `- **Quy trình dùng lại** (\`${opts.procedurePath}\`, staged at \`input/procedure.md\`):`,
          '  the approved working procedure for this channel. Apply its steps where they do not',
          '  conflict with the facts ledger or hard rules below.',
        ]
      : []),
    '- **factsLedger**: the ONLY facts you may state. Every number, name, place, study or',
    '  case in your script must trace to an entry here.',
    '- **outline**: the compression contract. Follow the beats; do not print field names.',
    '',
    ...(opts.personaPackPath
      ? [
          '## Persona pack',
          '',
          `Read the WHOLE persona pack at \`input/persona-pack.md\` (\`${opts.personaPackPath}\`).`,
          "It is the narrator's fixed identity — a stance registry (this channel's official",
          'position on recurring money questions) plus a bank of adapted personal experiences.',
          '',
          '- Any personal opinion, life experience, acquaintance or anecdote in the script must',
          '  trace to this file — pulled from it, not invented. If the brief calls for personal',
          '  color the persona pack does not cover, leave it out rather than making it up.',
          '- The stance registry is this channel\'s official position. Do not contradict it —',
          '  if the persona pack says the emergency fund is 1 year, do not write "3 months".',
          '- Adapt archetypes in your own words; do not paste them verbatim.',
          '',
        ]
      : []),
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

function buildPostmortemPrompt(): string {
  return [
    '# Tổng kết sau bài — đề xuất, không tự sửa sổ tay',
    '',
    'Đọc toàn bộ `input/article.md`, `input/editorial.md` và metadata trong',
    '`input/envelope.json`. Rút ra 1–3 kinh nghiệm BỀN VỮNG cho lần viết sau của',
    'chính kênh này.',
    '',
    'Chỉ đề xuất điều có thể tái dùng:',
    '- KEEP: một cách làm đã hiệu quả và nên giữ;',
    '- AVOID: một lỗi hoặc thói quen nên tránh;',
    '- TRY: một thử nghiệm cụ thể đáng làm ở bài sau.',
    '',
    'Không chép lại dữ kiện/chủ đề riêng của bài. Không lặp điều đã có trong sổ tay.',
    'Không đề xuất chung chung kiểu “viết hấp dẫn hơn”. Mỗi đề xuất phải là một chỉ dẫn',
    'có thể hành động và `reason` phải chỉ ra tín hiệu trong run khiến bạn kết luận vậy.',
    'Đây chỉ là hộp chờ: người viết sẽ duyệt sau.',
    '',
    'Write JSON to `out/result.json`:',
    '',
    '```json',
    '{ "lessons": [',
    '  { "kind": "KEEP", "text": "...", "reason": "..." }',
    '] }',
    '```',
  ].join('\n');
}

export function validatePostmortem(
  parsed: unknown,
): { ok: true; lessons: PostmortemLesson[] } | { ok: false; errorCode: string; reason: string } {
  const value = parsed as { lessons?: unknown } | null;
  if (!value || typeof value !== 'object' || !Array.isArray(value.lessons)) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'lessons phải là một mảng' };
  }
  if (value.lessons.length < 1 || value.lessons.length > 3) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'lessons cần 1–3 phần tử' };
  }
  const lessons: PostmortemLesson[] = [];
  for (const [index, raw] of value.lessons.entries()) {
    const lesson = raw as Partial<PostmortemLesson> | null;
    const text = typeof lesson?.text === 'string' ? lesson.text.replace(/\s+/g, ' ').trim() : '';
    const reason = typeof lesson?.reason === 'string' ? lesson.reason.replace(/\s+/g, ' ').trim() : '';
    if (lesson?.kind !== 'KEEP' && lesson?.kind !== 'AVOID' && lesson?.kind !== 'TRY') {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `lessons[${index}].kind phải là KEEP/AVOID/TRY` };
    }
    if (text.length < 15 || text.length > 500 || reason.length < 10 || reason.length > 800) {
      return {
        ok: false,
        errorCode: 'AGENT_SCHEMA',
        reason: `lessons[${index}] cần text 15–500 ký tự và reason 10–800 ký tự`,
      };
    }
    lessons.push({ kind: lesson.kind, text, reason });
  }
  return { ok: true, lessons };
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

function buildEditReviewPrompt(opts: {
  hasGateViolations: boolean;
  selectedHook?: SelectedHook;
}): string {
  const hookDebt = opts.selectedHook
    ? `4. Does the ending pay the debt this opening planted — "${opts.selectedHook.text}"? Same number, question or image, not a different one.`
    : '4. Does the ending pay the debt the hook created — the same number, question or image?';
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
    hookDebt,
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

/** Rule 1's wording branches on whether this run has a persona pack — a fourth
 * valid fix (tracing to it) only exists when there is one to trace to. */
function repairRuleOneLines(hasPersona: boolean): string[] {
  const groundingNoun = hasPersona ? '`factsLedger` or the persona pack' : '`factsLedger`';
  const fixCount = hasPersona ? 'Four' : 'Three';
  const personaFix = hasPersona
    ? ' A fourth: trace it verbatim to the persona pack (the channel\'s own approved'
      + ' stance/experience), if it is genuinely there.'
    : '';
  const sourceNoun = hasPersona ? 'ledger/persona pack' : 'ledger';
  return [
    `1. Every number/name/case must still trace to ${groundingNoun}. ${fixCount} valid fixes for an`,
    '   unsourced number: delete it, mark its sentence as openly hypothetical ("giả sử…"),',
    '   or — if it is genuinely common knowledge (an everyday time span, a canonical',
    '   fraction, a widely-known convention) — attribute it in the prose ("chuyên gia',
    `   thường khuyên…", "thông thường…").${personaFix} Inventing a source is not a fix.`,
    '   Money, ages, "N lần" and years never qualify as common knowledge; those must come',
    `   from the ${sourceNoun} or go.`,
  ];
}

function buildRepairPrompt(opts: {
  beatCount: number;
  wordRange: { minWords: number; maxWords: number };
  forbiddenNames: string[];
  gateViolations: string;
  defectCount: number;
  hasPersona: boolean;
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
    ...repairRuleOneLines(opts.hasPersona),
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
  input: WriterV2RoomInput,
): Promise<WriterRunV2> {
  const room = await createWriterRoomV2(deps, input);
  // One-shot API / tests skip the human hook loop. The Writer post UI never
  // calls this; `runWriterRoomV2` still requires a selected hook.
  if (!room.selectedHook) {
    const text = (room.requestedTitle ?? room.brief).trim();
    room.selectedHook = {
      id: 'start-run',
      type: 'direct-question',
      typeLabel: 'Câu hỏi trực diện',
      text,
    };
    room.updatedAt = new Date().toISOString();
    await saveWriterRunV2(room, deps.dataDir);
  }
  return runWriterRoomV2(deps, room.id);
}

/** Create the durable post shell only. No dependency lookup, lane or provider. */
export async function createWriterPostV2(deps: WriterV2Deps): Promise<WriterRunV2> {
  const now = new Date().toISOString();
  const post: WriterRunV2 = {
    id: randomUUID(),
    status: 'DRAFT',
    phase: 'CONFIGURING',
    brief: '',
    packId: '',
    packTitle: '',
    generalPackPath: '',
    generalPackHash: '',
    generalPackVersion: null,
    formulaId: '',
    formulaVersion: 0,
    formulaHash: '',
    agentId: 'codex',
    editorAgentId: 'claude',
    study: null,
    draft: null,
    gateResults: [],
    editorDefects: null,
    finalScript: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveWriterRunV2(post, deps.dataDir);
  return post;
}

/** The user-facing preflight contract: it resolves and pins every dependency,
 * but deliberately does not create a clone or call `requestTurn`. */
export interface WriterV2RoomInput {
    channelId: string;
    brief: string;
    title?: string;
    audience?: string;
    targetWords?: number;
    packId: string;
    generalPack: string;
    formulaId: string;
    agentId?: DefaultAgentId;
    editorAgentId?: DefaultAgentId;
}

export interface WriterV2PostConfigInput {
  channelId: string;
  brief: string;
  title?: string;
  audience?: string;
  targetWords?: number;
  packId: string;
  generalPack: string;
  formulaId: string;
  agentId: DefaultAgentId;
  editorAgentId: DefaultAgentId;
}

export function pinWriterPackHash(pack: WriterPack): string {
  return createHash('sha256').update(pack.markdown).digest('hex');
}

/** Replace a DRAFT post's saved configuration. This is persistence-only. */
export async function updateWriterPostV2(
  deps: WriterV2Deps,
  postId: string,
  input: WriterV2PostConfigInput,
): Promise<WriterRunV2> {
  const post = await getWriterRunV2(postId, deps.dataDir);
  if (!post) throw new Error('Writer v2 post không tồn tại');
  if (post.status !== 'DRAFT') {
    throw new Error(`Chỉ cập nhật được post DRAFT (hiện: ${post.status})`);
  }
  if (input.agentId === input.editorAgentId) {
    throw new Error('writer agent và editor agent phải khác nhau');
  }

  const channelId = input.channelId.trim();
  const channel = channelId ? await getChannelProfile(channelId, deps.dataDir) : null;
  if (!channel) throw new Error('Hồ sơ kênh không tồn tại hoặc channelId chưa được chọn');
  const brief = input.brief.trim();
  const packId = input.packId.trim();
  const generalPackPath = input.generalPack.trim() || channel.defaultGeneralPack || '';
  const formulaId = input.formulaId.trim() || channel.defaultFormulaId || '';
  let targetWords: number | undefined;
  if (input.targetWords !== undefined && input.targetWords !== null) {
    const n = Number(input.targetWords);
    if (!Number.isFinite(n) || n < 200) throw new Error('targetWords phải ≥ 200 (số từ)');
    if (n > 20_000) throw new Error('targetWords quá lớn (max 20000)');
    targetWords = Math.round(n);
  }

  const pack = packId ? await getWriterPack(packId, deps.dataDir) : null;
  if (packId && !pack) throw new Error('Source Pack không tồn tại');
  const generalPack = generalPackPath ? await getGeneralPack(generalPackPath, deps.dataDir) : null;
  if (generalPackPath && !generalPack) throw new Error(`General pack không tồn tại: ${generalPackPath}`);
  const formula = formulaId ? await getFormula(formulaId, deps.dataDir) : null;
  if (formulaId && !formula) throw new Error('Formula không tồn tại');
  const normalized = formula ? normalizeFormula(formula) : null;
  const editorial = await getEditorialNotebook(channelId, deps.dataDir);
  if (!editorial) throw new Error('Không đọc được sổ tay biên tập của kênh');
  const procedure = channel.defaultProcedure
    ? await getReusableProcedure(channel.defaultProcedure, deps.dataDir)
    : null;
  if (channel.defaultProcedure && !procedure) {
    throw new Error(`Quy trình mặc định không tồn tại: ${channel.defaultProcedure}`);
  }

  const previousTitle = (post.requestedTitle ?? '').trim();
  post.channelId = channelId;
  post.editorialPath = editorial.path;
  post.editorialHash = editorial.hash;
  if (procedure) {
    post.procedureId = procedure.id;
    post.procedureHash = procedure.hash;
  } else {
    delete post.procedureId;
    delete post.procedureHash;
  }
  post.brief = brief;
  const requestedTitle = input.title?.trim();
  if (requestedTitle) post.requestedTitle = requestedTitle;
  else delete post.requestedTitle;
  const audience = input.audience?.trim() || channel.audience;
  if (audience) post.audience = audience;
  else delete post.audience;
  if (targetWords !== undefined) post.targetWords = targetWords;
  else delete post.targetWords;
  post.packId = pack?.id ?? '';
  post.packTitle = pack ? (pack.title || pack.channelTitle || 'Source Pack') : '';
  if (pack) post.packHash = pinWriterPackHash(pack);
  else delete post.packHash;
  post.generalPackPath = generalPack?.path ?? '';
  post.generalPackHash = generalPack?.hash ?? '';
  post.generalPackVersion = generalPack?.version ?? null;
  post.formulaId = normalized?.id ?? '';
  post.formulaVersion = normalized?.version ?? 0;
  post.formulaHash = formula ? pinFormulaHash(formula) : '';
  post.agentId = input.agentId;
  post.editorAgentId = input.editorAgentId;
  post.phase = requestedTitle && brief && pack && generalPack && formula && editorial ? 'READY' : 'CONFIGURING';
  // Title is the input the hook loop was generated against. Changing it
  // silently keeping an old selection would open the wrong video.
  if (previousTitle !== (requestedTitle ?? '')) {
    clearHookState(post);
  }
  post.updatedAt = new Date().toISOString();
  await saveWriterRunV2(post, deps.dataDir);
  return post;
}

export async function createWriterRoomV2(
  deps: WriterV2Deps,
  input: WriterV2RoomInput,
): Promise<WriterRunV2> {
  const agentId: DefaultAgentId =
    input.agentId && (DEFAULT_AGENT_IDS as readonly string[]).includes(input.agentId)
      ? input.agentId
      : 'codex';
  const editorAgentId: DefaultAgentId =
    input.editorAgentId && (DEFAULT_AGENT_IDS as readonly string[]).includes(input.editorAgentId)
      ? input.editorAgentId
      : defaultEditorAgent(agentId);
  const post = await createWriterPostV2(deps);
  try {
    return await updateWriterPostV2(deps, post.id, {
      channelId: input.channelId,
      brief: input.brief,
      title: input.title ?? input.brief,
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      ...(input.targetWords !== undefined ? { targetWords: input.targetWords } : {}),
      packId: input.packId,
      generalPack: input.generalPack,
      formulaId: input.formulaId,
      agentId,
      editorAgentId,
    });
  } catch (err) {
    // This shell was created inside this helper and has never been returned to a
    // caller. Remove it so an invalid legacy /runs or /rooms request cannot leave
    // a ghost post behind in the user's list.
    await deleteWriterRunV2(post.id, deps.dataDir);
    throw err;
  }
}

/** Start exactly one reviewed room. A DRAFT is idempotently protected from
 * accidental background execution: only this explicit transition may dispatch. */
export async function runWriterRoomV2(deps: WriterV2Deps, runId: string): Promise<WriterRunV2> {
  const run = await getWriterRunV2(runId, deps.dataDir);
  if (!run) throw new Error('Writer v2 room không tồn tại');
  if (run.status !== 'DRAFT' || run.phase !== 'READY') {
    throw new Error(`Chỉ chạy được room DRAFT/READY (hiện: ${run.status}/${run.phase})`);
  }
  const pack = await getWriterPack(run.packId, deps.dataDir);
  if (!pack) throw new Error('Source Pack của room không còn tồn tại');
  if (!run.requestedTitle?.trim() || !run.brief.trim() || !run.packId || !run.generalPackPath || !run.formulaId) {
    throw new Error('Writer v2 post chưa đủ cấu hình để Run');
  }
  if (!run.channelId) throw new Error('Chưa chọn Hồ sơ kênh cho bài viết');
  const channel = await getChannelProfile(run.channelId, deps.dataDir);
  if (!channel) throw new Error('Hồ sơ kênh của bài viết không còn tồn tại');
  const editorial = await getEditorialNotebook(run.channelId, deps.dataDir);
  if (!editorial || editorial.hash !== run.editorialHash) {
    throw new Error('Sổ tay biên tập đã thay đổi sau khi Save; hãy Update configuration để pin lại');
  }
  if (run.procedureId) {
    const procedure = await getReusableProcedure(run.procedureId, deps.dataDir);
    if (!procedure || procedure.hash !== run.procedureHash) {
      throw new Error('Quy trình dùng lại đã thay đổi sau khi Save; hãy Update configuration để pin lại');
    }
  }
  if (run.agentId === run.editorAgentId) {
    throw new Error('writer agent và editor agent phải khác nhau');
  }
  if (!run.selectedHook?.text.trim()) {
    throw new Error('Chưa chọn hook — làm rõ title và chọn một hook trước khi Run');
  }
  if (run.generatingHook) {
    throw new Error('Đang gợi ý hook; chờ xong rồi Run');
  }
  if (!run.packHash || pinWriterPackHash(pack) !== run.packHash) {
    throw new Error('Source Pack đã thay đổi sau khi Save; hãy Update configuration để pin lại');
  }
  const generalPack = await getGeneralPack(run.generalPackPath, deps.dataDir);
  if (!generalPack || generalPack.hash !== run.generalPackHash) {
    throw new Error('General Pack đã thay đổi sau khi Save; hãy Update configuration để pin lại');
  }
  const formula = await getFormula(run.formulaId, deps.dataDir);
  if (!formula) throw new Error('Formula của room không còn tồn tại');
  if (pinFormulaHash(formula) !== run.formulaHash) {
    throw new Error('Formula đã thay đổi sau khi Save; hãy Update configuration để pin lại');
  }

  run.status = 'RUNNING';
  run.phase = 'STUDY';
  run.updatedAt = new Date().toISOString();
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
  options: { attempt?: number; freshContext?: boolean } = {},
): Promise<void> {
  const dispatch = await dispatchLegacyStudy({
    scheduler: deps.scheduler,
    batchId: run.id,
    itemId: WRITER_V2_ITEM_ID,
    templateId: run.agentId,
    sessionGroup: AUTHOR_PTY_SESSION_GROUP,
    title: run.requestedTitle ?? run.brief,
    brief: run.brief,
    audience: run.audience ?? DEFAULT_AUDIENCE,
    packTitle: run.packTitle,
    ...(run.selectedHook ? { selectedHook: run.selectedHook } : {}),
    pack,
    formula: formulaContractView(formula),
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(options.freshContext !== undefined ? { freshContext: options.freshContext } : {}),
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
  // `getGeneralPack` now throws on a non-ENOENT read failure instead of flattening
  // it into `null` (CEO review 2026-09-03). That throw must not escape: this
  // function runs inside the settle listener, whose only handler is a
  // `console.error`, so an uncaught error here would leave the run RUNNING
  // forever. Same shape as the persona guard just below.
  let generalPack: Awaited<ReturnType<typeof getGeneralPack>>;
  try {
    generalPack = await getGeneralPack(run.generalPackPath, deps.dataDir);
  } catch (err) {
    await failRun(
      deps,
      run,
      'GENERAL_PACK_UNREADABLE',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  const formula = await getFormula(run.formulaId, deps.dataDir);
  const editorial = run.channelId ? await getEditorialNotebook(run.channelId, deps.dataDir) : null;
  const procedure = run.procedureId ? await getReusableProcedure(run.procedureId, deps.dataDir) : null;
  // Optional and independent of the required packs above: absent is a normal,
  // fully-supported state (pipeline runs exactly as it did before persona packs).
  // `getApprovedPersonaPack` also collapses "file has zero APPROVED entries"
  // into that same absent state — see its doc comment.
  let personaPack: PersonaPack | null;
  try {
    personaPack = await getApprovedPersonaPack(deps.dataDir);
  } catch (err) {
    await failRun(
      deps,
      run,
      'PERSONA_PACK_UNREADABLE',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
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
  if (run.channelId && (!editorial || editorial.hash !== run.editorialHash)) {
    await failRun(
      deps,
      run,
      'EDITORIAL_CHANGED',
      `Sổ tay biên tập của kênh "${run.channelId}" đã bị sửa sau khi run bắt đầu. Tạo run mới để dùng bản mới.`,
    );
    return;
  }
  if (run.procedureId && (!procedure || procedure.hash !== run.procedureHash)) {
    await failRun(
      deps,
      run,
      'PROCEDURE_CHANGED',
      `Quy trình "${run.procedureId}" đã bị sửa sau khi run bắt đầu. Tạo run mới để dùng bản mới.`,
    );
    return;
  }

  // Pinned like generalPackHash, but nothing fails if it changes mid-run — a
  // persona pack is optional identity material, not a required contract.
  run.personaPackHash = personaPack?.hash;
  await saveWriterRunV2(run, deps.dataDir);

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
    ...(run.selectedHook ? { selectedHook: run.selectedHook } : {}),
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
    ...(editorial
      ? {
          editorial: {
            channelId: run.channelId,
            path: editorial.path,
            hash: editorial.hash,
            role: 'Durable publishing-channel decisions. Never a source of facts.',
            contentFile: 'input/editorial.md',
          },
        }
      : {}),
    ...(procedure
      ? {
          procedure: {
            id: procedure.id,
            path: procedure.path,
            hash: procedure.hash,
            role: 'Approved reusable workflow for this writing turn.',
            contentFile: 'input/procedure.md',
          },
        }
      : {}),
    ...(personaPack
      ? {
          personaPack: {
            path: personaPack.path,
            hash: personaPack.hash,
            role: "The narrator's fixed identity — stance registry + adapted experience "
              + 'archetypes. Personal opinions/experiences must trace here.',
            contentFile: 'input/persona-pack.md',
          },
        }
      : {}),
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
      ...(editorial ? { editorialPath: editorial.path } : {}),
      ...(procedure ? { procedurePath: procedure.path } : {}),
      ...(personaPack ? { personaPackPath: personaPack.path } : {}),
      ...(run.selectedHook ? { selectedHook: run.selectedHook } : {}),
    })}${continuation
      ? buildWriteContinuationPrompt({ previousWordCount: continuation.previousWordCount, wordRange })
      : ''}`,
    envelope,
    inputFiles: [
      { path: 'general-pack.md', content: generalPack.markdown },
      ...(editorial ? [{ path: 'editorial.md', content: editorial.markdown }] : []),
      ...(procedure ? [{ path: 'procedure.md', content: procedure.instructions }] : []),
      ...(personaPack ? [{ path: 'persona-pack.md', content: personaPack.markdown }] : []),
      ...(stagedPreviousDraft ? [{ path: 'previous-draft.md', content: stagedPreviousDraft }] : []),
    ],
    inputHashes: [
      envelopeHash(envelope),
      contentHash(generalPack.markdown),
      ...(editorial ? [editorial.hash] : []),
      ...(procedure ? [procedure.hash] : []),
      ...(personaPack ? [contentHash(personaPack.markdown)] : []),
      ...(stagedPreviousDraft ? [contentHash(stagedPreviousDraft)] : []),
    ],
    // Only when a persona pack is actually staged does the prompt text differ
    // from the pre-persona-pack shape — so only then does the turn key change.
    promptVersion: [
      WRITE_PROMPT_VERSION,
      personaPack ? 'persona-v1' : '',
      editorial ? 'editorial-v1' : '',
      procedure ? 'procedure-v1' : '',
    ].filter(Boolean).join('-'),
    sessionGroup: AUTHOR_PTY_SESSION_GROUP,
    interactivePty: true,
    // Blindness is a property of the turn, not just of the envelope. WRITE must
    // not inherit CLI context from STUDY — an author pane that still remembers
    // the study turn can quote source the envelope deliberately withheld. That
    // applies to the very first WRITE, not only to a continuation: this used to
    // be `continuation ? ... : {}`, which left the initial WRITE resuming the
    // same pane STUDY had just used. A continuation additionally needs it
    // because a timed-out CLI pane may be stuck mid-prompt.
    freshContext: true,
    // See the STUDY dispatch: the coordinator counts dispatches, so a scheduler
    // content-retry would be a model call nobody counted. WRITE's retry path is
    // the coordinator's own continuation (`WriteContinuation`), which is counted.
    maxContentRetries: 0,
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
 * Resume the interrupted stage of an existing post without creating a second
 * article. A valid orphan STUDY artifact advances directly to WRITE; when the
 * interrupted STUDY produced no artifact, explicit Continue starts STUDY
 * attempt 2 using the same pinned configuration and the Read-safe source parts.
 * A failed WRITE still creates WRITE attempt 2 from its orphaned draft.
 */
export async function continueWriterRunV2(
  deps: WriterV2Deps,
  runId: string,
): Promise<WriterRunV2> {
  const run = await getWriterRunV2(runId, deps.dataDir);
  if (!run) throw new Error('Writer v2 run không tồn tại');
  const canRecoverStudyArtifact = !run.study && (
    (run.status === 'RUNNING' && run.phase === 'STUDY')
    || (run.status === 'FAILED' && run.phase === 'FAILED')
  );
  if (canRecoverStudyArtifact) {
    if (deps.scheduler.getLiveCloneCount() > 0) {
      throw new Error('STUDY agent vẫn còn live; chỉ recovery sau khi restart daemon và liveClones=0');
    }
    const studyResultPath = join(
      deps.dataDir,
      'workspaces',
      'pipeline',
      run.id,
      WRITER_V2_ITEM_ID,
      'attempts',
      '1',
      STUDY_STAGE,
      'out',
      'result.json',
    );
    let parsed: unknown;
    let hasStudyArtifact = true;
    try {
      parsed = JSON.parse(await readFile(studyResultPath, 'utf8')) as unknown;
    } catch {
      hasStudyArtifact = false;
    }
    const pack = await getWriterPack(run.packId, deps.dataDir);
    if (!pack || !run.packHash || pinWriterPackHash(pack) !== run.packHash) {
      throw new Error('Source Pack không còn khớp pin của run; từ chối recovery STUDY');
    }
    if (!hasStudyArtifact) {
      const formula = await getFormula(run.formulaId, deps.dataDir);
      if (!formula || !run.formulaHash || pinFormulaHash(formula) !== run.formulaHash) {
        throw new Error('Formula không còn khớp pin của run; từ chối retry STUDY');
      }
      run.status = 'RUNNING';
      run.phase = 'STUDY';
      delete run.errorCode;
      delete run.errorReason;
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, deps.dataDir);
      // A daemon restart rotates the Team MCP URL/token. Replace the old pane
      // instead of resuming a CLI process that still holds stale MCP config.
      await dispatchStudy(deps, run, pack, formula, { attempt: 2, freshContext: true });
      return (await getWriterRunV2(run.id, deps.dataDir)) ?? run;
    }
    const validated = validateStudyArtifact(parsed, {
      packMarkdown: pack.markdown,
      videoIds: packVideoIds(pack),
    });
    if (!validated.ok) {
      throw new Error(`Artifact STUDY không hợp lệ (${validated.errorCode}): ${validated.reason}`);
    }
    run.study = validated.study;
    run.status = 'RUNNING';
    run.phase = 'WRITE';
    delete run.errorCode;
    delete run.errorReason;
    run.updatedAt = new Date().toISOString();
    await saveWriterRunV2(run, deps.dataDir);
    await dispatchWrite(deps, run);
    return (await getWriterRunV2(run.id, deps.dataDir)) ?? run;
  }
  const canResumeWriteFromStudy = Boolean(run.study)
    && !run.draft
    && (
      (run.status === 'FAILED' && run.phase === 'FAILED')
      || (run.status === 'RUNNING' && run.phase === 'WRITE' && deps.scheduler.getLiveCloneCount() === 0)
    );

  if (run.status === 'RUNNING' && !canResumeWriteFromStudy) {
    throw new Error(`Run đang ${run.phase}; chờ turn hiện tại settle trước khi tiếp tục`);
  }
  if (!canResumeWriteFromStudy) {
    throw new Error(`Chỉ tiếp tục được Writer v2 run FAILED ở WRITE (hiện: ${run.status}/${run.phase})`);
  }
  if (!run.study || run.draft) {
    throw new Error('Run này không phải lỗi WRITE sau STUDY; hãy dùng ReRun bài mới');
  }

  // Prefer an orphan WRITE draft (attempt 1 left `out/result.json` with a script)
  // so Continue keeps the same article. Only when that file is missing/empty do we
  // dispatch a fresh WRITE from the rescued STUDY (boot-recovery path).
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
  let previousDraft = '';
  try {
    const previous = JSON.parse(await readFile(previousResultPath, 'utf8')) as Partial<WriterV2Draft>;
    previousDraft = typeof previous?.script === 'string' ? previous.script.trim() : '';
  } catch {
    previousDraft = '';
  }

  const pack = await getWriterPack(run.packId, deps.dataDir);
  if (!pack || !run.packHash || pinWriterPackHash(pack) !== run.packHash) {
    throw new Error('Source Pack không còn khớp pin của run; từ chối tiếp tục WRITE');
  }

  run.status = 'RUNNING';
  run.phase = 'WRITE';
  delete run.errorCode;
  delete run.errorReason;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);

  if (previousDraft) {
    await dispatchWrite(deps, run, {
      attempt: 2,
      continuation: {
        previousDraft,
        previousWordCount: countScriptWords(previousDraft),
      },
    });
  } else {
    await dispatchWrite(deps, run);
  }
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
  // Re-loaded and re-filtered here rather than reusing the WRITE-time pin:
  // this gate runs after BOTH WRITE and REPAIR (`advanceAfterDraft` is the
  // only caller), and a persona pack edited mid-run is accepted drift — same
  // choice as the WRITE-time pin (see the comment on `run.personaPackHash =`
  // above). A read error here is treated the same as an absent file — the
  // gate simply runs without a persona source. This is DELIBERATELY the
  // opposite of `dispatchWrite`, which fails the run (PERSONA_PACK_UNREADABLE)
  // on the same error: at dispatch the model has not run yet and a broken
  // persona means the narrator would silently lose their identity, so fail
  // loud; here the WRITE turn is already done and paid for, and the worst
  // case of a missing persona source is a FALSE VIOLATION (stricter gate),
  // never a false pass. Do not "fix" the two sites to match.
  // Only the CITABLE slice reaches the gate, never the full filtered markdown:
  // an approved cell must not license the `**Chuẩn chung**` figure it argues
  // against (CEO review 2026-09-03, RC1). WRITE still stages the full markdown —
  // the model reads the contrast, it just cannot cite its numbers.
  let personaCitableText: string | undefined;
  try {
    personaCitableText = (await getApprovedPersonaPack(deps.dataDir))?.citableText;
  } catch {
    personaCitableText = undefined;
  }
  const result = runDeterministicGate({
    script: draft.script,
    packMarkdown: pack.markdown,
    ...(run.study ? { factsLedger: run.study.factsLedger, outline: run.study.outline } : {}),
    beatAnchors: draft.beatAnchors,
    wordRange: wordRangeFor(run),
    forbiddenNames: forbiddenHostNames({ channelTitle: pack.channelTitle, title: pack.title }),
    ...(draft.coinedLabels ? { declaredCoinedLabels: draft.coinedLabels } : {}),
    ...(personaCitableText ? { personaCitableText } : {}),
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
    ...(run.selectedHook ? { selectedHook: run.selectedHook } : {}),
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
    promptMarkdown: buildEditReviewPrompt({
      hasGateViolations: violations.length > 0,
      ...(run.selectedHook ? { selectedHook: run.selectedHook } : {}),
    }),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: EDIT_REVIEW_PROMPT_VERSION,
    sessionGroup: EDITOR_PTY_SESSION_GROUP,
    interactivePty: true,
    freshContext: true,
    // See the STUDY/WRITE dispatches: the coordinator counts dispatches, so a
    // scheduler content-retry here would be a model call nobody counted. If the
    // editor returns broken JSON the run fails with the validator's errorCode
    // instead of silently re-prompting — the reader notes it and hits continue.
    maxContentRetries: 0,
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
      // The pin from WRITE, not a re-read: whether this repair prompt may
      // mention the persona pack tracks the same run-level fact `dispatchWrite`
      // decided when it staged (or didn't stage) the filtered pack.
      hasPersona: run.personaPackHash !== undefined,
    }),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: REPAIR_PROMPT_VERSION,
    sessionGroup: AUTHOR_PTY_SESSION_GROUP,
    interactivePty: true,
    // See the STUDY/WRITE dispatches: the coordinator counts dispatches, so a
    // scheduler content-retry here would be a model call nobody counted. If the
    // repair turn returns broken JSON the run fails with the validator's
    // errorCode instead of silently re-prompting — the reader notes it and
    // hits continue.
    maxContentRetries: 0,
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
      // First pass always goes to the editor after the gate; repair only re-gates.
      await advanceAfterDraft(deps, run, validated.draft, event.stage === REPAIR_STAGE);
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
      await advanceAfterEditorReview(deps, run, validated.defects);
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
    // Restyle is a later, human-triggered job. It must not inherit the original
    // article batch's elapsed-time budget (real failure: a DONE run older than
    // 120 minutes silently produced WAITING_LANE on every Restyle click).
    budgetScope: `${run.id}:restyle:${version}`,
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

// ── Tổng kết sau bài (DONE side operation) ────────────────────────────────

async function recordPostmortemError(
  dataDir: string,
  run: WriterRunV2,
  code: string,
  reason: string,
): Promise<void> {
  delete run.reviewingPostmortem;
  run.postmortemError = { code, reason, at: new Date().toISOString() };
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, dataDir);
}

async function commitPostmortem(
  dataDir: string,
  run: WriterRunV2,
  lessons: PostmortemLesson[],
): Promise<void> {
  if (!run.channelId) throw new Error('Run thiếu channelId nên không thể lưu tổng kết');
  await appendEditorialSuggestions(
    run.channelId,
    lessons.map((lesson) => ({ ...lesson, sourceRunId: run.id })),
    dataDir,
  );
  run.postmortem = {
    lessons,
    agentId: run.editorAgentId,
    createdAt: new Date().toISOString(),
  };
  delete run.reviewingPostmortem;
  delete run.postmortemError;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, dataDir);
}

async function dispatchPostmortem(deps: WriterV2Deps, run: WriterRunV2): Promise<void> {
  const article = run.finalScript;
  if (!article || !run.channelId) throw new Error('Run thiếu bài hoàn chỉnh hoặc channelId');
  const editorial = await getEditorialNotebook(run.channelId, deps.dataDir);
  if (!editorial) throw new Error('Không đọc được sổ tay biên tập của kênh');
  const attempt = run.reviewingPostmortem?.attempt ?? 1;
  const envelope = {
    contract: { role: 'Tổng kết sau bài', output: '1–3 durable suggestions for human approval' },
    runId: run.id,
    channelId: run.channelId,
    title: run.requestedTitle ?? run.draft?.title ?? run.brief,
    outlineChanges: run.draft?.outlineChanges ?? [],
    editorDefects: run.editorDefects ?? [],
    gateResults: run.gateResults.map((gate) => ({ passed: gate.passed, violations: gate.violations })),
    articleFile: 'input/article.md',
    editorialFile: 'input/editorial.md',
  };
  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: WRITER_V2_ITEM_ID,
    stage: POSTMORTEM_STAGE,
    attempt,
    templateId: run.editorAgentId,
    promptMarkdown: buildPostmortemPrompt(),
    envelope,
    inputFiles: [
      { path: 'article.md', content: article },
      { path: 'editorial.md', content: editorial.markdown },
    ],
    inputHashes: [envelopeHash(envelope), contentHash(article), editorial.hash],
    promptVersion: POSTMORTEM_PROMPT_VERSION,
    sessionGroup: POSTMORTEM_PTY_SESSION_GROUP,
    interactivePty: true,
    freshContext: true,
    budgetScope: `${run.id}:postmortem:${attempt}`,
    validateContent: (parsed) => {
      const validated = validatePostmortem(parsed);
      return validated.ok
        ? { ok: true as const }
        : { ok: false as const, errorCode: validated.errorCode, reason: validated.reason };
    },
  });
  if (dispatch.status !== 'RUNNING') {
    await recordPostmortemError(
      deps.dataDir,
      run,
      dispatch.reason ?? 'POSTMORTEM_DISPATCH_FAILED',
      `Không dispatch được tổng kết (${dispatch.status})`,
    );
  }
}

export async function startWriterPostmortem(
  deps: WriterV2Deps,
  runId: string,
): Promise<WriterRunV2> {
  const run = await getWriterRunV2(runId, deps.dataDir);
  if (!run) throw new Error('Writer v2 run không tồn tại');
  if (run.status !== 'DONE' || !run.finalScript) throw new Error('Chỉ tổng kết được run đã DONE');
  if (!run.channelId || !(await getChannelProfile(run.channelId, deps.dataDir))) {
    throw new Error('Run chưa gắn Hồ sơ kênh hợp lệ');
  }
  if (run.reviewingPostmortem) throw new Error('Agent đang tổng kết bài này');
  if (run.postmortem) throw new Error('Bài này đã có tổng kết');
  const attempt = (run.postmortemAttempt ?? 0) + 1;
  run.postmortemAttempt = attempt;
  run.reviewingPostmortem = { attempt, startedAt: new Date().toISOString() };
  delete run.postmortemError;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);
  await dispatchPostmortem(deps, run);
  return (await getWriterRunV2(run.id, deps.dataDir)) ?? run;
}

export function registerWriterV2PostmortemListener(
  scheduler: LaneScheduler,
  deps: { dataDir: string },
): () => void {
  return scheduler.onItemSettled((event) => {
    if (event.stage !== POSTMORTEM_STAGE) return;
    void handlePostmortemSettle(deps.dataDir, event).catch((err) => {
      console.error('[writer-v2] postmortem settle failed:', (err as Error).message);
    });
  });
}

/** Clear/commit postmortem side operations interrupted by a daemon restart. */
export async function recoverInterruptedPostmortems(dataDir: string): Promise<void> {
  const summaries = await listWriterRunsV2(dataDir);
  for (const summary of summaries) {
    const run = await getWriterRunV2(summary.id, dataDir);
    if (!run?.reviewingPostmortem) continue;
    const attempt = run.reviewingPostmortem.attempt;
    try {
      const raw = await readFile(
        join(stageAttemptDir(dataDir, run.id, attempt, POSTMORTEM_STAGE), 'out', 'result.json'),
        'utf8',
      );
      const validated = validatePostmortem(JSON.parse(raw) as unknown);
      if (!validated.ok) throw new Error(validated.reason);
      await commitPostmortem(dataDir, run, validated.lessons);
      console.log(`[writer-v2] cứu được tổng kết của run ${run.id} sau daemon restart`);
    } catch (err) {
      await recordPostmortemError(
        dataDir,
        run,
        'POSTMORTEM_INTERRUPTED',
        `Tổng kết bị ngắt khi daemon restart: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function handlePostmortemSettle(dataDir: string, event: ItemSettledResult): Promise<void> {
  const run = await getWriterRunV2(event.batchId, dataDir);
  if (!run?.reviewingPostmortem || run.reviewingPostmortem.attempt !== event.attempt) return;
  if (event.outcome !== 'COMMITTED' || !event.artifactHash) {
    await recordPostmortemError(
      dataDir,
      run,
      event.errorCode ?? 'POSTMORTEM_FAILED',
      event.errorReason ?? 'Agent không hoàn tất tổng kết',
    );
    return;
  }
  const parsed = await readCommittedArtifact<unknown>(dataDir, event);
  const validated = validatePostmortem(parsed);
  if (!validated.ok) {
    await recordPostmortemError(dataDir, run, validated.errorCode, validated.reason);
    return;
  }
  await commitPostmortem(dataDir, run, validated.lessons);
}

function stageAttemptDir(
  dataDir: string,
  runId: string,
  attempt: number,
  stage: string,
): string {
  return join(
    dataDir,
    'workspaces',
    'pipeline',
    runId,
    WRITER_V2_ITEM_ID,
    'attempts',
    String(attempt),
    stage,
  );
}

/** Newest attempt that still has a readable `out/result.json` for this stage. */
async function latestStageResult(
  dataDir: string,
  runId: string,
  stage: string,
): Promise<{ attempt: number; parsed: unknown } | null> {
  const attemptsRoot = join(dataDir, 'workspaces', 'pipeline', runId, WRITER_V2_ITEM_ID, 'attempts');
  let names: string[];
  try {
    names = await readdir(attemptsRoot);
  } catch {
    return null;
  }
  const attempts = names
    .map((name) => Number(name))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => b - a);
  for (const attempt of attempts) {
    try {
      const raw = await readFile(
        join(stageAttemptDir(dataDir, runId, attempt, stage), 'out', 'result.json'),
        'utf8',
      );
      return { attempt, parsed: JSON.parse(raw) as unknown };
    } catch {
      // try an older attempt
    }
  }
  return null;
}

async function markWriterInterrupted(
  dataDir: string,
  run: WriterRunV2,
  errorCode: string,
  errorReason: string,
): Promise<void> {
  run.status = 'FAILED';
  run.phase = 'FAILED';
  run.errorCode = errorCode;
  run.errorReason = errorReason;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, dataDir);
}

export type WriterDraftVerdict =
  | { kind: 'EDIT_REVIEW' }
  | { kind: 'REPAIR' }
  | { kind: 'DONE'; finalScript: string }
  | { kind: 'FAILED_GATE'; violations: GateResult['violations'] };

/**
 * The single pure verdict boundary shared by live settle and boot recovery.
 *
 * This deliberately evaluates only the legacy gate contract for now. Keeping
 * the decision pure makes the later combined-gate wiring one replacement here,
 * instead of four subtly different recovery/live branches. `phase` separates
 * the pre-review GATE state from the post-review EDIT_REVIEW state without
 * adding a second, caller-owned verdict flag.
 */
export function evaluateWriterDraftVerdict(
  run: Pick<WriterRunV2, 'phase' | 'gateResults' | 'editorDefects'>,
  draft: Pick<WriterV2Draft, 'script'>,
  isRepair: boolean,
): WriterDraftVerdict {
  const gate = run.gateResults.at(-1);
  const gateClean = gate?.passed ?? false;

  if (isRepair) {
    return gateClean
      ? { kind: 'DONE', finalScript: draft.script }
      : { kind: 'FAILED_GATE', violations: gate?.violations ?? [] };
  }

  // A fresh WRITE always receives the independent editor pass, even when the
  // legacy code gate is already red. Once that editor has settled, its persisted
  // defect list determines DONE vs the one allowed REPAIR round.
  if (run.phase !== 'EDIT_REVIEW' || run.editorDefects === null) {
    return { kind: 'EDIT_REVIEW' };
  }
  if (gateClean && run.editorDefects.length === 0) {
    return { kind: 'DONE', finalScript: draft.script };
  }
  return { kind: 'REPAIR' };
}

/** Apply the pure verdict without duplicating DONE/FAILED routing. */
async function advanceFromWriterDraftVerdict(
  deps: WriterV2Deps,
  run: WriterRunV2,
  draft: WriterV2Draft,
  isRepair: boolean,
): Promise<void> {
  const verdict = evaluateWriterDraftVerdict(run, draft, isRepair);
  switch (verdict.kind) {
    case 'DONE':
      run.status = 'DONE';
      run.phase = 'DONE';
      run.finalScript = verdict.finalScript;
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, deps.dataDir);
      await notifyWriterV2Done(run, deps.dataDir);
      return;

    case 'FAILED_GATE':
      await failRun(
        deps,
        run,
        'WRITER_V2_GATE',
        `Gate vẫn đỏ sau một vòng sửa:\n${formatGateViolations(verdict.violations)}`,
        'FAILED_GATE',
      );
      return;

    case 'EDIT_REVIEW':
      run.phase = 'EDIT_REVIEW';
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, deps.dataDir);
      await dispatchEditReview(deps, run);
      return;

    case 'REPAIR':
      run.phase = 'REPAIR';
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, deps.dataDir);
      await dispatchRepair(deps, run);
  }
}

/**
 * After a draft settles (WRITE or REPAIR): run Layer 0, then either finish, fail the
 * gate, or dispatch EDIT_REVIEW. Shared by the live settle path and boot recovery so
 * a rescued `out/result.json` cannot take a different branch than a live turn.
 */
async function advanceAfterDraft(
  deps: WriterV2Deps,
  run: WriterRunV2,
  draft: WriterV2Draft,
  fromRepair: boolean,
): Promise<void> {
  run.draft = draft;
  run.phase = 'GATE';
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);

  await runGateForRun(deps, run);
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);
  await advanceFromWriterDraftVerdict(deps, run, draft, fromRepair);
}

async function advanceAfterEditorReview(
  deps: WriterV2Deps,
  run: WriterRunV2,
  defects: EditorDefect[],
): Promise<void> {
  const draft = run.draft;
  if (!draft) {
    await failRun(deps, run, 'WRITER_V2_INPUT_MISSING', 'draft missing when the editor settled');
    return;
  }
  run.editorDefects = defects;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);
  await advanceFromWriterDraftVerdict(deps, run, draft, false);
}

/**
 * Boot recovery for the main Writer v2 stages (STUDY → WRITE → GATE → EDIT → REPAIR).
 *
 * After `reconcileOnBoot`, every in-flight ledger row is INTERRUPTED and no settle
 * event fires — so a run left `status: RUNNING` is a zombie unless we either commit a
 * finished `out/result.json` or mark the run FAILED so Continue can resume it.
 *
 * When `scheduler` is provided (daemon boot), a valid artifact advances exactly as a
 * live settle would, including dispatching the next agent stage. Without a scheduler,
 * zombies are only cleared to FAILED/`*_INTERRUPTED` (safe for unit tests).
 *
 * Restyle recovery stays in `recoverInterruptedRestyles` — a side operation on DONE.
 */
export async function recoverInterruptedWriterRuns(
  dataDir: string,
  scheduler?: LaneScheduler,
): Promise<void> {
  const summaries = await listWriterRunsV2(dataDir);
  for (const summary of summaries) {
    try {
      const run = await getWriterRunV2(summary.id, dataDir);
      if (!run || run.status !== 'RUNNING') continue;
      // Restyle keeps status DONE; hook loop keeps DRAFT. Neither is a main-loop zombie.
      if (run.restyling) continue;
      if (run.generatingHook) continue;

      const deps: WriterV2Deps | null = scheduler
        ? { scheduler, dataDir }
        : null;

      switch (run.phase) {
        case 'STUDY': {
          const found = await latestStageResult(dataDir, run.id, STUDY_STAGE);
          if (!found) {
            await markWriterInterrupted(
              dataDir,
              run,
              'STUDY_INTERRUPTED',
              'STUDY bị ngắt (daemon restart) và không có out/result.json — bấm Continue để chạy lại.',
            );
            break;
          }
          const pack = await getWriterPack(run.packId, dataDir);
          if (!pack || !run.packHash || pinWriterPackHash(pack) !== run.packHash) {
            await markWriterInterrupted(
              dataDir,
              run,
              'STUDY_INTERRUPTED',
              'STUDY bị ngắt; Source Pack không còn khớp pin của run.',
            );
            break;
          }
          const validated = validateStudyArtifact(found.parsed, {
            packMarkdown: pack.markdown,
            videoIds: packVideoIds(pack),
          });
          if (!validated.ok) {
            await markWriterInterrupted(
              dataDir,
              run,
              'STUDY_INTERRUPTED',
              `STUDY bị ngắt; out/result.json không hợp lệ (${validated.errorCode}): ${validated.reason}`,
            );
            break;
          }
          run.study = validated.study;
          run.status = 'RUNNING';
          run.phase = 'WRITE';
          delete run.errorCode;
          delete run.errorReason;
          run.updatedAt = new Date().toISOString();
          await saveWriterRunV2(run, dataDir);
          if (deps) {
            await dispatchWrite(deps, run);
            console.log(`[writer-v2] cứu được STUDY của run ${run.id} → WRITE sau daemon restart`);
          } else {
            await markWriterInterrupted(
              dataDir,
              run,
              'STUDY_INTERRUPTED',
              'STUDY đã cứu được artifact nhưng thiếu scheduler để tiếp tục WRITE — bấm Continue.',
            );
          }
          break;
        }

        case 'WRITE': {
          const found = await latestStageResult(dataDir, run.id, WRITE_STAGE);
          if (!found || !run.study) {
            await markWriterInterrupted(
              dataDir,
              run,
              'WRITE_INTERRUPTED',
              'WRITE bị ngắt (daemon restart) — bấm Continue nếu còn bản nháp dở, hoặc ReRun.',
            );
            break;
          }
          const pack = await getWriterPack(run.packId, dataDir);
          if (!pack) {
            await markWriterInterrupted(
              dataDir,
              run,
              'WRITE_INTERRUPTED',
              'WRITE bị ngắt; Source Pack đã biến mất.',
            );
            break;
          }
          const validated = validateWriterV2Draft(found.parsed, {
            outline: run.study.outline,
            wordRange: wordRangeFor(run),
            forbiddenNames: forbiddenHostNames({ channelTitle: pack.channelTitle, title: pack.title }),
            requireOutlineChanges: true,
          });
          if (!validated.ok) {
            await markWriterInterrupted(
              dataDir,
              run,
              'WRITE_INTERRUPTED',
              `WRITE bị ngắt; out/result.json không hợp lệ (${validated.errorCode}): ${validated.reason}`,
            );
            break;
          }
          if (!deps) {
            await markWriterInterrupted(
              dataDir,
              run,
              'WRITE_INTERRUPTED',
              'WRITE đã có artifact nhưng thiếu scheduler để chạy gate — bấm Continue/ReRun.',
            );
            break;
          }
          await advanceAfterDraft(deps, run, validated.draft, false);
          console.log(`[writer-v2] cứu được WRITE của run ${run.id} sau daemon restart`);
          break;
        }

        case 'GATE': {
          if (!run.draft || !deps) {
            await markWriterInterrupted(
              dataDir,
              run,
              'GATE_INTERRUPTED',
              'GATE bị ngắt giữa chừng — bấm ReRun hoặc mở lại post để kiểm tra draft.',
            );
            break;
          }
          await advanceAfterDraft(deps, run, run.draft, Boolean(run.repairAttempted));
          console.log(`[writer-v2] tiếp tục GATE của run ${run.id} sau daemon restart`);
          break;
        }

        case 'EDIT_REVIEW': {
          const found = await latestStageResult(dataDir, run.id, EDIT_REVIEW_STAGE);
          if (!found || !run.draft) {
            await markWriterInterrupted(
              dataDir,
              run,
              'EDIT_REVIEW_INTERRUPTED',
              'EDIT_REVIEW bị ngắt (daemon restart) và không có out/result.json hợp lệ.',
            );
            break;
          }
          const validated = validateEditorReview(found.parsed, run.draft.script);
          if (!validated.ok) {
            await markWriterInterrupted(
              dataDir,
              run,
              'EDIT_REVIEW_INTERRUPTED',
              `EDIT_REVIEW bị ngắt; out/result.json không hợp lệ (${validated.errorCode}): ${validated.reason}`,
            );
            break;
          }
          if (!deps) {
            await markWriterInterrupted(
              dataDir,
              run,
              'EDIT_REVIEW_INTERRUPTED',
              'EDIT_REVIEW đã có artifact nhưng thiếu scheduler để tiếp tục.',
            );
            break;
          }
          await advanceAfterEditorReview(deps, run, validated.defects);
          console.log(`[writer-v2] cứu được EDIT_REVIEW của run ${run.id} sau daemon restart`);
          break;
        }

        case 'REPAIR': {
          const found = await latestStageResult(dataDir, run.id, REPAIR_STAGE);
          if (!found || !run.study) {
            await markWriterInterrupted(
              dataDir,
              run,
              'REPAIR_INTERRUPTED',
              'REPAIR bị ngắt (daemon restart) — kiểm tra draft và ReRun nếu cần.',
            );
            break;
          }
          const pack = await getWriterPack(run.packId, dataDir);
          if (!pack) {
            await markWriterInterrupted(
              dataDir,
              run,
              'REPAIR_INTERRUPTED',
              'REPAIR bị ngắt; Source Pack đã biến mất.',
            );
            break;
          }
          const validated = validateWriterV2Draft(found.parsed, {
            outline: run.study.outline,
            wordRange: wordRangeFor(run),
            forbiddenNames: forbiddenHostNames({ channelTitle: pack.channelTitle, title: pack.title }),
            requireOutlineChanges: false,
          });
          if (!validated.ok) {
            await markWriterInterrupted(
              dataDir,
              run,
              'REPAIR_INTERRUPTED',
              `REPAIR bị ngắt; out/result.json không hợp lệ (${validated.errorCode}): ${validated.reason}`,
            );
            break;
          }
          if (!deps) {
            await markWriterInterrupted(
              dataDir,
              run,
              'REPAIR_INTERRUPTED',
              'REPAIR đã có artifact nhưng thiếu scheduler để chạy gate.',
            );
            break;
          }
          await advanceAfterDraft(deps, run, validated.draft, true);
          console.log(`[writer-v2] cứu được REPAIR của run ${run.id} sau daemon restart`);
          break;
        }

        default:
          await markWriterInterrupted(
            dataDir,
            run,
            'WRITER_V2_INTERRUPTED',
            `Run bị ngắt ở phase ${run.phase} sau daemon restart.`,
          );
      }
    } catch (err) {
      console.error(
        `[writer-v2] recoverInterruptedWriterRuns bỏ qua run ${summary.id}:`,
        (err as Error).message,
      );
    }
  }
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
