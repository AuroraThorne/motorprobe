import React, { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { CanFrameDto } from '../../shared/protocol';
import {
  aggregatedFramesMap,
  clearFrameLogs,
  getFrameRelativeTime,
  rawFramesBuffer,
  useClientStore,
} from '../shared/clientStore';
import { PillSwitch } from '../shared/NoticeBanner';
import { postEngine, postToHost } from '../shared/vscodeApi';

export const BusMonitorApp: React.FC = () => {
  const { state, frameVersion, busLoadPct, feedbackFps, latencyMs } = useClientStore();
  const [tab, setTab] = useState<'frames' | 'latency'>('frames');
  const [paused, setPaused] = useState(false);
  const [hidePeriodic, setHidePeriodic] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  const [aggregate, setAggregate] = useState(true);
  const [idFilter, setIdFilter] = useState('');

  // Manual & periodic raw frame sender
  const [txIdHex, setTxIdHex] = useState('7FF');
  const [txDataHex, setTxDataHex] = useState('01 00 33 3C 00 00 00 00');
  const [frameMode, setFrameMode] = useState<'std' | 'ext' | 'std_rtr' | 'ext_rtr'>('std');
  const [rtrDlc, setRtrDlc] = useState(8);
  const [periodicHz, setPeriodicHz] = useState(10);

  const histRef = useRef<HTMLDivElement | null>(null);
  const [frozenRows, setFrozenRows] = useState<CanFrameDto[]>([]);

  // Poll latency histogram when latency tab is visible
  useEffect(() => {
    if (tab !== 'latency') return;
    postEngine({ type: 'getLatencySnapshot' });
    const id = setInterval(() => postEngine({ type: 'getLatencySnapshot' }), 600);
    return () => clearInterval(id);
  }, [tab]);

  const filterSet = useMemo(() => {
    const trimmed = idFilter.trim();
    if (!trimmed) return null;
    const set = new Set<number>();
    for (const part of trimmed.split(/[,\s]+/)) {
      const n = parseInt(part, 16);
      if (Number.isFinite(n)) set.add(n);
    }
    return set.size > 0 ? set : null;
  }, [idFilter]);

  const liveRows = useMemo(() => {
    const src = aggregate ? [...aggregatedFramesMap.values()] : rawFramesBuffer.slice(-300);
    return src.filter((f) => {
      if (filterSet && !filterSet.has(f.canId)) return false;
      if (onlyMine && !f.note) return false;
      if (
        hidePeriodic &&
        (f.note === 'MIT控制' ||
          f.note === '查询状态' ||
          f.note.startsWith('下发电流') ||
          f.note.startsWith('位置:'))
      ) {
        return false;
      }
      return true;
    });
  }, [frameVersion, aggregate, filterSet, onlyMine, hidePeriodic]);

  useEffect(() => {
    if (!paused) {
      setFrozenRows(liveRows);
    }
  }, [liveRows, paused]);

  // Render Latency Histogram via uPlot
  useEffect(() => {
    const el = histRef.current;
    if (tab !== 'latency' || !el) return;
    el.innerHTML = '';
    if (latencyMs.length < 2) return;

    const minV = Math.min(...latencyMs);
    const maxV = Math.max(...latencyMs, minV + 0.05);
    const bins = 40;
    const step = (maxV - minV) / bins;
    const xs = new Array<number>(bins);
    const counts = new Array<number>(bins).fill(0);
    for (let i = 0; i < bins; i++) xs[i] = minV + (i + 0.5) * step;
    for (const v of latencyMs) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((v - minV) / step)));
      counts[idx] += 1;
    }

    const style = getComputedStyle(document.body);
    const axis = style.getPropertyValue('--vscode-foreground').trim() || '#cccccc';
    const rect = el.getBoundingClientRect();
    const barsPath = uPlot.paths.bars?.({ size: [0.82, 100] });
    const plot = new uPlot(
      {
        width: Math.max(200, Math.floor(rect.width)),
        height: Math.max(120, Math.floor(rect.height)),
        legend: { show: false },
        scales: { x: { time: false }, y: { auto: true } },
        axes: [
          {
            label: '往返延迟 (ms)',
            labelSize: 16,
            size: 26,
            stroke: axis,
            grid: { stroke: 'rgba(128,128,128,0.18)', width: 1 },
            values: (_u, vals) => vals.map((v) => v.toFixed(2)),
            font: '10px Cascadia Mono, Consolas, monospace',
          },
          {
            label: '样本数',
            labelSize: 14,
            size: 48,
            stroke: axis,
            grid: { stroke: 'rgba(128,128,128,0.18)', width: 1 },
            font: '10px Cascadia Mono, Consolas, monospace',
          },
        ],
        series: [
          { label: 'ms' },
          {
            label: '次数',
            stroke: '#29b6f6',
            fill: 'rgba(41, 182, 246, 0.45)',
            paths: barsPath,
            points: { show: false },
          },
        ],
      },
      [xs, counts],
      el,
    );

    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr && cr.width > 30 && cr.height > 30) {
        plot.setSize({ width: Math.floor(cr.width), height: Math.floor(cr.height) });
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [tab, latencyMs]);

  const handleSaveLog = (): void => {
    const lines = [
      'Timestamp(s)\tChannel\tDir\tCAN_ID\tDLC\tData\tComment',
      ...frozenRows.map((f) => {
        const idW = f.extended ? 8 : 3;
        const idStr = `0x${f.canId.toString(16).toUpperCase().padStart(idW, '0')}${f.extended ? ' (Ext)' : ''}`;
        const dir = `${f.tx ? 'TX' : 'RX'}${f.rtr ? '/RTR' : ''}`;
        return `${getFrameRelativeTime(f.t).toFixed(4)}\t${state?.busName ?? ''}\t${dir}\t${idStr}\t${f.dlc}\t${f.rtr ? '—' : f.dataHex}\t${f.note}`;
      }),
    ];
    postToHost({
      type: 'saveFile',
      defaultName: 'can_bus_log.txt',
      filterName: 'CAN 报文日志',
      extensions: ['txt'],
      content: lines.join('\n'),
    });
  };

  const isRtr = frameMode === 'std_rtr' || frameMode === 'ext_rtr';
  const isExt = frameMode === 'ext' || frameMode === 'ext_rtr';

  const sendManual = (): void => {
    const cid = parseInt(txIdHex.trim(), 16);
    if (!Number.isFinite(cid)) return;
    postEngine({
      type: 'sendRaw',
      canId: cid,
      dataHex: txDataHex,
      extended: isExt,
      rtr: isRtr,
      dlc: rtrDlc,
    });
  };

  const togglePeriodic = (): void => {
    if (state?.rawPeriodicActive) {
      postEngine({ type: 'stopRawPeriodic' });
      return;
    }
    const cid = parseInt(txIdHex.trim(), 16);
    if (!Number.isFinite(cid)) return;
    postEngine({
      type: 'startRawPeriodic',
      canId: cid,
      dataHex: txDataHex,
      frequency: periodicHz,
      extended: isExt,
      rtr: isRtr,
      dlc: rtrDlc,
    });
  };

  const lat = state?.latency;

  return (
    <div className="bus-root">
      {/* Top Underline Tabs & Live Metrics */}
      <div className="bus-tabs">
        <button
          type="button"
          className={`bus-tab ${tab === 'frames' ? 'selected' : ''}`}
          onClick={() => setTab('frames')}
        >
          实时报文流 ({frozenRows.length})
        </button>
        <button
          type="button"
          className={`bus-tab ${tab === 'latency' ? 'selected' : ''}`}
          onClick={() => setTab('latency')}
        >
          往返延迟直方图 {lat ? `(P50 ${(lat.p50 * 1000).toFixed(2)} ms)` : ''}
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, paddingRight: 6 }}>
          <span className="ep-tag mono-num">
            总线负载：{busLoadPct !== null ? `${busLoadPct.toFixed(1)}%` : '—'}
          </span>
          <span className="ep-tag mono-num">
            反馈帧率 0x{(state?.driver?.fbId ?? 0x202).toString(16).toUpperCase().padStart(3, '0')}：{feedbackFps} FPS
          </span>
        </div>
      </div>

      {tab === 'frames' ? (
        <>
          <div className="bus-filter-bar">
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <PillSwitch
                checked={state?.logEnabled ?? true}
                onChange={(enabled) => postEngine({ type: 'setLogEnabled', enabled })}
              />
              <span>记录</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
              <span>暂停显示</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={aggregate}
                onChange={(e) => {
                  clearFrameLogs();
                  setAggregate(e.target.checked);
                }}
              />
              <span>按 ID 聚合</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={hidePeriodic}
                onChange={(e) => setHidePeriodic(e.target.checked)}
              />
              <span>隐藏周期帧</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
              <span>只看当前电机</span>
            </label>
            <input
              type="text"
              className="ep-input mono-num"
              style={{ width: 170 }}
              placeholder="过滤 ID (hex, 如 7FF,201)"
              value={idFilter}
              onChange={(e) => setIdFilter(e.target.value)}
            />
            <button type="button" className="ep-btn ghost mini" onClick={clearFrameLogs}>
              清空
            </button>
            <button type="button" className="ep-btn secondary mini" onClick={handleSaveLog}>
              保存日志…
            </button>
          </div>

          <div className="bus-table-scroll">
            <div className="bus-row head">
              <span>Time (s)</span>
              <span>Channel</span>
              <span>Dir</span>
              <span>CAN ID</span>
              <span>DLC</span>
              <span>Data (Hex)</span>
              <span>Protocol Comment</span>
            </div>
            {frozenRows.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--vscode-descriptionForeground)' }}>
                暂无报文（连接总线后自动显示收发帧）
              </div>
            ) : (
              frozenRows.map((f, i) => {
                const idW = f.extended ? 8 : 3;
                const idTxt = `0x${f.canId.toString(16).toUpperCase().padStart(idW, '0')}`;
                return (
                  <div
                    key={aggregate ? `${f.canId}-${f.tx}-${f.extended}-${f.rtr}` : i}
                    className="bus-row"
                  >
                    <span>{getFrameRelativeTime(f.t).toFixed(4)}</span>
                    <span>{state?.busName || '—'}</span>
                    <span className={f.tx ? 'bus-tx' : 'bus-rx'}>
                      {f.tx ? 'TX' : 'RX'}
                      {f.rtr ? '/R' : ''}
                    </span>
                    <span>{idTxt}</span>
                    <span>{f.dlc}</span>
                    <span>{f.rtr ? 'RTR' : f.dataHex}</span>
                    <span style={{ color: 'var(--vscode-descriptionForeground)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {f.note}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {/* Bottom Raw CAN Prompt Bar */}
          <div className="bus-send-bar">
            <select
              className="ep-select"
              value={frameMode}
              disabled={Boolean(state?.rawPeriodicActive)}
              onChange={(e) => setFrameMode(e.target.value as typeof frameMode)}
            >
              <option value="std">标准数据帧</option>
              <option value="ext">扩展数据帧</option>
              <option value="std_rtr">标准远程帧 (RTR)</option>
              <option value="ext_rtr">扩展远程帧 (RTR)</option>
            </select>
            <span>ID(hex)</span>
            <input
              type="text"
              className="ep-input mono-num"
              style={{ width: 68 }}
              disabled={Boolean(state?.rawPeriodicActive)}
              value={txIdHex}
              onChange={(e) => setTxIdHex(e.target.value)}
            />
            {isRtr ? (
              <>
                <span>DLC</span>
                <input
                  type="number"
                  className="ep-input mono-num"
                  style={{ width: 48 }}
                  min={0}
                  max={8}
                  value={rtrDlc}
                  onChange={(e) => setRtrDlc(Math.max(0, Math.min(8, Number(e.target.value) || 0)))}
                />
              </>
            ) : (
              <>
                <span>Data(hex)</span>
                <input
                  type="text"
                  className="ep-input mono-num"
                  style={{ width: 195 }}
                  disabled={Boolean(state?.rawPeriodicActive)}
                  value={txDataHex}
                  onChange={(e) => setTxDataHex(e.target.value)}
                />
              </>
            )}
            <button
              type="button"
              className="ep-btn secondary mini"
              disabled={!state?.connected}
              onClick={sendManual}
              title="直接发送原始 CAN 帧（不经过电机安全限幅）"
            >
              发送单帧
            </button>
            <span style={{ marginLeft: 6 }}>周期</span>
            <input
              type="number"
              className="ep-input mono-num"
              style={{ width: 62 }}
              min={0.5}
              max={2000}
              step={1}
              value={periodicHz}
              onChange={(e) => setPeriodicHz(Math.max(0.1, Number(e.target.value) || 10))}
            />
            <span>Hz</span>
            <button
              type="button"
              className={`ep-btn mini ${state?.rawPeriodicActive ? 'danger' : 'ghost'}`}
              disabled={!state?.connected}
              onClick={togglePeriodic}
            >
              {state?.rawPeriodicActive ? '停止周期发送' : '启动周期发送'}
            </button>
          </div>
        </>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '8px 12px', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="mono-num" style={{ fontSize: 12 }}>
              {lat
                ? `样本 n=${lat.n}  |  P50 ${(lat.p50 * 1000).toFixed(2)} ms  |  P95 ${(lat.p95 * 1000).toFixed(2)} ms  |  P99 ${(lat.p99 * 1000).toFixed(2)} ms  |  Max ${(lat.max * 1000).toFixed(2)} ms`
                : state?.driver && !state.driver.caps.enableCmd
                  ? '大疆电调采用 1 kHz 主动广播反馈，无问答往返延迟'
                  : '暂无往返延迟样本（选择达妙/HM 电机并打开查询/控制后自动采集）'}
            </span>
            <button
              type="button"
              className="ep-btn ghost mini"
              style={{ marginLeft: 'auto' }}
              onClick={() => postEngine({ type: 'clearLatencies' })}
            >
              清空统计
            </button>
          </div>
          <div ref={histRef} className="chart-box" style={{ flex: 1 }} />
        </div>
      )}
    </div>
  );
};
