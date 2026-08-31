/**
 * Read-only truth surface for the staged Spy P0 rollout.
 *
 * This module deliberately does not inspect, start, or reconfigure a collector.
 * Its job is to prevent the UI from presenting an existing legacy loop as the
 * planned yt-dlp-first P0 workflow.
 */

export type LoopCapabilityState = 'available' | 'unavailable' | 'legacy' | 'not_configured';

export interface LoopCapability {
  id: string;
  label: string;
  state: LoopCapabilityState;
  detail: string;
}

export interface LoopCapabilityStatus {
  phase: '0.1';
  readOnly: true;
  generatedAt: string;
  capabilities: LoopCapability[];
}

export interface LoopCapabilityInputs {
  spyFeatureEnabled: boolean;
  loopReady: boolean;
  schedulerReady: boolean;
  legacyDataApiConfigured: boolean;
  legacyAutoLoopEnabled: boolean;
  now?: Date;
}

/**
 * Map only facts already known by the daemon.  P0's local corpus/yt-dlp plane
 * is implemented independently of the legacy LoopRunner. Browser C3 and the
 * agy/Gemini runner remain deliberately not-configured until their approved
 * ports are wired; the legacy Data API is never a fallback for either.
 */
export function describeLoopCapabilities(input: LoopCapabilityInputs): LoopCapabilityStatus {
  const runtimeState: LoopCapabilityState = input.spyFeatureEnabled && input.loopReady
    ? 'available'
    : 'unavailable';
  const schedulerState: LoopCapabilityState = !input.spyFeatureEnabled || !input.schedulerReady
    ? 'unavailable'
    : input.legacyAutoLoopEnabled
      ? 'legacy'
      : 'not_configured';
  const dataApiState: LoopCapabilityState = input.legacyDataApiConfigured
    ? 'legacy'
    : 'not_configured';

  return {
    phase: '0.1',
    readOnly: true,
    generatedAt: (input.now ?? new Date()).toISOString(),
    capabilities: [
      {
        id: 'loop_runtime',
        label: 'Loop runtime hiện tại',
        state: runtimeState,
        detail: runtimeState === 'available'
          ? 'Topics, inbox, report và dry-run đang có runtime trên daemon.'
          : 'Spy Loop chưa được khởi tạo trong daemon hiện tại.',
      },
      {
        id: 'p0_ytdlp_source',
        label: 'Nguồn P0: yt-dlp-first',
        state: input.spyFeatureEnabled ? 'available' : 'unavailable',
        detail: input.spyFeatureEnabled
          ? 'P0 enrich dùng yt-dlp trực tiếp và không gọi Data API. Loop legacy vẫn là workflow riêng.'
          : 'Spy đang tắt nên P0 source không dùng được.',
      },
      {
        id: 'legacy_data_api',
        label: 'Đường Data API cũ',
        state: dataApiState,
        detail: input.legacyDataApiConfigured
          ? 'Loop legacy vẫn có Data API key. Đây là capability deferred, không phải fallback của P0.'
          : 'Loop legacy có đường Data API nhưng chưa có key khả dụng; P0 không được dựa vào nó.',
      },
      {
        id: 'confirmed_corpus_import',
        label: 'Corpus import draft → confirm',
        state: input.spyFeatureEnabled ? 'available' : 'unavailable',
        detail: input.spyFeatureEnabled
          ? 'P0 có batch draft → confirm tách khỏi candidate/Inbox legacy; daemon local dùng subject local-desktop.'
          : 'Spy đang tắt nên không thể tạo corpus draft.',
      },
      {
        id: 'direct_suggestions',
        label: 'C3 gợi ý trực tiếp giới hạn',
        state: 'not_configured',
        detail: 'Contract C3 depth 1/≤20 và review UI đã có, nhưng browser capture persona chưa được cấu hình. Không có yt-dlp/Data API fallback.',
      },
      {
        id: 'selected_item_enrichment',
        label: 'Enrich transcript / thumbnail P0',
        state: input.spyFeatureEnabled ? 'available' : 'unavailable',
        detail: input.spyFeatureEnabled
          ? 'Confirmed P0 item có thể enrich metadata/transcript/thumbnail qua yt-dlp, với expiry/tombstone 30 ngày.'
          : 'Spy đang tắt nên không thể enrich P0 corpus.',
      },
      {
        id: 'gemini_review',
        label: 'Gemini Flash evidence review',
        state: 'not_configured',
        detail: 'Analysis manifest/schema review-only đã có; agy/Gemini Flash port chưa được cấu hình. Không có LLM/Data API fallback.',
      },
      {
        id: 'legacy_scheduler',
        label: 'Lịch chạy tự động hiện tại',
        state: schedulerState,
        detail: schedulerState === 'legacy'
          ? 'Scheduler đang bật nhưng chỉ điều khiển loop legacy; chưa được phép coi là scheduler P0.'
          : schedulerState === 'not_configured'
            ? 'Scheduler có trong daemon nhưng đang tắt trong config/spy-loop.json.'
            : 'Scheduler chưa có runtime để chạy.',
      },
    ],
  };
}
