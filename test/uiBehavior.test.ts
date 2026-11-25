import { describe, expect, it } from 'vitest';
import { tr } from '../src/shared/i18n';
import { formatAxisTick } from '../src/webview/charts/chartInteractions';
import { computeYRange } from '../src/webview/charts/RealtimePlot';
import { resolveSingleNotice } from '../src/webview/shared/clientStore';
import { nonNegativeTimeRange } from '../src/webview/charts/chartInteractions';
import { formatFrequencyTick, plotValues } from '../src/webview/charts/plotValues';

describe('UI Notice Single-Slot & I18N Behavior', () => {
  it('skips uPlot logarithmic minor-tick placeholders without aborting Bode rendering', () => {
    expect([0.1, null, 1, undefined, 10, 100].map(formatFrequencyTick)).toEqual(['0.1', '', '1', '', '10', '100']);
    expect([Number.NaN, Infinity, 0, -1].map(formatFrequencyTick)).toEqual(['', '', '', '']);
  });

  it('keeps unavailable feedback as uPlot gaps so it cannot poison the reference auto-range', () => {
    expect(plotValues([Number.NaN, undefined, null, Infinity, -Infinity, 0, 5, -8])).toEqual([null, null, null, null, null, 0, 5, -8]);
    expect(plotValues(new Float64Array([2, Number.NaN]))).toEqual([2, null]);
  });

  it('uses 波形图 without emoji and labels E-Stop as zero-torque stop', () => {
    expect(tr('zh', 'sb.openScope')).toBe('波形图');
    expect(tr('en', 'sb.openScope')).toBe('Waveform');
    expect(tr('zh', 'sb.estop')).toBe('急停（零扭矩）');
    expect(tr('zh', 'sb.estop')).not.toContain('0.5');
    expect(tr('zh', 'sb.estop')).not.toContain('锁存');
  });

  it('keeps only one notice, preserves higher priority in same burst, and overwrites on new messages', () => {
    // 1. Initial error notice
    let list = resolveSingleNotice(undefined, 'error', 'safety', '急停：零扭矩锁存', 1000);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('急停：零扭矩锁存');

    // 2. Trailing info/warning within <600ms burst does NOT bury the error
    list = resolveSingleNotice(list[0], 'info', 'run', '运行已停止', 1015);
    expect(list).toHaveLength(1);
    expect(list[0].level).toBe('error');
    expect(list[0].text).toBe('急停：零扭矩锁存');

    // 3. Higher priority arriving right after lower priority in a burst DOES overwrite
    let lowFirst = resolveSingleNotice(undefined, 'info', 'control', '已发送指令', 2000);
    lowFirst = resolveSingleNotice(lowFirst[0], 'error', 'bus', '总线掉线', 2020);
    expect(lowFirst).toHaveLength(1);
    expect(lowFirst[0].level).toBe('error');
    expect(lowFirst[0].text).toBe('总线掉线');

    // 4. Same-subsystem recovery overwrites immediately even within <600ms
    list = resolveSingleNotice(list[0], 'success', 'safety', '已解除急停/超限锁存', 1200);
    expect(list).toHaveLength(1);
    expect(list[0].level).toBe('success');
    expect(list[0].text).toBe('已解除急停/超限锁存');

    // 5. Subsequent new message after burst window overwrites old message directly (never accumulates)
    list = resolveSingleNotice(list[0], 'info', 'control', '已发送清错指令', 2500);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('已发送清错指令');
  });

  it('formats Y-axis tick values cleanly across magnitudes', () => {
    expect(formatAxisTick(0)).toBe('0');
    expect(formatAxisTick(12.34567)).toBe('12.346');
    expect(formatAxisTick(-0.125)).toBe('-0.125');
    expect(formatAxisTick(25000)).toBe('2.5e+4');
  });

  it('clamps every linear chart viewport to non-negative time', () => {
    expect(nonNegativeTimeRange(-2, 3)).toEqual([0, 5]);
    expect(nonNegativeTimeRange(-3, -1)).toEqual([0, 2]);
    expect(nonNegativeTimeRange(1, 4)).toEqual([1, 4]);
  });

  it('pins Y-axis auto-range to steady minimum span near zero without jitter bouncing', () => {
    const t = new Float64Array([0, 0.1, 0.2, 0.3]);
    // Tiny velocity noise jittering near zero: stays rock-solid at [-1, 1]
    const noisyVelA = new Float64Array([-0.01, 0.02, -0.03, 0.015]);
    const noisyVelB = new Float64Array([-0.15, 0.22, -0.08, 0.31]);
    expect(
      computeYRange(t, [noisyVelA], 0, 1, { minSpan: 2.0, zeroSymmetric: true, includeZero: true }),
    ).toEqual([-1, 1]);
    expect(
      computeYRange(t, [noisyVelB], 0, 1, { minSpan: 2.0, zeroSymmetric: true, includeZero: true }),
    ).toEqual([-1, 1]);

    // Large velocity signal expands smoothly beyond minSpan
    const fastVel = new Float64Array([-10, 0, 12, 8]);
    const [lo, hi] = computeYRange(t, [fastVel], 0, 1, {
      minSpan: 2.0,
      zeroSymmetric: true,
      includeZero: true,
    });
    expect(lo).toBeLessThan(-10);
    expect(hi).toBeGreaterThan(12);
  });
});
