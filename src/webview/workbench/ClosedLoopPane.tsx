import React, { useEffect, useMemo, useState } from 'react';
import { LoopConfig, LoopKind, RefKind } from '../../shared/protocol';
import { consumePendingSuggestion, useClientStore } from '../shared/clientStore';
import { PillSwitch } from '../shared/NoticeBanner';
import { postEngine } from '../shared/vscodeApi';

export const ClosedLoopInspector: React.FC<{ onPreviewChange: (cfg: LoopConfig) => void }> = ({ onPreviewChange }) => {
  const { state, lastAnalysis, pendingLoopSuggestion } = useClientStore();

  const [loop, setLoop] = useState<LoopKind>('vel');
  // Velocity / Inner loop gains
  const [kp, setKp] = useState(0.5);
  const [ki, setKi] = useState(2.0);
  const [kd, setKd] = useState(0.0);
  const [ff, setFf] = useState(0.0);
  const [iMax, setIMax] = useState(10.0);
  const [outMax, setOutMax] = useState(5.0);
  const [errFc, setErrFc] = useState(0.0);
  const [dFc, setDFc] = useState(0.0);

  // Cascade Outer Position loop gains
  const [posKp, setPosKp] = useState(4.0);
  const [posKi, setPosKi] = useState(0.0);
  const [posKd, setPosKd] = useState(0.0);
  const [posOutMax, setPosOutMax] = useState(30.0);

  // Reference signal
  const [refKind, setRefKind] = useState<RefKind>('step');
  const [amp, setAmp] = useState(2.0);
  const [freq, setFreq] = useState(1.0);
  const [rampTime, setRampTime] = useState(1.0);
  const [duration, setDuration] = useState(2.0);
  const [relative, setRelative] = useState(true);
  const [multiStepCount, setMultiStepCount] = useState(1);
  const [steps, setSteps] = useState<Array<{ val: number; dur: number }>>([
    { val: 2.0, dur: 1.5 },
    { val: 0.0, dur: 1.0 },
  ]);

  // Apply auto-tuned suggestion when routed from SysID tab
  useEffect(() => {
    if (!pendingLoopSuggestion) return;
    const s = pendingLoopSuggestion;
    const r = s.startRatio;
    setKp(Number((s.velKp * r).toPrecision(5)));
    setKi(Number((s.velKi * r).toPrecision(5)));
    setKd(0);
    setPosKp(Number((s.posKp * r).toPrecision(5)));
    setPosKi(Number((s.posKi * r).toPrecision(5)));
    setPosKd(Number((s.posKd * r).toPrecision(5)));
    consumePendingSuggestion();
  }, [pendingLoopSuggestion]);

  const running = Boolean(state?.running && state?.runKind === 'loop');
  const drv = state?.driver ?? null;

  const cfg = useMemo<LoopConfig>(() => {
    const activeSteps = steps.slice(0, multiStepCount);
    return {
      loop,
      kp,
      ki,
      kd,
      refKind,
      amp,
      freq,
      rampTime,
      delay: 0.0,
      duration,
      outMax,
      integralMax: iMax,
      ff,
      errFc,
      dFc,
      posKp: loop === 'pos' ? posKp : null,
      posKi: loop === 'pos' ? posKi : null,
      posKd: loop === 'pos' ? posKd : null,
      posFf: 0.0,
      posIntegralMax: 5.0,
      posOutMax,
      posErrFc: 0.0,
      posDFc: 0.0,
      relative,
      dOnMeas: true,
      stepValues: refKind === 'step' && multiStepCount > 1 ? activeSteps.map((s) => s.val) : [],
      stepDurations: refKind === 'step' && multiStepCount > 1 ? activeSteps.map((s) => s.dur) : [],
    };
  }, [loop, kp, ki, kd, refKind, amp, freq, rampTime, duration, outMax, iMax, ff, errFc, dFc,
    posKp, posKi, posKd, posOutMax, relative, steps, multiStepCount]);

  useEffect(() => onPreviewChange(cfg), [cfg, onPreviewChange]);

  const handleStart = (): void => {
    if (running) {
      postEngine({ type: 'stopRun' });
      return;
    }
    if (state?.safetyLimits && drv) {
      const reqVel = loop === 'vel' ? Math.abs(amp) * 1.6 : posOutMax * 1.3;
      postEngine({
        type: 'setSafetyLimits',
        limits: {
          ...state.safetyLimits,
          velMax: Math.max(state.safetyLimits.velMax, reqVel),
          outMax: Math.min(drv.outMax, Math.max(state.safetyLimits.outMax, outMax)),
        },
      });
    }

    postEngine({ type: 'startLoopRun', cfg });
  };

  const loopRes = lastAnalysis?.runKind === 'loop' &&
    JSON.stringify(lastAnalysis.loopCfg) === JSON.stringify(cfg) ? lastAnalysis : null;
  const st = loopRes?.stepStats ?? null;
  const refUnit = loop === 'vel' ? 'rad/s' : 'rad';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="sub-heading" style={{ marginTop: 0 }}>
        <span>上位机闭环结构 (对齐 RMPP::Pid)</span>
      </div>

      <select
        className="ep-select"
        value={loop}
        onChange={(e) => setLoop(e.target.value as LoopKind)}
      >
        <option value="vel">单环速度闭环 (PI)</option>
        <option value="pos">串级位置闭环 (外位置 PID → 内速度 PID)</option>
        <option value="pos_single">单环位置闭环 (直接输出扭矩/电流)</option>
      </select>

      {loop === 'pos' && (
        <div
          style={{
            padding: 7,
            border: '1px solid var(--vscode-widget-border)',
            borderRadius: 4,
            display: 'grid',
            gridTemplateColumns: '92px 1fr',
            gap: 5,
            alignItems: 'center',
          }}
        >
          <strong style={{ gridColumn: '1 / -1', fontSize: 11 }}>外环：位置环 → 速度参考</strong>
          <span>外环 Kp</span>
          <input
            type="number"
            className="ep-input mono-num"
            step={0.2}
            value={posKp}
            onChange={(e) => setPosKp(Number(e.target.value) || 0)}
          />
          <span>外环 Ki / Kd</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              type="number"
              className="ep-input mono-num"
              style={{ width: '50%' }}
              step={0.1}
              value={posKi}
              onChange={(e) => setPosKi(Number(e.target.value) || 0)}
            />
            <input
              type="number"
              className="ep-input mono-num"
              style={{ width: '50%' }}
              step={0.05}
              value={posKd}
              onChange={(e) => setPosKd(Number(e.target.value) || 0)}
            />
          </div>
          <span>限速 (±rad/s)</span>
          <input
            type="number"
            className="ep-input mono-num"
            value={posOutMax}
            onChange={(e) => setPosOutMax(Math.max(0.1, Number(e.target.value) || 10))}
          />
        </div>
      )}

      <div
        style={{
          padding: 7,
          border: '1px solid var(--vscode-widget-border)',
          borderRadius: 4,
          display: 'grid',
          gridTemplateColumns: '92px 1fr',
          gap: 5,
          alignItems: 'center',
        }}
      >
        <strong style={{ gridColumn: '1 / -1', fontSize: 11 }}>
          {loop === 'pos' ? '内环：速度环 → 扭矩/电流' : '主控制器参数'}
        </strong>
        <span>Kp</span>
        <input
          type="number"
          className="ep-input mono-num"
          step={0.05}
          value={kp}
          onChange={(e) => setKp(Number(e.target.value) || 0)}
        />
        <span>Ki</span>
        <input
          type="number"
          className="ep-input mono-num"
          step={0.1}
          value={ki}
          onChange={(e) => setKi(Number(e.target.value) || 0)}
        />
        {(loop === 'pos' || loop === 'pos_single') && (
          <>
            <span>Kd</span>
            <input
              type="number"
              className="ep-input mono-num"
              step={0.01}
              value={kd}
              onChange={(e) => setKd(Number(e.target.value) || 0)}
            />
          </>
        )}
        <span>积分/输出限幅</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            type="number"
            className="ep-input mono-num"
            style={{ width: '50%' }}
            title="积分限幅 max_i"
            value={iMax}
            onChange={(e) => setIMax(Math.max(0, Number(e.target.value) || 0))}
          />
          <input
            type="number"
            className="ep-input mono-num"
            style={{ width: '50%' }}
            title="输出限幅 max_out"
            value={outMax}
            onChange={(e) => setOutMax(Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
        <span>前馈 / 滤波(Hz)</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            type="number"
            className="ep-input mono-num"
            style={{ width: '34%' }}
            title="前馈 ff"
            value={ff}
            onChange={(e) => setFf(Number(e.target.value) || 0)}
          />
          <input
            type="number"
            className="ep-input mono-num"
            style={{ width: '33%' }}
            title="误差低通 Hz"
            value={errFc}
            onChange={(e) => setErrFc(Math.max(0, Number(e.target.value) || 0))}
          />
          <input
            type="number"
            className="ep-input mono-num"
            style={{ width: '33%' }}
            title="微分低通 Hz"
            value={dFc}
            onChange={(e) => setDFc(Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
      </div>

      {/* Reference Signal */}
      <div className="sub-heading">
        <span>参考轨迹生成</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 5, alignItems: 'center' }}>
        <span>波形类型</span>
        <select
          className="ep-select"
          value={refKind}
          onChange={(e) => setRefKind(e.target.value as RefKind)}
        >
          <option value="step">阶跃序列 (1~16 段)</option>
          <option value="ramp">斜坡爬升</option>
          <option value="sine">正弦跟踪</option>
        </select>

        {refKind === 'step' ? (
          <>
            <span>阶跃段数</span>
            <input
              type="number"
              className="ep-input mono-num"
              min={1}
              max={16}
              value={multiStepCount}
              onChange={(e) => {
                const cnt = Math.max(1, Math.min(16, Number(e.target.value) || 1));
                setMultiStepCount(cnt);
                setSteps((prev) => {
                  const copy = [...prev];
                  while (copy.length < cnt) copy.push({ val: 0, dur: 1.0 });
                  return copy;
                });
              }}
            />
          </>
        ) : null}

        {refKind !== 'step' || multiStepCount === 1 ? (
          <>
            <span>目标幅值({refUnit})</span>
            <input
              type="number"
              className="ep-input mono-num"
              step={0.5}
              value={amp}
              onChange={(e) => setAmp(Number(e.target.value) || 0)}
            />
            {refKind === 'sine' && (
              <>
                <span>正弦频率 (Hz)</span>
                <input
                  type="number"
                  className="ep-input mono-num"
                  step={0.2}
                  value={freq}
                  onChange={(e) => setFreq(Math.max(0.02, Number(e.target.value) || 1))}
                />
              </>
            )}
            {refKind === 'ramp' && (
              <>
                <span>爬坡时间 (s)</span>
                <input
                  type="number"
                  className="ep-input mono-num"
                  step={0.2}
                  value={rampTime}
                  onChange={(e) => setRampTime(Math.max(0.05, Number(e.target.value) || 1))}
                />
              </>
            )}
            <span>持续时长 (s)</span>
            <input
              type="number"
              className="ep-input mono-num"
              step={0.5}
              value={duration}
              onChange={(e) => setDuration(Math.max(0.2, Number(e.target.value) || 2))}
            />
          </>
        ) : (
          <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {steps.slice(0, multiStepCount).map((s, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <span className="mono-num" style={{ fontSize: 10.5, width: 28 }}>
                  #{idx + 1}
                </span>
                <input
                  type="number"
                  className="ep-input mono-num"
                  style={{ flex: 1 }}
                  value={s.val}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 0;
                    setSteps((p) => p.map((it, k) => (k === idx ? { ...it, val: v } : it)));
                  }}
                />
                <span style={{ fontSize: 10 }}>{refUnit}</span>
                <input
                  type="number"
                  className="ep-input mono-num"
                  style={{ width: 58 }}
                  step={0.2}
                  value={s.dur}
                  onChange={(e) => {
                    const d = Math.max(0.1, Number(e.target.value) || 1);
                    setSteps((p) => p.map((it, k) => (k === idx ? { ...it, dur: d } : it)));
                  }}
                />
                <span style={{ fontSize: 10 }}>s</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {loop !== 'vel' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
          <PillSwitch checked={relative} onChange={setRelative} />
          <span>位置参考相对当前起始位置</span>
        </label>
      )}

      <button
        type="button"
        className={`ep-btn ${running ? 'danger' : ''}`}
        disabled={!state?.active && !running}
        onClick={handleStart}
      >
        {running ? '停止闭环运行' : '开始上位机闭环测试'}
      </button>

      {/* Step Response Metrics */}
      {st && (
        <div className="chip-stats">
          <div className="chip-stat">
            <span className="chip-k">上升时间 (10-90%)</span>
            <span className="chip-v mono-num">
              {st.rise !== null ? `${(st.rise * 1000).toFixed(1)} ms` : '—'}
            </span>
          </div>
          <div className="chip-stat">
            <span className="chip-k">超调量</span>
            <span className="chip-v mono-num">{st.overshoot.toFixed(1)}%</span>
          </div>
          <div className="chip-stat">
            <span className="chip-k">调节时间 (±2%)</span>
            <span className="chip-v mono-num">
              {st.settle !== null ? `${(st.settle * 1000).toFixed(1)} ms` : '—'}
            </span>
          </div>
          <div className="chip-stat">
            <span className="chip-k">稳态误差 / RMS</span>
            <span className="chip-v mono-num">
              {st.ssErr >= 0 ? '+' : ''}
              {st.ssErr.toFixed(4)} / {st.rmsErr.toFixed(4)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
