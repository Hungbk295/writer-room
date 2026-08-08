/**
 * Spy is ON by default.
 * Opt-out: WRITER_ROOM_SPY_ENABLED=0
 */
export const SPY_FEATURE = {
  enabled: process.env.WRITER_ROOM_SPY_ENABLED !== '0',
  reason: process.env.WRITER_ROOM_SPY_ENABLED === '0'
    ? 'Disabled via WRITER_ROOM_SPY_ENABLED=0'
    : 'Enabled',
} as const;

export function assertSpyEnabled(action = 'Spy'): void {
  if (!SPY_FEATURE.enabled) {
    throw new Error(`${action} đang tắt (WRITER_ROOM_SPY_ENABLED=0).`);
  }
}
