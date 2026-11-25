import React, { useCallback, useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import { loadSavedUiState, saveUiState } from '../shared/vscodeApi';

export function formatAxisTick(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs < 1e-12) return '0';
  if (abs >= 10000 || abs < 0.001) return v.toExponential(1);
  if (abs >= 100) return Number(v.toFixed(1)).toString();
  if (abs >= 1) return Number(v.toFixed(3)).toString();
  return Number(v.toFixed(4)).toString();
}

export function nonNegativeTimeRange(min: number, max: number): [number, number] {
  const rawMin = Number.isFinite(min) ? min : 0;
  const rawMax = Number.isFinite(max) ? max : rawMin + 1;
  const span = Math.max(1e-4, rawMax - rawMin);
  const safeMin = Math.max(0, rawMin);
  return [safeMin, rawMax <= 0 || rawMin < 0 ? safeMin + span : Math.max(safeMin + 1e-4, rawMax)];
}

function normalizeWeights(raw: unknown, count: number): number[] {
  if (!Array.isArray(raw) || raw.length !== count) {
    return new Array<number>(count).fill(1);
  }
  const nums = raw.map((x) => {
    const v = Number(x);
    return Number.isFinite(v) && v > 0.05 ? v : 1;
  });
  const sum = nums.reduce((a, b) => a + b, 0);
  if (sum <= 0) return new Array<number>(count).fill(1);
  return nums.map((v) => (v / sum) * count);
}

export function useRowWeights(storageKey: string, count: number) {
  const [weights, setWeights] = useState<number[]>(() => {
    const saved = loadSavedUiState<Record<string, unknown>>({});
    return normalizeWeights(saved[storageKey], count);
  });
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const weightsRef = useRef(weights);
  weightsRef.current = weights;

  useEffect(() => {
    setWeights((prev) => (prev.length === count ? prev : normalizeWeights(prev, count)));
  }, [count]);

  const resetWeights = useCallback(() => {
    const eq = new Array<number>(count).fill(1);
    setWeights(eq);
    saveUiState({ [storageKey]: eq });
  }, [count, storageKey]);

  const startRowResize = useCallback(
    (splitterIdx: number, e: React.PointerEvent, visibleIndices?: number[]) => {
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      const slots = Array.from(container.querySelectorAll<HTMLElement>(':scope > .uplot-slot'));
      const chIndices = visibleIndices ?? slots.map((_, i) => i);
      if (
        splitterIdx < 0 ||
        splitterIdx + 1 >= slots.length ||
        slots.length !== chIndices.length
      ) {
        return;
      }

      e.preventDefault();
      const startY = e.clientY;
      const startHeights = slots.map((el) => Math.max(24, el.getBoundingClientRect().height));
      const startWeights = [...weightsRef.current];
      const sumVisWeight =
        chIndices.reduce((acc, idx) => acc + (startWeights[idx] ?? 1), 0) || chIndices.length;
      const pairSum = startHeights[splitterIdx] + startHeights[splitterIdx + 1];
      const minH = Math.min(48, Math.max(28, Math.floor(pairSum * 0.2)));

      setDraggingIdx(splitterIdx);
      document.body.classList.add('cmk-resizing-rows');

      const onMove = (me: PointerEvent) => {
        const dy = me.clientY - startY;
        const nextTop = Math.max(minH, Math.min(pairSum - minH, startHeights[splitterIdx] + dy));
        const nextBot = pairSum - nextTop;
        const nextH = [...startHeights];
        nextH[splitterIdx] = nextTop;
        nextH[splitterIdx + 1] = nextBot;
        const totalPx = nextH.reduce((a, b) => a + b, 0) || 1;
        const nextW = [...startWeights];
        for (let k = 0; k < chIndices.length; k++) {
          nextW[chIndices[k]] = (nextH[k] / totalPx) * sumVisWeight;
        }
        setWeights(nextW);
      };

      const onUp = () => {
        setDraggingIdx(null);
        document.body.classList.remove('cmk-resizing-rows');
        saveUiState({ [storageKey]: weightsRef.current });
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [storageKey],
  );

  const isCustomWeights = weights.some((w) => Math.abs(w - 1) > 0.02);

  return {
    weights,
    draggingIdx,
    containerRef,
    startRowResize,
    resetWeights,
    isCustomWeights,
  };
}

export const ChartRowSplitter: React.FC<{
  active: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
}> = ({ active, onPointerDown, onDoubleClick }) => (
  <div
    className={`chart-row-splitter ${active ? 'dragging' : ''}`}
    onPointerDown={onPointerDown}
    onDoubleClick={onDoubleClick}
    title="上下拖动调整相邻波形窗口高度（双击恢复等高均分）"
  />
);

export interface PlotInteractionOptions {
  slotEl: HTMLElement;
  plot: uPlot;
  logX?: boolean;
  onZoomX?: (min: number, max: number) => void;
  onZoomY?: (min: number, max: number) => void;
  onResetY?: () => void;
  onResetAll?: () => void;
}

/**
 * Attaches cursor-centered mouse wheel zoom (X+Y on canvas, Y-only on left axis,
 * X-only on bottom axis), right/middle-button pan, and double-click reset to a uPlot instance.
 */
export function attachPlotInteractions(opts: PlotInteractionOptions): () => void {
  const { slotEl, plot, logX = false, onZoomX, onZoomY, onResetY, onResetAll } = opts;

  const applyX = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
    if (!logX) {
      const span = Math.max(1e-4, max - min);
      if (max <= 0 || min < 0) {
        min = 0;
        max = span;
      }
    }
    if (onZoomX) {
      onZoomX(min, max);
    } else {
      plot.setScale('x', { min, max });
    }
  };

  const applyY = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
    if (onZoomY) {
      onZoomY(min, max);
    } else {
      plot.setScale('y', { min, max });
    }
  };

  const onWheel = (e: WheelEvent): void => {
    const overRect = plot.over.getBoundingClientRect();
    if (overRect.width < 10 || overRect.height < 10) return;

    e.preventDefault();
    e.stopPropagation();

    const inLeftAxis = e.clientX < overRect.left;
    const inBottomAxis = e.clientY > overRect.bottom && e.clientX >= overRect.left;

    const doX = inLeftAxis ? false : inBottomAxis ? true : !e.altKey;
    const doY = inBottomAxis ? false : inLeftAxis ? true : !e.shiftKey;

    const rawDelta = e.deltaMode === 1 ? e.deltaY * 24 : e.deltaY;
    const clamped = Math.max(-160, Math.min(160, rawDelta));
    const factor = Math.exp(clamped * 0.0016);

    plot.batch(() => {
      if (doX) {
        const xMin = plot.scales.x.min;
        const xMax = plot.scales.x.max;
        if (xMin !== undefined && xMax !== undefined && Number.isFinite(xMin) && Number.isFinite(xMax) && xMax > xMin) {
          const relX = Math.max(0, Math.min(overRect.width, e.clientX - overRect.left));
          const anchorX = plot.posToVal(relX, 'x');
          if (logX && xMin > 0 && xMax > 0 && anchorX > 0) {
            const lMin = Math.log10(xMin);
            const lMax = Math.log10(xMax);
            const lAnc = Math.log10(anchorX);
            const nlMin = lAnc - (lAnc - lMin) * factor;
            const nlMax = lAnc + (lMax - lAnc) * factor;
            if (nlMax - nlMin >= 0.02 && nlMax - nlMin <= 8) {
              applyX(Math.pow(10, nlMin), Math.pow(10, nlMax));
            }
          } else {
            const nxMin = anchorX - (anchorX - xMin) * factor;
            const nxMax = anchorX + (xMax - anchorX) * factor;
            const span = nxMax - nxMin;
            if (span >= 1e-4 && span <= 1e6) {
              applyX(nxMin, nxMax);
            }
          }
        }
      }

      if (doY) {
        const yMin = plot.scales.y.min;
        const yMax = plot.scales.y.max;
        if (yMin !== undefined && yMax !== undefined && Number.isFinite(yMin) && Number.isFinite(yMax) && yMax > yMin) {
          const relY = Math.max(0, Math.min(overRect.height, e.clientY - overRect.top));
          const anchorY = plot.posToVal(relY, 'y');
          const nyMin = anchorY - (anchorY - yMin) * factor;
          const nyMax = anchorY + (yMax - anchorY) * factor;
          const span = nyMax - nyMin;
          if (span >= 1e-6 && span <= 1e8) {
            applyY(nyMin, nyMax);
          }
        }
      }
    });
  };

  let panning = false;
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 1 && e.button !== 2) return;
    const overRect = plot.over.getBoundingClientRect();
    if (overRect.width < 10 || overRect.height < 10) return;

    const sXMin = plot.scales.x.min;
    const sXMax = plot.scales.x.max;
    const sYMin = plot.scales.y.min;
    const sYMax = plot.scales.y.max;
    if (
      sXMin === undefined ||
      sXMax === undefined ||
      sYMin === undefined ||
      sYMax === undefined
    ) {
      return;
    }

    e.preventDefault();
    panning = true;
    const startX = e.clientX;
    const startY = e.clientY;
    plot.over.style.cursor = 'grabbing';

    const onMove = (me: PointerEvent) => {
      if (!panning) return;
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;

      plot.batch(() => {
        if (logX && sXMin > 0 && sXMax > 0) {
          const lMin = Math.log10(sXMin);
          const lMax = Math.log10(sXMax);
          const dLog = -(dx / overRect.width) * (lMax - lMin);
          applyX(Math.pow(10, lMin + dLog), Math.pow(10, lMax + dLog));
        } else {
          const dValX = -(dx / overRect.width) * (sXMax - sXMin);
          applyX(sXMin + dValX, sXMax + dValX);
        }

        const dValY = (dy / overRect.height) * (sYMax - sYMin);
        applyY(sYMin + dValY, sYMax + dValY);
      });
    };

    const onUp = () => {
      panning = false;
      plot.over.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  const onDblClick = (e: MouseEvent): void => {
    const overRect = plot.over.getBoundingClientRect();
    if (e.clientX < overRect.left) {
      onResetY?.();
    } else {
      onResetAll?.();
    }
  };

  slotEl.addEventListener('wheel', onWheel, { passive: false });
  slotEl.addEventListener('dblclick', onDblClick);
  plot.over.addEventListener('pointerdown', onPointerDown);
  plot.over.addEventListener('contextmenu', onContextMenu);

  return () => {
    slotEl.removeEventListener('wheel', onWheel);
    slotEl.removeEventListener('dblclick', onDblClick);
    plot.over.removeEventListener('pointerdown', onPointerDown);
    plot.over.removeEventListener('contextmenu', onContextMenu);
  };
}
