import { EngineCommand, WebviewToHostMessage } from '../../shared/protocol';

interface VsCodeWebviewApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): Record<string, unknown> | undefined;
  setState(newState: Record<string, unknown>): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeWebviewApi;
    __CMK_MOCK_POST__?: (msg: WebviewToHostMessage) => void;
  }
}

let cachedApi: VsCodeWebviewApi | null = null;

export function getVsCodeApi(): VsCodeWebviewApi {
  if (cachedApi) return cachedApi;
  if (typeof window.acquireVsCodeApi === 'function') {
    cachedApi = window.acquireVsCodeApi();
    return cachedApi;
  }
  // Browser preview fallback when inspecting standalone HTML outside Extension Host
  let localState: Record<string, unknown> = {};
  cachedApi = {
    postMessage(msg: WebviewToHostMessage) {
      window.__CMK_MOCK_POST__?.(msg);
    },
    getState() {
      return localState;
    },
    setState(s: Record<string, unknown>) {
      localState = s;
    },
  };
  return cachedApi;
}

export function postToHost(msg: WebviewToHostMessage): void {
  getVsCodeApi().postMessage(msg);
}

export function postEngine(cmd: EngineCommand): void {
  postToHost({ type: 'engine', cmd });
}

export function loadSavedUiState<T extends Record<string, unknown>>(fallback: T): T {
  const s = getVsCodeApi().getState();
  return s ? { ...fallback, ...(s as Partial<T>) } : fallback;
}

export function saveUiState(patch: Record<string, unknown>): void {
  const cur = getVsCodeApi().getState() ?? {};
  getVsCodeApi().setState({ ...cur, ...patch });
}
