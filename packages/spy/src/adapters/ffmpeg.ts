import {
  dhashFromGray9x8,
  dhashToHex,
  isDuplicateDhash,
  samplingTimestamps,
} from '../evidence/index.ts';
import type { SamplingPolicy } from '../schema.ts';
import { requireSuccessfulProcess } from './process.ts';

export interface FrameExtractionResult {
  frames: Array<{
    timestampSec: number;
    dhash: string;
    bytes: Buffer;
    mimeType: string;
  }>;
  status: 'ok' | 'low_variance';
  attemptedTimestamps: number[];
}

export interface MediaPort {
  extractFrames(input: {
    source: string;
    durationSec: number;
    sampling: SamplingPolicy;
    signal?: AbortSignal;
  }): Promise<FrameExtractionResult>;
}

export class FfmpegAdapter implements MediaPort {
  constructor(private readonly binary = 'ffmpeg') {}

  private async jpeg(source: string, timestampSec: number, signal?: AbortSignal): Promise<Buffer> {
    const result = await requireSuccessfulProcess(
      this.binary,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', timestampSec.toFixed(3),
        '-i', source,
        '-frames:v', '1',
        '-vf', 'scale=1280:-2',
        '-q:v', '4',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-',
      ],
      { signal, timeoutMs: 60_000, maximumStdoutBytes: 12 * 1024 * 1024 },
    );
    return result.stdout;
  }

  private async dhashFromSource(source: string, timestampSec: number, signal?: AbortSignal): Promise<bigint> {
    const result = await requireSuccessfulProcess(
      this.binary,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', timestampSec.toFixed(3),
        '-i', source,
        '-frames:v', '1',
        '-vf', 'scale=9:8,format=gray',
        '-f', 'rawvideo',
        '-pix_fmt', 'gray',
        '-',
      ],
      { signal, timeoutMs: 60_000, maximumStdoutBytes: 1024 },
    );
    return dhashFromGray9x8(result.stdout);
  }

  async extractFrames(input: {
    source: string;
    durationSec: number;
    sampling: SamplingPolicy;
    signal?: AbortSignal;
  }): Promise<FrameExtractionResult> {
    const timestamps = samplingTimestamps(input.durationSec, input.sampling);
    const hashes: bigint[] = [];
    const frames: FrameExtractionResult['frames'] = [];
    for (const timestampSec of timestamps) {
      if (input.signal?.aborted) break;
      const [jpeg, hash] = await Promise.all([
        this.jpeg(input.source, timestampSec, input.signal),
        this.dhashFromSource(input.source, timestampSec, input.signal),
      ]);
      if (isDuplicateDhash(hash, hashes, input.sampling.dhashThreshold)) continue;
      hashes.push(hash);
      frames.push({
        timestampSec,
        dhash: dhashToHex(hash),
        bytes: jpeg,
        mimeType: 'image/jpeg',
      });
    }
    return {
      frames,
      status: frames.length >= Math.max(1, Math.ceil(input.sampling.frameCount * 0.5))
        ? 'ok'
        : 'low_variance',
      attemptedTimestamps: timestamps,
    };
  }
}
