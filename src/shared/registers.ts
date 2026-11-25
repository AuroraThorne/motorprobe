export type RegType = 'f' | 'u' | 'i';
export type RegSource = 'both' | 'dm' | 'hm';

export interface RegisterDef {
  rid: number;
  name: string;
  typ: RegType;
  desc: string;
  ro: boolean;
  unit: string;
  src: RegSource;
  alt: string;
}

export const SRC_TEXT: Record<RegSource, string> = {
  both: '两家都有',
  dm: '仅达妙',
  hm: '仅 HM',
};

export const TYPE_TXT: Record<RegType, string> = {
  f: 'float',
  u: 'uint32',
  i: 'int32',
};

function R(
  rid: number,
  name: string,
  typ: RegType,
  desc: string,
  opts: { ro?: boolean; unit?: string; src?: RegSource; alt?: string } = {},
): RegisterDef {
  return {
    rid,
    name,
    typ,
    desc,
    ro: opts.ro ?? false,
    unit: opts.unit ?? '',
    src: opts.src ?? 'both',
    alt: opts.alt ?? '',
  };
}

export const REGISTERS: readonly RegisterDef[] = [
  R(0x00, 'uv_value', 'f', '欠压保护值', { unit: 'V', alt: 'UV_Value' }),
  R(0x01, 'kt', 'f', '扭矩系数', { alt: 'KT_Value' }),
  R(0x02, 'temp_max', 'f', '过温保护值', { unit: '℃', alt: 'OT_Value' }),
  R(0x03, 'i_fw_max', 'f', '过流/持续电流保护（达妙为百分比）', { alt: 'OC_Value' }),
  R(0x04, 'acc', 'f', '加速度（非 MIT 模式）', { unit: 'krad/s²', src: 'dm', alt: 'ACC' }),
  R(0x05, 'dec', 'f', '减速度（非 MIT 模式）', { unit: 'krad/s²', src: 'dm', alt: 'DEC' }),
  R(0x06, 'max_spd', 'f', '转子限速', { unit: 'rad/s', src: 'dm', alt: 'MAX_SPD' }),
  R(0x07, 'can_master', 'u', '反馈 ID (Master ID)', { alt: 'MST_ID' }),
  R(0x08, 'can_id', 'u', '接收 ID (电机 ID)', { alt: 'ESC_ID' }),
  R(0x09, 'can_timeout', 'u', '通信超时（0 关闭；达妙单位 50 µs，仅使能时生效）', { alt: 'TIMEOUT' }),
  R(0x0a, 'ctrl_mode', 'u', '控制模式 1 MIT/2 位置速度/3 速度/4 力位（本软件只读）', {
    ro: true,
    src: 'dm',
    alt: 'CTRL_MODE',
  }),
  R(0x0b, 'damp', 'f', '电机粘滞系数', { alt: 'Damp' }),
  R(0x0c, 'inertia', 'f', '电机转动惯量', { alt: 'Inertia' }),
  R(0x0d, 'motor_type', 'i', 'HM 电机型号 / 达妙硬件版本', { ro: true, alt: 'hw_ver' }),
  R(0x0e, 'config_version', 'i', 'HM 软件版本 / 达妙软件版本', { ro: true, alt: 'sw_ver' }),
  R(0x0f, 'sn', 'u', '序列号', { ro: true, src: 'dm', alt: 'SN' }),
  R(0x10, 'ppairs', 'i', '电机极对数（标定值）', { ro: true, alt: 'NPP' }),
  R(0x11, 'r_nominal', 'f', '相电阻（标定值）', { ro: true, unit: 'Ω', alt: 'Rs' }),
  R(0x12, 'ls', 'f', '相电感（标定值）', { ro: true, unit: 'H', alt: 'LS' }),
  R(0x13, 'flux', 'f', '磁链（标定值）', { ro: true, unit: 'Wb', alt: 'Flux' }),
  R(0x14, 'gr', 'f', '减速比（切勿修改）', { ro: true, alt: 'Gr' }),
  R(0x15, 'p_max', 'f', '位置映射范围', { unit: 'rad', alt: 'PMAX' }),
  R(0x16, 'v_max', 'f', '速度映射范围', { unit: 'rad/s', alt: 'VMAX' }),
  R(0x17, 't_max', 'f', '扭矩映射范围', { unit: 'Nm', alt: 'TMAX' }),
  R(0x18, 'i_bw', 'f', '电流环带宽', { unit: 'Hz', alt: 'I_BW' }),
  R(0x19, 'kp_asr', 'f', '速度环 Kp（非 MIT 模式）', { src: 'dm', alt: 'KP_ASR' }),
  R(0x1a, 'ki_asr', 'f', '速度环 Ki', { src: 'dm', alt: 'KI_ASR' }),
  R(0x1b, 'kp_apr', 'f', '位置环 Kp', { src: 'dm', alt: 'KP_APR' }),
  R(0x1c, 'ki_apr', 'f', '位置环 Ki', { src: 'dm', alt: 'KI_APR' }),
  R(0x1d, 'ov_value', 'f', '过压保护值', { unit: 'V', alt: 'OV_Value' }),
  R(0x1e, 'gref', 'f', '齿轮力矩效率', { src: 'dm', alt: 'GREF' }),
  R(0x1f, 'deta', 'f', '速度环阻尼系数', { src: 'dm', alt: 'Deta' }),
  R(0x20, 'v_bw', 'f', '速度环滤波带宽', { src: 'dm', alt: 'V_BW' }),
  R(0x21, 'iq_c1', 'f', '电流环增强系数', { src: 'dm', alt: 'IQ_c1' }),
  R(0x22, 'vl_c1', 'f', '速度环增强系数', { src: 'dm', alt: 'VL_c1' }),
  R(0x23, 'can_baudrate', 'i', '波特率索引（本软件只读）', { ro: true, alt: 'can_br' }),
  R(0x24, 'sub_ver', 'u', '子版本号', { ro: true, src: 'dm', alt: 'sub_ver' }),
  R(0x32, 'adc_a_offset', 'f', 'A/U 相零电流偏移（标定值）', { ro: true, alt: 'u_off' }),
  R(0x33, 'adc_b_offset', 'f', 'B/V 相零电流偏移（标定值）', { ro: true, alt: 'v_off' }),
  R(0x34, 'k1', 'f', '补偿因子 1', { ro: true, src: 'dm', alt: 'k1' }),
  R(0x35, 'k2', 'f', '补偿因子 2', { ro: true, src: 'dm', alt: 'k2' }),
  R(0x36, 'm_off', 'f', '角度偏移', { ro: true, src: 'dm', alt: 'm_off' }),
  R(0x37, 'dir', 'f', '方向', { ro: true, src: 'dm', alt: 'dir' }),
  R(0x3b, 'i_max', 'f', '驱动板最大电流', { unit: 'A', src: 'hm' }),
  R(0x3c, 'v_bus', 'f', '电源电压', { ro: true, unit: 'V', src: 'hm' }),
  R(0x3d, 't_mos', 'f', '驱动板温度', { ro: true, unit: '℃', src: 'hm' }),
  R(0x3e, 't_rotor', 'f', '电机温度', { ro: true, unit: '℃', src: 'hm' }),
  R(0x50, 'angle_singleturn', 'f', '电机轴位置', { ro: true, unit: 'rad', alt: 'p_m' }),
  R(0x51, 'output_angle_multiturn', 'f', '输出轴位置', { ro: true, unit: 'rad', alt: 'xout' }),
];

export const REG_BY_RID = new Map<number, RegisterDef>(REGISTERS.map((r) => [r.rid, r]));
export const REG_BY_NAME = new Map<string, RegisterDef>(REGISTERS.map((r) => [r.name, r]));
