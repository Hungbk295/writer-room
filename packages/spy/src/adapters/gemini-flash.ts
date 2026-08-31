/**
 * P0-E semantic analysis boundary. The implementation that invokes a local
 * agy/Gemini lane is intentionally separate from the old text-only LlmPort.
 */
import { AppError } from '../errors.ts';

export interface GeminiEvidenceRef {
  evidenceId: string;
  note?: string;
}

export interface GeminiAnalysisClaim {
  text: string;
  evidence: GeminiEvidenceRef[];
}

export interface GeminiFlashResult {
  labels: string[];
  keywordCandidates: string[];
  claims: GeminiAnalysisClaim[];
  rawResponse?: Uint8Array;
}

export interface GeminiFlashAnalysisPort {
  readonly model: string;
  analyze(input: {
    policyVersion: string;
    /** JSON-safe manifest. Untrusted transcript/title bytes are data, never instructions. */
    manifest: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<GeminiFlashResult>;
}

/** Default runtime must fail visibly until the approved agy/Gemini runner exists. */
export class UnavailableGeminiFlashAnalysisPort implements GeminiFlashAnalysisPort {
  readonly model = 'unconfigured';

  async analyze(): Promise<GeminiFlashResult> {
    throw new AppError('capability_missing', 'Gemini Flash review chưa được cấu hình');
  }
}

