import {
  CanFrameDto,
  ChannelItem,
  ConnectParams,
  ControlMode,
  DEFAULT_LIMITS,
  EngineCommand,
  EngineEvent,
  EngineState,
  ExciteConfig,
  LatencyStats,
  LatestSample,
  Limits,
  LoopConfig,
  MitCommand,
  ModelFit,
  RunAnalysisPayload,
  SafetyLimits,
  ScanEntry,
  ZERO_MIT,
} from '../shared/protocol';
import { percentile } from './analysis/math';
import { BaseRun, ExciteRun, LoopRun } from './analysis/runs';
import * as sysid from './analysis/sysid';
import { PCANBasic, PcanBus } from './bus/pcanBasic';
import { canablePorts, SlcanBus } from './bus/slcan';
import { SocketCanBus, socketcanInterfaces } from './bus/socketcan';
import { BusError, CanBus, createFrame, Frame, frameBits, nowSec, wireDlc } from './bus/types';
import { disableHighResTimer, enableHighResTimer } from './bus/winTimer';
import { Supervisor } from './control/safety';
import { Driver, Feedback, FrameTuple, maxTemp } from './drivers/base';
import { makeDriver } from './drivers/catalog';
import { guessModels } from './drivers/dji';
import { DmDriver } from './drivers/dm';
import { gdMotorFromStatus, GD_LIMITS, GD_MODEL, GdDriver, parseGdModelReply } from './drivers/gd';
import * as P from './drivers/dmProtocol';
import { DemoBus } from './sim/demo';

const LIMIT_RIDS = [0x15, 0x16, 0x17] as const;
const EMIT_HZ = 30;
const BLOCK_TIP = '电机使能中，请先失能';

interface ConfigReq {
  kind: 'read' | 'write' | 'save';
  rid: number;
  typ: P.RegType;
  frame: Uint8Array;
  tries: number;
  deadline: number;
}

interface ScanJob {
  phase: 'listen' | 'dm' | 'probe' | 'gd' | 'gdProbe';
  until: number;
  listen: number;
  dji: Map<number, { n: number; data: Uint8Array }>;
  ids: number[];
  i: number;
  cur: number | null;
  deadline: number;
  window: number;
  dm: Map<number, [number, Uint8Array]>;
  gd: Map<number, string>;
  gdProbeIds: number[];
  gdProbeId: number | null;
  identify: boolean;
  probe: Array<[number, number]>;
  pi: number;
  preq: Uint8Array | null;
  pres: Map<string, boolean>;
  stage: string;
  progCur: number;
  progTot: number;
}

interface RawPeriodicJob {
  canId: number;
  data: Uint8Array;
  period: number;
  next: number;
  extended: boolean;
  rtr: boolean;
  dlc: number | null;
}

export class Engine {
  bus: CanBus | null = null;
  driver: Driver | null = null;
  rateHz = 1000.0;
  sending = false;
  mode: ControlMode = 'current';
  reqTimeout = 0.1;
  reqRetries = 2;
  logEnabled = true;
  readonly safety = new Supervisor();
  pcanError = '';

  private targetOut = 0.0;
  private targetMit: MitCommand = { ...ZERO_MIT };
  private lastOut = Number.NaN;
  private swEn = false;
  private reqs: ConfigReq[] = [];
  private pending: ConfigReq | null = null;
  private limVals = new Map<number, number>();
  private scan: ScanJob | null = null;
  private rawPeriodic: RawPeriodicJob | null = null;
  private runObj: BaseRun | null = null;
  private exciteSuggestOpts = {
    pmDeg: 55.0,
    velBwHz: null as number | null,
    singlePosBwHz: null as number | null,
    startRatio: 0.5,
  };
  private lastExciteRun: ExciteRun | null = null;

  private running = false;
  private loopTimer: ReturnType<typeof setImmediate> | null = null;
  private timerEnabled = false;
  private nextTx = 0;
  private nextEmit = 0;
  private nextBusCheck = 0;
  private nextLiveSysid = 0;
  private rateT0 = 0;
  private rateN = 0;
  private txRate = 0;
  private busStatus = '未连接';
  private lastErrT = 0;
  private tripReported = false;
  private txT: number | null = null;

  readonly latencies: number[] = [];
  motorCode = -1;
  lastFb: Feedback | null = null;
  lastFbT = 0.0;
  private latestSample: LatestSample | null = null;
  private sampleFlatBuf: number[] = [];
  private frameBatch: CanFrameDto[] = [];

  constructor(private readonly emit: (ev: EngineEvent) => void) {}

  get active(): boolean {
    const d = this.driver;
    if (!d) return false;
    if (d.caps.enableCmd) return this.motorCode === P.CODE_ENABLED;
    return this.swEn;
  }

  get limitsOk(): boolean {
    return this.driver !== null && this.driver.ready;
  }

  get lim(): Limits {
    if (this.driver instanceof DmDriver) return this.driver.lim;
    if (this.driver instanceof GdDriver) return GD_LIMITS;
    return P.DEFAULT_LIMITS;
  }

  private isDm(): boolean {
    return this.driver instanceof DmDriver;
  }

  private configBlocked(): boolean {
    return this.isDm() && this.motorCode === P.CODE_ENABLED;
  }

  private notice(level: 'info' | 'warning' | 'error' | 'success', area: string, text: string): void {
    this.emit({ type: 'notice', level, area, text });
  }

  private errThrottled(msg: string): void {
    const now = nowSec();
    if (now - this.lastErrT > 1.0) {
      this.lastErrT = now;
      this.notice('error', 'bus', msg);
    }
  }

  enumerateChannels(): ChannelItem[] {
    const items: ChannelItem[] = [];
    this.pcanError = '';

    for (const dev of canablePorts()) {
      items.push({
        id: `slcan:${dev.port}`,
        kind: 'slcan',
        channel: dev.port,
        label: `SLCAN (${dev.port})`,
        detail: dev.description,
      });
    }

    for (const iface of socketcanInterfaces()) {
      items.push({
        id: `socketcan:${iface}`,
        kind: 'socketcan',
        channel: iface,
        label: `SocketCAN ${iface}`,
        detail: '波特率由 Linux ip link 配置',
      });
    }

    if (process.platform === 'win32') {
      try {
        const pcan = new PCANBasic();
        for (const ch of pcan.attachedChannels()) {
          const short = ch.name.replace(/^PCAN_/, '');
          items.push({
            id: `pcan:${ch.handle}`,
            kind: 'pcan',
            channel: ch.handle,
            label: `PCAN (${short})`,
            detail: ch.description,
            occupied: ch.occupied,
          });
        }
      } catch (e) {
        this.pcanError = (e as Error).message;
      }
    }

    items.push({
      id: 'sim:0',
      kind: 'sim',
      channel: 0,
      label: '演示台（虚拟电机，无需硬件）',
      detail: 'HM9816G9 · DM-J8009P · M3508 · M2006 · GM6020',
    });

    this.emit({ type: 'channels', channels: items, pcanError: this.pcanError });
    return items;
  }

  connectBus(bus: CanBus, channelLabel = bus.name): void {
    this.disconnectBus(true);
    bus.open();
    this.bus = bus;
    this.busStatus = 'OK';
    this.startLoop();
    this.notice('success', 'bus', `已连接 ${channelLabel}`);
    this.emitState(nowSec());
  }

  disconnectBus(silent = false): void {
    this.stopLoopAndSafeMotors();
    if (this.bus) {
      try {
        this.bus.close();
      } catch {
        // ignore
      }
      this.bus = null;
    }
    this.driver = null;
    this.motorCode = -1;
    this.lastFb = null;
    this.latestSample = null;
    this.swEn = false;
    this.sending = false;
    this.reqs = [];
    this.pending = null;
    this.scan = null;
    this.rawPeriodic = null;
    this.busStatus = '未连接';
    if (!silent) {
      this.notice('info', 'bus', '已断开总线连接');
    }
    this.emitState(nowSec());
  }

  handleCommand(cmd: EngineCommand): void {
    try {
      switch (cmd.type) {
        case 'listChannels':
          this.enumerateChannels();
          this.emitState(nowSec());
          break;
        case 'connect': {
          const p: ConnectParams = cmd.params;
          let bus: CanBus;
          if (p.kind === 'socketcan') {
            bus = new SocketCanBus(String(p.channel));
          } else if (p.kind === 'slcan') {
            bus = new SlcanBus(String(p.channel), p.bitrate);
          } else if (p.kind === 'sim') {
            bus = new DemoBus();
          } else {
            bus = new PcanBus(Number(p.channel), p.baud);
          }
          this.connectBus(bus, p.channelName);
          this.doScan(
            Array.from({ length: 40 }, (_, i) => i + 1),
            0.02,
            0.3,
            true,
          );
          break;
        }
        case 'disconnect':
          this.disconnectBus();
          break;
        case 'startScan':
          this.doScan(
            Array.from({ length: Math.max(1, Math.min(127, cmd.maxDmId)) }, (_, i) => i + 1),
            cmd.windowSec ?? 0.02,
            cmd.listenSec ?? 0.3,
            cmd.identify ?? true,
          );
          break;
        case 'stopScan':
          if (this.scan) this.finishScan();
          break;
        case 'selectMotor':
          if (cmd.spec === null) {
            this.doSetDriver(null);
          } else {
            const drv = makeDriver(cmd.spec.protocol, cmd.spec.model, cmd.spec.motorId, cmd.spec.masterId);
            this.doSetDriver(drv);
          }
          break;
        case 'setRateHz':
          this.rateHz = Math.max(10, Math.min(1000, cmd.rateHz));
          break;
        case 'setSending':
          this.sending = Boolean(cmd.sending);
          if (!this.sending && this.active) {
            this.targetOut = 0;
            this.targetMit = { ...ZERO_MIT };
            this.sendAll(this.driver?.stopFrames() ?? []);
            this.notice('warning', 'control', '发送已关闭：目标已归零，电机仍处于使能状态');
          }
          break;
        case 'setMode':
          if (cmd.mode === 'mit' && !(this.driver && this.driver.caps.mit)) {
            this.notice('warning', 'control', '当前电机不支持 MIT 模式');
            break;
          }
          if (cmd.mode !== this.mode) {
            this.abortRun('切换控制模式');
            this.mode = cmd.mode;
          }
          break;
        case 'setTargetOut': {
          const nextOut = Number(cmd.value) || 0;
          if (this.safety.tripped && nextOut !== 0) {
            break;
          }
          this.targetOut = nextOut;
          break;
        }
        case 'zeroOutput':
          this.targetOut = 0.0;
          if (this.driver && this.active) {
            this.sendAll(this.driver.stopFrames());
          }
          break;
        case 'setTargetMit':
          if (this.safety.tripped && (cmd.cmd.kp !== 0 || cmd.cmd.kd !== 0 || cmd.cmd.t !== 0)) {
            break;
          }
          this.targetMit = { ...cmd.cmd };
          break;
        case 'enable':
          this.doEnable();
          break;
        case 'disable':
          this.doDisable();
          break;
        case 'estop':
          this.doEstop(cmd.reason ?? '用户急停');
          break;
        case 'resetSafety':
          if (this.safety.reset()) {
            this.targetOut = 0;
            this.targetMit = { ...ZERO_MIT };
            this.tripReported = false;
            this.notice('success', 'safety', '已解除急停/超限锁存');
          } else {
            this.notice('error', 'safety', '不能解除：' + this.safety.reason);
          }
          this.emitState(nowSec());
          break;
        case 'setSafetyLimits':
          this.safety.limits = { ...cmd.limits };
          break;
        case 'zeroSafetyPosition':
          this.safety.zeroPosition();
          break;
        case 'clearError':
          if (this.driver) {
            const fr = this.driver.clearFrames();
            if (fr.length && this.sendAll(fr)) {
              this.notice('info', 'control', '已发送清错指令');
            }
          }
          break;
        case 'setZero':
          if (this.configBlocked()) {
            this.notice('warning', 'control', '不能设零点：' + BLOCK_TIP);
            break;
          }
          if (this.driver) {
            const fr = this.driver.zeroFrames();
            if (fr.length && this.sendAll(fr)) {
              this.notice('success', 'control', '已发送设零点指令');
            }
            this.safety.mt.reset();
          }
          break;
        case 'reloadLimits':
          this.doReloadLimits();
          break;
        case 'readReg':
          this.doReadReg(cmd.rid);
          break;
        case 'readAllRegs':
          for (const rid of cmd.rids) this.doReadReg(rid);
          break;
        case 'writeReg':
          this.doWriteReg(cmd.rid, cmd.value);
          break;
        case 'saveRegs':
          this.doSaveRegs();
          break;
        case 'changeMotorIds':
          this.doWriteReg(0x07, cmd.newMasterId);
          this.doWriteReg(0x08, cmd.newMotorId);
          this.doSaveRegs();
          break;
        case 'startExciteRun':
          this.exciteSuggestOpts = {
            pmDeg: cmd.pmDeg,
            velBwHz: cmd.velBwHz,
            singlePosBwHz: cmd.singlePosBwHz,
            startRatio: cmd.startRatio,
          };
          this.doStartRun(new ExciteRun(cmd.cfg));
          break;
        case 'recomputeSuggestion':
          this.exciteSuggestOpts = {
            pmDeg: cmd.pmDeg,
            velBwHz: cmd.velBwHz,
            singlePosBwHz: cmd.singlePosBwHz,
            startRatio: cmd.startRatio,
          };
          if (this.runObj instanceof ExciteRun) {
            this.emitExciteAnalysis(this.runObj, false);
          } else if (this.lastExciteRun) {
            this.emitExciteAnalysis(this.lastExciteRun, true);
          }
          break;
        case 'startLoopRun':
          this.doStartRun(new LoopRun(cmd.cfg));
          break;
        case 'stopRun':
          this.abortRun('用户停止');
          break;
        case 'sendRaw': {
          const data = cmd.rtr ? new Uint8Array(0) : this.parseHexBytes(cmd.dataHex);
          this.sendFrame(cmd.canId, data, cmd.extended, cmd.rtr, cmd.rtr ? cmd.dlc : data.length);
          break;
        }
        case 'startRawPeriodic': {
          const data = cmd.rtr ? new Uint8Array(0) : this.parseHexBytes(cmd.dataHex);
          this.doStartRawPeriodic(
            cmd.canId,
            data,
            cmd.frequency,
            cmd.extended,
            cmd.rtr,
            cmd.rtr ? cmd.dlc : data.length,
          );
          break;
        }
        case 'stopRawPeriodic':
          this.rawPeriodic = null;
          break;
        case 'setLogEnabled':
          this.logEnabled = Boolean(cmd.enabled);
          break;
        case 'clearLatencies':
          this.latencies.length = 0;
          this.emit({ type: 'latencyValues', valuesMs: [], stats: null });
          break;
        case 'getLatencySnapshot':
          this.emit({
            type: 'latencyValues',
            valuesMs: this.latencies.map((s) => s * 1000),
            stats: this.latencyStats(),
          });
          break;
      }
    } catch (e) {
      this.notice('error', 'global', (e as Error).message);
    }
  }

  private parseHexBytes(hex: string): Uint8Array {
    const cleaned = hex.replace(/[,;\s]+/g, '').trim();
    if (!cleaned) return new Uint8Array(0);
    if (cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
      throw new Error('十六进制报文格式无效');
    }
    const bytes = new Uint8Array(Buffer.from(cleaned, 'hex'));
    if (bytes.length > 8) {
      throw new Error('经典 CAN 数据最多 8 字节');
    }
    return bytes;
  }

  doSetDriver(driver: Driver | null): void {
    if (this.active) {
      this.notice('warning', 'motors', '请先失能/停止当前电机再切换');
      return;
    }
    this.rawPeriodic = null;
    this.abortRun('切换电机');
    this.driver = driver;
    this.motorCode = -1;
    this.lastFb = null;
    this.latestSample = null;
    this.swEn = false;
    this.lastOut = Number.NaN;
    this.targetOut = 0.0;
    this.targetMit = { ...ZERO_MIT };
    this.reqs = [];
    this.pending = null;
    this.latencies.length = 0;
    this.safety.mt.reset();
    if (driver) {
      this.safety.setWrapSpan(driver.wrapSpan);
      if (!driver.caps.mit) {
        this.mode = 'current';
      }
      this.sending = true;
      if (driver instanceof DmDriver) {
        driver.invalidateLimits();
        this.queueLimitReads();
      }
      this.notice('info', 'motors', `已选择电机：${driver.title()}`);
    } else {
      this.sending = false;
    }
    this.emitState(nowSec());
  }

  private queueLimitReads(): void {
    if (!this.driver) return;
    this.limVals.clear();
    this.reqs = this.reqs.filter((r) => !(LIMIT_RIDS as readonly number[]).includes(r.rid));
    for (const rid of LIMIT_RIDS) {
      this.reqs.push({
        kind: 'read',
        rid,
        typ: 'f',
        frame: P.readRegFrame(this.driver.motorId, rid),
        tries: 0,
        deadline: 0,
      });
    }
  }

  private doReloadLimits(): void {
    if (!(this.driver instanceof DmDriver)) return;
    if (this.configBlocked()) {
      this.notice('warning', 'regs', '不能重读量程：' + BLOCK_TIP);
      return;
    }
    this.driver.invalidateLimits();
    this.queueLimitReads();
    this.emitState(nowSec());
  }

  private onLimitValue(rid: number, val: number): void {
    if (!(this.driver instanceof DmDriver)) return;
    if (!Number.isFinite(val) || val <= 0) {
      this.notice('error', 'regs', `量程寄存器 0x${rid.toString(16).toUpperCase().padStart(2, '0')} 值无效: ${val}`);
      return;
    }
    this.limVals.set(rid, val);
    if (LIMIT_RIDS.every((r) => this.limVals.has(r))) {
      const wasReady = this.driver.ready;
      this.driver.setLimits(
        this.limVals.get(0x15)!,
        this.limVals.get(0x16)!,
        this.limVals.get(0x17)!,
      );
      this.safety.setWrapSpan(this.driver.wrapSpan);
      if (!wasReady) {
        const L = this.driver.lim;
        this.notice(
          'success',
          'regs',
          `已读取量程: p±${Number(L.pMax.toPrecision(7))} v±${Number(L.vMax.toPrecision(7))} t±${Number(L.tMax.toPrecision(7))}`,
        );
      }
      this.emitState(nowSec());
    }
  }

  doEnable(): void {
    const d = this.driver;
    if (!d) {
      this.notice('warning', 'control', '未选择电机');
      return;
    }
    if (this.scan !== null) {
      this.notice('warning', 'control', '扫描中，不能使能');
      return;
    }
    if (!d.ready) {
      this.notice('error', 'control', '尚未从电机读到量程，禁止使能（可在参数页重读）');
      return;
    }
    if (this.safety.tripped) {
      this.notice('warning', 'safety', '急停/超限锁存中，请先确认解除');
      return;
    }
    if (!this.sending) {
      this.sending = true;
    }
    if (d.caps.enableCmd) {
      if (this.sendAll(d.enableFrames())) {
        this.notice('success', 'control', '已发送使能指令 (FC)');
      }
    } else {
      this.swEn = true;
      this.notice('success', 'control', '已开始输出电流指令');
    }
    this.emitState(nowSec());
  }

  doDisable(): void {
    const d = this.driver;
    if (!d) return;
    this.abortRun('失能');
    this.targetOut = 0.0;
    this.targetMit = { ...ZERO_MIT };
    if (d.caps.enableCmd) {
      this.sendAll(d.stopFrames());
      if (this.sendAll(d.disableFrames()) && this.motorCode === P.CODE_ENABLED) {
        this.motorCode = P.CODE_DISABLED;
      }
      this.notice('info', 'control', '已发送失能指令 (FD)');
    } else {
      this.swEn = false;
      this.sendAll(d.stopFrames());
      this.notice('info', 'control', '已停止输出（已发零电流）');
    }
    this.emitState(nowSec());
  }

  doEstop(reason = '用户急停'): void {
    this.abortRun(reason);
    this.targetOut = 0.0;
    this.targetMit = { ...ZERO_MIT };
    this.safety.trip(`已急停：${reason}`);
    this.tripReported = true;
    if (this.driver) {
      this.sendAll(this.driver.stopFrames());
    }
    this.notice('warning', 'safety', `已急停并锁存（${reason}）：输出已归零`);
    this.emitState(nowSec());
  }

  private onTrip(): void {
    this.targetOut = 0;
    this.targetMit = { ...ZERO_MIT };
    if (!this.tripReported) {
      this.tripReported = true;
      this.abortRun('安全限制');
      this.notice('error', 'safety', '安全限制触发零扭矩：' + this.safety.reason);
    }
  }

  doStartRun(run: BaseRun): void {
    let why = '';
    if (!this.active) {
      why = '请先使能电机';
    } else if (this.safety.tripped) {
      why = '安全超限保护中，请先恢复正常范围';
    }
    if (why) {
      this.notice('warning', 'run', why);
      run.finish(why);
      this.emitRunFinished(run);
      return;
    }
    this.abortRun('启动新测试');
    run.start(nowSec(), this.safety.pos, this.lastFb ? this.lastFb.vel : 0.0);
    this.runObj = run;
    this.nextLiveSysid = nowSec() + 0.35;
    if (run instanceof ExciteRun) this.emitExciteAnalysis(run, false);
    this.notice('info', 'run', `开始：${run.title}`);
    this.emitState(nowSec());
  }

  private finishRun(run: BaseRun, reason = ''): void {
    if (this.runObj !== run) return;
    this.runObj = null;
    run.finish(reason);
    if (this.driver && this.active) {
      this.sendAll(this.driver.stopFrames());
      this.targetOut = 0.0;
    }
    this.notice(
      reason ? 'warning' : 'success',
      'run',
      `结束：${run.title}${reason ? `（${reason}）` : ''}，输出已归零`,
    );
    this.emitRunFinished(run);
    this.emitState(nowSec());
  }

  private abortRun(reason: string): void {
    if (this.runObj) {
      this.finishRun(this.runObj, reason);
    }
  }

  private emitExciteAnalysis(run: ExciteRun, done: boolean): void {
    const unit = this.driver?.outUnit ?? 'Nm';
    const latStats = this.latencyStats();
    const measLat = latStats ? latStats.p50 : 0.002;
    let bode = null;
    let model: ModelFit | null = null;
    if (run.cfg.kind === 'step') {
      if (done) model = sysid.stepModel(run.snapshotRecord(), unit);
    } else {
      bode = sysid.bodeFromRun(run);
      if (done && bode) model = sysid.fitModel(bode, unit);
    }
    const activeModel = model;
    const suggestion = activeModel
      ? sysid.suggest(activeModel, {
          latency: measLat,
          rateHz: this.rateHz,
          pmDeg: this.exciteSuggestOpts.pmDeg,
          velBwHz: this.exciteSuggestOpts.velBwHz,
          singlePosBwHz: this.exciteSuggestOpts.singlePosBwHz,
          startRatio: this.exciteSuggestOpts.startRatio,
        })
      : null;
    const predicted =
      activeModel && suggestion
        ? sysid.predictedClosedLoop(activeModel, suggestion, measLat, this.rateHz)
        : null;
    const rec = run.snapshotRecord();
    const payload: RunAnalysisPayload = {
      runKind: 'excite',
      title: run.title,
      reason: run.reason,
      done,
      exciteCfg: run.cfg,
      bode,
      model,
      suggestion,
      predicted,
      record: {
        t: rec.t,
        u: rec.u,
        ref: rec.ref,
        pos: rec.pos,
        vel: rec.vel,
        fbOut: rec.fbOut,
        pOut: rec.pOut,
        iOut: rec.iOut,
        dOut: rec.dOut,
      },
    };
    this.emit({ type: 'runAnalysis', payload });
  }

  private emitRunFinished(run: BaseRun): void {
    if (run instanceof ExciteRun) {
      this.lastExciteRun = run;
      this.emitExciteAnalysis(run, true);
    } else if (run instanceof LoopRun) {
      const rec = run.snapshotRecord();
      const stats = sysid.loopStats(rec, run.cfg.loop);
      this.emit({
        type: 'runAnalysis',
        payload: {
          runKind: 'loop',
          title: run.title,
          reason: run.reason,
          done: true,
          loopCfg: run.cfg,
          stepStats: stats,
          satRatio: run.satRatio,
          record: {
            t: rec.t,
            u: rec.u,
            ref: rec.ref,
            pos: rec.pos,
            vel: rec.vel,
            fbOut: rec.fbOut,
            pOut: rec.pOut,
            iOut: rec.iOut,
            dOut: rec.dOut,
          },
        },
      });
    }
  }

  doReadReg(rid: number): void {
    if (!this.isDm() || !this.driver) return;
    if (this.reqs.some((r) => r.kind === 'read' && r.rid === rid)) return;
    const reg = P.REG_BY_RID.get(rid);
    this.reqs.push({
      kind: 'read',
      rid,
      typ: reg?.typ ?? 'u',
      frame: P.readRegFrame(this.driver.motorId, rid),
      tries: 0,
      deadline: 0,
    });
  }

  doWriteReg(rid: number, value: number): void {
    if (!this.isDm() || !this.driver) return;
    const reg = P.REG_BY_RID.get(rid);
    const typ = reg?.typ ?? 'u';
    if (reg?.ro) {
      this.emit({ type: 'regResult', kind: 'write', rid, value: null, error: '本软件中为只读寄存器' });
      return;
    }
    if (this.configBlocked()) {
      this.emit({ type: 'regResult', kind: 'write', rid, value: null, error: BLOCK_TIP });
      return;
    }
    try {
      const frame = P.writeRegFrame(this.driver.motorId, rid, typ, value);
      this.reqs.push({ kind: 'write', rid, typ, frame, tries: 0, deadline: 0 });
    } catch (e) {
      this.emit({ type: 'regResult', kind: 'write', rid, value: null, error: `数值无效: ${(e as Error).message}` });
    }
  }

  doSaveRegs(): void {
    if (!this.isDm() || !this.driver) return;
    if (this.configBlocked()) {
      this.emit({
        type: 'regResult',
        kind: 'save',
        rid: 0,
        value: null,
        error: '保存参数只在失能模式下生效：' + BLOCK_TIP,
      });
      return;
    }
    this.reqs.push({
      kind: 'save',
      rid: 0,
      typ: 'u',
      frame: P.saveFrame(this.driver.motorId),
      tries: 0,
      deadline: 0,
    });
  }

  private finishReq(d: Uint8Array): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const rep = P.parseConfigReply(d);
    if (!rep) return;
    const val = p.kind === 'save' ? true : P.decodeValue(p.typ, rep.raw4);
    if (p.kind === 'read' && (LIMIT_RIDS as readonly number[]).includes(p.rid) && typeof val === 'number') {
      this.onLimitValue(p.rid, val);
    }
    this.emit({ type: 'regResult', kind: p.kind, rid: p.rid, value: val, error: '' });
  }

  private serviceConfig(now: number): void {
    const p = this.pending;
    if (p !== null) {
      if (now >= p.deadline) {
        if (p.tries <= this.reqRetries) {
          p.tries += 1;
          p.deadline = now + this.reqTimeout;
          this.sendFrame(P.CONFIG_ID, p.frame);
        } else {
          this.pending = null;
          if (p.kind === 'read' && (LIMIT_RIDS as readonly number[]).includes(p.rid)) {
            this.notice(
              'error',
              'regs',
              `量程寄存器 0x${p.rid.toString(16).toUpperCase().padStart(2, '0')} 读取超时，禁止使能（可在参数页重读）`,
            );
          }
          this.emit({ type: 'regResult', kind: p.kind, rid: p.rid, value: null, error: '超时无应答' });
        }
      }
      return;
    }
    if (this.reqs.length > 0 && this.scan === null && !this.configBlocked()) {
      const next = this.reqs.shift()!;
      next.tries = 1;
      next.deadline = now + this.reqTimeout;
      this.pending = next;
      this.sendFrame(P.CONFIG_ID, next.frame);
    }
  }

  doScan(ids: number[], windowSec: number, listenSec: number, identify: boolean): void {
    if (!this.bus) return;
    if (this.active) {
      this.notice('warning', 'motors', '不能扫描：请先失能当前电机');
      this.emit({ type: 'scanDone', entries: [] });
      return;
    }
    this.abortRun('扫描');
    this.scan = {
      phase: 'listen',
      until: nowSec() + listenSec,
      listen: listenSec,
      dji: new Map(),
      gd: new Map(),
      gdProbeIds: [],
      gdProbeId: null,
      ids,
      i: -1,
      cur: null,
      deadline: 0,
      window: windowSec,
      dm: new Map(),
      identify,
      probe: [],
      pi: -1,
      preq: null,
      pres: new Map(),
      stage: '监听大疆反馈',
      progCur: 0,
      progTot: 1,
    };
    this.emitState(nowSec());
  }

  private scanRx(f: Frame): void {
    const s = this.scan;
    if (!s) return;
    const d = f.data;
    if (s.phase === 'listen') {
      if (f.canId >= 0x201 && f.canId <= 0x20b && d.length >= 7) {
        const cur = s.dji.get(f.canId) ?? { n: 0, data: d };
        cur.n += 1;
        cur.data = d;
        s.dji.set(f.canId, cur);
      }
    } else if (s.phase === 'dm') {
      const cur = s.cur;
      if (
        cur !== null &&
        !s.dm.has(cur) &&
        !f.extended &&
        d.length === 8 &&
        f.canId !== P.CONFIG_ID &&
        !(f.canId >= 0x201 && f.canId <= 0x20b) &&
        !P.CONFIG_CMDS.includes(d[2])
      ) {
        s.dm.set(cur, [f.canId, new Uint8Array(d)]);
      }
    } else if (s.phase === 'gd' && f.extended) {
      const motorId = gdMotorFromStatus(f.canId, d);
      if (motorId !== null && !s.gd.has(motorId)) s.gd.set(motorId, GD_MODEL);
    } else if (s.phase === 'gdProbe' && f.extended && s.gdProbeId !== null) {
      if (f.canId === (0x10000 | (s.gdProbeId << 8))) {
        const model = parseGdModelReply(d);
        if (model) {
          s.gd.set(s.gdProbeId, model);
          s.deadline = 0;
        }
      }
    } else if (s.phase === 'probe' && s.preq !== null) {
      if (P.matchesRequest(d, s.preq)) {
        const [mid, rid] = s.probe[s.pi];
        s.pres.set(`${mid}:${rid}`, true);
        s.deadline = 0;
      }
    }
  }

  private serviceScan(now: number): void {
    const s = this.scan;
    if (!s || this.pending !== null) return;
    if (s.phase === 'listen') {
      if (now < s.until) return;
      s.phase = 'dm';
    }
    if (s.phase === 'dm') {
      if (now < s.deadline) return;
      s.i += 1;
      if (s.i < s.ids.length) {
        const cur = s.ids[s.i];
        s.cur = cur;
        s.deadline = now + s.window;
        this.sendFrame(P.CONFIG_ID, P.queryStateFrame(cur));
        s.stage = '查询达妙/HM';
        s.progCur = s.i + 1;
        s.progTot = s.ids.length;
        return;
      }
      s.cur = null;
      s.phase = 'probe';
      if (s.identify) {
        const dmIds = [...s.dm.keys()].sort((a, b) => a - b);
        for (const mid of dmIds) {
          s.probe.push([mid, 0x0a], [mid, 0x3c]);
        }
      }
      s.deadline = 0;
    }
    if (s.phase === 'probe') {
      if (now < s.deadline) return;
      s.pi += 1;
      if (s.pi < s.probe.length) {
        const [mid, rid] = s.probe[s.pi];
        s.preq = P.readRegFrame(mid, rid);
        s.deadline = now + 0.06;
        this.sendFrame(P.CONFIG_ID, s.preq);
        s.stage = '识别型号';
        s.progCur = s.pi + 1;
        s.progTot = s.probe.length;
        return;
      }
      s.phase = 'gd';
      s.i = -1;
      s.deadline = 0;
    }
    if (s.phase === 'gd') {
      if (now < s.deadline) return;
      s.i += 1;
      if (s.i < s.ids.length) {
        const motorId = s.ids[s.i];
        s.deadline = now + s.window;
        this.sendFrame(0x18000 | motorId, new Uint8Array([0x00, 0x0e]), true);
        s.stage = '查询高擎 GD';
        s.progCur = s.i + 1;
        s.progTot = s.ids.length;
        return;
      }
      if (s.identify && s.gd.size > 0) {
        s.phase = 'gdProbe';
        s.gdProbeIds = [...s.gd.keys()].sort((a, b) => a - b);
        s.gdProbeId = null;
        s.i = -1;
        s.deadline = 0;
      } else {
        this.finishScan();
      }
    }
    if (s.phase === 'gdProbe') {
      if (now < s.deadline) return;
      s.i += 1;
      if (s.i < s.gdProbeIds.length) {
        const motorId = s.gdProbeIds[s.i];
        s.gdProbeId = motorId;
        s.deadline = now + Math.max(s.window, 0.06);
        this.sendFrame(0x18000 | motorId, new Uint8Array([0x00, 0x07]), true);
        s.stage = '识别 GD 型号';
        s.progCur = s.i + 1;
        s.progTot = s.gdProbeIds.length;
        return;
      }
      this.finishScan();
    }
  }

  private finishScan(): void {
    const s = this.scan;
    if (!s) return;
    this.scan = null;
    const found: ScanEntry[] = [];
    const minN = Math.max(5, Math.trunc(s.listen * 200));

    for (const fbId of [...s.dji.keys()].sort((a, b) => a - b)) {
      const e = s.dji.get(fbId)!;
      const cands = guessModels(fbId, e.data);
      if (e.n < minN || cands.length === 0) continue;
      const rate = e.n / s.listen;
      found.push({
        protocol: 'dji',
        model: cands[0][0],
        motorId: cands[0][1],
        masterId: null,
        fbId,
        candidates: cands,
        evidence:
          `反馈 0x${fbId.toString(16).toUpperCase().padStart(3, '0')} 广播约 ${rate.toFixed(0)} Hz` +
          (cands.length > 1 ? '；与其它型号 ID 重叠，请确认' : ''),
      });
    }

    for (const mid of [...s.dm.keys()].sort((a, b) => a - b)) {
      const [cid, d] = s.dm.get(mid)!;
      const hasMode = s.pres.get(`${mid}:10`) ?? false; // 0x0A
      const hasVbus = s.pres.get(`${mid}:60`) ?? false; // 0x3C
      let model = '达妙/HM 通用';
      let ev = '特征不足';
      if (!s.identify) {
        ev = '0xCC 有应答';
      } else if (hasMode) {
        model = 'DM-J8009P';
        ev = '有 CTRL_MODE(0x0A) → 达妙';
      } else if (hasVbus) {
        model = 'HM9816G9';
        ev = '有 v_bus(0x3C)、无 CTRL_MODE → HM';
      }
      found.push({
        protocol: 'dm',
        model,
        motorId: mid,
        masterId: cid,
        fbId: cid,
        candidates: [[model, mid]],
        evidence: `0xCC 应答 ID 0x${cid.toString(16).toUpperCase()}；${ev}`,
        code: d[0] >> 4,
      });
    }

    for (const motorId of [...s.gd.keys()].sort((a, b) => a - b)) {
      found.push({
        protocol: 'gd',
        model: s.gd.get(motorId) ?? GD_MODEL,
        motorId,
        masterId: null,
        fbId: 0x10000 | (motorId << 8),
        candidates: [[s.gd.get(motorId) ?? GD_MODEL, motorId]],
        evidence: `扩展帧 0x${(0x10000 | (motorId << 8)).toString(16).toUpperCase()} 应答 0x0E 状态`,
      });
    }

    this.emit({ type: 'scanDone', entries: found });
    this.emitState(nowSec());
  }

  private doStartRawPeriodic(
    canId: number,
    data: Uint8Array,
    frequency: number,
    extended: boolean,
    rtr: boolean,
    dlc: number | null,
  ): void {
    if (frequency <= 0) {
      this.rawPeriodic = null;
      return;
    }
    this.rawPeriodic = {
      canId,
      data,
      period: 1.0 / frequency,
      next: nowSec(),
      extended,
      rtr,
      dlc,
    };
  }

  private serviceRawPeriodic(now: number): void {
    const task = this.rawPeriodic;
    if (!task || now < task.next) return;
    task.next = now + task.period;
    this.sendFrame(task.canId, task.data, task.extended, task.rtr, task.dlc);
  }

  private sendFrame(
    canId: number,
    data: Uint8Array,
    extended = false,
    rtr = false,
    dlc: number | null = null,
  ): boolean {
    if (!this.bus) return false;
    try {
      this.bus.send(canId, data, extended, rtr, dlc);
    } catch (e) {
      if (e instanceof BusError) {
        this.errThrottled(e.message);
      } else {
        this.errThrottled((e as Error).message);
      }
      return false;
    }
    if (this.logEnabled) {
      const f = createFrame(nowSec(), canId, data, { tx: true, extended, rtr, dlc });
      this.pushFrameDto(f);
    }
    return true;
  }

  private sendAll(frames: FrameTuple[]): boolean {
    let ok = true;
    for (const [cid, d] of frames) {
      ok = this.sendFrame(cid, d, this.driver?.extended ?? false) && ok;
    }
    return ok;
  }

  private pushFrameDto(f: Frame): void {
    if (this.frameBatch.length >= 600) return;
    this.frameBatch.push({
      t: f.t,
      canId: f.canId,
      dataHex: f.rtr ? '' : P.hexdata(f.data),
      tx: f.tx,
      extended: f.extended,
      rtr: f.rtr,
      dlc: wireDlc(f),
      note: this.driver ? this.driver.describe(f.canId, f.data, f.tx) : '',
      bits: frameBits(f),
    });
  }

  private onRx(f: Frame): void {
    const d = f.data;
    const p = this.pending;
    if (p && this.isDm() && this.driver && f.canId === this.driver.masterId && P.matchesRequest(d, p.frame)) {
      this.finishReq(d);
      return;
    }
    if (this.scan !== null) {
      this.scanRx(f);
      if (this.scan.phase !== 'listen') return;
    }
    const drv = this.driver;
    if (!drv || f.extended !== drv.extended || !drv.accepts(f.canId, d)) return;
    const fb = drv.parse(f.canId, d, f.t);
    if (!fb) return;

    if (this.txT !== null && drv.caps.enableCmd) {
      const lat = f.t - this.txT;
      if (lat >= 0) {
        if (this.latencies.length >= 5000) this.latencies.shift();
        this.latencies.push(lat);
      }
      this.txT = null;
    }
    if (drv.caps.statusCode) {
      if (this.motorCode !== -1 && drv.isFault(fb.code)) {
        this.safety.trip(`电机报告 ${drv.codeText(fb.code)}`);
        this.notice('error', 'control', `电机报告 ${drv.codeText(fb.code)}`);
      }
      if (fb.enabled === false && this.runObj !== null) {
        this.abortRun('电机已退出使能');
      }
      this.motorCode = fb.code;
    }
    this.lastFb = fb;
    this.lastFbT = f.t;
    this.safety.onFeedback(f.t, fb.pos, fb.vel, maxTemp(fb));
    if (this.safety.tripped && this.active) {
      this.onTrip();
    } else if (!this.safety.tripped) {
      this.tripReported = false;
    }

    const run = this.runObj;
    let pOut = Number.NaN;
    let iOut = Number.NaN;
    let dOut = Number.NaN;
    if (run) {
      run.record(f.t, this.lastOut, fb, this.safety.pos);
      if (run instanceof LoopRun) {
        [pOut, iOut, dOut] = run.components();
      }
    }

    const act = this.active;
    const outCmd = act ? this.lastOut : Number.NaN;
    const refVal = run ? run.ref : Number.NaN;

    this.latestSample = {
      t: f.t,
      posRaw: fb.pos,
      posMt: this.safety.pos,
      vel: fb.vel,
      outCmd,
      outFb: fb.out,
      ref: refVal,
      temp: fb.temp,
      temp2: fb.temp2,
      code: fb.code,
      active: act,
    };

    this.sampleFlatBuf.push(
      f.t,
      fb.pos,
      this.safety.pos,
      fb.vel,
      outCmd,
      fb.out,
      refVal,
      fb.temp,
      fb.temp2,
      fb.code,
      act ? 1.0 : 0.0,
      pOut,
      iOut,
      dOut,
    );
  }

  private tick(now: number): boolean {
    const d = this.driver;
    if (!d) return false;
    if (!this.active) {
      this.lastOut = Number.NaN;
      if (this.scan === null && this.pending === null) {
        const fr = d.idleFrames();
        if (fr.length && this.sendAll(fr)) {
          this.txT = now;
          return true;
        }
      }
      return false;
    }

    let fr: FrameTuple[];
    let out = 0.0;
    if (this.safety.tripped || !d.ready) {
      fr = d.stopFrames();
      out = 0.0;
    } else {
      const run = this.runObj;
      if (run !== null) {
        let u = run.output(now, this.lastFb, this.safety.pos);
        if (u === null) {
          this.finishRun(run);
          u = 0.0;
        }
        out = this.safety.filterOutput(now, u);
        if (run instanceof LoopRun) {
          let actual = out;
          if (d.outMax > 0) {
            actual = Math.max(-d.outMax, Math.min(d.outMax, actual));
          }
          run.trackOutput(actual);
        }
        fr = d.outputFrames(out);
      } else if (this.mode === 'mit' && d.caps.mit) {
        const cmd = this.targetMit;
        const tFiltered = this.safety.filterOutput(now, cmd.t);
        const L = this.lim;
        const mit: MitCommand = {
          p: P.clamp(cmd.p, L.pMin, L.pMax),
          v: P.clamp(cmd.v, L.vMin, L.vMax),
          kp: P.clamp(cmd.kp, L.kpMin, L.kpMax),
          kd: P.clamp(cmd.kd, L.kdMin, L.kdMax),
          t: P.clamp(tFiltered, L.tMin, L.tMax),
        };
        out = mit.t;
        fr = d.mitFrames(mit);
      } else {
        out = this.safety.filterOutput(now, this.targetOut);
        fr = d.outputFrames(out);
      }

      if (this.safety.tripped) {
        this.onTrip();
        fr = d.stopFrames();
        out = 0.0;
      }
    }

    if (this.sendAll(fr)) {
      this.lastOut = out;
      this.txT = now;
      return true;
    }
    return false;
  }

  latencyStats(): LatencyStats | null {
    if (this.latencies.length === 0) return null;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      n: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1],
    };
  }

  private startLoop(): void {
    if (this.running) return;
    this.timerEnabled = enableHighResTimer();
    this.running = true;
    const now = nowSec();
    this.nextTx = now;
    this.nextEmit = now;
    this.nextBusCheck = now + 1.0;
    this.rateT0 = now;
    this.rateN = 0;
    this.txRate = 0;
    this.scheduleIteration();
  }

  private scheduleIteration(): void {
    if (!this.running) return;
    const step = (): void => {
      if (!this.running) return;
      this.stepOnce();
      if (!this.running) return;
      // Use sub-ms sleep via Atomics.wait when idle between 1kHz ticks without starving IPC
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  stepOnce(): void {
    if (!this.bus) return;
    try {
      const rx = this.bus.recvAll();
      for (const f of rx) {
        if (this.logEnabled) this.pushFrameDto(f);
        this.onRx(f);
      }
    } catch (e) {
      this.errThrottled(`接收失败: ${(e as Error).message}`);
    }

    const now = nowSec();
    if (this.sending) {
      if (now >= this.nextTx) {
        const period = 1.0 / Math.max(1.0, this.rateHz);
        this.nextTx += period;
        if (this.nextTx < now) {
          this.nextTx = now + period;
        }
        if (this.tick(now)) {
          this.rateN += 1;
        }
      }
    } else {
      this.nextTx = now;
      this.lastOut = Number.NaN;
    }

    this.serviceRawPeriodic(now);
    this.serviceConfig(now);
    this.serviceScan(now);

    if (now >= this.nextBusCheck) {
      this.nextBusCheck = now + 1.0;
      try {
        this.busStatus = this.bus.statusText();
      } catch (e) {
        this.busStatus = (e as Error).message;
      }
      this.txRate = this.rateN / Math.max(1e-6, now - this.rateT0);
      this.rateT0 = now;
      this.rateN = 0;
    }

    if (this.runObj instanceof ExciteRun && now >= this.nextLiveSysid) {
      this.nextLiveSysid = now + 0.4;
      this.emitExciteAnalysis(this.runObj, false);
    }

    if (now >= this.nextEmit) {
      this.nextEmit = now + 1.0 / EMIT_HZ;
      if (this.sampleFlatBuf.length > 0) {
        const flat = this.sampleFlatBuf;
        this.sampleFlatBuf = [];
        this.emit({ type: 'samples', flat, count: flat.length / 14 });
      }
      if (this.frameBatch.length > 0) {
        const frames = this.frameBatch;
        this.frameBatch = [];
        this.emit({ type: 'frames', frames });
      }
      this.emitState(now);
    }
  }

  private stopLoopAndSafeMotors(): void {
    this.rawPeriodic = null;
    this.abortRun('断开');
    if (this.bus && this.driver && this.active) {
      this.sendAll(this.driver.stopFrames());
    }
    this.running = false;
    if (this.loopTimer) {
      clearImmediate(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.timerEnabled) {
      disableHighResTimer();
      this.timerEnabled = false;
    }
  }

  shutdown(): void {
    this.disconnectBus(true);
  }

  buildState(now = nowSec()): EngineState {
    const d = this.driver;
    const linkOk = this.lastFb !== null && now - this.lastFbT < 0.2;
    const code = linkOk ? this.motorCode : -1;
    let runKind: '' | 'excite' | 'loop' = '';
    let runLoopTarget: '' | 'vel' | 'pos' | 'pos_single' = '';
    if (this.runObj instanceof ExciteRun) {
      runKind = 'excite';
    } else if (this.runObj instanceof LoopRun) {
      runKind = 'loop';
      runLoopTarget = this.runObj.cfg.loop;
    }

    return {
      connected: this.bus !== null,
      busName: this.bus?.name ?? '',
      busStatus: this.bus ? this.busStatus : '未连接',
      bitrate: this.bus?.bitrate ?? null,
      pcanError: this.pcanError,
      driver: d ? d.summary() : null,
      code,
      codeText: d && d.caps.statusCode ? d.codeText(code) : '',
      isFault: d !== null && d.caps.statusCode && code >= 0 && d.isFault(code),
      enabled: this.active,
      active: this.active,
      sending: this.sending,
      rateHz: this.rateHz,
      txRate: this.sending ? this.txRate : 0.0,
      mode: this.mode,
      linkOk,
      running: this.runObj !== null,
      runKind,
      runLoopTarget,
      runTitle: this.runObj?.title ?? '',
      scanning: this.scan !== null,
      scanStage: this.scan?.stage ?? '',
      scanCurrent: this.scan?.progCur ?? 0,
      scanTotal: this.scan?.progTot ?? 1,
      queueCount: this.reqs.length + (this.pending ? 1 : 0),
      limits: { ...this.lim },
      limitsOk: this.limitsOk,
      blocked: this.configBlocked(),
      tripped: this.safety.tripped,
      tripReason: this.safety.reason,
      safetyLimits: { ...this.safety.limits },
      posMt: this.safety.pos,
      latency: this.latencyStats(),
      rawPeriodicActive: this.rawPeriodic !== null,
      logEnabled: this.logEnabled,
      latestSample: this.latestSample,
    };
  }

  private emitState(now: number): void {
    this.emit({ type: 'state', state: this.buildState(now) });
  }
}
