/**
 * Pure script checks shared by the v1 Writer flow (`writer-run.ts`) and the v2
 * deterministic gate (`deterministic-gate.ts`).
 *
 * Extracted 2026-08-14 (Write Loop v2, Phase 0) — these were defined inside
 * `writer-run.ts`, which also pulls in Taste RAG / profile store / scheduler types.
 * The gate must stay dependency-free (it is code, not an agent, and its test runs
 * without any env setup), so the pure helpers moved here. `writer-run.ts` re-exports
 * them, so every existing caller/import path keeps working unchanged.
 */

/** Default floor when the human did not set a target length. */
export const DEFAULT_MIN_WORDS = 80;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word count contract used by every prompt: `script.trim().split(/\s+/).length`. */
export function countScriptWords(script: string): number {
  const trimmed = script.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Accept band around a human target word count.
 * ±20% with at least ±40 words of headroom so agents can land without
 * surgical rewrites; never below DEFAULT_MIN_WORDS.
 */
export function targetWordRange(targetWords: number): { minWords: number; maxWords: number } {
  const t = Math.round(targetWords);
  const slack = Math.max(40, Math.round(t * 0.2));
  const minWords = Math.max(DEFAULT_MIN_WORDS, t - slack);
  const maxWords = Math.max(minWords + 50, t + slack);
  return { minWords, maxWords };
}

/**
 * Host/channel names that must not appear as the narrator identity of THIS series.
 * Pack sources (e.g. "Hieu Nguyen") leak first-person intros ("Tôi là Hiếu") if unfenced.
 */
export function forbiddenHostNames(pack: {
  channelTitle?: string;
  title?: string;
}): string[] {
  const raw = [pack.channelTitle, pack.title].filter(Boolean).join(' ');
  const names = new Set<string>();
  const push = (s: string) => {
    const t = s.trim();
    if (t.length >= 2) names.add(t);
  };
  // Whole channel title + tokens (skip generic words)
  push(pack.channelTitle ?? '');
  for (const part of raw.split(/[\s|/·,()（）\-_]+/)) {
    if (part.length < 2) continue;
    if (/^(50%|pack|source|channel|kênh|podcast)$/i.test(part)) continue;
    push(part);
  }
  // Common Vietnamese host-name variants for Hiếu TV sources
  const lower = raw.toLowerCase();
  if (lower.includes('hieu') || lower.includes('hiếu')) {
    for (const n of ['Hiếu', 'Hieu', 'Hiếu TV', 'Hieu Nguyen', 'Hiếu Nguyễn', 'Podcast Hiếu TV']) {
      push(n);
    }
  }
  return [...names];
}

/** True if `script` names a forbidden host as identity (case-insensitive). */
export function findIdentityLeak(script: string, forbidden: string[]): string | null {
  if (!script || forbidden.length === 0) return null;
  const hay = script.normalize('NFC');
  for (const name of forbidden) {
    const n = name.normalize('NFC').trim();
    if (n.length < 2) continue;
    // Prefer "tôi là X" / "mình là X" — strongest identity claim
    const identityRe = new RegExp(
      `(?:tôi|mình|ta)\\s+là\\s+${escapeRegExp(n)}`,
      'i',
    );
    if (identityRe.test(hay)) return n;
    // Bare host name (not common single surnames alone): multi-word channel titles
    // or known first-name host marks (Hiếu / Hieu). Avoid banning bare "Nguyen".
    const allowBare =
      n.includes(' ') || /hiếu|hieu/i.test(n) || /tv/i.test(n);
    if (allowBare && n.length >= 4) {
      const bare = new RegExp(`(?:^|[^\\p{L}])${escapeRegExp(n)}(?:[^\\p{L}]|$)`, 'iu');
      if (bare.test(hay)) return n;
    }
  }
  return null;
}
