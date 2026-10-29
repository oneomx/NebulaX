import { createServer, connect, type Server, type Socket } from 'net';
import { EventEmitter } from 'events';
import type { Client } from 'ssh2';
import type { SSHSession } from './ssh';

export interface TunnelSpec {
  /** local = 本地端口转发；dynamic = SOCKS5 代理（流量走 SSH） */
  type: 'local' | 'dynamic';
  /** 本地监听端口（0 = 系统自动分配） */
  localPort: number;
  /** local 转发目标主机 */
  remoteHost?: string;
  /** local 转发目标端口 */
  remotePort?: number;
}

export interface TunnelInfo {
  id: string;
  sessionId: string;
  type: 'local' | 'dynamic';
  localPort: number;
  remoteHost?: string;
  remotePort?: number;
  connections: number;
  createdAt: number;
  error?: string;
}

interface TunnelRecord {
  info: TunnelInfo;
  server: Server;
  session: SSHSession;
  /** 活跃的本地 socket 集合（stop 时需要一并销毁，否则已建立的转发会继续传输） */
  sockets: Set<Socket>;
}

let seq = 0;

/**
 * SSH 隧道管理器（对标 MobaXterm Tunneling）：
 * - local：本地端口转发 —— 监听 127.0.0.1:localPort，经 SSH forwardOut 打到 remoteHost:remotePort
 *   （典型用法：ssh -L 13306:db:3389）
 * - dynamic：SOCKS5 代理 —— 浏览器/任意程序把代理指向 127.0.0.1:localPort，
 *   所有 TCP 流量经 SSH 加密隧道出去（等价 ssh -D）
 */
export class TunnelManager extends EventEmitter {
  private tunnels = new Map<string, TunnelRecord>();

  list(): TunnelInfo[] {
    return Array.from(this.tunnels.values()).map((t) => ({ ...t.info }));
  }

  async start(sessionId: string, session: SSHSession, spec: TunnelSpec): Promise<TunnelInfo> {
    // 创建时校验可用；每个连接建立时再动态取 client，SSH 自动重连后隧道继续可用
    if (!session.getClient()) throw new Error('SSH 连接不可用，无法创建隧道');

    const id = `tun_${Date.now()}_${(++seq).toString(36)}`;
    const info: TunnelInfo = {
      id,
      sessionId,
      type: spec.type,
      localPort: spec.localPort,
      remoteHost: spec.remoteHost,
      remotePort: spec.remotePort,
      connections: 0,
      createdAt: Date.now()
    };

    const server = createServer();
    const record: TunnelRecord = { info, server, session, sockets: new Set() };
    this.tunnels.set(id, record);

    server.on('connection', (socket: Socket) => {
      // 动态取当前 client：重连后 getClient() 返回新连接，旧 client 已失效
      const client = session.getClient();
      if (!client) {
        info.error = 'SSH 连接不可用';
        socket.destroy();
        this.emit('update');
        return;
      }
      record.sockets.add(socket);
      socket.on('close', () => record.sockets.delete(socket));
      if (info.type === 'dynamic') {
        this.handleSocks5(socket, client, info);
      } else {
        this.handleLocalForward(socket, client, info);
      }
    });

    server.on('error', (err: Error) => {
      info.error = err.message;
      this.emit('update');
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: Error) => {
        this.tunnels.delete(id);
        reject(new Error(`本地端口 ${spec.localPort} 监听失败：${err.message}`));
      });
      server.listen(spec.localPort, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') info.localPort = addr.port;
        resolve();
      });
    });

    this.emit('update');
    return { ...info };
  }

  /** 关闭隧道记录：销毁监听 Server 与所有已建立的转发 socket */
  private destroyRecord(t: TunnelRecord) {
    try {
      t.server.close();
    } catch {
      /* ignore */
    }
    for (const s of t.sockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    t.sockets.clear();
  }

  stop(id: string): boolean {
    const t = this.tunnels.get(id);
    if (!t) return false;
    this.destroyRecord(t);
    this.tunnels.delete(id);
    this.emit('update');
    return true;
  }

  /** 关闭某 SSH 会话的全部隧道（会话断开时调用） */
  stopBySession(sessionId: string) {
    for (const [id, t] of this.tunnels) {
      if (t.info.sessionId === sessionId) {
        this.destroyRecord(t);
        this.tunnels.delete(id);
      }
    }
    this.emit('update');
  }

  stopAll() {
    for (const t of this.tunnels.values()) {
      this.destroyRecord(t);
    }
    this.tunnels.clear();
  }

  /** 本地端口转发核心：本地 socket ↔ SSH forwardOut 流 */
  private handleLocalForward(socket: Socket, client: Client, info: TunnelInfo) {
    info.connections++;
    this.emit('update');
    client.forwardOut('127.0.0.1', socket.remotePort || 0, info.remoteHost!, info.remotePort!, (err, stream) => {
      if (err) {
        info.error = `转发失败：${err.message}`;
        socket.destroy();
        this.emit('update');
        return;
      }
      socket.pipe(stream).pipe(socket);
      socket.on('close', () => {
        stream.close?.();
        info.connections = Math.max(0, info.connections - 1);
        this.emit('update');
      });
      stream.on('close', () => socket.destroy());
      stream.on('error', () => socket.destroy());
    });
    socket.on('error', () => socket.destroy());
  }

  /**
   * 极简 SOCKS5 服务端（无认证，仅 CONNECT，支持 IPv4/域名）。
   * 握手用累积缓冲状态机而非"一次 data 事件 = 一个完整报文"的假设：
   * TCP 可能把 hello/请求拆成多个分片，也可能与后续应用数据合并在一个分片里。
   */
  private handleSocks5(socket: Socket, client: Client, info: TunnelInfo) {
    let buf = Buffer.alloc(0);
    let phase: 'hello' | 'req' = 'hello';
    // 握手超时保护：10 秒未完成协商即断开，防半开连接堆积
    const guard = setTimeout(() => socket.destroy(), 10000);

    const onData = (chunk: Buffer) => {
      try {
        buf = Buffer.concat([buf, chunk]);

        if (phase === 'hello') {
          // VER NMETHODS METHODS...（只支持无认证）
          if (buf.length < 2) return;
          const nmethods = buf[1];
          if (buf.length < 2 + nmethods) return;
          if (buf[0] !== 0x05) {
            socket.destroy();
            return;
          }
          socket.write(Buffer.from([0x05, 0x00]));
          buf = buf.subarray(2 + nmethods);
          phase = 'req';
        }

        if (phase === 'req') {
          // VER CMD RSV ATYP DST.ADDR DST.PORT —— 先等到能读 ATYP，再算出完整请求长度
          if (buf.length < 4) return;
          if (buf[0] !== 0x05 || buf[1] !== 0x01) {
            // 仅支持 CONNECT
            socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.destroy();
            return;
          }
          let need = 0;
          if (buf[3] === 0x01) need = 10; // IPv4
          else if (buf[3] === 0x03) {
            if (buf.length < 5) return;
            need = 7 + buf[4]; // 域名
          } else {
            // IPv6 不支持
            socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.destroy();
            return;
          }
          if (buf.length < need) return; // 请求尚未收齐，继续等

          const req = buf.subarray(0, need);
          const rest = buf.subarray(need); // 合包时随请求一起到达的应用数据
          buf = Buffer.alloc(0);

          let host = '';
          let port = 0;
          if (req[3] === 0x01) {
            host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
            port = req.readUInt16BE(8);
          } else {
            const len = req[4];
            host = req.subarray(5, 5 + len).toString('utf8');
            port = req.readUInt16BE(5 + len);
          }

          // 握手完成，摘掉缓冲监听，转入透明转发
          clearTimeout(guard);
          socket.removeListener('data', onData);

          info.connections++;
          this.emit('update');
          client.forwardOut('127.0.0.1', socket.remotePort || 0, host, port, (err, stream) => {
            if (err) {
              socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              socket.destroy();
              info.connections = Math.max(0, info.connections - 1);
              return;
            }
            // 成功应答（绑定地址 0.0.0.0:0）
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            // 合包场景：请求后可能已带应用数据，先补发再 pipe
            if (rest.length > 0) stream.write(rest);
            socket.pipe(stream).pipe(socket);
            socket.on('close', () => {
              stream.close?.();
              info.connections = Math.max(0, info.connections - 1);
              this.emit('update');
            });
            stream.on('close', () => socket.destroy());
            stream.on('error', () => socket.destroy());
          });
        }
      } catch {
        // 畸形 SOCKS5 包：直接销毁连接，绝不让异常冒泡打崩主进程
        clearTimeout(guard);
        socket.destroy();
      }
    };

    socket.on('data', onData);
    socket.on('error', () => {
      clearTimeout(guard);
      socket.destroy();
    });
  }
}

export const tunnelManager = new TunnelManager();
