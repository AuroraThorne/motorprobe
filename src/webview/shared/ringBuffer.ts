import { SAMPLE_STRIDE } from '../../shared/protocol';

/**
 * High-throughput columnar Float64Array ring buffer (200,000 samples x 14 cols)
 * designed for zero-GC uPlot rendering.
 */
export class ColumnRingBuffer {
  readonly cols: Float64Array[];
  private head = 0;
  count = 0;
  t0: number | null = null;
  version = 0;

  constructor(public readonly capacity = 200_000) {
    this.cols = Array.from({ length: SAMPLE_STRIDE }, () => new Float64Array(capacity));
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.t0 = null;
    this.version += 1;
  }

  appendFlat(flat: number[]): void {
    const rows = Math.trunc(flat.length / SAMPLE_STRIDE);
    if (rows <= 0) return;
    if (this.t0 === null) {
      this.t0 = flat[0];
    }
    const baseT = this.t0;
    for (let r = 0; r < rows; r++) {
      const srcBase = r * SAMPLE_STRIDE;
      const dst = this.head;
      this.cols[0][dst] = Math.max(0, flat[srcBase] - baseT);
      for (let c = 1; c < SAMPLE_STRIDE; c++) {
        const v = flat[srcBase + c];
        this.cols[c][dst] = v === null || v === undefined ? Number.NaN : v;
      }
      this.head = (dst + 1) % this.capacity;
      if (this.count < this.capacity) {
        this.count += 1;
      }
    }
    this.version += 1;
  }

  /**
   * Materializes contiguous chronological Float64Arrays for uPlot.
   */
  orderedColumns(colIndices: number[]): Float64Array[] {
    const n = this.count;
    if (n === 0) {
      return colIndices.map(() => new Float64Array(0));
    }
    if (n < this.capacity) {
      return colIndices.map((ci) => this.cols[ci].subarray(0, n));
    }
    const tailLen = this.capacity - this.head;
    return colIndices.map((ci) => {
      const src = this.cols[ci];
      const out = new Float64Array(this.capacity);
      out.set(src.subarray(this.head), 0);
      out.set(src.subarray(0, this.head), tailLen);
      return out;
    });
  }

  timeBounds(): { min: number; max: number } {
    if (this.count === 0) return { min: 0, max: 10 };
    const firstIdx = this.count < this.capacity ? 0 : this.head;
    const lastIdx = (this.head - 1 + this.capacity) % this.capacity;
    return {
      min: this.cols[0][firstIdx],
      max: this.cols[0][lastIdx],
    };
  }
}
