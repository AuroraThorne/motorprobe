import { BAUDRATE_PCAN } from '../../shared/protocol';
import { BusError, CanBus, createFrame, Frame, nowSec } from './types';

export const PCAN_NONEBUS = 0x00;
export const USB_CHANNELS: Record<string, number> = Object.fromEntries(
  Array.from({ length: 16 }, (_, idx) => {
    const i = idx + 1;
    return [`PCAN_USBBUS${i}`, i <= 8 ? 0x50 + i : 0x500 + i];
  }),
);

export const PCAN_ERROR_OK = 0x00000;
export const PCAN_ERROR_QRCVEMPTY = 0x00020;
export const PCAN_MESSAGE_STANDARD = 0x00;
export const PCAN_MESSAGE_RTR = 0x01;
export const PCAN_MESSAGE_EXTENDED = 0x02;
export const PCAN_MESSAGE_ERRFRAME = 0x40;
export const PCAN_MESSAGE_STATUS = 0x80;

const PCAN_ATTACHED_CHANNELS_COUNT = 0x2a;
const PCAN_ATTACHED_CHANNELS = 0x2b;
const PCAN_CHANNEL_OCCUPIED = 0x02;

const PCAN_BITRATE_MAP: Record<number, number> = {
  [BAUDRATE_PCAN['1M']]: 1_000_000,
  [BAUDRATE_PCAN['800K']]: 800_000,
  [BAUDRATE_PCAN['500K']]: 500_000,
  [BAUDRATE_PCAN['250K']]: 250_000,
  [BAUDRATE_PCAN['125K']]: 125_000,
};

export interface PcanAttachedChannel {
  name: string;
  handle: number;
  description: string;
  occupied: boolean;
}

export class PCANBasic {
  private readonly fnInit: (ch: number, baud: number, hwType: number, ioPort: number, irq: number) => number;
  private readonly fnUninit: (ch: number) => number;
  private readonly fnGetStatus: (ch: number) => number;
  private readonly fnRead: (ch: number, msgBuf: Buffer, tsBuf: Buffer) => number;
  private readonly fnWrite: (ch: number, msgBuf: Buffer) => number;
  private readonly fnGetValue: (ch: number, param: number, buf: Buffer, len: number) => number;
  private readonly fnGetErrorText: (err: number, lang: number, buf: Buffer) => number;

  private readonly rxMsgBuf = Buffer.alloc(16);
  private readonly rxMsgDv = new DataView(this.rxMsgBuf.buffer, this.rxMsgBuf.byteOffset, 16);
  private readonly rxTsBuf = Buffer.alloc(8);
  private readonly txMsgBuf = Buffer.alloc(16);
  private readonly txMsgDv = new DataView(this.txMsgBuf.buffer, this.txMsgBuf.byteOffset, 16);
  private readonly errBuf = Buffer.alloc(256);

  constructor() {
    if (process.platform !== 'win32') {
      throw new BusError('PCAN 仅支持 Windows (PCANBasic.dll)');
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    let dll: ReturnType<typeof koffi.load>;
    try {
      dll = koffi.load('PCANBasic.dll');
    } catch (e) {
      throw new BusError(
        `无法加载 PCANBasic.dll，请安装 PEAK PCAN 驱动 (www.peak-system.com): ${(e as Error).message}`,
      );
    }

    this.fnInit = dll.func(
      'uint32 __stdcall CAN_Initialize(uint16 Channel, uint16 Btr0Btr1, uint8 HwType, uint32 IOPort, uint16 Interrupt)',
    );
    this.fnUninit = dll.func('uint32 __stdcall CAN_Uninitialize(uint16 Channel)');
    this.fnGetStatus = dll.func('uint32 __stdcall CAN_GetStatus(uint16 Channel)');
    this.fnRead = dll.func(
      'uint32 __stdcall CAN_Read(uint16 Channel, _Out_ void *MessageBuffer, _Out_ void *TimestampBuffer)',
    );
    this.fnWrite = dll.func('uint32 __stdcall CAN_Write(uint16 Channel, const void *MessageBuffer)');
    this.fnGetValue = dll.func(
      'uint32 __stdcall CAN_GetValue(uint16 Channel, uint8 Parameter, _Inout_ void *Buffer, uint32 BufferLength)',
    );
    this.fnGetErrorText = dll.func(
      'uint32 __stdcall CAN_GetErrorText(uint32 Error, uint16 Language, _Out_ void *Buffer)',
    );
  }

  initialize(ch: number, baud: number): number {
    return this.fnInit(ch, baud, 0, 0, 0) >>> 0;
  }

  uninitialize(ch: number): number {
    return this.fnUninit(ch) >>> 0;
  }

  getStatus(ch: number): number {
    return this.fnGetStatus(ch) >>> 0;
  }

  readInto(): { status: number; id: number; msgType: number; len: number; data: Buffer } {
    return {
      status: 0,
      id: this.rxMsgDv.getUint32(0, true),
      msgType: this.rxMsgBuf[4],
      len: this.rxMsgBuf[5],
      data: this.rxMsgBuf,
    };
  }

  readChannel(ch: number): { status: number; id: number; msgType: number; len: number } {
    const status = this.fnRead(ch, this.rxMsgBuf, this.rxTsBuf) >>> 0;
    if (status !== PCAN_ERROR_OK) {
      return { status, id: 0, msgType: 0, len: 0 };
    }
    return {
      status: PCAN_ERROR_OK,
      id: this.rxMsgDv.getUint32(0, true),
      msgType: this.rxMsgBuf[4],
      len: this.rxMsgBuf[5],
    };
  }

  copyRxData(len: number): Uint8Array {
    const n = Math.min(8, Math.max(0, len));
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.rxMsgBuf[6 + i];
    }
    return out;
  }

  write(
    ch: number,
    canId: number,
    data: Uint8Array,
    extended = false,
    rtr = false,
    dlc: number | null = null,
  ): number {
    this.txMsgBuf.fill(0);
    this.txMsgDv.setUint32(0, canId >>> 0, true);
    let msgType = extended ? PCAN_MESSAGE_EXTENDED : PCAN_MESSAGE_STANDARD;
    if (rtr) msgType |= PCAN_MESSAGE_RTR;
    this.txMsgBuf[4] = msgType;
    this.txMsgBuf[5] = dlc === null ? data.length : dlc;
    const copyLen = Math.min(8, data.length);
    for (let i = 0; i < copyLen; i++) {
      this.txMsgBuf[6 + i] = data[i];
    }
    return this.fnWrite(ch, this.txMsgBuf) >>> 0;
  }

  errorText(err: number): string {
    this.errBuf.fill(0);
    const r = this.fnGetErrorText(err >>> 0, 0x09, this.errBuf) >>> 0;
    if (r === PCAN_ERROR_OK) {
      const nul = this.errBuf.indexOf(0);
      return this.errBuf.subarray(0, nul >= 0 ? nul : 256).toString('ascii');
    }
    return `PCAN error 0x${(err >>> 0).toString(16).toUpperCase()}`;
  }

  attachedChannels(): PcanAttachedChannel[] {
    try {
      const cntBuf = Buffer.alloc(4);
      if (this.fnGetValue(PCAN_NONEBUS, PCAN_ATTACHED_CHANNELS_COUNT, cntBuf, 4) !== PCAN_ERROR_OK) {
        return [];
      }
      const cnt = cntBuf.readUInt32LE(0);
      if (cnt === 0 || cnt > 64) return [];

      // sizeof(TPCANChannelInformation) == 52 bytes with natural C alignment:
      // 0..1 handle(u16), 2 type(u8), 3 ctrl(u8), 4..7 features(u32),
      // 8..40 name(char[33]), 41..43 pad(3), 44..47 device_id(u32), 48..51 condition(u32)
      const ITEM_SIZE = 52;
      const arrBuf = Buffer.alloc(cnt * ITEM_SIZE);
      if (
        this.fnGetValue(PCAN_NONEBUS, PCAN_ATTACHED_CHANNELS, arrBuf, arrBuf.length) !== PCAN_ERROR_OK
      ) {
        return [];
      }
      const nameByHandle = new Map<number, string>();
      for (const [k, v] of Object.entries(USB_CHANNELS)) {
        nameByHandle.set(v, k);
      }

      const out: PcanAttachedChannel[] = [];
      for (let i = 0; i < cnt; i++) {
        const base = i * ITEM_SIZE;
        const handle = arrBuf.readUInt16LE(base);
        const nameSlice = arrBuf.subarray(base + 8, base + 41);
        const nul = nameSlice.indexOf(0);
        const devName = nameSlice.subarray(0, nul >= 0 ? nul : 33).toString('utf8');
        const devId = arrBuf.readUInt32LE(base + 44);
        const cond = arrBuf.readUInt32LE(base + 48);
        const occupied = Boolean(cond & PCAN_CHANNEL_OCCUPIED);
        const name = nameByHandle.get(handle) ?? `0x${handle.toString(16).toUpperCase()}`;
        out.push({
          name,
          handle,
          occupied,
          description: `${devName} #${devId}${occupied ? ' (已占用)' : ''}`,
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}

export class PcanBus implements CanBus {
  readonly name: string;
  readonly bitrate: number | null;
  private readonly api: PCANBasic;
  private _open = false;

  constructor(
    public readonly ch: number,
    public readonly baud: number,
  ) {
    this.api = new PCANBasic();
    this.name = `PCAN 0x${ch.toString(16).toUpperCase()}`;
    this.bitrate = PCAN_BITRATE_MAP[baud] ?? null;
  }

  open(): void {
    const r = this.api.initialize(this.ch, this.baud);
    if (r !== PCAN_ERROR_OK) {
      throw new BusError(`打开 PCAN 失败: ${this.api.errorText(r)}`);
    }
    this._open = true;
  }

  close(): void {
    if (this._open) {
      this.api.uninitialize(this.ch);
      this._open = false;
    }
  }

  send(canId: number, data: Uint8Array, extended = false, rtr = false, dlc: number | null = null): void {
    const r = this.api.write(this.ch, canId, data, extended, rtr, dlc);
    if (r !== PCAN_ERROR_OK) {
      throw new BusError(`发送失败: ${this.api.errorText(r)}`);
    }
  }

  recvAll(): Frame[] {
    const out: Frame[] = [];
    for (let i = 0; i < 512; i++) {
      const res = this.api.readChannel(this.ch);
      if (res.status & PCAN_ERROR_QRCVEMPTY) break;
      if (res.status !== PCAN_ERROR_OK) break;
      if (res.msgType & (PCAN_MESSAGE_STATUS | PCAN_MESSAGE_ERRFRAME)) continue;
      const rtr = Boolean(res.msgType & PCAN_MESSAGE_RTR);
      const data = rtr ? new Uint8Array(0) : this.api.copyRxData(res.len);
      out.push(
        createFrame(nowSec(), res.id, data, {
          extended: Boolean(res.msgType & PCAN_MESSAGE_EXTENDED),
          rtr,
          dlc: res.len,
        }),
      );
    }
    return out;
  }

  statusText(): string {
    const r = this.api.getStatus(this.ch);
    return r === PCAN_ERROR_OK ? 'OK' : this.api.errorText(r);
  }
}
