export type BusKind = 'pcan' | 'slcan' | 'socketcan' | 'sim';
export type BaudRateKey = '1M' | '800K' | '500K' | '250K' | '125K';
export type ControlMode = 'current' | 'mit';
export type ExciteKind = 'step' | 'stepsine' | 'chirp' | 'prbs';
export type LoopKind = 'vel' | 'pos' | 'pos_single';
export type RefKind = 'step' | 'ramp' | 'sine';

export const BAUDRATE_PCAN: Record<BaudRateKey, number> = {
  '1M': 0x0014,
  '800K': 0x0016,
  '500K': 0x001c,
  '250K': 0x011c,
  '125K': 0x031c,
};

export const BITRATE_HZ: Record<BaudRateKey, number> = {
  '1M': 1_000_000,
  '800K': 800_000,
  '500K': 500_000,
  '250K': 250_000,
  '125K': 125_000,
};

export const BAUDRATE_KEYS: BaudRateKey[] = ['1M', '800K', '500K', '250K', '125K'];

export interface ChannelItem {
  id: string;
  kind: BusKind;
  channel: number | string;
  label: string;
  detail: string;
  occupied?: boolean;
}

export interface ConnectParams {
  kind: BusKind;
  channel: number | string;
  channelName: string;
  baudKey: BaudRateKey;
  baud: number;
  bitrate: number;
}

export interface Limits {
  pMin: number;
  pMax: number;
  vMin: number;
  vMax: number;
  tMin: number;
  tMax: number;
  kpMin: number;
  kpMax: number;
  kdMin: number;
  kdMax: number;
}

export const DEFAULT_LIMITS: Limits = {
  pMin: -12.5,
  pMax: 12.5,
  vMin: -45.0,
  vMax: 45.0,
  tMin: -54.0,
  tMax: 54.0,
  kpMin: 0.0,
  kpMax: 500.0,
  kdMin: 0.0,
  kdMax: 5.0,
};

export function withMaps(
  base: Limits,
  pMax?: number | null,
  vMax?: number | null,
  tMax?: number | null,
): Limits {
  return {
    ...base,
    ...(pMax && pMax > 0 ? { pMin: -pMax, pMax } : {}),
    ...(vMax && vMax > 0 ? { vMin: -vMax, vMax } : {}),
    ...(tMax && tMax > 0 ? { tMin: -tMax, tMax } : {}),
  };
}

export interface MitCommand {
  p: number;
  v: number;
  kp: number;
  kd: number;
  t: number;
}

export const ZERO_MIT: MitCommand = { p: 0, v: 0, kp: 0, kd: 0, t: 0 };

export interface SafetyLimits {
  velMax: number;
  posEnabled: boolean;
  posMin: number;
  posMax: number;
  outMax: number;
  tempMax: number;
  fbTimeout: number;
  velEnabled: boolean;
  outEnabled: boolean;
}

export const DEFAULT_SAFETY_LIMITS: SafetyLimits = {
  velMax: 10.0,
  posEnabled: false,
  posMin: -6.0,
  posMax: 6.0,
  outMax: 1.0,
  tempMax: 0.0,
  fbTimeout: 0.0,
  velEnabled: false,
  outEnabled: false,
};

export interface DriverCaps {
  mit: boolean;
  registers: boolean;
  enableCmd: boolean;
  zero: boolean;
  clear: boolean;
  statusCode: boolean;
}

export interface DriverSpec {
  protocol: 'dm' | 'dji' | 'gd';
  model: string;
  motorId: number;
  masterId: number;
}

export interface DriverSummary extends DriverSpec {
  protocolName: string;
  title: string;
  outName: string;
  outUnit: string;
  outMax: number;
  wrapSpan: number;
  fbId: number;
  ctrlId?: number;
  ctrlSlot?: number;
  family?: 'hm' | 'dm' | 'both';
  gr?: number;
  rawMax?: number;
  note: string;
  caps: DriverCaps;
}

export interface ScanEntry {
  protocol: 'dm' | 'dji' | 'gd';
  model: string;
  motorId: number;
  masterId: number | null;
  fbId: number;
  candidates: Array<[string, number]>;
  evidence: string;
  code?: number;
}

export interface ExciteConfig {
  kind: ExciteKind;
  amp: number;
  stepOn: number;
  stepDelay: number;
  stepTail: number;
  f0: number;
  f1: number;
  nFreq: number;
  cycles: number;
  minSeg: number;
  duration: number;
  prbsDt: number;
  seed: number;
}

export interface LoopConfig {
  loop: LoopKind;
  kp: number;
  ki: number;
  kd: number;
  refKind: RefKind;
  amp: number;
  freq: number;
  rampTime: number;
  delay: number;
  duration: number;
  outMax: number;
  integralMax: number;
  ff: number;
  errFc: number;
  dFc: number;
  posKp?: number | null;
  posKi?: number | null;
  posKd?: number | null;
  posFf: number;
  posIntegralMax: number;
  posOutMax: number;
  posErrFc: number;
  posDFc: number;
  relative: boolean;
  dOnMeas: boolean;
  stepValues: number[];
  stepDurations: number[];
}

export interface BodeData {
  f: number[];
  magV: number[];
  phV: number[];
  magP: number[];
  phP: number[];
  coh: number[];
  cohP: number[];
}

export interface ModelFit {
  J: number;
  b: number;
  Fc: number;
  Td: number;
  unit: string;
  text: string;
}

export interface PidSuggestion {
  velKp: number;
  velKi: number;
  velBw: number;
  posKp: number;
  posKd: number;
  posKi: number;
  posBw: number;
  unit: string;
  note: string;
  startRatio: number;
  phaseMargin: number;
  velPhaseMargin: number;
  posPhaseMargin: number;
  singlePosKp: number;
  singlePosKi: number;
  singlePosKd: number;
  singlePosBw: number;
  singlePosPhaseMargin: number;
  text: string;
}

export interface PredictedClosedLoop {
  f: number[];
  velDb: number[];
  posDb: number[];
  singlePosDb: number[];
}

export interface StepStats {
  rise: number | null;
  overshoot: number;
  settle: number | null;
  ssErr: number;
  rmsErr: number;
}

export interface LatencyStats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface LatestSample {
  t: number;
  posRaw: number;
  posMt: number;
  vel: number;
  outCmd: number;
  outFb: number;
  ref: number;
  temp: number;
  temp2: number;
  code: number;
  active: boolean;
}

export interface EngineState {
  connected: boolean;
  busName: string;
  busStatus: string;
  bitrate: number | null;
  pcanError: string;
  driver: DriverSummary | null;
  code: number;
  codeText: string;
  isFault: boolean;
  enabled: boolean;
  active: boolean;
  sending: boolean;
  rateHz: number;
  txRate: number;
  mode: ControlMode;
  linkOk: boolean;
  running: boolean;
  runKind: '' | 'excite' | 'loop';
  runLoopTarget: '' | LoopKind;
  runTitle: string;
  scanning: boolean;
  scanStage: string;
  scanCurrent: number;
  scanTotal: number;
  queueCount: number;
  limits: Limits;
  limitsOk: boolean;
  blocked: boolean;
  tripped: boolean;
  tripReason: string;
  safetyLimits: SafetyLimits;
  posMt: number;
  latency: LatencyStats | null;
  rawPeriodicActive: boolean;
  logEnabled: boolean;
  latestSample: LatestSample | null;
}

export interface CanFrameDto {
  t: number;
  canId: number;
  dataHex: string;
  tx: boolean;
  extended: boolean;
  rtr: boolean;
  dlc: number;
  note: string;
  bits: number;
}

export interface RunAnalysisPayload {
  runKind: 'excite' | 'loop';
  title: string;
  reason: string;
  done: boolean;
  exciteCfg?: ExciteConfig;
  loopCfg?: LoopConfig;
  bode?: BodeData | null;
  model?: ModelFit | null;
  suggestion?: PidSuggestion | null;
  predicted?: PredictedClosedLoop | null;
  stepStats?: StepStats | null;
  satRatio?: number;
  record: {
    t: number[];
    u: number[];
    ref: number[];
    pos: number[];
    vel: number[];
    fbOut: number[];
    pOut: number[];
    iOut: number[];
    dOut: number[];
  };
}

// Flat stride-14 sample array layout for 30Hz batch streaming
export const SAMPLE_COLS = [
  't',
  'posRaw',
  'posMt',
  'vel',
  'outCmd',
  'outFb',
  'ref',
  'temp',
  'temp2',
  'code',
  'active',
  'pOut',
  'iOut',
  'dOut',
] as const;
export const SAMPLE_STRIDE = SAMPLE_COLS.length; // 14

export type EngineCommand =
  | { type: 'listChannels' }
  | { type: 'connect'; params: ConnectParams }
  | { type: 'disconnect' }
  | { type: 'startScan'; maxDmId: number; windowSec?: number; listenSec?: number; identify?: boolean }
  | { type: 'stopScan' }
  | { type: 'selectMotor'; spec: DriverSpec | null }
  | { type: 'setRateHz'; rateHz: number }
  | { type: 'setSending'; sending: boolean }
  | { type: 'setMode'; mode: ControlMode }
  | { type: 'setTargetOut'; value: number }
  | { type: 'zeroOutput' }
  | { type: 'setTargetMit'; cmd: MitCommand }
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'estop'; reason?: string }
  | { type: 'resetSafety' }
  | { type: 'setSafetyLimits'; limits: SafetyLimits }
  | { type: 'zeroSafetyPosition' }
  | { type: 'clearError' }
  | { type: 'setZero' }
  | { type: 'reloadLimits' }
  | { type: 'readReg'; rid: number }
  | { type: 'readAllRegs'; rids: number[] }
  | { type: 'writeReg'; rid: number; value: number }
  | { type: 'saveRegs' }
  | { type: 'changeMotorIds'; newMotorId: number; newMasterId: number }
  | { type: 'startExciteRun'; cfg: ExciteConfig; pmDeg: number; velBwHz: number | null; singlePosBwHz: number | null; startRatio: number }
  | { type: 'recomputeSuggestion'; pmDeg: number; velBwHz: number | null; singlePosBwHz: number | null; startRatio: number }
  | { type: 'startLoopRun'; cfg: LoopConfig }
  | { type: 'stopRun' }
  | { type: 'sendRaw'; canId: number; dataHex: string; extended: boolean; rtr: boolean; dlc: number }
  | { type: 'startRawPeriodic'; canId: number; dataHex: string; frequency: number; extended: boolean; rtr: boolean; dlc: number }
  | { type: 'stopRawPeriodic' }
  | { type: 'setLogEnabled'; enabled: boolean }
  | { type: 'clearLatencies' }
  | { type: 'getLatencySnapshot' };

export type EngineEvent =
  | { type: 'channels'; channels: ChannelItem[]; pcanError: string }
  | { type: 'state'; state: EngineState }
  | { type: 'samples'; flat: number[]; count: number }
  | { type: 'frames'; frames: CanFrameDto[] }
  | { type: 'scanDone'; entries: ScanEntry[] }
  | { type: 'regResult'; kind: 'read' | 'write' | 'save'; rid: number; value: number | boolean | null; error: string }
  | { type: 'runAnalysis'; payload: RunAnalysisPayload }
  | { type: 'latencyValues'; valuesMs: number[]; stats: LatencyStats | null }
  | { type: 'notice'; level: 'info' | 'warning' | 'error' | 'success'; area: string; text: string };


export type WorkbenchMode = 'scope' | 'sysid' | 'loop' | 'regs';

export interface HydrateSnapshot {
  state: EngineState | null;
  channels: ChannelItem[];
  pcanError: string;
  scanEntries: ScanEntry[];
  regValues: Record<number, { value: number | null; status: 'idle' | 'ok' | 'timeout' | 'error'; error?: string }>;
  lastAnalysis: RunAnalysisPayload | null;
  lang: 'zh' | 'en';
}

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'engine'; cmd: EngineCommand }
  | { type: 'openWorkbench'; mode?: WorkbenchMode; applySuggestion?: PidSuggestion }
  | { type: 'openBusMonitor' }
  | { type: 'setLang'; lang: 'zh' | 'en' }
  | { type: 'saveFile'; defaultName: string; filterName: string; extensions: string[]; content: string }
  | { type: 'pickImportJson' }
  | { type: 'pidCodeAction'; action: 'copy' | 'insert'; suggestion: PidSuggestion; model: ModelFit | null }
  | { type: 'copyText'; text: string };

export type HostToWebviewMessage =
  | { type: 'hydrate'; snapshot: HydrateSnapshot }
  | { type: 'engineEvent'; event: EngineEvent }
  | { type: 'switchWorkbenchMode'; mode: WorkbenchMode; applySuggestion?: PidSuggestion }
  | { type: 'lang'; lang: 'zh' | 'en' }
  | { type: 'importedRegs'; regs: Record<string, number> }
  | { type: 'clearBusLog' };
