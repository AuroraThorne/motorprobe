import React, { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import { LoopConfig, LoopKind, RunAnalysisPayload } from '../../shared/protocol';
import { ColumnRingBuffer } from '../shared/ringBuffer';
import { buildLoopReferencePreview } from './loopPreview';
import {
  attachPlotInteractions,
  ChartRowSplitter,
  formatAxisTick,
  nonNegativeTimeRange,
  useRowWeights,
} from './chartInteractions';

interface ClosedLoopPlotProps {
  analysis: RunAnalysisPayload | null;
  preview: LoopConfig | null;
  ring: ColumnRingBuffer;
  sampleVersion: number;
  running: boolean;
  positionOffset: number;
  loopKind: LoopKind;
  outUnit: string;
  resetZoomToken?: number;
  equalizeToken?: number;
}

type PlotData = [number[], number[], number[]];
type LoopPlotData = [PlotData, PlotData, [number[], number[], number[], number[]]];

function sameLoopConfig(a: LoopConfig | undefined, b: LoopConfig | null): boolean {
  return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
}

function liveLoopRecord(ring: ColumnRingBuffer, loopKind: LoopKind) {
  // t, posMt, velocity, output command, output feedback, reference, P, I, D
  const cols = ring.orderedColumns([0, 2, 3, 4, 5, 6, 11, 12, 13]);
  const [times, pos, vel, output, fbOut, ref, pOut, iOut, dOut] = cols;
  let last = ref.length - 1;
  while (last >= 0 && !Number.isFinite(ref[last])) last -= 1;
  if (last < 0) return null;
  let first = last;
  while (first > 0 && Number.isFinite(ref[first - 1])) first -= 1;
  const t0 = times[first];
  const slice = (values: Float64Array): number[] => Array.from(values.subarray(first, last + 1));
  return {
    t: Array.from(times.subarray(first, last + 1), (value) => Math.max(0, value - t0)),
    pos: slice(pos), vel: slice(vel), u: slice(output), fbOut: slice(fbOut), ref: slice(ref),
    pOut: slice(pOut), iOut: slice(iOut), dOut: slice(dOut),
    measured: loopKind === 'vel' ? slice(vel) : slice(pos),
  };
}

function empty2(): PlotData { return [[], [], []]; }
function empty3(): LoopPlotData { return [empty2(), empty2(), [[], [], [], []]]; }

export const ClosedLoopPlot: React.FC<ClosedLoopPlotProps> = ({
  analysis,
  preview,
  ring,
  sampleVersion,
  running,
  positionOffset,
  loopKind,
  outUnit,
  resetZoomToken = 0,
  equalizeToken = 0,
}) => {
  const { weights, draggingIdx, containerRef, startRowResize, resetWeights } = useRowWeights(
    'loopRowWeights',
    3,
  );
  const hostRefs = [
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
  ];
  const plotsRef = useRef<Array<uPlot | null>>([null, null, null]);
  const resetFnsRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (equalizeToken > 0) resetWeights();
  }, [equalizeToken, resetWeights]);
  useEffect(() => {
    if (resetZoomToken > 0) resetFnsRef.current.forEach((reset) => reset());
  }, [resetZoomToken]);

  const matchingAnalysis = analysis?.runKind === 'loop' && sameLoopConfig(analysis.loopCfg, preview)
    ? analysis.record
    : null;
  const live = useMemo(() => running ? liveLoopRecord(ring, loopKind) : null, [ring, sampleVersion, loopKind, running]);
  const displayed = running ? live : matchingAnalysis;
  const generatedPreview = useMemo(
    () => preview ? buildLoopReferencePreview(preview, positionOffset) : { t: [], ref: [] },
    [preview, positionOffset],
  );
  const sourceT = displayed?.t ?? generatedPreview.t;
  const sourceRef = displayed?.ref ?? generatedPreview.ref;
  const measured = displayed ? (live?.measured ?? (loopKind === 'vel' ? displayed.vel : displayed.pos)) : [];
  const unavailable = (n: number): number[] => new Array<number>(n).fill(Number.NaN);

  const data = useMemo<LoopPlotData>(() => {
    const n = sourceT.length;
    if (n === 0) return empty3();
    const noSignal = unavailable(n);
    return [
      [sourceT, sourceRef, displayed ? measured : noSignal],
      [sourceT, displayed ? displayed.u : noSignal, displayed ? displayed.fbOut : noSignal],
      [sourceT, displayed ? displayed.pOut : noSignal, displayed ? displayed.iOut : noSignal, displayed ? displayed.dOut : noSignal],
    ];
  }, [sourceT, sourceRef, measured, displayed]);
  const dataRef = useRef(data);
  dataRef.current = data;

  const yUnit = loopKind === 'vel' ? 'rad/s' : 'rad';
  const hasOutputRecord = Boolean(displayed && sourceT.length > 1);

  useEffect(() => {
    const style = getComputedStyle(document.body);
    const axis = style.getPropertyValue('--vscode-foreground').trim() || '#cccccc';
    const isLight = document.body.classList.contains('vscode-light');
    const grid = isLight ? 'rgba(0,0,0,0.09)' : 'rgba(255,255,255,0.08)';
    const sync = uPlot.sync('motorprobe-loop');
    const created: Array<uPlot | null> = [null, null, null];
    const observers: ResizeObserver[] = [];
    const cleanups: Array<() => void> = [];
    const resets: Array<() => void> = [];

    const mount = (idx: number, yLabel: string, series: uPlot.Series[], showX: boolean): void => {
      const el = hostRefs[idx].current;
      if (!el) return;
      el.innerHTML = '';
      const rect = el.getBoundingClientRect();
      const plot = new uPlot({
        width: Math.max(140, Math.floor(rect.width)),
        height: Math.max(54, Math.floor(rect.height - 22)),
        padding: [6, 12, showX ? 8 : 2, 0],
        cursor: { sync: { key: sync.key }, drag: { x: true, y: false } },
        legend: { show: true },
        scales: {
          x: { time: false, range: (_u, min, max) => nonNegativeTimeRange(min, max) },
          y: { auto: true },
        },
        axes: [
          {
            stroke: axis,
            grid: { stroke: grid, width: 1 },
            ticks: { stroke: grid, width: 1, size: showX ? 4 : 2 },
            gap: showX ? 3 : 0,
            size: showX ? 40 : 24,
            label: '时间 (s)',
            labelSize: 15,
            labelFont: '600 10px system-ui, sans-serif',
            values: showX
              ? (u, vals) => {
                  const span = Math.max(1e-6, (u.scales.x.max ?? 2) - (u.scales.x.min ?? 0));
                  const digits = span >= 5 ? 1 : span >= 0.5 ? 2 : 3;
                  return vals.map((value) => `${Math.max(0, value).toFixed(digits)}`);
                }
              : () => [],
            font: '10px Cascadia Mono, Consolas, monospace',
          },
          {
            label: yLabel,
            labelSize: 14,
            labelFont: '600 10px system-ui, sans-serif',
            size: 72,
            gap: 5,
            stroke: axis,
            grid: { stroke: grid, width: 1 },
            ticks: { stroke: grid, width: 1 },
            values: (_u, vals) => vals.map(formatAxisTick),
            font: '10px Cascadia Mono, Consolas, monospace',
          },
        ],
        series,
      }, dataRef.current[idx], el);
      created[idx] = plot;

      const resetY = () => {
        const bounds = autoBounds(plot.data.slice(1) as Array<ArrayLike<number | null | undefined>>);
        if (bounds) plot.setScale('y', { min: bounds[0], max: bounds[1] });
      };
      const resetPlot = () => {
        const t = plot.data[0] as ArrayLike<number>;
        if (t?.length > 1) plot.setScale('x', { min: Math.max(0, Number(t[0])), max: Number(t[t.length - 1]) });
        resetY();
      };
      resets.push(resetPlot);
      cleanups.push(attachPlotInteractions({
        slotEl: el,
        plot,
        onZoomX: (min, max) => created.forEach((peer) => peer?.setScale('x', { min, max })),
        onZoomY: (min, max) => plot.setScale('y', { min, max }),
        onResetY: resetY,
        onResetAll: () => resets.forEach((reset) => reset()),
      }));

      const observer = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (!box || box.width <= 20 || box.height <= 20) return;
        const legendHeight = plot.root.querySelector('.u-legend')?.getBoundingClientRect().height ?? 0;
        plot.setSize({ width: Math.floor(box.width), height: Math.max(44, Math.floor(box.height - legendHeight)) });
        created.forEach((peer) => peer?.syncRect(true));
      });
      observer.observe(el);
      observers.push(observer);
    };

    mount(0, `参考 / 反馈 (${yUnit})`, [
      { label: 't' },
      { label: `参考 (${yUnit})`, stroke: '#ef5350', width: 1.8 },
      { label: `反馈 (${yUnit})`, stroke: '#29b6f6', width: 2.0 },
    ], false);
    mount(1, `输出 (${outUnit})`, [
      { label: 't' },
      { label: `控制器输出 (${outUnit})`, stroke: '#ffa726', width: 1.8 },
      { label: `电机反馈 (${outUnit})`, stroke: '#66bb6a', width: 1.6 },
    ], false);
    mount(2, `内环分量 (${outUnit})`, [
      { label: 't' },
      { label: `P (${outUnit})`, stroke: '#42a5f5', width: 1.6 },
      { label: `I (${outUnit})`, stroke: '#ab47bc', width: 1.6 },
      { label: `D (${outUnit})`, stroke: '#26a69a', width: 1.6 },
    ], true);
    plotsRef.current = created;
    resetFnsRef.current = resets;
    return () => {
      plotsRef.current = [null, null, null];
      resetFnsRef.current = [];
      cleanups.forEach((cleanup) => cleanup());
      observers.forEach((observer) => observer.disconnect());
      created.forEach((plot) => plot?.destroy());
    };
  }, [loopKind, outUnit, yUnit]);

  useEffect(() => {
    plotsRef.current.forEach((plot, idx) => plot?.setData(data[idx]));
  }, [data]);

  return (
    <div ref={containerRef} className="chart-stack">
      {[0, 1, 2].map((idx) => (
        <React.Fragment key={idx}>
          {idx > 0 && (
            <ChartRowSplitter
              active={draggingIdx === idx - 1}
              onPointerDown={(event) => startRowResize(idx - 1, event)}
              onDoubleClick={resetWeights}
            />
          )}
          <div className="uplot-slot" style={{ flexGrow: weights[idx] ?? 1, flexShrink: 1, flexBasis: 0 }}>
            <div ref={hostRefs[idx]} className="uplot-canvas-host" />
            {idx > 0 && !hasOutputRecord && (
              <div className="loop-chart-hint">
                {running ? '等待反馈样本…' : '开始闭环后显示实时输出曲线'}
              </div>
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

function autoBounds(arrs: Array<ArrayLike<number | null | undefined>>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const array of arrs) {
    for (let i = 0; i < array.length; i += 1) {
      const value = array[i];
      if (typeof value === 'number' && Number.isFinite(value)) {
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const padding = hi === lo ? Math.max(Math.abs(hi) * 0.15, 1) : (hi - lo) * 0.1;
  return [lo - padding, hi + padding];
}
