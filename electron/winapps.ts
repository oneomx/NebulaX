import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 启动外部程序并等待 spawn 确认（spawn() 的失败经异步 error 事件上报，
 * try/catch 捕获不到；不监听会形成 unhandled error 事件，且误报成功）。
 */
function spawnDetached(
  cmd: string,
  args: string[]
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      const timer = setTimeout(() => resolve({ ok: true }), 3000);
      child.once('spawn', () => {
        clearTimeout(timer);
        child.unref();
        resolve({ ok: true });
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err?.message || String(err) });
      });
    } catch (err: any) {
      resolve({ ok: false, error: err?.message || String(err) });
    }
  });
}

export interface RdpOptions {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  fullscreen?: boolean;
  /** 分辨率，如 1920x1080；fullscreen 时忽略 */
  resolution?: string;
}

export interface VncOptions {
  host: string;
  port?: number;
  /** 自定义 VNC viewer 可执行文件路径；留空自动探测 */
  viewerPath?: string;
}

export interface DetectedTools {
  platform: string;
  mstsc: boolean;
  wsl: boolean;
  wslDistros: string[];
  pwsh: boolean;
  gitBash: boolean;
  gitBashPath?: string;
  vncViewers: { name: string; path: string }[];
}

const fsExists = (p: string) => {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
};

function execFileAsync(cmd: string, args: string[], timeout = 8000, utf16 = false): Promise<string> {
  return new Promise((resolve) => {
    try {
      // utf16 模式按 buffer 取回再按 UTF-16LE 解码（wsl -l 输出即 UTF-16LE）
      execFile(cmd, args, { timeout, windowsHide: true, encoding: utf16 ? 'buffer' : 'utf8' }, (err, stdout) => {
        if (err || stdout == null) return resolve('');
        if (Buffer.isBuffer(stdout)) return resolve(stdout.toString('utf16le'));
        resolve(String(stdout));
      });
    } catch {
      resolve('');
    }
  });
}

/** 探测本机可用工具（Windows 适配核心：mstsc / WSL / PowerShell / Git Bash / VNC viewer） */
export async function detectTools(): Promise<DetectedTools> {
  const win = process.platform === 'win32';
  const tools: DetectedTools = {
    platform: process.platform,
    mstsc: false,
    wsl: false,
    wslDistros: [],
    pwsh: false,
    gitBash: false,
    vncViewers: []
  };

  if (!win) {
    // 非 Windows：仅探测 bash 类
    tools.gitBash = fsExists('/bin/bash');
    return tools;
  }

  const systemRoot = process.env['SystemRoot'] || 'C:\\Windows';
  tools.mstsc = fsExists(path.join(systemRoot, 'System32', 'mstsc.exe'));
  tools.wsl = fsExists(path.join(systemRoot, 'System32', 'wsl.exe'));
  if (tools.wsl) {
    const out = await execFileAsync(path.join(systemRoot, 'System32', 'wsl.exe'), ['-l', '-q'], 8000, true);
    // 已按 UTF-16LE 正确解码，清洗残留空字符并按行切分
    tools.wslDistros = out
      .replace(/\u0000/g, '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  tools.pwsh = fsExists('C:\\Program Files\\PowerShell\\7\\pwsh.exe');

  const gitBashCandidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    `${process.env['LOCALAPPDATA'] || ''}\\Programs\\Git\\bin\\bash.exe`
  ];
  for (const c of gitBashCandidates) {
    if (fsExists(c)) {
      tools.gitBash = true;
      tools.gitBashPath = c;
      break;
    }
  }

  const vncCandidates: { name: string; path: string }[] = [
    { name: 'TightVNC', path: 'C:\\Program Files\\TightVNC\\tvnviewer.exe' },
    { name: 'TightVNC (x86)', path: 'C:\\Program Files (x86)\\TightVNC\\tvnviewer.exe' },
    { name: 'RealVNC', path: 'C:\\Program Files\\RealVNC\\VNC Viewer\\vncviewer.exe' },
    { name: 'UltraVNC', path: 'C:\\Program Files\\UltraVNC\\vncviewer.exe' },
    { name: 'UltraVNC (x86)', path: 'C:\\Program Files (x86)\\UltraVNC\\vncviewer.exe' }
  ];
  tools.vncViewers = vncCandidates.filter((c) => fsExists(c.path));

  return tools;
}

/**
 * 启动 RDP：优先注入凭据到 Windows 凭据管理器（cmdkey），再拉起 mstsc。
 * mstsc 本身不接受命令行密码，cmdkey 方案是业界标准做法（MobaXterm 同理）。
 */
export async function launchRdp(opts: RdpOptions): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'RDP 仅支持 Windows（调用系统 mstsc）' };
  }
  const host = opts.host.trim();
  if (!host) return { ok: false, error: '主机地址为空' };
  const port = opts.port || 3389;
  const target = port === 3389 ? host : `${host}:${port}`;

  // 1) 注入凭据（可选）
  const user = opts.username?.trim();
  if (user) {
    await new Promise<void>((resolve) => {
      const args = [
        '/generic:TERMSRV/' + target,
        '/user:' + user,
        '/pass:' + (opts.password || '')
      ];
      try {
        const p = spawn('cmdkey.exe', args, { windowsHide: true, stdio: 'ignore' });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
        setTimeout(resolve, 4000);
      } catch {
        resolve();
      }
    });
  }

  // 2) 拉起 mstsc
  const mstsc = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'mstsc.exe');
  const args = ['/v:' + target];
  if (opts.fullscreen) args.push('/f');
  else if (opts.resolution && /^\d+x\d+$/.test(opts.resolution)) {
    args.push('/w:' + opts.resolution.split('x')[0], '/h:' + opts.resolution.split('x')[1]);
  }
  try {
    const r = await spawnDetached(mstsc, args);
    return r.ok ? { ok: true } : { ok: false, error: `启动 mstsc 失败：${r.error}` };
  } catch (err: any) {
    return { ok: false, error: `启动 mstsc 失败：${err?.message || err}` };
  }
}

/** 启动 VNC：自动探测 viewer（TightVNC/RealVNC/UltraVNC），支持自定义路径 */
export async function launchVnc(opts: VncOptions): Promise<{ ok: boolean; error?: string; viewer?: string }> {
  const host = opts.host.trim();
  if (!host) return { ok: false, error: '主机地址为空' };
  const port = opts.port || 5900;

  let viewer = opts.viewerPath?.trim() || '';
  if (!viewer) {
    const tools = await detectTools();
    viewer = tools.vncViewers[0]?.path || '';
  }
  if (!viewer) {
    return {
      ok: false,
      error:
        '未检测到 VNC 客户端。请安装 TightVNC / RealVNC / UltraVNC，或在连接设置里指定 viewer 路径（如 C:\\Program Files\\TightVNC\\tvnviewer.exe）'
    };
  }
  if (!fsExists(viewer)) {
    return { ok: false, error: `VNC viewer 不存在：${viewer}` };
  }

  // TightVNC/RealVNC 语法：viewer host::port（双冒号）或 host:port 均可，统一用 host::port
  const target = host.includes(':') ? host : `${host}::${port}`;
  try {
    const r = await spawnDetached(viewer, [target]);
    return r.ok ? { ok: true, viewer } : { ok: false, error: `启动 VNC viewer 失败：${r.error}` };
  } catch (err: any) {
    return { ok: false, error: `启动 VNC viewer 失败：${err?.message || err}` };
  }
}

/** 默认 shell 探测（本地终端入口用）：pwsh > powershell > cmd */
export function defaultShellId(): string {
  if (process.platform !== 'win32') return 'bash';
  if (fsExists('C:\\Program Files\\PowerShell\\7\\pwsh.exe')) return 'pwsh';
  return 'powershell';
}
