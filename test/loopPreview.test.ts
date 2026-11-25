import { describe, expect, it } from 'vitest';
import { buildLoopReferencePreview } from '../src/webview/charts/loopPreview';
import { LoopConfig } from '../src/shared/protocol';

const base: LoopConfig = {
  loop: 'vel', kp: 0, ki: 0, kd: 0, refKind: 'step', amp: 2, freq: 1,
  rampTime: 1, delay: 0, duration: 2, outMax: 1, integralMax: 1, ff: 0,
  errFc: 0, dFc: 0, posKp: null, posKi: null, posKd: null, posFf: 0,
  posIntegralMax: 1, posOutMax: 1, posErrFc: 0, posDFc: 0, relative: true,
  dOnMeas: true, stepValues: [3, -1], stepDurations: [1, 2],
};

describe('closed-loop reference preview', () => {
  it('updates the plotted step sequence and never creates negative time', () => {
    const preview = buildLoopReferencePreview(base);
    expect(preview.t[0]).toBe(0);
    expect(preview.t.every((value) => value >= 0)).toBe(true);
    expect(preview.ref[0]).toBe(3);
    expect(preview.ref[preview.t.findIndex((value) => value >= 1)]).toBe(-1);
  });

  it('applies the configured position start offset and samples sine references', () => {
    const preview = buildLoopReferencePreview({
      ...base, loop: 'pos', refKind: 'sine', amp: 1, freq: 0.5,
      duration: 1, stepValues: [], stepDurations: [],
    }, 2);
    expect(preview.ref[0]).toBe(2);
    expect(preview.t[0]).toBeGreaterThanOrEqual(0);
    expect(preview.ref.some((value) => value > 2.9)).toBe(true);
  });
});
