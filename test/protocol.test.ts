import { describe, expect, it } from 'vitest';
import * as P from '../src/sidecar/drivers/dmProtocol';

const G9 = P.DEFAULT_LIMITS;

describe('dmProtocol bit-exact encoding/decoding', () => {
  it.each([
    [0.0, -12.5, 12.5, 16],
    [1.234, -12.5, 12.5, 16],
    [-45, -45, 45, 12],
    [45, -45, 45, 12],
    [250, 0, 500, 12],
    [0.5, 0, 5, 12],
    [-10.1, -54, 54, 12],
  ])('floatToUint roundtrip (%f, [%f, %f], %i bits)', (x, lo, hi, bits) => {
    const u = P.floatToUint(x, lo, hi, bits);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual((1 << bits) - 1);
    expect(Math.abs(P.uintToFloat(u, lo, hi, bits) - x)).toBeLessThanOrEqual(P.lsb(lo, hi, bits) + 1e-12);
  });

  it('clamps out-of-range values without wrapping', () => {
    expect(P.floatToUint(100, -12.5, 12.5, 16)).toBe(0xffff);
    expect(P.floatToUint(-100, -12.5, 12.5, 16)).toBe(0);
  });

  it('packs and unpacks MIT commands accurately', () => {
    const cmd: P.MitCommand = { p: 1.5, v: -3.0, kp: 20.0, kd: 1.0, t: 2.5 };
    const d = P.packMit(cmd, G9);
    expect(d.length).toBe(8);
    const back = P.unpackMit(d, G9);
    expect(Math.abs(back.p - cmd.p)).toBeLessThanOrEqual(P.lsb(-12.5, 12.5, 16));
    expect(Math.abs(back.v - cmd.v)).toBeLessThanOrEqual(P.lsb(-45, 45, 12));
    expect(Math.abs(back.kp - cmd.kp)).toBeLessThanOrEqual(P.lsb(0, 500, 12));
    expect(Math.abs(back.kd - cmd.kd)).toBeLessThanOrEqual(P.lsb(0, 5, 12));
    expect(Math.abs(back.t - cmd.t)).toBeLessThanOrEqual(P.lsb(-54, 54, 12));
  });

  it('packs zero MIT command midpoint bytes identically to manual', () => {
    const d = P.packMit(P.ZERO_MIT, G9);
    expect(d[0]).toBe(0x80);
    expect(d[1]).toBe(0x00);
    const v = (d[2] << 4) | (d[3] >> 4);
    expect(v).toBe(2048);
    expect(d[3] & 0x0f).toBe(0);
    expect(d[4]).toBe(0);
    expect(d[5]).toBe(0);
    expect(d[6] >> 4).toBe(0);
  });

  it('packs and unpacks motor status feedback frames', () => {
    const d = P.packStatus(1, 3, 0.7, -2.0, 5.0, 40, 35, G9);
    const s = P.unpackStatus(d, G9);
    expect(s.motorId4).toBe(1);
    expect(s.err).toBe(3);
    expect(Math.abs(s.pos - 0.7)).toBeLessThanOrEqual(P.lsb(-12.5, 12.5, 16));
    expect(Math.abs(s.vel - -2.0)).toBeLessThanOrEqual(P.lsb(-45, 45, 12));
    expect(Math.abs(s.torque - 5.0)).toBeLessThanOrEqual(P.lsb(-54, 54, 12));
    expect(s.tMos).toBe(40);
    expect(s.tRotor).toBe(35);
  });

  it('recognizes special frames and config frames', () => {
    expect(Buffer.from(P.specialFrame(P.SPECIAL_ENABLE)).toString('hex').toUpperCase()).toBe('FFFFFFFFFFFFFFFC');
    expect(Buffer.from(P.specialFrame(P.SPECIAL_DISABLE)).toString('hex').toUpperCase()).toBe('FFFFFFFFFFFFFFFD');
    expect(P.isSpecial(P.specialFrame(P.SPECIAL_ZERO))).toBe(true);
    expect(P.isSpecial(P.packMit(P.ZERO_MIT, G9))).toBe(false);

    expect([...P.readRegFrame(1, 0x3c)]).toEqual([0x01, 0x00, 0x33, 0x3c, 0, 0, 0, 0]);
    expect([...P.writeRegFrame(0x101, 0x09, 'u', 100)]).toEqual([0x01, 0x01, 0x55, 0x09, 100, 0, 0, 0]);
    expect([...P.saveFrame(1)]).toEqual([0x01, 0x00, 0xaa, 0x01, 0, 0, 0, 0]);
    expect([...P.queryStateFrame(5)]).toEqual([0x05, 0x00, 0xcc, 0, 0, 0, 0, 0]);
  });

  it('encodes/decodes u32, i32, f32 values and classifies replies', () => {
    expect(P.decodeValue('u', P.encodeValue('u', 4000000000))).toBe(4000000000);
    expect(P.decodeValue('i', P.encodeValue('i', -5))).toBe(-5);
    expect(P.decodeValue('f', P.encodeValue('f', 12.5))).toBeCloseTo(12.5, 5);

    const req = P.readRegFrame(1, 0x3c);
    const rep = new Uint8Array(8);
    rep.set(req.subarray(0, 4), 0);
    rep.set(P.encodeValue('f', 24.1), 4);
    expect(P.matchesRequest(rep, req)).toBe(true);
    const parsed = P.parseConfigReply(rep)!;
    expect(parsed.cmd).toBe(P.CMD_READ);
    expect(parsed.sub).toBe(0x3c);
    expect(P.decodeValue('f', parsed.raw4)).toBeCloseTo(24.1, 4);

    const status = P.packStatus(1, 0, 0, 0, 0, 30, 30, G9);
    expect(P.matchesRequest(status, req)).toBe(false);
  });

  it('has unique register RIDs and valid code text', () => {
    expect(P.REG_BY_RID.size).toBe(P.REGISTERS.length);
    expect(P.REG_BY_NAME.get('output_angle_multiturn')?.rid).toBe(0x51);
    expect(P.codeText(0)).toBe('失能');
    expect(P.codeText(1)).toBe('已使能');
    expect(P.isFault(1)).toBe(false);
    expect(P.isFault(8)).toBe(true);
    expect(P.codeText(8)).toContain('过压');
  });
});
