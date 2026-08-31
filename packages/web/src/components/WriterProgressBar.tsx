/**
 * Weighted Writer v2 progress — Director Board pattern.
 * Steps: STUDY → WRITE → GATE → EDIT → DONE. Role pill shows Author/Critic/Gate.
 */
import type { WriterRunV2, WriterV2ActiveRole, WriterV2Phase } from '../api.ts';

const STEPS: Array<{ id: string; label: string; phases: WriterV2Phase[] }> = [
  { id: 'study', label: '1. STUDY', phases: ['STUDY'] },
  { id: 'write', label: '2. WRITE', phases: ['WRITE'] },
  { id: 'gate', label: '3. GATE', phases: ['GATE'] },
  { id: 'edit', label: '4. EDIT', phases: ['EDIT_REVIEW', 'REPAIR'] },
  { id: 'done', label: '5. DONE', phases: ['DONE'] },
];

function stepState(
  step: (typeof STEPS)[number],
  run: Pick<WriterRunV2, 'status' | 'phase' | 'gateResults'>,
): 'pending' | 'active' | 'done' | 'error' {
  if (run.status === 'DONE' && run.phase === 'DONE') return 'done';

  const phase = run.phase;
  const stepIndex = STEPS.findIndex((s) => s.id === step.id);
  const activeIndex = STEPS.findIndex((s) => s.phases.includes(phase));

  if (run.status === 'FAILED_GATE' && step.id === 'gate') return 'error';
  if (run.status === 'FAILED' && step.phases.includes(phase)) return 'error';
  if (
    run.status === 'FAILED'
    && phase === 'FAILED'
    && step.id === 'write'
    && (run.gateResults?.length ?? 0) === 0
  ) {
    // Interrupted before/during WRITE often lands as phase FAILED.
    return 'error';
  }

  if (step.phases.includes(phase) && run.status === 'RUNNING') return 'active';
  if (step.phases.includes(phase) && (run.status === 'FAILED' || run.status === 'FAILED_GATE')) {
    return 'error';
  }

  if (activeIndex === -1) {
    // CONFIGURING / READY / FAILED without a mapped phase — nothing lit yet.
    if (phase === 'CONFIGURING' || phase === 'READY') return 'pending';
    if (phase === 'FAILED') {
      // Rough: treat earlier steps as done only when we clearly passed them.
      return 'pending';
    }
  }

  if (activeIndex > stepIndex) return 'done';
  if (activeIndex === stepIndex) {
    return run.status === 'RUNNING' ? 'active' : run.status === 'DONE' ? 'done' : 'pending';
  }
  return 'pending';
}

function fallbackProgress(run: Pick<WriterRunV2, 'status' | 'phase' | 'restyling'>): number {
  if (run.restyling) return 97;
  switch (run.phase) {
    case 'CONFIGURING': return 5;
    case 'READY': return 10;
    case 'STUDY': return 22;
    case 'WRITE': return 52;
    case 'GATE': return 75;
    case 'EDIT_REVIEW': return 85;
    case 'REPAIR': return 90;
    case 'DONE': return 100;
    case 'FAILED': return 40;
    default: return 0;
  }
}

function fallbackRole(
  run: Pick<WriterRunV2, 'status' | 'phase' | 'agentId' | 'editorAgentId' | 'restyling'>,
): WriterV2ActiveRole {
  if (run.restyling) return { kind: 'author', label: `Author: ${run.agentId}`, agentId: run.agentId };
  if (run.status !== 'RUNNING') return { kind: 'none', label: '—' };
  if (run.phase === 'EDIT_REVIEW') {
    return { kind: 'critic', label: `Critic: ${run.editorAgentId}`, agentId: run.editorAgentId };
  }
  if (run.phase === 'GATE') return { kind: 'gate', label: 'Gate' };
  if (run.phase === 'STUDY' || run.phase === 'WRITE' || run.phase === 'REPAIR') {
    return { kind: 'author', label: `Author: ${run.agentId}`, agentId: run.agentId };
  }
  return { kind: 'none', label: '—' };
}

export function WriterProgressBar({ run }: { run: WriterRunV2 }) {
  const percent = typeof run.progressPercent === 'number'
    ? Math.max(0, Math.min(100, run.progressPercent))
    : fallbackProgress(run);
  const role = run.activeRole ?? fallbackRole(run);
  const showBar = run.status !== 'DRAFT' || run.phase === 'READY';

  if (!showBar && run.phase === 'CONFIGURING') {
    return (
      <div class="writer-progress-container writer-progress-container--config">
        <div class="writer-progress-meta">
          <span class="muted">Chưa chạy — cấu hình post trước</span>
          <span class="writer-progress-percent">5%</span>
        </div>
        <div class="writer-progress-bar" role="progressbar" aria-valuenow={5} aria-valuemin={0} aria-valuemax={100}>
          <div class="writer-progress-fill" style={{ width: '5%' }} />
        </div>
      </div>
    );
  }

  return (
    <div class="writer-progress-container">
      <div class="writer-progress-meta">
        <span class={`writer-role-pill writer-role-pill--${role.kind}`}>{role.label}</span>
        <span class="writer-progress-percent">{Math.round(percent)}%</span>
      </div>
      <div
        class="writer-progress-bar"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Tiến độ Writer v2"
      >
        <div
          class={`writer-progress-fill${run.status === 'FAILED' || run.status === 'FAILED_GATE' ? ' writer-progress-fill--error' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <ol class="writer-stepper">
        {STEPS.map((step) => {
          const state = stepState(step, run);
          return (
            <li key={step.id} class={`writer-step-node writer-step-node--${state}`}>
              <span class="writer-step-dot" aria-hidden="true" />
              <span class="writer-step-label">{step.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
