import React, { useMemo, useState } from 'react';
import { SAMPLE_COLS } from '../../shared/protocol';
import { ColumnRingBuffer } from '../shared/ringBuffer';
import { postToHost } from '../shared/vscodeApi';

interface ExportCsvModalProps {
  ring: ColumnRingBuffer;
  outUnit: string;
  onClose: () => void;
}

const SERIES_META = [
  { col: 1, key: 'pos_raw', label: '单圈原始位置 (rad)' },
  { col: 2, key: 'pos_mt', label: '多圈累计位置 (rad)' },
  { col: 3, key: 'vel', label: '输出轴速度 (rad/s)' },
  { col: 4, key: 'out_cmd', label: '输出指令' },
  { col: 5, key: 'out_fb', label: '输出反馈' },
  { col: 6, key: 'ref', label: '测试/闭环参考' },
  { col: 7, key: 'temp1', label: '温度 1 (℃)' },
  { col: 8, key: 'temp2', label: '温度 2 (℃)' },
];

export const ExportCsvModal: React.FC<ExportCsvModalProps> = ({ ring, outUnit, onClose }) => {
  const bounds = useMemo(() => ring.timeBounds(), [ring]);
  const [fileName, setFileName] = useState('motorprobe_curve');
  const [selected, setSelected] = useState<Record<number, boolean>>({
    1: true,
    2: true,
    3: true,
    4: true,
    5: true,
    6: true,
    7: true,
  });
  const [fromRatio, setFromRatio] = useState(0);
  const [toRatio, setToRatio] = useState(1);

  const tStart = bounds.min + (bounds.max - bounds.min) * Math.min(fromRatio, toRatio);
  const tEnd = bounds.min + (bounds.max - bounds.min) * Math.max(fromRatio, toRatio);

  const handleExport = (): void => {
    const activeCols = [0, ...SERIES_META.filter((m) => selected[m.col]).map((m) => m.col)];
    const colsData = ring.orderedColumns(activeCols);
    const tCol = colsData[0];
    const header = activeCols.map((ci) => {
      const name = SAMPLE_COLS[ci];
      return name === 'outCmd' || name === 'outFb' ? `${name}[${outUnit}]` : name;
    });
    const lines: string[] = ['\ufeff' + header.join(',')];
    for (let i = 0; i < tCol.length; i++) {
      if (tCol[i] < tStart || tCol[i] > tEnd) continue;
      const row = colsData.map((arr) => {
        const v = arr[i];
        return Number.isNaN(v) ? '' : Number(v.toPrecision(7)).toString();
      });
      lines.push(row.join(','));
    }
    postToHost({
      type: 'saveFile',
      defaultName: `${fileName.trim() || 'curve'}.csv`,
      filterName: 'CSV 数据',
      extensions: ['csv'],
      content: lines.join('\n'),
    });
    onClose();
  };

  return (
    <div className="ep-overlay" onClick={onClose}>
      <div className="ep-modal" onClick={(e) => e.stopPropagation()}>
        <h3>导出波形历史 CSV</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="text"
            className="ep-input"
            style={{ flex: 1 }}
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            placeholder="文件名"
          />
          <span style={{ color: 'var(--vscode-descriptionForeground)' }}>.csv</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="sub-heading" style={{ margin: 0 }}>
            导出通道选择
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="ep-btn ghost mini"
              onClick={() =>
                setSelected(Object.fromEntries(SERIES_META.map((m) => [m.col, true])))
              }
            >
              全选
            </button>
            <button
              type="button"
              className="ep-btn ghost mini"
              onClick={() =>
                setSelected((prev) =>
                  Object.fromEntries(SERIES_META.map((m) => [m.col, !prev[m.col]])),
                )
              }
            >
              反选
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
            padding: 8,
            border: '1px solid var(--vscode-widget-border)',
            borderRadius: 4,
          }}
        >
          {SERIES_META.map((m) => (
            <label key={m.col} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={Boolean(selected[m.col])}
                onChange={(e) => setSelected((prev) => ({ ...prev, [m.col]: e.target.checked }))}
              />
              <span>{m.label}</span>
            </label>
          ))}
        </div>

        <div
          style={{
            padding: '8px 10px',
            border: '1px solid var(--vscode-widget-border)',
            borderRadius: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }} className="mono-num">
            <span>时间范围裁剪</span>
            <span>
              {tStart.toFixed(2)} s ~ {tEnd.toFixed(2)} s（总缓存 {ring.count} 点）
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 10 }}>起点</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={fromRatio}
              className="write-slider"
              onChange={(e) => setFromRatio(Number(e.target.value))}
            />
            <span style={{ fontSize: 10 }}>终点</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={toRatio}
              className="write-slider"
              onChange={(e) => setToRatio(Number(e.target.value))}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="ep-btn secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ep-btn" onClick={handleExport} disabled={ring.count === 0}>
            保存 CSV
          </button>
        </div>
      </div>
    </div>
  );
};
