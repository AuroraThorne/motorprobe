import { DriverCaps, DriverSummary } from '../../shared/protocol';
import { Driver, Feedback, FrameTuple } from './base';

export interface DjiModelDef {
  name: string;
  esc: string;
  idMin: number;
  idMax: number;
  fbBase: number;
  ctrlLo: number;
  ctrlHi: number;
  rawMax: number;
  ampMax: number;
  gr: number;
  hasTemp: boolean;
  note: string;
  feedbackFormat?: 'rpm_current_temp' | '6623';
  zeroBasedId?: boolean;
  outUnit?: string;
}

export const DJI_MODELS: Record<string, DjiModelDef> = {
  'M3508 (C620)': {
    name: 'M3508 (C620)',
    esc: 'C620',
    idMin: 1,
    idMax: 8,
    fbBase: 0x200,
    ctrlLo: 0x200,
    ctrlHi: 0x1ff,
    rawMax: 16384,
    ampMax: 20.0,
    gr: 3591 / 187,
    hasTemp: true,
    note: '',
  },
  'M2006 (C610)': {
    name: 'M2006 (C610)',
    esc: 'C610',
    idMin: 1,
    idMax: 8,
    fbBase: 0x200,
    ctrlLo: 0x200,
    ctrlHi: 0x1ff,
    rawMax: 10000,
    ampMax: 10.0,
    gr: 36.0,
    hasTemp: false,
    note: '反馈电流比例按 ±10000↔±10 A 假定，待核对；C610 无温度反馈',
  },
  'GM6020 (电流模式)': {
    name: 'GM6020 (电流模式)',
    esc: 'GM6020',
    idMin: 1,
    idMax: 7,
    fbBase: 0x204,
    ctrlLo: 0x1fe,
    ctrlHi: 0x2fe,
    rawMax: 16384,
    ampMax: 3.0,
    gr: 1.0,
    hasTemp: true,
    note: '需在 RoboMaster Assistant 中打开电流环；反馈电流比例按 ±16384↔±3 A 假定，待核对',
  },
  'RM 6623': {
    name: 'RM 6623', esc: '6623', idMin: 0, idMax: 7, fbBase: 0x205,
    ctrlLo: 0x1ff, ctrlHi: 0x2ff, rawMax: 5000, ampMax: 5000, gr: 1,
    hasTemp: false, note: '反馈无转速/温度字段；输出单位为厂家原始电流值',
    feedbackFormat: '6623', zeroBasedId: true, outUnit: '原始值',
  },
};

function i16(hi: number, lo: number): number {
  const v = (hi << 8) | lo;
  return v & 0x8000 ? v - 0x10000 : v;
}

export class DjiDriver extends Driver {
  readonly protocol = 'dji' as const;
  readonly protocolName = '大疆 RoboMaster';
  readonly caps: DriverCaps = {
    mit: false,
    registers: false,
    enableCmd: false,
    zero: false,
    clear: false,
    statusCode: false,
  };
  readonly outName = '电流';
  get outUnit(): string { return this.m.outUnit ?? 'A'; }
  readonly m: DjiModelDef;
  private last6623Pos: number | null = null;
  private last6623T: number | null = null;

  constructor(model = 'M3508 (C620)', motorId = 1) {
    const m = DJI_MODELS[model];
    if (!m) throw new Error(`未知大疆型号: ${model}`);
    if (!Number.isInteger(motorId) || motorId < m.idMin || motorId > m.idMax) {
      throw new RangeError(`${model} 的 ID 范围为 ${m.idMin}~${m.idMax}`);
    }
    super(model, motorId);
    this.m = m;
    this.note = m.note;
  }

  override get outMax(): number {
    return this.m.ampMax;
  }

  override get wrapSpan(): number {
    return (2 * Math.PI) / this.m.gr;
  }

  override get fbId(): number {
    return this.m.fbBase + this.motorId;
  }

  get ctrl(): [number, number] {
    if (this.m.zeroBasedId) {
      return this.motorId < 4 ? [this.m.ctrlLo, this.motorId] : [this.m.ctrlHi, this.motorId - 4];
    }
    if (this.motorId <= 4) {
      return [this.m.ctrlLo, this.motorId - 1];
    }
    return [this.m.ctrlHi, this.motorId - 5];
  }

  override title(): string {
    const [cid, slot] = this.ctrl;
    const fbHex = this.fbId.toString(16).toUpperCase().padStart(3, '0');
    const cidHex = cid.toString(16).toUpperCase().padStart(3, '0');
    return `${this.model}  ID ${this.motorId}（反馈 0x${fbHex} / 控制 0x${cidHex}#${slot + 1}）`;
  }

  override summary(): DriverSummary {
    const [cid, slot] = this.ctrl;
    return {
      protocol: 'dji',
      protocolName: this.protocolName,
      model: this.model,
      motorId: this.motorId,
      masterId: -1,
      title: this.title(),
      outName: this.outName,
      outUnit: this.outUnit,
      outMax: this.outMax,
      wrapSpan: this.wrapSpan,
      fbId: this.fbId,
      ctrlId: cid,
      ctrlSlot: slot,
      gr: this.m.gr,
      rawMax: this.m.rawMax,
      note: this.note,
      caps: { ...this.caps },
    };
  }

  override accepts(canId: number, data: Uint8Array): boolean {
    return canId === this.fbId && data.length >= 7;
  }

  override parse(_canId: number, data: Uint8Array, t?: number): Feedback | null {
    const ang = (data[0] << 8) | data[1];
    if (this.m.feedbackFormat === '6623') {
      const actual = i16(data[2], data[3]);
      let rotor = (ang / 8192.0) * 2 * Math.PI;
      if (rotor >= Math.PI) rotor -= 2 * Math.PI;
      let velocity = Number.NaN;
      if (t !== undefined && this.last6623T !== null && this.last6623Pos !== null && t > this.last6623T) {
        let delta = rotor - this.last6623Pos;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        else if (delta < -Math.PI) delta += 2 * Math.PI;
        velocity = delta / (t - this.last6623T);
      }
      this.last6623Pos = rotor;
      this.last6623T = t ?? this.last6623T;
      return {
        pos: rotor, vel: velocity, out: actual, temp: Number.NaN, temp2: Number.NaN,
        code: -1, enabled: null, motorId: this.motorId, raw: new Uint8Array(data),
      };
    }
    const rpm = i16(data[2], data[3]);
    const cur = i16(data[4], data[5]);
    let rotor = (ang / 8192.0) * 2 * Math.PI;
    if (rotor >= Math.PI) rotor -= 2 * Math.PI;
    const gr = this.m.gr;
    return {
      pos: rotor / gr,
      vel: ((rpm * 2 * Math.PI) / 60.0) / gr,
      out: (cur / this.m.rawMax) * this.m.ampMax,
      temp: this.m.hasTemp ? data[6] : Number.NaN,
      temp2: Number.NaN,
      code: -1,
      enabled: null,
      motorId: this.motorId,
      raw: new Uint8Array(data),
    };
  }

  encode(out: number): number {
    const a = this.m.ampMax;
    const clamped = Math.max(-a, Math.min(a, out));
    return Math.round((clamped / a) * this.m.rawMax);
  }

  override outputFrames(out: number): FrameTuple[] {
    const [cid, slot] = this.ctrl;
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    dv.setInt16(2 * slot, this.encode(out), false);
    return [[cid, buf]];
  }

  override describe(canId: number, data: Uint8Array, tx: boolean): string {
    const [cid, slot] = this.ctrl;
    if (tx && canId === cid && data.length === 8) {
      const raw = i16(data[2 * slot], data[2 * slot + 1]);
      if (this.m.feedbackFormat === '6623') return `下发电流: ${raw >= 0 ? '+' : ''}${raw} 原始值`;
      const amp = (raw / this.m.rawMax) * this.m.ampMax;
      const sign = amp >= 0 ? '+' : '';
      return `下发电流: ${sign}${amp.toFixed(3)} A`;
    }
    if (!tx && canId === this.fbId) {
      if (data.length < 7) return '反馈（数据长度不足）';
      const ang = (data[0] << 8) | data[1];
      if (this.m.feedbackFormat === '6623') {
        const actual = i16(data[2], data[3]);
        const command = i16(data[4], data[5]);
        let pos = (ang / 8192.0) * 2 * Math.PI;
        if (pos >= Math.PI) pos -= 2 * Math.PI;
        return `位置: ${pos.toFixed(5)} rad, 电流: ${actual >= 0 ? '+' : ''}${actual} 原始值, 指令: ${command} 原始值`;
      }
      const rpm = i16(data[2], data[3]);
      const cur = i16(data[4], data[5]);
      let rotor = (ang / 8192.0) * 2 * Math.PI;
      if (rotor >= Math.PI) rotor -= 2 * Math.PI;
      const pos = rotor / this.m.gr;
      const current = (cur / this.m.rawMax) * this.m.ampMax;
      const posTxt = pos.toFixed(5).padStart(8, ' ');
      const spdTxt = String(rpm).padStart(5, ' ');
      const curSign = current >= 0 ? '+' : '';
      const curTxt = (curSign + current.toFixed(5)).padStart(8, ' ');
      const tempTxt = this.m.hasTemp ? `, 温度: ${String(data[6]).padStart(3, ' ')} °C` : '';
      return `位置: ${posTxt} rad, 速度: ${spdTxt} rpm, 电流: ${curTxt} A${tempTxt}`;
    }
    return '';
  }
}

export function guessModels(fbId: number, data: Uint8Array): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const m of Object.values(DJI_MODELS)) {
    const mid = fbId - m.fbBase;
    if (mid >= m.idMin && mid <= m.idMax) {
      out.push([m.name, mid]);
    }
  }
  const noTemp = data.length >= 7 && data[6] === 0;
  const order = (name: string): number => {
    if (name === 'M2006 (C610)') return noTemp ? 0 : 2;
    if (name === 'M3508 (C620)') return 1;
    return 3;
  };
  out.sort((a, b) => order(a[0]) - order(b[0]));
  return out;
}
