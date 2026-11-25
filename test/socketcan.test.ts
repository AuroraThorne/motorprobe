import { describe, expect, it } from 'vitest';
import { SocketCanBus } from '../src/sidecar/bus/socketcan';

describe('SocketCAN binary frame codec', () => {
  it('packs and unpacks 16-byte classic CAN frames', () => {
    const raw = SocketCanBus.packFrame(0x123, new Uint8Array([0x01, 0x02, 0x03]));
    expect(raw.length).toBe(16);
    const parsed = SocketCanBus.unpackFrame(raw);
    expect(parsed).not.toBeNull();
    expect(parsed![0]).toBe(0x123);
    expect([...parsed![1]]).toEqual([0x01, 0x02, 0x03]);
  });

  it('rejects CAN_ERR_FLAG frames', () => {
    const raw = new Uint8Array(SocketCanBus.packFrame(0x123, new Uint8Array(0)));
    raw[3] |= 0x20;
    expect(SocketCanBus.unpackFrame(raw)).toBeNull();
  });

  it('supports extended and RTR frames with flags', () => {
    const raw = SocketCanBus.packFrame(0x1abcde, new Uint8Array(0), true, true, 8);
    const parsed = SocketCanBus.unpackFrame(raw, true);
    expect(parsed).not.toBeNull();
    expect(parsed!.canId).toBe(0x1abcde);
    expect(parsed!.data.length).toBe(0);
    expect(parsed!.extended).toBe(true);
    expect(parsed!.rtr).toBe(true);
    expect(parsed!.dlc).toBe(8);
  });
});
