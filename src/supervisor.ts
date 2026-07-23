import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DurableJobRecord, JobAttemptRecord, RetryClass } from './domain.ts';
import { SCHEMA_VERSION } from './domain.ts';

export interface JobHeartbeat {
  jobId: string;
  status: 'starting' | 'running' | 'complete' | 'failed' | 'timed_out';
  pid?: number;
  updatedAt: string;
  lastOutputAt: string;
  outputBytes: number;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function logicalJobKey(kind: string, role: string, inputHash: string): string {
  const safeKind = kind.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return `${role}-${safeKind}-${inputHash.slice(0, 16)}`;
}

export function classifyFailure(errorValue: unknown): RetryClass {
  const message = (errorValue instanceof Error ? errorValue.message : String(errorValue)).toLowerCase();
  if (/cancelled|aborted/.test(message)) return 'cancelled';
  if (/unauthori[sz]ed|authentication|not logged in|login required|invalid api key|forbidden|permission denied|executable.+not found|enoent/.test(message)) {
    return 'permanent';
  }
  if (/3221225794|0xc0000142|status_dll_init_failed|dll initialization failed/.test(message)) return 'permanent';
  if (/valid json|schema|must provide|must be|references missing|truth risk|artifact conflict/.test(message)) return 'repairable';
  return 'transient';
}

export function createJobRecord(jobKey: string, inputHash: string, kind: string, role: DurableJobRecord['role']): DurableJobRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    jobKey,
    inputHash,
    kind,
    role,
    status: 'pending',
    attempts: [],
    updatedAt: new Date().toISOString(),
  };
}

export function appendAttempt(record: DurableJobRecord, attempt: JobAttemptRecord): DurableJobRecord {
  if (record.attempts.some((item) => item.id === attempt.id)) return record;
  return { ...record, status: 'running', attempts: [...record.attempts, attempt], updatedAt: new Date().toISOString() };
}

export function finishAttempt(record: DurableJobRecord, attemptId: string, retryClass: RetryClass, error = ''): DurableJobRecord {
  return {
    ...record,
    status: retryClass === 'permanent' ? 'action_required' : retryClass === 'cancelled' ? 'cancelled' : 'retrying',
    attempts: record.attempts.map((attempt) => attempt.id === attemptId ? {
      ...attempt,
      finishedAt: new Date().toISOString(),
      retryClass,
      ...(error ? { error } : {}),
    } : attempt),
    updatedAt: new Date().toISOString(),
  };
}

export function settleRecord(record: DurableJobRecord, resultHash: string): DurableJobRecord {
  return { ...record, status: 'settled', settledResultHash: resultHash, updatedAt: new Date().toISOString() };
}

export async function readHeartbeat(path: string): Promise<JobHeartbeat | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as JobHeartbeat; }
  catch { return null; }
}
