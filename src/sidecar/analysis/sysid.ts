import {
  BodeData,
  LoopKind,
  ModelFit,
  PidSuggestion,
  PredictedClosedLoop,
  StepStats,
} from '../../shared/protocol';
import {
  boxcarSmoothSame,
  cAbs,
  cAbs2,
  cAdd,
  cArg,
  cConj,
  cDiv,
  cExpIm,
  cMul,
  Complex,
  detrendLinear,
  geomspace,
  gradient,
  hanning,
  interp,
  linspace,
  lstsqColumns,
  mean,
  rfft,
  rfftfreq,
  unwrapDeg,
  unwrapRad,
} from './math';
import { ExciteRun, RunRecord } from './runs';

export function formatModelText(m: Omit<ModelFit, 'text'>): string {
  const u = m.unit;
  return `J = ${Number(m.J.toPrecision(4))} ${u}·s²/rad，b = ${Number(m.b.toPrecision(4))} ${u}·s/rad，库仑摩擦 Fc = ${Number(m.Fc.toPrecision(4))} ${u}，等效延迟 Td = ${(m.Td * 1000).toFixed(2)} ms`;
}

export function makeModel(J: number, b: number, Fc: number, Td: number, unit = 'Nm'): ModelFit {
  const base = { J, b, Fc, Td, unit };
  return { ...base, text: formatModelText(base) };
}

function cleanRecordArrays(rec: RunRecord): {
  t: number[];
  u: number[];
  v: number[];
  p: number[];
  seg: number[];
} {
  const t: number[] = [];
  const u: number[] = [];
  const v: number[] = [];
  const p: number[] = [];
  const seg: number[] = [];
  for (let i = 0; i < rec.t.length; i++) {
    if (
      Number.isFinite(rec.t[i]) &&
      Number.isFinite(rec.u[i]) &&
      Number.isFinite(rec.vel[i]) &&
      Number.isFinite(rec.pos[i])
    ) {
      t.push(rec.t[i]);
      u.push(rec.u[i]);
      v.push(rec.vel[i]);
      p.push(rec.pos[i]);
      seg.push(rec.seg[i]);
    }
  }
  return { t, u, v, p, seg };
}

function sineFit(t: number[], y: number[], f: number): [Complex, number] {
  const w = 2 * Math.PI * f;
  const tMean = mean(t);
  const col0 = t.map((ti) => Math.sin(w * ti));
  const col1 = t.map((ti) => Math.cos(w * ti));
  const col2 = t.map(() => 1.0);
  const col3 = t.map((ti) => ti - tMean);
  const coef = lstsqColumns([col0, col1, col2, col3], y);
  let ssRes = 0.0;
  let ssTot = 0.0;
  for (let i = 0; i < t.length; i++) {
    const pred = coef[0] * col0[i] + coef[1] * col1[i] + coef[2] * col2[i] + coef[3] * col3[i];
    const trend = coef[2] * col2[i] + coef[3] * col3[i];
    const r = y[i] - pred;
    const yv = y[i] - trend;
    ssRes += r * r;
    ssTot += yv * yv;
  }
  const r2 = ssTot > 0 ? Math.max(0.0, 1.0 - ssRes / ssTot) : 0.0;
  return [{ re: coef[0], im: coef[1] }, r2];
}

export function bodeStepsine(run: ExciteRun): BodeData | null {
  const { t, u, v, p, seg } = cleanRecordArrays(run.snapshotRecord());
  const rows: Array<[number, number, number, number, number, number, number]> = [];
  for (let i = 0; i < run.segs.length; i++) {
    const [a, b, f] = run.segs[i];
    const settle = (b - a) * f >= 3 ? a + 1.0 / f : a + 0.3 * (b - a);
    const tu: number[] = [];
    const uu: number[] = [];
    const vu: number[] = [];
    const pu: number[] = [];
    for (let k = 0; k < t.length; k++) {
      if (seg[k] === i && t[k] >= settle) {
        tu.push(t[k]);
        uu.push(u[k]);
        vu.push(v[k]);
        pu.push(p[k]);
      }
    }
    if (tu.length < 8) continue;
    if (tu[tu.length - 1] - tu[0] < Math.min(1 / f, (b - settle) * 0.9)) continue;
    const [U, r2u] = sineFit(tu, uu, f);
    const [V, r2v] = sineFit(tu, vu, f);
    const [Pp, r2p] = sineFit(tu, pu, f);
    if (cAbs(U) < 1e-12) continue;
    const gv = cDiv(V, U);
    const gp = cDiv(Pp, U);
    rows.push([
      f,
      cAbs(gv),
      (cArg(gv) * 180) / Math.PI,
      cAbs(gp),
      (cArg(gp) * 180) / Math.PI,
      Math.min(r2u, r2v),
      Math.min(r2u, r2p),
    ]);
  }
  if (rows.length < 1) return null;
  return {
    f: rows.map((r) => r[0]),
    magV: rows.map((r) => r[1]),
    phV: unwrapDeg(rows.map((r) => r[2])),
    magP: rows.map((r) => r[3]),
    phP: unwrapDeg(rows.map((r) => r[4])),
    coh: rows.map((r) => r[5]),
    cohP: rows.map((r) => r[6]),
  };
}

export function bodeBroadband(run: ExciteRun, nper = 4): BodeData | null {
  const { t, u, v, p } = cleanRecordArrays(run.snapshotRecord());
  if (t.length < 64 || t[t.length - 1] <= t[0]) return null;
  const n = t.length;
  const fs = (n - 1) / (t[n - 1] - t[0]);
  const tg = linspace(t[0], t[n - 1], n);
  const ugRaw = interp(tg, t, u);
  const vgRaw = interp(tg, t, v);
  const pgRaw = interp(tg, t, p);

  const uMean = mean(ugRaw);
  const vMean = mean(vgRaw);
  const ug = ugRaw.map((x) => x - uMean);
  const vg = vgRaw.map((x) => x - vMean);
  const pg = detrendLinear(tg, pgRaw);

  const L = Math.max(64, Math.trunc(n / nper));
  const step = Math.max(1, Math.trunc(L / 2));
  const win = hanning(L);
  const nFreqBins = Math.floor(L / 2) + 1;

  const Suu = new Float64Array(nFreqBins);
  const Svv = new Float64Array(nFreqBins);
  const Spp = new Float64Array(nFreqBins);
  const SuvRe = new Float64Array(nFreqBins);
  const SuvIm = new Float64Array(nFreqBins);
  const SupRe = new Float64Array(nFreqBins);
  const SupIm = new Float64Array(nFreqBins);

  const segU = new Float64Array(L);
  const segV = new Float64Array(L);
  const segP = new Float64Array(L);

  for (let s0 = 0; s0 <= n - L; s0 += step) {
    for (let i = 0; i < L; i++) {
      const w = win[i];
      segU[i] = w * ug[s0 + i];
      segV[i] = w * vg[s0 + i];
      segP[i] = w * pg[s0 + i];
    }
    const U = rfft(segU);
    const V = rfft(segV);
    const Pq = rfft(segP);
    for (let k = 0; k < nFreqBins; k++) {
      Suu[k] += cAbs2(U[k]);
      Svv[k] += cAbs2(V[k]);
      Spp[k] += cAbs2(Pq[k]);
      const uv = cMul(cConj(U[k]), V[k]);
      SuvRe[k] += uv.re;
      SuvIm[k] += uv.im;
      const up = cMul(cConj(U[k]), Pq[k]);
      SupRe[k] += up.re;
      SupIm[k] += up.im;
    }
  }

  const freqs = rfftfreq(L, 1 / fs);
  let maxSuu = 0;
  for (let k = 0; k < nFreqBins; k++) {
    if (Suu[k] > maxSuu) maxSuu = Suu[k];
  }
  const c = run.cfg;
  const fm: number[] = [];
  const Gv: Complex[] = [];
  const Gp: Complex[] = [];
  const cohV: number[] = [];
  const cohP: number[] = [];

  for (let k = 0; k < nFreqBins; k++) {
    if (freqs[k] >= c.f0 && freqs[k] <= c.f1 && Suu[k] > 1e-12 * maxSuu) {
      fm.push(freqs[k]);
      const suv = { re: SuvRe[k], im: SuvIm[k] };
      const sup = { re: SupRe[k], im: SupIm[k] };
      Gv.push({ re: suv.re / Suu[k], im: suv.im / Suu[k] });
      Gp.push({ re: sup.re / Suu[k], im: sup.im / Suu[k] });
      cohV.push(cAbs2(suv) / (Suu[k] * Svv[k] + 1e-30));
      cohP.push(cAbs2(sup) / (Suu[k] * Spp[k] + 1e-30));
    }
  }
  if (fm.length < 3) return null;

  const edges = geomspace(fm[0], fm[fm.length - 1] * 1.0001, 21);
  const rows: Array<[number, number, number, number, number, number, number]> = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = edges[b];
    const hi = edges[b + 1];
    let cnt = 0;
    let sumF = 0;
    let gvSum: Complex = { re: 0, im: 0 };
    let gpSum: Complex = { re: 0, im: 0 };
    let cvSum = 0;
    let cpSum = 0;
    for (let i = 0; i < fm.length; i++) {
      if (fm[i] >= lo && fm[i] < hi) {
        cnt++;
        sumF += fm[i];
        gvSum = cAdd(gvSum, Gv[i]);
        gpSum = cAdd(gpSum, Gp[i]);
        cvSum += cohV[i];
        cpSum += cohP[i];
      }
    }
    if (cnt > 0) {
      const gvAvg = { re: gvSum.re / cnt, im: gvSum.im / cnt };
      const gpAvg = { re: gpSum.re / cnt, im: gpSum.im / cnt };
      rows.push([
        sumF / cnt,
        cAbs(gvAvg),
        (cArg(gvAvg) * 180) / Math.PI,
        cAbs(gpAvg),
        (cArg(gpAvg) * 180) / Math.PI,
        cvSum / cnt,
        cpSum / cnt,
      ]);
    }
  }
  if (rows.length < 3) return null;
  return {
    f: rows.map((r) => r[0]),
    magV: rows.map((r) => r[1]),
    phV: unwrapDeg(rows.map((r) => r[2])),
    magP: rows.map((r) => r[3]),
    phP: unwrapDeg(rows.map((r) => r[4])),
    coh: rows.map((r) => r[5]),
    cohP: rows.map((r) => r[6]),
  };
}

export function bodeFromRun(run: ExciteRun): BodeData | null {
  if (run.cfg.kind === 'stepsine') return bodeStepsine(run);
  if (run.cfg.kind === 'chirp' || run.cfg.kind === 'prbs') return bodeBroadband(run);
  return null;
}

export function fitModel(bode: BodeData, unit = 'Nm'): ModelFit | null {
  let indices: number[] = [];
  for (let i = 0; i < bode.f.length; i++) {
    if (bode.coh[i] > 0.5) indices.push(i);
  }
  if (indices.length < 2) {
    indices = bode.f.map((_, i) => i);
  }
  if (indices.length < 2) return null;

  const w = indices.map((i) => 2 * Math.PI * bode.f[i]);
  const inv2 = indices.map((i) => 1.0 / Math.max(1e-24, bode.magV[i] * bode.magV[i]));
  const sol = lstsqColumns(
    [
      w.map((wi) => wi * wi),
      w.map(() => 1.0),
    ],
    inv2,
  );
  const J = Math.sqrt(Math.max(sol[0], 1e-18));
  const b = Math.sqrt(Math.max(sol[1], 0.0));

  let num = 0.0;
  let den = 0.0;
  for (let idx = 0; idx < indices.length; idx++) {
    const i = indices[idx];
    const wi = w[idx];
    const phModel = -(Math.atan2(J * wi, b) * 180) / Math.PI;
    let res = ((bode.phV[i] - phModel) * Math.PI) / 180;
    res = ((((res + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    num += -res * wi;
    den += wi * wi;
  }
  const Td = den > 0 ? Math.max(0.0, num / den) : 0.0;
  return makeModel(J, b, 0.0, Td, unit);
}

export function stepModel(rec: RunRecord, unit = 'Nm'): ModelFit | null {
  const { t, u, v } = cleanRecordArrays(rec);
  if (t.length < 20 || t[t.length - 1] <= t[0]) return null;
  const tg = linspace(t[0], t[t.length - 1], t.length);
  const vg = interp(tg, t, v);
  const ug = interp(tg, t, u);
  const dt = tg[1] - tg[0];
  const k = Math.max(1, Math.trunc(0.004 / dt));
  const vs = boxcarSmoothSame(vg, k);
  const a = gradient(vs, dt);

  let maxAbsVs = 1e-9;
  for (let i = 0; i < vs.length; i++) {
    if (Math.abs(vs[i]) > maxAbsVs) maxAbsVs = Math.abs(vs[i]);
  }
  const colA: number[] = [];
  const colV: number[] = [];
  const colS: number[] = [];
  const rhsU: number[] = [];
  for (let i = k; i < vs.length - k; i++) {
    if (Math.abs(vs[i]) > 0.05 * maxAbsVs) {
      colA.push(a[i]);
      colV.push(vs[i]);
      colS.push(Math.sign(vs[i]));
      rhsU.push(ug[i]);
    }
  }
  if (colA.length < 10) return null;
  const [J, b, Fc] = lstsqColumns([colA, colV, colS], rhsU);
  if (!(J > 0)) return null;
  return makeModel(J, Math.max(b, 0.0), Math.max(Fc, 0.0), 0.0, unit);
}

function velocityOpenLoop(model: ModelFit, kp: number, ki: number, w: number, delay: number): Complex {
  const plant = cDiv(cExpIm(-w * delay), { re: model.b, im: model.J * w });
  const ctrl: Complex = { re: kp, im: -ki / w };
  return cMul(ctrl, plant);
}

function velocityClosedLoop(model: ModelFit, kp: number, ki: number, w: number, delay: number): Complex {
  const loop = velocityOpenLoop(model, kp, ki, w, delay);
  return cDiv(loop, { re: 1.0 + loop.re, im: loop.im });
}

function positionOpenLoop(
  model: ModelFit,
  kp: number,
  ki: number,
  kd: number,
  w: number,
  delay: number,
): Complex {
  // (J*jw + b)*(jw) = -J*w^2 + j*b*w
  const den: Complex = { re: -model.J * w * w, im: model.b * w };
  const plant = cDiv(cExpIm(-w * delay), den);
  const ctrl: Complex = { re: kp, im: kd * w - ki / w };
  return cMul(ctrl, plant);
}

function positionClosedLoop(
  model: ModelFit,
  kp: number,
  ki: number,
  kd: number,
  w: number,
  delay: number,
): Complex {
  const loop = positionOpenLoop(model, kp, ki, kd, w, delay);
  return cDiv(loop, { re: 1.0 + loop.re, im: loop.im });
}

function phaseMargin(loopFn: (w: number) => Complex, rateHz: number): number {
  const fmax = Math.max(1.0, rateHz / 2.0);
  const ws = geomspace(2.0 * Math.PI * 1e-3, 2.0 * Math.PI * fmax, 2400);
  const vals = ws.map((w) => loopFn(w));
  const logMag = vals.map((z) => Math.log(Math.max(cAbs(z), 1e-30)));
  const phase = unwrapRad(vals.map((z) => cArg(z)));

  let crossIdx = -1;
  for (let i = 0; i < logMag.length - 1; i++) {
    if (logMag[i] >= 0.0 && logMag[i + 1] < 0.0) {
      crossIdx = i;
      break;
    }
  }
  if (crossIdx < 0) {
    let minI = 0;
    let minVal = Math.abs(logMag[0]);
    for (let i = 1; i < logMag.length; i++) {
      if (Math.abs(logMag[i]) < minVal) {
        minVal = Math.abs(logMag[i]);
        minI = i;
      }
    }
    return 180.0 + (phase[minI] * 180) / Math.PI;
  }
  const a = logMag[crossIdx];
  const b = logMag[crossIdx + 1];
  let ratio = Math.abs(b - a) < 1e-12 ? 0.0 : -a / (b - a);
  ratio = Math.max(0.0, Math.min(1.0, ratio));
  const phCross = phase[crossIdx] + ratio * (phase[crossIdx + 1] - phase[crossIdx]);
  return 180.0 + (phCross * 180) / Math.PI;
}

function closedLoopBandwidthFrom(
  loopFn: (w: number) => Complex,
  targetW: number,
  rateHz: number,
): number {
  const low = Math.max(1e-3, targetW / 1000.0);
  const high = Math.max(targetW * 10.0, (2.0 * Math.PI * rateHz) / 2.0);
  const ws = geomspace(low, high, 1600);
  const invSqrt2 = 1.0 / Math.SQRT2;
  const mag = ws.map((w) => cAbs(loopFn(w)));
  let hit = -1;
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] <= invSqrt2) {
      hit = i;
      break;
    }
  }
  if (hit < 0) return targetW;
  if (hit === 0) return ws[0];
  const a = Math.log(ws[hit - 1]);
  const b = Math.log(ws[hit]);
  const ma = mag[hit - 1];
  const mb = mag[hit];
  if (Math.abs(mb - ma) < 1e-12) return ws[hit];
  const ratio = Math.max(0.0, Math.min(1.0, (invSqrt2 - ma) / (mb - ma)));
  return Math.exp(a + ratio * (b - a));
}

function singlePositionGains(
  model: ModelFit,
  crossoverW: number,
  delay: number,
  pmDeg: number,
): [number, number, number] {
  const den: Complex = { re: -model.J * crossoverW * crossoverW, im: model.b * crossoverW };
  const plant = cDiv(cExpIm(-crossoverW * delay), den);
  const phaseP = cArg(plant);
  let desired = ((-180.0 + pmDeg) * Math.PI) / 180 - phaseP;
  desired = Math.max(Math.PI / 180, Math.min((89.0 * Math.PI) / 180, desired));
  const lead = Math.tan(desired);
  const kp = 1.0 / (cAbs(plant) * Math.sqrt(1.0 + lead * lead));
  const kd = (kp * lead) / crossoverW;
  return [kp, 0.0, kd];
}

function singlePositionPid(
  model: ModelFit,
  delay: number,
  rateHz: number,
  targetBwHz: number,
  pmDeg: number,
): [number, number, number, number, number] {
  const targetW = 2.0 * Math.PI * Math.max(0.01, targetBwHz);
  let lo = 2.0 * Math.PI * 0.01;
  let hi = (2.0 * Math.PI * rateHz) / 10.0;

  const actual = (cw: number): number => {
    const [kp, ki, kd] = singlePositionGains(model, cw, delay, pmDeg);
    return closedLoopBandwidthFrom((w) => positionClosedLoop(model, kp, ki, kd, w, delay), cw, rateHz);
  };

  let crossover = lo;
  if (targetW <= actual(lo)) {
    crossover = lo;
  } else if (targetW >= actual(hi)) {
    crossover = hi;
  } else {
    for (let iter = 0; iter < 48; iter++) {
      const mid = 0.5 * (lo + hi);
      if (actual(mid) < targetW) lo = mid;
      else hi = mid;
    }
    crossover = 0.5 * (lo + hi);
  }
  const [kp, ki, kd] = singlePositionGains(model, crossover, delay, pmDeg);
  const bw = closedLoopBandwidthFrom((w) => positionClosedLoop(model, kp, ki, kd, w, delay), crossover, rateHz);
  const pm = phaseMargin((w) => positionOpenLoop(model, kp, ki, kd, w, delay), rateHz);
  return [kp, ki, kd, bw / (2 * Math.PI), pm];
}

function velocityGains(model: ModelFit, crossoverW: number): [number, number] {
  const mag = Math.hypot(model.J * crossoverW, model.b);
  return [mag, (mag * crossoverW) / 5.0];
}

function crossoverForVelocityBandwidth(
  model: ModelFit,
  targetW: number,
  delay: number,
  rateHz: number,
): number {
  let lo = 2.0 * Math.PI * 0.01;
  let hi = (2.0 * Math.PI * rateHz) / 10.0;
  const actual = (cw: number): number => {
    const [kp, ki] = velocityGains(model, cw);
    return closedLoopBandwidthFrom((w) => velocityClosedLoop(model, kp, ki, w, delay), cw, rateHz);
  };
  if (targetW <= actual(lo)) return lo;
  if (targetW >= actual(hi)) return hi;
  for (let iter = 0; iter < 48; iter++) {
    const mid = 0.5 * (lo + hi);
    if (actual(mid) < targetW) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function cascadePositionPid(
  model: ModelFit,
  velKp: number,
  velKi: number,
  velBwRad: number,
  delay: number,
  rateHz: number,
  pmDeg: number,
): [number, number, number, number, number] {
  const innerBw = closedLoopBandwidthFrom(
    (w) => velocityClosedLoop(model, velKp, velKi, w, delay),
    velBwRad,
    rateHz,
  );
  const maxW = Math.min(innerBw / 3.0, (2.0 * Math.PI * rateHz) / 20.0);
  if (maxW <= 0) {
    return [1.0, 0.0, 0.0, Math.max(0.01, velBwRad / (2 * Math.PI * 4.0)), 0.0];
  }
  const minW = Math.max(maxW / 1000.0, 2.0 * Math.PI * 0.05);
  const ws = geomspace(minW, maxW, 700);
  let chosen: [number, number, number, number, number] | null = null;
  let fallback: [number, number, number, number, number] = [1, 0, 0, 0.1, 0];
  const zeroRatio = 5.0;
  const normalized: Complex = { re: 1.0, im: -1.0 / zeroRatio };
  for (const w of ws) {
    const hv = velocityClosedLoop(model, velKp, velKi, w, delay);
    const outerPlant = cDiv(hv, { re: 0, im: w });
    const kp = 1.0 / Math.max(cAbs(cMul(outerPlant, normalized)), 1e-12);
    const ki = (kp * w) / zeroRatio;
    const loop = cMul({ re: kp, im: -ki / w }, outerPlant);
    const pm = 180.0 + (cArg(loop) * 180) / Math.PI;
    const cand: [number, number, number, number, number] = [kp, 0.0, ki, w / (2 * Math.PI), pm];
    fallback = cand;
    if (pm >= pmDeg) chosen = cand;
  }
  return chosen ?? fallback;
}

export function suggest(
  model: ModelFit,
  opts: {
    latency?: number;
    rateHz?: number;
    pmDeg?: number;
    velBwHz?: number | null;
    startRatio?: number;
    singlePosBwHz?: number | null;
  } = {},
): PidSuggestion {
  const latency = opts.latency ?? 0.003;
  const rateHz = opts.rateHz ?? 500.0;
  const pmDeg = opts.pmDeg ?? 55.0;
  const velBwHz = opts.velBwHz ?? null;
  const startRatio = opts.startRatio ?? 1.0;
  const singlePosBwHz = opts.singlePosBwHz ?? null;

  const T = Math.max(0.0, model.Td) + Math.max(0.0, latency) + 0.5 / Math.max(rateHz, 1.0);
  let wv: number;
  let requested: number | null = null;
  if (velBwHz === null) {
    const budgetV = ((180 - pmDeg - 90 - 11.3) * Math.PI) / 180;
    wv = T > 0 ? budgetV / T : 2 * Math.PI * 50;
  } else {
    requested = Math.max(0.01, velBwHz);
    wv = crossoverForVelocityBandwidth(model, 2 * Math.PI * requested, T, rateHz);
  }
  wv = Math.min(wv, (2 * Math.PI * rateHz) / 10);

  const [vkp, vki] = velocityGains(model, wv);
  const innerBw = closedLoopBandwidthFrom((w) => velocityClosedLoop(model, vkp, vki, w, T), wv, rateHz);
  const [pkp, pkd, pki, posBw] = cascadePositionPid(model, vkp, vki, innerBw, T, rateHz, pmDeg);
  const singleTarget = singlePosBwHz !== null ? singlePosBwHz : posBw;
  const [skp, ski, skd, singleBw, singlePm] = singlePositionPid(model, T, rateHz, singleTarget, pmDeg);

  const velPm = phaseMargin((w) => velocityOpenLoop(model, vkp, vki, w, T), rateHz);
  const posPm = phaseMargin(
    (w) =>
      cMul(
        { re: pkp, im: pkd * w - pki / w },
        cDiv(velocityClosedLoop(model, vkp, vki, w, T), { re: 0, im: w }),
      ),
    rateHz,
  );

  const actualTarget = innerBw / (2 * Math.PI);
  const reqText = requested !== null ? `速度环期望带宽 ${requested.toFixed(1)} Hz；` : '';
  const ratio = Math.max(0.0, Math.min(1.0, startRatio));
  const note =
    `依据：${model.text}；已组合内环速度 PI 的实际闭环模型，` +
    `内环 -3 dB 带宽约 ${actualTarget.toFixed(1)} Hz；${reqText}` +
    `总延迟估计 ${(T * 1000).toFixed(1)} ms（含通信 ${(latency * 1000).toFixed(1)} ms、` +
    `半周期 ${(500 / rateHz).toFixed(1)} ms），目标相位裕度 ${pmDeg.toFixed(0)}°。` +
    `库仑摩擦未补偿；内外环建议均从计算值的 ${(ratio * 100).toFixed(0)}% 起步。`;

  const u = model.unit;
  const text =
    `速度环 PI（带宽 ${actualTarget.toFixed(1)} Hz）：Kp = ${Number(vkp.toPrecision(4))} ${u}/(rad/s)，Ki = ${Number(vki.toPrecision(4))} ${u}/rad\n` +
    `串级位置环外环 PID（带宽 ${posBw.toFixed(1)} Hz）：Kp = ${Number(pkp.toPrecision(4))} (rad/s)/rad，Kd = ${Number(pkd.toPrecision(4))} (rad/s)/(rad/s)，Ki = ${Number(pki.toPrecision(4))} (rad/s)/(rad·s)\n` +
    `实际相位裕度：速度内环 ${Number(velPm.toPrecision(4))}°，位置外环 ${Number(posPm.toPrecision(4))}°\n` +
    note;

  return {
    velKp: vkp,
    velKi: vki,
    velBw: actualTarget,
    posKp: pkp,
    posKd: pkd,
    posKi: pki,
    posBw,
    unit: u,
    note,
    startRatio: ratio,
    phaseMargin: posPm,
    velPhaseMargin: velPm,
    posPhaseMargin: posPm,
    singlePosKp: skp,
    singlePosKi: ski,
    singlePosKd: skd,
    singlePosBw: singleBw,
    singlePosPhaseMargin: singlePm,
    text,
  };
}

export function predictedClosedLoop(
  model: ModelFit,
  sugg: PidSuggestion,
  latency = 0.003,
  rateHz = 500.0,
  fmin = 0.05,
  fmax?: number,
  count = 500,
): PredictedClosedLoop {
  const delay = Math.max(0.0, model.Td) + Math.max(0.0, latency) + 0.5 / Math.max(rateHz, 1.0);
  const maxBw = Math.max(sugg.velBw, sugg.posBw, sugg.singlePosBw, 0.1);
  const resolvedFmax = Math.max(
    fmin * 10.0,
    fmax ?? Math.min(Math.max(100.0, maxBw * 20.0), rateHz / 2.0),
  );
  const f = geomspace(Math.max(1e-3, fmin), resolvedFmax, Math.max(32, Math.trunc(count)));
  const velDb: number[] = [];
  const posDb: number[] = [];
  const singlePosDb: number[] = [];
  const toDb = (m: number): number => 20.0 * Math.log10(Math.max(m, 1e-12));

  for (const hz of f) {
    const w = 2.0 * Math.PI * hz;
    const hv = velocityClosedLoop(model, sugg.velKp, sugg.velKi, w, delay);
    const outerPlant = cDiv(hv, { re: 0, im: w });
    const outerCtrl: Complex = { re: sugg.posKp, im: sugg.posKd * w - sugg.posKi / w };
    const ol = cMul(outerCtrl, outerPlant);
    const hp = cDiv(ol, { re: 1.0 + ol.re, im: ol.im });
    const hs = positionClosedLoop(model, sugg.singlePosKp, sugg.singlePosKi, sugg.singlePosKd, w, delay);
    velDb.push(toDb(cAbs(hv)));
    posDb.push(toDb(cAbs(hp)));
    singlePosDb.push(toDb(cAbs(hs)));
  }
  return { f, velDb, posDb, singlePosDb };
}

export function loopStats(rec: RunRecord, loop: LoopKind): StepStats | null {
  const t: number[] = [];
  const r: number[] = [];
  const y: number[] = [];
  const srcY = loop === 'vel' ? rec.vel : rec.pos;
  for (let i = 0; i < rec.t.length; i++) {
    if (Number.isFinite(rec.ref[i]) && Number.isFinite(srcY[i])) {
      t.push(rec.t[i]);
      r.push(rec.ref[i]);
      y.push(srcY[i]);
    }
  }
  if (t.length < 10) return null;

  const e = r.map((ri, i) => ri - y[i]);
  let e2 = 0;
  for (const ei of e) e2 += ei * ei;
  const rmsErr = Math.sqrt(e2 / e.length);

  let maxDr = 0;
  let k0 = 1;
  for (let i = 1; i < r.length; i++) {
    const dr = Math.abs(r[i] - r[i - 1]);
    if (dr > maxDr) {
      maxDr = dr;
      k0 = i;
    }
  }
  const y0 = y[Math.max(0, k0 - 1)];
  const span = r[k0] - y0;
  const tailSlice = e.slice(e.length - Math.max(3, Math.trunc(e.length / 10)));
  const ssErr = mean(tailSlice);

  if (maxDr < 1e-12 || Math.abs(span) < 1e-12) {
    return { rise: null, overshoot: 0.0, settle: null, ssErr, rmsErr };
  }

  const yn = y.slice(k0).map((yi) => (yi - y0) / span);
  const tt = t.slice(k0);
  const i10 = yn.findIndex((v) => v >= 0.1);
  const i90 = yn.findIndex((v) => v >= 0.9);
  const rise = i10 >= 0 && i90 >= 0 ? tt[i90] - tt[i10] : null;
  const overshoot = Math.max(0.0, (Math.max(...yn) - 1.0) * 100.0);

  let lastOutIdx = -1;
  for (let i = 0; i < yn.length; i++) {
    if (Math.abs(yn[i] - 1.0) > 0.02) lastOutIdx = i;
  }
  let settle: number | null;
  if (lastOutIdx === yn.length - 1) {
    settle = null;
  } else if (lastOutIdx < 0) {
    settle = tt[0] - t[k0];
  } else {
    settle = tt[lastOutIdx + 1] - t[k0];
  }

  return { rise, overshoot, settle, ssErr, rmsErr };
}
