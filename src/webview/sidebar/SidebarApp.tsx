import React, { useEffect, useState } from 'react';
import { tr } from '../../shared/i18n';
import {
  BAUDRATE_KEYS,
  BAUDRATE_PCAN,
  BaudRateKey,
  BITRATE_HZ,
  DEFAULT_SAFETY_LIMITS,
  MitCommand,
  SafetyLimits,
  ScanEntry,
  ZERO_MIT,
} from '../../shared/protocol';
import { useClientStore } from '../shared/clientStore';
import { NoticeBanner, PillSwitch } from '../shared/NoticeBanner';
import { loadSavedUiState, postEngine, postToHost, saveUiState } from '../shared/vscodeApi';
import { WriteCard } from '../shared/WriteCard';

const MANUAL_MODELS: Array<{ protocol: 'dm' | 'dji' | 'gd'; model: string }> = [
  { protocol: 'dm', model: 'HM9816G9' },
  { protocol: 'dm', model: 'DM-J8009P' },
  { protocol: 'dm', model: '达妙/HM 通用' },
  { protocol: 'dji', model: 'M3508 (C620)' },
  { protocol: 'dji', model: 'M2006 (C610)' },
  { protocol: 'dji', model: 'GM6020 (电流模式)' },
  { protocol: 'dji', model: 'RM 6623' },
  { protocol: 'gd', model: 'GD 5036-02-CNE' },
  { protocol: 'gd', model: 'GD 5036（通用）' },
  { protocol: 'gd', model: 'GD 6036（通用）' },
  { protocol: 'gd', model: '高擎 GD（经典 CAN）' },
];

export const SidebarApp: React.FC = () => {
  const { lang, state, channels, pcanError, scanEntries, notices } = useClientStore();
  const saved = loadSavedUiState({ selectedChannelId: '', baudKey: '1M', maxDmId: 40 });

  const [selectedChannelId, setSelectedChannelId] = useState<string>(String(saved.selectedChannelId || ''));
  const [baudKey, setBaudKey] = useState<BaudRateKey>((saved.baudKey as BaudRateKey) || '1M');
  const [maxDmId, setMaxDmId] = useState<number>(Number(saved.maxDmId) || 40);
  const [candChoices, setCandChoices] = useState<Record<number, number>>({});
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualModelIdx, setManualModelIdx] = useState(0);
  const [manualMotorId, setManualMotorId] = useState(1);
  const [manualMasterId, setManualMasterId] = useState('0');

  // Target write state
  const [editOut, setEditOut] = useState(0);
  const [appliedOut, setAppliedOut] = useState(0);
  const [editMit, setEditMit] = useState<MitCommand>({ ...ZERO_MIT });
  const [appliedMit, setAppliedMit] = useState<MitCommand>({ ...ZERO_MIT });

  // Safety limits local state synced with backend
  const [safetyLim, setSafetyLim] = useState<SafetyLimits>({ ...DEFAULT_SAFETY_LIMITS });

  useEffect(() => {
    if (channels.length > 0 && !channels.some((c) => c.id === selectedChannelId)) {
      const real = channels.find((c) => c.kind !== 'sim');
      const pick = (real ?? channels[channels.length - 1]).id;
      setSelectedChannelId(pick);
      saveUiState({ selectedChannelId: pick });
    }
  }, [channels, selectedChannelId]);

  useEffect(() => {
    if (state?.safetyLimits) {
      setSafetyLim(state.safetyLimits);
    }
  }, [state?.driver?.title]);

  const connected = Boolean(state?.connected);
  const drv = state?.driver ?? null;
  const active = Boolean(state?.active);
  const tripped = Boolean(state?.tripped);
  const smp = state?.latestSample ?? null;
  const selectedChannel = channels.find((c) => c.id === selectedChannelId) ?? channels[0];

  const handleConnectToggle = (): void => {
    if (connected) {
      postEngine({ type: 'disconnect' });
      return;
    }
    if (!selectedChannel) return;
    postEngine({
      type: 'connect',
      params: {
        kind: selectedChannel.kind,
        channel: selectedChannel.channel,
        channelName: selectedChannel.label,
        baudKey,
        baud: BAUDRATE_PCAN[baudKey],
        bitrate: BITRATE_HZ[baudKey],
      },
    });
  };

  const selectScanEntry = (entry: ScanEntry, idx: number): void => {
    const choiceIdx = candChoices[idx] ?? 0;
    const [model, motorId] = entry.candidates[choiceIdx] ?? [entry.model, entry.motorId];
    setEditOut(0);
    setAppliedOut(0);
    setEditMit({ ...ZERO_MIT });
    setAppliedMit({ ...ZERO_MIT });
    postEngine({
      type: 'selectMotor',
      spec: {
        protocol: entry.protocol,
        model,
        motorId,
        masterId: entry.masterId ?? 0,
      },
    });
  };

  const pushSafety = (patch: Partial<SafetyLimits>): void => {
    const next = { ...safetyLim, ...patch };
    setSafetyLim(next);
    postEngine({ type: 'setSafetyLimits', limits: next });
  };

  const outLimitMax =
    drv && safetyLim.outEnabled && safetyLim.outMax > 0
      ? Math.min(drv.outMax, safetyLim.outMax)
      : drv?.outMax ?? 10;

  const dotClass = tripped || state?.isFault
    ? 'err'
    : state?.scanning || state?.running
      ? 'busy'
      : connected
        ? 'on'
        : '';

  return (
    <div className="sb-root">
      {/* Top Brand Toolbar (EmberProbe Style) */}
      <div className="sb-toolbar">
        <div className="sb-mark">MP</div>
        <strong>MotorProbe</strong>
        <span className="sb-version">v0.1.0</span>
        <button
          type="button"
          className="sb-lang"
          onClick={() => postToHost({ type: 'setLang', lang: lang === 'zh' ? 'en' : 'zh' })}
          title="切换语言 / Switch Language"
        >
          {lang === 'zh' ? '中' : 'EN'}
        </button>
        <span className={`status-dot ${dotClass}`} title={connected ? state?.busName : '未连接'} />
      </div>

      {/* Single-Slot Priority Notice Area */}
      {notices[0] && (
        <div style={{ padding: '4px 9px 0' }}>
          <NoticeBanner
            notice={notices[0]}
            actionLabel={tripped && notices[0].area === 'safety' ? tr(lang, 'sb.unlock') : undefined}
            onAction={tripped ? () => postEngine({ type: 'resetSafety' }) : undefined}
          />
        </div>
      )}

      {/* 1. Bus Connection Accordion */}
      <details className="sb-section" open>
        <summary>
          <span>{tr(lang, 'sb.busConn')}</span>
          <span className="sb-summary-meta">
            {connected ? `${state?.busName} · ${baudKey}` : selectedChannel?.label ?? '—'}
          </span>
        </summary>
        <div className="sb-body">
          <div className="channel-connect-block">
            <div className="channel-connect-status">
              <span className={`status-dot ${connected ? 'on' : ''}`} />
              <span>
                <strong>{connected ? '总线已连接' : '当前选择'}</strong>
                <small>{connected ? state?.busName : selectedChannel?.label ?? '请选择通道'}</small>
              </span>
            </div>
            <button
              type="button"
              className={`ep-btn channel-connect-action ${connected ? 'secondary' : ''}`}
              disabled={!connected && !selectedChannel}
              onClick={handleConnectToggle}
            >
              {connected ? '断开总线连接' : '连接所选通道'}
            </button>
          </div>

          {channels.map((ch) => (
            <button
              key={ch.id}
              type="button"
              disabled={connected}
              className={`channel-card ${ch.id === selectedChannel?.id ? 'selected' : ''}`}
              onClick={() => {
                setSelectedChannelId(ch.id);
                saveUiState({ selectedChannelId: ch.id });
              }}
            >
              <span className={`status-dot ${ch.kind !== 'sim' ? 'on' : ''}`} />
              <span className="channel-copy">
                <strong>{ch.label}</strong>
                <small>{ch.detail}</small>
              </span>
              <span className={`ep-tag ${ch.kind !== 'sim' ? 'accent' : ''}`}>
                {ch.kind.toUpperCase()}
              </span>
            </button>
          ))}

          {pcanError && !connected && (
            <div style={{ fontSize: 10.5, color: 'var(--vscode-descriptionForeground)', margin: '4px 2px' }}>
              提示：未检测到 PCAN 驱动（仍可直接使用演示台或 SLCAN）
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
            <select
              className="ep-select"
              disabled={connected || selectedChannel?.kind === 'socketcan'}
              value={baudKey}
              onChange={(e) => {
                const next = e.target.value as BaudRateKey;
                setBaudKey(next);
                saveUiState({ baudKey: next });
              }}
              style={{ width: 82 }}
            >
              {BAUDRATE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}bps
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ep-btn secondary"
              disabled={connected}
              onClick={() => postEngine({ type: 'listChannels' })}
              title="重新枚举硬件接口"
            >
              刷新
            </button>
          </div>
        </div>
      </details>

      {/* Hero Motor Operation & Emergency Stop Card (.flash-debug-card) */}
      <div className="hero-action-card">
        <button
          type="button"
          className="ep-btn danger hero-estop-btn"
          disabled={!connected || !drv}
          onClick={() => {
            setAppliedOut(0);
            setAppliedMit({ ...ZERO_MIT });
            postEngine({ type: 'estop', reason: '侧边栏急停' });
          }}
          title="立即发送零扭矩/零电流并归零目标指令，不触发失能猛刹"
        >
          ⛔ {tr(lang, 'sb.estop')}
        </button>

        {tripped && (
          <div className="ep-notice error" style={{ margin: 0 }}>
            <div className="ep-notice-head">
              <span className="ep-notice-text">已锁存：{state?.tripReason}</span>
              <button
                type="button"
                className="ep-btn secondary mini"
                onClick={() => postEngine({ type: 'resetSafety' })}
              >
                {tr(lang, 'sb.unlock')}
              </button>
            </div>
          </div>
        )}

        <div className="hero-grid-2">
          <button
            type="button"
            className="ep-btn"
            disabled={!connected || !drv}
            onClick={() => postEngine({ type: 'enable' })}
          >
            {drv?.caps.enableCmd ? tr(lang, 'sb.enable') : tr(lang, 'sb.startOut')}
          </button>
          <button
            type="button"
            className="ep-btn secondary"
            disabled={!connected || !drv}
            onClick={() => postEngine({ type: 'disable' })}
          >
            {drv?.caps.enableCmd ? tr(lang, 'sb.disable') : tr(lang, 'sb.stopOut')}
          </button>
        </div>

        {(drv?.caps.clear || drv?.caps.zero) && (
          <div style={{ display: 'flex', gap: 6 }}>
            {drv?.caps.clear && (
              <button
                type="button"
                className="ep-btn ghost mini"
                style={{ flex: 1 }}
                disabled={!connected}
                onClick={() => postEngine({ type: 'clearError' })}
              >
                {tr(lang, 'sb.clearErr')}
              </button>
            )}
            {drv?.caps.zero && (
              <button
                type="button"
                className="ep-btn ghost mini"
                style={{ flex: 1 }}
                disabled={!connected || active}
                onClick={() => postEngine({ type: 'setZero' })}
              >
                {tr(lang, 'sb.setZero')}
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          className="ep-btn secondary hero-scope-btn"
          onClick={() => postToHost({ type: 'openWorkbench', mode: 'scope' })}
        >
          {tr(lang, 'sb.openScope')}
        </button>

        <div className="hero-status-strip">
          <span className={`status-dot ${active ? 'on' : tripped ? 'err' : ''}`} />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {!connected
              ? '等待连接 CAN 总线'
              : !drv
                ? '请在下方扫描或选择电机'
                : active
                  ? `输出中 (${state?.mode === 'mit' ? 'MIT' : drv.outName})`
                  : state?.codeText || '待机'}
          </span>
          <span className="mono-num">
            {connected && state?.sending ? `${state.txRate.toFixed(0)} Hz` : `${state?.rateHz ?? 1000} Hz`}
          </span>
        </div>
      </div>

      {/* 2. Bus Motors Section */}
      <details className="sb-section" open>
        <summary>
          <span>{tr(lang, 'sb.motors')}</span>
          <span className="sb-summary-meta">{drv ? `${drv.model} #${drv.motorId}` : `${scanEntries.length} 台`}</span>
        </summary>
        <div className="sb-body">
          <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 6 }}>
            <button
              type="button"
              className="ep-btn secondary mini"
              style={{ flex: 1 }}
              disabled={!connected || active || Boolean(state?.scanning)}
              onClick={() => postEngine({ type: 'startScan', maxDmId })}
            >
              {state?.scanning ? `${state.scanStage} (${state.scanCurrent}/${state.scanTotal})` : tr(lang, 'sb.scan')}
            </button>
            <span style={{ fontSize: 10.5, color: 'var(--vscode-descriptionForeground)' }}>ID≤</span>
            <input
              type="number"
              className="ep-input mono-num"
              style={{ width: 46 }}
              min={1}
              max={127}
              value={maxDmId}
              onChange={(e) => setMaxDmId(Math.max(1, Math.min(127, Number(e.target.value) || 40)))}
            />
            <button
              type="button"
              className="ep-btn ghost mini"
              disabled={!connected || active}
              onClick={() => setShowManualAdd(!showManualAdd)}
              title="手动指定电机型号与 ID"
            >
              +
            </button>
          </div>

          {showManualAdd && (
            <div
              style={{
                padding: 7,
                marginBottom: 6,
                border: '1px solid var(--vscode-widget-border)',
                borderRadius: 4,
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              }}
            >
              <select
                className="ep-select"
                value={manualModelIdx}
                onChange={(e) => setManualModelIdx(Number(e.target.value))}
              >
                {MANUAL_MODELS.map((m, idx) => (
                  <option key={m.model} value={idx}>
                    {m.protocol === 'dm' ? '达妙/HM' : m.protocol === 'dji' ? '大疆' : '高擎 GD'} · {m.model}
                  </option>
                ))}
              </select>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <span style={{ fontSize: 10.5 }}>ID</span>
                <input
                  type="number"
                  className="ep-input mono-num"
                  style={{ width: 48 }}
                  min={MANUAL_MODELS[manualModelIdx]?.model === 'RM 6623' ? 0 : 1}
                  max={MANUAL_MODELS[manualModelIdx]?.model === 'RM 6623' ? 7 : MANUAL_MODELS[manualModelIdx]?.protocol === 'gd' ? 126 : 127}
                  value={manualMotorId}
                  onChange={(e) => setManualMotorId(Number(e.target.value) || 1)}
                />
                {MANUAL_MODELS[manualModelIdx]?.protocol === 'dm' && (
                  <>
                    <span style={{ fontSize: 10.5 }}>Master(hex)</span>
                    <input
                      type="text"
                      className="ep-input mono-num"
                      style={{ width: 48 }}
                      value={manualMasterId}
                      onChange={(e) => setManualMasterId(e.target.value)}
                    />
                  </>
                )}
                <button
                  type="button"
                  className="ep-btn mini"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => {
                    const m = MANUAL_MODELS[manualModelIdx];
                    postEngine({
                      type: 'selectMotor',
                      spec: {
                        protocol: m.protocol,
                        model: m.model,
                        motorId: manualMotorId,
                        masterId: m.protocol === 'dm' ? parseInt(manualMasterId, 16) || 0 : 0,
                      },
                    });
                    setShowManualAdd(false);
                  }}
                >
                  绑定
                </button>
              </div>
            </div>
          )}

          {scanEntries.map((e, idx) => {
            const cIdx = candChoices[idx] ?? 0;
            const [curModel, curId] = e.candidates[cIdx] ?? [e.model, e.motorId];
            const isSelected =
              drv?.protocol === e.protocol && drv?.model === curModel && drv?.motorId === curId;
            return (
              <div
                key={`${e.protocol}-${e.fbId}-${e.motorId}`}
                className={`channel-card ${isSelected ? 'selected' : ''}`}
                style={{ cursor: active ? 'default' : 'pointer' }}
                onClick={() => !active && selectScanEntry(e, idx)}
              >
                <div className="channel-copy">
                  {e.candidates.length > 1 ? (
                    <select
                      className="ep-select"
                      style={{ fontSize: 11, padding: '1px 4px', marginBottom: 2 }}
                      value={cIdx}
                      onClick={(ev) => ev.stopPropagation()}
                      onChange={(ev) => {
                        const nextIdx = Number(ev.target.value);
                        setCandChoices((p) => ({ ...p, [idx]: nextIdx }));
                      }}
                    >
                      {e.candidates.map(([cm, cid], ci) => (
                        <option key={cm} value={ci}>
                          {cm} (ID {cid})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <strong>
                      {curModel} · ID {curId}
                    </strong>
                  )}
                  <small>{e.evidence}</small>
                </div>
                <span className="ep-tag mono-num">0x{e.fbId.toString(16).toUpperCase()}</span>
              </div>
            );
          })}

          {drv && (
            <div className="motor-hero">
              <div className="motor-hero-banner">
                <div>
                  <div className="motor-hero-title">{drv.model}</div>
                  <div className="motor-hero-sub">
                    {drv.protocol === 'dm'
                      ? `ID ${drv.motorId} · Master 0x${drv.masterId.toString(16).toUpperCase()}`
                      : `ID ${drv.motorId} · ${drv.protocol === 'gd' ? '扩展帧 FB' : 'FB'} 0x${drv.fbId.toString(16).toUpperCase()}`}
                  </div>
                </div>
                <span className="ep-tag accent">
                  {drv.protocol === 'gd' ? '协议量程' : state?.limitsOk ? '量程就绪' : '读量程中'}
                </span>
              </div>
              <div className="chip-stats">
                <div className="chip-stat">
                  <span className="chip-k">{drv.outName}上限</span>
                  <span className="chip-v mono-num">
                    ±{Number(drv.outMax.toPrecision(7))} {drv.outUnit}
                  </span>
                </div>
                <div className="chip-stat">
                  <span className="chip-k">往返延迟 P50</span>
                  <span className="chip-v mono-num">
                    {state?.latency ? `${(state.latency.p50 * 1000).toFixed(2)} ms` : '广播模式'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </details>

      {/* 3. Live Read / Write Section (EmberProbe Signature Cards) */}
      <details className="sb-section" open>
        <summary>
          <span>{tr(lang, 'sb.liveRw')}</span>
          <span className="sb-summary-meta">{state?.mode === 'mit' ? 'MIT' : '电流/扭矩'}</span>
        </summary>
        <div className="sb-body">
          <div className="sub-heading">
            <span>{tr(lang, 'sb.watchList')}</span>
            <span className="count-pill">4</span>
          </div>
          <div className="value-grid">
            <div className="value-row">
              <div className="value-label-wrap">
                <span className="value-name">多圈位置</span>
                <span className="unit-pill">rad</span>
              </div>
              <span className="value-number mono-num">
                {smp ? smp.posMt.toFixed(4) : '—'}
              </span>
            </div>
            <div className="value-row">
              <div className="value-label-wrap">
                <span className="value-name">输出轴速度</span>
                <span className="unit-pill">rad/s</span>
              </div>
              <span className="value-number mono-num">
                {smp ? smp.vel.toFixed(3) : '—'}
              </span>
            </div>
            <div className="value-row">
              <div className="value-label-wrap">
                <span className="value-name">反馈{drv?.outName ?? '输出'}</span>
                <span className="unit-pill">{drv?.outUnit ?? 'Nm'}</span>
              </div>
              <span className="value-number mono-num">
                {smp ? smp.outFb.toFixed(3) : '—'}
              </span>
            </div>
            <div className="value-row">
              <div className="value-label-wrap">
                <span className="value-name">温度</span>
                <span className="unit-pill">℃</span>
              </div>
              <span className="value-number mono-num">
                {smp && Number.isFinite(smp.temp) ? smp.temp.toFixed(0) : '—'}
              </span>
            </div>
          </div>

          <div className="sub-heading" style={{ marginTop: 10 }}>
            <span>{tr(lang, 'sb.writeList')}</span>
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
                label="目标位置 p"
                unit="rad"
                min={state.limits.pMin}
                max={state.limits.pMax}
                step={0.05}
                decimals={4}
                value={editMit.p}
                appliedValue={appliedMit.p}
                disabled={!drv}
                onChange={(p) => setEditMit((m) => ({ ...m, p }))}
                onApply={() => {
                  setAppliedMit({ ...editMit });
                  postEngine({ type: 'setTargetMit', cmd: editMit });
                }}
                onZero={() => {
                  const next = { ...editMit, p: 0 };
                  setEditMit(next);
                  if (active) {
                    setAppliedMit(next);
                    postEngine({ type: 'setTargetMit', cmd: next });
                  }
                }}
              />
              <WriteCard
                label="目标速度 v"
                unit="rad/s"
                min={state.limits.vMin}
                max={state.limits.vMax}
                step={0.2}
                decimals={3}
                value={editMit.v}
                appliedValue={appliedMit.v}
                disabled={!drv}
                onChange={(v) => setEditMit((m) => ({ ...m, v }))}
                onApply={() => {
                  setAppliedMit({ ...editMit });
                  postEngine({ type: 'setTargetMit', cmd: editMit });
                }}
                onZero={() => {
                  const next = { ...editMit, v: 0 };
                  setEditMit(next);
                  if (active) {
                    setAppliedMit(next);
                    postEngine({ type: 'setTargetMit', cmd: next });
                  }
                }}
              />
              <WriteCard
                label="刚度 Kp"
                min={0}
                max={500}
                step={1}
                decimals={2}
                value={editMit.kp}
                appliedValue={appliedMit.kp}
                disabled={!drv}
                onChange={(kp) => setEditMit((m) => ({ ...m, kp }))}
                onApply={() => {
                  setAppliedMit({ ...editMit });
                  postEngine({ type: 'setTargetMit', cmd: editMit });
                }}
                onZero={() => {
                  const next = { ...editMit, kp: 0 };
                  setEditMit(next);
                  if (active) {
                    setAppliedMit(next);
                    postEngine({ type: 'setTargetMit', cmd: next });
                  }
                }}
              />
              <WriteCard
                label="阻尼 Kd"
                min={0}
                max={5}
                step={0.05}
                decimals={3}
                value={editMit.kd}
                appliedValue={appliedMit.kd}
                disabled={!drv}
                onChange={(kd) => setEditMit((m) => ({ ...m, kd }))}
                onApply={() => {
                  setAppliedMit({ ...editMit });
                  postEngine({ type: 'setTargetMit', cmd: editMit });
                }}
                onZero={() => {
                  const next = { ...editMit, kd: 0 };
                  setEditMit(next);
                  if (active) {
                    setAppliedMit(next);
                    postEngine({ type: 'setTargetMit', cmd: next });
                  }
                }}
              />
              <WriteCard
                label="前馈扭矩 t"
                unit="Nm"
                min={-outLimitMax}
                max={outLimitMax}
                step={0.1}
                decimals={3}
                value={editMit.t}
                appliedValue={appliedMit.t}
                disabled={!drv}
                onChange={(t) => setEditMit((m) => ({ ...m, t }))}
                onApply={() => {
                  setAppliedMit({ ...editMit });
                  postEngine({ type: 'setTargetMit', cmd: editMit });
                }}
                onZero={() => {
                  const next = { ...editMit, t: 0 };
                  setEditMit(next);
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
                  setAppliedMit({ ...editMit });
                  postEngine({ type: 'setTargetMit', cmd: editMit });
                }}
              >
                {tr(lang, 'sb.apply')} (MIT)
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <WriteCard
                label={`目标${drv?.outName ?? '输出'}`}
                unit={drv?.outUnit ?? 'Nm'}
                min={-outLimitMax}
                max={outLimitMax}
                step={0.05}
                decimals={3}
                value={editOut}
                appliedValue={appliedOut}
                disabled={!drv}
                canZeroImmediate={active}
                onChange={setEditOut}
                onApply={() => {
                  setAppliedOut(editOut);
                  postEngine({ type: 'setTargetOut', value: editOut });
                }}
                onZero={() => {
                  setEditOut(0);
                  setAppliedOut(0);
                  postEngine({ type: 'zeroOutput' });
                }}
              />
              <button
                type="button"
                className="ep-btn"
                disabled={!active}
                onClick={() => {
                  setAppliedOut(editOut);
                  postEngine({ type: 'setTargetOut', value: editOut });
                }}
              >
                {tr(lang, 'sb.apply')}
              </button>
            </div>
          )}
        </div>
      </details>

      {/* 4. Safety Limits Section */}
      <details className="sb-section">
        <summary>
          <span>{tr(lang, 'sb.safety')}</span>
          <span className="sb-summary-meta">±{safetyLim.outMax}{drv?.outUnit ?? ''}</span>
        </summary>
        <div className="sb-body" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <PillSwitch
              checked={safetyLim.velEnabled}
              onChange={(velEnabled) => pushSafety({ velEnabled })}
            />
            <span style={{ flex: 1, fontSize: 11.5 }}>速度上限 (±rad/s)</span>
            <input
              type="number"
              className="ep-input mono-num"
              style={{ width: 68 }}
              value={safetyLim.velMax}
              onChange={(e) => pushSafety({ velMax: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <PillSwitch
              checked={safetyLim.outEnabled}
              onChange={(outEnabled) => pushSafety({ outEnabled })}
            />
            <span style={{ flex: 1, fontSize: 11.5 }}>{drv?.outName ?? '输出'}限幅 (±{drv?.outUnit ?? 'Nm'})</span>
            <input
              type="number"
              className="ep-input mono-num"
              style={{ width: 68 }}
              step={0.2}
              value={safetyLim.outMax}
              onChange={(e) => pushSafety({ outMax: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <PillSwitch
              checked={safetyLim.posEnabled}
              onChange={(posEnabled) => pushSafety({ posEnabled })}
            />
            <span style={{ flex: 1, fontSize: 11.5 }}>多圈位置窗口 (rad)</span>
            <button
              type="button"
              className="ep-btn ghost mini"
              onClick={() => postEngine({ type: 'zeroSafetyPosition' })}
            >
              设零基准
            </button>
          </div>
          {safetyLim.posEnabled && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 10.5 }}>Min</span>
              <input
                type="number"
                className="ep-input mono-num"
                style={{ flex: 1 }}
                value={safetyLim.posMin}
                onChange={(e) => pushSafety({ posMin: Number(e.target.value) || 0 })}
              />
              <span style={{ fontSize: 10.5 }}>Max</span>
              <input
                type="number"
                className="ep-input mono-num"
                style={{ flex: 1 }}
                value={safetyLim.posMax}
                onChange={(e) => pushSafety({ posMax: Number(e.target.value) || 0 })}
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 11.5 }}>温度上限 (℃，0=关闭)</span>
            <input
              type="number"
              className="ep-input mono-num"
              style={{ width: 62 }}
              value={safetyLim.tempMax}
              onChange={(e) => pushSafety({ tempMax: Math.max(0, Number(e.target.value) || 0) })}
            />
            <span style={{ fontSize: 11.5 }}>超时(ms，0=关闭)</span>
            <input
              type="number"
              className="ep-input mono-num"
              style={{ width: 56 }}
              value={Math.round(safetyLim.fbTimeout * 1000)}
              onChange={(e) => pushSafety({ fbTimeout: Math.max(0, (Number(e.target.value) || 0) / 1000) })}
            />
          </div>
        </div>
      </details>

      {/* 5. Quick Navigation Links (Modeled on EmberProbe's RTT / Peripherals / RTOS sections) */}
      <details className="sb-section" open>
        <summary>
          <span>{tr(lang, 'sb.shortcuts')}</span>
        </summary>
        <div className="sb-body" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            className="channel-card"
            onClick={() => postToHost({ type: 'openWorkbench', mode: 'sysid' })}
          >
            <span className="channel-copy">
              <strong>频响辨识与模型拟合 (Bode)</strong>
              <small>阶跃 / 步进正弦 / 扫频 / PRBS → J, b, Fc, Td</small>
            </span>
            <span className="ep-tag">打开</span>
          </button>
          <button
            type="button"
            className="channel-card"
            onClick={() => postToHost({ type: 'openWorkbench', mode: 'loop' })}
          >
            <span className="channel-copy">
              <strong>上位机闭环测试 (RMPP PID)</strong>
              <small>速度 PI · 串级位置环 · P/I/D 分量波形</small>
            </span>
            <span className="ep-tag">打开</span>
          </button>
          <button
            type="button"
            className="channel-card"
            onClick={() => postToHost({ type: 'openWorkbench', mode: 'regs' })}
          >
            <span className="channel-copy">
              <strong>电机参数寄存器表</strong>
              <small>0x00~0x51 读写 · Flash 保存 · 修改 ID</small>
            </span>
            <span className="ep-tag">打开</span>
          </button>
          <button
            type="button"
            className="channel-card"
            onClick={() => postToHost({ type: 'openBusMonitor' })}
          >
            <span className="channel-copy">
              <strong>底部 CAN 报文与延迟终端</strong>
              <small>实时收发监控 · 总线负载率 · 原始帧发送</small>
            </span>
            <span className="ep-tag">面板</span>
          </button>
        </div>
      </details>
    </div>
  );
};
