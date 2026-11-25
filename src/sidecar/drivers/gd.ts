import { DriverCaps, DriverSummary, Limits, MitCommand } from '../../shared/protocol';
import { Driver, Feedback, FrameTuple } from './base';

const TAU = 2 * Math.PI;
export const GD_MODEL = '高擎 GD（经典 CAN）';
export const GD_MODEL_5036 = 'GD 5036-02-CNE';
export const GD_MODEL_5036_FAMILY = 'GD 5036（通用）';
export const GD_MODEL_6036 = 'GD 6036（通用）';
export const GD_MODELS = [GD_MODEL_5036, GD_MODEL_5036_FAMILY, GD_MODEL_6036, GD_MODEL];
export const GD_TX_BASE = 0x18000;
export const GD_MIT_BASE = 0x58000;
export const GD_RX_BASE = 0x10000;
export const GD_QUERY_STATUS = 0x0e;
export const GD_LIMITS: Limits = {
  pMin: -3.2768 * TAU, pMax: 3.2767 * TAU,
  vMin: -10 * TAU, vMax: 10 * TAU,
  tMin: -100, tMax: 100, kpMin: -800, kpMax: 800, kdMin: -200, kdMax: 200,
};

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new ValueError(`${label}必须为有限数值`);
}

class ValueError extends Error {}

function floatToUint(value: number, lo: number, hi: number, bits: number): number {
  finite(value, 'MIT 参数');
  const max = 2 ** bits - 1;
  const clamped = Math.max(lo, Math.min(hi, value));
  return Math.round(((clamped - lo) * max) / (hi - lo));
}

export interface GdMitCommand extends MitCommand {}

export function packGdMit(cmd: GdMitCommand): Uint8Array {
  const fields: Array<[number, number, number, number, number]> = [
    [cmd.p / TAU, -3.2768, 3.2767, 16, 0],
    [cmd.v / TAU, -10, 10, 12, 16],
    [cmd.t, -100, 100, 12, 28],
    [cmd.kp, -800, 800, 12, 40],
    [cmd.kd, -200, 200, 12, 52],
  ];
  let raw = 0n;
  for (const [value, lo, hi, bits, shift] of fields) {
    raw |= BigInt(floatToUint(value, lo, hi, bits)) << BigInt(shift);
  }
  const data = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) data[i] = Number((raw >> BigInt(i * 8)) & 0xffn);
  return data;
}

export function unpackGdMit(data: Uint8Array): GdMitCommand {
  if (data.length !== 8) throw new RangeError('GD MIT 帧必须为 8 字节');
  let raw = 0n;
  for (let i = 0; i < 8; i += 1) raw |= BigInt(data[i]) << BigInt(i * 8);
  const field = (shift: number, bits: number, lo: number, hi: number): number => {
    const value = Number((raw >> BigInt(shift)) & ((1n << BigInt(bits)) - 1n));
    return (value / (2 ** bits - 1)) * (hi - lo) + lo;
  };
  return {
    p: field(0, 16, -3.2768, 3.2767) * TAU,
    v: field(16, 12, -10, 10) * TAU,
    t: field(28, 12, -100, 100),
    kp: field(40, 12, -800, 800),
    kd: field(52, 12, -200, 200),
  };
}

export function gdMotorFromStatus(canId: number, data: Uint8Array): number | null {
  const motorId = (canId >> 8) & 0x7f;
  return motorId >= 1 && motorId <= 126 && canId === (GD_RX_BASE | (motorId << 8)) &&
    data.length === 8 && data[0] === GD_QUERY_STATUS ? motorId : null;
}

export function parseGdModelReply(data: Uint8Array): string | null {
  if (data.length < 3 || data.length > 8 || data[0] !== 0x07 || data[1] === 0) return null;
  const payload = data.subarray(2);
  if ([...payload].some((byte) => byte < 0x20 || byte > 0x7e)) return null;
  const name = String.fromCharCode(...payload).trim().toUpperCase();
  if (name.startsWith('5036')) return 'GD 5036（通用）';
  if (name.startsWith('6036')) return 'GD 6036（通用）';
  return GD_MODEL;
}

export class GdDriver extends Driver {
  readonly protocol = 'gd' as const;
  readonly protocolName = '高擎 GD';
  override readonly extended = true;
  readonly caps: DriverCaps = {
    mit: true,
    registers: false,
    enableCmd: false,
    zero: true,
    clear: false,
    statusCode: true,
  };
  readonly outName = '扭矩';
  readonly outUnit = 'Nm';
  readonly note = '经典 CAN 1 Mbps 扩展帧；反馈不含温度和使能位；协议扭矩范围不代表额定能力';

  constructor(model = GD_MODEL, motorId = 1) {
    if (!GD_MODELS.includes(model)) throw new Error(`未知 GD 型号：${model}`);
    if (!Number.isInteger(motorId) || motorId < 1 || motorId > 126) {
      throw new RangeError('GD 电机 ID 范围为 1~126');
    }
    super(model, motorId);
  }

  override get fbId(): number { return GD_RX_BASE | (this.motorId << 8); }
  get txId(): number { return GD_TX_BASE | this.motorId; }
  get mitId(): number { return GD_MIT_BASE | this.motorId; }
  override get outMax(): number { return 100; }
  override get wrapSpan(): number { return (65536 / 10000) * TAU; }

  override summary(): DriverSummary {
    return {
      protocol: this.protocol, protocolName: this.protocolName, model: this.model,
      motorId: this.motorId, masterId: -1, title: this.title(), outName: this.outName,
      outUnit: this.outUnit, outMax: this.outMax, wrapSpan: this.wrapSpan, fbId: this.fbId,
      note: this.note, caps: { ...this.caps },
    };
  }

  override accepts(canId: number, data: Uint8Array): boolean {
    return gdMotorFromStatus(canId, data) === this.motorId;
  }

  override parse(_canId: number, data: Uint8Array): Feedback | null {
    if (data.length !== 8) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      pos: (view.getInt16(2, true) / 10000) * TAU,
      vel: (view.getInt16(4, true) / 4000) * TAU,
      out: view.getInt16(6, true) / 100,
      temp: Number.NaN, temp2: Number.NaN, code: data[1], enabled: null,
      motorId: this.motorId, raw: new Uint8Array(data),
    };
  }

  override outputFrames(out: number): FrameTuple[] {
    finite(out, '扭矩');
    const raw = Math.round(Math.max(-this.outMax, Math.min(this.outMax, out)) * 100);
    const data = new Uint8Array([0x1b, GD_QUERY_STATUS, 0, 0]);
    new DataView(data.buffer).setInt16(2, raw, true);
    return [[this.txId, data], ...this.idleFrames()];
  }

  override stopFrames(): FrameTuple[] { return this.outputFrames(0); }

  override mitFrames(cmd: MitCommand): FrameTuple[] {
    if (cmd.kp === 0 && cmd.kd === 0) return this.outputFrames(cmd.t);
    const mit: FrameTuple = [this.mitId, packGdMit(cmd)];
    return [mit, ...this.idleFrames()];
  }

  override idleFrames(): FrameTuple[] { return [[this.txId, new Uint8Array([0x00, GD_QUERY_STATUS])]]; }
  override disableFrames(): FrameTuple[] { return [[this.txId, new Uint8Array([0x01, GD_QUERY_STATUS])]]; }
  override zeroFrames(): FrameTuple[] { return [[this.txId, new Uint8Array([0x03, 0x03, 0x03])]]; }

  override codeText(code: number): string { return code === 0 ? '无错误' : `GD 错误码 0x${code.toString(16).toUpperCase().padStart(2, '0')}`; }
  override isFault(code: number): boolean { return code > 0; }

  override describe(canId: number, data: Uint8Array, tx: boolean): string {
    if (!tx && canId === this.fbId && data.length === 8 && data[0] === GD_QUERY_STATUS) {
      const fb = this.parse(canId, data);
      return fb ? `位置: ${fb.pos.toFixed(5)} rad, 速度: ${fb.vel.toFixed(3)} rad/s, 扭矩: ${fb.out >= 0 ? '+' : ''}${fb.out.toFixed(2)} Nm, ${this.codeText(fb.code)}` : '';
    }
    if (tx && canId === this.mitId && data.length === 8) return 'GD MIT 控制';
    if (tx && canId === this.txId && data.length >= 2) {
      if (data[0] === 0x1b && data.length === 4) return `下发扭矩: ${new DataView(data.buffer, data.byteOffset, data.byteLength).getInt16(2, true) / 100} Nm`;
      if (data[0] === 0) return 'GD 状态查询';
      if (data[0] === 0x01) return '自由停转';
    }
    return '';
  }
}
