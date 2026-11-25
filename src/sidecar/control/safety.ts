import { DEFAULT_SAFETY_LIMITS, SafetyLimits } from '../../shared/protocol';

export class MultiTurn {
  span: number;
  last: number | null = null;
  turns = 0;

  constructor(span = 2 * Math.PI) {
    this.span = span;
  }

  reset(): void {
    this.last = null;
    this.turns = 0;
  }

  update(raw: number): number {
    if (this.last !== null) {
      const d = raw - this.last;
      if (d > this.span / 2) {
        this.turns -= 1;
      } else if (d < -this.span / 2) {
        this.turns += 1;
      }
    }
    this.last = raw;
    return raw + this.turns * this.span;
  }
}

export class Supervisor {
  limits: SafetyLimits;
  readonly mt = new MultiTurn();
  tripped = false;
  reason = '';
  pos = 0.0;
  lastFbT: number | null = null;
  private _vel = 0.0;
  private _temp = 0.0;

  constructor(limits?: Partial<SafetyLimits>) {
    this.limits = { ...DEFAULT_SAFETY_LIMITS, ...limits };
  }

  setWrapSpan(span: number): void {
    this.mt.span = span;
    this.mt.reset();
  }

  trip(reason: string): void {
    if (!this.tripped) {
      this.tripped = true;
      this.reason = reason;
    }
  }

  reset(): boolean {
    const why = this.checkState(this._vel, this._temp);
    if (why) {
      this.reason = why;
      return false;
    }
    this.tripped = false;
    this.reason = '';
    return true;
  }

  private checkState(vel: number, temp: number): string {
    const L = this.limits;
    if (L.velEnabled && L.velMax > 0 && Math.abs(vel) > L.velMax) {
      const sign = vel >= 0 ? '+' : '';
      return `速度超限 ${sign}${vel.toFixed(3)} rad/s（限 ±${L.velMax}）`;
    }
    if (L.posEnabled && !(L.posMin <= this.pos && this.pos <= L.posMax)) {
      const sign = this.pos >= 0 ? '+' : '';
      return `位置超限 ${sign}${this.pos.toFixed(3)} rad（窗口 [${L.posMin}, ${L.posMax}]）`;
    }
    if (L.tempMax > 0 && temp > L.tempMax) {
      return `温度超限 ${temp.toFixed(0)} ℃（限 ${L.tempMax}）`;
    }
    return '';
  }

  onFeedback(t: number, rawPos: number, vel: number, temp: number): void {
    this.lastFbT = t;
    this.pos = this.mt.update(rawPos);
    this._vel = vel;
    this._temp = temp;
    const why = this.checkState(vel, temp);
    if (why) {
      this.trip(why);
    }
  }

  zeroPosition(): void {
    if (this.mt.last !== null) {
      this.mt.turns = 0;
      this.pos = this.mt.last;
    }
  }

  filterOutput(now: number, out: number): number {
    const L = this.limits;
    if (
      !this.tripped &&
      L.fbTimeout > 0 &&
      out !== 0.0 &&
      this.lastFbT !== null &&
      now - this.lastFbT > L.fbTimeout
    ) {
      this.trip(`反馈超时 >${(L.fbTimeout * 1000).toFixed(0)} ms`);
    }
    if (this.tripped) {
      return 0.0;
    }
    if (L.outEnabled && L.outMax > 0) {
      return Math.max(-L.outMax, Math.min(L.outMax, out));
    }
    return out;
  }
}
