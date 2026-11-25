import { fork } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EngineCommand, EngineEvent, RunAnalysisPayload, ScanEntry } from '../src/shared/protocol';

describe('Compiled dist/sidecar.js child_process.fork IPC & Deadman Switch', () => {
  it('spawns isolated sidecar process, scans DemoBus, runs SysID + Closed-Loop over IPC, and exits cleanly on disconnect', async () => {
    const sidecarPath = path.resolve(__dirname, '..', 'dist', 'sidecar.js');
    const child = fork(sidecarPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

    let channelsReceived = false;
    let scanEntries: ScanEntry[] | null = null;
    let sampleBatches = 0;
    let analysisDone: RunAnalysisPayload | null = null;

    child.on('message', (msg: EngineEvent) => {
      if (msg.type === 'channels') channelsReceived = true;
      if (msg.type === 'scanDone') scanEntries = msg.entries;
      if (msg.type === 'samples') sampleBatches += 1;
      if (msg.type === 'runAnalysis' && msg.payload.done) analysisDone = msg.payload;
    });

    const send = (cmd: EngineCommand) => child.send(cmd);
    const wait = async (pred: () => boolean, ms = 5000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 15));
      }
      return pred();
    };

    try {
      expect(await wait(() => channelsReceived, 2000)).toBe(true);

      send({
        type: 'connect',
        params: {
          kind: 'sim',
          channel: 0,
          channelName: '演示台',
          baudKey: '1M',
          baud: 0x0014,
          bitrate: 1_000_000,
        },
      });

      expect(await wait(() => scanEntries !== null, 5000)).toBe(true);
      expect(scanEntries!.length).toBeGreaterThanOrEqual(5);

      send({
        type: 'selectMotor',
        spec: { protocol: 'dji', model: 'M3508 (C620)', motorId: 1, masterId: -1 },
      });
      send({
        type: 'setSafetyLimits',
        limits: {
          velMax: 60,
          posEnabled: false,
          posMin: -6,
          posMax: 6,
          outMax: 6,
          tempMax: 0,
          fbTimeout: 0.2,
          velEnabled: true,
          outEnabled: true,
        },
      });
      send({ type: 'enable' });
      expect(await wait(() => sampleBatches >= 2, 1500)).toBe(true);

      // Run quick closed-loop velocity step over IPC
      send({
        type: 'startLoopRun',
        cfg: {
          loop: 'vel',
          kp: 0.8,
          ki: 2.0,
          kd: 0,
          refKind: 'step',
          amp: 5.0,
          freq: 1.0,
          rampTime: 1.0,
          delay: 0,
          duration: 0.6,
          outMax: 5.0,
          integralMax: 5.0,
          ff: 0,
          errFc: 0,
          dFc: 0,
          posKp: null,
          posKi: null,
          posKd: null,
          posFf: 0,
          posIntegralMax: 0,
          posOutMax: 30,
          posErrFc: 0,
          posDFc: 0,
          relative: true,
          dOnMeas: true,
          stepValues: [],
          stepDurations: [],
        },
      });

      expect(await wait(() => analysisDone !== null, 3000)).toBe(true);
      expect(analysisDone!.runKind).toBe('loop');
      expect(analysisDone!.record.t.length).toBeGreaterThan(20);

      // Verify Deadman Switch: disconnecting IPC causes sidecar to self-terminate with exit code 0
      const exitCodePromise = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
      });
      child.disconnect();
      const code = await exitCodePromise;
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  });
});
