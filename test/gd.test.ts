import { describe, expect, it } from 'vitest';
import { GdDriver, gdMotorFromStatus, GD_RX_BASE, packGdMit, parseGdModelReply, unpackGdMit } from '../src/sidecar/drivers/gd';
import { DjiDriver } from '../src/sidecar/drivers/dji';
import { makeDriver } from '../src/sidecar/drivers/catalog';

describe('GD classic CAN driver', () => {
  it('packs torque and reports the status-query frame as extended CAN', () => {
    const driver = new GdDriver('GD 5036-02-CNE', 1);
    expect(driver.extended).toBe(true);
    expect(driver.fbId).toBe(0x10100);
    expect(driver.outputFrames(0.5)).toEqual([
      [0x18001, new Uint8Array([0x1b, 0x0e, 0x32, 0x00])],
      [0x18001, new Uint8Array([0x00, 0x0e])],
    ]);
    expect(driver.outputFrames(0)[0][1]).toEqual(new Uint8Array([0x1b, 0x0e, 0, 0]));
  });

  it('decodes the documented little-endian status layout and keeps GD error codes separate', () => {
    const driver = new GdDriver('GD 6036（通用）', 1);
    const frameId = GD_RX_BASE | (1 << 8);
    const data = new Uint8Array([0x0e, 0, 0xc8, 0, 0x90, 1, 3, 0]);
    expect(gdMotorFromStatus(frameId, data)).toBe(1);
    expect(gdMotorFromStatus(frameId, new Uint8Array([0x0e]))).toBeNull();
    expect(driver.accepts(frameId, data)).toBe(true);
    const fb = driver.parse(frameId, data)!;
    expect(fb.pos).toBeCloseTo(0.02 * 2 * Math.PI, 7);
    expect(fb.vel).toBeCloseTo(0.1 * 2 * Math.PI, 7);
    expect(fb.out).toBe(0.03);
    expect(Number.isNaN(fb.temp)).toBe(true);
    expect(fb.enabled).toBeNull();
    expect(driver.codeText(0)).toBe('无错误');
    expect(driver.isFault(0)).toBe(false);
    expect(driver.isFault(1)).toBe(true);
  });

  it('encodes GD MIT as little-endian packed fields and uses exact zero torque when gains are zero', () => {
    expect(Buffer.from(packGdMit({ p: 0, v: 0, t: 0, kp: 0, kd: 0 })).toString('hex')).toBe('0080000880000880');
    const cmd = { p: 0, v: 10 * 2 * Math.PI, t: -100, kp: 800, kd: -200 };
    expect(unpackGdMit(packGdMit(cmd)).v).toBeCloseTo(cmd.v, 3);
    expect(new GdDriver().mitFrames({ p: 0, v: 0, t: 0.3, kp: 0, kd: 0 })[0][1])
      .toEqual(new Uint8Array([0x1b, 0x0e, 30, 0]));
  });

  it('rejects invalid IDs and registers the Windows desktop model catalogue', () => {
    expect(makeDriver('gd', '高擎 GD（经典 CAN）', 126)).toBeInstanceOf(GdDriver);
    expect(() => new GdDriver('高擎 GD（经典 CAN）', 127)).toThrow(/1~126/);
    expect(new DjiDriver('RM 6623', 0).outUnit).toBe('原始值');
    expect(() => new DjiDriver('RM 6623', 8)).toThrow(/0~7/);
  });

  it('identifies documented GD model families without inventing an unknown suffix', () => {
    expect(parseGdModelReply(new Uint8Array([7, 11, 0x35, 0x30, 0x33, 0x36, 0x2d, 0x30])))
      .toBe('GD 5036（通用）');
    expect(parseGdModelReply(new Uint8Array([7, 4, 0x36, 0x30, 0x33, 0x36])))
      .toBe('GD 6036（通用）');
    expect(parseGdModelReply(new Uint8Array([7, 0]))).toBeNull();
  });

  it('maps zero-based RM 6623 IDs and derives velocity across the angle wrap', () => {
    const driver = new DjiDriver('RM 6623', 0);
    expect(driver.fbId).toBe(0x205);
    expect(driver.ctrl).toEqual([0x1ff, 0]);
    const first = new Uint8Array([0x1f, 0xff, 0, 10, 0, 0, 0, 0]);
    const second = new Uint8Array([0, 0, 0, 20, 0, 0, 0, 0]);
    driver.parse(driver.fbId, first, 1.0);
    const fb = driver.parse(driver.fbId, second, 1.01)!;
    expect(Number.isFinite(fb.vel)).toBe(true);
    expect(fb.vel).toBeGreaterThan(0);
    expect(fb.out).toBe(20);
  });
});
