/**
 * Agent harness composition: AgentManager + TeamWorkflow + McpTeamServer + SSE fan-out.
 */
import { join } from 'node:path';
import type { AgentDefinition, McpServerInfo } from '@writer-room/shared';
import { AgentConfigStore } from './agents/config.ts';
import { ensureDefaultAgents } from './agents/defaults.ts';
import { AgentManager } from './agents/index.ts';
import { openTeamDb } from './team/db.ts';
import { McpTeamServer } from './team/mcp.ts';
import { TeamStore } from './team/store.ts';
import { TeamWorkflow, type TeamEvent, type TurnJob } from './team/workflow.ts';
import { APP_ROOT, dataRoot, ensureDir } from './paths.ts';

export type { TeamEvent, TurnJob };

export interface AgentHarness {
  agents: AgentManager;
  config: AgentConfigStore;
  store: TeamStore;
  workflow: TeamWorkflow;
  mcp: McpTeamServer;
  teamMcpInfo: () => McpServerInfo | null;
  subscribe(listener: (event: TeamEvent) => void): () => void;
  emit(event: TeamEvent): void;
  listAgents(): AgentDefinition[];
  dispose(): void;
}

export async function createAgentHarness(opts?: {
  dataDir?: string;
  defaultProjectRoot?: string;
}): Promise<AgentHarness> {
  const dataDir = opts?.dataDir ?? dataRoot();
  await ensureDir(dataDir);
  await ensureDir(join(dataDir, 'agents'));
  await ensureDir(join(dataDir, 'workspaces'));

  const projectRoot = opts?.defaultProjectRoot ?? APP_ROOT;
  const config = new AgentConfigStore(dataDir);
  ensureDefaultAgents(config, projectRoot);

  const db = openTeamDb(join(dataDir, 'team.sqlite'));
  const store = new TeamStore(db);
  store.reconcileStale();

  const listeners = new Set<(event: TeamEvent) => void>();
  const emit = (event: TeamEvent) => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* isolate bad listeners */ }
    }
  };

  let mcpInfo: McpServerInfo | null = null;
  let workflow!: TeamWorkflow;

  const mcp = new McpTeamServer(
    store,
    (msg) => { workflow.handleNewMessage(msg); },
    (req) => {
      workflow.completeInteractiveTurn(req.turnId, req.agentId, req.status, req.summary);
    },
  );

  const agents = new AgentManager(
    config,
    dataDir,
    () => mcpInfo,
    () => null,
    () => [join(dataDir, 'workspaces')],
  );

  workflow = new TeamWorkflow({
    store,
    agents,
    guards: () => config.guards(),
    emit,
  });

  const info = await mcp.start();
  mcpInfo = info;

  return {
    agents,
    config,
    store,
    workflow,
    mcp,
    teamMcpInfo: () => mcpInfo,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit,
    listAgents: () => agents.list(),
    dispose() {
      mcp.stop();
      db.close();
      listeners.clear();
    },
  };
}
