import * as fs from 'fs';
import * as path from 'path';
import { BusError, CanBus, createFrame, Frame, nowSec } from './types';

export const CANABLE_VID = 0x16d0;
export const CANABLE_PID = 0x117e;
export const DEFAULT_SERIAL_BAUDRATE = 115200;

export const SLCAN_BITRATE_COMMANDS: Record<number, string> = {
  10_000: 'S0',
  20_000: 'S1',
  50_000: 'S2',
  100_000: 'S3',
  125_000: 'S4',
  250_000: 'S5',
  500_000: 'S6',
  800_000: 'S7',
  1_000_000: 'S8',
};

export interface CanableDeviceInfo {
  port: string;
  description: string;
  vid: number | null;
  pid: number | null;
}

export function decodeWindowsRegistryString(data: Uint8Array, length = data.length, type = 1): string {
  const byteLength = Math.max(0, Math.min(length, data.byteLength));
  const bytes = Buffer.from(data.buffer, data.byteOffset, byteLength);
  if (type === 1 || type === 2 || type === 7) {
    const evenLength = byteLength - (byteLength % 2);
    return bytes.subarray(0, evenLength).toString('utf16le').replace(/\0.*$/s, '').trim();
  }
  return bytes.toString('utf8').replace(/\0.*$/s, '').trim();
}

export function encodeSlcanFrame(
  canId: number,
  data: Uint8Array,
  extended = false,
  rtr = false,
  dlc: number | null = null,
): Uint8Array {
  const limit = extended ? 0x1fffffff : 0x7ff;
  if (canId < 0 || canId > limit) {
    throw new RangeError(`SLCAN CAN ID 超出范围: 0x${canId.toString(16).toUpperCase()}`);
  }
  if (data.length > 8) {
    throw new RangeError('经典 CAN 数据长度不能超过 8 字节');
  }
  const wDlc = dlc === null ? data.length : dlc;
  if (wDlc < 0 || wDlc > 8) {
    throw new RangeError('DLC 必须在 0~8 之间');
  }
  const prefix = extended && rtr ? 'R' : extended ? 'T' : rtr ? 'r' : 't';
  const idWidth = extended ? 8 : 3;
  const idHex = canId.toString(16).toUpperCase().padStart(idWidth, '0');
  const dlcHex = wDlc.toString(16).toUpperCase();
  let payload = '';
  if (!rtr) {
    for (let i = 0; i < data.length; i++) {
      payload += data[i].toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return Buffer.from(`${prefix}${idHex}${dlcHex}${payload}\r`, 'ascii');
}

export interface ParsedSlcanFrame {
  canId: number;
  data: Uint8Array;
  extended: boolean;
  rtr: boolean;
  dlc: number;
}

export function parseSlcanFrame(
  line: Uint8Array | string,
  withFlags: true,
): ParsedSlcanFrame | null;
export function parseSlcanFrame(
  line: Uint8Array | string,
  withFlags?: false,
): [number, Uint8Array] | null;
export function parseSlcanFrame(
  line: Uint8Array | string,
  withFlags = false,
): ParsedSlcanFrame | [number, Uint8Array] | null {
  const text = (typeof line === 'string' ? line : Buffer.from(line).toString('ascii')).trim();
  if (!text || !'tTrR'.includes(text[0])) {
    return null;
  }
  const extended = text[0] === 'T' || text[0] === 'R';
  const rtr = text[0] === 'r' || text[0] === 'R';
  if (!withFlags && (extended || rtr)) {
    return null;
  }
  const idWidth = extended ? 8 : 3;
  if (text.length < 2 + idWidth) {
    return null;
  }
  const idStr = text.slice(1, 1 + idWidth);
  const dlcStr = text[1 + idWidth];
  if (!/^[0-9a-fA-F]+$/.test(idStr) || !/^[0-9a-fA-F]$/.test(dlcStr)) {
    return null;
  }
  const canId = parseInt(idStr, 16);
  const dlc = parseInt(dlcStr, 16);
  const payload = text.slice(2 + idWidth, 2 + idWidth + dlc * 2);
  if (dlc > 8 || (!rtr && (payload.length !== dlc * 2 || (dlc > 0 && !/^[0-9a-fA-F]+$/.test(payload))))) {
    return null;
  }
  const data = rtr ? new Uint8Array(0) : new Uint8Array(Buffer.from(payload, 'hex'));
  if (withFlags) {
    return { canId, data, extended, rtr, dlc };
  }
  return [canId, data];
}

function discoverWindowsCanablePorts(): CanableDeviceInfo[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const advapi = koffi.load('advapi32.dll');
    const RegOpenKeyExA = advapi.func(
      'int32 __stdcall RegOpenKeyExA(uintptr hKey, str lpSubKey, uint32 ulOptions, uint32 samDesired, _Out_ uintptr *phkResult)',
    );
    const RegEnumValueA = advapi.func(
      'int32 __stdcall RegEnumValueA(uintptr hKey, uint32 dwIndex, _Out_ void *lpValueName, _Inout_ uint32 *lpcchValueName, void *lpReserved, _Out_ uint32 *lpType, _Out_ void *lpData, _Inout_ uint32 *lpcbData)',
    );
    const RegQueryValueExA = advapi.func(
      'int32 __stdcall RegQueryValueExA(uintptr hKey, str lpValueName, void *lpReserved, _Out_ uint32 *lpType, _Out_ void *lpData, _Inout_ uint32 *lpcbData)',
    );
    const RegCloseKey = advapi.func('int32 __stdcall RegCloseKey(uintptr hKey)');

    const HKEY_LOCAL_MACHINE = 0x80000002;
    const KEY_READ = 0x20019;

    // 1. Read active serial ports from HARDWARE\DEVICEMAP\SERIALCOMM
    const hSerialArr = [0];
    if (
      RegOpenKeyExA(HKEY_LOCAL_MACHINE, 'HARDWARE\\DEVICEMAP\\SERIALCOMM', 0, KEY_READ, hSerialArr) !== 0
    ) {
      return [];
    }
    const activePorts = new Set<string>();
    const nameBuf = Buffer.alloc(256);
    const dataBuf = Buffer.alloc(256);
    try {
      for (let idx = 0; idx < 128; idx++) {
        const nameLen = [255];
        const dataLen = [255];
        const typ = [0];
        const rc = RegEnumValueA(
          hSerialArr[0],
          idx,
          nameBuf,
          nameLen,
          null,
          typ,
          dataBuf,
          dataLen,
        );
        if (rc !== 0) break;
        const nul = dataBuf.indexOf(0);
        const comName = dataBuf.subarray(0, nul >= 0 ? nul : dataLen[0]).toString('ascii').trim();
        if (comName) activePorts.add(comName);
      }
    } finally {
      RegCloseKey(hSerialArr[0]);
    }
    if (activePorts.size === 0) return [];

    // 2. Check usbser service Enum entries for VID_16D0&PID_117E or "canable"
    const hUsbser = [0];
    if (
      RegOpenKeyExA(
        HKEY_LOCAL_MACHINE,
        'SYSTEM\\CurrentControlSet\\Services\\usbser\\Enum',
        0,
        KEY_READ,
        hUsbser,
      ) !== 0
    ) {
      return [];
    }

    const pnpPaths: string[] = [];
    try {
      for (let i = 0; i < 64; i++) {
        const len = [255];
        const typ = [0];
        if (RegQueryValueExA(hUsbser[0], String(i), null, typ, dataBuf, len) !== 0) continue;
        const nul = dataBuf.indexOf(0);
        const pnp = dataBuf.subarray(0, nul >= 0 ? nul : len[0]).toString('ascii');
        if (pnp) pnpPaths.push(pnp);
      }
    } finally {
      RegCloseKey(hUsbser[0]);
    }

    const out: CanableDeviceInfo[] = [];
    for (const pnp of pnpPaths) {
      const upper = pnp.toUpperCase();
      const isCanableVidPid = upper.includes('VID_16D0') && upper.includes('PID_117E');

      const hDev = [0];
      if (
        RegOpenKeyExA(
          HKEY_LOCAL_MACHINE,
          `SYSTEM\\CurrentControlSet\\Enum\\${pnp}`,
          0,
          KEY_READ,
          hDev,
        ) !== 0
      ) {
        continue;
      }
      let friendly = '';
      try {
        const len = [255];
        const typ = [0];
        if (RegQueryValueExA(hDev[0], 'FriendlyName', null, typ, dataBuf, len) === 0) {
          friendly = decodeWindowsRegistryString(dataBuf, len[0], typ[0]);
        }
      } finally {
        RegCloseKey(hDev[0]);
      }

      if (!isCanableVidPid && !friendly.toLowerCase().includes('canable')) {
        continue;
      }

      const hParam = [0];
      if (
        RegOpenKeyExA(
          HKEY_LOCAL_MACHINE,
          `SYSTEM\\CurrentControlSet\\Enum\\${pnp}\\Device Parameters`,
          0,
          KEY_READ,
          hParam,
        ) !== 0
      ) {
        continue;
      }
      let portName = '';
      try {
        const len = [255];
        const typ = [0];
        if (RegQueryValueExA(hParam[0], 'PortName', null, typ, dataBuf, len) === 0) {
          const nul = dataBuf.indexOf(0);
          portName = dataBuf.subarray(0, nul >= 0 ? nul : len[0]).toString('ascii').trim();
        }
      } finally {
        RegCloseKey(hParam[0]);
      }

      if (portName && activePorts.has(portName)) {
        out.push({
          port: portName,
          description: friendly || 'Canable SLCAN',
          vid: isCanableVidPid ? CANABLE_VID : null,
          pid: isCanableVidPid ? CANABLE_PID : null,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function discoverLinuxCanablePorts(): CanableDeviceInfo[] {
  const sysTty = '/sys/class/tty';
  try {
    if (!fs.existsSync(sysTty)) return [];
    const entries = fs.readdirSync(sysTty);
    const out: CanableDeviceInfo[] = [];
    for (const name of entries) {
      if (!name.startsWith('ttyACM') && !name.startsWith('ttyUSB')) continue;
      const devLink = path.join(sysTty, name, 'device');
      if (!fs.existsSync(devLink)) continue;
      let cur = fs.realpathSync(devLink);
      let vid: number | null = null;
      let pid: number | null = null;
      let product = '';
      for (let depth = 0; depth < 4; depth++) {
        const vPath = path.join(cur, 'idVendor');
        const pPath = path.join(cur, 'idProduct');
        if (fs.existsSync(vPath) && fs.existsSync(pPath)) {
          vid = parseInt(fs.readFileSync(vPath, 'ascii').trim(), 16);
          pid = parseInt(fs.readFileSync(pPath, 'ascii').trim(), 16);
          const prodPath = path.join(cur, 'product');
          if (fs.existsSync(prodPath)) {
            product = fs.readFileSync(prodPath, 'utf8').trim();
          }
          break;
        }
        cur = path.dirname(cur);
      }
      const isKnown = vid === CANABLE_VID && pid === CANABLE_PID;
      if (!isKnown && !product.toLowerCase().includes('canable')) continue;
      out.push({
        port: `/dev/${name}`,
        description: product || 'Canable SLCAN',
        vid,
        pid,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function canablePorts(): CanableDeviceInfo[] {
  if (process.platform === 'win32') return discoverWindowsCanablePorts();
  if (process.platform === 'linux') return discoverLinuxCanablePorts();
  return [];
}

interface RawSerialHandle {
  read(dst: Buffer): number;
  write(src: Uint8Array): void;
  purge(): void;
  close(): void;
}

function openWindowsSerial(port: string, baudrate: number): RawSerialHandle {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  const CreateFileA = k32.func(
    'intptr __stdcall CreateFileA(str lpFileName, uint32 dwDesiredAccess, uint32 dwShareMode, void *lpSecurityAttributes, uint32 dwCreationDisposition, uint32 dwFlagsAndAttributes, intptr hTemplateFile)',
  );
  const CloseHandle = k32.func('int __stdcall CloseHandle(intptr hObject)');
  const GetCommState = k32.func('int __stdcall GetCommState(intptr hFile, _Inout_ void *lpDCB)');
  const SetCommState = k32.func('int __stdcall SetCommState(intptr hFile, const void *lpDCB)');
  const SetCommTimeouts = k32.func('int __stdcall SetCommTimeouts(intptr hFile, const void *lpCommTimeouts)');
  const PurgeComm = k32.func('int __stdcall PurgeComm(intptr hFile, uint32 dwFlags)');
  const ReadFile = k32.func(
    'int __stdcall ReadFile(intptr hFile, _Out_ void *lpBuffer, uint32 nNumberOfBytesToRead, _Out_ uint32 *lpNumberOfBytesRead, void *lpOverlapped)',
  );
  const WriteFile = k32.func(
    'int __stdcall WriteFile(intptr hFile, const void *lpBuffer, uint32 nNumberOfBytesToWrite, _Out_ uint32 *lpNumberOfBytesWritten, void *lpOverlapped)',
  );

  const GENERIC_RW = 0xc0000000;
  const OPEN_EXISTING = 3;
  const devPath = port.startsWith('\\\\.\\') ? port : `\\\\.\\${port}`;
  const handle = CreateFileA(devPath, GENERIC_RW, 0, null, OPEN_EXISTING, 0, 0);
  if (handle === -1 || handle === 0) {
    throw new BusError(`打开串口 ${port} 失败`);
  }

  try {
    // DCB is 28 bytes
    const dcb = Buffer.alloc(28);
    dcb.writeUInt32LE(28, 0);
    if (!GetCommState(handle, dcb)) {
      throw new BusError(`读取 ${port} 串口配置失败`);
    }
    dcb.writeUInt32LE(baudrate, 4); // BaudRate
    dcb.writeUInt32LE(0x0001, 8); // fBinary = 1, fParity = 0, no flow control, DTR_CONTROL_ENABLE = 0x10 optional
    dcb[18] = 8; // ByteSize
    dcb[19] = 0; // NOPARITY
    dcb[20] = 0; // ONESTOPBIT
    if (!SetCommState(handle, dcb)) {
      throw new BusError(`设置 ${port} 串口参数失败`);
    }

    // COMMTIMEOUTS (20 bytes): non-blocking immediate return on ReadFile
    const timeouts = Buffer.alloc(20);
    timeouts.writeUInt32LE(0xffffffff, 0); // ReadIntervalTimeout = MAXDWORD
    timeouts.writeUInt32LE(0, 4);
    timeouts.writeUInt32LE(0, 8);
    timeouts.writeUInt32LE(0, 12);
    timeouts.writeUInt32LE(200, 16); // WriteTotalTimeoutConstant = 200ms
    SetCommTimeouts(handle, timeouts);
    PurgeComm(handle, 0x000c); // PURGE_RXCLEAR | PURGE_TXCLEAR
  } catch (e) {
    CloseHandle(handle);
    throw e;
  }

  const nRead = [0];
  const nWritten = [0];
  return {
    read(dst: Buffer): number {
      nRead[0] = 0;
      const ok = ReadFile(handle, dst, dst.length, nRead, null);
      if (!ok) throw new BusError(`SLCAN 读取失败 (${port})`);
      return nRead[0];
    },
    write(src: Uint8Array): void {
      nWritten[0] = 0;
      const buf = Buffer.from(src.buffer, src.byteOffset, src.byteLength);
      const ok = WriteFile(handle, buf, buf.length, nWritten, null);
      if (!ok) throw new BusError(`SLCAN 发送失败 (${port})`);
    },
    purge(): void {
      PurgeComm(handle, 0x0008); // PURGE_RXCLEAR
    },
    close(): void {
      CloseHandle(handle);
    },
  };
}

function openPosixSerial(port: string): RawSerialHandle {
  const fd = fs.openSync(port, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
  try {
    // Configure raw mode for CDC ACM virtual serial via libc termios
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const libc = koffi.load('libc.so.6');
    const tcgetattr = libc.func('int tcgetattr(int fd, _Out_ void *termios_p)');
    const cfmakeraw = libc.func('void cfmakeraw(_Inout_ void *termios_p)');
    const tcsetattr = libc.func('int tcsetattr(int fd, int optional_actions, const void *termios_p)');
    const tbuf = Buffer.alloc(64);
    if (tcgetattr(fd, tbuf) === 0) {
      cfmakeraw(tbuf);
      tcsetattr(fd, 0, tbuf);
    }
  } catch {
    // USB CDC ACM ignores termios baudrate on most kernels anyway
  }

  return {
    read(dst: Buffer): number {
      try {
        return fs.readSync(fd, dst, 0, dst.length, null);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return 0;
        throw new BusError(`SLCAN 接收失败: ${(e as Error).message}`);
      }
    },
    write(src: Uint8Array): void {
      try {
        fs.writeSync(fd, src);
      } catch (e) {
        throw new BusError(`SLCAN 发送失败: ${(e as Error).message}`);
      }
    },
    purge(): void {
      const tmp = Buffer.alloc(1024);
      try {
        while (fs.readSync(fd, tmp, 0, tmp.length, null) > 0) {
          // drain
        }
      } catch {
        // drained
      }
    },
    close(): void {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    },
  };
}

export class SlcanBus implements CanBus {
  readonly name: string;
  readonly bitrate: number;
  private handle: RawSerialHandle | null = null;
  private rxBuf = '';
  private readonly chunkBuf = Buffer.alloc(4096);

  constructor(
    public readonly port: string,
    bitrate = 1_000_000,
    public readonly serialBaudrate = DEFAULT_SERIAL_BAUDRATE,
  ) {
    this.bitrate = bitrate;
    this.name = `SLCAN ${port}`;
  }

  open(): void {
    const cmd = SLCAN_BITRATE_COMMANDS[this.bitrate];
    if (!cmd) {
      throw new BusError(`SLCAN 不支持 CAN 波特率 ${this.bitrate} bit/s`);
    }
    if (this.handle) return;
    const h =
      process.platform === 'win32'
        ? openWindowsSerial(this.port, this.serialBaudrate)
        : openPosixSerial(this.port);
    try {
      this.rxBuf = '';
      h.purge();
      h.write(Buffer.from('C\r', 'ascii'));
      h.write(Buffer.from(`${cmd}\r`, 'ascii'));
      h.write(Buffer.from('O\r', 'ascii'));
      h.purge();
      this.handle = h;
    } catch (e) {
      h.close();
      throw e;
    }
  }

  close(): void {
    const h = this.handle;
    this.handle = null;
    if (!h) return;
    try {
      h.write(Buffer.from('C\r', 'ascii'));
    } catch {
      // ignore
    }
    h.close();
  }

  send(canId: number, data: Uint8Array, extended = false, rtr = false, dlc: number | null = null): void {
    if (!this.handle) throw new BusError('SLCAN 尚未打开');
    this.handle.write(encodeSlcanFrame(canId, data, extended, rtr, dlc));
  }

  recvAll(): Frame[] {
    if (!this.handle) return [];
    const n = this.handle.read(this.chunkBuf);
    if (n > 0) {
      this.rxBuf += this.chunkBuf.subarray(0, n).toString('ascii');
    }
    const out: Frame[] = [];
    let crIdx = this.rxBuf.indexOf('\r');
    while (crIdx >= 0) {
      const line = this.rxBuf.slice(0, crIdx);
      this.rxBuf = this.rxBuf.slice(crIdx + 1);
      const parsed = parseSlcanFrame(line, true);
      if (parsed) {
        out.push(
          createFrame(nowSec(), parsed.canId, parsed.data, {
            extended: parsed.extended,
            rtr: parsed.rtr,
            dlc: parsed.dlc,
          }),
        );
      }
      crIdx = this.rxBuf.indexOf('\r');
    }
    if (this.rxBuf.length > 8192) {
      this.rxBuf = this.rxBuf.slice(-1024);
    }
    return out;
  }

  statusText(): string {
    return this.handle ? 'OK' : '未打开';
  }
}
