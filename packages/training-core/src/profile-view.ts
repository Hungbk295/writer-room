/**
 * Runtime projection of `WRITER_READY_PROFILE` for the Writer agent prompt.
 *
 * Store keeps `sourceRuleIds` for audit/re-migrate. The agent must NOT see
 * provenance or source identity (plan §2 / acceptance: clean profile projection).
 */
import type { WriterReadyProfile, WriterReadyProfileGuideline } from './profile.ts';

export interface WriterProfileGuidelineView {
  id: string;
  instruction: string;
  when?: string;
  avoidWhen?: string;
  priority: WriterReadyProfileGuideline['priority'];
}

/** What the Writer agent is allowed to see of a profile. */
export interface WriterProfileView {
  kind: 'WRITER_READY_PROFILE';
  id: string;
  version: number;
  label: string;
  readiness: WriterReadyProfile['readiness'];
  scope: WriterReadyProfile['scope'];
  editorialPromise?: string;
  guidelines: WriterProfileGuidelineView[];
  antiPatterns: string[];
}

export function toWriterProfileView(profile: WriterReadyProfile): WriterProfileView {
  return {
    kind: 'WRITER_READY_PROFILE',
    id: profile.id,
    version: profile.version,
    label: profile.label,
    readiness: profile.readiness,
    scope: profile.scope,
    editorialPromise: profile.editorialPromise,
    guidelines: profile.guidelines.map((g) => ({
      id: g.id,
      instruction: g.instruction,
      when: g.when,
      avoidWhen: g.avoidWhen,
      priority: g.priority,
    })),
    antiPatterns: [...profile.antiPatterns],
  };
}
