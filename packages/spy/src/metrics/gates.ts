export const MIN_VIDEOS_FOR_DISTRIBUTION = 8;
export const MIN_VIDEOS_PER_COHORT = 3;
export const MIN_VIDEOS_FOR_TOKEN_LIFT = 3;
export const MIN_VIDEOS_FOR_CORRELATION = 12;

export type MetricMethod =
  | 'deterministic'
  | 'interpreted'
  | 'proxy'
  | 'unavailable'
  | 'insufficient_sample';

export interface MetricValue<T> {
  value: T | null;
  method: MetricMethod;
  reason?: string;
  have?: number;
  need?: number;
}

export function insufficientSample<T>(have: number, need: number): MetricValue<T> {
  return { value: null, method: 'insufficient_sample', have, need };
}

export function unavailable<T>(reason: string): MetricValue<T> {
  return { value: null, method: 'unavailable', reason };
}

export function deterministic<T>(value: T): MetricValue<T> {
  return { value, method: 'deterministic' };
}

export function proxy<T>(value: T): MetricValue<T> {
  return { value, method: 'proxy' };
}
