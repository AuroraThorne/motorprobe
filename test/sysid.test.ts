import { describe, expect, it } from 'vitest';
import { BaseRun, ExciteRun, LoopRun } from '../src/sidecar/analysis/runs';
import * as sysid from '../src/sidecar/analysis/sysid';
import { ExciteConfig, LoopConfig } from '../src/shared/protocol';

function baseExciteCfg(partial: Partial<ExciteConfig>): ExciteConfig {
  return {
    kind: 'stepsine',
    amp: 0.5,
    stepOn: 0.3,
    stepDelay: 0.0,
    stepTail: 0.5,
    f0: 1.0,
    f1: 20.0,
    nFreq: 8,
    cycles: 6,
    minSeg: 0.3,
    duration: 6.0,
    prbsDt: 0.01,
    seed: 1,
    ...partial,
  };
}

function baseLoopCfg(partial: Partial<LoopConfig>): LoopConfig {
  return {
    loop: 'vel',
    kp: 0.1,
    ki: 0.0,
    kd: 0.0,
    refKind: 'step',
    amp: 2.0,
    freq: 1.0,
    rampTime: 1.0,
    delay: 0.0,
    duration: 2.0,
    outMax: 10.0,
    integralMax: 10.0,
    ff: 0.0,
    errFc: 0.0,
    dFc: 0.0,
    posKp: null,
    posKi: null,
    posKd: null,
    posFf: 0.0,
    posIntegralMax: 0.0,
    posOutMax: 50.0,
    posErrFc: 0.0,
    posDFc: 0.0,
    relative: true,
    dOnMeas: true,
    stepValues: [],
    stepDurations: [],
    ...partial,
  };
}

function simulate<T extends BaseRun>(
  run: T,
  opts: { J?: number; b?: number; fc?: number; dt?: number; delaySteps?: number } = {},
): T {
  const J = opts.J ?? 0.01;
  const b = opts.b ?? 0.05;
  const fc = opts.fc ?? 0.0;
  const dt = opts.dt ?? 0.002;
  const delaySteps = opts.delaySteps ?? 1;

  run.start(0.0, 0.0, 0.0);
  let v = 0.0;
  let p = 0.0;
  const hist = new Array<number>(delaySteps + 1).fill(0.0);
  let t = 0.0;
  while (true) {
    const u = run.output(t, { vel: v, out: 0.0 }, p);
    if (u === null) break;
    hist.push(u);
    const ua = hist.shift()!;
    const s = Math.abs(v) > 1e-4 ? Math.sign(v) : 0.0;
    v += ((ua - b * v - fc * s) / J) * dt;
    p += v * dt;
    run.record(t, u, { vel: v, out: ua }, p);
    t += dt;
  }
  return run;
}

describe('System Identification & Closed-Loop PID Auto-Tuning', () => {
  it('recovers J, b, Td from stepped-sine Bode fit', () => {
    const run = simulate(new ExciteRun(baseExciteCfg({ kind: 'stepsine', amp: 0.5, f0: 1, f1: 20, nFreq: 8 })));
    const bode = sysid.bodeFromRun(run);
    expect(bode).not.toBeNull();
    expect(bode!.f.length).toBe(8);
    const m = sysid.fitModel(bode!)!;
    expect(Math.abs(m.J - 0.01) / 0.01).toBeLessThan(0.1);
    expect(Math.abs(m.b - 0.05) / 0.05).toBeLessThan(0.3);
    expect(m.Td).toBeGreaterThan(0.001);
    expect(m.Td).toBeLessThan(0.01);
    for (let i = 0; i < bode!.f.length; i++) {
      const w = 2 * Math.PI * bode!.f[i];
      expect(Math.abs((bode!.magP[i] * w) / bode!.magV[i] - 1)).toBeLessThan(0.1);
    }
  });

  it('recovers inertia J from broadband chirp and PRBS Welch H1 estimators', () => {
    for (const kind of ['chirp', 'prbs'] as const) {
      const run = simulate(new ExciteRun(baseExciteCfg({ kind, amp: 0.5, f0: 1, f1: 20, duration: 6 })));
      const bode = sysid.bodeFromRun(run);
      expect(bode).not.toBeNull();
      const m = sysid.fitModel(bode!)!;
      expect(Math.abs(m.J - 0.01) / 0.01).toBeLessThan(0.3);
    }
  });

  it('keeps a usable broadband estimate for a 5 s 1–30 Hz sweep', () => {
    const run = simulate(new ExciteRun(baseExciteCfg({
      kind: 'chirp', amp: 1.5, f0: 1, f1: 30, duration: 5,
    })));
    const bode = sysid.bodeFromRun(run);
    expect(bode).not.toBeNull();
    expect(bode!.f.length).toBeGreaterThanOrEqual(3);
    expect(bode!.f.every((frequency) => frequency >= 1 && frequency <= 30)).toBe(true);
  });

  it('estimates J and Coulomb friction Fc from step response', () => {
    const run = simulate(
      new ExciteRun(baseExciteCfg({ kind: 'step', amp: 1.0, stepOn: 0.3, stepDelay: 0.1, stepTail: 0.4 })),
      { fc: 0.2 },
    );
    const m = sysid.stepModel(run.rec)!;
    expect(m).not.toBeNull();
    expect(Math.abs(m.J - 0.01) / 0.01).toBeLessThan(0.25);
    expect(Math.abs(m.Fc - 0.2)).toBeLessThan(0.08);
  });

  it('designs stable velocity PI, cascade position PID, and single-loop position PD', () => {
    const model = sysid.makeModel(0.01, 0.05, 0.0, 0.002);
    const s = sysid.suggest(model, { latency: 0.002, rateHz: 500, startRatio: 0.75 });
    expect(s.velKp).toBeGreaterThan(0);
    expect(s.velKi).toBeGreaterThan(0);
    expect(s.posKp).toBeGreaterThan(0);
    expect(s.posKi).toBeGreaterThan(0);
    expect(s.text).toContain('75%');

    const vel = simulate(
      new LoopRun(baseLoopCfg({ loop: 'vel', kp: s.velKp, ki: s.velKi, amp: 2.0, duration: 2.0 })),
      { delaySteps: 2 },
    );
    const velStats = sysid.loopStats(vel.rec, 'vel')!;
    expect(velStats.overshoot).toBeLessThan(40);
    expect(Math.abs(velStats.ssErr)).toBeLessThan(0.1);

    const pos = simulate(
      new LoopRun(
        baseLoopCfg({
          loop: 'pos',
          kp: s.velKp,
          ki: s.velKi,
          posKp: s.posKp,
          posKi: s.posKi,
          posKd: s.posKd,
          amp: 0.5,
          duration: 2.0,
          posOutMax: 10,
        }),
      ),
      { delaySteps: 2 },
    );
    const posStats = sysid.loopStats(pos.rec, 'pos')!;
    expect(posStats.overshoot).toBeLessThan(40);
    expect(Math.abs(posStats.ssErr)).toBeLessThan(0.05);

    const sCustom = sysid.suggest(model, {
      latency: 0.002,
      rateHz: 500,
      velBwHz: 5.0,
      singlePosBwHz: 2.0,
    });
    expect(sCustom.velBw).toBeGreaterThan(4.5);
    expect(sCustom.velBw).toBeLessThan(5.5);
    expect(sCustom.singlePosBw).toBeGreaterThan(1.8);
    expect(sCustom.singlePosBw).toBeLessThan(2.2);
    const curves = sysid.predictedClosedLoop(model, sCustom, 0.002, 500);
    expect(curves.f.length).toBe(curves.velDb.length);
  });
});
