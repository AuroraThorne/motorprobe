import {
  ExciteConfig,
  ExciteKind,
  LoopConfig,
  LoopKind,
  RefKind,
} from '../../shared/protocol';

export const EXCITE_KIND_NAMES: Record<ExciteKind, string> = {
  step: '阶跃',
  stepsine: '步进正弦',
  chirp: '扫频',
  prbs: 'PRBS',
};

export const LOOP_KIND_NAMES: Record<LoopKind, string> = {
  vel: '速度环（PI）',
  pos: '串级位置环',
  pos_single: '单环位置环（PID）',
};

export const REF_KIND_NAMES: Record<RefKind, string> = {
  step: '阶跃',
  ramp: '斜坡',
  sine: '正弦',
};

function lowpass(last: number, value: number, cutoff: number, dt: number): number {
  if (cutoff <= 0) return value;
  const rc = 1.0 / (2.0 * Math.PI * cutoff);
  const alpha = dt / (rc + dt);
  return last + alpha * (value - last);
}

/**
 * Deterministic seeded PRNG (Mulberry32) for reproducible PRBS sequences.
 */
function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PidController {
  readonly maxI: number;
  readonly maxOut: number;
  readonly errFc: number;
  readonly dFc: number;
  err = 0.0;
  lastErr = 0.0;
  iOut = 0.0;
  dOut = 0.0;
  out = 0.0;

  constructor(
    public readonly kp: number,
    public readonly ki: number,
    public readonly kd: number,
    public readonly ff: number,
    maxI: number,
    maxOut: number,
    errFc: number,
    dFc: number,
  ) {
    this.maxI = Math.max(0.0, maxI);
    this.maxOut = Math.max(0.0, maxOut);
    this.errFc = Math.max(0.0, errFc);
    this.dFc = Math.max(0.0, dFc);
  }

  components(): [number, number, number] {
    return [this.kp * this.err, this.iOut, this.dOut];
  }

  calculate(error: number, rawDt: number, derr?: number): number {
    const dt = Math.min(Math.max(rawDt, 1e-4), 0.01);
    this.err = lowpass(this.err, error, this.errFc, dt);
    this.iOut = Math.max(-this.maxI, Math.min(this.maxI, this.iOut + this.ki * this.err * dt));
    const d = this.kd * (derr !== undefined ? derr : (this.err - this.lastErr) / dt);
    this.dOut = lowpass(this.dOut, d, this.dFc, dt);
    this.lastErr = this.err;
    this.out = this.kp * this.err + this.iOut + this.dOut + this.ff;
    if (this.maxOut <= 0.0) {
      this.track(0.0);
    } else if (Math.abs(this.out) > this.maxOut) {
      this.track(Math.max(-this.maxOut, Math.min(this.maxOut, this.out)));
    }
    return this.out;
  }

  track(actual: number): void {
    const i = this.iOut + actual - this.out;
    this.iOut = Math.max(Math.min(i, Math.max(0.0, this.iOut)), Math.min(0.0, this.iOut));
    this.out = actual;
  }
}

export interface RunRecord {
  t: number[];
  u: number[];
  ref: number[];
  pos: number[];
  vel: number[];
  fbOut: number[];
  seg: number[];
  pOut: number[];
  iOut: number[];
  dOut: number[];
}

export function createEmptyRecord(): RunRecord {
  return {
    t: [],
    u: [],
    ref: [],
    pos: [],
    vel: [],
    fbOut: [],
    seg: [],
    pOut: [],
    iOut: [],
    dOut: [],
  };
}

export interface MinimalFeedback {
  vel: number;
  out: number;
}

export abstract class BaseRun {
  title = '';
  rec: RunRecord = createEmptyRecord();
  t0 = 0.0;
  pos0 = 0.0;
  vel0 = 0.0;
  ref = Number.NaN;
  done = false;
  reason = '';
  seg = -1;

  start(t0: number, pos0: number, vel0: number): void {
    this.t0 = t0;
    this.pos0 = pos0;
    this.vel0 = vel0;
  }

  abstract output(now: number, fb: MinimalFeedback | null, posMt: number): number | null;

  record(t: number, u: number, fb: MinimalFeedback, posMt: number): void {
    const r = this.rec;
    // A queued feedback frame can carry a hardware/receive timestamp from just before the run started.
    r.t.push(Math.max(0.0, t - this.t0));
    r.u.push(u);
    r.ref.push(this.ref);
    r.pos.push(posMt);
    r.vel.push(fb.vel);
    r.fbOut.push(fb.out);
    r.seg.push(this.seg);
    r.pOut.push(Number.NaN);
    r.iOut.push(Number.NaN);
    r.dOut.push(Number.NaN);
  }

  snapshotRecord(): RunRecord {
    const r = this.rec;
    return {
      t: [...r.t],
      u: [...r.u],
      ref: [...r.ref],
      pos: [...r.pos],
      vel: [...r.vel],
      fbOut: [...r.fbOut],
      seg: [...r.seg],
      pOut: [...r.pOut],
      iOut: [...r.iOut],
      dOut: [...r.dOut],
    };
  }

  finish(reason = ''): void {
    this.done = true;
    this.reason = reason;
  }
}

export function logFreqs(f0: number, f1: number, n: number): number[] {
  if (n <= 1) return [f0];
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = f0 * Math.pow(f1 / f0, i / (n - 1));
  }
  return out;
}

export function exciteLabel(cfg: ExciteConfig): string {
  const k = EXCITE_KIND_NAMES[cfg.kind];
  if (cfg.kind === 'step') {
    return `${k} ${cfg.amp}，持续 ${cfg.stepOn} s`;
  }
  return `${k} ±${cfg.amp}，${cfg.f0}~${cfg.f1} Hz`;
}

export class ExciteRun extends BaseRun {
  readonly segs: Array<[number, number, number]> = [];
  readonly total: number;
  private readonly prbs: number[];

  constructor(public readonly cfg: ExciteConfig) {
    super();
    this.title = '响应测试：' + exciteLabel(cfg);
    if (cfg.kind === 'stepsine') {
      let t = 0.0;
      for (const f of logFreqs(cfg.f0, cfg.f1, cfg.nFreq)) {
        let dur = Math.max(cfg.cycles / f, cfg.minSeg);
        dur = Math.ceil(dur * f) / f;
        this.segs.push([t, t + dur, f]);
        t += dur;
      }
      this.total = t;
    } else if (cfg.kind === 'step') {
      this.total = cfg.stepDelay + cfg.stepOn + cfg.stepTail;
    } else {
      this.total = cfg.duration;
    }
    const rnd = createRng(cfg.seed);
    const n = Math.trunc(this.total / Math.max(1e-4, cfg.prbsDt)) + 2;
    this.prbs = Array.from({ length: n }, () => (rnd() < 0.5 ? 1.0 : -1.0));
  }

  excitation(t: number): number {
    const c = this.cfg;
    this.seg = -1;
    if (c.kind === 'step') {
      return c.stepDelay <= t && t < c.stepDelay + c.stepOn ? c.amp : 0.0;
    }
    if (c.kind === 'stepsine') {
      for (let i = 0; i < this.segs.length; i++) {
        const [a, b, f] = this.segs[i];
        if (a <= t && t < b) {
          this.seg = i;
          return c.amp * Math.sin(2 * Math.PI * f * (t - a));
        }
      }
      return 0.0;
    }
    if (c.kind === 'chirp') {
      const T = this.total;
      const k = Math.log(c.f1 / c.f0) / T;
      const ph = Math.abs(k) > 1e-9 ? (2 * Math.PI * c.f0 * (Math.exp(k * t) - 1)) / k : 2 * Math.PI * c.f0 * t;
      return c.amp * Math.sin(ph);
    }
    if (c.kind === 'prbs') {
      const idx = Math.min(this.prbs.length - 1, Math.max(0, Math.trunc(t / c.prbsDt)));
      return c.amp * this.prbs[idx];
    }
    return 0.0;
  }

  override output(now: number): number | null {
    const t = now - this.t0;
    if (t >= this.total) {
      this.ref = Number.NaN;
      return null;
    }
    const x = this.excitation(t);
    this.ref = x;
    return x;
  }
}

export function loopLabel(cfg: LoopConfig): string {
  const kd = cfg.loop === 'pos' || cfg.loop === 'pos_single' ? ` Kd=${cfg.kd}` : '';
  let ref = '';
  if (cfg.refKind === 'step') {
    const values = cfg.stepValues.length > 0 ? cfg.stepValues : [cfg.amp];
    const durations = cfg.stepDurations.length > 0 ? cfg.stepDurations : [cfg.duration];
    const steps = values.map((v, i) => `${v}/${durations[i] ?? cfg.duration}s`).join(', ');
    ref = `${REF_KIND_NAMES[cfg.refKind]} [${steps}]`;
  } else {
    ref = `${REF_KIND_NAMES[cfg.refKind]} ${cfg.amp}`;
  }
  return `${LOOP_KIND_NAMES[cfg.loop]} ${ref} Kp=${cfg.kp} Ki=${cfg.ki}${kd}`;
}

export class LoopRun extends BaseRun {
  readonly innerPid: PidController;
  readonly outerPid: PidController;
  readonly legacyPosition: boolean;
  readonly stepValues: number[];
  readonly stepDurations: number[];
  readonly total: number;
  private prevT: number | null = null;
  sat = 0;
  n = 0;

  constructor(public readonly cfg: LoopConfig) {
    super();
    this.title = '闭环测试：' + loopLabel(cfg);
    this.innerPid = new PidController(
      cfg.kp,
      cfg.ki,
      cfg.kd,
      cfg.ff,
      cfg.integralMax,
      cfg.outMax,
      cfg.errFc,
      cfg.dFc,
    );
    this.legacyPosition = cfg.loop === 'pos_single' || (cfg.loop === 'pos' && (cfg.posKp === undefined || cfg.posKp === null));
    this.outerPid = new PidController(
      cfg.posKp ?? 0.0,
      cfg.posKi ?? 0.0,
      cfg.posKd ?? 0.0,
      cfg.posFf,
      cfg.posIntegralMax,
      cfg.posOutMax,
      cfg.posErrFc,
      cfg.posDFc,
    );
    this.stepValues = cfg.stepValues.length > 0 ? cfg.stepValues : [cfg.amp];
    this.stepDurations = cfg.stepDurations.length > 0 ? cfg.stepDurations : [cfg.duration];
    this.total =
      cfg.refKind === 'step'
        ? this.stepDurations.reduce((a, b) => a + b, 0)
        : cfg.duration;
  }

  reference(t: number): number {
    const c = this.cfg;
    let x = 0.0;
    if (c.refKind === 'step') {
      let elapsed = 0.0;
      x = this.stepValues[this.stepValues.length - 1] ?? 0.0;
      for (let i = 0; i < this.stepValues.length; i++) {
        const dur = this.stepDurations[i] ?? c.duration;
        if (t < elapsed + dur) {
          x = this.stepValues[i];
          break;
        }
        elapsed += dur;
      }
    } else if (c.refKind === 'ramp') {
      const elapsed = Math.max(0.0, t - c.delay);
      x = c.amp * Math.min(1.0, elapsed / Math.max(c.rampTime, 1e-6));
    } else {
      const elapsed = Math.max(0.0, t - c.delay);
      x = c.amp * Math.sin(2 * Math.PI * c.freq * elapsed);
    }
    if ((c.loop === 'pos' || c.loop === 'pos_single') && c.relative) {
      x += this.pos0;
    }
    return x;
  }

  override output(now: number, fb: MinimalFeedback | null, posMt: number): number | null {
    const c = this.cfg;
    const t = now - this.t0;
    if (t >= this.total) {
      this.ref = Number.NaN;
      return null;
    }
    if (fb === null) return 0.0;
    const r = this.reference(t);
    this.ref = r;
    const dt = this.prevT === null ? 0.0 : Math.max(0.0, now - this.prevT);
    this.prevT = now;

    let u = 0.0;
    if (c.loop === 'vel') {
      u = this.innerPid.calculate(r - fb.vel, dt);
    } else if (this.legacyPosition) {
      const derr = c.dOnMeas ? -fb.vel : 0.0;
      u = this.innerPid.calculate(r - posMt, dt, derr);
    } else {
      const speedRef = this.outerPid.calculate(r - posMt, dt);
      u = this.innerPid.calculate(speedRef - fb.vel, dt);
    }
    this.n += 1;
    if (this.innerPid.maxOut > 0 && Math.abs(u) >= this.innerPid.maxOut) {
      this.sat += 1;
    }
    return u;
  }

  override record(t: number, u: number, fb: MinimalFeedback, posMt: number): void {
    super.record(t, u, fb, posMt);
    const [p, i, d] = this.innerPid.components();
    this.rec.pOut[this.rec.pOut.length - 1] = p;
    this.rec.iOut[this.rec.iOut.length - 1] = i;
    this.rec.dOut[this.rec.dOut.length - 1] = d;
  }

  components(): [number, number, number] {
    return this.innerPid.components();
  }

  trackOutput(actual: number): void {
    this.innerPid.track(actual);
  }

  get satRatio(): number {
    return this.n > 0 ? this.sat / this.n : 0.0;
  }
}
