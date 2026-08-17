/**
 * `detectTopicLeak` (plan/writer-train/FORMULA-MIGRATION-TO-WRITER.md §1/§6, ADR-FM3):
 * a cheap, deterministic scan flagging rule statements that still read like they
 * describe ONE video (a verbatim quote, a timestamp from that video, a literal list
 * of that video's section numbers) instead of a general-purpose writing pattern. Used
 * as the leak GATE when publishing a `WriterReadyProfile`
 * (`packages/daemon/src/training/studio.ts`'s `publishProfile`) — see its own doc
 * comment below for what it deliberately does NOT catch.
 *
 * Renamed from `writer-view.ts` 2026-08-11 (FM1): that file used to also export
 * `toWriterFormula`/`WriterFormula` (a Formula-to-writer-prompt projection, since
 * replaced by `training-core/draft-view.ts`'s Training-Lab-only `toTrainingDraftView`
 * and by the real migration path into `WriterReadyProfile`). Once that projection was
 * gone, `writer-view.ts` held only leak detection — a misnomer, since this has nothing
 * to do with "the writer's view" of anything; it is a standalone leak-scanning
 * utility. `leak.ts` names what is actually here.
 */

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
 * blocks anything on its own — callers decide how to use it (advisory warning in
 * `promoteCompound`, a hard GATE in `publishProfile` — see that function's doc
 * comment). (Contrast with `validateAnalysis`/`validateCompoundRule` in
 * `validator.ts`, which always reject.)
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
