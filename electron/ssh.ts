import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Socket } from 'net';
import { checkHostKey, sha256Fingerprint, extractKeyType, trustHostKey } from './knownhosts';
import { log } from './logger';
import {
  psCommand,
  windowsLoadArray,
  WIN_SERVER_INFO_SCRIPT,
  WIN_DIAG_SCRIPT,
  WIN_METRICS_SCRIPT,
  WIN_AUDIT_SCRIPT
} from './wincommands';

/** 代理配置（连接目标主机前先经代理隧道） */
export interface ProxyConfig {
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** 跳板机配置（先连跳板，再经其 forwardOut 到目标） */
export interface JumpConfig {
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'key';
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SSHSessionConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
  authType: 'password' | 'key';
  /** 主机指纹：false/undefined = 首次需用户确认；true = 用户已确认本次信任 */
  acceptHostKey?: boolean;
  /** 经由代理（SOCKS5/HTTP CONNECT） */
  proxy?: ProxyConfig;
  /** 经由 SSH 跳板机（与 proxy 同时配置时优先跳板） */
  jump?: JumpConfig;
}

/** 展开 ~ 前缀为用户主目录 */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * 解析私钥内容：若传入的是文件路径（且存在）则读取文件，否则视为 PEM 字符串直接返回。
 */
export function resolvePrivateKey(keyOrPath: string, fallbackPath?: string): string {
  const candidates = [keyOrPath, fallbackPath].filter(Boolean) as string[];
  for (const c of candidates) {
    // 明显是 PEM 内容，直接用
    if (c.includes('-----BEGIN')) return c;
    const p = expandHome(c.trim());
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return fs.readFileSync(p, 'utf8');
      }
    } catch {
      /* ignore and try next */
    }
  }
  throw new Error(
    `无法读取私钥：既不是 PEM 内容，也不是存在的文件路径。已尝试：${candidates.join(', ')}`
  );
}

export interface ServerInfo {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  memTotal: number;
  memUsed: number;
  memFree: number;
  /** Mem 行 available 字段（可立即分配给新进程的内存） */
  memAvailable: number;
  swapTotal: number;
  swapUsed: number;
  diskList: { fs: string; size: string; used: string; avail: string; use: string; mount: string }[];
  load: string[];
  uptime: string;
  users: string[];
  topProcesses: string[];
  docker: string | null;
  ipAddresses: string[];
}

/** 自动重连参数：指数退避 1s→2s→4s→8s→16s，最多 5 次 */
const RECONNECT_MAX = 5;
const HEARTBEAT_INTERVAL_MS = 60000;
const HEARTBEAT_TIMEOUT_MS = 10000;

/** 经 SOCKS5/HTTP CONNECT 代理建立到目标主机的 TCP 隧道（export 供测试用） */
export function openProxySocket(p: ProxyConfig, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(20000, () => fail(new Error('代理连接超时')));
    sock.once('error', fail);
    sock.connect(p.port, p.host, () => {
      sock.setTimeout(0);
      if (p.type === 'socks5') {
        // 无认证或用户名密码认证（RFC 1929）
        const useAuth = !!p.username;
        sock.write(Buffer.from([0x05, 0x01, useAuth ? 0x02 : 0x00]));
        sock.once('data', (greet: Buffer) => {
          if (greet.length < 2 || greet[0] !== 0x05) return fail(new Error('SOCKS5 代理应答异常'));
          if (greet[1] === 0x02) {
            const u = Buffer.from(p.username || '', 'utf8');
            const pw = Buffer.from(p.password || '', 'utf8');
            sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([pw.length]), pw]));
          } else if (greet[1] !== 0x00) {
            return fail(new Error('SOCKS5 代理不接受当前认证方式'));
          }
          const sendConnect = () => {
            const hostBuf = Buffer.from(host, 'utf8');
            const req = Buffer.alloc(7 + hostBuf.length);
            req[0] = 0x05;
            req[1] = 0x01; // CONNECT
            req[2] = 0x00;
            req[3] = 0x03; // 域名
            req[4] = hostBuf.length;
            hostBuf.copy(req, 5);
            req.writeUInt16BE(port, 5 + hostBuf.length);
            sock.write(req);
            // CONNECT 应答监听必须在这里注册：若与认证监听并排注册，
            // 认证应答 [0x01,0x00] 会同时触发两个处理器导致误判失败
            sock.once('data', (reply: Buffer) => {
              if (reply.length < 4 || reply[1] !== 0x00) {
                return fail(new Error(`SOCKS5 代理隧道建立失败（状态码 ${reply[1] ?? '?'}）`));
              }
              sock.removeAllListeners('error');
              sock.on('error', () => sock.destroy());
              settled = true;
              resolve(sock);
            });
          };
          if (useAuth) {
            sock.once('data', (authReply: Buffer) => {
              if (authReply.length < 2 || authReply[1] !== 0x00) return fail(new Error('SOCKS5 代理认证失败'));
              sendConnect();
            });
          } else {
            sendConnect();
          }
        });
      } else {
        // HTTP CONNECT 代理
        const auth = p.username ? `\r\nProxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password || ''}`).toString('base64')}` : '';
        sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}${auth}\r\n\r\n`);
        let buf = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const head = buf.toString('latin1');
          const idx = head.indexOf('\r\n\r\n');
          if (idx < 0) {
            if (buf.length > 8192) fail(new Error('HTTP 代理应答异常'));
            return;
          }
          sock.off('data', onData);
          if (!/^HTTP\/1\.[01] 2\d\d /.test(head)) {
            return fail(new Error(`HTTP 代理拒绝隧道请求（${head.split('\r\n')[0]}）`));
          }
          // 丢弃头部后残余字节（正常情况下 CONNECT 响应后无数据）
          sock.removeAllListeners('error');
          sock.on('error', () => sock.destroy());
          settled = true;
          resolve(sock);
        };
        sock.on('data', onData);
      }
    });
  });
}

/** 经 SSH 跳板机 forwardOut 到目标主机（返回可复用的 ClientChannel 作为 sock） */
function openJumpSocket(
  j: JumpConfig,
  host: string,
  port: number,
  acceptHostKey?: boolean
): Promise<{ sock: ClientChannel; jump: Client }> {
  return new Promise((resolve, reject) => {
    const jump = new Client();
    const cfg: ConnectConfig = {
      host: j.host,
      port: j.port,
      username: j.username,
      readyTimeout: 15000,
      keepaliveInterval: 15000
    };
    // 跳板机自身也要做主机指纹校验（TOFU），否则凭据可能先交给未验证身份的中间人
    let pending: { sha256: string; keyType: string; kind: 'unknown' | 'mismatch' } | null = null;
    cfg.hostVerifier = (key: Buffer): boolean => {
      const result = checkHostKey(j.host, j.port, key);
      if (result === 'match') return true;
      if (result === 'unknown' && acceptHostKey) {
        trustHostKey(j.host, j.port, key);
        return true;
      }
      pending = { sha256: sha256Fingerprint(key), keyType: extractKeyType(key), kind: result };
      return false;
    };
    if (j.authType === 'password') {
      cfg.password = j.password;
    } else {
      try {
        cfg.privateKey = resolvePrivateKey(j.privateKey || '');
      } catch (err) {
        reject(err);
        return;
      }
      if (j.passphrase) cfg.passphrase = j.passphrase;
    }
    jump
      .on('ready', () => {
        jump.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
          if (err) {
            jump.end();
            reject(new Error(`跳板机转发失败（${j.host}:${j.port} → ${host}:${port}）：${err.message}`));
            return;
          }
          resolve({ sock: stream, jump });
        });
      })
      .on('error', (err) => {
        if (pending) {
          const tag = pending.kind === 'mismatch' ? 'HOSTKEY_MISMATCH' : 'HOSTKEY_UNKNOWN';
          reject(new Error(`__${tag}__|${j.host}|${j.port}|${pending.sha256}|${pending.keyType}`));
          return;
        }
        reject(new Error(`跳板机连接失败（${j.host}:${j.port}）：${err.message}`));
      })
      .connect(cfg);
  });
}

export class SSHSession extends EventEmitter {
  private conn: Client | null = null;
  private stream: ClientChannel | null = null;
  private jumpConn: Client | null = null;
  private closed = false;
  /** 用户主动断开（disconnect/关闭窗口）——不允许自动重连 */
  private userEnded = false;
  /** 至少成功连接过一次（重连的前提） */
  private hasConnected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 重连期间排队的用户输入，重连成功后按序补发 */
  private writeQueue: string[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatMiss = 0;
  /** hostVerifier 捕获的待确认指纹（连接失败时翻译成结构化错误给前端） */
  private pendingHostKey: { sha256: string; keyType: string; kind: 'unknown' | 'mismatch' } | null = null;

  /** 远端操作系统探测结果（每会话一次） */
  private remoteOS: 'linux' | 'windows' | null = null;
  private remoteOSPromise: Promise<'linux' | 'windows'> | null = null;

  constructor(public id: string, private config: SSHSessionConfig) {
    super();
    this.setMaxListeners(100);
  }

  private emitOnce(event: 'close' | 'error', ...args: any[]) {
    if (this.closed && event === 'close') return;
    if (event === 'close') this.closed = true;
    this.emit(event, ...args);
  }

  connect(): Promise<void> {
    this.userEnded = false;
    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closed = false;
      const conn = new Client();
      this.conn = conn;
      let settled = false;
      this.pendingHostKey = null;

      const connectConfig: ConnectConfig = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        readyTimeout: 15000,
        keepaliveInterval: 15000
      };

      if (this.config.authType === 'password') {
        connectConfig.password = this.config.password;
      } else {
        try {
          connectConfig.privateKey = resolvePrivateKey(this.config.privateKey || '', this.config.privateKeyPath);
        } catch (err: any) {
          reject(err);
          return;
        }
        if (this.config.passphrase) connectConfig.passphrase = this.config.passphrase;
      }

      // 主机指纹校验（TOFU）：未知需用户确认（除非本次已确认），不一致一律拦截
      connectConfig.hostVerifier = (key: Buffer): boolean => {
        const result = checkHostKey(this.config.host, this.config.port, key);
        if (result === 'match') return true;
        if (result === 'unknown' && this.config.acceptHostKey) {
          trustHostKey(this.config.host, this.config.port, key);
          return true;
        }
        // result === 'mismatch' 时即使 acceptHostKey 也拦截（确认过指纹后被更换 = 高危）
        this.pendingHostKey = { sha256: sha256Fingerprint(key), keyType: extractKeyType(key), kind: result };
        return false;
      };

      // 经跳板机 / 代理建立底层通道
      const setupSock = async (): Promise<void> => {
        if (this.config.jump) {
          const { sock, jump } = await openJumpSocket(this.config.jump, this.config.host, this.config.port, this.config.acceptHostKey);
          this.jumpConn = jump;
          connectConfig.sock = sock as any;
        } else if (this.config.proxy) {
          connectConfig.sock = (await openProxySocket(this.config.proxy, this.config.host, this.config.port)) as any;
        }
      };

      setupSock().then(
        () => {
          conn
            .on('ready', () => {
              settled = true;
              const wasReconnect = this.hasConnected;
              this.hasConnected = true;
              this.reconnectAttempts = 0;
              this.startHeartbeat();
              conn.shell({ term: 'xterm-256color' }, (err, stream) => {
                if (err) {
                  // shell 创建失败：必须清理已建立的连接与心跳，避免泄漏
                  this.stopHeartbeat();
                  try {
                    conn.end();
                  } catch {
                    /* ignore */
                  }
                  try {
                    this.jumpConn?.end();
                  } catch {
                    /* ignore */
                  }
                  settled = true;
                  reject(err);
                  return;
                }
                this.stream = stream;
                stream.on('data', (data: Buffer) => {
                  this.emit('data', data.toString('utf8'));
                });
                stream.stderr.on('data', (data: Buffer) => {
                  this.emit('data', data.toString('utf8'));
                });
                stream.on('close', () => {
                  this.handleDisconnect('shell 已关闭');
                });
                if (wasReconnect) {
                  this.emit('reconnected');
                  // 补发重连期间排队的输入
                  const queued = this.writeQueue.splice(0);
                  for (const q of queued) {
                    try {
                      stream.write(q);
                    } catch {
                      /* ignore */
                    }
                  }
                  log('info', `SSH ${this.config.host}:${this.config.port} 重连成功`);
                }
                resolve();
              });
            })
            .on('error', (err: Error) => {
              // 主机指纹拦截：翻译成结构化错误供前端弹窗确认
              if (this.pendingHostKey) {
                const phk = this.pendingHostKey;
                this.pendingHostKey = null;
                if (!settled) {
                  settled = true;
                  const tag = phk.kind === 'mismatch' ? 'HOSTKEY_MISMATCH' : 'HOSTKEY_UNKNOWN';
                  reject(new Error(`__${tag}__|${this.config.host}|${this.config.port}|${phk.sha256}|${phk.keyType}`));
                  return;
                }
              }
              if (!settled) {
                settled = true;
                reject(err);
                return;
              }
              this.handleDisconnect(err.message);
            })
            .on('close', () => {
              this.stopHeartbeat();
              if (!settled) {
                // 连接建立前就关闭（主机指纹被拒等）
                settled = true;
                reject(new Error(this.pendingHostKey ? '主机指纹校验未通过' : 'SSH 连接被关闭'));
                return;
              }
              this.handleDisconnect('连接已关闭');
            })
            .connect(connectConfig);
        },
        (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      );
    });
  }

  /** 连接断开统一处理：用户主动结束→直接 close；否则进入自动重连 */
  private handleDisconnect(reason: string) {
    this.stopHeartbeat();
    this.closeJumpConn();
    if (this.userEnded) {
      this.emitOnce('close');
      return;
    }
    if (!this.hasConnected) return; // 首连失败走 reject，不触发重连
    if (this.closed) return; // 已经 close 过
    if (this.reconnectAttempts >= RECONNECT_MAX) {
      log('warn', `SSH ${this.config.host}:${this.config.port} 重连 ${RECONNECT_MAX} 次失败，放弃：${reason}`);
      this.emitOnce('error', `连接已断开（${reason}），自动重连 ${RECONNECT_MAX} 次均失败`);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.userEnded) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    log('info', `SSH ${this.config.host}:${this.config.port} 第 ${this.reconnectAttempts}/${RECONNECT_MAX} 次重连（${delay}ms 后）`);
    this.emit('reconnecting', { attempt: this.reconnectAttempts, max: RECONNECT_MAX, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.userEnded) return;
      this.doConnect().catch(() => {
        // 重连失败：on('close'/'error') 会再次进入 handleDisconnect 形成退避循环；
        // 这里兜底：若连接根本没触发事件（如 DNS 失败静默），手动续链
        if (!this.userEnded && this.reconnectAttempts > 0) {
          this.handleDisconnect('重连失败');
        }
      });
    }, delay);
  }

  /** 心跳探活：exec true 连续 2 次超时/失败视为假死，强制断开走重连 */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatMiss = 0;
    this.heartbeatTimer = setInterval(() => {
      const conn = this.conn;
      if (!conn || this.closed || this.userEnded) return;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.onHeartbeatResult(false);
        }
      }, HEARTBEAT_TIMEOUT_MS);
      try {
        conn.exec('true', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.onHeartbeatResult(!err);
          if (!err) {
            // 确认通道真正退出即可（不关心输出）
          }
        });
      } catch {
        clearTimeout(timer);
        this.onHeartbeatResult(false);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private onHeartbeatResult(ok: boolean) {
    if (ok) {
      this.heartbeatMiss = 0;
      return;
    }
    this.heartbeatMiss++;
    if (this.heartbeatMiss >= 2) {
      log('warn', `SSH ${this.config.host}:${this.config.port} 心跳连续失败，判定假死，强制断开`);
      try {
        this.conn?.end();
      } catch {
        /* ignore */
      }
    }
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private closeJumpConn() {
    if (this.jumpConn) {
      try {
        this.jumpConn.end();
      } catch {
        /* ignore */
      }
      this.jumpConn = null;
    }
  }

  write(data: string) {
    if (this.stream && !this.stream.destroyed) {
      try {
        this.stream.write(data);
      } catch {
        /* stream 可能刚好断开 */
      }
      return;
    }
    // 重连中：排队等待补发（仅 SSH 会话；其他协议无重连）
    if (this.hasConnected && !this.userEnded && !this.closed) {
      if (this.writeQueue.length < 500) this.writeQueue.push(data);
    }
  }

  resize(cols: number, rows: number) {
    if (this.stream && cols > 0 && rows > 0) {
      this.stream.setWindow(rows, cols, 0, 0);
    }
  }

  /** Execute a command in a one-shot shell (separate from the interactive stream) */
  async exec(command: string, timeoutMs = 15000): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject(new Error('Not connected'));
        return;
      }
      let stdout = '';
      let stderr = '';
      let code: number | null = null;
      let settled = false;
      let activeStream: ClientChannel | null = null;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // 超时必须主动关闭通道，否则远端长命令会一直挂着占资源
          try {
            activeStream?.close();
          } catch {
            /* ignore */
          }
          resolve({ stdout, stderr: stderr || '(timeout)', code });
        }
      }, timeoutMs);

      this.conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
          return;
        }
        activeStream = stream;
        stream
          .on('data', (data: Buffer) => {
            stdout += data.toString('utf8');
          })
          .stderr.on('data', (data: Buffer) => {
            stderr += data.toString('utf8');
          })
          .on('close', (c: number | null) => {
            clearTimeout(timer);
            code = c;
            if (!settled) {
              settled = true;
              resolve({ stdout, stderr, code });
            }
          });
      });
    });
  }

  /**
   * 探测远端操作系统（每会话只探测一次，结果缓存）。
   * Windows OpenSSH 默认 shell 为 cmd，`cmd /c ver` 输出版本串；
   * Linux 上没有 cmd 命令，stdout 为空 → 判定 linux。
   */
  async detectOS(): Promise<'linux' | 'windows'> {
    if (this.remoteOS) return this.remoteOS;
    if (!this.remoteOSPromise) {
      this.remoteOSPromise = (async () => {
        try {
          const { stdout } = await this.exec('cmd /c ver', 8000);
          if (/Microsoft Windows/i.test(stdout)) {
            this.remoteOS = 'windows';
            log('info', '[ssh] 远端 OS 检测：Windows');
          }
        } catch {
          /* 探测失败按 linux 处理（原行为不变） */
        }
        if (!this.remoteOS) this.remoteOS = 'linux';
        return this.remoteOS;
      })();
    }
    return this.remoteOSPromise;
  }

  async getServerInfo(): Promise<ServerInfo> {
    const osType = await this.detectOS();
    const cmd = osType === 'windows' ? psCommand(WIN_SERVER_INFO_SCRIPT) : `
echo "__HOST__";hostname;
echo "__OS__";(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2) || uname -o;
echo "__KERNEL__";uname -r;
echo "__ARCH__";uname -m;
echo "__CPU__";lscpu 2>/dev/null | grep 'Model name' | cut -d':' -f2 | xargs;
echo "__CORES__";nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo;
echo "__MEM__";free -m | awk 'NR==2{print $2,$3,$4,$7}';
echo "__SWAP__";free -m | awk 'NR==3{print $2,$3,$4}';
echo "__LOAD__";cat /proc/loadavg | cut -d' ' -f1-3;
echo "__UPTIME__";uptime -p 2>/dev/null || uptime;
echo "__USERS__";who 2>/dev/null | awk '{print $1}' | sort | uniq -c | sort -rn | head -8;
echo "__IP__";hostname -I 2>/dev/null || ip -4 addr 2>/dev/null | grep inet | grep -v 127.0.0.1 | awk '{print $2}';
echo "__DISK__";df -h --output=source,size,used,avail,pcent,target -x tmpfs -x devtmpfs -x overlay 2>/dev/null | head -12;
echo "__PROC__";ps aux --sort=-%mem 2>/dev/null | head -6 | tail -5;
echo "__DOCKER__";(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | head -8) || true;
echo "__END__";
`.trim();

    const { stdout } = await this.exec(cmd, 20000);
    const sections = stdout.split('__');
    const pick = (key: string) => {
      const idx = sections.indexOf(key);
      return idx >= 0 && idx + 1 < sections.length ? sections[idx + 1].trim() : '';
    };

    const memLine = pick('MEM');
    const memParts = memLine.split(/\s+/).map((x) => parseInt(x, 10));
    const memTotal = memParts[0] || 0;
    const memUsed = memParts[1] || 0;
    const memFree = memParts[2] || 0;
    // 注意：free -m 第 2 行第 4 个字段是 Mem 的 available（不是 swap）
    const memAvailable = memParts[3] || 0;
    // swap 取自第 3 行（Swap: total used free）
    const swapParts = pick('SWAP').split(/\s+/).map((x) => parseInt(x, 10));
    const swapTotal = swapParts[0] || 0;
    const swapUsed = swapParts[1] || 0;

    const diskRaw = pick('DISK');
    const diskLines = diskRaw.split('\n').filter((l) => l.trim());
    const diskList = diskLines.slice(1).map((l) => {
      const parts = l.trim().split(/\s+/);
      return {
        fs: parts[0] || '',
        size: parts[1] || '',
        used: parts[2] || '',
        avail: parts[3] || '',
        use: parts[4] || '',
        mount: parts[5] || ''
      };
    });

    return {
      hostname: pick('HOST') || 'unknown',
      os: pick('OS') || 'unknown',
      kernel: pick('KERNEL'),
      arch: pick('ARCH'),
      cpuModel: pick('CPU'),
      cpuCores: parseInt(pick('CORES'), 10) || 1,
      memTotal,
      memUsed,
      memFree,
      memAvailable,
      swapTotal,
      swapUsed,
      diskList,
      // Windows 无 1/5/15 分钟负载均值：单值 CPU 负载%，5/15 分钟位 N/A 占位
      load: osType === 'windows' ? windowsLoadArray(pick('LOAD').split(/\s+/).filter(Boolean)) : pick('LOAD').split(/\s+/).filter(Boolean),
      uptime: pick('UPTIME'),
      users: pick('USERS').split('\n').filter(Boolean),
      topProcesses: pick('PROC').split('\n').filter(Boolean),
      docker: pick('DOCKER') || null,
      ipAddresses: pick('IP').split(/\s+/).filter(Boolean)
    };
  }

  /** 安全审计数据采集 */
  async getSecurityAuditData(): Promise<string> {
    // 安全审计检查项（sshd_config/SUID/cron 等）目前仅覆盖 Linux；
    // Windows 远端如实说明，不伪装成"审计通过"
    const osType = await this.detectOS();
    if (osType === 'windows') {
      let basic = '';
      try {
        const r = await this.exec(psCommand(WIN_AUDIT_SCRIPT), 15000);
        basic = r.stdout;
      } catch {
        /* 基础信息采集失败不影响说明文本 */
      }
      return [
        '=== AUDIT_SECTION: NOTE ===',
        '安全审计检查项当前仅支持 Linux 远端（Windows 检查集规划中），本次未执行审计。',
        '',
        '=== AUDIT_SECTION: BASIC_INFO ===',
        basic
      ].join('\n');
    }
    const cmd = `
echo "=== AUDIT_SECTION: SSH_CONFIG ==="
grep -hE '^[^#]' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | grep -E 'PermitRootLogin|PasswordAuthentication|PermitEmptyPasswords|PubkeyAuthentication|X11Forwarding' || echo "无 /etc/ssh/sshd_config 访问权限"
echo ""
echo "=== AUDIT_SECTION: SUID_BINARIES ==="
find / -perm -4000 -type f 2>/dev/null | head -30
echo ""
echo "=== AUDIT_SECTION: WORLD_WRITABLE_DIRS ==="
find /etc /var /usr/local -perm -0002 ! -perm -1000 -type d 2>/dev/null | head -20
echo ""
echo "=== AUDIT_SECTION: SENSITIVE_FILES ==="
for f in /etc/shadow /etc/sudoers /root/.ssh/authorized_keys /etc/passwd; do
  if [ -e "$f" ]; then
    echo "--- $f (permission: $(stat -c '%a %U:%G' "$f" 2>/dev/null || echo 'N/A')) ---"
  else
    echo "--- $f (missing) ---"
  fi
done
echo ""
echo "=== AUDIT_SECTION: OPEN_PORTS ==="
ss -lntp 2>/dev/null | head -30
echo ""
echo "=== AUDIT_SECTION: SUDO_RULES ==="
sudo -n -l 2>/dev/null | head -30 || echo "无 sudo 权限"
echo ""
echo "=== AUDIT_SECTION: AUTH_POLICY ==="
grep -E '^PASS_(MAX|MIN|WARN)_DAYS' /etc/login.defs 2>/dev/null || echo "未配置口令有效期"
echo ""
echo "=== AUDIT_SECTION: DOCKER_SOCKET ==="
if [ -e /var/run/docker.sock ]; then stat -c '%a %U:%G' /var/run/docker.sock 2>/dev/null; else echo "none"; fi
echo ""
echo "=== AUDIT_SECTION: FAIL2BAN ==="
systemctl is-active fail2ban 2>/dev/null || echo "inactive"
echo ""
echo "=== AUDIT_SECTION: RUNNING_SERVICES ==="
systemctl list-units --type=service --state=running 2>/dev/null | head -30
echo ""
echo "=== AUDIT_SECTION: CRON_JOBS ==="
ls -la /etc/cron.* 2>/dev/null | head -10
crontab -l 2>/dev/null | head -10
echo ""
echo "=== AUDIT_SECTION: SSL_CERTS ==="
for d in /etc/ssl /etc/letsencrypt /etc/nginx; do
  find "$d" -name '*.pem' -o -name '*.crt' 2>/dev/null | head -5
done
echo "=== AUDIT_END ==="
`.trim();
    const { stdout } = await this.exec(cmd, 25000);
    return stdout;
  }

  /** 一站式诊断证据收集 */
  async getDiagnosticsBundle(): Promise<{ [section: string]: string }> {
    const osType = await this.detectOS();
    const cmd = osType === 'windows' ? psCommand(WIN_DIAG_SCRIPT) : `
echo "=== DIAG: TOP ==="
top -bn1 | head -20
echo ""
echo "=== DIAG: FREE ==="
free -h
echo ""
echo "=== DIAG: DF ==="
df -h
echo ""
echo "=== DIAG: DMESG_OOM ==="
dmesg 2>/dev/null | grep -iE 'oom|kill|error|fail' | tail -30
echo ""
echo "=== DIAG: JOURNAL_ERRORS ==="
journalctl -p err -n 30 --no-pager 2>/dev/null | tail -30
echo ""
echo "=== DIAG: PS_TOP_MEM ==="
ps aux --sort=-%mem | head -15
echo ""
echo "=== DIAG: PS_TOP_CPU ==="
ps aux --sort=-%cpu | head -15
echo ""
echo "=== DIAG: NETWORK ==="
ss -lntp 2>/dev/null | head -20
ip -4 addr 2>/dev/null | grep inet
echo ""
echo "=== DIAG: SYSTEMD_FAILED ==="
systemctl --failed 2>/dev/null | head -15
echo ""
echo "=== DIAG: UPTIME ==="
uptime
echo "=== DIAG_END ==="
`.trim();
    const { stdout } = await this.exec(cmd, 25000);
    const sections: { [k: string]: string } = {};
    const re = /=== DIAG: (\w+) ===\n([\s\S]*?)(?=\n=== DIAG:|\n=== DIAG_END ===|$)/g;
    let m;
    while ((m = re.exec(stdout)) !== null) {
      sections[m[1]] = m[2];
    }
    return sections;
  }

  /** 指标快照（用于趋势/预测） */
  async getMetricsSnapshot(): Promise<{
    ts: number;
    hostname: string;
    cpuPercent: number;
    memPercent: number;
    disk: { mount: string; usePercent: number; availGB: number }[];
    load1: number;
    connections: number;
    os: 'linux' | 'windows';
  }> {
    const osType = await this.detectOS();
    const cmd = osType === 'windows' ? psCommand(WIN_METRICS_SCRIPT) : `
echo "=== M_HOST ==="; hostname
echo "=== M_CPU ==="; top -bn1 | grep '%Cpu' | awk '{print 100 - $8}' 2>/dev/null
echo "=== M_MEM ==="; free | awk 'NR==2{print $3/$2 * 100}'
echo "=== M_LOAD ==="; cat /proc/loadavg | cut -d' ' -f1
echo "=== M_DISK ==="; df -h --output=target,pcent,avail -x tmpfs -x devtmpfs -x overlay 2>/dev/null | tail -n +2
echo "=== M_CONN ==="; ss -ant 2>/dev/null | wc -l
echo "=== M_END ==="
`.trim();
    const { stdout } = await this.exec(cmd, 15000);
    const sections = stdout.split('===');
    const pick = (k: string) => {
      const i = sections.indexOf(` ${k} `);
      return i >= 0 && i + 1 < sections.length ? sections[i + 1].trim() : '';
    };
    const diskLines = pick('M_DISK')
      .split('\n')
      .filter((l) => l.trim());
    // df -h 的 avail 带 K/M/G/T 后缀，直接 parseFloat 会把 500M 当成 500 GB
    const parseAvailGB = (s: string): number => {
      const m = /^([\d.]+)([KMGTPE])?i?B?$/i.exec((s || '').trim());
      if (!m) return 0;
      const n = parseFloat(m[1]);
      if (!Number.isFinite(n)) return 0;
      const unit = (m[2] || 'G').toUpperCase();
      const factor: Record<string, number> = { K: 1 / 1048576, M: 1 / 1024, G: 1, T: 1024, P: 1048576, E: 1073741824 };
      return Math.round(n * (factor[unit] ?? 1) * 100) / 100;
    };
    const cpuPercent = parseFloat(pick('M_CPU'));
    const memPercent = parseFloat(pick('M_MEM'));
    // 关键指标缺失说明采集失败（命令不存在/超时等），必须抛错让巡检记为失败，
    // 不能用 || 0 把"没采到"伪装成"一切正常"
    if (!Number.isFinite(cpuPercent) || !Number.isFinite(memPercent)) {
      throw new Error('指标采集失败：CPU/内存数据缺失（远端命令异常或超时）');
    }
    return {
      ts: Date.now(),
      hostname: pick('M_HOST') || 'unknown',
      cpuPercent,
      memPercent,
      load1: parseFloat(pick('M_LOAD')) || 0,
      connections: parseInt(pick('M_CONN'), 10) || 0,
      os: osType,
      disk: diskLines.map((l) => {
        const [mount, pct, avail] = l.trim().split(/\s+/);
        return {
          mount,
          usePercent: parseFloat(pct) || 0,
          availGB: parseAvailGB(avail)
        };
      })
    };
  }

  end() {
    // 用户主动断开：终止一切重连与心跳
    this.userEnded = true;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.closeJumpConn();
    if (this.stream) {
      try {
        this.stream.end();
      } catch {}
      this.stream = null;
    }
    if (this.conn) {
      try {
        this.conn.end();
      } catch {}
      this.conn = null;
    }
  }

  /** 获取底层 Client 以便创建 SFTP 子系统 */
  getClient(): Client | null {
    return this.conn;
  }

  /** 打开 SFTP 子系统 */
  openSftp(): Promise<import('ssh2').SFTPWrapper> {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        reject(new Error('SSH 连接未建立'));
        return;
      }
      this.conn.sftp((err, sftp) => {
        if (err) reject(err);
        else resolve(sftp);
      });
    });
  }
}
