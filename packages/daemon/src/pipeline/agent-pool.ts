/**
 * Agent Pool — clone/reap ephemeral agent configs for pipeline turns (SDD §5.3).
 *
 * The harness caps one running turn per agent id, so parallelism comes from cloning
 * the Settings-configured agent (the "template"), not from queueing harder. Every
 * dispatch gets its own clone; `LaneScheduler` reaps it as soon as its turn settles.
 */
import { createHash } from 'node:crypto';
import type { AgentDefinition } from '@writer-room/shared';
import type { AgentManager } from '../agents/index.ts';

/** `agents/config.ts:29` — `^[a-z0-9][a-z0-9-]{0,40}$`. */
const MAX_ID_LEN = 41;

function shortHash(input: string, len = 6): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

/**
 * Deterministic clone id: `${templateId}-${shortBatch}-${shortItem}-a${attempt}`.
 *
 * `batchId`/`itemId` are arbitrary app-chosen strings — they may be longer than the
 * id budget or contain characters outside the kebab-case alphabet the harness
 * enforces — so they are always hashed down to 6 hex chars rather than
 * sanitized/truncated in place. That keeps the id: (a) deterministic — same inputs
 * always produce the same clone id, which is what makes idempotent re-dispatch able
 * to reuse a clone id safely; (b) always kebab-case-safe (hex is a subset); and
 * (c) never wider than 41 chars, even for a pathologically long `templateId` (which
 * itself gets truncated to fit the remaining budget). 6 hex chars is a deliberately
 * small collision-risk tradeoff acceptable at M0.5 scale (one running batch at a
 * time, human-attended) — not a cryptographic identifier.
 */
export function cloneAgentId(templateId: string, batchId: string, itemId: string, attempt: number): string {
  const suffix = `-${shortHash(batchId)}-${shortHash(itemId)}-a${attempt}`;
  const templateBudget = Math.max(1, MAX_ID_LEN - suffix.length);
  const template = templateId.slice(0, templateBudget);
  return `${template}${suffix}`.slice(0, MAX_ID_LEN);
}

export interface AcquireCloneParams {
  templateId: string;
  batchId: string;
  itemId: string;
  attempt: number;
  itemRunDir: string;
}

/**
 * ACQUIRE (SDD §5.3): clone the template agent, pointed at the item's run dir.
 *
 * `projectRoot` is set to `itemRunDir` (never the repo root) — `AgentManager.delete`
 * removes `<projectRoot>/AGENTS.override.md` and `<projectRoot>/.gemini/system.md`
 * (`agents/index.ts:118-126`); reaping a clone whose projectRoot was the repo root
 * would delete the repo's tracked `AGENTS.override.md`.
 */
export function acquireClone(agents: AgentManager, params: AcquireCloneParams): AgentDefinition {
  const template = agents.get(params.templateId);
  const id = cloneAgentId(params.templateId, params.batchId, params.itemId, params.attempt);
  return agents.save({
    ...template,
    id,
    name: `${template.name} · ${params.itemId}`,
    projectRoot: params.itemRunDir,
    workingDirectoryMode: 'project',
    ephemeral: true,
  });
}

/**
 * REAP (SDD §5.3): remove the clone's config entry. Must never throw — reaping runs
 * on every settle path (success or failure) and must never block settlement.
 */
export function reapClone(agents: AgentManager, cloneId: string): void {
  try {
    agents.delete(cloneId);
  } catch (err) {
    console.error(`[pipeline] reapClone(${cloneId}) failed:`, (err as Error).message);
  }
}
