import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { PCANBasic } from '../src/sidecar/bus/pcanBasic';

describe('Windows PCANBasic.dll read-only FFI smoke check', () => {
  it('loads PCANBasic.dll via koffi and enumerates attached channels safely without opening any bus', () => {
    if (process.platform !== 'win32' || !fs.existsSync('C:\\Windows\\System32\\PCANBasic.dll')) {
      return;
    }
    const pcan = new PCANBasic();
    const channels = pcan.attachedChannels();
    expect(Array.isArray(channels)).toBe(true);
    const okText = pcan.errorText(0x00000);
    expect(typeof okText).toBe('string');
    expect(okText.length).toBeGreaterThan(0);
  });
});
