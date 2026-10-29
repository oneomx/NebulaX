import { Socket } from 'net';
import { EventEmitter } from 'events';

export interface TelnetConfig {
  host: string;
  port: number;
  /** 连接超时（毫秒），默认 15s */
  timeoutMs?: number;
}

// Telnet 协议字节
const IAC = 255; // Interpret As Command
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250; // subnegotiation begin
const SE = 240; // subnegotiation end
const OPTION_ECHO = 1;
const OPTION_SGA = 3; // Suppress Go Ahead

/**
 * Telnet 会话：接口与 SSHSession 对齐（write/resize/end + data/close/error 事件）。
 * 处理 IAC 协商：对未知选项回 WONT/DONT，接受 ECHO/SGA；子协商块直接跳过；
 * 出站数据中的 0xFF 按协议转义为 IAC IAC。
 */
export class TelnetSession extends EventEmitter {
  private sock: Socket | null = null;
  private closed = false;
  /** 已发送过的协商响应，避免重复应答造成循环 */
  private answered = new Set<string>();

  constructor(public id: string, private config: TelnetConfig) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closed = false;
      const sock = new Socket();
      this.sock = sock;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(new Error(`Telnet 连接超时（${(this.config.timeoutMs ?? 15000) / 1000}s）`));
        }
      }, this.config.timeoutMs ?? 15000);

      sock.setTimeout(this.config.timeoutMs ?? 15000, () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          sock.destroy();
          reject(new Error('Telnet 连接超时'));
        }
      });

      sock.on('connect', () => {
        clearTimeout(timer);
        sock.setTimeout(0); // 连接成功后不再做整体超时
        this.emit('data', '');
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      sock.on('data', (buf: Buffer) => {
        const { clean, replies } = this.processIAC(buf);
        for (const r of replies) {
          try {
            sock.write(r);
          } catch {
            /* socket 可能已关闭 */
          }
        }
        if (clean.length > 0) this.emit('data', clean.toString('utf8'));
      });

      sock.on('error', (err: Error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.emitOnce('error', err.message);
      });

      sock.on('close', () => {
        clearTimeout(timer);
        this.emitOnce('close');
      });

      sock.connect(this.config.port, this.config.host);
    });
  }

  private emitOnce(event: 'close' | 'error', ...args: any[]) {
    if (this.closed && event === 'close') return;
    if (event === 'close') this.closed = true;
    this.emit(event, ...args);
  }

  /** 未解析完的不完整 IAC 序列（TCP 分包把协商命令切到两个包里时暂存，等下一包拼上再解析） */
  private pending: Buffer = Buffer.alloc(0);

  /**
   * 解析入站缓冲：剥离 IAC 序列，生成需要的协商响应。
   * 策略（保守，保证互通）：
   * - WILL x：若 x 支持（ECHO/SGA）→ DO x；否则 DONT x（只回一次）
   * - DO x：若 x 支持（SGA）→ WILL x；否则 WONT x（只回一次）
   * - IAC SB ... IAC SE：整块跳过
   * - IAC IAC：转义的 0xFF 数据字节
   * - 跨包保护：包尾的不完整 IAC 序列存入 pending，与下一包拼接后再解析
   */
  private processIAC(chunk: Buffer): { clean: Buffer; replies: Buffer[] } {
    const buf = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    const out: number[] = [];
    const replies: Buffer[] = [];
    let i = 0;
    const supported = new Set([OPTION_ECHO, OPTION_SGA]);

    while (i < buf.length) {
      const b = buf[i];
      if (b !== IAC) {
        out.push(b);
        i++;
        continue;
      }
      // IAC 开头：确认完整序列长度，不足则留到下一包
      const cmd = buf[i + 1];
      if (cmd === undefined) {
        this.pending = buf.subarray(i);
        break;
      }
      if (cmd === IAC) {
        // 转义的 0xFF 数据
        out.push(IAC);
        i += 2;
      } else if (cmd === WILL || cmd === DONT || cmd === DO || cmd === WONT) {
        const opt = buf[i + 2];
        if (opt === undefined) {
          this.pending = buf.subarray(i);
          break;
        }
        const key = `${cmd}:${opt}`;
        if (cmd === WILL && !this.answered.has(key)) {
          this.answered.add(key);
          replies.push(Buffer.from([IAC, supported.has(opt) ? DO : DONT, opt]));
        } else if (cmd === DO && !this.answered.has(key)) {
          this.answered.add(key);
          replies.push(Buffer.from([IAC, supported.has(opt) ? WILL : WONT, opt]));
        }
        i += 3;
      } else if (cmd === SB) {
        // 跳过子协商：IAC SB ... IAC SE；找不到 SE 说明被分包，整体留到下一包
        let j = i + 2;
        let found = false;
        while (j + 1 < buf.length) {
          if (buf[j] === IAC && buf[j + 1] === SE) {
            found = true;
            j += 2;
            break;
          }
          j++;
        }
        if (!found) {
          // 防御：子协商异常超长（>8KB）直接丢弃，避免恶意/异常数据撑爆内存
          if (buf.length - i > 8192) {
            i = buf.length;
          } else {
            this.pending = buf.subarray(i);
          }
          break;
        }
        i = j;
      } else {
        // 其他两字节命令（NOP、AYT、IP 等）：忽略
        i += 2;
      }
    }
    return { clean: Buffer.from(out), replies };
  }

  write(data: string) {
    if (!this.sock || this.sock.destroyed) return;
    // 出站转义：数据里的 0xFF 需写成 IAC IAC
    const raw = Buffer.from(data, 'utf8');
    if (raw.includes(IAC)) {
      const escaped: number[] = [];
      for (const b of raw) {
        escaped.push(b);
        if (b === IAC) escaped.push(IAC);
      }
      this.sock.write(Buffer.from(escaped));
    } else {
      this.sock.write(raw);
    }
  }

  /** Telnet 无窗口概念，忽略 resize */
  resize(_cols: number, _rows: number) {}

  end() {
    this.closed = true;
    if (this.sock) {
      try {
        this.sock.end();
        this.sock.destroy();
      } catch {
        /* ignore */
      }
      this.sock = null;
    }
  }
}
