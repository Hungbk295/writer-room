import { describe, expect, test } from 'bun:test';
import { classifyFailure, logicalJobKey, sha256 } from '../src/supervisor.ts';

describe('durable job supervision', () => {
  test('builds stable logical keys from the role, stage and input hash', () => {
    const hash = sha256('same prompt');
    expect(logicalJobKey('writer-r2', 'writer', hash)).toBe(logicalJobKey('writer-r2', 'writer', hash));
    expect(logicalJobKey('writer-r2', 'writer', hash)).not.toBe(logicalJobKey('editor-r2', 'editor', hash));
  });

  test('does not automatically retry permanent auth failures', () => {
    expect(classifyFailure(new Error('Unauthorized: login required'))).toBe('permanent');
    expect(classifyFailure(new Error('runner exit=3221225794 0xC0000142 STATUS_DLL_INIT_FAILED'))).toBe('permanent');
    expect(classifyFailure(new Error('output does not contain valid JSON'))).toBe('repairable');
    expect(classifyFailure(new Error('process exited 1 after timeout'))).toBe('transient');
  });
});
