let beginPeriod: ((uPeriod: number) => number) | null = null;
let endPeriod: ((uPeriod: number) => number) | null = null;
let loaded = false;

function ensureWinmm(): void {
  if (loaded) return;
  loaded = true;
  if (process.platform !== 'win32') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const winmm = koffi.load('winmm.dll');
    beginPeriod = winmm.func('uint32 __stdcall timeBeginPeriod(uint32 uPeriod)');
    endPeriod = winmm.func('uint32 __stdcall timeEndPeriod(uint32 uPeriod)');
  } catch {
    beginPeriod = null;
    endPeriod = null;
  }
}

export function enableHighResTimer(): boolean {
  ensureWinmm();
  if (!beginPeriod) return false;
  try {
    return beginPeriod(1) === 0;
  } catch {
    return false;
  }
}

export function disableHighResTimer(): void {
  if (!endPeriod) return;
  try {
    endPeriod(1);
  } catch {
    // ignore
  }
}
