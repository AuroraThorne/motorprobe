import { DEFAULT_LIMITS, Limits, MitCommand, withMaps, ZERO_MIT } from '../../shared/protocol';
import { REG_BY_NAME, REG_BY_RID, REGISTERS, RegType } from '../../shared/registers';

export { DEFAULT_LIMITS, REG_BY_NAME, REG_BY_RID, REGISTERS, withMaps, ZERO_MIT };
export type { Limits, MitCommand, RegType };

export const CONFIG_ID = 0x7ff;
export const CMD_READ = 0x33;
export const CMD_WRITE = 0x55;
export const CMD_SAVE = 0xaa;
export const CMD_STATE = 0xcc;
export const SAVE_SUB = 0x01;
export const BAUD_SUB = 0x23;
export const CONFIG_CMDS: readonly number[] = [CMD_READ, CMD_WRITE, CMD_SAVE];

export const SPECIAL_CLEAR_ERROR = 0xfb;
export const SPECIAL_ENABLE = 0xfc;
export const SPECIAL_DISABLE = 0xfd;
export const SPECIAL_ZERO = 0xfe;

export const SPECIAL_NAMES: Record<number, string> = {
  0xfb: '清除错误',
  0xfc: '使能',
  0xfd: '失能',
  0xfe: '设零点',
};

export const CODE_DISABLED = 0;
export const CODE_ENABLED = 1;

export const FAULT_NAMES: Record<number, string> = {
  0x3: '输出轴校准异常',
  0x4: '传感器异常',
  0x5: '编码器校准异常',
  0x8: '过压',
  0x9: '欠压',
  0xa: '过电流',
  0xb: 'MOS过温',
  0xc: '线圈过温',
  0xd: '通讯丢失',
  0xe: '过载',
};

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function floatToUint(x: number, xMin: number, xMax: number, bits: number): number {
  const span = xMax - xMin;
  const full = (1 << bits) - 1;
  const xc = clamp(x, xMin, xMax);
  const raw = Math.round(((xc - xMin) * full) / span);
  return Math.max(0, Math.min(full, raw));
}

export function uintToFloat(xInt: number, xMin: number, xMax: number, bits: number): number {
  const span = xMax - xMin;
  return (xInt * span) / ((1 << bits) - 1) + xMin;
}

export function lsb(xMin: number, xMax: number, bits: number): number {
  return (xMax - xMin) / ((1 << bits) - 1);
}

export function packMit(cmd: MitCommand, lim: Limits): Uint8Array {
  const p = floatToUint(cmd.p, lim.pMin, lim.pMax, 16);
  const v = floatToUint(cmd.v, lim.vMin, lim.vMax, 12);
  const kp = floatToUint(cmd.kp, lim.kpMin, lim.kpMax, 12);
  const kd = floatToUint(cmd.kd, lim.kdMin, lim.kdMax, 12);
  const t = floatToUint(cmd.t, lim.tMin, lim.tMax, 12);
  return new Uint8Array([
    (p >> 8) & 0xff,
    p & 0xff,
    (v >> 4) & 0xff,
    ((v & 0x0f) << 4) | ((kp >> 8) & 0x0f),
    kp & 0xff,
    (kd >> 4) & 0xff,
    ((kd & 0x0f) << 4) | ((t >> 8) & 0x0f),
    t & 0xff,
  ]);
}

export function unpackMit(d: Uint8Array, lim: Limits): MitCommand {
  const p = (d[0] << 8) | d[1];
  const v = (d[2] << 4) | (d[3] >> 4);
  const kp = ((d[3] & 0x0f) << 8) | d[4];
  const kd = (d[5] << 4) | (d[6] >> 4);
  const t = ((d[6] & 0x0f) << 8) | d[7];
  return {
    p: uintToFloat(p, lim.pMin, lim.pMax, 16),
    v: uintToFloat(v, lim.vMin, lim.vMax, 12),
    kp: uintToFloat(kp, lim.kpMin, lim.kpMax, 12),
    kd: uintToFloat(kd, lim.kdMin, lim.kdMax, 12),
    t: uintToFloat(t, lim.tMin, lim.tMax, 12),
  };
}

export function isSpecial(d: Uint8Array): boolean {
  if (d.length !== 8) return false;
  for (let i = 0; i < 7; i++) {
    if (d[i] !== 0xff) return false;
  }
  return d[7] in SPECIAL_NAMES;
}

export function specialFrame(code: number): Uint8Array {
  return new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, code & 0xff]);
}

export interface DmStatus {
  motorId4: number;
  err: number;
  pos: number;
  vel: number;
  torque: number;
  tMos: number;
  tRotor: number;
  raw: Uint8Array;
}

export function isFault(code: number): boolean {
  return code >= 2;
}

export function codeText(code: number): string {
  if (code < 0) return '未知';
  if (code === CODE_DISABLED) return '失能';
  if (code === CODE_ENABLED) return '已使能';
  const name = FAULT_NAMES[code];
  return `故障 ${code}` + (name ? `(${name}?)` : '');
}

export function packStatus(
  motorId: number,
  err: number,
  pos: number,
  vel: number,
  torque: number,
  tMos: number,
  tRotor: number,
  lim: Limits,
): Uint8Array {
  const p = floatToUint(pos, lim.pMin, lim.pMax, 16);
  const v = floatToUint(vel, lim.vMin, lim.vMax, 12);
  const t = floatToUint(torque, lim.tMin, lim.tMax, 12);
  return new Uint8Array([
    ((err & 0x0f) << 4) | (motorId & 0x0f),
    (p >> 8) & 0xff,
    p & 0xff,
    (v >> 4) & 0xff,
    ((v & 0x0f) << 4) | ((t >> 8) & 0x0f),
    t & 0xff,
    Math.trunc(clamp(tMos, 0, 255)),
    Math.trunc(clamp(tRotor, 0, 255)),
  ]);
}

export function unpackStatus(d: Uint8Array, lim: Limits): DmStatus {
  const p = (d[1] << 8) | d[2];
  const v = (d[3] << 4) | (d[4] >> 4);
  const t = ((d[4] & 0x0f) << 8) | d[5];
  return {
    motorId4: d[0] & 0x0f,
    err: (d[0] >> 4) & 0x0f,
    pos: uintToFloat(p, lim.pMin, lim.pMax, 16),
    vel: uintToFloat(v, lim.vMin, lim.vMax, 12),
    torque: uintToFloat(t, lim.tMin, lim.tMax, 12),
    tMos: d[6],
    tRotor: d[7],
    raw: new Uint8Array(d),
  };
}

export function encodeValue(typ: RegType, value: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  if (typ === 'f') {
    dv.setFloat32(0, Number(value), true);
  } else if (typ === 'u') {
    const u = Math.trunc(Number(value));
    if (!Number.isFinite(u) || u < 0 || u > 0xffffffff) {
      throw new RangeError(`uint32 超出范围: ${value}`);
    }
    dv.setUint32(0, u >>> 0, true);
  } else {
    const i = Math.trunc(Number(value));
    if (!Number.isFinite(i) || i < -0x80000000 || i > 0x7fffffff) {
      throw new RangeError(`int32 超出范围: ${value}`);
    }
    dv.setInt32(0, i | 0, true);
  }
  return new Uint8Array(buf);
}

export function decodeValue(typ: RegType, raw: Uint8Array): number {
  const dv = new DataView(raw.buffer, raw.byteOffset, 4);
  if (typ === 'f') return dv.getFloat32(0, true);
  if (typ === 'u') return dv.getUint32(0, true);
  return dv.getInt32(0, true);
}

function hdr(motorId: number, cmd: number): [number, number, number] {
  return [motorId & 0xff, (motorId >> 8) & 0xff, cmd & 0xff];
}

export function readRegFrame(motorId: number, rid: number): Uint8Array {
  return new Uint8Array([...hdr(motorId, CMD_READ), rid & 0xff, 0, 0, 0, 0]);
}

export function writeRegFrame(motorId: number, rid: number, typ: RegType, value: number): Uint8Array {
  const v = encodeValue(typ, value);
  const out = new Uint8Array(8);
  const h = hdr(motorId, CMD_WRITE);
  out[0] = h[0];
  out[1] = h[1];
  out[2] = h[2];
  out[3] = rid & 0xff;
  out.set(v, 4);
  return out;
}

export function saveFrame(motorId: number): Uint8Array {
  return new Uint8Array([...hdr(motorId, CMD_SAVE), SAVE_SUB, 0, 0, 0, 0]);
}

export function queryStateFrame(motorId: number): Uint8Array {
  return new Uint8Array([...hdr(motorId, CMD_STATE), 0, 0, 0, 0, 0]);
}

export function baudFrame(motorId: number, index: number): Uint8Array {
  return new Uint8Array([...hdr(motorId, CMD_SAVE), BAUD_SUB, index & 0xff, 0, 0, 0]);
}

export interface ConfigReply {
  motorId: number;
  cmd: number;
  sub: number;
  raw4: Uint8Array;
}

export function parseConfigReply(d: Uint8Array): ConfigReply | null {
  if (d.length < 8 || !CONFIG_CMDS.includes(d[2])) {
    return null;
  }
  return {
    motorId: d[0] | (d[1] << 8),
    cmd: d[2],
    sub: d[3],
    raw4: d.slice(4, 8),
  };
}

export function matchesRequest(d: Uint8Array, req: Uint8Array): boolean {
  if (d.length < 4 || req.length < 4 || !CONFIG_CMDS.includes(d[2])) {
    return false;
  }
  return d[0] === req[0] && d[1] === req[1] && d[2] === req[2] && d[3] === req[3];
}

export function hexdata(d: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < d.length; i++) {
    parts.push(d[i].toString(16).toUpperCase().padStart(2, '0'));
  }
  return parts.join(' ');
}
