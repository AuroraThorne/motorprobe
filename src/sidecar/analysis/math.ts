export interface Complex {
  re: number;
  im: number;
}

export function cAdd(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}

export function cSub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}

export function cMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

export function cDiv(a: Complex, b: Complex): Complex {
  const den = b.re * b.re + b.im * b.im;
  if (den === 0) return { re: 0, im: 0 };
  return { re: (a.re * b.re + a.im * b.im) / den, im: (a.im * b.re - a.re * b.im) / den };
}

export function cConj(a: Complex): Complex {
  return { re: a.re, im: -a.im };
}

export function cAbs(a: Complex): number {
  return Math.hypot(a.re, a.im);
}

export function cAbs2(a: Complex): number {
  return a.re * a.re + a.im * a.im;
}

export function cArg(a: Complex): number {
  return Math.atan2(a.im, a.re);
}

export function cExpIm(theta: number): Complex {
  return { re: Math.cos(theta), im: Math.sin(theta) };
}

function fftRadix2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (sign * 2 * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1.0;
      let wIm = 0.0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextWRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextWRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Exact real-input FFT matching numpy.fft.rfft for arbitrary length N >= 1 (Bluestein chirp-z).
 */
export function rfft(x: Float64Array | number[]): Complex[] {
  const N = x.length;
  if (N === 0) return [];
  const outLen = Math.floor(N / 2) + 1;
  if ((N & (N - 1)) === 0) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[i];
    fftRadix2(re, im, false);
    const out: Complex[] = new Array(outLen);
    for (let k = 0; k < outLen; k++) {
      out[k] = { re: re[k], im: im[k] };
    }
    return out;
  }

  let M = 1;
  while (M < 2 * N - 1) M <<= 1;

  const wRe = new Float64Array(N);
  const wIm = new Float64Array(N);
  const twoN = 2 * N;
  for (let m = 0; m < N; m++) {
    const rem = (m * m) % twoN;
    const phi = (Math.PI * rem) / N;
    wRe[m] = Math.cos(phi);
    wIm[m] = -Math.sin(phi);
  }

  const aRe = new Float64Array(M);
  const aIm = new Float64Array(M);
  const bRe = new Float64Array(M);
  const bIm = new Float64Array(M);

  for (let n = 0; n < N; n++) {
    const xn = x[n];
    aRe[n] = xn * wRe[n];
    aIm[n] = xn * wIm[n];
  }
  bRe[0] = 1.0;
  bIm[0] = 0.0;
  for (let m = 1; m < N; m++) {
    bRe[m] = wRe[m];
    bIm[m] = -wIm[m];
    bRe[M - m] = wRe[m];
    bIm[M - m] = -wIm[m];
  }

  fftRadix2(aRe, aIm, false);
  fftRadix2(bRe, bIm, false);

  for (let i = 0; i < M; i++) {
    const cr = aRe[i] * bRe[i] - aIm[i] * bIm[i];
    const ci = aRe[i] * bIm[i] + aIm[i] * bRe[i];
    aRe[i] = cr;
    aIm[i] = ci;
  }

  fftRadix2(aRe, aIm, true);

  const out: Complex[] = new Array(outLen);
  for (let k = 0; k < outLen; k++) {
    out[k] = {
      re: aRe[k] * wRe[k] - aIm[k] * wIm[k],
      im: aRe[k] * wIm[k] + aIm[k] * wRe[k],
    };
  }
  return out;
}

export function rfftfreq(n: number, d = 1.0): number[] {
  const outLen = Math.floor(n / 2) + 1;
  const scale = 1.0 / (n * d);
  const out = new Array<number>(outLen);
  for (let k = 0; k < outLen; k++) {
    out[k] = k * scale;
  }
  return out;
}

/**
 * Householder QR linear least squares minimizing ||A * x - y||_2.
 * `cols` is an array of M column vectors, each of length N (N >= M).
 */
export function lstsqColumns(cols: number[][], y: number[]): number[] {
  const m = cols.length;
  const n = y.length;
  if (m === 0 || n < m) return new Array(m).fill(0);

  const R = cols.map((c) => Float64Array.from(c));
  const rhs = Float64Array.from(y);

  for (let k = 0; k < m; k++) {
    let norm2 = 0;
    for (let i = k; i < n; i++) {
      norm2 += R[k][i] * R[k][i];
    }
    const norm = Math.sqrt(norm2);
    if (norm < 1e-30) continue;

    const alpha = R[k][k] >= 0 ? -norm : norm;
    const v0 = R[k][k] - alpha;
    let vNorm2 = v0 * v0;
    for (let i = k + 1; i < n; i++) {
      vNorm2 += R[k][i] * R[k][i];
    }
    if (vNorm2 < 1e-60) continue;

    R[k][k] = alpha;
    // Apply Householder reflector to remaining columns j = k+1 .. m-1 and rhs
    for (let j = k + 1; j < m; j++) {
      let dot = v0 * R[j][k];
      for (let i = k + 1; i < n; i++) {
        dot += R[k][i] * R[j][i];
      }
      const scale = (2 * dot) / vNorm2;
      R[j][k] -= scale * v0;
      for (let i = k + 1; i < n; i++) {
        R[j][i] -= scale * R[k][i];
      }
    }

    let dotY = v0 * rhs[k];
    for (let i = k + 1; i < n; i++) {
      dotY += R[k][i] * rhs[i];
    }
    const scaleY = (2 * dotY) / vNorm2;
    rhs[k] -= scaleY * v0;
    for (let i = k + 1; i < n; i++) {
      rhs[i] -= scaleY * R[k][i];
    }
  }

  const sol = new Array<number>(m).fill(0);
  for (let k = m - 1; k >= 0; k--) {
    let s = rhs[k];
    for (let j = k + 1; j < m; j++) {
      s -= R[j][k] * sol[j];
    }
    sol[k] = Math.abs(R[k][k]) > 1e-18 ? s / R[k][k] : 0;
  }
  return sol;
}

export function linspace(start: number, stop: number, num: number): number[] {
  if (num <= 0) return [];
  if (num === 1) return [start];
  const step = (stop - start) / (num - 1);
  const out = new Array<number>(num);
  for (let i = 0; i < num; i++) out[i] = start + i * step;
  return out;
}

export function geomspace(start: number, stop: number, num: number): number[] {
  if (num <= 0) return [];
  if (num === 1) return [start];
  const ratio = stop / start;
  const out = new Array<number>(num);
  for (let i = 0; i < num; i++) {
    out[i] = start * Math.pow(ratio, i / (num - 1));
  }
  return out;
}

export function interp(xGrid: number[], xp: number[], fp: number[]): number[] {
  const n = xp.length;
  if (n === 0) return xGrid.map(() => 0);
  if (n === 1) return xGrid.map(() => fp[0]);
  const out = new Array<number>(xGrid.length);
  let j = 0;
  for (let i = 0; i < xGrid.length; i++) {
    const x = xGrid[i];
    if (x <= xp[0]) {
      out[i] = fp[0];
      continue;
    }
    if (x >= xp[n - 1]) {
      out[i] = fp[n - 1];
      continue;
    }
    while (j + 1 < n - 1 && xp[j + 1] < x) {
      j++;
    }
    const x0 = xp[j];
    const x1 = xp[j + 1];
    const ratio = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
    out[i] = fp[j] + ratio * (fp[j + 1] - fp[j]);
  }
  return out;
}

export function hanning(L: number): number[] {
  if (L <= 1) return [1];
  const out = new Array<number>(L);
  for (let i = 0; i < L; i++) {
    out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1));
  }
  return out;
}

export function unwrapRad(phases: number[]): number[] {
  if (phases.length === 0) return [];
  const out = new Array<number>(phases.length);
  out[0] = phases[0];
  let offset = 0;
  for (let i = 1; i < phases.length; i++) {
    const d = phases[i] - phases[i - 1];
    const wrapped = ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    offset += wrapped - d;
    out[i] = phases[i] + offset;
  }
  return out;
}

export function unwrapDeg(deg: number[]): number[] {
  const rad = deg.map((d) => (d * Math.PI) / 180);
  return unwrapRad(rad).map((r) => (r * 180) / Math.PI);
}

export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

export function detrendLinear(t: number[], y: number[]): number[] {
  const [slope, intercept] = lstsqColumns([t, new Array(t.length).fill(1)], y);
  return y.map((v, i) => v - (slope * t[i] + intercept));
}

export function boxcarSmoothSame(x: number[], halfWin: number): number[] {
  const w = 2 * halfWin + 1;
  const n = x.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -halfWin; j <= halfWin; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < n) {
        acc += x[idx];
      }
    }
    out[i] = acc / w;
  }
  return out;
}

export function gradient(y: number[], dt: number): number[] {
  const n = y.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const out = new Array<number>(n);
  out[0] = (y[1] - y[0]) / dt;
  for (let i = 1; i < n - 1; i++) {
    out[i] = (y[i + 1] - y[i - 1]) / (2 * dt);
  }
  out[n - 1] = (y[n - 1] - y[n - 2]) / dt;
  return out;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}
