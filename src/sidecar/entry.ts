import { EngineCommand, EngineEvent } from '../shared/protocol';
import { Engine } from './engine';

const engine = new Engine((ev: EngineEvent) => {
  if (typeof process.send === 'function' && process.connected) {
    try {
      process.send(ev);
    } catch {
      // IPC closed
    }
  }
});

process.on('message', (msg: unknown) => {
  if (msg && typeof msg === 'object' && 'type' in msg) {
    engine.handleCommand(msg as EngineCommand);
  }
});

function emergencyExit(): void {
  try {
    engine.shutdown();
  } catch {
    // ignore
  }
  process.exit(0);
}

// Deadman switch: if VS Code Extension Host reloads, crashes, or closes IPC, immediately send zero-torque & close bus
process.on('disconnect', emergencyExit);
process.on('SIGINT', emergencyExit);
process.on('SIGTERM', emergencyExit);
process.on('uncaughtException', (err) => {
  try {
    if (typeof process.send === 'function' && process.connected) {
      process.send({
        type: 'notice',
        level: 'error',
        area: 'global',
        text: `Sidecar 异常: ${err.message}`,
      } satisfies EngineEvent);
    }
  } catch {
    // ignore
  }
});

// Initial channel probe
engine.enumerateChannels();
