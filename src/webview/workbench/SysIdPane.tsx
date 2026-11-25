import React, { useMemo, useState } from 'react';
import { ExciteConfig, ExciteKind, PidSuggestion } from '../../shared/protocol';
import { setWorkbenchMode, useClientStore } from '../shared/clientStore';
import { postEngine, postToHost } from '../shared/vscodeApi';

function optionalBandwidth(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function displayGain(value: number): string {
  return Number(value.toPrecision(5)).toString();
}

function mean(values: number[] | undefined): number | null {
  const finite = values?.filter(Number.isFinite) ?? [];
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

export const SysIdInspector: React.FC = () => {
  const { state, lastAnalysis } = useClientStore();
  const [kind, setKind] = useState<ExciteKind>('stepsine');
  const [amp, setAmp] = useState(1.5);
  const [stepOn, setStepOn] = useState(0.3);
  const [f0, setF0] = useState(1.0);
  const [f1, setF1] = useState(30.0);
  const [nFreq, setNFreq] = useState(20);
  const [cycles, setCycles] = useState(5);
  const [duration, setDuration] = useState(5.0);

  const [pmDeg, setPmDeg] = useState(55);
  const [velBwHz, setVelBwHz] = useState<string>('');
  const [singlePosBwHz, setSinglePosBwHz] = useState<string>('');
  const [startRatioPct, setStartRatioPct] = useState(50);

  const drv = state?.driver ?? null;
  const running = Boolean(state?.running && state?.runKind === 'excite');

  const estSeconds = useMemo(() => {
    if (kind === 'step') return 0.3 + stepOn + 0.5;
    if (kind !== 'stepsine') return duration;
    let total = 0;
    for (let i = 0; i < nFreq; i++) {
      const f = nFreq <= 1 ? f0 : f0 * Math.pow(f1 / f0, i / (nFreq - 1));
      const d = Math.max(cycles / f, 0.3);
      total += Math.ceil(d * f) / f;
    }
    return total;
  }, [kind, stepOn, f0, f1, nFreq, cycles, duration]);

  const handleStart = (): void => {
    if (running) {
      postEngine({ type: 'stopRun' });
      return;
    }
    // Auto-raise output safety limit if needed (within motor protocol limit)
    if (state?.safetyLimits && drv && amp > state.safetyLimits.outMax) {
      postEngine({
        type: 'setSafetyLimits',
        limits: {
          ...state.safetyLimits,
          outMax: Math.min(drv.outMax, Math.max(state.safetyLimits.outMax, amp * 1.2)),
        },
      });
    }
    const cfg: ExciteConfig = {
      kind,
      amp,
      stepOn,
      stepDelay: 0.05,
      stepTail: 0.5,
      f0,
      f1,
      nFreq,
      cycles,
      minSeg: 0.3,
      duration,
      prbsDt: 0.01,
      seed: 1,
    };
    postEngine({
      type: 'startExciteRun',
      cfg,
      pmDeg,
      velBwHz: optionalBandwidth(velBwHz),
      singlePosBwHz: optionalBandwidth(singlePosBwHz),
      startRatio: startRatioPct / 100,
    });
  };

  const triggerRecompute = (
    nextPm = pmDeg,
    nextVelBw = velBwHz,
    nextPosBw = singlePosBwHz,
    nextRatio = startRatioPct,
  ): void => {
    postEngine({
      type: 'recomputeSuggestion',
      pmDeg: nextPm,
      velBwHz: optionalBandwidth(nextVelBw),
      singlePosBwHz: optionalBandwidth(nextPosBw),
      startRatio: nextRatio / 100,
    });
  };

  const exportTestCsv = (): void => {
    const rec = lastAnalysis?.record;
    if (!rec || rec.t.length === 0) return;
    const lines = ['\ufefft,u,ref,pos_mt,vel,fb_out'];
    for (let i = 0; i < rec.t.length; i++) {
      lines.push(
        [rec.t[i], rec.u[i], rec.ref[i], rec.pos[i], rec.vel[i], rec.fbOut[i]]
          .map((v) => (Number.isFinite(v) ? Number(v.toPrecision(7)) : ''))
          .join(','),
      );
    }
    postToHost({
      type: 'saveFile',
      defaultName: 'sysid_response.csv',
      filterName: 'CSV 测试数据',
      extensions: ['csv'],
      content: lines.join('\n'),
    });
  };

  const exciteAnalysis = lastAnalysis?.runKind === 'excite' ? lastAnalysis : null;
  const model = exciteAnalysis?.model ?? null;
  const sugg: PidSuggestion | null = exciteAnalysis?.suggestion ?? null;
  const bode = exciteAnalysis?.bode ?? null;
  const velCoherence = mean(bode?.coh);
  const posCoherence = mean(bode?.cohP);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="sub-heading" style={{ marginTop: 0 }}>
        <span>开环电流/扭矩激励</span>
        <span className="ep-tag mono-num">预计 {estSeconds.toFixed(1)}s</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 6, alignItems: 'center' }}>
        <span>激励类型</span>
        <select
          className="ep-select"
          value={kind}
          onChange={(e) => setKind(e.target.value as ExciteKind)}
        >
          <option value="stepsine">步进正弦 (高精度点频)</option>
          <option value="chirp">对数扫频 (快速宽带)</option>
          <option value="prbs">PRBS 伪随机二进制</option>
          <option value="step">开环阶跃 (辨识摩擦 Fc)</option>
        </select>

        <span>幅值 ({drv?.outUnit ?? 'Nm'})</span>
        <input
          type="number"
          className="ep-input mono-num"
          step={0.1}
          min={0.05}
          value={amp}
          onChange={(e) => setAmp(Math.max(0, Number(e.target.value) || 0))}
        />

        {kind === 'step' ? (
          <>
            <span>阶跃时长 (s)</span>
            <input
              type="number"
              className="ep-input mono-num"
              step={0.05}
              value={stepOn}
              onChange={(e) => setStepOn(Math.max(0.02, Number(e.target.value) || 0.3))}
            />
          </>
        ) : (
          <>
            <span>频率范围 (Hz)</span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="number"
                className="ep-input mono-num"
                style={{ width: '50%' }}
                value={f0}
                onChange={(e) => setF0(Math.max(0.05, Number(e.target.value) || 1))}
              />
              <span>~</span>
              <input
                type="number"
                className="ep-input mono-num"
                style={{ width: '50%' }}
                value={f1}
                onChange={(e) => setF1(Math.max(f0 + 0.5, Number(e.target.value) || 30))}
              />
            </div>

            {kind === 'stepsine' ? (
              <>
                <span>频点数 / 周期</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    type="number"
                    className="ep-input mono-num"
                    style={{ width: '50%' }}
                    min={3}
                    max={40}
                    value={nFreq}
                    onChange={(e) => setNFreq(Math.max(3, Number(e.target.value) || 15))}
                  />
                  <input
                    type="number"
                    className="ep-input mono-num"
                    style={{ width: '50%' }}
                    min={2}
                    max={30}
                    value={cycles}
                    onChange={(e) => setCycles(Math.max(2, Number(e.target.value) || 5))}
                  />
                </div>
              </>
            ) : (
              <>
                <span>总时长 (s)</span>
                <input
                  type="number"
                  className="ep-input mono-num"
                  step={0.5}
                  value={duration}
                  onChange={(e) => setDuration(Math.max(1, Number(e.target.value) || 5))}
                />
              </>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className={`ep-btn ${running ? 'danger' : ''}`}
          style={{ flex: 1 }}
          disabled={!state?.active && !running}
          onClick={handleStart}
          title={!state?.active ? '请先使能电机' : ''}
        >
          {running ? '停止辨识' : '开始频响测试'}
        </button>
        <button
          type="button"
          className="ep-btn secondary"
          disabled={!exciteAnalysis?.record.t.length}
          onClick={exportTestCsv}
        >
          导出数据
        </button>
      </div>

      {/* Fitted Model Summary */}
      <div className="sub-heading">
        <span>辨识物理模型</span>
      </div>
      <div className="chip-stats">
        <div className="chip-stat">
          <span className="chip-k">等效惯量 J</span>
          <span className="chip-v mono-num">{model ? Number(model.J.toPrecision(4)) : '—'}</span>
        </div>
        <div className="chip-stat">
          <span className="chip-k">粘滞阻尼 b</span>
          <span className="chip-v mono-num">{model ? Number(model.b.toPrecision(4)) : '—'}</span>
        </div>
        <div className="chip-stat">
          <span className="chip-k">库仑摩擦 Fc</span>
          <span className="chip-v mono-num">{model ? Number(model.Fc.toPrecision(4)) : '—'}</span>
        </div>
        <div className="chip-stat">
          <span className="chip-k">纯延迟 Td</span>
          <span className="chip-v mono-num">{model ? `${(model.Td * 1000).toFixed(2)} ms` : '—'}</span>
        </div>
      </div>

      {/* Controller Bandwidth / Phase Margin Synthesis */}
      <div className="sub-heading">
        <span>控制器相位裕度整定</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '98px 1fr', gap: 5, alignItems: 'center' }}>
        <span>目标相位裕度 (°)</span>
        <input
          type="number"
          className="ep-input mono-num"
          min={30}
          max={80}
          value={pmDeg}
          onChange={(e) => {
            const v = Math.max(25, Math.min(85, Number(e.target.value) || 55));
            setPmDeg(v);
            triggerRecompute(v, velBwHz, singlePosBwHz, startRatioPct);
          }}
        />
        <span>期望速度带宽(Hz)</span>
        <input
          type="number"
          className="ep-input mono-num"
          min={0.01}
          step="any"
          placeholder="留空按延迟自动上限"
          value={velBwHz}
          onChange={(e) => {
            setVelBwHz(e.target.value);
            triggerRecompute(pmDeg, e.target.value, singlePosBwHz, startRatioPct);
          }}
        />
        <span>单环位置带宽(Hz)</span>
        <input
          type="number"
          className="ep-input mono-num"
          min={0.01}
          step="any"
          placeholder="默认跟随外环带宽"
          value={singlePosBwHz}
          onChange={(e) => {
            setSinglePosBwHz(e.target.value);
            triggerRecompute(pmDeg, velBwHz, e.target.value, startRatioPct);
          }}
        />
        <span>安全起步比例(%)</span>
        <input
          type="number"
          className="ep-input mono-num"
          min={10}
          max={100}
          step={5}
          value={startRatioPct}
          onChange={(e) => {
            const r = Math.max(10, Math.min(100, Number(e.target.value) || 50));
            setStartRatioPct(r);
            triggerRecompute(pmDeg, velBwHz, singlePosBwHz, r);
          }}
        />
      </div>

      {!sugg && (
        <div className="ep-notice">
          完成一次辨识后可设置速度环与单环位置的期望带宽；每次修改都会重新计算增益、级联外环带宽和相位裕度。
        </div>
      )}

      {sugg && (
        <div className="sysid-results">
          <div className="sub-heading" style={{ marginTop: 0 }}>
            <span>辨识参数</span>
            <span className="ep-tag">结果实时更新</span>
          </div>
          {model && (
            <>
              <div className="chip-stats">
                <div className="chip-stat"><span className="chip-k">等效惯量 J</span><span className="chip-v mono-num">{displayGain(model.J)}</span></div>
                <div className="chip-stat"><span className="chip-k">粘滞阻尼 b</span><span className="chip-v mono-num">{displayGain(model.b)}</span></div>
                <div className="chip-stat"><span className="chip-k">库仑摩擦 Fc</span><span className="chip-v mono-num">{displayGain(model.Fc)} {model.unit}</span></div>
                <div className="chip-stat"><span className="chip-k">等效延迟 Td</span><span className="chip-v mono-num">{(model.Td * 1000).toFixed(2)} ms</span></div>
              </div>
              <div className="sysid-transfer-grid">
                <div><strong>速度传递函数</strong><span className="mono-num">Gv(s) = e<sup>−Td·s</sup> / (J·s + b)</span><small>(rad/s)/{model.unit}</small></div>
                <div><strong>位置传递函数</strong><span className="mono-num">Gp(s) = e<sup>−Td·s</sup> / [s·(J·s + b)]</span><small>rad/{model.unit}</small></div>
              </div>
            </>
          )}

          <div className="sub-heading"><span>推荐速度环 PI</span></div>
          <div className="chip-stats">
            <div className="chip-stat"><span className="chip-k">实际闭环带宽</span><span className="chip-v mono-num">{sugg.velBw.toFixed(2)} Hz</span></div>
            <div className="chip-stat"><span className="chip-k">相位裕度</span><span className="chip-v mono-num">{sugg.velPhaseMargin.toFixed(2)}°</span></div>
            <div className="chip-stat"><span className="chip-k">Kp</span><span className="chip-v mono-num">{displayGain(sugg.velKp * sugg.startRatio)} {sugg.unit}/(rad/s)</span></div>
            <div className="chip-stat"><span className="chip-k">Ki</span><span className="chip-v mono-num">{displayGain(sugg.velKi * sugg.startRatio)} {sugg.unit}/rad</span></div>
          </div>

          <div className="sub-heading"><span>推荐单环位置 PID</span></div>
          <div className="chip-stats">
            <div className="chip-stat"><span className="chip-k">实际带宽</span><span className="chip-v mono-num">{sugg.singlePosBw.toFixed(2)} Hz</span></div>
            <div className="chip-stat"><span className="chip-k">相位裕度</span><span className="chip-v mono-num">{sugg.singlePosPhaseMargin.toFixed(2)}°</span></div>
            <div className="chip-stat"><span className="chip-k">Kp</span><span className="chip-v mono-num">{displayGain(sugg.singlePosKp * sugg.startRatio)} {sugg.unit}/rad</span></div>
            <div className="chip-stat"><span className="chip-k">Ki / Kd</span><span className="chip-v mono-num">{displayGain(sugg.singlePosKi * sugg.startRatio)} {sugg.unit}/(rad·s) · {displayGain(sugg.singlePosKd * sugg.startRatio)} {sugg.unit}·s/rad</span></div>
          </div>

          <div className="sub-heading"><span>推荐串级位置外环 PID</span></div>
          <div className="chip-stats">
            <div className="chip-stat"><span className="chip-k">实际外环带宽</span><span className="chip-v mono-num">{sugg.posBw.toFixed(2)} Hz</span></div>
            <div className="chip-stat"><span className="chip-k">相位裕度</span><span className="chip-v mono-num">{sugg.posPhaseMargin.toFixed(2)}°</span></div>
            <div className="chip-stat"><span className="chip-k">Kp / Ki</span><span className="chip-v mono-num">{displayGain(sugg.posKp * sugg.startRatio)} · {displayGain(sugg.posKi * sugg.startRatio)}</span></div>
            <div className="chip-stat"><span className="chip-k">Kd</span><span className="chip-v mono-num">{displayGain(sugg.posKd * sugg.startRatio)}</span></div>
          </div>

          <div className={`ep-notice ${!bode || (velCoherence ?? 0) < 0.5 ? 'warning' : 'success'}`}>
            {kind === 'step'
              ? '阶跃辨识不生成波特频点。'
              : bode
                ? `频响点 ${bode.f.length} 个 · 电流/扭矩→速度相干度 ${(velCoherence ?? 0).toFixed(2)} · →位置相干度 ${(posCoherence ?? 0).toFixed(2)}`
                : '频响点不足，波特图暂不可用；请延长激励时间或降低起始频率。'}
          </div>
          <div className="ep-notice">{sugg.note}</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="ep-btn mini"
              style={{ flex: 1 }}
              onClick={() => setWorkbenchMode('loop', sugg)}
            >
              填入闭环测试 →
            </button>
            <button
              type="button"
              className="ep-btn secondary mini"
              onClick={() =>
                postToHost({ type: 'pidCodeAction', action: 'copy', suggestion: sugg, model })
              }
            >
              复制 C++ PID
            </button>
            <button
              type="button"
              className="ep-btn ghost mini"
              onClick={() =>
                postToHost({ type: 'pidCodeAction', action: 'insert', suggestion: sugg, model })
              }
              title="直接插入到当前活动的 C++/头文件光标位置"
            >
              插入代码
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
