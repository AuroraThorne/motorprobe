import { describe, expect, it } from 'vitest';
import { decodeWindowsRegistryString, encodeSlcanFrame, parseSlcanFrame } from '../src/sidecar/bus/slcan';

describe('SLCAN ASCII frame codec', () => {
  it('decodes Windows USB friendly names from UTF-16LE registry values', () => {
    const friendly = Buffer.from('USB 串口设备 (COM21)\0', 'utf16le');
    expect(decodeWindowsRegistryString(friendly, friendly.length, 1)).toBe('USB 串口设备 (COM21)');
    expect(decodeWindowsRegistryString(Buffer.from('Canable COM21\0'), 14, 3)).toBe('Canable COM21');
  });

  it('roundtrips standard classic CAN data frames', () => {
    const raw = encodeSlcanFrame(0x123, new Uint8Array([0x01, 0x02, 0xa0]));
    expect(Buffer.from(raw).toString('ascii')).toBe('t12330102A0\r');
    const parsed = parseSlcanFrame(raw.subarray(0, raw.length - 1));
    expect(parsed).not.toBeNull();
    expect(parsed![0]).toBe(0x123);
    expect([...parsed![1]]).toEqual([0x01, 0x02, 0xa0]);
  });

  it('ignores non-data and malformed frames in default mode', () => {
    expect(parseSlcanFrame('O')).toBeNull();
    expect(parseSlcanFrame('r1230')).toBeNull();
    expect(parseSlcanFrame('t1239')).toBeNull();
    expect(parseSlcanFrame('t1232AA')).toBeNull();
  });

  it('supports extended and remote (RTR) frames when withFlags=true', () => {
    const raw = encodeSlcanFrame(0x1abcde, new Uint8Array(0), true, true, 8);
    expect(Buffer.from(raw).toString('ascii')).toBe('R001ABCDE8\r');
    const parsed = parseSlcanFrame(raw.subarray(0, raw.length - 1), true);
    expect(parsed).not.toBeNull();
    expect(parsed!.canId).toBe(0x1abcde);
    expect(parsed!.data.length).toBe(0);
    expect(parsed!.extended).toBe(true);
    expect(parsed!.rtr).toBe(true);
    expect(parsed!.dlc).toBe(8);
  });
});
