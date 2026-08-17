/**
 * `WRITER_READY_PROFILE` persistence — JSON-per-record under `trainingRoot()/profiles`,
 * a directory of its OWN, separate from `trainingRoot()/formulas` (`storage.ts`).
 *
 * ADR-FM10 (plan/writer-train/FORMULA-MIGRATION-TO-WRITER.md §1/§6): the boundary
 * between Training (Formula, source-bound) and Writer (Profile, migrated + human-
 * approved) is structural, not a runtime guard. A `kind` field discriminating one
 * shared store would let a Formula slip into a Profile-shaped read path by accident;
 * a separate directory + separate type means there is no query that can return a
 * Formula where a Profile is expected. Mirrors `storage.ts`'s formula functions
 * (`saveFormula`/`getFormula`/`listFormulas`/`deleteFormula`) 1:1 in shape — same
 * JSON-per-record idiom, same optional `dataDir` threading — deliberately NOT
 * unified into one module with `storage.ts`, for the same reason there are two
 * directories.
 */
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WriterReadyProfile } from '@writer-room/training-core';
import { ensureDir, trainingRoot } from '../paths.ts';

export interface ProfileSummary {
  id: string;
  version: number;
  label: string;
  readiness: WriterReadyProfile['readiness'];
  guidelineCount: number;
  createdAt: string;
}

function profilesDir(dataDir?: string): string {
  return join(trainingRoot(dataDir), 'profiles');
}

function profilePath(id: string, dataDir?: string): string {
  return join(profilesDir(dataDir), `${id}.json`);
}

export async function saveProfile(profile: WriterReadyProfile, dataDir?: string): Promise<void> {
  await ensureDir(profilesDir(dataDir));
  await writeFile(profilePath(profile.id, dataDir), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
}

export async function getProfile(id: string, dataDir?: string): Promise<WriterReadyProfile | null> {
  try {
    const raw = await readFile(profilePath(id, dataDir), 'utf8');
    return JSON.parse(raw) as WriterReadyProfile;
  } catch {
    return null;
  }
}

export async function listProfiles(dataDir?: string): Promise<ProfileSummary[]> {
  const root = profilesDir(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const summaries: ProfileSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(root, name), 'utf8');
      const profile = JSON.parse(raw) as WriterReadyProfile;
      summaries.push({
        id: profile.id,
        version: profile.version,
        label: profile.label,
        readiness: profile.readiness,
        guidelineCount: profile.guidelines.length,
        createdAt: profile.createdAt,
      });
    } catch {
      // skip corrupt
    }
  }
  // Tiebreak on `id` after the timestamp compare — two profiles published in the same
  // millisecond otherwise fall back to `readdir` order, which is not deterministic
  // (same flake `listFormulas`/`listStudioSessions` fixed for this exact reason).
  summaries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  return summaries;
}

/** Xoá file Profile. Formula/Studio session nguồn (nếu còn) không bị đụng tới. */
export async function deleteProfile(id: string, dataDir?: string): Promise<boolean> {
  try {
    await unlink(profilePath(id, dataDir));
    return true;
  } catch {
    return false;
  }
}
