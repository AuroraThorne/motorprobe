import { describe, expect, it } from 'vitest';
import { EngineEvent, ExciteConfig, ScanEntry } from '../src/shared/protocol';
import { Engine } from '../src/sidecar/engine';
import { makeDriver } from '../src/sidecar/drivers/catalog';
import { DemoBus, DjiSimMotor, DmSimMotor, GdSimMotor } from '../src/sidecar/sim/demo';

async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 8));
  }
  return pred();
}

describe('Engine integration with 2 kHz DemoBus', () => {
  it('reads HM limits, latches E-Stop until confirmation, and supports MIT mode', async () => {
    const events: EngineEvent[] = [];
    const regs: Array<{ kind: string; rid: number; value: unknown; error: string }> = [];
    const engine = new Engine((ev) => {
      events.push(ev);
      if (ev.type === 'regResult') {
        regs.push({ kind: ev.kind, rid: ev.rid, value: ev.value, error: ev.error });
      }
    });
    const bus = new DemoBus();
    try {
      engine.connectBus(bus, '演示台');
      engine.doSetDriver(makeDriver('dm', 'HM9816G9', 1, 0));

      expect(await waitUntil(() => engine.limitsOk && engine.lastFb !== null, 2000)).toBe(true);
      expect(Math.abs(engine.lim.pMax - Math.PI)).toBeLessThan(1e-5);

      engine.doReadReg(0x3c);
      engine.doReadReg(0x0a); // HM lacks CTRL_MODE -> timeout
      engine.doWriteReg(0x09, 0);
      engine.doWriteReg(0x14, 5.0); // read-only in software
      engine.doSaveRegs();

      expect(await waitUntil(() => regs.length >= 3 + 5, 2500)).toBe(true);
      const vbus = regs.find((r) => r.kind === 'read' && r.rid === 0x3c);
      expect(Number(vbus?.value)).toBeCloseTo(24.0, 0);
      const noCtrlMode = regs.find((r) => r.kind === 'read' && r.rid === 0x0a);
      expect(noCtrlMode?.error).toBeTruthy();
      const roErr = regs.find((r) => r.kind === 'write' && r.rid === 0x14);
      expect(roErr?.error).toContain('只读');
      const saved = regs.find((r) => r.kind === 'save');
      expect(saved?.value).toBe(true);

      // Pure torque + E-Stop latch without disabling motor
      const hmSim = bus.motor(DmSimMotor, 1);
      engine.handleCommand({ type: 'setTargetOut', value: 0.5 });
      engine.doEnable();
      expect(await waitUntil(() => engine.active, 800)).toBe(true);
      await new Promise((r) => setTimeout(r, 120));
      expect(Math.abs(hmSim.cmd.t - 0.5)).toBeLessThan(0.05);

      engine.doEstop('测试急停');
      await new Promise((r) => setTimeout(r, 100));
      expect(hmSim.enabled).toBe(true);
      expect(engine.safety.tripped).toBe(true);
      expect(Math.abs(hmSim.cmd.t)).toBeLessThan(0.05);

      // A latched E-Stop blocks later targets until the user explicitly confirms reset.
      engine.handleCommand({ type: 'setTargetOut', value: 0.5 });
      await new Promise((r) => setTimeout(r, 120));
      expect(Math.abs(hmSim.cmd.t)).toBeLessThan(0.05);
      engine.handleCommand({ type: 'resetSafety' });
      expect(engine.safety.tripped).toBe(false);
      engine.handleCommand({ type: 'setTargetOut', value: 0.5 });
      await new Promise((r) => setTimeout(r, 100));
      expect(Math.abs(hmSim.cmd.t - 0.5)).toBeLessThan(0.05);

      // MIT position mode
      engine.handleCommand({ type: 'setMode', mode: 'mit' });
      engine.handleCommand({ type: 'setTargetMit', cmd: { p: 0.4, v: 0, kp: 20, kd: 1, t: 0 } });
      expect(
        await waitUntil(() => engine.lastFb !== null && Math.abs(engine.lastFb.pos - 0.4) < 0.08, 2500),
      ).toBe(true);

      engine.doDisable();
      expect(await waitUntil(() => !hmSim.enabled, 800)).toBe(true);
    } finally {
      engine.shutdown();
    }
  });

  it('scans DemoBus DJI, Damiao/HM, and GD extended-frame motors', async () => {
    let scanResult: ScanEntry[] | null = null;
    const engine = new Engine((ev) => {
      if (ev.type === 'scanDone') scanResult = ev.entries;
    });
    const bus = new DemoBus();
    try {
      engine.connectBus(bus, '演示台');
      engine.doScan([1, 2, 3, 4, 5, 6, 7], 0.015, 0.25, true);
      expect(await waitUntil(() => scanResult !== null, 4500)).toBe(true);

      const dmHm = scanResult!.find((e) => e.protocol === 'dm' && e.motorId === 1);
      expect(dmHm?.model).toBe('HM9816G9');
      const dmJ8 = scanResult!.find((e) => e.protocol === 'dm' && e.motorId === 3);
      expect(dmJ8?.model).toBe('DM-J8009P');
      expect(dmJ8?.masterId).toBe(0x13);

      const djiFbIds = scanResult!.filter((e) => e.protocol === 'dji').map((e) => e.fbId).sort();
      expect(djiFbIds).toEqual([0x201, 0x202, 0x205, 0x206]);
      expect(scanResult!.filter((e) => e.protocol === 'gd').map((e) => [e.model, e.motorId])).toEqual([
        ['GD 5036（通用）', 6],
        ['GD 6036（通用）', 7],
      ]);
    } finally {
      engine.shutdown();
    }
  });

  it('controls DJI M3508 current with safety clamping', async () => {
    const engine = new Engine(() => {});
    const bus = new DemoBus();
    try {
      engine.connectBus(bus, '演示台');
      engine.doSetDriver(makeDriver('dji', 'M3508 (C620)', 1));
      const m = bus.motor(DjiSimMotor, 1);

      expect(await waitUntil(() => engine.lastFb !== null, 800)).toBe(true);
      engine.handleCommand({
        type: 'setSafetyLimits',
        limits: { ...engine.safety.limits, outEnabled: true, outMax: 1.0 },
      });
      engine.handleCommand({ type: 'setTargetOut', value: 2.0 });
      engine.doEnable();
      expect(await waitUntil(() => Math.abs(m.cur - 1.0) < 0.02, 600)).toBe(true); // clamped to +-1A default

      engine.handleCommand({
        type: 'setSafetyLimits',
        limits: {
          velMax: 100,
          posEnabled: false,
          posMin: -6,
          posMax: 6,
          outMax: 5.0,
          tempMax: 0,
          fbTimeout: 0.1,
          velEnabled: true,
          outEnabled: true,
        },
      });
      expect(await waitUntil(() => Math.abs(m.cur - 2.0) < 0.02 && engine.lastFb!.vel > 0.5, 1500)).toBe(true);

      engine.doDisable();
      expect(await waitUntil(() => m.cur === 0.0, 500)).toBe(true);
    } finally {
      engine.shutdown();
    }
  });

  it('records non-negative time and usable Bode points for the 5 s 1–30 Hz sweep shown in the UI', async () => {
    let result: Extract<EngineEvent, { type: 'runAnalysis' }>['payload'] | null = null;
    const progress: Extract<EngineEvent, { type: 'runAnalysis' }>['payload'][] = [];
    const engine = new Engine((event) => {
      if (event.type === 'runAnalysis' && event.payload.done) result = event.payload;
      if (event.type === 'runAnalysis' && !event.payload.done) progress.push(event.payload);
    });
    const bus = new DemoBus();
    const cfg: ExciteConfig = {
      kind: 'chirp', amp: 1.5, stepOn: 0.3, stepDelay: 0.05, stepTail: 0.5,
      f0: 1, f1: 30, nFreq: 20, cycles: 5, minSeg: 0.3, duration: 5,
      prbsDt: 0.01, seed: 1,
    };
    try {
      engine.connectBus(bus, '演示台');
      engine.doSetDriver(makeDriver('dji', 'GM6020 (电流模式)', 2));
      expect(await waitUntil(() => engine.lastFb !== null, 800)).toBe(true);
      engine.doEnable();
      engine.handleCommand({
        type: 'startExciteRun', cfg, pmDeg: 55, velBwHz: null, singlePosBwHz: null, startRatio: 0.5,
      });
      expect(await waitUntil(() => result !== null, 7500)).toBe(true);
      expect(result!.bode).not.toBeNull();
      expect(result!.bode!.f.length).toBeGreaterThanOrEqual(3);
      expect(result!.record.t.every((time) => time >= 0)).toBe(true);
      expect(result!.record.u.length).toBeGreaterThan(100);
      expect(result!.record.vel.length).toBe(result!.record.u.length);
      expect(progress.some((payload) => (payload.bode?.f.length ?? 0) >= 3)).toBe(true);
      expect(progress.filter((payload) => payload.record.t.length > 0).length).toBeGreaterThan(1);
      expect(progress.every((payload) => !payload.model && !payload.predicted && !payload.suggestion)).toBe(true);
      expect(result!.model).not.toBeNull();
      expect(result!.predicted!.f.length).toBeGreaterThan(1);
    } finally {
      engine.shutdown();
    }
  }, 10_000);

  it('runs the GD extended-frame torque driver on DemoBus with a zero-torque E-Stop', async () => {
    const engine = new Engine(() => {});
    const bus = new DemoBus();
    try {
      engine.connectBus(bus, '演示台');
      engine.doSetDriver(makeDriver('gd', 'GD 5036-02-CNE', 6));
      const motor = bus.motor(GdSimMotor, 6);
      expect(await waitUntil(() => engine.lastFb !== null, 1000)).toBe(true);
      expect(engine.lastFb?.temp).toBe(Number.NaN);
      engine.handleCommand({ type: 'setTargetOut', value: 0.5 });
      engine.doEnable();
      expect(await waitUntil(() => Math.abs(engine.lastFb!.out - 0.5) < 0.02, 1000)).toBe(true);
      expect(motor.directTorque).toBe(true);
      engine.doEstop('GD 演示台急停');
      expect(engine.safety.tripped).toBe(true);
      expect(await waitUntil(() => Math.abs(engine.lastFb!.out) < 0.02, 500)).toBe(true);
    } finally {
      engine.shutdown();
    }
  });
});
