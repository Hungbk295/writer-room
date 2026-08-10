/**
 * turnBridge (SDD §5.1, P-DEF-1b) — the client-side glue between the
 * daemon's SSE team-event stream (`GET /api/team/events`) and the Tauri PTY
 * client (`terminalApi.ts` / `terminalStore.ts`). Framework-agnostic: no
 * Preact imports here, see `TurnBridge.tsx` for the mount point.
 *
 * The bridge is the ONLY `spawnTurn` consumer (SDD §5.1). It never
 * re-interprets the job — it launches exactly one read-only pane per
 * turnId and reports settlement back to the daemon.
 *
 * Known M0.5-scope gaps (intentional, not bugs — see task brief / SDD §5.1):
 *
 *  1. No reconnect replay. `EventSource` reconnects automatically on a
 *     transport drop, and on every `onopen` we re-sync via
 *     `GET /api/team/status`. But that endpoint returns workflow/agent
 *     summaries, not the `spawnTurn` payload (spec/env/etc) needed to
 *     relaunch a pane. `/api/team/events` has no `?cursor=` support (unlike
 *     the pipeline event log planned in §5.7, which doesn't exist yet), so
 *     any `spawnTurn` emitted while disconnected is simply missed. There is
 *     no way to build real replay against the backend as it exists today.
 *
 *  2. No cross-reload turn-launch dedup. `claimed` (below) is in-memory and
 *     only prevents double-launch within one page session. A full page
 *     reload loses it — if a turn is still running server-side, a fresh
 *     bridge instance has no record of it and nothing here currently stops
 *     it from being launched again should the daemon replay it. Fixing this
 *     properly needs server-side "this turn already has a live pane"
 *     tracking, which doesn't exist. Accepted known gap for M0.5.
 *
 *  3. No launch-failure reporting. If `terminals.launchTab` rejects, there
 *     is no daemon route to report "spawn failed" (only `turn/complete`,
 *     which needs a real exit). We log to console and drop our claim; the
 *     turn will simply never settle from this client's point of view.
 */
import type { TeamEvent } from '@writer-room/shared/terminal';
import { b64ToBytes, isTauri, onTermExit, termKill, termSnapshot } from '../../components/terminal/terminalApi.ts';
import { terminals } from '../../components/terminal/terminalStore.ts';

type SpawnTurnEvent = Extract<TeamEvent, { kind: 'spawnTurn' }>;

/**
 * Session-id capture (added 2026-08-09, SDD §12a session-continuity fix). A resumed
 * turn needs the daemon to know the prior turn's CLI session id — `turn/complete`
 * accepts an optional `resumeSessionRef` for exactly this, but nothing here ever
 * populated it before now, so `store.resumeRef(agentId)` (daemon-side) always found
 * nothing and every turn ran fresh regardless of clone-id reuse.
 *
 * All four CLIs print their session id as plain text near the very start (or, for
 * grok/agy, the very end) of output — verified for real against the actual binaries,
 * not guessed:
 *  - Claude Code (`--output-format stream-json`): a JSON line containing
 *    `"session_id":"<uuid>"` (present on effectively every emitted event).
 *  - Codex (`codex exec` / `codex exec resume`): a banner line `session id: <uuid>`.
 *  - Grok (`--output-format json`, added 2026-08-10): a single JSON object at the
 *    end of output containing `"sessionId":"<uuid>"` (camelCase — a DIFFERENT key
 *    name from Claude's `session_id`, needs its own pattern).
 *  - Agy (`--output-format json`, added 2026-08-10): a single JSON object
 *    containing `"conversation_id":"<uuid>"`.
 * First match wins; extraction is opportunistic (checked on the first available
 * snapshot right after launch, then again on every heartbeat poll until found) since
 * the ring buffer may not have flushed anything in the first instant after spawn.
 */
const SESSION_ID_PATTERNS = [
  /"session_id"\s*:\s*"([0-9a-fA-F-]{8,})"/,
  /^session id:\s*([0-9a-fA-F-]{8,})/m,
  /"sessionId"\s*:\s*"([0-9a-fA-F-]{8,})"/,
  /"conversation_id"\s*:\s*"([0-9a-fA-F-]{8,})"/,
];

function decodeSnapshotText(data: string): string {
  return new TextDecoder().decode(b64ToBytes(data));
}

function extractSessionId(text: string): string | null {
  for (const pattern of SESSION_ID_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Pane reuse (added 2026-08-10, ported from dna-spy's `client/src/components/agents/
 * turnBridge.ts` "Nhánh 2" — same problem, same fix). Session continuity (above) only
 * resumes the underlying CLI's own conversation context; `handleSpawnTurn` still
 * unconditionally opened a BRAND NEW read-only pane/tab for every turn regardless of
 * clone-id reuse, so a 3-round Training Lab run (2 agent identities: DRAFT and
 * CRITIQUE+REFINE sharing one each, §12a `training-lab.ts`) still left ~10 dead tabs
 * in the drawer — one per turn, not one per agent. `paneByAgent` tracks the most
 * recent pane per `agentId`; `closeExistingPanesForAgent` closes it (and any other
 * stray read-only tab for that agent found by scanning `tabs`, belt-and-suspenders
 * like the dna-spy original) right before launching a new one. Same-agent turns are
 * dispatched sequentially by the pipeline scheduler (a new round's turn only starts
 * after the previous round's has already settled), so the "old" pane is virtually
 * always already exited — this mainly just removes it from the drawer instead of
 * leaving a dead tab behind; the `closeTab`/`termKill` call is a no-op-but-safe path
 * for the rare case it is somehow still alive.
 */
const paneByAgent = new Map<string, string>();

async function closeExistingPanesForAgent(agentId: string): Promise<void> {
  const stale = new Set<string>();
  for (const tab of terminals.getState().tabs) {
    if (tab.agentId === agentId && tab.readOnly) stale.add(tab.sessionId);
  }
  const mapped = paneByAgent.get(agentId);
  if (mapped) stale.add(mapped);
  paneByAgent.delete(agentId);
  for (const sessionId of stale) {
    try {
      await terminals.closeTab(sessionId);
    } catch (err) {
      console.error('[turnBridge] closeTab failed while clearing old pane for', agentId, err);
    }
  }
}

function postJson(path: string, body: unknown): void {
  void fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (!res.ok) console.error(`[turnBridge] POST ${path} failed`, res.status);
    })
    .catch((err) => console.error(`[turnBridge] POST ${path} failed`, err));
}

/**
 * Starts the bridge. Returns a teardown function that closes the SSE
 * connection, clears heartbeat timers, and unsubscribes listeners.
 *
 * No-op outside the Tauri shell — there is no PTY backend in a plain
 * browser dev session, so the bridge would have nothing to drive.
 */
export function startTurnBridge(): () => void {
  if (!isTauri()) {
    return () => {};
  }

  // Turns this bridge instance has already launched a pane for.
  const claimed = new Set<number>();
  // turnId -> the pane's Tauri PTY session id (needed to route
  // terminal://exit back to turn/complete, and for heartbeat polling).
  const turnIdToSessionId = new Map<number, string>();
  // turnId -> last ring-buffer sequence number seen, for heartbeat diffing.
  const lastSeenSequence = new Map<number, number>();
  const heartbeatIntervals = new Map<number, ReturnType<typeof setInterval>>();
  // turnId -> CLI session id, once found in the pane's output (see extractSessionId).
  const sessionIdByTurn = new Map<number, string>();

  function stopHeartbeat(turnId: number): void {
    const h = heartbeatIntervals.get(turnId);
    if (h !== undefined) {
      clearInterval(h);
      heartbeatIntervals.delete(turnId);
    }
    lastSeenSequence.delete(turnId);
  }

  function captureSessionIdIfMissing(turnId: number, snap: { data: string }): void {
    if (sessionIdByTurn.has(turnId)) return;
    const found = extractSessionId(decodeSnapshotText(snap.data));
    if (found) sessionIdByTurn.set(turnId, found);
  }

  function startHeartbeat(turnId: number, sessionId: string): void {
    const interval = setInterval(() => {
      void termSnapshot(sessionId)
        .catch(() => null)
        .then((snap) => {
          if (!snap) return;
          captureSessionIdIfMissing(turnId, snap);
          const prev = lastSeenSequence.get(turnId);
          if (prev !== snap.sequence) {
            lastSeenSequence.set(turnId, snap.sequence);
            postJson('/api/team/turn/heartbeat', { turnId });
          }
        });
    }, 10_000);
    heartbeatIntervals.set(turnId, interval);
  }

  async function handleSpawnTurn(event: SpawnTurnEvent): Promise<void> {
    // `interactiveRequired` marks the existing Board-loop "inject into an
    // already-open pane" path (persistent-pane wake-up), not a pipeline
    // turn. That path predates this bridge and is out of scope for a
    // read-only pipeline bridge — skip entirely: don't launch, don't claim.
    if (event.interactiveRequired) return;
    if (claimed.has(event.turnId)) return; // already launched, defend against dup delivery
    claimed.add(event.turnId);
    try {
      await closeExistingPanesForAgent(event.agentId);
      const sessionId = await terminals.launchTab({
        executable: event.spec.executable,
        args: event.spec.args,
        cwd: event.spec.cwd,
        env: event.spec.env,
        agentId: event.agentId,
        readOnly: true, // §5.1: pipeline turns are read-only headless panes
        title: `${event.agentId} · ${event.spec.mode}`,
        turnId: event.turnId,
      });
      paneByAgent.set(event.agentId, sessionId);
      turnIdToSessionId.set(event.turnId, sessionId);
      startHeartbeat(event.turnId, sessionId);
      // Best-effort early capture — the session id line is usually the very first
      // thing a CLI prints, so don't wait for the first 10s heartbeat tick if a
      // snapshot is already available right after launch.
      void termSnapshot(sessionId).then((snap) => captureSessionIdIfMissing(event.turnId, snap)).catch(() => {});
    } catch (err) {
      claimed.delete(event.turnId);
      console.error('[turnBridge] launchTab failed for turn', event.turnId, err);
    }
  }

  async function killOwnedTurn(turnId: number): Promise<void> {
    const sessionId = turnIdToSessionId.get(turnId);
    if (!sessionId) return; // not owned by this bridge instance
    try {
      await termKill(sessionId);
      // terminal://exit fires on any process death (including killed-by-
      // signal); the exit listener below reports turn/complete. Do not
      // also report it here — that would double-report.
    } catch (err) {
      console.error('[turnBridge] termKill failed for turn', turnId, err);
    }
  }

  function handleEvent(event: TeamEvent): void {
    switch (event.kind) {
      case 'spawnTurn':
        void handleSpawnTurn(event);
        break;
      case 'turnTimeout':
        if (turnIdToSessionId.has(event.turnId)) void killOwnedTurn(event.turnId);
        break;
      case 'interrupt':
        for (const turnId of event.turnIds) {
          if (turnIdToSessionId.has(turnId)) void killOwnedTurn(turnId);
        }
        break;
      case 'message':
      case 'turnSettled':
      case 'agentPaused':
      case 'guard':
      case 'stopAll':
        // Board-loop/UI concerns. The bridge REPORTS settlement via
        // turn/complete; it doesn't need to react to the daemon's own
        // settlement broadcast.
        break;
      default:
        break;
    }
  }

  const es = new EventSource('/api/team/events');

  es.onopen = () => {
    // Re-sync on (re)connect. See gap (1) in the module doc comment: there
    // is no spawnTurn replay endpoint, so this is best-effort/no-op today —
    // kept as the documented hook point for when a richer re-sync exists.
    void fetch('/api/team/status').catch(() => null);
  };

  es.onmessage = (ev) => {
    let event: TeamEvent;
    try {
      event = JSON.parse(ev.data) as TeamEvent;
    } catch {
      return; // defensive: malformed line, ignore
    }
    handleEvent(event);
  };

  let unlistenExit: (() => void) | null = null;
  void onTermExit((e) => {
    if (e.turnId == null || !claimed.has(e.turnId)) return;
    claimed.delete(e.turnId);
    stopHeartbeat(e.turnId);
    turnIdToSessionId.delete(e.turnId);
    const resumeSessionRef = sessionIdByTurn.get(e.turnId);
    sessionIdByTurn.delete(e.turnId);
    postJson('/api/team/turn/complete', {
      turnId: e.turnId,
      exitCode: e.exitCode ?? null,
      ...(resumeSessionRef ? { resumeSessionRef } : {}),
    });
  }).then((unlisten) => {
    unlistenExit = unlisten;
  });

  const onBeforeUnload = () => {
    // Best-effort only (SDD §5.1: "so nothing is left half-running", not a
    // guarantee) — beforeunload cannot reliably await a fetch.
    for (const turnId of claimed) {
      const body = JSON.stringify({ turnId });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/team/interrupt', new Blob([body], { type: 'application/json' }));
      } else {
        void fetch('/api/team/interrupt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  return () => {
    es.close();
    for (const turnId of [...heartbeatIntervals.keys()]) stopHeartbeat(turnId);
    window.removeEventListener('beforeunload', onBeforeUnload);
    unlistenExit?.();
  };
}
