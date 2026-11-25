import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFETY_LIMITS } from '../src/shared/protocol';
import { MultiTurn, Supervisor } from '../src/sidecar/control/safety';

describe('Safety Supervisor & MultiTurn', () => {
  it('leaves optional motion, output, temperature, and timeout limits disabled by default', () => {
    expect(DEFAULT_SAFETY_LIMITS.velEnabled).toBe(false);
    expect(DEFAULT_SAFETY_LIMITS.outEnabled).toBe(false);
    expect(DEFAULT_SAFETY_LIMITS.posEnabled).toBe(false);
    expect(DEFAULT_SAFETY_LIMITS.tempMax).toBe(0);
    expect(DEFAULT_SAFETY_LIMITS.fbTimeout).toBe(0);
  });

  it('unwraps multi-turn angles across +-pi seamlessly', () => {
    const m = new MultiTurn();
    const xs = [3.0, 3.1, -3.1, -3.0, 3.1, 3.0];
    const ys = xs.map((x) => m.update(x));
    expect(Math.abs(ys[2] - (2 * Math.PI - 3.1))).toBeLessThan(1e-9);
    expect(Math.abs(ys[4] - 3.1)).toBeLessThan(1e-9);
  });

  it('clamps output, latches zero torque on overspeed, and refuses reset while still overspeeding', () => {
    const s = new Supervisor({ velMax: 5, velEnabled: true, outMax: 1.0, outEnabled: true, tempMax: 0, fbTimeout: 0 });
    s.onFeedback(0.0, 0.0, 1.0, 30);
    expect(s.filterOutput(0.0, 3.0)).toBe(1.0);
    expect(s.filterOutput(0.0, -0.4)).toBe(-0.4);

    s.onFeedback(0.01, 0.0, 6.0, 30);
    expect(s.tripped).toBe(true);
    expect(s.reason).toContain('速度');
    expect(s.filterOutput(0.01, 0.5)).toBe(0.0);
    expect(s.reset()).toBe(false);

    s.onFeedback(0.02, 0.0, 0.5, 30);
    expect(s.tripped).toBe(true); // stays latched until explicit reset
    expect(s.reset()).toBe(true);
    expect(s.tripped).toBe(false);
  });

  it('enforces multi-turn position window limits', () => {
    const s = new Supervisor({
      velMax: 0,
      posEnabled: true,
      posMin: -4,
      posMax: 4,
      tempMax: 0,
      fbTimeout: 0,
    });
    for (const x of [2.0, 3.0, -3.0, -2.5]) {
      s.onFeedback(0, x, 0, 0);
    }
    expect(s.tripped).toBe(false);
    expect(Math.abs(s.pos - (2 * Math.PI - 2.5))).toBeLessThan(1e-9);
    s.onFeedback(0, -2.0, 0, 0);
    expect(s.tripped).toBe(true);
    expect(s.reason).toContain('位置');
  });

  it('triggers feedback timeout only when non-zero output is requested', () => {
    const s = new Supervisor({ velMax: 0, tempMax: 0, fbTimeout: 0.1 });
    s.onFeedback(0.0, 0, 0, 0);
    expect(s.filterOutput(1.0, 0.0)).toBe(0.0);
    expect(s.tripped).toBe(false);
    expect(s.filterOutput(1.0, 0.5)).toBe(0.0);
    expect(s.tripped).toBe(true);
    expect(s.reason).toContain('超时');
  });
});
