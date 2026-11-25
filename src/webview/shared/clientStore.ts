import { useSyncExternalStore } from 'react';
import {
  CanFrameDto,
  ChannelItem,
  EngineEvent,
  EngineState,
  HostToWebviewMessage,
  PidSuggestion,
  RunAnalysisPayload,
  ScanEntry,
  WorkbenchMode,
} from '../../shared/protocol';
import { ColumnRingBuffer } from './ringBuffer';
import { postToHost } from './vscodeApi';

export interface NoticeItem {
  id: number;
  level: 'info' | 'warning' | 'error' | 'success';
  area: string;
  text: string;
  createdAt: number;
}

const NOTICE_PRIORITY: Record<NoticeItem['level'], number> = {
  error: 4,
  warning: 3,
  success: 2,
  info: 1,
};

const NOTICE_BURST_MS = 600;

export interface ClientStoreSnapshot {
  lang: 'zh' | 'en';
  state: EngineState | null;
  channels: ChannelItem[];
  pcanError: string;
  scanEntries: ScanEntry[];
  regValues: Record<number, { value: number | null; status: 'idle' | 'ok' | 'timeout' | 'error'; error?: string }>;
  lastAnalysis: RunAnalysisPayload | null;
  notices: NoticeItem[];
  workbenchMode: WorkbenchMode;
  pendingLoopSuggestion: PidSuggestion | null;
  sampleVersion: number;
  frameVersion: number;
  latencyMs: number[];
  busLoadPct: number | null;
  feedbackFps: number;
  importedRegs: Record<string, number> | null;
}

export const sharedRing = new ColumnRingBuffer(200_000);
export const rawFramesBuffer: CanFrameDto[] = [];
export const aggregatedFramesMap = new Map<string, CanFrameDto>();
let frameT0: number | null = null;
const bitWindow: Array<[number, number]> = [];
const fbTimeWindow: number[] = [];
let noticeSeq = 1;
let prevDriverKey = '';

let store: ClientStoreSnapshot = {
  lang: 'zh',
  state: null,
  channels: [],
  pcanError: '',
  scanEntries: [],
  regValues: {},
  lastAnalysis: null,
  notices: [],
  workbenchMode: 'scope',
  pendingLoopSuggestion: null,
  sampleVersion: 0,
  frameVersion: 0,
  latencyMs: [],
  busLoadPct: null,
  feedbackFps: 0,
  importedRegs: null,
};

const listeners = new Set<() => void>();
function emitChange(): void {
  for (const l of listeners) l();
}

export function clearFrameLogs(): void {
  rawFramesBuffer.length = 0;
  aggregatedFramesMap.clear();
  bitWindow.length = 0;
  fbTimeWindow.length = 0;
  frameT0 = null;
  store = { ...store, frameVersion: store.frameVersion + 1, busLoadPct: null, feedbackFps: 0 };
  emitChange();
}

export function clearSampleHistory(): void {
  sharedRing.clear();
  store = { ...store, sampleVersion: sharedRing.version };
  emitChange();
}

export function resolveSingleNotice(
  current: NoticeItem | undefined,
  level: NoticeItem['level'],
  area: string,
  text: string,
  now = performance.now(),
): NoticeItem[] {
  const next: NoticeItem = {
    id: noticeSeq++,
    level,
    area,
    text,
    createdAt: now,
  };
  if (!current) {
    return [next];
  }
  // Explicit recovery in the same subsystem (e.g. unlocking safety latch or reconnecting bus)
  // immediately replaces the previous error/warning.
  if (current.area === area && level === 'success') {
    return [next];
  }
  // Within a simultaneous event burst, keep only the highest-priority message
  // so a trailing low-priority status update never hides a critical error.
  if (now - current.createdAt < NOTICE_BURST_MS) {
    if (NOTICE_PRIORITY[level] < NOTICE_PRIORITY[current.level]) {
      return [current];
    }
  }
  // Any subsequent message overwrites the old message directly (never accumulates).
  return [next];
}

export function dismissNotice(_id?: number): void {
  if (store.notices.length === 0) return;
  store = { ...store, notices: [] };
  emitChange();
}

export function setWorkbenchMode(mode: WorkbenchMode, applySuggestion?: PidSuggestion): void {
  store = {
    ...store,
    workbenchMode: mode,
    pendingLoopSuggestion: applySuggestion ?? store.pendingLoopSuggestion,
  };
  emitChange();
}

export function consumePendingSuggestion(): void {
  if (store.pendingLoopSuggestion) {
    store = { ...store, pendingLoopSuggestion: null };
    emitChange();
  }
}

export function consumeImportedRegs(): void {
  if (store.importedRegs) {
    store = { ...store, importedRegs: null };
    emitChange();
  }
}

export function getFrameRelativeTime(t: number): number {
  if (frameT0 === null) frameT0 = t;
  return Math.max(0, t - frameT0);
}

function handleEngineEvent(ev: EngineEvent): void {
  switch (ev.type) {
    case 'channels':
      store = { ...store, channels: ev.channels, pcanError: ev.pcanError };
      emitChange();
      break;
    case 'state': {
      const nextKey = ev.state.driver?.title ?? '';
      if (nextKey !== prevDriverKey) {
        prevDriverKey = nextKey;
        sharedRing.clear();
        store = { ...store, regValues: {}, sampleVersion: sharedRing.version };
      }
      store = { ...store, state: ev.state };
      emitChange();
      break;
    }
    case 'samples':
      sharedRing.appendFlat(ev.flat);
      store = { ...store, sampleVersion: sharedRing.version };
      emitChange();
      break;
    case 'frames': {
      const fpsId = store.state?.driver?.fbId ?? 0x202;
      let latestT = 0;
      for (const f of ev.frames) {
        latestT = Math.max(latestT, f.t);
        bitWindow.push([f.t, f.bits]);
        if (!f.tx && f.canId === fpsId) {
          fbTimeWindow.push(f.t);
        }
        rawFramesBuffer.push(f);
        const key = `${f.canId}:${f.tx ? 1 : 0}:${f.extended ? 1 : 0}:${f.rtr ? 1 : 0}`;
        aggregatedFramesMap.set(key, f);
      }
      if (rawFramesBuffer.length > 2200) {
        rawFramesBuffer.splice(0, rawFramesBuffer.length - 2000);
      }
      const cutoff = latestT - 1.0;
      while (bitWindow.length > 0 && bitWindow[0][0] < cutoff) bitWindow.shift();
      while (fbTimeWindow.length > 0 && fbTimeWindow[0] < cutoff) fbTimeWindow.shift();

      const bitrate = store.state?.bitrate ?? null;
      let loadPct: number | null = null;
      if (bitrate && bitrate > 0) {
        let bits = 0;
        for (const [, b] of bitWindow) bits += b;
        loadPct = Math.min(100, (bits / bitrate) * 100);
      }
      store = {
        ...store,
        frameVersion: store.frameVersion + 1,
        busLoadPct: loadPct,
        feedbackFps: fbTimeWindow.length,
      };
      emitChange();
      break;
    }
    case 'scanDone':
      store = { ...store, scanEntries: ev.entries };
      emitChange();
      break;
    case 'regResult': {
      const nextRegs = { ...store.regValues };
      if (ev.kind === 'read' || ev.kind === 'write') {
        nextRegs[ev.rid] = {
          value: typeof ev.value === 'number' ? ev.value : nextRegs[ev.rid]?.value ?? null,
          status: ev.error ? (ev.error.includes('超时') ? 'timeout' : 'error') : 'ok',
          error: ev.error || undefined,
        };
      }
      const notices = ev.error
        ? resolveSingleNotice(store.notices[0], 'error', 'regs', ev.error)
        : ev.kind === 'save'
          ? resolveSingleNotice(store.notices[0], 'success', 'regs', '参数已保存到 Flash (AA 01)')
          : store.notices;
      store = { ...store, regValues: nextRegs, notices };
      emitChange();
      break;
    }
    case 'runAnalysis':
      store = { ...store, lastAnalysis: ev.payload };
      emitChange();
      break;
    case 'latencyValues':
      store = { ...store, latencyMs: ev.valuesMs };
      emitChange();
      break;
    case 'notice':
      store = {
        ...store,
        notices: resolveSingleNotice(store.notices[0], ev.level, ev.area, ev.text),
      };
      emitChange();
      break;
  }
}

let initialized = false;
export function initClientStore(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener('message', (e: MessageEvent<HostToWebviewMessage>) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hydrate':
        prevDriverKey = msg.snapshot.state?.driver?.title ?? '';
        store = {
          ...store,
          state: msg.snapshot.state,
          channels: msg.snapshot.channels,
          pcanError: msg.snapshot.pcanError,
          scanEntries: msg.snapshot.scanEntries,
          regValues: msg.snapshot.regValues,
          lastAnalysis: msg.snapshot.lastAnalysis,
          lang: msg.snapshot.lang,
        };
        emitChange();
        break;
      case 'engineEvent':
        handleEngineEvent(msg.event);
        break;
      case 'switchWorkbenchMode':
        setWorkbenchMode(msg.mode, msg.applySuggestion);
        break;
      case 'lang':
        store = { ...store, lang: msg.lang };
        emitChange();
        break;
      case 'importedRegs':
        store = { ...store, importedRegs: msg.regs };
        emitChange();
        break;
      case 'clearBusLog':
        clearFrameLogs();
        break;
    }
  });
  postToHost({ type: 'ready' });
}

export function useClientStore(): ClientStoreSnapshot {
  initClientStore();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => store,
  );
}
