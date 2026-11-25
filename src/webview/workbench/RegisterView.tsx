import React, { useEffect, useMemo, useState } from 'react';
import { REG_BY_NAME, REG_BY_RID, REGISTERS, SRC_TEXT, TYPE_TXT } from '../../shared/registers';
import { consumeImportedRegs, useClientStore } from '../shared/clientStore';
import { PillSwitch } from '../shared/NoticeBanner';
import { postEngine, postToHost } from '../shared/vscodeApi';

export const RegisterView: React.FC = () => {
  const { state, regValues, importedRegs } = useClientStore();
  const [familyOnly, setFamilyOnly] = useState(true);
  const [search, setSearch] = useState('');
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [showIdModal, setShowIdModal] = useState(false);
  const [newMotorId, setNewMotorId] = useState(1);
  const [newMasterHex, setNewMasterHex] = useState('0');

  const drv = state?.driver ?? null;
  const hasRegs = Boolean(drv?.caps.registers);
  const blocked = Boolean(state?.blocked);

  useEffect(() => {
    setEdits({});
    if (drv) {
      setNewMotorId(drv.motorId);
      setNewMasterHex(drv.masterId >= 0 ? drv.masterId.toString(16).toUpperCase() : '0');
    }
  }, [drv?.title]);

  useEffect(() => {
    if (!importedRegs) return;
    const patch: Record<number, string> = {};
    for (const [k, v] of Object.entries(importedRegs)) {
      const byName = REG_BY_NAME.get(k);
      const rid = byName ? byName.rid : k.startsWith('0x') ? parseInt(k, 16) : parseInt(k, 10);
      const reg = REG_BY_RID.get(rid);
      if (reg && !reg.ro && Number.isFinite(Number(v))) {
        patch[rid] = String(v);
      }
    }
    setEdits((prev) => ({ ...prev, ...patch }));
    consumeImportedRegs();
  }, [importedRegs]);

  const visibleRegs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return REGISTERS.filter((r) => {
      if (familyOnly && drv?.family && drv.family !== 'both' && r.src !== 'both' && r.src !== drv.family) {
        return false;
      }
      if (!q) return true;
      const hex = `0x${r.rid.toString(16).padStart(2, '0')}`;
      return (
        hex.includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.alt.toLowerCase().includes(q) ||
        r.desc.toLowerCase().includes(q)
      );
    });
  }, [familyOnly, drv?.family, search]);

  const handleReadAll = (): void => {
    postEngine({ type: 'readAllRegs', rids: visibleRegs.map((r) => r.rid) });
  };

  const handleWriteModified = (): void => {
    for (const [ridStr, raw] of Object.entries(edits)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const num = Number(trimmed);
      if (Number.isFinite(num)) {
        postEngine({ type: 'writeReg', rid: Number(ridStr), value: num });
      }
    }
  };

  const handleExportJson = (): void => {
    const out: Record<string, number> = {};
    for (const r of REGISTERS) {
      const entry = regValues[r.rid];
      if (entry && entry.value !== null) {
        out[r.name] = entry.value;
      }
    }
    postToHost({
      type: 'saveFile',
      defaultName: `${drv?.model ?? 'motor'}_id${drv?.motorId ?? 1}_regs.json`,
      filterName: 'JSON 参数文件',
      extensions: ['json'],
      content: JSON.stringify(out, null, 2),
    });
  };

  const lim = state?.limits;
  const modifiedCount = Object.values(edits).filter((v) => v.trim() !== '').length;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 14px', gap: 10 }}>
      {/* Connection & Limits Hero Summary */}
      <div className="motor-hero-banner">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div className="motor-hero-title">
            {drv ? `${drv.protocolName} · ${drv.model}` : '未选择电机'}
          </div>
          <div className="motor-hero-sub">
            {!drv
              ? '请先在左侧边栏连接总线并选择一台电机'
              : hasRegs
                ? `电机控制帧 ID: ${drv.motorId}  |  反馈 Master ID: 0x${drv.masterId.toString(16).toUpperCase()}  |  ${drv.note || ''}`
                : `电调 ID: ${drv.motorId}  |  反馈 0x${drv.fbId.toString(16).toUpperCase().padStart(3, '0')}  |  控制帧 0x${(drv.ctrlId ?? 0x200).toString(16).toUpperCase().padStart(3, '0')} 第 ${(drv.ctrlSlot ?? 0) + 1} 槽  |  减速比 ${Number((drv.gr ?? 1).toPrecision(6))}`}
          </div>
          {drv && hasRegs && lim && (
            <div
              className="mono-num"
              style={{
                fontSize: 11.5,
                color: state?.limitsOk ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-errorForeground)',
              }}
            >
              量程：p ±{Number(lim.pMax.toPrecision(7))} rad，v ±{Number(lim.vMax.toPrecision(7))} rad/s，t ±
              {Number(lim.tMax.toPrecision(7))} Nm，kp 0~{lim.kpMax}，kd 0~{lim.kdMax}（
              {state?.limitsOk ? '来自电机实读' : '未读取，禁止使能'}）
            </div>
          )}
        </div>
        {state && state.queueCount > 0 && (
          <span className="ep-tag accent mono-num">队列请求: {state.queueCount}</span>
        )}
      </div>

      {!hasRegs ? (
        <div className="chart-box" style={{ justifyContent: 'center', alignItems: 'center', color: 'var(--vscode-descriptionForeground)' }}>
          {drv
            ? '当前大疆电调协议无 0x7FF 参数寄存器表（电调 ID 与电流环开关请通过拨码开关或 RoboMaster Assistant 配置）。'
            : '选择达妙 DM 或 HM 关节电机后，可在此读写 0x00~0x51 全部寄存器并保存到 Flash。'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <button type="button" className="ep-btn" onClick={handleReadAll}>
              全部读取 ({visibleRegs.length})
            </button>
            <button
              type="button"
              className="ep-btn secondary"
              disabled={blocked || modifiedCount === 0}
              onClick={handleWriteModified}
              title={blocked ? '电机使能中禁止写寄存器' : ''}
            >
              写入已修改 ({modifiedCount})
            </button>
            <button
              type="button"
              className="ep-btn secondary"
              disabled={blocked}
              onClick={() => postEngine({ type: 'saveRegs' })}
              title="发送 AA 01 保存至 Flash（擦写寿命约 1 万次，仅失能有效）"
            >
              保存到 Flash
            </button>
            <button
              type="button"
              className="ep-btn ghost"
              disabled={blocked}
              onClick={() => postEngine({ type: 'reloadLimits' })}
            >
              重读量程
            </button>
            <button
              type="button"
              className="ep-btn ghost"
              disabled={blocked}
              onClick={() => setShowIdModal(true)}
            >
              修改 ID…
            </button>
            <button type="button" className="ep-btn ghost" onClick={handleExportJson}>
              导出 JSON
            </button>
            <button
              type="button"
              className="ep-btn ghost"
              onClick={() => postToHost({ type: 'pickImportJson' })}
            >
              导入 JSON
            </button>

            <input
              type="search"
              className="ep-input"
              style={{ width: 170, marginLeft: 'auto' }}
              placeholder="搜索 RID / 名称 / 说明…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5 }}>
              <PillSwitch checked={familyOnly} onChange={setFamilyOnly} />
              <span>仅当前家族</span>
            </label>
          </div>

          <div className="reg-table-wrap">
            <table className="reg-table">
              <thead>
                <tr>
                  <th>RID</th>
                  <th>名称</th>
                  <th>来源</th>
                  <th>类型</th>
                  <th>当前实读值</th>
                  <th>新值 (回车单写)</th>
                  <th>应答</th>
                  <th>功能说明</th>
                </tr>
              </thead>
              <tbody>
                {visibleRegs.map((r) => {
                  const rec = regValues[r.rid];
                  const editStr = edits[r.rid] ?? '';
                  const isMod = editStr.trim() !== '';
                  const fmtVal =
                    rec && rec.value !== null
                      ? r.typ === 'f'
                        ? Number(rec.value.toPrecision(7)).toString()
                        : String(Math.trunc(rec.value))
                      : '';
                  return (
                    <tr key={r.rid} className={isMod ? 'modified' : ''}>
                      <td className="mono-num">0x{r.rid.toString(16).toUpperCase().padStart(2, '0')}</td>
                      <td className="mono-num" style={{ fontWeight: 600 }}>
                        {r.name}
                        {r.alt && r.alt.toLowerCase() !== r.name ? (
                          <span style={{ color: 'var(--vscode-descriptionForeground)', fontWeight: 400 }}>
                            {' '}
                            ({r.alt})
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className="ep-tag">{SRC_TEXT[r.src]}</span>
                      </td>
                      <td className="mono-num" style={{ color: 'var(--vscode-descriptionForeground)' }}>
                        {TYPE_TXT[r.typ]}
                        {r.ro ? ' · 只读' : ''}
                      </td>
                      <td
                        className="mono-num"
                        style={{ color: 'var(--vscode-symbolIcon-numberForeground, #b5cea8)', fontWeight: 600 }}
                      >
                        {fmtVal}
                      </td>
                      <td>
                        {r.ro ? (
                          <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 10.5 }}>只读保护</span>
                        ) : (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <input
                              type="text"
                              className="ep-input mono-num"
                              style={{ width: 96, padding: '1px 5px' }}
                              disabled={blocked}
                              value={editStr}
                              placeholder={fmtVal || '输入新值'}
                              onChange={(e) => setEdits((p) => ({ ...p, [r.rid]: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && editStr.trim()) {
                                  const v = Number(editStr.trim());
                                  if (Number.isFinite(v)) {
                                    postEngine({ type: 'writeReg', rid: r.rid, value: v });
                                    setEdits((p) => ({ ...p, [r.rid]: '' }));
                                  }
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="ep-btn ghost mini"
                              onClick={() => postEngine({ type: 'readReg', rid: r.rid })}
                              title="单独读取该寄存器"
                            >
                              读
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        {rec?.status === 'ok' && (
                          <span style={{ color: 'var(--vscode-testing-iconPassed)', fontWeight: 600 }}>有应答</span>
                        )}
                        {rec?.status === 'timeout' && (
                          <span style={{ color: 'var(--vscode-errorForeground)' }}>无应答</span>
                        )}
                        {rec?.status === 'error' && (
                          <span style={{ color: 'var(--vscode-errorForeground)' }}>{rec.error}</span>
                        )}
                      </td>
                      <td style={{ color: 'var(--vscode-descriptionForeground)' }}>
                        {r.desc}
                        {r.unit ? ` [${r.unit}]` : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {showIdModal && (
        <div className="ep-overlay" onClick={() => setShowIdModal(false)}>
          <div className="ep-modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3>修改电机 CAN ID 与反馈 Master ID</h3>
            <p style={{ margin: 0, fontSize: 11.5, color: 'var(--vscode-descriptionForeground)' }}>
              将依次写入 0x07 (Master ID)、0x08 (电机 ID) 并发送 AA 01 保存至 Flash。修改后请给电机断电重启并重新扫描总线。
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, alignItems: 'center' }}>
              <span>新电机 ID (1~127)</span>
              <input
                type="number"
                className="ep-input mono-num"
                min={1}
                max={127}
                value={newMotorId}
                onChange={(e) => setNewMotorId(Math.max(1, Math.min(127, Number(e.target.value) || 1)))}
              />
              <span>新 Master ID (hex)</span>
              <input
                type="text"
                className="ep-input mono-num"
                value={newMasterHex}
                onChange={(e) => setNewMasterHex(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="ep-btn secondary" onClick={() => setShowIdModal(false)}>
                取消
              </button>
              <button
                type="button"
                className="ep-btn"
                onClick={() => {
                  const mst = parseInt(newMasterHex.trim(), 16);
                  if (Number.isFinite(mst) && mst >= 0 && mst <= 0x7fe) {
                    postEngine({ type: 'changeMotorIds', newMotorId, newMasterId: mst });
                    setShowIdModal(false);
                    postEngine({ type: 'selectMotor', spec: null });
                  }
                }}
              >
                确认写入并保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
