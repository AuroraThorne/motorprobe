export interface Frame {
  t: number;
  canId: number;
  data: Uint8Array;
  tx: boolean;
  extended: boolean;
  rtr: boolean;
  dlc: number | null;
}

export function createFrame(
  t: number,
  canId: number,
  data: Uint8Array,
  opts: { tx?: boolean; extended?: boolean; rtr?: boolean; dlc?: number | null } = {},
): Frame {
  return {
    t,
    canId,
    data,
    tx: opts.tx ?? false,
    extended: opts.extended ?? false,
    rtr: opts.rtr ?? false,
    dlc: opts.dlc ?? null,
  };
}

export function wireDlc(f: Frame): number {
  return f.dlc === null ? f.data.length : f.dlc;
}

export function frameBits(f: Frame): number {
  const base = f.extended ? 67 : 47;
  const raw = base + 8 * wireDlc(f);
  return raw + Math.floor((raw + 4) / 5) + 3;
}

export function nowSec(): number {
  return performance.now() * 1e-3;
}

export class BusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusError';
  }
}

export interface CanBus {
  readonly name: string;
  readonly bitrate: number | null;
  open(): void;
  close(): void;
  send(canId: number, data: Uint8Array, extended?: boolean, rtr?: boolean, dlc?: number | null): void;
  recvAll(): Frame[];
  statusText(): string;
}
