import { describe, expect, test } from 'bun:test';
import { describeLoopCapabilities } from '../../src/spy/loop-capabilities.ts';

describe('Spy P0 capability status', () => {
  test('does not present the legacy Data API loop as a yt-dlp P0 source', () => {
    const result = describeLoopCapabilities({
      spyFeatureEnabled: true,
      loopReady: true,
      schedulerReady: true,
      legacyDataApiConfigured: true,
      legacyAutoLoopEnabled: true,
      now: new Date('2026-08-24T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      phase: '0.1',
      readOnly: true,
      generatedAt: '2026-08-24T00:00:00.000Z',
    });
    expect(result.capabilities.find((item) => item.id === 'loop_runtime')?.state).toBe('available');
    expect(result.capabilities.find((item) => item.id === 'legacy_data_api')?.state).toBe('legacy');
    expect(result.capabilities.find((item) => item.id === 'p0_ytdlp_source')?.state).toBe('available');
    expect(result.capabilities.find((item) => item.id === 'legacy_scheduler')?.state).toBe('legacy');
  });

  test('reports a disabled legacy scheduler and missing key without inventing availability', () => {
    const result = describeLoopCapabilities({
      spyFeatureEnabled: true,
      loopReady: true,
      schedulerReady: true,
      legacyDataApiConfigured: false,
      legacyAutoLoopEnabled: false,
      now: new Date('2026-08-24T00:00:00.000Z'),
    });

    expect(result.capabilities.find((item) => item.id === 'legacy_data_api')?.state).toBe('not_configured');
    expect(result.capabilities.find((item) => item.id === 'legacy_scheduler')?.state).toBe('not_configured');
    expect(result.capabilities.find((item) => item.id === 'gemini_review')?.state).toBe('not_configured');
  });
});
