/**
 * The Writer-side view of a Formula (user decision, 2026-08-10 — see thread
 * "Formula có HAI cách dùng"):
 *
 *  1. A Formula AS TRAINING DATA (`FormulaArtifact` itself) describes one specific
 *     video and MUST carry `evidence` — that's what `validateAnalysis` /
 *     `validateCompoundRule` enforce, and what training/grading reads.
 *  2. A Formula AS WRITER INPUT is a different projection of the SAME artifact:
 *     no evidence (a writer agent has no transcript to ground a citation in), and
 *     as generic as the rule statements themselves allow — the writer is writing
 *     about a NEW topic, not the video the Formula was extracted from.
 *
 * `toWriterFormula` is that projection. It is intentionally NOT a second storage
 * shape — there is exactly one Formula store (ADR-14 in
 * `docs/specs/002-writer-agent-mvp/solution-design.md` §8.2 fixed the previous
 * split between `lab-runs/*.json` / `studio-sessions/*.json` and the canonical
 * store); this file only narrows what a caller reads off `FormulaArtifact`, it
 * never writes anywhere.
 *
 * `detectTopicLeak` is the companion half: a cheap, deterministic scan that flags
 * rule statements which still read like they describe ONE video (a verbatim quote,
 * a timestamp from that video, a literal list of that video's section numbers)
 * instead of a general-purpose writing pattern. See its own doc comment for what
 * it deliberately does NOT catch.
 */
import type { FormulaArtifact } from './contracts.ts';
import { normalizeFormula } from './validator.ts';

/** What a writer agent is allowed to see of a Formula: an id to reference it by, a
 * human label for context, and bare rule statements. Nothing here can be traced
 * back to the source video — that's the point (evidence/sources/segmentIds/
 * includedArtifacts/lineage all dropped). */
export interface WriterFormula {
  id: string;
  /** `COMPOUND` Formulas are scoped to a genre, never a channel (ADR-5); `ANALYZED`/
   * `REFINED` Formulas are scoped to one video, so `channelTitle` is the closest
   * thing to a topic hint. Either way this is display/context ONLY — never fed back
   * into grounding or grading. Empty string if the source Formula never recorded
   * one (both fields are optional on `FormulaArtifact`); a missing label is not
   * worth failing the projection over. */
  label: string;
  rules: { id: string; statement: string }[];
}

/**
 * Projects any `FormulaArtifact` — `ANALYZED`, `REFINED`, or `COMPOUND` alike — into
 * what a writer agent should receive. Deliberately origin-agnostic: the user
 * confirmed the Writer connects to any Formula regardless of origin, so this
 * function does not branch on `origin` except to pick the label source.
 */
export function toWriterFormula(formula: FormulaArtifact): WriterFormula {
  // Normalize first, defensively. Formulas written before ADR-14 carry
  // `scope`/`channelGroups` and no `origin` — and real ones still do on disk today.
  // Without this, such a Formula silently yields `label: ''` and `origin === undefined`
  // instead of failing, which is the worst outcome: a Writer prompt that quietly lost
  // its context label. `normalizeFormula` early-returns on already-current shapes, so
  // calling it here is cheap and idempotent rather than a second migration path.
  const current = normalizeFormula(formula);
  const label = current.origin === 'COMPOUND' ? current.genre : current.channelTitle;
  return {
    id: current.id,
    label: label ?? '',
    rules: current.rules.map((rule) => ({ id: rule.id, statement: rule.statement })),
  };
}

/** One kind of "this rule statement still smells like it describes a specific
 * video" signal `detectTopicLeak` can raise. */
export type TopicLeakKind = 'VERBATIM_QUOTE' | 'SPECIFIC_NUMBER' | 'VIDEO_ORDINAL';

export interface TopicLeak {
  kind: TopicLeakKind;
  /** The exact substring of `statement` that triggered this leak — shown to the
   * human as-is so they can judge whether it actually matters, not just told
   * "leak found". */
  excerpt: string;
}

// Quote-delimiter pairs a rule statement might use to embed a verbatim line from
// the source video. Four pairs because real Formula data (see 0fcb21c0's rule-4/
// rule-7) mixes straight ASCII quotes with typographic ones depending on which
// agent/editor produced the statement — narrowing to just one style would miss
// half of what's already on disk.
const QUOTE_PATTERNS: RegExp[] = [
  /"([^"]+)"/g, // straight double
  /'([^']+)'/g, // straight single
  /“([^”]+)”/g, // curly double
  /„([^"]+)"/g, // German-style open, straight close (as seen in some sources)
];

// A number is only a topic leak when it pins a position WITHIN that one video
// (a timestamp or a "thứ N" ordinal on giây/phút) — not just any number. A rule
// like "lặp lại ba lần" (repeat three times) is a generic writing technique that
// happens to name a count; it says nothing about which second/minute of THIS
// video that happened at, so it must not match here.
const SPECIFIC_NUMBER_PATTERN = /\b(?:giây|phút)\s+(?:thứ\s+)?~?\s*\d+(?:[.,]\d+)?\b/gi;

// A literal enumeration of a video's own section numbers ("Phần một, Phần hai,
// Phần bốn"). Requires TWO OR MORE consecutive "Phần <n>" entries — a single
// "chia thành các Phần" mention is a generic structural technique, not a leak;
// only a concrete listing pins the rule to one video's actual section count/order.
const VIDEO_ORDINAL_PATTERN =
  /Phần\s+(?:một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|\d+)(?:\s*,\s*Phần\s+(?:một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|\d+))+/gi;

/**
 * Advisory-only scan for topic leakage in a rule statement meant for a writer
 * agent. Returns an empty array for a clean statement; NEVER throws and NEVER
 * blocks anything — callers surface these as warnings for a human to glance at,
 * same trust level as a lint suggestion, not a validation gate. (Contrast with
 * `validateAnalysis`/`validateCompoundRule` in `validator.ts`, which DO reject.)
 *
 * Deliberately a plain string/regex heuristic, not an LLM call: it needs to run
 * inline wherever a rule is about to be shown to a writer, cheaply and
 * deterministically, and false positives are the acceptable failure mode here
 * (a human sees one extra warning) whereas a false negative silently ships a
 * leak — so every pattern below is written to over-trigger rather than under-.
 *
 * Known blind spot, by design: this catches the LITERAL leaks (a quoted line, a
 * timestamp, an explicit section list) but NOT a bare topic noun like "khái niệm
 * tài chính" (a financial concept) — there is no deterministic way to tell "this
 * noun is the video's specific subject" from "this noun is part of a genuinely
 * generic rule" without understanding meaning. That class of leak needs an LLM
 * generalization pass (P3), not a regex; do not extend this function to guess at
 * topic nouns via a keyword list — it would be wrong often enough to be worse
 * than no signal, and nobody could tell why a given noun was or wasn't flagged.
 */
export function detectTopicLeak(statement: string): TopicLeak[] {
  const leaks: TopicLeak[] = [];

  // `matchAll` takes a copy of each pattern internally, so reusing these
  // module-level `/g` regexes across calls is safe — no `lastIndex` reset needed.
  for (const pattern of QUOTE_PATTERNS) {
    for (const match of statement.matchAll(pattern)) {
      // Group 1 is always captured when the pattern matches at all (it's the
      // whole pattern minus the delimiters) — TS just can't see that from the
      // regex literal, hence the fallback to the full match.
      leaks.push({ kind: 'VERBATIM_QUOTE', excerpt: match[1] ?? match[0] });
    }
  }

  for (const match of statement.matchAll(SPECIFIC_NUMBER_PATTERN)) {
    leaks.push({ kind: 'SPECIFIC_NUMBER', excerpt: match[0] });
  }

  for (const match of statement.matchAll(VIDEO_ORDINAL_PATTERN)) {
    leaks.push({ kind: 'VIDEO_ORDINAL', excerpt: match[0] });
  }

  return leaks;
}
