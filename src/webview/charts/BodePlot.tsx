import React, { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { BodeData, ModelFit, PredictedClosedLoop } from '../../shared/protocol';
import { formatFrequencyTick, plotValues } from './plotValues';
import {
  attachPlotInteractions,
  ChartRowSplitter,
  formatAxisTick,
  nonNegativeTimeRange,
  useRowWeights,
} from './chartInteractions';

interface BodePlotProps {
  bode: BodeData | null;
  model: ModelFit | null;
  predicted: PredictedClosedLoop | null;
  timeT: number[];
  timeU: number[];
  timeFb: number[];
  timeVelocity: number[];
  timeUUnit: string;
  outputName: string;
  running?: boolean;
  resetZoomToken?: number;
  equalizeToken?: number;
}

function autoBounds(arrs: Array<ArrayLike<number | null | undefined>>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of arrs) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const pad = hi === lo ? Math.max(Math.abs(hi) * 0.15, 1) : (hi - lo) * 0.1;
  return [lo - pad, hi + pad];
}

export const BodePlot: React.FC<BodePlotProps> = ({
  bode,
  model,
  predicted,
  timeT,
  timeU,
  timeFb,
  timeVelocity,
  timeUUnit,
  outputName,
  running = false,
  resetZoomToken = 0,
  equalizeToken = 0,
}) => {
  const [response, setResponse] = useState<'output' | 'velocity'>('output');
  const showVelocity = response === 'velocity';
  const { weights, draggingIdx, containerRef, startRowResize, resetWeights } = useRowWeights(
    'bodeRowWeights',
    4,
  );

  const hostRefs = [
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
  ];
  const resetFnsRef = useRef<Array<() => void>>([]);
  const plotsRef = useRef<uPlot[]>([]);

  useEffect(() => {
    if (equalizeToken > 0) resetWeights();
  }, [equalizeToken, resetWeights]);

  useEffect(() => {
    if (resetZoomToken > 0) {
      for (const fn of resetFnsRef.current) fn();
    }
  }, [resetZoomToken]);

  const data = useMemo<uPlot.AlignedData[]>(() => {
    const toDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

    let magData: uPlot.AlignedData = [[], [], [], [], []];
    let phData: uPlot.AlignedData = [[], [], [], [], []];
    if (bode && bode.f.length > 0) {
      const f = bode.f;
      const mvDb = plotValues(bode.magV.map(toDb));
      const mpDb = plotValues(bode.magP.map(toDb));
      let modVDb: Array<number | null> = f.map(() => null);
      let modPDb: Array<number | null> = f.map(() => null);
      let modPhV: Array<number | null> = f.map(() => null);
      let modPhP: Array<number | null> = f.map(() => null);
      if (model) {
        modVDb = f.map((hz) => {
          const w = 2 * Math.PI * hz;
          return toDb(1.0 / Math.hypot(model.J * w, model.b));
        });
        modPDb = f.map((hz) => {
          const w = 2 * Math.PI * hz;
          return toDb(1.0 / (w * Math.hypot(model.J * w, model.b)));
        });
        modPhV = f.map((hz) => {
          const w = 2 * Math.PI * hz;
          return (-(Math.atan2(model.J * w, model.b) + w * model.Td) * 180) / Math.PI;
        });
        modPhP = modPhV.map((pv) => (pv !== null ? pv - 90 : null));
      }
      magData = [f, mvDb, mpDb, modVDb, modPDb];
      phData = [f, plotValues(bode.phV), plotValues(bode.phP), modPhV, modPhP];
    }

    const clData: uPlot.AlignedData = predicted
      ? [
          predicted.f,
          predicted.velDb,
          predicted.posDb,
          predicted.singlePosDb,
          predicted.f.map(() => -3.01),
        ]
      : [[], [], [], [], []];

    return [magData, phData, [timeT, plotValues(timeU), plotValues(showVelocity ? timeVelocity : timeFb)], clData];
  }, [bode, model, predicted, timeT, timeU, timeFb, timeVelocity, showVelocity]);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const style = getComputedStyle(document.body);
    const axis = style.getPropertyValue('--vscode-foreground').trim() || '#cccccc';
    const isLight = document.body.classList.contains('vscode-light');
    const grid = isLight ? 'rgba(0,0,0,0.09)' : 'rgba(255,255,255,0.08)';
    const freqSync = uPlot.sync('cmk-bode-freq');

    const created: uPlot[] = [];
    const freqPlots: uPlot[] = [];
    const observers: ResizeObserver[] = [];
    const cleanups: Array<() => void> = [];
    const resetAllFns: Array<() => void> = [];

    const mountPlot = (
      idx: number,
      logX: boolean,
      yLabel: string,
      series: uPlot.Series[],
      rightAxisLabel?: string,
    ): void => {
      const el = hostRefs[idx].current;
      if (!el) return;
      const data = dataRef.current[idx];
      el.innerHTML = '';
      const rect = el.getBoundingClientRect();
      const opts: uPlot.Options = {
        width: Math.max(140, Math.floor(rect.width)),
        height: Math.max(54, Math.floor(rect.height - 22)),
        padding: [6, 12, 6, 0],
        cursor: logX
          ? { sync: { key: freqSync.key }, drag: { x: true, y: false } }
          : { drag: { x: true, y: false } },
        legend: { show: true },
        scales: {
          x: logX
            ? { time: false, distr: 3 }
            : { time: false, range: (_u, min, max) => nonNegativeTimeRange(min, max) },
          y: { auto: true },
          ...(rightAxisLabel ? { y2: { auto: true } } : {}),
        },
        axes: [
          {
            label: logX ? '频率 (Hz)' : '时间 (s)',
            labelSize: 15,
            labelFont: '600 10px system-ui, sans-serif',
            stroke: axis,
            grid: { stroke: grid, width: 1 },
            ticks: { stroke: grid, width: 1, size: 4 },
            gap: 3,
            size: 40,
            values: logX
              ? (_u, vals) => vals.map(formatFrequencyTick)
              : (_u, vals) => vals.map((v) => `${Number(v.toFixed(2))}s`),
            font: '10px Cascadia Mono, Consolas, monospace',
          },
          {
            scale: 'y',
            label: yLabel,
            labelSize: 14,
            labelFont: '600 10px system-ui, sans-serif',
            size: 64,
            gap: 5,
            stroke: axis,
            grid: { stroke: grid, width: 1 },
            ticks: { stroke: grid, width: 1 },
            values: (_u, vals) => vals.map(formatAxisTick),
            font: '10px Cascadia Mono, Consolas, monospace',
          },
          ...(rightAxisLabel ? [{
            scale: 'y2',
            side: 1,
            label: rightAxisLabel,
            labelSize: 14,
            labelFont: '600 10px system-ui, sans-serif',
            size: 68,
            gap: 5,
            stroke: axis,
            grid: { show: false, stroke: grid, width: 1 },
            ticks: { stroke: grid, width: 1 },
            values: (_u: uPlot, vals: number[]) => vals.map(formatAxisTick),
            font: '10px Cascadia Mono, Consolas, monospace',
          } as uPlot.Axis] : []),
        ],
        series,
      };
      const plot = new uPlot(opts, data, el);
      created.push(plot);
      if (logX) freqPlots.push(plot);

      const resetThisY = () => {
        const initY = autoBounds(
          (rightAxisLabel ? plot.data.slice(2, 3) : plot.data.slice(1)) as Array<ArrayLike<number | null | undefined>>,
        );
        const initY2 = rightAxisLabel ? autoBounds([plot.data[1]]) : null;
        if (initY) plot.setScale('y', { min: initY[0], max: initY[1] });
        if (initY2) plot.setScale('y2', { min: initY2[0], max: initY2[1] });
      };
      const resetThisPlot = () => {
        const x = plot.data[0];
        if (x.length > 1 && x[x.length - 1] > x[0]) {
          plot.setScale('x', { min: x[0], max: x[x.length - 1] });
        }
        resetThisY();
      };
      resetAllFns.push(resetThisPlot);

      const detach = attachPlotInteractions({
        slotEl: el,
        plot,
        logX,
        onZoomX: (min, max) => {
          if (logX) {
            for (const fp of freqPlots) fp.setScale('x', { min, max });
          } else {
            plot.setScale('x', { min, max });
          }
        },
        onZoomY: (min, max) => {
          plot.setScale('y', { min, max });
        },
        onResetY: resetThisY,
        onResetAll: () => {
          if (logX) {
            for (const fn of resetAllFns) fn();
          } else {
            resetThisPlot();
          }
        },
      });
      cleanups.push(detach);

      const ro = new ResizeObserver((entries) => {
        const cr = entries[0]?.contentRect;
        if (cr && cr.width > 20 && cr.height > 20) {
          const legendH = plot.root.querySelector('.u-legend')?.getBoundingClientRect().height ?? 0;
          plot.setSize({
            width: Math.floor(cr.width),
            height: Math.max(44, Math.floor(cr.height - legendH)),
          });
          for (const peer of created) peer.syncRect(true);
        }
      });
      ro.observe(el);
      observers.push(ro);
    };


    mountPlot(
      0,
      true,
      '幅值 (dB)',
      [
        { label: 'Hz' },
        { label: `激励→速度 ((rad/s)/${timeUUnit})`, stroke: '#29b6f6', width: 2, points: { show: true, size: 5 } },
        { label: `激励→位置 (rad/${timeUUnit})`, stroke: '#ffa726', width: 2, points: { show: true, size: 5 } },
        { label: '拟合(速度)', stroke: '#90a4ae', width: 1.5, dash: [5, 4] },
        { label: '拟合(位置)', stroke: '#78909c', width: 1.5, dash: [2, 3] },
      ],
    );

    mountPlot(
      1,
      true,
      '相位 (°)',
      [
        { label: 'Hz' },
        { label: '相位：激励→速度 (°)', stroke: '#29b6f6', width: 2, points: { show: true, size: 5 } },
        { label: '相位：激励→位置 (°)', stroke: '#ffa726', width: 2, points: { show: true, size: 5 } },
        { label: '拟合(速度)', stroke: '#90a4ae', width: 1.5, dash: [5, 4] },
        { label: '拟合(位置)', stroke: '#78909c', width: 1.5, dash: [2, 3] },
      ],
    );

    mountPlot(
      2,
      false,
      showVelocity ? '反馈速度 (rad/s)' : `激励 / 反馈${outputName} (${timeUUnit})`,
      [
        { label: 's' },
        { label: `激励${outputName} (${timeUUnit})`, scale: showVelocity ? 'y2' : 'y', stroke: '#ef5350', width: 1.6 },
        { label: showVelocity ? '反馈速度 (rad/s)' : `反馈${outputName} (${timeUUnit})`, scale: 'y', stroke: '#42a5f5', width: 1.6 },
      ],
      showVelocity ? `激励${outputName} (${timeUUnit})` : undefined,
    );


    mountPlot(
      3,
      true,
      '闭环预测增益 (dB)',
      [
        { label: 'Hz' },
        { label: '速度闭环', stroke: '#29b6f6', width: 2 },
        { label: '串级位置闭环', stroke: '#ffa726', width: 2 },
        { label: '单环位置闭环', stroke: '#26a69a', width: 1.8 },
        { label: '-3 dB', stroke: '#888888', width: 1.2, dash: [4, 4] },
      ],
    );

    plotsRef.current = created;
    resetFnsRef.current = resetAllFns;
    return () => {
      plotsRef.current = [];
      resetFnsRef.current = [];
      for (const fn of cleanups) fn();
      for (const ro of observers) ro.disconnect();
      for (const p of created) p.destroy();
    };
  }, [timeUUnit, outputName, showVelocity]);

  useEffect(() => {
    plotsRef.current.forEach((plot, idx) => plot.setData(data[idx]));
  }, [data]);

  return (
    <div ref={containerRef} className="chart-stack">
      {[0, 1, 2, 3].map((idx) => (
        <React.Fragment key={idx}>
          {idx > 0 && (
            <ChartRowSplitter
              active={draggingIdx === idx - 1}
              onPointerDown={(e) => startRowResize(idx - 1, e)}
              onDoubleClick={resetWeights}
            />
          )}
          <div
            className="uplot-slot"
            style={{
              flexGrow: weights[idx] ?? 1,
              flexShrink: 1,
              flexBasis: 0,
            }}
          >
            <div ref={hostRefs[idx]} className="uplot-canvas-host" />
            {idx === 2 && (
              <select
                aria-label="时域反馈类型"
                className="ep-select response-selector"
                value={response}
                onChange={(event) => setResponse(event.target.value as 'output' | 'velocity')}
              >
                <option value="output">{outputName}跟随 ({timeUUnit})</option>
                <option value="velocity">速度响应 (rad/s)</option>
              </select>
            )}
            {idx < 2 && (!bode || bode.f.length === 0) && (
              <div className="chart-empty-overlay">{running ? '正在采集频响点，幅频 / 相频曲线随测试更新…' : '暂无有效频响点；请运行步进正弦、扫频或 PRBS 测试'}</div>
            )}
            {idx === 2 && timeT.length === 0 && (
              <div className="chart-empty-overlay">测试开始后实时显示激励与反馈</div>
            )}
            {idx === 3 && !predicted && (
              <div className="chart-empty-overlay">{running ? '测试结束并完成拟合后显示闭环预测' : '完成模型辨识后显示闭环带宽预测'}</div>
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};
