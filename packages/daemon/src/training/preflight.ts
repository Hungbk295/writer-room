/**
 * Formula Discovery preflight (SDD §7.2, §6.1 step 2-3).
 *
 * Runs before the Start button enables: agent binary detected, transcript
 * present/non-empty, channel resolvable from the Spy snapshot (never from the
 * agent — SDD §6.1 step 2: "Channel identity comes from the Spy snapshot, never
 * from the agent").
 */
import type { SpyService } from '@writer-room/spy';
import type { AgentManager } from '../agents/index.ts';

export type PreflightBlockerCode = 'INPUT_MISSING_TRANSCRIPT' | 'INPUT_NO_CHANNEL' | 'AGENT_UNAVAILABLE';

export interface PreflightBlocker {
  code: PreflightBlockerCode;
  message: string;
}

export interface PreflightResult {
  ready: boolean;
  blockers: PreflightBlocker[];
  channelTitle: string | null;
  transcriptSegmentCount: number;
}

/** Which configured agent is the Training ANALYZE stage's author (SDD §6.1: Claude). */
const ANALYZE_TEMPLATE_ID = 'claude';

export async function preflightVideo(
  spy: SpyService,
  agents: AgentManager,
  videoSnapshotId: string,
): Promise<PreflightResult> {
  const blockers: PreflightBlocker[] = [];

  // Channel identity comes from the Spy snapshot directly (spy.store mirrors the
  // access path the existing `/api/spy/snapshots/:id/...` routes already use —
  // see packages/daemon/src/http.ts's thumbnail/transcript routes).
  const snapshot = spy.store.getVideoSnapshot(videoSnapshotId);
  const channelTitle = snapshot?.channelTitle?.trim() || null;
  if (!snapshot || !channelTitle) {
    blockers.push({ code: 'INPUT_NO_CHANNEL', message: 'Chưa xác định được channel' });
  }

  // Transcript blocker: either the snapshot's own status says it isn't ready, or a
  // 1-row probe fetch comes back empty.
  let transcriptSegmentCount = 0;
  if (snapshot) {
    if (snapshot.transcriptStatus !== 'ok') {
      blockers.push({ code: 'INPUT_MISSING_TRANSCRIPT', message: 'Video chưa có transcript' });
    } else {
      const probe = spy.getTranscript(videoSnapshotId, 0, 1);
      transcriptSegmentCount = probe.meta.count;
      if (probe.meta.count === 0) {
        blockers.push({ code: 'INPUT_MISSING_TRANSCRIPT', message: 'Video chưa có transcript' });
      }
    }
  }

  // Agent blocker: the ANALYZE stage's template agent binary must be detectable.
  try {
    const template = agents.get(ANALYZE_TEMPLATE_ID);
    const availability = await agents.detect(template.adapter, template.executable);
    if (availability.found !== true) {
      blockers.push({ code: 'AGENT_UNAVAILABLE', message: 'Không tìm thấy Claude CLI' });
    }
  } catch {
    blockers.push({ code: 'AGENT_UNAVAILABLE', message: 'Không tìm thấy Claude CLI' });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    channelTitle,
    transcriptSegmentCount,
  };
}
