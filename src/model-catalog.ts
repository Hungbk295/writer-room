import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, AgentProfile } from './domain.ts';

export interface ModelOption {
  id: string;
  label: string;
  source: 'alias' | 'local-cache' | 'configured' | 'fallback';
  recommended?: boolean;
}

export type ModelCatalog = Record<AgentAdapter, ModelOption[]>;

interface CodexCacheModel {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

interface CodexModelCache {
  models?: CodexCacheModel[];
}

const CLAUDE_MODELS: ModelOption[] = [
  { id: 'sonnet', label: 'Sonnet (latest)', source: 'alias', recommended: true },
  { id: 'opus', label: 'Opus (latest)', source: 'alias' },
  { id: 'fable', label: 'Fable (latest)', source: 'alias' },
];

const GEMINI_MODELS: ModelOption[] = [
  { id: 'auto', label: 'Auto (recommended)', source: 'alias', recommended: true },
  { id: 'pro', label: 'Pro (latest)', source: 'alias' },
  { id: 'flash', label: 'Flash (latest)', source: 'alias' },
  { id: 'flash-lite', label: 'Flash Lite (latest)', source: 'alias' },
];

// Keep these aliases aligned with DNA Spy's proven Agy agent configuration.
const AGY_MODELS: ModelOption[] = [
  { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)', source: 'alias', recommended: true },
];

// Used only when Codex has not populated its local model cache yet.
const CODEX_FALLBACK: ModelOption[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', source: 'fallback', recommended: true },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', source: 'fallback' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', source: 'fallback' },
  { id: 'gpt-5.5', label: 'GPT-5.5', source: 'fallback' },
  { id: 'gpt-5.4', label: 'GPT-5.4', source: 'fallback' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', source: 'fallback' },
];

function codexModels(path: string): ModelOption[] {
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8')) as CodexModelCache;
    return (cache.models || [])
      .filter((model) => model.visibility === 'list' && typeof model.slug === 'string' && model.slug.trim())
      .sort((left, right) => {
        const a = typeof left.priority === 'number' ? left.priority : Number.MAX_SAFE_INTEGER;
        const b = typeof right.priority === 'number' ? right.priority : Number.MAX_SAFE_INTEGER;
        return a - b;
      })
      .map((model, index) => ({
        id: (model.slug as string).trim(),
        label: typeof model.display_name === 'string' && model.display_name.trim()
          ? model.display_name.trim()
          : (model.slug as string).trim(),
        source: 'local-cache' as const,
        ...(index === 0 ? { recommended: true } : {}),
      }));
  } catch {
    return [];
  }
}

function includeConfigured(options: ModelOption[], profiles: AgentProfile[], adapter: AgentAdapter): ModelOption[] {
  const result = [...options];
  for (const profile of profiles) {
    const model = profile.adapter === adapter ? profile.model.trim() : '';
    if (model && !result.some((option) => option.id === model)) {
      result.push({ id: model, label: `${model} (đang cấu hình)`, source: 'configured' });
    }
  }
  return result;
}

export function loadModelCatalog(
  profiles: AgentProfile[] = [],
  cachePath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'),
): ModelCatalog {
  const localCodex = codexModels(cachePath);
  return {
    claude: includeConfigured(CLAUDE_MODELS, profiles, 'claude'),
    codex: includeConfigured(localCodex.length ? localCodex : CODEX_FALLBACK, profiles, 'codex'),
    gemini: includeConfigured(GEMINI_MODELS, profiles, 'gemini'),
    agy: includeConfigured(AGY_MODELS, profiles, 'agy'),
    mock: includeConfigured([{ id: 'mock', label: 'Mock', source: 'alias' }], profiles, 'mock'),
  };
}
