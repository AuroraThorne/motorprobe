import { DriverCaps, DriverSummary, Limits, MitCommand } from '../../shared/protocol';
import { Driver, Feedback, FrameTuple } from './base';
import * as P from './dmProtocol';

export const DM_MODELS: Record<string, { family: 'hm' | 'dm' | 'both'; note: string }> = {
  HM9816G9: { family: 'hm', note: 'HM 关节电机，对标达妙 J8009P' },
  'DM-J8009P': { family: 'dm', note: '达妙 J8009P-2EC' },
  '达妙/HM 通用': { family: 'both', note: '型号未知，按协议族通用处理' },
};

export class DmDriver extends Driver {
  readonly protocol = 'dm' as const;
  readonly protocolName = '达妙/HM MIT';
  readonly caps: DriverCaps = {
    mit: true,
    registers: true,
    enableCmd: true,
    zero: true,
    clear: true,
    statusCode: true,
  };
  readonly outName = '扭矩';
  readonly outUnit = 'Nm';
  readonly family: 'hm' | 'dm' | 'both';
  lim: Limits = { ...P.DEFAULT_LIMITS };
  limitsOk = false;
  private readonly _masterId: number;

  constructor(model = 'HM9816G9', motorId = 1, masterId = 0) {
    super(model, motorId);
    this._masterId = masterId;
    const meta = DM_MODELS[model] ?? { family: 'both', note: '' };
    this.family = meta.family;
    this.note = meta.note;
  }

  override get masterId(): number {
    return this._masterId;
  }

  override get fbId(): number {
    return this._masterId;
  }

  override get ready(): boolean {
    return this.limitsOk;
  }

  override get outMax(): number {
    return this.lim.tMax;
  }

  override get wrapSpan(): number {
    return 2 * this.lim.pMax;
  }

  override title(): string {
    return `${this.model}  ID ${this.motorId} / Master 0x${this._masterId.toString(16).toUpperCase()}`;
  }

  override summary(): DriverSummary {
    return {
      protocol: 'dm',
      protocolName: this.protocolName,
      model: this.model,
      motorId: this.motorId,
      masterId: this._masterId,
      title: this.title(),
      outName: this.outName,
      outUnit: this.outUnit,
      outMax: this.outMax,
      wrapSpan: this.wrapSpan,
      fbId: this._masterId,
      family: this.family,
      note: this.note,
      caps: { ...this.caps },
    };
  }

  setLimits(pMax: number, vMax: number, tMax: number): void {
    this.lim = P.withMaps(P.DEFAULT_LIMITS, pMax, vMax, tMax);
    this.limitsOk = true;
  }

  invalidateLimits(): void {
    this.lim = { ...P.DEFAULT_LIMITS };
    this.limitsOk = false;
  }

  isConfigReply(data: Uint8Array, motorId?: number): boolean {
    const mid = motorId ?? this.motorId;
    return data.length >= 4 && P.CONFIG_CMDS.includes(data[2]) && (data[0] | (data[1] << 8)) === mid;
  }

  override accepts(canId: number, data: Uint8Array): boolean {
    return canId === this._masterId && data.length === 8 && !this.isConfigReply(data);
  }

  override parse(_canId: number, data: Uint8Array): Feedback | null {
    const st = P.unpackStatus(data, this.lim);
    return {
      pos: st.pos,
      vel: st.vel,
      out: st.torque,
      temp: st.tMos,
      temp2: st.tRotor,
      code: st.err,
      enabled: st.err === P.CODE_ENABLED,
      motorId: st.motorId4,
      raw: st.raw,
    };
  }

  override outputFrames(out: number): FrameTuple[] {
    return [[this.motorId, P.packMit({ p: 0, v: 0, kp: 0, kd: 0, t: out }, this.lim)]];
  }

  override stopFrames(): FrameTuple[] {
    return [[this.motorId, P.packMit(P.ZERO_MIT, this.lim)]];
  }

  override mitFrames(cmd: MitCommand): FrameTuple[] {
    return [[this.motorId, P.packMit(cmd, this.lim)]];
  }

  override idleFrames(): FrameTuple[] {
    return [[P.CONFIG_ID, P.queryStateFrame(this.motorId)]];
  }

  override enableFrames(): FrameTuple[] {
    return [[this.motorId, P.specialFrame(P.SPECIAL_ENABLE)]];
  }

  override disableFrames(): FrameTuple[] {
    return [[this.motorId, P.specialFrame(P.SPECIAL_DISABLE)]];
  }

  override clearFrames(): FrameTuple[] {
    return [[this.motorId, P.specialFrame(P.SPECIAL_CLEAR_ERROR)]];
  }

  override zeroFrames(): FrameTuple[] {
    return [[this.motorId, P.specialFrame(P.SPECIAL_ZERO)]];
  }

  override codeText(code: number): string {
    return P.codeText(code);
  }

  override isFault(code: number): boolean {
    return P.isFault(code);
  }

  override describe(canId: number, data: Uint8Array, tx: boolean): string {
    if (data.length !== 8) return '';
    if (tx) {
      if (canId === P.CONFIG_ID && (data[0] | (data[1] << 8)) === this.motorId) {
        const ridHex = `0x${data[3].toString(16).toUpperCase().padStart(2, '0')}`;
        if (data[2] === P.CMD_READ) return `读 ${ridHex}`;
        if (data[2] === P.CMD_WRITE) return `写 ${ridHex}`;
        if (data[2] === P.CMD_SAVE) return data[3] === 1 ? '保存' : `0xAA/${data[3].toString(16).toUpperCase().padStart(2, '0')}`;
        if (data[2] === P.CMD_STATE) return '查询状态';
        return '';
      }
      if (canId === this.motorId) {
        if (P.isSpecial(data)) return P.SPECIAL_NAMES[data[7]] ?? '';
        return 'MIT控制';
      }
      return '';
    }
    if (canId !== this._masterId) return '';
    if (this.isConfigReply(data)) {
      if (data[2] === P.CMD_SAVE) return '保存应答';
      const reg = P.REG_BY_RID.get(data[3]);
      if (!reg) return '应答';
      const val = P.decodeValue(reg.typ, data.slice(4, 8));
      const fmtVal = reg.typ === 'f' ? Number(val.toPrecision(7)).toString() : String(val);
      return `应答 ${reg.name} = ${fmtVal}`;
    }
    const st = P.unpackStatus(data, this.lim);
    const posTxt = st.pos.toFixed(5).padStart(8, ' ');
    const spdTxt = st.vel.toFixed(3).padStart(8, ' ');
    const trqSign = st.torque >= 0 ? '+' : '';
    const trqTxt = (trqSign + st.torque.toFixed(5)).padStart(8, ' ');
    const tMosTxt = String(st.tMos).padStart(3, ' ');
    const tRotTxt = String(st.tRotor).padStart(3, ' ');
    return `位置: ${posTxt} rad, 速度: ${spdTxt} rad/s, 扭矩: ${trqTxt} Nm, 温度: ${tMosTxt}/${tRotTxt} °C`;
  }
}
