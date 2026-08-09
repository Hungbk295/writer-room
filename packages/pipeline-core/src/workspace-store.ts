/**
 * Workspace artifact-commit primitive.
 *
 * This file implements ONLY the fsync + atomic-rename write primitive described in
 * SDD §5.2 "Commit rule (the truth rule)" step 6:
 *
 *   6. Otherwise: hash content -> write artifacts/{stage}-v{n}.json -> fsync ->
 *      atomically rename item-manifest.json -> emit event.
 *
 * It does NOT implement the full 6-branch commit rule (exit-code check, missing
 * output detection, schema validation, ungrounded-output check, sandbox-violation
 * detection). Those require a real turn runner and turn output to validate against
 * and belong to M0.5+ (lane-scheduler / turn-runner), not pipeline-core. A future
 * reader looking for turn-settlement logic should look there, not here.
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export interface Manifest {
  stage: string;
  version: number;
  artifactPath: string;
  hash: string;
  committedAt: string;
}

export interface CommitArtifactParams {
  runDir: string;
  stage: string;
  version: number;
  content: unknown;
}

export interface CommitArtifactResult {
  path: string;
  hash: string;
}

/** Write a file's content and fsync it before returning, so a crash right after cannot leave a torn write. */
async function writeFileSynced(path: string, content: string): Promise<void> {
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Write `artifacts/{stage}-v{n}.json`, fsync it, then atomically rename a manifest
 * tmp file over `item-manifest.json` so the manifest is never observably in a
 * half-written state (rename is atomic on POSIX).
 */
export async function commitArtifact(params: CommitArtifactParams): Promise<CommitArtifactResult> {
  const { runDir, stage, version, content } = params;
  await mkdir(runDir, { recursive: true });

  const artifactsDir = join(runDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });

  const fileName = `${stage}-v${version}.json`;
  const artifactPath = join(artifactsDir, fileName);
  const serialized = JSON.stringify(content, null, 2);
  const hash = createHash('sha256').update(serialized).digest('hex');

  await writeFileSynced(artifactPath, serialized);

  const manifest: Manifest = {
    stage,
    version,
    artifactPath: join('artifacts', fileName),
    hash,
    committedAt: new Date().toISOString(),
  };

  const manifestPath = join(runDir, 'item-manifest.json');
  const manifestTmpPath = `${manifestPath}.tmp`;
  await writeFileSynced(manifestTmpPath, JSON.stringify(manifest, null, 2));
  await rename(manifestTmpPath, manifestPath);

  return { path: artifactPath, hash };
}

export async function readManifest(runDir: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(runDir, 'item-manifest.json'), 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
