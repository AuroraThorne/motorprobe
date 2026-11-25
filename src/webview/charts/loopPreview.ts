import { LoopConfig } from '../../shared/protocol';

export interface LoopReferencePreview {
  t: number[];
  ref: number[];
}

export function buildLoopReferencePreview(
  cfg: LoopConfig,
  positionOffset = 0,
  sampleHz = 80,
): LoopReferencePreview {
  const stepValues = cfg.stepValues.length > 0 ? cfg.stepValues : [cfg.amp];
  const stepDurations = cfg.stepDurations.length > 0 ? cfg.stepDurations : [cfg.duration];
  const total = Math.max(
    0.1,
    cfg.refKind === 'step' ? stepDurations.reduce((sum, duration) => sum + duration, 0) : cfg.duration,
  );
  const count = Math.max(2, Math.min(4000, Math.ceil(total * Math.max(10, sampleHz)) + 1));
  const t = Array.from({ length: count }, (_, i) => (i * total) / (count - 1));
  const positionOffsetApplies = (cfg.loop === 'pos' || cfg.loop === 'pos_single') && cfg.relative;

  const ref = t.map((time) => {
    let value: number;
    if (cfg.refKind === 'step') {
      let elapsed = 0;
      value = stepValues[stepValues.length - 1] ?? 0;
      for (let i = 0; i < stepValues.length; i += 1) {
        const duration = stepDurations[i] ?? cfg.duration;
        if (time < elapsed + duration) {
          value = stepValues[i];
          break;
        }
        elapsed += duration;
      }
    } else if (cfg.refKind === 'ramp') {
      const elapsed = Math.max(0, time - cfg.delay);
      value = cfg.amp * Math.min(1, elapsed / Math.max(cfg.rampTime, 1e-6));
    } else {
      const elapsed = Math.max(0, time - cfg.delay);
      value = cfg.amp * Math.sin(2 * Math.PI * cfg.freq * elapsed);
    }
    return value + (positionOffsetApplies ? positionOffset : 0);
  });

  return { t, ref };
}
