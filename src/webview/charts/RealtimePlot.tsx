import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { ColumnRingBuffer } from '../shared/ringBuffer';
import {
  attachPlotInteractions,
  ChartRowSplitter,
  formatAxisTick,
  nonNegativeTimeRange,
  useRowWeights,
} from './chartInteractions';

export interface CurveVisibility {
  pos: boolean;
  refPos: boolean;
  vel: boolean;
  refVel: boolean;
  outCmd: boolean;
  outFb: boolean;
  temp: boolean;
}

export interface ViewportBounds {
  min: number;
  max: number;
}

interface RealtimePlotProps {
  ring: ColumnRingBuffer;
  sampleVersion: number;
  posMode: 'multi' | 'raw';
  outUnit: string;
  outName: string;
  refTarget: '' | 'vel' | 'pos' | 'pos_single';
  frozen: boolean;
  windowSec: number; // 0 = all
  customRange: ViewportBounds | null;
  yAutoFit: boolean;
  visibility: CurveVisibility;
  showTemp?: boolean;
  resetZoomToken?: number;
  equalizeToken?: number;
  onUserZoomRange: (range: ViewportBounds) => void;
  onWheelZoomRange?: (range: ViewportBounds) => void;
  onResetZoom?: () => void;
}

function getThemeColors(): { axis: string; grid: string } {
  const style = getComputedStyle(document.body);
  const fg = style.getPropertyValue('--vscode-foreground').trim() || '#cccccc';
  const isLight = document.body.classList.contains('vscode-light');
  return {
    axis: fg,
    grid: isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.075)',
  };
}

function formatTimeAxis(u: uPlot, vals: number[]): string[] {
  const min = u.scales.x.min ?? 0;
  const max = u.scales.x.max ?? 10;
  const span = Math.max(1e-6, max - min);
  const digits = span >= 5 ? 1 : span >= 0.5 ? 2 : span >= 0.05 ? 3 : 4;
  return vals.map((v) => `${v.toFixed(digits)}s`);
}

export interface YRangeOptions {
  minSpan: number;
  zeroSymmetric?: boolean;
  adaptivePosition?: boolean;
  includeZero?: boolean;
}

const CHANNEL_Y_OPTS: readonly YRangeOptions[] = [
  { minSpan: 0.5, zeroSymmetric: true, adaptivePosition: true }, // 0: 位置 (rad)
  { minSpan: 2.0, zeroSymmetric: true, includeZero: true }, // 1: 速度 (rad/s)
  { minSpan: 1.0, zeroSymmetric: true }, // 2: 输出 (Nm / A)
  { minSpan: 6.0, zeroSymmetric: false }, // 3: 温度 (℃)
];

export function computeYRange(
  tArr: Float64Array,
  seriesList: Array<Float64Array | null>,
  xMin: number,
  xMax: number,
  opts: YRangeOptions,
): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  const n = tArr.length;
  for (const s of seriesList) {
    if (!s) continue;
    for (let i = 0; i < n; i++) {
      const ti = tArr[i];
      if (ti < xMin || ti > xMax) continue;
      const v = s[i];
      if (Number.isFinite(v)) {
        if (v < low) low = v;
        if (v > high) high = v;
      }
    }
  }

  const baseMinSpan = Math.max(1e-3, opts.minSpan);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return opts.zeroSymmetric === false
      ? [20, 20 + baseMinSpan]
      : [-baseMinSpan / 2, baseMinSpan / 2];
  }
  if (opts.includeZero) {
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  }

  const baseline = Math.max(Math.abs(low), Math.abs(high));
  const effMinSpan = opts.adaptivePosition
    ? Math.max(baseMinSpan, baseline * 0.002)
    : baseMinSpan;

  // Zero-vicinity deadband lock: keeps axis rock-solid when signal jitters around 0
  if (opts.zeroSymmetric !== false) {
    const halfLock = effMinSpan * 0.42;
    if (low >= -halfLock && high <= halfLock) {
      return [-effMinSpan / 2, effMinSpan / 2];
    }
  }

  const rawSpan = high - low;
  const paddedSpan = rawSpan * 1.24;

  // Non-zero steady plateau lock: snaps midpoint so minor LSB noise never jiggles ticks
  if (paddedSpan < effMinSpan) {
    const mid = (low + high) * 0.5;
    const grid = effMinSpan * 0.1;
    const snappedMid = Math.round(mid / grid) * grid;
    const margin = effMinSpan * 0.44;
    if (low >= snappedMid - margin && high <= snappedMid + margin) {
      return [snappedMid - effMinSpan / 2, snappedMid + effMinSpan / 2];
    }
    return [mid - effMinSpan / 2, mid + effMinSpan / 2];
  }

  const pad = Math.max(rawSpan * 0.12, effMinSpan * 0.05);
  return [low - pad, high + pad];
}

export const RealtimePlot: React.FC<RealtimePlotProps> = ({
  ring,
  sampleVersion,
  posMode,
  outUnit,
  outName,
  refTarget,
  frozen,
  windowSec,
  customRange,
  yAutoFit,
  visibility,
  showTemp = true,
  resetZoomToken = 0,
  equalizeToken = 0,
  onUserZoomRange,
  onWheelZoomRange,
  onResetZoom,
}) => {
  const maxSlots = showTemp ? 4 : 3;
  const { weights, draggingIdx, containerRef, startRowResize, resetWeights } = useRowWeights(
    'scopeRowWeights',
    maxSlots,
  );

  const visibleSlots = useMemo(() => {
    const flags = [
      visibility.pos,
      visibility.vel,
      visibility.outCmd || visibility.outFb,
      showTemp && visibility.temp,
    ];
    return [0, 1, 2, 3].filter((idx) => idx < maxSlots && flags[idx]);
  }, [visibility.pos, visibility.vel, visibility.outCmd, visibility.outFb, visibility.temp, showTemp, maxSlots]);

  const visibleKey = visibleSlots.join(',');

  const canvasRefs = [
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
    useRef<HTMLDivElement | null>(null),
  ];
  const readoutRefs = [
    useRef<HTMLSpanElement | null>(null),
    useRef<HTMLSpanElement | null>(null),
    useRef<HTMLSpanElement | null>(null),
    useRef<HTMLSpanElement | null>(null),
  ];
  const plotsRef = useRef<Array<uPlot | null>>([null, null, null, null]);
  const manualYRef = useRef<Array<[number, number] | null>>([null, null, null, null]);
  const [yZoomFlags, setYZoomFlags] = useState<[boolean, boolean, boolean, boolean]>([
    false,
    false,
    false,
    false,
  ]);

  const onZoomRef = useRef(onUserZoomRange);
  onZoomRef.current = onUserZoomRange;
  const onWheelZoomRef = useRef(onWheelZoomRange);
  onWheelZoomRef.current = onWheelZoomRange;
  const onResetZoomRef = useRef(onResetZoom);
  onResetZoomRef.current = onResetZoom;
  const yAutoRef = useRef(yAutoFit);
  yAutoRef.current = yAutoFit;

  const clearSingleYZoom = useCallback((idx: number) => {
    manualYRef.current[idx] = null;
    setYZoomFlags((prev) => {
      if (!prev[idx]) return prev;
      const next = [...prev] as [boolean, boolean, boolean, boolean];
      next[idx] = false;
      return next;
    });
    const p = plotsRef.current[idx];
    if (p) {
      const dataT = p.data[0] as unknown as Float64Array | undefined;
      if (dataT && dataT.length > 0) {
        const xMin = p.scales.x.min ?? 0;
        const xMax = p.scales.x.max ?? 10;
        const [lo, hi] = computeYRange(
          dataT,
          [p.data[1] as unknown as Float64Array, p.data[2] as unknown as Float64Array],
          xMin,
          xMax,
          CHANNEL_Y_OPTS[idx],
        );
        p.setScale('y', { min: lo, max: hi });
      }
    }
  }, []);

  const clearAllYZoom = useCallback(() => {
    manualYRef.current = [null, null, null, null];
    setYZoomFlags([false, false, false, false]);
    plotsRef.current.forEach((p, idx) => {
      if (!p) return;
      const dataT = p.data[0] as unknown as Float64Array | undefined;
      if (dataT && dataT.length > 0) {
        const xMin = p.scales.x.min ?? 0;
        const xMax = p.scales.x.max ?? 10;
        const [lo, hi] = computeYRange(
          dataT,
          [p.data[1] as unknown as Float64Array, p.data[2] as unknown as Float64Array],
          xMin,
          xMax,
          CHANNEL_Y_OPTS[idx],
        );
        p.setScale('y', { min: lo, max: hi });
      }
    });
  }, []);

  useEffect(() => {
    if (resetZoomToken > 0) {
      clearAllYZoom();
    }
  }, [resetZoomToken, clearAllYZoom]);

  useEffect(() => {
    if (equalizeToken > 0) {
      resetWeights();
    }
  }, [equalizeToken, resetWeights]);

  // Create uPlot instances for currently visible channels
  useEffect(() => {
    const sync = uPlot.sync('cmk-realtime');
    const colors = getThemeColors();
    const bottomSlotIdx = visibleSlots.length > 0 ? visibleSlots[visibleSlots.length - 1] : -1;

    const specs: Array<{
      title: string;
      unit: string;
      decimals: number;
      series: uPlot.Series[];
    }> = [
      {
        title: '位置 (rad)',
        unit: 'rad',
        decimals: 4,
        series: [
          { label: 't' },
          { label: '反馈', stroke: '#29b6f6', width: 1.8, points: { show: false } },
          { label: '参考', stroke: '#ef5350', width: 1.5, points: { show: false } },
        ],
      },
      {
        title: '速度 (rad/s)',
        unit: 'rad/s',
        decimals: 3,
        series: [
          { label: 't' },
          { label: '反馈', stroke: '#66bb6a', width: 1.8, points: { show: false } },
          { label: '参考', stroke: '#ffa726', width: 1.5, points: { show: false } },
        ],
      },
      {
        title: `${outName} (${outUnit})`,
        unit: outUnit,
        decimals: 3,
        series: [
          { label: 't' },
          { label: '指令', stroke: '#ef5350', width: 1.6, points: { show: false } },
          { label: '反馈', stroke: '#42a5f5', width: 1.8, points: { show: false } },
        ],
      },
      {
        title: '温度 (℃)',
        unit: '℃',
        decimals: 1,
        series: [
          { label: 't' },
          { label: '温度1', stroke: '#ffb74d', width: 1.7, points: { show: false } },
          { label: '温度2', stroke: '#ab47bc', width: 1.5, points: { show: false } },
        ],
      },
    ];

    const created: Array<uPlot | null> = [null, null, null, null];
    const observers: ResizeObserver[] = [];
    const cleanups: Array<() => void> = [];

    for (const idx of visibleSlots) {
      const hostEl = canvasRefs[idx].current;
      if (!hostEl) continue;
      hostEl.innerHTML = '';
      const spec = specs[idx];
      const yOpts = CHANNEL_Y_OPTS[idx];
      const isBottom = idx === bottomSlotIdx;
      const rect = hostEl.getBoundingClientRect();

      const opts: uPlot.Options = {
        width: Math.max(120, Math.floor(rect.width)),
        height: Math.max(54, Math.floor(rect.height)),
        padding: [6, 12, isBottom ? 8 : 2, 0],
        cursor: {
          sync: { key: sync.key },
          drag: { x: true, y: false },
        },
        legend: { show: false },
        scales: {
          x: { time: false, range: (_u, min, max) => nonNegativeTimeRange(min, max) },
          y: {
            auto: true,
            range: (u, initMin, initMax) => {
              const manual = manualYRef.current[idx];
              if (manual) {
                return manual;
              }
              if (!yAutoRef.current) {
                const curMin = u.scales.y.min;
                const curMax = u.scales.y.max;
                if (
                  curMin !== undefined &&
                  curMax !== undefined &&
                  Number.isFinite(curMin) &&
                  Number.isFinite(curMax)
                ) {
                  return [curMin, curMax];
                }
                if (Number.isFinite(initMin) && Number.isFinite(initMax)) {
                  return [initMin, initMax];
                }
              }
              const dataT = u.data[0] as unknown as Float64Array;
              if (!dataT || dataT.length === 0) {
                return yOpts.zeroSymmetric === false
                  ? [20, 20 + yOpts.minSpan]
                  : [-yOpts.minSpan / 2, yOpts.minSpan / 2];
              }
              const xMin = u.scales.x.min ?? 0;
              const xMax = u.scales.x.max ?? 10;
              return computeYRange(
                dataT,
                [u.data[1] as unknown as Float64Array, u.data[2] as unknown as Float64Array],
                xMin,
                xMax,
                yOpts,
              );
            },
          },
        },
        axes: [
          {
            label: '时间 (s)',
            labelSize: 14,
            labelFont: '600 10px system-ui, sans-serif',
            show: true,
            stroke: colors.axis,
            grid: { stroke: colors.grid, width: 1 },
            ticks: { stroke: colors.grid, width: 1, size: isBottom ? 4 : 2 },
            gap: isBottom ? 3 : 0,
            size: isBottom ? 40 : 24,
            values: isBottom ? formatTimeAxis : () => [],
            font: '10px Cascadia Mono, Consolas, monospace',
          },
          {
            label: spec.title,
            labelSize: 14,
            labelFont: '600 10px system-ui, sans-serif',
            size: 66,
            gap: 5,
            stroke: colors.axis,
            grid: { stroke: colors.grid, width: 1 },
            ticks: { stroke: colors.grid, width: 1 },
            values: (_u, vals) => vals.map(formatAxisTick),
            font: '10px Cascadia Mono, Consolas, monospace',
          },
        ],
        hooks: {
          setSelect: [
            (u) => {
              if (u.select.width > 4) {
                const min = u.posToVal(u.select.left, 'x');
                const max = u.posToVal(u.select.left + u.select.width, 'x');
                u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
                if (max > min) {
                  onZoomRef.current({ min, max });
                }
              }
            },
          ],
          setCursor: [
            (u) => {
              const roEl = readoutRefs[idx].current;
              if (!roEl) return;
              const cIdx = u.cursor.idx;
              const dataT = u.data[0] as unknown as ArrayLike<number> | undefined;
              const s1 = u.data[1] as unknown as ArrayLike<number> | undefined;
              const s2 = u.data[2] as unknown as ArrayLike<number> | undefined;
              if (!dataT || dataT.length === 0) {
                roEl.textContent = '';
                return;
              }
              const k = cIdx != null && cIdx >= 0 && cIdx < dataT.length ? cIdx : dataT.length - 1;
              const tv = dataT[k];
              const v1 = s1 ? s1[k] : Number.NaN;
              const v2 = s2 ? s2[k] : Number.NaN;
              const parts: string[] = [];
              if (cIdx != null && Number.isFinite(tv)) {
                parts.push(`t=${tv.toFixed(3)}s`);
              }
              if (Number.isFinite(v1)) {
                parts.push(`${spec.series[1].label}:${v1.toFixed(spec.decimals)}`);
              }
              if (Number.isFinite(v2)) {
                parts.push(`${spec.series[2].label}:${v2.toFixed(spec.decimals)}`);
              }
              roEl.textContent = parts.join('  ');
            },
          ],
        },
        series: spec.series,
      };

      const plot = new uPlot(opts, [[], [], []], hostEl);
      created[idx] = plot;

      const detach = attachPlotInteractions({
        slotEl: hostEl,
        plot,
        logX: false,
        onZoomX: (min, max) => {
          for (const peer of created) {
            peer?.setScale('x', { min, max });
          }
          if (onWheelZoomRef.current) {
            onWheelZoomRef.current({ min, max });
          } else {
            onZoomRef.current({ min, max });
          }
        },
        onZoomY: (min, max) => {
          manualYRef.current[idx] = [min, max];
          plot.setScale('y', { min, max });
          setYZoomFlags((prev) => {
            if (prev[idx]) return prev;
            const next = [...prev] as [boolean, boolean, boolean, boolean];
            next[idx] = true;
            return next;
          });
        },
        onResetY: () => {
          clearSingleYZoom(idx);
        },
        onResetAll: () => {
          clearAllYZoom();
          onResetZoomRef.current?.();
        },
      });
      cleanups.push(detach);

      const ro = new ResizeObserver((entries) => {
        const cr = entries[0]?.contentRect;
        if (cr && cr.width > 20 && cr.height > 20) {
          plot.setSize({ width: Math.floor(cr.width), height: Math.floor(cr.height) });
          for (const peer of created) {
            peer?.syncRect(true);
          }
        }
      });
      ro.observe(hostEl);
      observers.push(ro);
    }

    plotsRef.current = created;
    return () => {
      for (const fn of cleanups) fn();
      for (const ro of observers) ro.disconnect();
      for (const p of created) p?.destroy();
      plotsRef.current = [null, null, null, null];
    };
  }, [outName, outUnit, visibleKey, clearSingleYZoom, clearAllYZoom]);

  // Update curve data & viewport on 30Hz batch updates or visibility/window changes
  useEffect(() => {
    const plots = plotsRef.current;
    const firstPlot = plots.find((p) => p !== null);
    if (!firstPlot) return;

    if (ring.count === 0) {
      const empty: uPlot.AlignedData = [[], [], []];
      for (const p of plots) {
        if (p) {
          p.setData(empty, false);
          p.setScale('x', { min: 0, max: Math.max(1, windowSec || 10) });
        }
      }
      for (const r of readoutRefs) {
        if (r.current) r.current.textContent = '';
      }
      return;
    }

    // Columns: 0=t, 1=posRaw, 2=posMt, 3=vel, 4=outCmd, 5=outFb, 6=ref, 7=temp, 8=temp2
    const posCol = posMode === 'multi' ? 2 : 1;
    const [t, pos, vel, outCmd, outFb, ref, temp1, temp2] = ring.orderedColumns([
      0,
      posCol,
      3,
      4,
      5,
      6,
      7,
      8,
    ]);

    const nanArr = new Float64Array(t.length).fill(Number.NaN);
    const isPosRef = refTarget === 'pos' || refTarget === 'pos_single';
    const isVelRef = refTarget === 'vel';

    const d0: uPlot.AlignedData = [
      t,
      visibility.pos ? pos : nanArr,
      visibility.refPos && isPosRef ? ref : nanArr,
    ];
    const d1: uPlot.AlignedData = [
      t,
      visibility.vel ? vel : nanArr,
      visibility.refVel && isVelRef ? ref : nanArr,
    ];
    const d2: uPlot.AlignedData = [
      t,
      visibility.outCmd ? outCmd : nanArr,
      visibility.outFb ? outFb : nanArr,
    ];
    const d3: uPlot.AlignedData = [
      t,
      visibility.temp ? temp1 : nanArr,
      visibility.temp ? temp2 : nanArr,
    ];

    const datasets = [d0, d1, d2, d3];
    const tMax = t[t.length - 1] ?? 10;
    const tMin = t[0] ?? 0;

    let xLo = tMin;
    let xHi = Math.max(tMin + 1, tMax);
    if (customRange) {
      xLo = customRange.min;
      xHi = customRange.max;
    } else if (!frozen) {
      if (windowSec > 0) {
        xLo = Math.max(0, tMax - windowSec);
        xHi = Math.max(windowSec, tMax);
      }
    } else {
      const curMin = firstPlot.scales.x.min;
      const curMax = firstPlot.scales.x.max;
      if (curMin !== undefined && curMax !== undefined && curMax > curMin) {
        xLo = curMin;
        xHi = curMax;
      }
    }

    for (let i = 0; i < plots.length; i++) {
      const p = plots[i];
      if (!p) continue;
      p.batch(() => {
        p.setData(datasets[i], false);
        p.setScale('x', { min: xLo, max: xHi });
        const manualY = manualYRef.current[i];
        if (manualY) {
          p.setScale('y', { min: manualY[0], max: manualY[1] });
        }
      });
    }
  }, [
    ring,
    sampleVersion,
    posMode,
    refTarget,
    frozen,
    windowSec,
    customRange,
    yAutoFit,
    visibility,
    visibleKey,
  ]);

  const badges: Array<{
    swatches: Array<{ color: string; label: string; show: boolean }>;
  }> = [
    {
      swatches: [
        { color: '#29b6f6', label: '反馈', show: visibility.pos },
        {
          color: '#ef5350',
          label: '参考',
          show: visibility.refPos && (refTarget === 'pos' || refTarget === 'pos_single'),
        },
      ],
    },
    {
      swatches: [
        { color: '#66bb6a', label: '反馈', show: visibility.vel },
        { color: '#ffa726', label: '参考', show: visibility.refVel && refTarget === 'vel' },
      ],
    },
    {
      swatches: [
        { color: '#ef5350', label: '指令', show: visibility.outCmd },
        { color: '#42a5f5', label: '反馈', show: visibility.outFb },
      ],
    },
    {
      swatches: [
        { color: '#ffb74d', label: '温度1', show: visibility.temp },
        { color: '#ab47bc', label: '温度2', show: visibility.temp },
      ],
    },
  ];

  if (visibleSlots.length === 0) {
    return (
      <div className="chart-stack chart-empty-hint">
        已隐藏全部波形通道 — 点击左侧色块或「显示全部」恢复显示
      </div>
    );
  }

  return (
    <div ref={containerRef} className="chart-stack">
      {visibleSlots.map((slotIdx, visPos) => (
        <React.Fragment key={slotIdx}>
          {visPos > 0 && (
            <ChartRowSplitter
              active={draggingIdx === visPos - 1}
              onPointerDown={(e) => startRowResize(visPos - 1, e, visibleSlots)}
              onDoubleClick={resetWeights}
            />
          )}
          <div
            className="uplot-slot"
            style={{
              flexGrow: weights[slotIdx] ?? 1,
              flexShrink: 1,
              flexBasis: 0,
            }}
          >
            <div ref={canvasRefs[slotIdx]} className="uplot-canvas-host" />
            <div className="uplot-overlay-bar">
              {badges[slotIdx]?.swatches
                .filter((sw) => sw.show)
                .map((sw) => (
                  <span key={sw.label} className="uplot-legend-chip">
                    <i style={{ background: sw.color }} />
                    {sw.label}
                  </span>
                ))}
              <span ref={readoutRefs[slotIdx]} className="uplot-readout mono-num" />
              {yZoomFlags[slotIdx] && (
                <button
                  type="button"
                  className="uplot-zoom-pill"
                  onClick={() => clearSingleYZoom(slotIdx)}
                  title="恢复当前通道纵轴自动适配"
                >
                  复位 Y
                </button>
              )}
            </div>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};
