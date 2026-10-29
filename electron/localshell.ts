import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';

export interface LocalShellConfig {
  /** shell 预设：powershell | pwsh | cmd | wsl | git-bash | bash | custom */
  shell?: string;
  /** custom 时的完整命令 */
  command?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** 可用 shell 预设清单（Windows 适配；Linux/macOS 走 bash） */
export const SHELL_PRESETS: { id: string; label: string; win?: boolean; unix?: boolean }[] = [
  { id: 'powershell', label: 'Windows PowerShell', win: true },
  { id: 'pwsh', label: 'PowerShell 7 (pwsh)', win: true },
  { id: 'cmd', label: '命令提示符 (CMD)', win: true },
  { id: 'wsl', label: 'WSL (Linux)', win: true },
  { id: 'git-bash', label: 'Git Bash', win: true },
  { id: 'bash', label: 'Bash', unix: true }
];

/** 解析 shell 预设为启动命令（文件不存在的预设返回 null） */
export function resolveShellCommand(shellId: string): { file: string; args: string[] } | null {
  const win = process.platform === 'win32';
  switch (shellId) {
    case 'powershell':
      return {
        file: win ? 'powershell.exe' : 'powershell',
        args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass']
      };
    case 'pwsh':
      // pwsh 可能在 PATH（scoop/winget 安装）也可能在 Program Files，交给 PATH 解析
      return { file: 'pwsh', args: ['-NoLogo', '-NoProfile'] };
    case 'cmd':
      return { file: 'cmd.exe', args: [] };
    case 'wsl':
      // 不带 -d 参数使用系统默认发行版（硬编码 -d Ubuntu 在未安装该发行版时会直接报错）
      return { file: 'wsl.exe', args: [] };
    case 'git-bash': {
      const candidates = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        `${process.env['LOCALAPPDATA'] || ''}\\Programs\\Git\\bin\\bash.exe`
      ];
      const fs = require('fs') as typeof import('fs');
      for (const c of candidates) {
        try {
          if (c && fs.existsSync(c)) return { file: c, args: ['-l'] };
        } catch {
          /* ignore */
        }
      }
      return null;
    }
    case 'bash':
      return { file: '/bin/bash', args: ['-l'] };
    default:
      return null;
  }
}

// node-pty 类型（@lydell/node-pty 与 node-pty API 兼容；避免硬依赖类型包）
interface PtyProcess {
  on(event: 'data', cb: (data: string) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
interface PtyModule {
  spawn(file: string, args: string[], opts: Record<string, unknown>): PtyProcess;
}

let ptyMod: PtyModule | null | undefined;

/** 惰性加载 node-pty（预编译包不可用时返回 null，走管道降级） */
function loadPty(): PtyModule | null {
  if (ptyMod !== undefined) return ptyMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyMod = require('@lydell/node-pty') as PtyModule;
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ptyMod = require('node-pty') as PtyModule;
    } catch {
      ptyMod = null;
    }
  }
  return ptyMod;
}

/**
 * 本地终端会话：优先 ConPTY（node-pty，真实 TTY 体验），
 * 预编译不可用时降级为 child_process 管道（无 TTY，交互受限但可用）。
 * 接口与 SSHSession 对齐。
 */
export class LocalShellSession extends EventEmitter {
  private pty: PtyProcess | null = null;
  private child: ChildProcess | null = null;
  private closed = false;
  private mode: 'pty' | 'pipe' = 'pty';

  constructor(
    public id: string,
    private config: LocalShellConfig
  ) {
    super();
  }

  getMode(): 'pty' | 'pipe' {
    return this.mode;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let file: string;
      let args: string[];
      if (this.config.command && this.config.command.trim()) {
        // 自定义命令：Windows 走 cmd /c 包装以支持带空格路径与内建命令
        if (process.platform === 'win32') {
          file = 'cmd.exe';
          args = ['/d', '/s', '/c', this.config.command.trim()];
        } else {
          file = '/bin/bash';
          args = ['-lc', this.config.command.trim()];
        }
      } else {
        const resolved = resolveShellCommand(this.config.shell || (process.platform === 'win32' ? 'powershell' : 'bash'));
        if (!resolved) {
          reject(new Error(`未找到可用 shell：${this.config.shell}（可在连接设置中改用 powershell/cmd 或指定自定义命令）`));
          return;
        }
        file = resolved.file;
        args = resolved.args;
      }

      const pty = loadPty();
      if (pty) {
        try {
          const p = pty.spawn(file, args, {
            name: 'xterm-256color',
            cols: this.config.cols || 120,
            rows: this.config.rows || 32,
            cwd: this.config.cwd || os.homedir(),
            env: process.env as Record<string, string>,
            useConpty: process.platform === 'win32'
          });
          this.mode = 'pty';
          this.pty = p;
          p.on('data', (data: string) => this.emit('data', data));
          p.on('exit', () => this.emitOnce('close'));
          resolve();
          return;
        } catch (err: any) {
          // ConPTY 创建失败 → 降级管道
          this.pty = null;
        }
      }

      // 降级：管道模式（无 TTY；vim/密码提示等交互程序体验差）
      try {
        this.mode = 'pipe';
        const child = spawn(file, args, {
          cwd: this.config.cwd || os.homedir(),
          env: process.env,
          shell: false,
          windowsHide: true
        });
        this.child = child;
        child.stdout?.on('data', (d: Buffer) => this.emit('data', d.toString('utf8')));
        child.stderr?.on('data', (d: Buffer) => this.emit('data', d.toString('utf8')));
        child.on('error', (err) => this.emitOnce('error', err.message));
        child.on('close', () => this.emitOnce('close'));
        this.emit(
          'data',
          `\r\n[提示] node-pty 预编译库不可用，已降级为管道模式（无 TTY）：vim/top 等全屏程序可能显示异常。\r\n$ `
        );
        resolve();
      } catch (err: any) {
        this.emitOnce('error', err?.message || String(err));
        reject(err);
      }
    });
  }

  private emitOnce(event: 'close' | 'error', ...args: any[]) {
    if (this.closed && event === 'close') return;
    if (event === 'close') this.closed = true;
    this.emit(event, ...args);
  }

  write(data: string) {
    if (this.pty) {
      this.pty.write(data);
    } else if (this.child?.stdin?.writable) {
      this.child.stdin.write(data);
    }
  }

  resize(cols: number, rows: number) {
    if (this.pty && cols > 0 && rows > 0) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        /* ignore */
      }
    }
  }

  end() {
    this.closed = true;
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        /* ignore */
      }
      this.pty = null;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
      this.child = null;
    }
  }
}
