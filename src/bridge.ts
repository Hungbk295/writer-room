import { createInterface } from 'node:readline';
import { AgentSettingsStore } from './agents.ts';
import { NativeTerminalController } from './native-terminal.ts';
import { Orchestrator } from './orchestrator.ts';
import { handleRpc } from './rpc.ts';
import { RunStore } from './store.ts';

interface BridgeRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const terminal = new NativeTerminalController((event, payload) => send({ type: 'event', event, payload }));
const store = new RunStore(undefined, (state) => send({ type: 'event', event: 'run.state', payload: { runId: state.id, revision: state.revision, state } }));
const orchestrator = new Orchestrator(store, process.env.WRITER_ROOM_MOCK === '1', new AgentSettingsStore(), terminal);
await orchestrator.init();
send({ type: 'event', event: 'engine.ready', payload: { pid: process.pid, dataRoot: orchestrator.store.root } });

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  void (async () => {
    let request: BridgeRequest;
    try { request = JSON.parse(line) as BridgeRequest; }
    catch (error) {
      send({ type: 'event', event: 'engine.protocol_error', payload: { message: (error as Error).message } });
      return;
    }
    try {
      const result = await handleRpc(orchestrator, request.method, request.params);
      send({ type: 'response', id: request.id, ok: true, result });
    } catch (error) {
      send({ type: 'response', id: request.id, ok: false, error: { message: (error as Error).message || String(error) } });
    }
  })();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
