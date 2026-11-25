import { Limits, MitCommand, ZERO_MIT } from '../../shared/protocol';
import { BusError, CanBus, createFrame, Frame, nowSec } from '../bus/types';
import { DJI_MODELS, DjiModelDef } from '../drivers/dji';
import * as P from '../drivers/dmProtocol';
import { FrameTuple } from '../drivers/base';
import { GD_RX_BASE, GD_QUERY_STATUS, GD_TX_BASE, GdMitCommand, unpackGdMit } from '../drivers/gd';

function gauss(mean = 0, std = 1): number {
  const u1 = Math.max(1e-12, Math.random());
  const u2 = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function wrap(x: number, half: number): number {
  const span = 2 * half;
  return ((((x + half) % span) + span) % span) - half;
}

export class Plant {
  pos = 0.0;
  vel = 0.0;

  constructor(
    public J: number,
    public b: number,
    public fc: number,
    public fs: number,
    public k = 1.0,
  ) {}

  step(u: number, dt: number): void {
    const tau = this.k * u;
    if (Math.abs(this.vel) < 1e-3 && Math.abs(tau) <= this.fs) {
      this.vel = 0.0;
      return;
    }
    const signTarget = Math.abs(this.vel) >= 1e-3 ? this.vel : tau;
    const s = signTarget >= 0 ? 1.0 : -1.0;
    const acc = (tau - this.fc * s - this.b * this.vel) / this.J;
    let vNew = this.vel + acc * dt;
    if (this.vel !== 0.0 && vNew > 0 !== this.vel > 0 && Math.abs(tau) <= this.fs) {
      vNew = 0.0;
    }
    this.pos += 0.5 * (this.vel + vNew) * dt;
    this.vel = vNew;
  }
}

export class DmSimMotor {
  enabled = false;
  err = 0;
  cmd: MitCommand = { ...ZERO_MIT };
  tau = 0.0;
  offset = 0.0;
  temp = 30.0;
  lastCmdT = nowSec();
  readonly regs = new Map<number, number>();

  constructor(
    public readonly family: 'hm' | 'dm',
    motorId: number,
    masterId: number,
    pMax: number,
    vMax: number,
    tMax: number,
    public readonly plant: Plant,
  ) {
    for (const r of P.REGISTERS) {
      if (r.src === 'both' || r.src === family) {
        this.regs.set(r.rid, 0);
      }
    }
    const init: Array<[number, number]> = [
      [0x00, 12.0],
      [0x01, 0.12],
      [0x02, 100.0],
      [0x03, 14.0],
      [0x07, masterId],
      [0x08, motorId],
      [0x09, 0],
      [0x0b, 0.0],
      [0x0c, 0.0],
      [0x10, 21],
      [0x11, 0.121],
      [0x12, 70e-6],
      [0x13, 0.0035],
      [0x14, 9.0],
      [0x15, pMax],
      [0x16, vMax],
      [0x17, tMax],
      [0x18, 1000.0],
      [0x1d, 60.0],
      [0x23, 4],
      [0x50, 0.0],
      [0x51, 0.0],
    ];
    for (const [k, v] of init) this.regs.set(k, v);
    if (family === 'hm') {
      this.regs.set(0x0d, 1);
      this.regs.set(0x0e, 2);
      this.regs.set(0x3b, 40.0);
      this.regs.set(0x3c, 24.0);
      this.regs.set(0x3d, 30.0);
      this.regs.set(0x3e, 30.0);
    } else {
      this.regs.set(0x0a, 1);
      this.regs.set(0x0d, 11);
      this.regs.set(0x0e, 5013);
      this.regs.set(0x0f, 20261110);
      this.regs.set(0x24, 1);
    }
  }

  get lim(): Limits {
    return P.withMaps(
      P.DEFAULT_LIMITS,
      this.regs.get(0x15) ?? 12.5,
      this.regs.get(0x16) ?? 45,
      this.regs.get(0x17) ?? 54,
    );
  }

  get motorId(): number {
    return Math.trunc(this.regs.get(0x08) ?? 1);
  }

  get masterId(): number {
    return Math.trunc(this.regs.get(0x07) ?? 0);
  }

  outPos(): number {
    const pMax = this.regs.get(0x15) ?? Math.PI;
    return wrap(this.plant.pos - this.offset, pMax);
  }

  code(): number {
    if (this.err) return this.err;
    return this.enabled ? P.CODE_ENABLED : P.CODE_DISABLED;
  }

  injectFault(code: number): void {
    this.err = code;
    this.enabled = false;
  }

  step(dt: number, now: number): void {
    const to = Math.trunc(this.regs.get(0x09) ?? 0);
    if (this.enabled && to > 0 && now - this.lastCmdT > to * 50e-6) {
      this.injectFault(0x0d);
    }
    let tau = 0.0;
    if (this.enabled && !this.err) {
      const c = this.cmd;
      tau = c.kp * (c.p - this.outPos()) + c.kd * (c.v - this.plant.vel) + c.t;
      const L = this.lim;
      tau = P.clamp(tau, L.tMin, L.tMax);
    }
    this.tau = tau;
    this.plant.step(tau, dt);
    this.temp += (30.0 + Math.abs(tau) * 0.8 - this.temp) * dt * 0.05;
    if (this.family === 'hm') {
      this.regs.set(0x3d, this.temp);
      this.regs.set(0x3e, this.temp);
      this.regs.set(0x3c, 24.0 + (Math.random() - 0.5) * 0.1);
    }
    this.regs.set(0x51, this.plant.pos - this.offset);
    this.regs.set(0x50, wrap((this.plant.pos - this.offset) * (this.regs.get(0x14) ?? 9), Math.PI));
  }

  status(): Uint8Array {
    const L = this.lim;
    return P.packStatus(
      this.motorId,
      this.code(),
      this.outPos() + gauss(0, 2e-4),
      this.plant.vel,
      this.tau,
      Math.trunc(this.temp),
      Math.trunc(this.temp),
      L,
    );
  }

  handle(canId: number, d: Uint8Array, now: number): FrameTuple[] {
    if (d.length !== 8) return [];
    if (canId === this.motorId) {
      if (P.isSpecial(d)) {
        const c = d[7];
        if (c === P.SPECIAL_ENABLE && !this.err) {
          this.enabled = true;
          this.lastCmdT = now;
        } else if (c === P.SPECIAL_DISABLE) {
          this.enabled = false;
        } else if (c === P.SPECIAL_ZERO) {
          this.offset = this.plant.pos;
          this.cmd.p = 0.0;
        } else if (c === P.SPECIAL_CLEAR_ERROR) {
          this.err = 0;
        }
      } else {
        this.cmd = P.unpackMit(d, this.lim);
        this.lastCmdT = now;
      }
      return [[this.masterId, this.status()]];
    }
    if (canId !== P.CONFIG_ID || (d[0] | (d[1] << 8)) !== this.motorId) {
      return [];
    }
    const cmd = d[2];
    const rid = d[3];
    if (cmd === P.CMD_STATE) {
      return [[this.masterId, this.status()]];
    }
    if (cmd === P.CMD_SAVE) {
      if (d[3] === 1 && !this.enabled) {
        const rep = new Uint8Array(8);
        rep.set(d.subarray(0, 4), 0);
        return [[this.masterId, rep]];
      }
      return [];
    }
    if (!this.regs.has(rid)) return [];
    const reg = P.REG_BY_RID.get(rid);
    const typ = reg?.typ ?? 'u';
    if (cmd === P.CMD_WRITE) {
      this.regs.set(rid, P.decodeValue(typ, d.subarray(4, 8)));
    } else if (cmd !== P.CMD_READ) {
      return [];
    }
    const rep = new Uint8Array(8);
    rep.set(d.subarray(0, 4), 0);
    rep.set(P.encodeValue(typ, this.regs.get(rid) ?? 0), 4);
    return [[this.masterId, rep]];
  }
}

export class DjiSimMotor {
  readonly m: DjiModelDef;
  cur = 0.0;
  lastCmdT = 0.0;
  temp = 32.0;

  constructor(
    public readonly model: string,
    public readonly motorId: number,
    public readonly plant: Plant,
  ) {
    this.m = DJI_MODELS[model];
  }

  get fbId(): number {
    return this.m.fbBase + this.motorId;
  }

  handle(canId: number, d: Uint8Array, now: number): FrameTuple[] {
    const [cid, slot] =
      this.m.zeroBasedId
        ? this.motorId < 4 ? [this.m.ctrlLo, this.motorId] : [this.m.ctrlHi, this.motorId - 4]
        : this.motorId <= 4 ? [this.m.ctrlLo, this.motorId - 1] : [this.m.ctrlHi, this.motorId - 5];
    if (canId === cid && d.length >= 2 * slot + 2) {
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const raw = dv.getInt16(2 * slot, false);
      this.cur = Math.max(-1.0, Math.min(1.0, raw / this.m.rawMax)) * this.m.ampMax;
      this.lastCmdT = now;
    }
    return [];
  }

  step(dt: number, now: number): void {
    if (now - this.lastCmdT > 0.1) {
      this.cur = 0.0;
    }
    this.plant.step(this.cur, dt);
    this.temp += (32.0 + Math.abs(this.cur) * 0.5 - this.temp) * dt * 0.05;
  }

  feedback(): Uint8Array {
    const gr = this.m.gr;
    const twoPi = 2 * Math.PI;
    const rotor = (((this.plant.pos * gr) % twoPi) + twoPi) % twoPi;
    const ang = Math.trunc((rotor / twoPi) * 8192) % 8192;
    let rpm = Math.round((this.plant.vel * gr * 60) / twoPi);
    rpm = Math.max(-32768, Math.min(32767, rpm));
    let cur = Math.round((this.cur / this.m.ampMax) * this.m.rawMax + gauss(0, 20));
    cur = Math.max(-32768, Math.min(32767, cur));
    const temp = this.m.hasTemp ? Math.trunc(this.temp) & 0xff : 0;
    const out = new Uint8Array(8);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, ang, false);
    if (this.m.feedbackFormat === '6623') {
      dv.setInt16(2, cur, false);
      dv.setInt16(4, Math.round(Math.max(-this.m.rawMax, Math.min(this.m.rawMax, this.cur))), false);
      return out;
    }
    dv.setInt16(2, rpm, false);
    dv.setInt16(4, cur, false);
    out[6] = temp;
    out[7] = 0;
    return out;
  }
}

export class GdSimMotor {
  torque = 0;
  directTorque = false;
  cmd: GdMitCommand = { ...ZERO_MIT };
  faultCode = 0;
  constructor(public readonly motorId: number, public readonly plant: Plant, public readonly model: string) {}

  get fbId(): number { return GD_RX_BASE | (this.motorId << 8); }

  step(dt: number, _now?: number): void {
    const errorP = this.cmd.p - this.plant.pos;
    const errorV = this.cmd.v - this.plant.vel;
    const demand = this.cmd.kp * errorP + this.cmd.kd * errorV + this.cmd.t;
    this.plant.step(this.faultCode === 0 ? (this.directTorque ? this.torque : demand) : 0, dt);
  }

  feedback(): Uint8Array {
    const data = new Uint8Array(8);
    const view = new DataView(data.buffer);
    const wrappedPos = ((this.plant.pos / (2 * Math.PI)) * 10000) | 0;
    data[0] = GD_QUERY_STATUS;
    data[1] = this.faultCode;
    view.setInt16(2, Math.max(-32768, Math.min(32767, wrappedPos)), true);
    view.setInt16(4, Math.round(Math.max(-32768, Math.min(32767, (this.plant.vel / (2 * Math.PI)) * 4000))), true);
    view.setInt16(6, Math.round(Math.max(-32768, Math.min(32767, this.torque * 100))), true);
    return data;
  }

  handle(canId: number, data: Uint8Array, extended: boolean): FrameTuple[] {
    if (!extended || data.length < 2) return [];
    if (canId === (GD_TX_BASE | this.motorId)) {
      if (data[0] === 0x1b && data.length === 4) {
        this.torque = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt16(2, true) / 100;
        this.cmd = { ...ZERO_MIT };
        this.directTorque = true;
      } else if (data[0] === 0x00 && data[1] === GD_QUERY_STATUS) {
        return [[this.fbId, this.feedback(), true]];
      } else if (data[0] === 0x00 && data[1] === 0x07) {
        const name = Buffer.from(this.model, 'ascii');
        const reply = new Uint8Array([0x07, name.length, ...name.subarray(0, 6)]);
        return [[this.fbId, reply, true]];
      } else if (data[0] === 0x01) {
        this.torque = 0;
        this.cmd = { ...ZERO_MIT };
        this.directTorque = true;
      } else if (data[0] === 0x03 && data[1] === 0x03 && data[2] === 0x03) {
        this.plant.pos = 0;
      }
      return [];
    }
    if (canId === (0x58000 | this.motorId) && data.length === 8) {
      this.cmd = unpackGdMit(data);
      this.torque = 0;
      this.directTorque = false;
      return [];
    }
    return [];
  }
}

export type SimMotor = DmSimMotor | DjiSimMotor | GdSimMotor;

export function defaultMotors(): SimMotor[] {
  return [
    new DmSimMotor('hm', 1, 0x00, Math.PI, 45.0, 54.0, new Plant(0.006, 0.02, 0.6, 0.8)),
    new DmSimMotor('dm', 3, 0x13, 12.5, 45.0, 54.0, new Plant(0.006, 0.03, 0.5, 0.7)),
    new DjiSimMotor('M3508 (C620)', 1, new Plant(0.002, 0.004, 0.08, 0.1, 0.3)),
    new DjiSimMotor('M2006 (C610)', 2, new Plant(0.0008, 0.002, 0.03, 0.04, 0.18)),
    new DjiSimMotor('GM6020 (电流模式)', 2, new Plant(0.003, 0.01, 0.05, 0.07, 0.741)),
    new DjiSimMotor('RM 6623', 0, new Plant(0.003, 0.01, 0.04, 0.06)),
    new GdSimMotor(6, new Plant(0.008, 0.025, 0.1, 0.15), '5036-02-CNE'),
    new GdSimMotor(7, new Plant(0.009, 0.03, 0.1, 0.15), '6036'),
  ];
}

interface QueuedFrame {
  due: number;
  seq: number;
  canId: number;
  data: Uint8Array;
  extended: boolean;
}

export class DemoBus implements CanBus {
  readonly name = '演示台';
  readonly bitrate = 1_000_000;
  readonly motors: SimMotor[];
  private queue: QueuedFrame[] = [];
  private seq = 0;
  private running = false;
  private lastStepT = 0;
  private nextFbT = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    motors?: SimMotor[],
    public readonly latency = 0.001,
  ) {
    this.motors = motors ?? defaultMotors();
  }

  motor<T extends SimMotor>(ctor: new (...args: never[]) => T, motorId: number): T {
    const found = this.motors.find((m): m is T => m instanceof ctor && m.motorId === motorId);
    if (!found) throw new Error(`未找到仿真电机 ID=${motorId}`);
    return found;
  }

  open(): void {
    this.running = true;
    const now = nowSec();
    this.lastStepT = now;
    this.nextFbT = now;
    this.timer = setInterval(() => this.advance(nowSec()), 2);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  close(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue.length = 0;
  }

  private push(due: number, canId: number, data: Uint8Array, extended = false): void {
    this.seq += 1;
    const item: QueuedFrame = { due, seq: this.seq, canId, data, extended };
    this.queue.push(item);
    // Keep sorted by due ascending (small queue)
    let i = this.queue.length - 1;
    while (i > 0 && (this.queue[i - 1].due > item.due || (this.queue[i - 1].due === item.due && this.queue[i - 1].seq > item.seq))) {
      this.queue[i] = this.queue[i - 1];
      this.queue[i - 1] = item;
      i--;
    }
  }

  private advance(now: number): void {
    if (!this.running) return;
    const rawDt = now - this.lastStepT;
    if (rawDt <= 0) return;
    const dt = Math.min(rawDt, 0.02);
    this.lastStepT = now;

    const n = Math.max(1, Math.trunc(dt / 0.0005));
    const subDt = dt / n;
    const t0 = now - dt;
    for (let s = 1; s <= n; s++) {
      const tCur = t0 + s * subDt;
      for (const m of this.motors) {
        m.step(subDt, tCur);
      }
      if (tCur >= this.nextFbT) {
        this.nextFbT = Math.max(this.nextFbT + 0.001, tCur - 0.005);
        for (const m of this.motors) {
          if (m instanceof DjiSimMotor) {
            this.push(tCur, m.fbId, m.feedback());
          }
        }
      }
    }
  }

  send(canId: number, data: Uint8Array, extended = false): void {
    if (!this.running) throw new BusError('总线未打开');
    const now = nowSec();
    this.advance(now);
    const payload = new Uint8Array(data);
    for (const m of this.motors) {
      const replies = m instanceof GdSimMotor
        ? m.handle(canId, payload, extended)
        : m.handle(canId, payload, now);
      for (const [rid, rd, replyExtended] of replies) {
        const jitter = 0.8 + Math.random() * 0.8;
        this.push(now + this.latency * jitter, rid, rd, replyExtended ?? false);
      }
    }
  }

  recvAll(): Frame[] {
    const now = nowSec();
    this.advance(now);
    const out: Frame[] = [];
    let k = 0;
    while (k < this.queue.length && this.queue[k].due <= now) {
      const q = this.queue[k];
      out.push(createFrame(q.due, q.canId, q.data, { extended: q.extended }));
      k++;
    }
    if (k > 0) {
      this.queue.splice(0, k);
    }
    return out;
  }

  statusText(): string {
    return this.running ? 'OK' : '未打开';
  }
}
