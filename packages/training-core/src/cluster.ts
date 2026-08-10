/**
 * Deterministic rule clustering for the Formula Studio (SDD §12b, ADR-13).
 *
 * This is the "thuật toán" half of the merge: the human picks which rules are
 * candidates, and this code — with NO model call — groups the picked rules so the
 * human can see what overlaps before deciding what to merge. Being deterministic
 * matters: the same picks always produce the same clusters, it costs nothing, and
 * it is fully testable without an agent.
 *
 * What this deliberately does NOT do (ADR-13 — the LLM proposes, the human decides):
 *  - it never merges anything; it only groups and reports;
 *  - it never rewrites a statement (that is the SYNTHESIZE stage's job, and only for
 *    clusters the human approved);
 *  - it never drops a picked rule — every input appears in exactly one output cluster.
 */
import { createHash } from 'node:crypto';
import type { Evidence } from './contracts.ts';

/** One rule the human picked out of some L1 Formula, flattened for clustering. */
export interface PickedRule {
  videoSnapshotId: string;
  channelTitle: string;
  sourceFormulaId: string;
  sourceRuleId: string;
  statement: string;
  evidence: Evidence[];
}

/** `SIMILAR` = more than one picked rule landed here, so there is a merge decision
 * to make. `SINGLE` = nothing else resembled it; it can be carried through as-is. */
export type RuleClusterKind = 'SIMILAR' | 'SINGLE';

export interface RuleCluster {
  /**
   * Derived from the cluster's MEMBERSHIP, not its position — `c-<hash of sorted
   * member refs>`.
   *
   * This matters because Studio proposals are keyed by `clusterId`. With positional
   * ids (`c1`, `c2`, …) picking one more rule would renumber the clusters, and an
   * already-approved proposal would silently re-attach to a different cluster. With
   * a content-derived id: adding an unrelated pick leaves existing cluster ids
   * untouched, so their proposals survive; and if a cluster's membership really does
   * change, its id changes with it, so the stale proposal correctly stops matching
   * instead of quietly applying to different rules.
   */
  id: string;
  kind: RuleClusterKind;
  members: PickedRule[];
}

/**
 * Jaccard overlap at which two statements are considered near-duplicates.
 *
 * Deliberately conservative. A false split (two rules that mean the same thing land
 * in separate clusters) costs the user one extra manual merge; a false join (two
 * genuinely different tactics silently grouped) risks the human merging away a real
 * distinction — the exact mistake ADR-5 says must not be automated. So when in doubt,
 * this splits.
 *
 * This threshold is a guess until it meets real data. It is exported so it can be
 * tuned from one place once there are enough picked rules to judge it on.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

/** Words carrying no discriminating signal in Vietnamese rule statements. Without
 * this, two unrelated long statements share enough filler to look similar. Kept
 * short on purpose — an aggressive stopword list would itself distort similarity. */
const STOPWORDS = new Set([
  'và', 'của', 'là', 'một', 'các', 'có', 'được', 'cho', 'với', 'trong', 'để', 'này',
  'đó', 'những', 'thì', 'mà', 'ở', 'khi', 'người', 'không', 'nhưng', 'rồi', 'sẽ',
  'the', 'a', 'an', 'of', 'to', 'and', 'is', 'in', 'for', 'with', 'that', 'this',
]);

/** Lowercase, drop punctuation, split on whitespace, drop stopwords and 1-char
 * tokens. Diacritics are preserved — stripping them would merge Vietnamese words
 * that differ only by tone and are not the same word. */
function tokenize(statement: string): Set<string> {
  const cleaned = statement
    .toLowerCase()
    // Unicode-aware: keep letters/digits/whitespace, drop everything else.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** |A ∩ B| / |A ∪ B|. Returns 0 when either side has no meaningful tokens, so an
 * empty/stopword-only statement never looks similar to anything. */
export function similarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Groups picked rules by statement similarity.
 *
 * Greedy single-pass in input order: each rule joins the first existing cluster whose
 * FIRST member it is similar enough to, otherwise it opens a new cluster. Comparing
 * against the cluster's first member (not every member) keeps clusters tight and the
 * result order-stable and easy to explain in the UI — "these all resemble this one" —
 * rather than letting a cluster drift as unrelated members chain onto each other.
 *
 * Every input rule ends up in exactly one cluster; nothing is dropped or merged.
 */
export function clusterRules(
  picked: PickedRule[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): RuleCluster[] {
  const clusters: RuleCluster[] = [];

  for (const rule of picked) {
    const match = clusters.find(
      (cluster) => similarity(cluster.members[0]!.statement, rule.statement) >= threshold,
    );
    if (match) {
      match.members.push(rule);
    } else {
      clusters.push({ id: '', kind: 'SINGLE', members: [rule] });
    }
  }

  for (const cluster of clusters) {
    cluster.kind = cluster.members.length > 1 ? 'SIMILAR' : 'SINGLE';
    cluster.id = clusterId(cluster.members);
  }

  return clusters;
}

/** `c-<12 hex>` over the sorted `formulaId:ruleId` refs — see `RuleCluster.id`.
 * Sorted so member insertion order cannot change a cluster's identity. */
function clusterId(members: PickedRule[]): string {
  const refs = members.map((m) => `${m.sourceFormulaId}:${m.sourceRuleId}`).sort();
  return `c-${createHash('sha256').update(refs.join('|')).digest('hex').slice(0, 12)}`;
}
