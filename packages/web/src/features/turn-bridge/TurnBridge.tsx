/** Mounts the turnBridge (SDD §5.1) once at app root. No visible UI — this
 * is invisible infrastructure, not a user-facing feature, per M0.5 scope. */
import { useEffect } from 'preact/hooks';
import { startTurnBridge } from './client.ts';

export function TurnBridge() {
  useEffect(() => startTurnBridge(), []);
  return null;
}
