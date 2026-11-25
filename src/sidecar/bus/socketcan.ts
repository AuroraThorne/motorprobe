import * as fs from 'fs';
import * as path from 'path';
import { BusError, CanBus, createFrame, Frame, nowSec } from './types';

export const CAN_MTU = 16;
export const CAN_INTERFACE_TYPE = 280; // Linux ARPHRD_CAN
export const CAN_EFF_FLAG = 0x80000000;
export const CAN_RTR_FLAG = 0x40000000;
export const CAN_ERR_FLAG = 0x20000000;

export function socketcanInterfaces(): string[] {
  if (process.platform !== 'linux') return [];
  const netDir = '/sys/class/net';
  try {
    if (!fs.existsSync(netDir)) return [];
    const names: string[] = [];
    for (const name of fs.readdirSync(netDir)) {
      try {
        const typeStr = fs.readFileSync(path.join(netDir, name, 'type'), 'ascii').trim();
        if (parseInt(typeStr, 10) === CAN_INTERFACE_TYPE) {
          names.push(name);
        }
      } catch {
        // ignore interface
      }
    }
    return names.sort();
  } catch {
    return [];
  }
}

export interface UnpackedSocketCanFrame {
  canId: number;
  data: Uint8Array;
  extended: boolean;
  rtr: boolean;
  dlc: number;
}

export class SocketCanBus implements CanBus {
  readonly name: string;
  readonly bitrate: number | null = null;
  private sockFd: number | null = null;
  private libcSend: ((fd: number, buf: Buffer, len: number, flags: number) => number) | null = null;
  private libcRecv: ((fd: number, buf: Buffer, len: number, flags: number) => number) | null = null;
  private libcClose: ((fd: number) => number) | null = null;
  private readonly rxBuf = Buffer.alloc(CAN_MTU);

  constructor(public readonly iface: string) {
    this.name = `SocketCAN ${iface}`;
  }

  static packFrame(
    canId: number,
    data: Uint8Array,
    extended = false,
    rtr = false,
    dlc: number | null = null,
  ): Uint8Array {
    const limit = extended ? 0x1fffffff : 0x7ff;
    if (canId < 0 || canId > limit) {
      throw new RangeError(`CAN ID 超出范围: 0x${canId.toString(16).toUpperCase()}`);
    }
    if (data.length > 8) {
      throw new RangeError('经典 CAN 数据长度不能超过 8 字节');
    }
    let frameId = canId >>> 0;
    if (extended) frameId = (frameId | CAN_EFF_FLAG) >>> 0;
    if (rtr) frameId = (frameId | CAN_RTR_FLAG) >>> 0;
    const wDlc = dlc === null ? data.length : dlc;
    if (wDlc < 0 || wDlc > 8) {
      throw new RangeError('DLC 必须在 0~8 之间');
    }
    const out = new Uint8Array(CAN_MTU);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, frameId, true);
    out[4] = wDlc;
    out.set(data.subarray(0, 8), 8);
    return out;
  }

  static unpackFrame(raw: Uint8Array, withFlags: true): UnpackedSocketCanFrame | null;
  static unpackFrame(raw: Uint8Array, withFlags?: false): [number, Uint8Array] | null;
  static unpackFrame(
    raw: Uint8Array,
    withFlags = false,
  ): UnpackedSocketCanFrame | [number, Uint8Array] | null {
    if (raw.length < CAN_MTU) return null;
    const dv = new DataView(raw.buffer, raw.byteOffset, CAN_MTU);
    const rawId = dv.getUint32(0, true);
    if ((rawId & CAN_ERR_FLAG) !== 0) return null;
    const extended = (rawId & CAN_EFF_FLAG) !== 0;
    const rtr = (rawId & CAN_RTR_FLAG) !== 0;
    const mask = extended ? 0x1fffffff : 0x7ff;
    const canId = (rawId & mask) >>> 0;
    const dlc = raw[4];
    const data = rtr ? new Uint8Array(0) : raw.slice(8, 8 + Math.min(dlc, 8));
    if (withFlags) {
      return { canId, data, extended, rtr, dlc };
    }
    return [canId, data];
  }

  open(): void {
    if (process.platform !== 'linux') {
      throw new BusError('SocketCAN 仅支持 Linux');
    }
    if (this.sockFd !== null) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const libc = koffi.load('libc.so.6');
    const fnSocket = libc.func('int socket(int domain, int type, int protocol)');
    const fnSetsockopt = libc.func(
      'int setsockopt(int sockfd, int level, int optname, const void *optval, uint32 optlen)',
    );
    const fnIfNametoindex = libc.func('uint32 if_nametoindex(str ifname)');
    const fnBind = libc.func('int bind(int sockfd, const void *addr, uint32 addrlen)');
    const fnSend = libc.func('intptr send(int sockfd, const void *buf, uintptr len, int flags)');
    const fnRecv = libc.func('intptr recv(int sockfd, _Out_ void *buf, uintptr len, int flags)');
    const fnClose = libc.func('int close(int fd)');

    const AF_CAN = 29;
    const SOCK_RAW = 3;
    const SOCK_NONBLOCK = 0x800;
    const CAN_RAW = 1;
    const SOL_CAN_RAW = 101;
    const CAN_RAW_LOOPBACK = 3;

    const fd: number = fnSocket(AF_CAN, SOCK_RAW | SOCK_NONBLOCK, CAN_RAW);
    if (fd < 0) {
      throw new BusError(`创建 AF_CAN 套接字失败 (${this.iface})`);
    }

    try {
      const zeroInt = Buffer.alloc(4);
      fnSetsockopt(fd, SOL_CAN_RAW, CAN_RAW_LOOPBACK, zeroInt, 4);

      const ifIndex: number = fnIfNametoindex(this.iface);
      if (ifIndex === 0) {
        throw new BusError(`找不到 SocketCAN 接口 ${this.iface}`);
      }

      // struct sockaddr_can (16/24 bytes): u16 can_family=AF_CAN, pad(2), i32 can_ifindex
      const addr = Buffer.alloc(24);
      addr.writeUInt16LE(AF_CAN, 0);
      addr.writeInt32LE(ifIndex, 4);
      if (fnBind(fd, addr, 16) !== 0) {
        throw new BusError(`绑定 SocketCAN ${this.iface} 失败`);
      }

      this.sockFd = fd;
      this.libcSend = fnSend;
      this.libcRecv = fnRecv;
      this.libcClose = fnClose;
    } catch (e) {
      fnClose(fd);
      throw e;
    }
  }

  close(): void {
    if (this.sockFd !== null && this.libcClose) {
      this.libcClose(this.sockFd);
    }
    this.sockFd = null;
  }

  send(canId: number, data: Uint8Array, extended = false, rtr = false, dlc: number | null = null): void {
    if (this.sockFd === null || !this.libcSend) {
      throw new BusError('SocketCAN 尚未打开');
    }
    const packed = SocketCanBus.packFrame(canId, data, extended, rtr, dlc);
    const buf = Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength);
    const n = this.libcSend(this.sockFd, buf, CAN_MTU, 0);
    if (n !== CAN_MTU) {
      throw new BusError(`SocketCAN 发送失败 (len=${n})`);
    }
  }

  recvAll(): Frame[] {
    if (this.sockFd === null || !this.libcRecv) return [];
    const MSG_DONTWAIT = 0x40;
    const out: Frame[] = [];
    for (let i = 0; i < 512; i++) {
      const n = this.libcRecv(this.sockFd, this.rxBuf, CAN_MTU, MSG_DONTWAIT);
      if (n <= 0) break;
      const decoded = SocketCanBus.unpackFrame(this.rxBuf, true);
      if (!decoded) continue;
      out.push(
        createFrame(nowSec(), decoded.canId, decoded.data, {
          extended: decoded.extended,
          rtr: decoded.rtr,
          dlc: decoded.dlc,
        }),
      );
    }
    return out;
  }

  statusText(): string {
    return this.sockFd !== null ? 'OK' : '未打开';
  }
}
