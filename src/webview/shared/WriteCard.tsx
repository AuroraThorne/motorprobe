import React, { useEffect, useState } from 'react';

export interface WriteCardProps {
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  value: number;
  appliedValue: number;
  disabled?: boolean;
  canZeroImmediate?: boolean;
  onChange: (val: number) => void;
  onApply: () => void;
  onZero: () => void;
}

const SLIDER_STEPS = 2000;

export const WriteCard: React.FC<WriteCardProps> = ({
  label,
  unit,
  min,
  max,
  step,
  decimals = 3,
  value,
  appliedValue,
  disabled = false,
  canZeroImmediate = false,
  onChange,
  onApply,
  onZero,
}) => {
  const [text, setText] = useState(() => value.toFixed(decimals));

  useEffect(() => {
    setText(Number(value.toFixed(decimals)).toString());
  }, [value, decimals]);

  const isPending = Math.abs(value - appliedValue) > 1e-9;
  const span = max - min;
  const sliderPos = span > 0 ? Math.round(((value - min) / span) * SLIDER_STEPS) : 0;

  const clampVal = (v: number): number => Math.max(min, Math.min(max, v));

  const commitInput = (raw: string): void => {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) {
      onChange(clampVal(parsed));
    } else {
      setText(Number(value.toFixed(decimals)).toString());
    }
  };

  return (
    <div className={`write-card ${isPending ? 'pending' : ''}`}>
      <div className="write-top">
        <div className="write-title-group">
          <span
            className={`write-dot ${isPending ? 'pending' : Math.abs(appliedValue) > 1e-9 ? 'applied' : ''}`}
            title={isPending ? '已修改，按回车或点应用生效' : '已同步'}
          />
          <span className="value-name">{label}</span>
          {unit && <span className="unit-pill">{unit}</span>}
        </div>
        <div className="write-controls">
          <button
            type="button"
            className="step-btn"
            disabled={disabled}
            onClick={() => onChange(clampVal(Number((value - step).toFixed(decimals + 2))))}
            title={`-${step}`}
          >
            −
          </button>
          <input
            type="text"
            inputMode="decimal"
            className="write-num-input mono-num"
            disabled={disabled}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => commitInput(text)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const parsed = parseFloat(text);
                if (Number.isFinite(parsed)) {
                  onChange(clampVal(parsed));
                  setTimeout(onApply, 0);
                }
              }
            }}
          />
          <button
            type="button"
            className="step-btn"
            disabled={disabled}
            onClick={() => onChange(clampVal(Number((value + step).toFixed(decimals + 2))))}
            title={`+${step}`}
          >
            +
          </button>
          <button
            type="button"
            className="step-btn"
            disabled={disabled && !canZeroImmediate}
            onClick={onZero}
            title="置零（输出中立即生效）"
          >
            0
          </button>
        </div>
      </div>
      <div className="write-bottom">
        <span className="write-bound mono-num">{Number(min.toPrecision(4))}</span>
        <input
          type="range"
          min={0}
          max={SLIDER_STEPS}
          value={Math.max(0, Math.min(SLIDER_STEPS, sliderPos))}
          disabled={disabled}
          className="write-slider"
          onChange={(e) => {
            const idx = Number(e.target.value);
            const next = min + (span * idx) / SLIDER_STEPS;
            onChange(Number(next.toFixed(decimals)));
          }}
        />
        <span className="write-bound mono-num">{Number(max.toPrecision(4))}</span>
      </div>
    </div>
  );
};
