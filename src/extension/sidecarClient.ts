import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import {
  ChannelItem,
  EngineCommand,
  EngineEvent,
  EngineState,
  HydrateSnapshot,
  RunAnalysisPayload,
  ScanEntry,
} from '../shared/protocol';

export class SidecarClient {
  private proc: ChildProcess | null = null;
  private disposed = false;
  private readonly listeners = new Set<(ev: EngineEvent) => void>();

  state: EngineState | null = null;
  channels: ChannelItem[] = [];
  pcanError = '';
  scanEntries: ScanEntry[] = [];
  regValues: Record<number, { value: number | null; status: 'idle' | 'ok' | 'timeout' | 'error'; error?: string }> = {};
  lastAnalysis: RunAnalysisPayload | null = null;

  constructor(private readonly extensionPath: string) {}

  start(): void {
    if (this.proc || this.disposed) return;
    const sidecarPath = path.join(this.extensionPath, 'dist', 'sidecar.js');
    const child = fork(sidecarPath, [], {
      cwd: this.extensionPath,
      execArgv: [],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    child.on('message', (msg: unknown) => {
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
      const ev = msg as EngineEvent;
      this.cacheEvent(ev);
      for (const fn of this.listeners) {
        fn(ev);
      }
    });

    child.on('exit', () => {
      this.proc = null;
      if (!this.disposed) {
        setTimeout(() => this.start(), 800);
      }
    });

    this.proc = child;
    this.send({ type: 'listChannels' });
  }

  private cacheEvent(ev: EngineEvent): void {
    switch (ev.type) {
      case 'channels':
        this.channels = ev.channels;
        this.pcanError = ev.pcanError;
        break;
      case 'state': {
        const prevMotor = this.state?.driver?.title;
        const nextMotor = ev.state.driver?.title;
        if (prevMotor !== nextMotor) {
          this.regValues = {};
        }
        this.state = ev.state;
        break;
      }
      case 'scanDone':
        this.scanEntries = ev.entries;
        break;
      case 'regResult':
        if (ev.kind === 'read' || ev.kind === 'write') {
          this.regValues[ev.rid] = {
            value: typeof ev.value === 'number' ? ev.value : this.regValues[ev.rid]?.value ?? null,
            status: ev.error ? (ev.error.includes('超时') ? 'timeout' : 'error') : 'ok',
            error: ev.error || undefined,
          };
        }
        break;
      case 'runAnalysis':
        this.lastAnalysis = ev.payload;
        break;
    }
  }

  snapshot(lang: 'zh' | 'en'): HydrateSnapshot {
    return {
      state: this.state,
      channels: this.channels,
      pcanError: this.pcanError,
      scanEntries: this.scanEntries,
      regValues: this.regValues,
      lastAnalysis: this.lastAnalysis,
      lang,
    };
  }

  onEvent(fn: (ev: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(cmd: EngineCommand): void {
    if (!this.proc) this.start();
    if (this.proc && this.proc.connected) {
      this.proc.send(cmd);
    }
  }

  dispose(): void {
    this.disposed = true;
    const p = this.proc;
    this.proc = null;
    if (p) {
      try {
        if (p.connected) {
          p.send({ type: 'disconnect' } satisfies EngineCommand);
          p.disconnect();
        }
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          p.kill();
        } catch {
          // ignore
        }
      }, 400);
    }
  }
}
