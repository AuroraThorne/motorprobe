import { DriverCaps, DriverSummary, MitCommand } from '../../shared/protocol';

export type FrameTuple = [canId: number, data: Uint8Array, extended?: boolean];

export interface Feedback {
  pos: number;
  vel: number;
  out: number;
  temp: number;
  temp2: number;
  code: number;
  enabled: boolean | null;
  motorId: number;
  raw: Uint8Array;
}

export function maxTemp(fb: Feedback): number {
  const vals = [fb.temp, fb.temp2].filter((x) => !Number.isNaN(x));
  return vals.length > 0 ? Math.max(...vals) : 0.0;
}

export abstract class Driver {
  abstract readonly protocol: 'dm' | 'dji' | 'gd';
  readonly extended: boolean = false;
  abstract readonly protocolName: string;
  abstract readonly caps: DriverCaps;
  abstract readonly outName: string;
  abstract readonly outUnit: string;
  note = '';

  constructor(
    public readonly model: string,
    public readonly motorId: number,
  ) {}

  get ready(): boolean {
    return true;
  }

  abstract get outMax(): number;

  get wrapSpan(): number {
    return 2 * Math.PI;
  }

  abstract get fbId(): number;

  get masterId(): number {
    return -1;
  }

  title(): string {
    return `${this.model}  ID ${this.motorId}`;
  }

  abstract summary(): DriverSummary;
  abstract accepts(canId: number, data: Uint8Array): boolean;
  abstract parse(canId: number, data: Uint8Array, t?: number): Feedback | null;
  abstract outputFrames(out: number): FrameTuple[];

  stopFrames(): FrameTuple[] {
    return this.outputFrames(0.0);
  }

  mitFrames(_cmd: MitCommand): FrameTuple[] {
    return [];
  }

  idleFrames(): FrameTuple[] {
    return [];
  }

  enableFrames(): FrameTuple[] {
    return [];
  }

  disableFrames(): FrameTuple[] {
    return [];
  }

  clearFrames(): FrameTuple[] {
    return [];
  }

  zeroFrames(): FrameTuple[] {
    return [];
  }

  codeText(_code: number): string {
    return '';
  }

  isFault(_code: number): boolean {
    return false;
  }

  describe(_canId: number, _data: Uint8Array, _tx: boolean): string {
    return '';
  }
}
