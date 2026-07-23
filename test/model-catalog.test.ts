import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAgentProfiles } from '../src/domain.ts';
import { loadModelCatalog } from '../src/model-catalog.ts';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('provider model catalog', () => {
  test('reads visible Codex models from the local cache in provider priority order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-models-'));
    dirs.push(root);
    const cache = join(root, 'models_cache.json');
    await writeFile(cache, JSON.stringify({
      models: [
        { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide', priority: 0 },
        { slug: 'second-model', display_name: 'Second', visibility: 'list', priority: 2 },
        { slug: 'first-model', display_name: 'First', visibility: 'list', priority: 1 },
      ],
    }));
    const catalog = loadModelCatalog([], cache);
    expect(catalog.codex.map((model) => model.id)).toEqual(['first-model', 'second-model']);
    expect(catalog.codex[0]?.source).toBe('local-cache');
    expect(catalog.claude.map((model) => model.id)).toEqual(['sonnet', 'opus', 'fable']);
    expect(catalog.gemini.map((model) => model.id)).toEqual(['auto', 'pro', 'flash', 'flash-lite']);
    expect(catalog.agy[0]).toMatchObject({ id: 'Gemini 3.5 Flash (High)', recommended: true });
  });

  test('keeps a configured custom model selectable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-models-'));
    dirs.push(root);
    const profiles = defaultAgentProfiles();
    profiles[0] = { ...profiles[0]!, model: 'claude-custom-preview' };
    const catalog = loadModelCatalog(profiles, join(root, 'missing-cache.json'));
    expect(catalog.claude.at(-1)).toMatchObject({ id: 'claude-custom-preview', source: 'configured' });
  });
});
