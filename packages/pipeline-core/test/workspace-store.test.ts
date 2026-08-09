import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitArtifact, readManifest } from '../src/workspace-store.ts';

let tempDir = '';

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function setupRunDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'pipeline-core-workspace-'));
  return join(tempDir, 'run');
}

describe('commitArtifact / readManifest (SDD §5.2 commit rule, step 6)', () => {
  test('writes the artifact and a manifest pointing at its hash/path', async () => {
    const runDir = await setupRunDir();
    const content = { rule: 'example', evidence: [{ locator: 'x', quote: 'y' }] };

    const result = await commitArtifact({ runDir, stage: 'ANALYZE', version: 1, content });

    const expectedSerialized = JSON.stringify(content, null, 2);
    const expectedHash = createHash('sha256').update(expectedSerialized).digest('hex');
    expect(result.hash).toBe(expectedHash);
    expect(result.path).toBe(join(runDir, 'artifacts', 'ANALYZE-v1.json'));

    const artifactOnDisk = await readFile(result.path, 'utf8');
    expect(artifactOnDisk).toBe(expectedSerialized);

    const manifest = await readManifest(runDir);
    expect(manifest).not.toBeNull();
    expect(manifest?.stage).toBe('ANALYZE');
    expect(manifest?.version).toBe(1);
    expect(manifest?.hash).toBe(expectedHash);
    expect(manifest?.artifactPath).toBe(join('artifacts', 'ANALYZE-v1.json'));
  });

  test('re-reading the manifest after a second commit returns the new version', async () => {
    const runDir = await setupRunDir();

    await commitArtifact({ runDir, stage: 'ANALYZE', version: 1, content: { n: 1 } });
    const afterFirst = await readManifest(runDir);
    expect(afterFirst?.version).toBe(1);

    const second = await commitArtifact({ runDir, stage: 'ANALYZE', version: 2, content: { n: 2 } });
    const afterSecond = await readManifest(runDir);
    expect(afterSecond?.version).toBe(2);
    expect(afterSecond?.hash).toBe(second.hash);
    expect(afterSecond?.artifactPath).toBe(join('artifacts', 'ANALYZE-v2.json'));

    // The first version's artifact file is untouched — only the manifest pointer moved.
    const firstArtifactStillPresent = await stat(join(runDir, 'artifacts', 'ANALYZE-v1.json'));
    expect(firstArtifactStillPresent.isFile()).toBe(true);
  });

  test('the manifest rename looks atomic: no leftover tmp file, final file has correct content', async () => {
    const runDir = await setupRunDir();
    await commitArtifact({ runDir, stage: 'ANALYZE', version: 1, content: { ok: true } });

    // The tmp file used for the atomic rename must not survive the commit.
    await expect(stat(join(runDir, 'item-manifest.json.tmp'))).rejects.toThrow();

    // The final manifest file must exist and parse.
    const raw = await readFile(join(runDir, 'item-manifest.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.stage).toBe('ANALYZE');
    expect(parsed.version).toBe(1);
  });

  test('readManifest returns null when no manifest has been committed yet', async () => {
    const runDir = await setupRunDir();
    expect(await readManifest(runDir)).toBeNull();
  });
});
