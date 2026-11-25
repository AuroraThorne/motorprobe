import React, { useEffect, useRef, useState } from 'react';
import { tr } from '../../shared/i18n';
import { LoopConfig, LoopKind, MitCommand, WorkbenchMode, ZERO_MIT } from '../../shared/protocol';
import { BodePlot } from '../charts/BodePlot';
import { ClosedLoopPlot } from '../charts/ClosedLoopPlot';
import { ExportCsvModal } from '../charts/ExportCsvModal';
import { CurveVisibility, RealtimePlot, ViewportBounds } from '../charts/RealtimePlot';
import { nonNegativeTimeRange } from '../charts/chartInteractions';
import {
  clearSampleHistory,
  setWorkbenchMode,
  sharedRing,
  useClientStore,
} from '../shared/clientStore';
import { loadSavedUiState, postEngine, postToHost, saveUiState } from '../shared/vscodeApi';
import { WriteCard } from '../shared/WriteCard';
import { ClosedLoopInspector } from './ClosedLoopPane';
import { RegisterView } from './RegisterView';
import { SysIdInspector } from './SysIdPane';

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export const WorkbenchApp: React.FC = () => {
  const { lang, state, workbenchMode, sampleVersion, lastAnalysis } = useClientStore();
  const saved = loadSavedUiState({
    floating: false,
    sideCollapsed: false,
    sideWidth: 325,
    windowSec: 10,
  });

  const [floating, setFloating] = useState<boolean>(Boolean(saved.floating));
  const [sideCollapsed, setSideCollapsed] = useState<boolean>(Boolean(saved.sideCollapsed));
  const [sideWidth, setSideWidth] = useState<number>(Number(saved.sideWidth) || 325);
  const [floatRect, setFloatRect] = useState({ x: 16, y: 12, w: 325, h: 480 });

  const [windowSec, setWindowSec] = useState<number>(Number(saved.windowSec ?? 10));
  const [frozen, setFrozen] = useState(false);
  const [posMode, setPosMode] = useState<'multi' | 'raw'>('multi');
  const [yAutoFit, setYAutoFit] = useState(true);
  const [customRange, setCustomRange] = useState<ViewportBounds | null>(null);
  const [undoStack, setUndoStack] = useState<Array<ViewportBounds | null>>([]);
  const [showExportModal, setShowExportModal] = useState(false);
  const [loopPreviewCfg, setLoopPreviewCfg] = useState<LoopConfig | null>(null);

  const [visibility, setVisibility] = useState<CurveVisibility>({
    pos: true,
    refPos: true,
    vel: true,
    refVel: true,
    outCmd: true,
    outFb: true,
    temp: true,
  });

  // Quick Write State inside Scope Inspector
  const [quickOut, setQuickOut] = useState(0);
  const [appliedOut, setAppliedOut] = useState(0);
  const [quickMit, setQuickMit] = useState<MitCommand>({ ...ZERO_MIT });
  const [appliedMit, setAppliedMit] = useState<MitCommand>({ ...ZERO_MIT });

  // Global Space / Escape E-Stop inside Workbench Webview (matches original _SpaceEstop)
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      const target = ev.target as HTMLElement | null;
      if (target && TEXT_TAGS.has(target.tagName)) return;
      if (ev.key === 'Escape' || ev.key === ' ') {
        ev.preventDefault();
        setAppliedOut(0);
        setAppliedMit({ ...ZERO_MIT });
        postEngine({ type: 'estop', reason: ev.key === ' ' ? '空格急停' : 'Esc 急停' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Splitter Dragging
  const draggingSplitter = useRef(false);
  const startSplitterDrag = (e: React.PointerEvent): void => {
    e.preventDefault();
    draggingSplitter.current = true;
    const startX = e.clientX;
    const startW = sideWidth;
    const onMove = (me: PointerEvent) => {
      if (!draggingSplitter.current) return;
      const next = Math.max(240, Math.min(540, startW + (me.clientX - startX)));
      setSideWidth(next);
      saveUiState({ sideWidth: next });
    };
    const onUp = () => {
      draggingSplitter.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Floating Card Drag & Resize (EmberProbe .panel-floating behavior)
  const startFloatMove = (e: React.PointerEvent): void => {
    if (!floating) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const orig = { ...floatRect };
    const onMove = (me: PointerEvent) => {
      setFloatRect((r) => ({
        ...r,
        x: Math.max(4, orig.x + (me.clientX - sx)),
        y: Math.max(4, orig.y + (me.clientY - sy)),
      }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startFloatResize = (e: React.PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const orig = { ...floatRect };
    const onMove = (me: PointerEvent) => {
      setFloatRect((r) => ({
        ...r,
        w: Math.max(260, orig.w + (me.clientX - sx)),
        h: Math.max(220, orig.h + (me.clientY - sy)),
      }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const pushZoomRange = (range: ViewportBounds): void => {
    const [min, max] = nonNegativeTimeRange(range.min, range.max);
    setUndoStack((prev) => [...prev.slice(-19), customRange]);
    setCustomRange({ min, max });
    setFrozen(true);
  };

  const [resetZoomToken, setResetZoomToken] = useState(0);
  const [equalizeToken, setEqualizeToken] = useState(0);
  const wheelGestureRef = useRef(0);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const handleWheelZoomRange = (range: ViewportBounds): void => {
    const [min, max] = nonNegativeTimeRange(range.min, range.max);
    const now = performance.now();
    if (now - wheelGestureRef.current > 450) {
      setUndoStack((prev) => [...prev.slice(-19), customRange]);
    }
    wheelGestureRef.current = now;
    setCustomRange({ min, max });
    setFrozen(true);
  };

  const handleResetZoom = (): void => {
    setCustomRange(null);
    setFrozen(false);
    setResetZoomToken((t) => t + 1);
  };

  const undoViewport = (): void => {
    if (undoStack.length === 0) {
      setCustomRange(null);
      setResetZoomToken((t) => t + 1);
      return;
    }
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setCustomRange(prev);
  };

  const drv = state?.driver ?? null;
  const smp = state?.latestSample ?? null;
  const active = Boolean(state?.active);
  const tripped = Boolean(state?.tripped);
  const bounds = sharedRing.timeBounds();
  const totalSpan = Math.max(0.001, bounds.max - bounds.min);

  const visMin = customRange
    ? customRange.min
    : windowSec > 0
      ? Math.max(bounds.min, bounds.max - windowSec)
      : bounds.min;
  const visMax = customRange ? customRange.max : Math.max(bounds.min + (windowSec || 1), bounds.max);
  const fillLeftPct = Math.max(0, Math.min(96, ((visMin - bounds.min) / totalSpan) * 100));
  const fillWidthPct = Math.max(4, Math.min(100 - fillLeftPct, ((visMax - visMin) / totalSpan) * 100));

  const startTimelineScrub = (e: React.PointerEvent): void => {
    if (e.button !== 0 || sharedRing.count < 2) return;
    const barEl = timelineRef.current;
    if (!barEl) return;
    e.preventDefault();
    e.stopPropagation();

    const barWidth = Math.max(20, barEl.getBoundingClientRect().width);
    const startX = e.clientX;
    const startMin = visMin;
    const startMax = visMax;
    const winSpan = Math.max(0.01, startMax - startMin);
    setUndoStack((prev) => [...prev.slice(-19), customRange]);

    const onMove = (me: PointerEvent) => {
      const dt = ((me.clientX - startX) / barWidth) * totalSpan;
      const clampedMin = Math.max(bounds.min, Math.min(bounds.max - winSpan, startMin + dt));
      setCustomRange({ min: clampedMin, max: clampedMin + winSpan });
      setFrozen(true);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const switchMode = (m: WorkbenchMode): void => {
    if (m === 'regs' && !state?.driver?.caps.registers) return;
    setWorkbenchMode(m);
  };

  useEffect(() => {
    if (workbenchMode === 'regs' && !state?.driver?.caps.registers) setWorkbenchMode('scope');
  }, [state?.driver?.protocol, workbenchMode]);

  const dotClass = tripped || state?.isFault
    ? 'err'
    : state?.running || state?.scanning
      ? 'busy'
      : state?.connected
        ? 'on'
        : '';

  const exciteData = lastAnalysis?.runKind === 'excite' ? lastAnalysis : null;

  return (
    <div className="wb-root">
      {/* Top Segmented Toolbar (EmberProbe Style) */}
      <div className="wb-top">
        <div className="wb-toolbar">
          <div className="wb-group">
            <span className={`status-dot ${dotClass}`} />
            {workbenchMode !== 'regs' && (
              <button
                type="button"
                className={`ep-btn ghost side-toggle-btn ${!sideCollapsed ? 'active' : ''}`}
                onClick={() => {
                  const next = !sideCollapsed;
                  setSideCollapsed(next);
                  saveUiState({ sideCollapsed: next });
                }}
                title="折叠/展开左侧检查器面板"
              >
                ◧
              </button>
            )}
            <div className="mode-tabs">
              {(['scope', 'sysid', 'loop', ...(state?.driver?.caps.registers ? ['regs' as const] : [])] as WorkbenchMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`mode-tab ${workbenchMode === m ? 'active' : ''}`}
                  onClick={() => switchMode(m)}
                >
                  {tr(lang, `wb.${m}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Motor Status + Instant E-Stop */}
          <div className="wb-group">
            <span style={{ fontWeight: 600, fontSize: 12 }}>
              {drv ? `${drv.model} #${drv.motorId}` : state?.connected ? '未选择电机' : '未连接'}
            </span>
            {!state?.connected && (
              <button
                type="button"
                className="ep-btn mini"
                onClick={() =>
                  postEngine({
                    type: 'connect',
                    params: {
                      kind: 'sim',
                      channel: 0,
                      channelName: '演示台（虚拟电机）',
                      baudKey: '1M',
                      baud: 0x0014,
                      bitrate: 1_000_000,
                    },
                  })
                }
              >
                一键进演示台
              </button>
            )}
            {drv && (
              <>
                <button
                  type="button"
                  className={`ep-btn mini ${active ? 'secondary' : ''}`}
                  onClick={() => postEngine({ type: active ? 'disable' : 'enable' })}
                >
                  {active ? (drv.caps.enableCmd ? '失能' : '停止') : drv.caps.enableCmd ? '使能' : '开始输出'}
                </button>
                <button
                  type="button"
                  className="ep-btn danger mini"
                  onClick={() => {
                    setAppliedOut(0);
                    setAppliedMit({ ...ZERO_MIT });
                    postEngine({ type: 'estop', reason: '工作台工具栏急停' });
                  }}
                  title="空格 / Esc 快捷键立即零扭矩急停"
                >
                  ⛔ 急停
                </button>
                {tripped && (
                  <button
                    type="button"
                    className="ep-btn secondary mini"
                    onClick={() => postEngine({ type: 'resetSafety' })}
                  >
                    解除锁存
                  </button>
                )}
              </>
            )}
          </div>

          {/* Frequency Picker Group */}
          <div className="wb-group">
            <label>{tr(lang, 'wb.targetFreq')}</label>
            <select
              className="ep-select mono-num"
              style={{ width: 82 }}
              value={state?.rateHz ?? 1000}
              onChange={(e) => postEngine({ type: 'setRateHz', rateHz: Number(e.target.value) })}
            >
              <option value={1000}>1000 Hz</option>
              <option value={500}>500 Hz</option>
              <option value={250}>250 Hz</option>
              <option value={100}>100 Hz</option>
              <option value={50}>50 Hz</option>
            </select>
          </div>

          {/* Scope History Tools */}
          {workbenchMode === 'scope' && (
            <div className="wb-group">
              <label>{tr(lang, 'wb.window')}</label>
              <select
                className="ep-select"
                value={customRange ? 'custom' : String(windowSec)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setCustomRange(null);
                  setWindowSec(v);
                  saveUiState({ windowSec: v });
                }}
              >
                <option value="2">2 秒</option>
                <option value="5">5 秒</option>
                <option value="10">10 秒</option>
                <option value="30">30 秒</option>
                <option value="60">60 秒</option>
                <option value="0">全部历史</option>
                {customRange && <option value="custom">框选区间</option>}
              </select>
              <button
                type="button"
                className={`ep-btn ghost mini ${frozen ? 'active' : ''}`}
                onClick={() => {
                  const next = !frozen;
                  setFrozen(next);
                  if (!next) setCustomRange(null);
                }}
              >
                {frozen ? tr(lang, 'wb.resume') : tr(lang, 'wb.freeze')}
              </button>
              <button
                type="button"
                className="ep-btn ghost mini"
                onClick={() => setPosMode(posMode === 'multi' ? 'raw' : 'multi')}
              >
                {posMode === 'multi' ? '多圈累计' : '单圈原值'}
              </button>
              <button type="button" className="ep-btn ghost mini" onClick={clearSampleHistory}>
                {tr(lang, 'wb.clear')}
              </button>
              <button
                type="button"
                className="ep-btn ghost mini"
                onClick={() => setShowExportModal(true)}
              >
                {tr(lang, 'wb.exportCsv')}
              </button>
              <button
                type="button"
                className="ep-btn ghost mini"
                disabled={undoStack.length === 0 && !customRange}
                onClick={undoViewport}
              >
                {tr(lang, 'wb.undoView')}
              </button>
            </div>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="ep-btn ghost mini"
              onClick={() => postToHost({ type: 'openBusMonitor' })}
              title="打开底部 CAN 报文监控终端"
            >
              CAN 报文终端
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      {workbenchMode === 'regs' ? (
        <RegisterView />
      ) : (
        <main
          className={`wb-layout ${floating ? 'panel-floating' : ''} ${sideCollapsed ? 'side-collapsed' : ''}`}
          style={!floating ? ({ '--side-width': `${sideWidth}px` } as React.CSSProperties) : undefined}
        >
          {/* Left Docked OR Floating Raised Inspector Card */}
          <aside
            className="wb-side"
            style={
              floating
                ? {
                    left: floatRect.x,
                    top: floatRect.y,
                    width: floatRect.w,
                    height: floatRect.h,
                  }
                : undefined
            }
          >
            <div className="wb-side-head" onPointerDown={startFloatMove}>
              <strong>
                {workbenchMode === 'scope'
                  ? tr(lang, 'wb.currentValues')
                  : workbenchMode === 'sysid'
                    ? '频响辨识配置'
                    : '闭环控制器'}
              </strong>
              <span className="wb-side-rate mono-num">
                {state?.sending ? `${state.txRate.toFixed(0)} Hz` : '待机'}
              </span>
              <div className="wb-side-actions">
                <button
                  type="button"
                  className="panel-icon-btn"
                  onClick={() => {
                    const next = !floating;
                    setFloating(next);
                    saveUiState({ floating: next });
                  }}
                  title={floating ? '停靠回左侧分栏' : '切换为图表上方悬浮窗 (EmberProbe 浮动模式)'}
                >
                  {floating ? '◧' : '❐'}
                </button>
                <button
                  type="button"
                  className="panel-icon-btn"
                  onClick={() => setSideCollapsed(true)}
                  title="隐藏检查器"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="wb-side-scroll">
              {workbenchMode === 'scope' && (
                <>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      className="ep-btn ghost mini"
                      style={{ flex: 1 }}
                      onClick={() =>
                        setVisibility({
                          pos: true,
                          refPos: true,
                          vel: true,
                          refVel: true,
                          outCmd: true,
                          outFb: true,
                          temp: true,
                        })
                      }
                    >
                      显示全部
                    </button>
                    <button
                      type="button"
                      className="ep-btn ghost mini"
                      style={{ flex: 1 }}
                      onClick={() =>
                        setVisibility({
                          pos: false,
                          refPos: false,
                          vel: false,
                          refVel: false,
                          outCmd: false,
                          outFb: false,
                          temp: false,
                        })
                      }
                    >
                      隐藏全部
                    </button>
                  </div>

                  {/* EmberProbe Swatch Curve Cards */}
                  <div className="value-grid">
                    <div className="value-row">
                      <button
                        type="button"
                        className={`swatch ${visibility.pos ? '' : 'off'}`}
                        style={{ background: '#29b6f6' }}
                        onClick={() => setVisibility((v) => ({ ...v, pos: !v.pos }))}
                        title="点击切换位置曲线显示"
                      />
                      <div className="value-label-wrap">
                        <span className="value-name">
                          {posMode === 'multi' ? '多圈累计位置' : '单圈原始位置'}
                        </span>
                        <span className="unit-pill">rad</span>
                      </div>
                      <span className="value-number mono-num">
                        {smp ? (posMode === 'multi' ? smp.posMt : smp.posRaw).toFixed(4) : '—'}
                      </span>
                    </div>

                    <div className="value-row">
                      <button
                        type="button"
                        className={`swatch ${visibility.vel ? '' : 'off'}`}
                        style={{ background: '#66bb6a' }}
                        onClick={() => setVisibility((v) => ({ ...v, vel: !v.vel }))}
                      />
                      <div className="value-label-wrap">
                        <span className="value-name">输出轴速度</span>
                        <span className="unit-pill">rad/s</span>
                      </div>
                      <span className="value-number mono-num">
                        {smp ? smp.vel.toFixed(3) : '—'}
                      </span>
                    </div>

                    <div className="value-row">
                      <button
                        type="button"
                        className={`swatch ${visibility.outCmd ? '' : 'off'}`}
                        style={{ background: '#ef5350' }}
                        onClick={() => setVisibility((v) => ({ ...v, outCmd: !v.outCmd }))}
                      />
                      <div className="value-label-wrap">
                        <span className="value-name">指令{drv?.outName ?? '输出'}</span>
                        <span className="unit-pill">{drv?.outUnit ?? 'Nm'}</span>
                      </div>
                      <span className="value-number mono-num">
                        {smp && Number.isFinite(smp.outCmd) ? smp.outCmd.toFixed(3) : '—'}
                      </span>
                    </div>

                    <div className="value-row">
                      <button
                        type="button"
                        className={`swatch ${visibility.outFb ? '' : 'off'}`}
                        style={{ background: '#42a5f5' }}
                        onClick={() => setVisibility((v) => ({ ...v, outFb: !v.outFb }))}
                      />
                      <div className="value-label-wrap">
                        <span className="value-name">反馈{drv?.outName ?? '输出'}</span>
                        <span className="unit-pill">{drv?.outUnit ?? 'Nm'}</span>
                      </div>
                      <span className="value-number mono-num">
                        {smp ? smp.outFb.toFixed(3) : '—'}
                      </span>
                    </div>

                    <div className="value-row">
                      <button
                        type="button"
                        className={`swatch ${visibility.temp ? '' : 'off'}`}
                        style={{ background: '#ffb74d' }}
                        onClick={() => setVisibility((v) => ({ ...v, temp: !v.temp }))}
                      />
                      <div className="value-label-wrap">
                        <span className="value-name">驱动/电机温度</span>
                        <span className="unit-pill">℃</span>
                      </div>
                      <span className="value-number mono-num">
                        {smp && Number.isFinite(smp.temp) ? smp.temp.toFixed(0) : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Quick Inline Control inside Workbench */}
                  <div className="sub-heading" style={{ marginTop: 6 }}>
                    <span>实时指令调节</span>
                    {drv?.caps.mit && (
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
                        <button
                          type="button"
                          className={`ep-btn ghost mini ${state?.mode !== 'mit' ? 'active' : ''}`}
                          onClick={() => postEngine({ type: 'setMode', mode: 'current' })}
                        >
                          扭矩
                        </button>
                        <button
                          type="button"
                          className={`ep-btn ghost mini ${state?.mode === 'mit' ? 'active' : ''}`}
                          onClick={() => postEngine({ type: 'setMode', mode: 'mit' })}
                        >
                          MIT
                        </button>
                      </div>
                    )}
                  </div>

                  {state?.mode === 'mit' && drv?.caps.mit ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <WriteCard
                        label="位置 p"
                        unit="rad"
                        min={state.limits.pMin}
                        max={state.limits.pMax}
                        step={0.05}
                        decimals={4}
                        value={quickMit.p}
                        appliedValue={appliedMit.p}
                        disabled={!drv}
                        onChange={(p) => setQuickMit((m) => ({ ...m, p }))}
                        onApply={() => {
                          setAppliedMit({ ...quickMit });
                          postEngine({ type: 'setTargetMit', cmd: quickMit });
                        }}
                        onZero={() => {
                          const next = { ...quickMit, p: 0 };
                          setQuickMit(next);
                          if (active) {
                            setAppliedMit(next);
                            postEngine({ type: 'setTargetMit', cmd: next });
                          }
                        }}
                      />
                      <WriteCard
                        label="速度 v"
                        unit="rad/s"
                        min={state.limits.vMin}
                        max={state.limits.vMax}
                        step={0.2}
                        decimals={3}
                        value={quickMit.v}
                        appliedValue={appliedMit.v}
                        disabled={!drv}
                        onChange={(v) => setQuickMit((m) => ({ ...m, v }))}
                        onApply={() => {
                          setAppliedMit({ ...quickMit });
                          postEngine({ type: 'setTargetMit', cmd: quickMit });
                        }}
                        onZero={() => {
                          const next = { ...quickMit, v: 0 };
                          setQuickMit(next);
                          if (active) {
                            setAppliedMit(next);
                            postEngine({ type: 'setTargetMit', cmd: next });
                          }
                        }}
                      />
                      <WriteCard
                        label="Kp"
                        min={0}
                        max={500}
                        step={1}
                        decimals={2}
                        value={quickMit.kp}
                        appliedValue={appliedMit.kp}
                        disabled={!drv}
                        onChange={(kp) => setQuickMit((m) => ({ ...m, kp }))}
                        onApply={() => {
                          setAppliedMit({ ...quickMit });
                          postEngine({ type: 'setTargetMit', cmd: quickMit });
                        }}
                        onZero={() => {
                          const next = { ...quickMit, kp: 0 };
                          setQuickMit(next);
                          if (active) {
                            setAppliedMit(next);
                            postEngine({ type: 'setTargetMit', cmd: next });
                          }
                        }}
                      />
                      <WriteCard
                        label="Kd"
                        min={0}
                        max={5}
                        step={0.05}
                        decimals={3}
                        value={quickMit.kd}
                        appliedValue={appliedMit.kd}
                        disabled={!drv}
                        onChange={(kd) => setQuickMit((m) => ({ ...m, kd }))}
                        onApply={() => {
                          setAppliedMit({ ...quickMit });
                          postEngine({ type: 'setTargetMit', cmd: quickMit });
                        }}
                        onZero={() => {
                          const next = { ...quickMit, kd: 0 };
                          setQuickMit(next);
                          if (active) {
                            setAppliedMit(next);
                            postEngine({ type: 'setTargetMit', cmd: next });
                          }
                        }}
                      />
                      <WriteCard
                        label="前馈 t"
                        unit="Nm"
                        min={-(state.safetyLimits.outEnabled ? Math.min(drv.outMax, state.safetyLimits.outMax) : drv.outMax)}
                        max={state.safetyLimits.outEnabled ? Math.min(drv.outMax, state.safetyLimits.outMax) : drv.outMax}
                        step={0.1}
                        decimals={3}
                        value={quickMit.t}
                        appliedValue={appliedMit.t}
                        disabled={!drv}
                        onChange={(t) => setQuickMit((m) => ({ ...m, t }))}
                        onApply={() => {
                          setAppliedMit({ ...quickMit });
                          postEngine({ type: 'setTargetMit', cmd: quickMit });
                        }}
                        onZero={() => {
                          const next = { ...quickMit, t: 0 };
                          setQuickMit(next);
                          if (active) {
                            setAppliedMit(next);
                            postEngine({ type: 'setTargetMit', cmd: next });
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="ep-btn"
                        disabled={!active}
                        onClick={() => {
                          setAppliedMit({ ...quickMit });
                          postEngine({ type: 'setTargetMit', cmd: quickMit });
                        }}
                      >
                        应用 MIT 参数
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <WriteCard
                        label={`目标${drv?.outName ?? '扭矩'}`}
                        unit={drv?.outUnit ?? 'Nm'}
                        min={-(drv ? Math.min(drv.outMax, state?.safetyLimits.outMax || drv.outMax) : 10)}
                        max={drv ? Math.min(drv.outMax, state?.safetyLimits.outMax || drv.outMax) : 10}
                        step={0.05}
                        decimals={3}
                        value={quickOut}
                        appliedValue={appliedOut}
                        disabled={!drv}
                        canZeroImmediate={active}
                        onChange={setQuickOut}
                        onApply={() => {
                          setAppliedOut(quickOut);
                          postEngine({ type: 'setTargetOut', value: quickOut });
                        }}
                        onZero={() => {
                          setQuickOut(0);
                          setAppliedOut(0);
                          postEngine({ type: 'zeroOutput' });
                        }}
                      />
                      <button
                        type="button"
                        className="ep-btn"
                        disabled={!active}
                        onClick={() => {
                          setAppliedOut(quickOut);
                          postEngine({ type: 'setTargetOut', value: quickOut });
                        }}
                      >
                        应用指令
                      </button>
                    </div>
                  )}
                </>
              )}

              {workbenchMode === 'sysid' && <SysIdInspector />}
              {workbenchMode === 'loop' && <ClosedLoopInspector onPreviewChange={setLoopPreviewCfg} />}
            </div>

            {floating && <div className="float-grip" onPointerDown={startFloatResize} title="拖拽调整悬浮窗大小" />}
          </aside>

          {/* Vertical Draggable Splitter */}
          <div className="wb-splitter" onPointerDown={startSplitterDrag} />

          {/* Right Chart Stage */}
          <section className="wb-stage">
            <div className="chart-head-bar">
              <strong>
                {workbenchMode === 'scope'
                  ? tr(lang, 'wb.history')
                  : workbenchMode === 'sysid'
                    ? '幅频 / 相频波特图与闭环带宽预测'
                    : '闭环跟踪响应与 P/I/D 内环分量'}
              </strong>
              <span className="mono-num">
                {workbenchMode === 'scope'
                  ? `${visMin.toFixed(2)}s ~ ${visMax.toFixed(2)}s`
                  : lastAnalysis?.title ?? '等待运行测试'}
              </span>
              <span className="chart-hint">
                滚轮缩放 · 右键拖拽平移 · 双击复位 · 拖分隔条调窗口占高
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
                <button
                  type="button"
                  className="ep-btn ghost mini"
                  onClick={handleResetZoom}
                  title="复位全部横纵轴缩放到自动适配（也可在图表内双击）"
                >
                  {tr(lang, 'wb.resetZoom')}
                </button>
                <button
                  type="button"
                  className="ep-btn ghost mini"
                  onClick={() => setEqualizeToken((t) => t + 1)}
                  title="将上下各波形窗口恢复等高均分（也可双击窗口间分隔条）"
                >
                  {tr(lang, 'wb.equalizeRows')}
                </button>
                <span className="mono-num" style={{ marginLeft: 4 }}>
                  缓存 {sharedRing.count} 点 · Space/Esc 急停
                </span>
              </div>
            </div>

            <div className="chart-box">
              {workbenchMode === 'scope' && (
                <RealtimePlot
                  ring={sharedRing}
                  sampleVersion={sampleVersion}
                  posMode={posMode}
                  outUnit={drv?.outUnit ?? 'Nm'}
                  outName={drv?.outName ?? '输出'}
                  refTarget={state?.runLoopTarget ?? ''}
                  frozen={frozen}
                  windowSec={windowSec}
                  customRange={customRange}
                  yAutoFit={yAutoFit}
                  visibility={visibility}
                  resetZoomToken={resetZoomToken}
                  equalizeToken={equalizeToken}
                  onUserZoomRange={pushZoomRange}
                  onWheelZoomRange={handleWheelZoomRange}
                  onResetZoom={handleResetZoom}
                />
              )}

              {workbenchMode === 'sysid' && (
                <BodePlot
                  bode={exciteData?.bode ?? null}
                  model={exciteData?.model ?? null}
                  predicted={exciteData?.predicted ?? null}
                  timeT={exciteData?.record.t ?? []}
                  timeU={exciteData?.record.u ?? []}
                  timeFb={exciteData?.record.vel ?? []}
                  timeUUnit={drv?.outUnit ?? 'Nm'}
                  timeFbUnit="rad/s"
                  resetZoomToken={resetZoomToken}
                  equalizeToken={equalizeToken}
                />
              )}

              {workbenchMode === 'loop' && (
                <ClosedLoopPlot
                  analysis={lastAnalysis?.runKind === 'loop' ? lastAnalysis : null}
                  preview={loopPreviewCfg}
                  ring={sharedRing}
                  sampleVersion={sampleVersion}
                  running={Boolean(state?.running && state?.runKind === 'loop')}
                  positionOffset={state?.posMt ?? 0}
                  loopKind={state?.runLoopTarget || loopPreviewCfg?.loop || 'vel'}
                  outUnit={drv?.outUnit ?? 'Nm'}
                  resetZoomToken={resetZoomToken}
                  equalizeToken={equalizeToken}
                />
              )}
            </div>

            {/* EmberProbe Bottom Overview Timeline Scrubber + Fit-Y Split Control */}
            {workbenchMode === 'scope' && (
              <div className="timeline-bar">
                <div
                  ref={timelineRef}
                  className="range-timeline"
                  title="拖动蓝色滑块回看历史，双击或点击空白恢复实时跟随"
                  onDoubleClick={handleResetZoom}
                  onClick={() => {
                    if (customRange || frozen) {
                      handleResetZoom();
                    }
                  }}
                >
                  <div
                    className="range-timeline-fill"
                    style={{ left: `${fillLeftPct}%`, width: `${fillWidthPct}%` }}
                    onPointerDown={startTimelineScrub}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="range-timeline-labels mono-num">
                    <span>{bounds.min.toFixed(1)}s</span>
                    <span>
                      {frozen || customRange
                        ? '已锁定视口（拖动滑块平移 · 点击空白恢复跟随）'
                        : '跟随最新采样'}
                    </span>
                    <span>{bounds.max.toFixed(1)}s</span>
                  </div>
                </div>
                <button
                  type="button"
                  className={`ep-btn ghost mini ${yAutoFit ? 'active' : ''}`}
                  onClick={() => setYAutoFit(!yAutoFit)}
                  title="切换纵轴自动适配 / 锁定当前纵轴范围"
                >
                  {yAutoFit ? '纵轴自动适配' : '纵轴已锁定'}
                </button>
              </div>
            )}
          </section>
        </main>
      )}

      {showExportModal && (
        <ExportCsvModal
          ring={sharedRing}
          outUnit={drv?.outUnit ?? 'Nm'}
          onClose={() => setShowExportModal(false)}
        />
      )}
    </div>
  );
};
