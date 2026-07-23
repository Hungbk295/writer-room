import type { Orchestrator } from './orchestrator.ts';

type Params = Record<string, unknown>;

function params(value: unknown): Params {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Params : {};
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export async function handleRpc(orchestrator: Orchestrator, method: string, rawParams?: unknown): Promise<unknown> {
  const value = params(rawParams);
  if (method === 'health') return orchestrator.health();
  if (method === 'models.list') return orchestrator.models();
  if (method === 'prompts.defaults') return orchestrator.promptDefaults();
  if (method === 'agents.list') return orchestrator.agents();
  if (method === 'agents.save') return orchestrator.saveAgents(value.agents);
  if (method === 'runs.list') return orchestrator.store.listStates();
  if (method === 'runs.create') return orchestrator.create(value);
  if (method === 'runs.get') return orchestrator.store.details(string(value.id, 'id'));
  if (method === 'runs.logs') return orchestrator.store.recentLogs(string(value.id, 'id'));
  if (method === 'runs.cancel') return orchestrator.cancel(string(value.id, 'id'));
  if (method === 'runs.rerun') return orchestrator.rerun(string(value.id, 'id'));
  if (method === 'runs.retry') return orchestrator.retry(string(value.id, 'id'));
  if (method === 'runs.retry-snapshot') return orchestrator.retrySnapshot(string(value.id, 'id'));
  if (method === 'runs.retry-current-agent') return orchestrator.retryWithCurrentAgent(string(value.id, 'id'));
  if (method === 'runs.human') return orchestrator.submitHuman(string(value.id, 'id'), value.brief);
  if (method === 'runs.continue') return orchestrator.continueRound(string(value.id, 'id'), value.note);
  if (method === 'runs.accept') return orchestrator.acceptCurrent(string(value.id, 'id'), value.reason);
  if (method === 'runs.export-draft' || method === 'runs.exportDraft') return orchestrator.exportDraft(string(value.id, 'id'), (value.round ?? 'init') as string | number);
  if (method === 'articles.list') return orchestrator.articles(typeof value.query === 'string' ? value.query : '', Boolean(value.includeArchived));
  if (method === 'articles.get') return orchestrator.article(string(value.id, 'id'));
  if (method === 'articles.export') return orchestrator.exportArticle(string(value.id, 'id'));
  if (method === 'articles.backup') return orchestrator.backupLibrary();
  if (method === 'articles.archive') {
    orchestrator.archiveArticle(string(value.id, 'id'), value.archived !== false);
    return { ok: true };
  }
  throw new Error(`unknown method: ${method}`);
}
