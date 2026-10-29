import { EventEmitter } from 'events';

export interface SerialConfig {
  /** 端口名，如 COM3 */
  path: string;
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
}

/** 枚举系统可用串口（含 PnP 信息，便于用户识别设备） */
export async function listSerialPorts(): Promise<
  { path: string; manufacturer?: string; serialNumber?: string; pnpId?: string; friendlyName?: string }[]
> {
  const { SerialPort } = await import('serialport');
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer,
    serialNumber: p.serialNumber,
    pnpId: p.pnpId,
    friendlyName: (p as any).friendlyName
  }));
}

/**
 * 串口会话（对接交换机/路由器 Console 口、单片机、PLC 等）。
 * 接口与 SSHSession 对齐；serialport 为 NAPI 预编译，免编译直接可用。
 */
export class SerialSession extends EventEmitter {
  private port: any = null;
  private closed = false;

  constructor(
    public id: string,
    private config: SerialConfig
  ) {
    super();
  }

  async connect(): Promise<void> {
    const { SerialPort } = await import('serialport');
    return new Promise((resolve, reject) => {
      const port = new SerialPort({
        path: this.config.path,
        baudRate: this.config.baudRate || 9600,
        dataBits: this.config.dataBits || 8,
        stopBits: this.config.stopBits || 1,
        parity: this.config.parity || 'none',
        autoOpen: false
      });
      this.port = port;

      port.open((err: Error | null) => {
        if (err) {
          reject(new Error(`打开串口 ${this.config.path} 失败：${err.message}`));
          return;
        }
        port.on('data', (data: Buffer) => {
          this.emit('data', data.toString('utf8'));
        });
        port.on('error', (e: Error) => this.emitOnce('error', e.message));
        port.on('close', () => this.emitOnce('close'));
        resolve();
      });
    });
  }

  private emitOnce(event: 'close' | 'error', ...args: any[]) {
    if (this.closed && event === 'close') return;
    if (event === 'close') this.closed = true;
    this.emit(event, ...args);
  }

  write(data: string) {
    if (this.port?.isOpen) {
      // Console 口常用 CR/LF 结尾
      this.port.write(data);
      this.port.drain?.(() => {});
    }
  }

  /** 串口无窗口概念，忽略 resize */
  resize(_cols: number, _rows: number) {}

  end() {
    this.closed = true;
    if (this.port) {
      try {
        this.port.close(() => {});
      } catch {
        /* ignore */
      }
      this.port = null;
    }
  }
}
