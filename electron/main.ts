import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SSHSession, type SSHSessionConfig, type ServerInfo } from './ssh';
import { chatWithUsage, loadAIConfig, saveAIConfig, type AIConfig, type ChatMessage } from './ai';
import { recordUsage, getUsage } from './aitracker';
import { log, getLogs, initFileLogging, installGlobalErrorLogging } from './logger';
import { listHostKeys, removeHostKey } from './knownhosts';
import { runDbQuery, testDb, type DbConfig } from './dbconsole';

// ---- GPU 防崩兜底（部分机器 GPU 进程 0xC0000005 崩溃会带走整个应用）----
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// ---- 本地文件系统安全边界 ----
const BLOCKED_PATHS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/sys', '/proc', '/dev', '/boot'];
function isPathAllowed(p: string): { ok: boolean; error?: string } {
  const resolved = path.resolve(p);
  const home = app.getPath('home');
  // Windows 文件系统大小写不敏感：统一小写比较，避免误拒/绕过
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const r = norm(resolved);
  const h = norm(home);
  // 仅允许 home 目录及其子目录；必须带分隔符边界，
  // 防止 C:\Users\Administrator2 这类兄弟前缀目录被误判为合法
  if (r !== h && !r.startsWith(h + path.sep)) {
    return { ok: false, error: '路径必须位于用户主目录下' };
  }
  // 额外黑名单（Linux）
  for (const b of BLOCKED_PATHS) {
    if (r === b || r.startsWith(b + path.sep)) {
      return { ok: false, error: `禁止访问系统目录: ${b}` };
    }
  }
  return { ok: true };
}

// ---- 高阶 AI 模块 ----
import { runSecurityAudit, type AuditResult } from './ai/audit';
import { planDiagnosticSteps, analyzeDiagnosticResult, type DiagnosticStep, type DiagnosticReport } from './ai/agent';
import { addRunbook, loadRunbooks, removeRunbook, buildRagContext, retrieve, ensureDefaultRunbooks, restoreBuiltinRunbooks, builtinStats } from './ai/rag';
import { forecastMetrics, forecastLocal, predictDaysToFull, type MetricSnapshot, type ForecastResult } from './ai/forecast';
import { generateScript, type GeneratedScript } from './ai/scriptgen';
// ---- v1.7 AI 场景化 / 路由 / 富上下文 / 专项诊断 ----
import { SCENARIOS, SCENARIO_CATEGORY_LABELS, getScenario, getScenarios, buildScenarioIncident, type ScenarioCategory } from './ai/scenarios';
import { loadRoutingConfig, saveRoutingConfig, resolveRoute, AI_TASK_LABELS, type RoutingConfig, type AiTaskType } from './ai/router';
import { buildRichContext, matchRunbooks, logTailCommand, type RichContextInput } from './ai/context';
import { collectItems as dbCollectItems, diagnoseDatabase, type DbDialect, type DbSampleResult, type DbDiagReport } from './ai/dbdiag';
import { collectItems as perfCollectItems, analyzePerf, type PerfReport, type CollectItem as PerfCollectItem } from './ai/perf/perftune';

// ---- 定时巡检与主动预警 ----
import {
  loadPatrolConfig,
  savePatrolConfig,
  evaluateSnapshot,
  evaluateTrend,
  buildAutoDiagSteps,
  formatPatrolReport,
  type PatrolConfig,
  type PatrolHostResult,
  type PatrolAlert,
  type AutoDiagStep
} from './patrol';

// ---- 凭据保管库 ----
import { vaultSet, vaultGet, vaultDelete, vaultStatus, type VaultSecrets } from './vault';

// ---- 多协议终端（Telnet / 本地终端 / 串口）----
import { TelnetSession } from './telnet';
import { LocalShellSession, SHELL_PRESETS, resolveShellCommand } from './localshell';
import { SerialSession, listSerialPorts } from './serialsession';

// ---- SSH 隧道 ----
import { tunnelManager, type TunnelSpec } from './tunnels';

// ---- Windows 适配（RDP/VNC/工具探测）----
import { detectTools, launchRdp, launchVnc, defaultShellId } from './winapps';
import { getLicenseState, activateLicense, deactivateLicense, isReadOnly } from './license';

const AI_KEY_ID = '__ai_key__';

/** 读取 AI Key：优先 vault，降级 ai-config.json */
function loadApiKey(): string {
  const v = vaultGet(AI_KEY_ID);
  if (v.ok && v.secrets?.password) return v.secrets.password;
  return loadAIConfig().apiKey;
}

/** 保存 AI Key 到 vault */
function saveApiKey(apiKey: string) {
  vaultSet(AI_KEY_ID, { password: apiKey });
}

// ---- SFTP ----
import { SftpService, type RemoteFile, type TransferProgress } from './sftp';

let mainWindow: BrowserWindow | null = null;

/** 统一会话接口（SSH/Telnet/本地终端/串口 对齐 write/resize/end + data/close/error 事件） */
type AnySession = SSHSession | TelnetSession | LocalShellSession | SerialSession;
type SessionKind = 'ssh' | 'telnet' | 'local' | 'serial';

const sessions = new Map<string, AnySession>();
const sessionKinds = new Map<string, SessionKind>();
const sftpServices = new Map<string, SftpService>();
/** 每会话最近执行的命令（新→旧，上限 30 条）——供 AI 富上下文注入 */
const execHistory = new Map<string, string[]>();

/** 仅取 SSH 会话（exec/server-info/SFTP/隧道等 SSH 专属能力的守卫） */
function getSSH(id: string): SSHSession | null {
  return sessionKinds.get(id) === 'ssh' ? (sessions.get(id) as SSHSession) : null;
}

/**
 * SFTP 传输队列：并发上限 2（单 SFTP 通道多路复用时并发过高会互相饿死带宽）。
 * 排队的任务按 FIFO 执行；任务自身的进度/取消由 SftpService 管理。
 */
const TRANSFER_MAX_CONCURRENT = 2;
let transferActive = 0;
const transferWaiters: Array<() => void> = [];
function enqueueTransfer<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      transferActive++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          transferActive--;
          const next = transferWaiters.shift();
          if (next) next();
        });
    };
    if (transferActive < TRANSFER_MAX_CONCURRENT) run();
    else transferWaiters.push(run);
  });
}

async function getSftpService(sessionId: string): Promise<SftpService> {
  let svc = sftpServices.get(sessionId);
  if (svc) return svc;
  const s = getSSH(sessionId);
  if (!s) throw new Error(sessionKinds.has(sessionId) ? 'SFTP 仅 SSH 会话支持' : 'session not found');
  const wrapper = await s.openSftp();
  svc = new SftpService(sessionId, wrapper);
  // 转发进度到 renderer
  svc.onProgress((p: TransferProgress) => {
    mainWindow?.webContents.send('sftp:progress', p);
  });
  sftpServices.set(sessionId, svc);
  return svc;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    frame: false,
    backgroundColor: '#08090c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const s of sessions.values()) s.end();
    sessions.clear();
    sessionKinds.clear();
    tunnelManager.stopAll();
  });
}

// 全局异常落盘：崩溃/未处理 Promise 在重启后可从日志文件追溯
installGlobalErrorLogging();

app.whenReady().then(() => {
  // 文件日志：userData/Logs/nebula-YYYY-MM-DD.log（按天轮转保留 7 天）
  initFileLogging(app.getPath('logs'));
  log('info', `NebulaX 启动，版本 ${app.getVersion()}`);
  // 内置知识库 seed：首次启动（知识库为空）自动写入默认 runbook
  const seeded = ensureDefaultRunbooks();
  if (seeded.seeded > 0) log('info', `内置知识库已初始化：${seeded.seeded} 篇`);
  // 许可状态初始化：推进试用计时与时间回拨防护记录
  try {
    const lic = getLicenseState();
    if (lic.status === 'trial') log('info', `许可状态：试用中（剩余 ${lic.trialDaysLeft} 天），机器码 ${lic.machineCode}`);
    else if (lic.status === 'activated') log('info', `许可状态：已激活（${lic.license?.type === 'perpetual' ? '永久' : '订阅至 ' + lic.license?.expiresAt}）`);
    else log('warn', '许可状态：试用已到期（只读模式）');
  } catch (e) {
    log('warn', `许可状态初始化失败: ${e}`);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- SSH IPC ----
ipcMain.handle('ssh:connect', async (_e, config: SSHSessionConfig) => {
  if (isReadOnly()) return { ok: false, error: '试用已到期，当前为只读模式。请输入激活码后继续使用' };
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = new SSHSession(id, config);
  sessions.set(id, session);
  sessionKinds.set(id, 'ssh');
  session.on('data', (d: string) => {
    mainWindow?.webContents.send('ssh:data', id, d);
  });
  session.on('close', () => {
    mainWindow?.webContents.send('ssh:close', id);
    sessions.delete(id);
    sessionKinds.delete(id);
    sftpServices.delete(id);
    tunnelManager.stopBySession(id);
  });
  session.on('error', (msg: string) => {
    mainWindow?.webContents.send('ssh:error', id, msg);
    sessions.delete(id);
    sessionKinds.delete(id);
    sftpServices.delete(id);
    tunnelManager.stopBySession(id);
  });
  // 自动重连状态回传（渲染层显示"重连中…"）
  session.on('reconnecting', (info: { attempt: number; max: number; delayMs: number }) => {
    mainWindow?.webContents.send('ssh:reconnecting', id, info);
  });
  session.on('reconnected', () => {
    mainWindow?.webContents.send('ssh:reconnected', id);
  });
  try {
    await session.connect();
    log('info', `SSH 连接成功 ${config.host}:${config.port} (${id})`);
    return { ok: true, sessionId: id };
  } catch (err: any) {
    log('warn', `SSH 连接失败 ${config.host}:${config.port}：${err?.message || err}`);
    sessions.delete(id);
    sessionKinds.delete(id);
    // 清理可能已建立的底层连接/心跳（shell 创建失败等场景）
    try {
      session.end();
    } catch {
      /* ignore */
    }
    // 主机指纹拦截：把结构化错误翻译成前端弹窗载荷（此前只返回 error 字符串，确认流程断裂）
    const msg = err?.message || String(err);
    const m = /^__(HOSTKEY_UNKNOWN|HOSTKEY_MISMATCH)__\|(.+)\|(\d+)\|([^|]+)\|([^|]+)$/.exec(msg);
    if (m) {
      return {
        ok: false,
        hostKeyPrompt: { host: m[2], port: parseInt(m[3], 10), sha256: m[4], keyType: m[5], mismatch: m[1] === 'HOSTKEY_MISMATCH' }
      };
    }
    return { ok: false, error: msg };
  }
});

// ---- 多协议终端连接（Telnet / 本地终端 / 串口）----
// 复用 ssh:data / ssh:close / ssh:error 事件通道与 ssh:write / ssh:resize，
// 前端终端面板零改动即可承载所有协议。
interface TermConnectConfig {
  type: 'telnet' | 'local' | 'serial';
  host?: string;
  port?: number;
  shell?: string;
  command?: string;
  serialPath?: string;
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
}

ipcMain.handle('term:connect', async (_e, config: TermConnectConfig) => {
  if (isReadOnly()) return { ok: false, error: '试用已到期，当前为只读模式。请输入激活码后继续使用' };
  const id = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let session: AnySession;
  if (config.type === 'telnet') {
    session = new TelnetSession(id, { host: config.host || '', port: config.port || 23 });
  } else if (config.type === 'local') {
    session = new LocalShellSession(id, { shell: config.shell, command: config.command });
  } else if (config.type === 'serial') {
    session = new SerialSession(id, {
      path: config.serialPath || '',
      baudRate: config.baudRate,
      dataBits: config.dataBits,
      stopBits: config.stopBits,
      parity: config.parity
    });
  } else {
    return { ok: false, error: `未知终端协议：${(config as any).type}` };
  }
  sessions.set(id, session);
  sessionKinds.set(id, config.type);
  session.on('data', (d: string) => {
    mainWindow?.webContents.send('ssh:data', id, d);
  });
  session.on('close', () => {
    mainWindow?.webContents.send('ssh:close', id);
    sessions.delete(id);
    sessionKinds.delete(id);
  });
  session.on('error', (msg: string) => {
    mainWindow?.webContents.send('ssh:error', id, msg);
    sessions.delete(id);
    sessionKinds.delete(id);
  });
  try {
    await session.connect();
    const mode = (session as LocalShellSession).getMode?.();
    return { ok: true, sessionId: id, mode };
  } catch (err: any) {
    sessions.delete(id);
    sessionKinds.delete(id);
    return { ok: false, error: err?.message || String(err) };
  }
});

// 本地终端可用 shell 预设（含默认 shell 探测）
ipcMain.handle('term:shells', () => {
  return { ok: true, presets: SHELL_PRESETS, defaultShell: defaultShellId() };
});

// 串口枚举
ipcMain.handle('term:serial-ports', async () => {
  try {
    const ports = await listSerialPorts();
    return { ok: true, ports };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---- Windows 适配 ----
ipcMain.handle('win:detect-tools', async () => {
  try {
    const tools = await detectTools();
    return { ok: true, tools };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('win:launch-rdp', async (_e, opts) => launchRdp(opts));
ipcMain.handle('win:launch-vnc', async (_e, opts) => launchVnc(opts));

// ---- SSH 隧道 ----
ipcMain.handle('tunnel:start', async (_e, sessionId: string, spec: TunnelSpec) => {
  const s = getSSH(sessionId);
  if (!s) return { ok: false, error: '隧道仅支持已连接的 SSH 会话' };
  try {
    const info = await tunnelManager.start(sessionId, s, spec);
    return { ok: true, tunnel: info };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('tunnel:stop', (_e, tunnelId: string) => {
  return { ok: tunnelManager.stop(tunnelId) };
});

ipcMain.handle('tunnel:list', () => {
  return { ok: true, tunnels: tunnelManager.list() };
});

// ---- 主机指纹（known_hosts，TOFU）----
ipcMain.handle('hostkeys:list', () => {
  return { ok: true, entries: listHostKeys() };
});

ipcMain.handle('hostkeys:remove', (_e, host: string, port: number) => {
  const removed = removeHostKey(host, port);
  log('info', `移除主机指纹 ${host}:${port}（${removed ? '成功' : '未找到'}）`);
  return { ok: removed };
});

// ---- 诊断包导出（日志 + 环境 + 会话/隧道/指纹清单，不含任何凭据）----
ipcMain.handle('diag:export', async () => {
  if (!mainWindow) return { ok: false, error: '窗口不可用' };
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出诊断包',
    defaultPath: `nebula-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' };
  // 活跃 SSH 会话的诊断数据（指标/进程/网络采样，不含凭据）——排查问题时最有价值的部分
  const sessionDiagnostics: Record<string, unknown> = {};
  for (const [id, s] of sessions.entries()) {
    if (sessionKinds.get(id) !== 'ssh') continue;
    try {
      sessionDiagnostics[id] = await (s as unknown as { getDiagnosticsBundle: () => Promise<unknown> }).getDiagnosticsBundle();
    } catch (err: any) {
      sessionDiagnostics[id] = { error: err?.message || String(err) };
    }
  }
  const bundle = {
    generatedAt: new Date().toISOString(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      locale: app.getLocale()
    },
    sessions: Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      kind: sessionKinds.get(id),
      host: (s as unknown as { config?: { host?: string } }).config?.host || null
    })),
    sessionDiagnostics,
    tunnels: tunnelManager.list(),
    hostKeys: listHostKeys(),
    vault: vaultStatus(),
    logs: getLogs()
  };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    log('info', `诊断包已导出：${res.filePath}`);
    return { ok: true, path: res.filePath };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// 打开日志目录（设置页入口；崩溃排查用）
ipcMain.handle('app:open-logs', async () => {
  const dir = app.getPath('logs');
  try {
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true, path: dir };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// 测试连接：连接 -> 取基础信息 -> 立即断开，不进入会话列表
ipcMain.handle('ssh:test', async (_e, config: SSHSessionConfig) => {
  const id = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = new SSHSession(id, config);
  try {
    await session.connect();
    let info: ServerInfo | null = null;
    try {
      info = await session.getServerInfo();
    } catch {
      // 基础信息获取失败不影响连通性结论
    }
    session.end();
    return { ok: true, info };
  } catch (err: any) {
    try {
      session.end();
    } catch {
      /* noop */
    }
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ssh:disconnect', (_e, id: string) => {
  const s = sessions.get(id);
  if (s) {
    s.end();
    sessions.delete(id);
    sessionKinds.delete(id);
    sftpServices.delete(id);
    tunnelManager.stopBySession(id);
    return { ok: true };
  }
  return { ok: false, error: 'session not found' };
});

ipcMain.handle('ssh:exec', async (_e, id: string, command: string) => {
  const s = getSSH(id);
  if (!s) return { ok: false, error: sessionKinds.has(id) ? '命令执行仅 SSH 会话支持' : 'session not found' };
  // 命令历史：供 AI 富上下文注入（环形缓冲，仅内存）
  try {
    const h = execHistory.get(id) || [];
    h.push(command);
    if (h.length > 30) h.splice(0, h.length - 30);
    execHistory.set(id, h);
  } catch {
    /* 历史记录失败不影响执行 */
  }
  try {
    const result = await s.exec(command);
    return { ok: true, ...result };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ssh:write', (_e, id: string, data: string) => {
  const s = sessions.get(id);
  if (s) s.write(data);
  return { ok: true };
});

ipcMain.handle('ssh:resize', (_e, id: string, cols: number, rows: number) => {
  const s = sessions.get(id);
  if (s) s.resize(cols, rows);
  return { ok: true };
});

ipcMain.handle('ssh:server-info', async (_e, id: string) => {
  const s = getSSH(id);
  if (!s) return { ok: false, error: sessionKinds.has(id) ? '服务器信息仅 SSH 会话支持' : 'session not found' };
  try {
    const info = await s.getServerInfo();
    return { ok: true, info };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ssh:list', () => {
  return { ok: true, sessions: Array.from(sessions.keys()) };
});

// ---- AI IPC ----
ipcMain.handle('ai:chat', async (_e, payload: { messages: ChatMessage[]; config?: Partial<AIConfig>; attachOps?: boolean; task?: AiTaskType; attachRich?: boolean; sessionId?: string }) => {
  try {
    if (isReadOnly()) return { ok: false, error: '试用已到期，AI 功能已锁定。请输入激活码后继续使用' };
    const cfg = payload.config || {};
    // 若未显式给 apiKey，从 vault 取
    if (!cfg.apiKey) {
      const k = loadApiKey();
      if (k) cfg.apiKey = k;
    }
    // 多模型路由：按任务类型覆盖模型/地址（用户显式 config 优先于路由规则）
    if (payload.task) {
      const routed = resolveRoute(payload.task);
      // 只在用户未显式指定对应字段时应用路由
      if (routed.model && !payload.config?.model) cfg.model = routed.model;
      if (routed.baseUrl && !payload.config?.baseUrl) cfg.baseUrl = routed.baseUrl;
      if (routed.maxTokens && !payload.config?.maxTokens) cfg.maxTokens = routed.maxTokens;
    }
    // 根因分析增强：问答类请求按需附带最近巡检指标/预警作为上下文
    let messages = payload.messages;
    // 富上下文（v1.7）：巡检 + 趋势 + 命令历史 + 日志尾部 + Runbook 匹配
    if (payload.attachRich) {
      const rich = await buildOpsRichContext(payload.sessionId, messages);
      if (rich) {
        messages = [...messages];
        const sysIdx = messages.findIndex((m) => m.role === 'system');
        if (sysIdx >= 0) messages[sysIdx] = { role: 'system', content: messages[sysIdx].content + rich };
        else messages.unshift({ role: 'system', content: rich.trim() });
      }
    } else if (payload.attachOps) {
      const ops = buildOpsContext();
      if (ops) {
        messages = [...messages];
        const block =
          `\n\n【服务器运维上下文（最近一轮巡检采样）】\n${ops}\n` +
          '（回答"为什么慢/为什么告警"类问题时优先基于以上数据推理根因，并给出可执行的验证命令；数据不含敏感凭据）';
        const sysIdx = messages.findIndex((m) => m.role === 'system');
        if (sysIdx >= 0) messages[sysIdx] = { role: 'system', content: messages[sysIdx].content + block };
        else messages.unshift({ role: 'system', content: block.trim() });
      }
    }
    const result = await chatWithUsage(messages, cfg);
    // token 用量记账（服务端返回了 usage 才记）
    if (result.usage && result.usage.totalTokens > 0) {
      recordUsage(cfg.model || loadAIConfig().model, result.usage.promptTokens, result.usage.completionTokens);
    }
    return { ok: true, reply: result.content, usage: result.usage, modelUsed: cfg.model };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ai:usage', async () => {
  try {
    return { ok: true, usage: getUsage() };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ai:config-get', () => {
  const cfg = loadAIConfig();
  const apiKey = loadApiKey();
  return { ok: true, config: { ...cfg, apiKey: apiKey ? '••••' + apiKey.slice(-4) : '' } };
});

ipcMain.handle('ai:config-set', (_e, config: Partial<AIConfig>) => {
  if (config.apiKey && config.apiKey.trim()) {
    saveApiKey(config.apiKey.trim());
  }
  const merged = saveAIConfig(config);
  const apiKey = loadApiKey();
  const masked = apiKey
    ? apiKey.length > 4
      ? '••••' + apiKey.slice(-4)
      : '••••'
    : '';
  return { ok: true, config: { ...merged, apiKey: masked } };
});

// ---- 高阶 AI IPC ----
ipcMain.handle('ai:audit', async (_e, payload: { content: string; contentType: 'terminal' | 'file' | 'config' | 'log'; context?: string }) => {
  try {
    const result = await runSecurityAudit(payload.content, payload.contentType, payload.context);
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ssh:audit-data', async (_e, sessionId: string) => {
  const s = getSSH(sessionId);
  if (!s) return { ok: false, error: sessionKinds.has(sessionId) ? '该功能仅 SSH 会话支持' : 'session not found' };
  try {
    const data = await s.getSecurityAuditData();
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ai:plan-diagnostic', async (_e, payload: { incident: string; context?: string; os?: string }) => {
  try {
    // 附带最近巡检数据：规划的诊断步骤可直接针对真实异常指标
    const ops = buildOpsContext();
    const context = [payload.context, ops ? `【最近巡检数据】\n${ops}` : ''].filter(Boolean).join('\n\n');
    const steps = await planDiagnosticSteps(payload.incident, context || undefined, payload.os);
    return { ok: true, steps };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ai:analyze-diagnostic', async (_e, payload: { incident: string; steps: DiagnosticStep[]; os?: string }) => {
  try {
    const report = await analyzeDiagnosticResult(payload.incident, payload.steps, payload.os);
    return { ok: true, report };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ssh:diagnostics-bundle', async (_e, sessionId: string) => {
  const s = getSSH(sessionId);
  if (!s) return { ok: false, error: sessionKinds.has(sessionId) ? '该功能仅 SSH 会话支持' : 'session not found' };
  try {
    const bundle = await s.getDiagnosticsBundle();
    return { ok: true, bundle };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Runbook (RAG)
ipcMain.handle('rag:add', (_e, payload: { title: string; filename: string; content: string }) => {
  const doc = addRunbook(payload.title, payload.filename, payload.content);
  return { ok: true, doc };
});

ipcMain.handle('rag:list', () => {
  return { ok: true, docs: loadRunbooks() };
});

ipcMain.handle('rag:remove', (_e, id: string) => {
  removeRunbook(id);
  return { ok: true };
});

ipcMain.handle('rag:retrieve', (_e, query: string) => {
  return { ok: true, results: retrieve(query, 3) };
});

ipcMain.handle('rag:context', (_e, query: string) => {
  return { ok: true, context: buildRagContext(query) };
});

// 内置知识库：恢复缺失的默认知识（幂等）与统计
ipcMain.handle('rag:restore-builtin', () => {
  try {
    const r = restoreBuiltinRunbooks();
    return { ok: true, ...r };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('rag:builtin-stats', () => {
  try {
    return { ok: true, ...builtinStats() };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---- 许可激活（离线） ----
ipcMain.handle('license:state', () => {
  try {
    return { ok: true, state: getLicenseState() };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('license:activate', (_e, code: string) => {
  try {
    return activateLicense(code);
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('license:deactivate', () => {
  try {
    return deactivateLicense();
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Forecast
ipcMain.handle('ssh:metrics-snapshot', async (_e, sessionId: string) => {
  const s = getSSH(sessionId);
  if (!s) return { ok: false, error: sessionKinds.has(sessionId) ? '该功能仅 SSH 会话支持' : 'session not found' };
  try {
    const snap = await s.getMetricsSnapshot();
    return { ok: true, snapshot: snap };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ai:forecast', async (_e, snapshots: MetricSnapshot[]) => {
  try {
    const result = await forecastMetrics(snapshots);
    return { ok: true, result };
  } catch (err: any) {
    // AI 不可用（未配置 key / 网络失败 / 模型报错）→ 降级本地线性回归，
    // 容量预测功能在无 AI 环境下保持可用，而非直接报错
    try {
      const local = forecastLocal(snapshots);
      log('info', `AI 预测失败（${err?.message || err}），已降级为本地线性回归预测`);
      return { ok: true, result: local, degraded: true };
    } catch (e2: any) {
      return { ok: false, error: `${err?.message || err}；本地降级预测也失败：${e2?.message || e2}` };
    }
  }
});

ipcMain.handle('forecast:linear', (_e, payload: { points: number[]; intervalMinutes: number; threshold?: number }) => {
  return { ok: true, days: predictDaysToFull(payload.points, payload.intervalMinutes, payload.threshold) };
});

// ---- 定时巡检与主动预警 ----
let patrolTimer: NodeJS.Timeout | null = null;
let lastPatrolReport = '';
let lastPatrolResults: PatrolHostResult[] = [];
/** 各主机历史快照（趋势回归用）：host → 最近 N 次快照（时间升序） */
const patrolHistory = new Map<string, import('./ai/forecast').MetricSnapshot[]>();
const PATROL_HISTORY_MAX = 96; // 上限 96 个点，防止长期运行内存增长

/**
 * 运维上下文摘要（最近一轮巡检的指标与预警）。
 * 注入 AI 问答/诊断请求，让"为什么慢/为什么告警"类回答有据可依（v1.5 根因分析增强）。
 */
function buildOpsContext(): string {
  if (!lastPatrolResults.length) return '';
  const lines: string[] = [];
  for (const r of lastPatrolResults.slice(0, 10)) {
    if (!r.ok) {
      lines.push(`- ${r.host}：巡检失败（${r.error || '未知错误'}）`);
      continue;
    }
    const s = r.snapshot!;
    const disk = (s.disk || []).map((d) => `${d.mount} ${d.usePercent}%（剩 ${d.availGB}G）`).join('，');
    lines.push(
      `- ${r.host}（${s.os === 'windows' ? 'Windows' : 'Linux'}）：CPU ${s.cpuPercent}%，内存 ${s.memPercent}%，负载 ${s.load1}，连接数 ${s.connections}${disk ? `；磁盘：${disk}` : ''}`
    );
    for (const a of r.alerts) {
      lines.push(`  ⚠ ${a.severity === 'critical' ? '严重' : '警告'} ${a.resource}${a.mount ? `(${a.mount})` : ''} ${a.currentPercent}% 超阈值 ${a.threshold}% —— ${a.suggestion}`);
    }
  }
  return lines.join('\n');
}

/** 日志尾部缓存：session → { ts, text }（避免每次问答都去远端采日志拖慢响应） */
const logTailCache = new Map<string, { ts: number; text: string }>();
const LOG_TAIL_TTL_MS = 60_000;

/** 采集远端日志尾部（带 60s 缓存；失败返回空串，不阻塞问答主流程） */
async function fetchLogTail(sessionId?: string): Promise<string> {
  if (!sessionId) return '';
  const cached = logTailCache.get(sessionId);
  if (cached && Date.now() - cached.ts < LOG_TAIL_TTL_MS) return cached.text;
  const s = getSSH(sessionId);
  if (!s) return '';
  try {
    // OS 探测内部自带缓存，失败默认按 linux 处理
    let osType: 'linux' | 'windows' = 'linux';
    try {
      osType = await s.detectOS();
    } catch {
      /* 保持 linux */
    }
    const r = await s.exec(logTailCommand(osType, 40), 6000);
    const text = (r.stdout || '').trim().slice(0, 4000);
    logTailCache.set(sessionId, { ts: Date.now(), text });
    return text;
  } catch {
    return '';
  }
}

/**
 * 富上下文组装（v1.7）：巡检 + 趋势预警 + 命令历史 + 日志尾部 + Runbook 匹配。
 * 返回注入 system 消息的文本块；全部为空时返回空串。
 */
async function buildOpsRichContext(sessionId: string | undefined, messages: ChatMessage[]): Promise<string> {
  // 用户本轮问题（取最后一条 user 消息，用于 Runbook 检索）
  const question = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  // 趋势预警行
  const trendLines: string[] = [];
  for (const r of lastPatrolResults) {
    for (const t of r.trendAlerts || []) {
      const where = t.resource === 'disk' ? `磁盘 ${t.mount}` : t.resource.toUpperCase();
      trendLines.push(`- ${r.host} ${where} 当前 ${t.currentPercent}%（阈值 ${t.threshold}%，预计 ${t.daysToFull} 天触顶）`);
    }
  }

  const recentCommands = sessionId ? (execHistory.get(sessionId) || []).slice(0, 15) : [];
  const logTail = await fetchLogTail(sessionId);
  const runbookMatches = question ? matchRunbooks(question, 2) : [];

  const input: RichContextInput = {
    opsSummary: buildOpsContext() || undefined,
    trendLines,
    recentCommands,
    logTail: logTail || undefined,
    runbookMatches,
    question,
    budgetChars: 6000
  };
  const body = buildRichContext(input);
  if (!body) return '';
  return `\n\n【服务器上下文（AI 应优先基于以下真实数据分析，而非泛泛而谈）】\n${body}\n` +
    '（数据不含敏感凭据；引用命令时给出可复制的完整命令，涉及危险操作须提醒风险）';
}

/** 对所有已连接 SSH 会话执行一轮巡检；返回结果并（如有告警）推送通知 */
async function runPatrolRound(): Promise<PatrolHostResult[]> {
  const cfg = loadPatrolConfig();
  const startedAt = new Date();
  const results: PatrolHostResult[] = [];
  const sshIds = [...sessions.keys()].filter((id) => sessionKinds.get(id) === 'ssh');
  for (const id of sshIds) {
    const s = getSSH(id);
    if (!s) continue;
    const host = (s as unknown as { config?: { host?: string } }).config?.host || id;
    try {
      const snap = await s.getMetricsSnapshot();
      const alerts = evaluateSnapshot(snap, cfg.thresholds);
      // 趋势提前预警：追加历史快照后做线性回归（未超阈值但按趋势将触顶）
      const hist = patrolHistory.get(host) || [];
      hist.push(snap);
      if (hist.length > PATROL_HISTORY_MAX) hist.splice(0, hist.length - PATROL_HISTORY_MAX);
      patrolHistory.set(host, hist);
      const trendAlerts = cfg.trendWarnDays > 0 ? evaluateTrend(hist, cfg.thresholds, cfg.intervalMinutes, cfg.trendWarnDays) : [];
      // 告警自动触发诊断：本地规则生成基础采集步骤（无需 AI）
      const autoDiagSteps = cfg.autoDiagnose && alerts.length > 0 ? buildAutoDiagSteps(alerts, snap.os) : [];
      results.push({ host, ok: true, snapshot: snap, alerts, trendAlerts, autoDiagSteps });
    } catch (err: any) {
      results.push({ host, ok: false, error: err?.message || String(err), alerts: [] });
    }
  }
  lastPatrolResults = results;
  lastPatrolReport = formatPatrolReport(results, startedAt);

  // 主动预警：critical 级别发系统通知（去重：同一轮内同主机只发一条汇总）
  if (cfg.notify && Notification.isSupported()) {
    for (const r of results) {
      const criticals = r.alerts.filter((a) => a.severity === 'critical');
      if (criticals.length === 0) continue;
      const summary = criticals
        .map((a) => `${a.resource === 'disk' ? `磁盘(${a.mount})` : a.resource.toUpperCase()} ${a.currentPercent}%`)
        .join('、');
      new Notification({
        title: `NebulaX 巡检预警 · ${r.host}`,
        body: `${summary} 已超阈值（${cfg.intervalMinutes} 分钟自动巡检发现）`
      }).show();
    }
  }
  // 推送到渲染端（巡检面板实时刷新 + 站内提醒）
  mainWindow?.webContents.send('patrol:result', {
    ts: startedAt.getTime(),
    results: results.map((r) => ({
      host: r.host,
      ok: r.ok,
      error: r.error,
      cpuPercent: r.snapshot?.cpuPercent,
      memPercent: r.snapshot?.memPercent,
      disk: r.snapshot?.disk,
      alerts: r.alerts,
      trendAlerts: r.trendAlerts,
      autoDiagSteps: r.autoDiagSteps
    }))
  });
  log(
    'info',
    `[patrol] round done: ${results.length} hosts, ${results.reduce((n, r) => n + r.alerts.length, 0)} alerts, ${results.reduce((n, r) => n + (r.trendAlerts?.length || 0), 0)} trend warnings`
  );
  // 告警自动触发 AI 诊断（异步，不阻塞巡检轮次；失败仅记日志）
  if (cfg.autoDiagnose) {
    for (const r of results) {
      if (!r.ok || r.alerts.length === 0) continue;
      void runAiDiagnosisForAlerts(r).catch((e) => log('warn', `[patrol] auto AI diagnosis failed for ${r.host}: ${e}`));
    }
  }
  // 报告自动生成：落盘 markdown 到 ~/.nebula-ssh/reports/
  if (cfg.autoReport && lastPatrolReport) {
    try {
      const dir = path.join(os.homedir(), '.nebula-ssh', 'reports');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stamp = startedAt.toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const file = path.join(dir, `patrol-${stamp}.md`);
      fs.writeFileSync(file, lastPatrolReport, { encoding: 'utf8', mode: 0o600 });
      pruneOldReports(dir, 30); // 保留最近 30 份，防磁盘膨胀
      lastAutoReportPath = file;
      log('info', `[patrol] auto report saved: ${file}`);
    } catch (e: any) {
      log('warn', `[patrol] auto report save failed: ${e?.message || e}`);
    }
  }
  return results;
}

let lastAutoReportPath = '';

/** 保留最近 N 份自动报告，删除更旧的 */
function pruneOldReports(dir: string, keep: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('patrol-') && f.endsWith('.md'))
      .sort();
    if (files.length <= keep) return;
    for (const f of files.slice(0, files.length - keep)) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/**
 * 告警自动触发 AI 诊断：把巡检告警作为"故障现象"交给诊断 Agent 规划，
 * 生成的步骤推送到渲染端（巡检面板展示"AI 已生成诊断方案"）。
 * 未配置 AI key 时静默跳过（本地 buildAutoDiagSteps 已提供基础步骤）。
 */
async function runAiDiagnosisForAlerts(r: PatrolHostResult): Promise<void> {
  if (!loadApiKey()) return;
  const snap = r.snapshot;
  if (!snap) return;
  const incident = `巡检发现资源告警：${r.alerts
    .map((a) => `${a.resource === 'disk' ? `磁盘(${a.mount})` : a.resource.toUpperCase()} 使用率 ${a.currentPercent}%（阈值 ${a.threshold}%）`)
    .join('；')}`;
  const context = `主机 ${r.host}（${snap.os === 'windows' ? 'Windows' : 'Linux'}），当前 CPU ${snap.cpuPercent}%、内存 ${snap.memPercent}%、负载 ${snap.load1}、连接数 ${snap.connections}，磁盘：${(snap.disk || []).map((d) => `${d.mount} ${d.usePercent}%`).join('，')}`;
  const steps = await planDiagnosticSteps(incident, context, snap.os);
  if (steps.length === 0) return;
  log('info', `[patrol] AI diagnosis planned ${steps.length} steps for ${r.host}`);
  mainWindow?.webContents.send('patrol:ai-diagnosis', { host: r.host, incident, steps });
}

function applyPatrolSchedule(cfg: PatrolConfig): void {
  if (patrolTimer) {
    clearInterval(patrolTimer);
    patrolTimer = null;
  }
  if (cfg.enabled) {
    patrolTimer = setInterval(() => {
      void runPatrolRound().catch((e) => log('error', `[patrol] round failed: ${e}`));
    }, cfg.intervalMinutes * 60000);
    log('info', `[patrol] scheduler enabled: every ${cfg.intervalMinutes}min`);
  } else {
    log('info', '[patrol] scheduler disabled');
  }
}

// 启动时恢复巡检计划（应用启动后即可生效，无需用户再点一次）
const initialPatrolCfg = loadPatrolConfig();
if (initialPatrolCfg.enabled) {
  // 延后到 app ready 后启动，避免过早创建 Notification
  app.whenReady().then(() => applyPatrolSchedule(initialPatrolCfg));
}

ipcMain.handle('patrol:get-config', () => ({ ok: true, config: loadPatrolConfig() }));

ipcMain.handle('patrol:set-config', (_e, config: PatrolConfig) => {
  const saved = savePatrolConfig(config);
  applyPatrolSchedule(saved);
  return { ok: true, config: saved };
});

ipcMain.handle('patrol:run-now', async () => {
  try {
    const results = await runPatrolRound();
    return { ok: true, results, report: lastPatrolReport };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('patrol:last-report', () => ({ ok: true, report: lastPatrolReport, results: lastPatrolResults }));

// 巡检报告导出为 Markdown 文件
ipcMain.handle('patrol:export-report', async () => {
  if (!lastPatrolReport) return { ok: false, error: '暂无巡检报告，请先执行一次巡检' };
  if (!mainWindow) return { ok: false, error: '窗口不可用' };
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出巡检报告',
    defaultPath: `nebula-patrol-${new Date().toISOString().slice(0, 10)}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' };
  try {
    fs.writeFileSync(res.filePath, lastPatrolReport, 'utf8');
    log('info', `巡检报告已导出：${res.filePath}`);
    return { ok: true, path: res.filePath };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// 打开自动报告目录（reports/ 下按时间戳归档）
ipcMain.handle('patrol:open-reports', async () => {
  const dir = path.join(os.homedir(), '.nebula-ssh', 'reports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  await shell.openPath(dir);
  return { ok: true, path: dir, lastReport: lastAutoReportPath };
});

// Script generation
ipcMain.handle('ai:gen-script', async (_e, payload: { requirement: string; context?: string }) => {
  try {
    const script = await generateScript(payload.requirement, payload.context);
    return { ok: true, script };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---- v1.7 场景化预设 ----
ipcMain.handle('ai:scenarios', (_e, payload?: { category?: ScenarioCategory }) => {
  return { ok: true, scenarios: getScenarios(payload?.category), labels: SCENARIO_CATEGORY_LABELS };
});

// ---- v1.7 多模型路由配置 ----
ipcMain.handle('ai:routing-get', () => ({ ok: true, routing: loadRoutingConfig(), taskLabels: AI_TASK_LABELS }));

ipcMain.handle('ai:routing-set', (_e, routing: RoutingConfig) => {
  try {
    const saved = saveRoutingConfig(routing);
    log('info', `[routing] saved: enabled=${saved.enabled} rules=${Object.keys(saved.rules).length}`);
    return { ok: true, routing: saved };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---- v1.7 数据库专项 AI 诊断 ----
ipcMain.handle('ai:db-diagnose', async (_e, payload: { sessionId: string; dialect: DbDialect; context?: string }) => {
  const s = getSSH(payload.sessionId);
  if (!s) return { ok: false, error: sessionKinds.has(payload.sessionId) ? '该功能仅 SSH 会话支持' : 'session not found' };
  try {
    const items = dbCollectItems(payload.dialect);
    const samples: DbSampleResult[] = [];
    for (const item of items) {
      try {
        const r = await s.exec(item.sql, item.timeoutMs || 12000);
        samples.push({ id: item.id, label: item.label, ok: (r.code ?? 0) === 0 || !!r.stdout?.trim(), output: r.stdout || '', error: r.stderr || undefined });
      } catch (err: any) {
        samples.push({ id: item.id, label: item.label, ok: false, output: '', error: err?.message || String(err) });
      }
    }
    const { report, degraded } = await diagnoseDatabase(payload.dialect, samples, payload.context);
    log('info', `[dbdiag] ${payload.dialect}: ${report.findings.length} findings${degraded ? ' (degraded)' : ''}`);
    return { ok: true, report, degraded };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---- v1.7 性能调优建议（只读采集）----
ipcMain.handle('ai:perf-analyze', async (_e, payload: { sessionId: string; role?: string }) => {
  const s = getSSH(payload.sessionId);
  if (!s) return { ok: false, error: sessionKinds.has(payload.sessionId) ? '该功能仅 SSH 会话支持' : 'session not found' };
  try {
    const osType = await s.detectOS();
    const items = perfCollectItems(osType);
    const collected: Record<string, string> = {};
    await Promise.all(
      items.map(async (item) => {
        try {
          const r = await s.exec(item.command, item.timeoutMs || 8000);
          collected[item.id] = r.stdout || '';
        } catch (err: any) {
          collected[item.id] = '';
          log('warn', `[perf] collect ${item.id} failed: ${err?.message || err}`);
        }
      })
    );
    const report: PerfReport = await analyzePerf(collected, osType, payload.role);
    log('info', `[perf] ${osType}: ${report.items.length} items${report.degraded ? ' (degraded)' : ''}`);
    return { ok: true, report };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---- Window controls ----
ipcMain.handle('win:minimize', () => mainWindow?.minimize());
ipcMain.handle('clipboard:read', () => {
  try {
    return { ok: true, text: clipboard.readText() };
  } catch (e: any) {
    return { ok: false, error: e?.message || '读取剪贴板失败' };
  }
});
ipcMain.handle('clipboard:write', (_e, text: string) => {
  try {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || '写入剪贴板失败' };
  }
});
ipcMain.handle('win:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('win:close', () => mainWindow?.close());

// ---- Vault IPC ----
ipcMain.handle('vault:status', () => {
  return { ok: true, ...vaultStatus() };
});

ipcMain.handle('vault:set', (_e, id: string, secrets: VaultSecrets) => {
  return vaultSet(id, secrets);
});

ipcMain.handle('vault:get', (_e, id: string) => {
  return vaultGet(id);
});

ipcMain.handle('vault:delete', (_e, id: string) => {
  return vaultDelete(id);
});

// ---- SFTP IPC ----
ipcMain.handle('sftp:list', async (_e, sessionId: string, dir: string) => {
  try {
    const svc = await getSftpService(sessionId);
    const files = await svc.list(dir);
    return { ok: true, files };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('sftp:stat', async (_e, sessionId: string, p: string) => {
  try {
    const svc = await getSftpService(sessionId);
    const file = await svc.stat(p);
    return { ok: true, file };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('sftp:mkdir', async (_e, sessionId: string, p: string) => {
  try {
    const svc = await getSftpService(sessionId);
    await svc.mkdir(p);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('sftp:rmdir', async (_e, sessionId: string, p: string) => {
  try {
    const svc = await getSftpService(sessionId);
    await svc.rmdir(p);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('sftp:unlink', async (_e, sessionId: string, p: string) => {
  try {
    const svc = await getSftpService(sessionId);
    await svc.unlink(p);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('sftp:rename', async (_e, sessionId: string, src: string, dest: string) => {
  try {
    const svc = await getSftpService(sessionId);
    await svc.rename(src, dest);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('sftp:upload', async (_e, sessionId: string, transferId: string, localPath: string, remotePath: string, filename: string) => {
  // 与 local:* 一致的安全边界：本地文件必须位于用户主目录内
  const allowed = isPathAllowed(localPath);
  if (!allowed.ok) return { ok: false, error: allowed.error };
  try {
    return await enqueueTransfer(async () => {
      const svc = await getSftpService(sessionId);
      await svc.upload(transferId, localPath, remotePath, filename);
      return { ok: true as const };
    });
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('sftp:download', async (_e, sessionId: string, transferId: string, remotePath: string, localPath: string, filename: string) => {
  // 本地落盘路径同样受限，防止恶意/异常远端文件名遍历写出主目录
  const allowed = isPathAllowed(localPath);
  if (!allowed.ok) return { ok: false, error: allowed.error };
  try {
    return await enqueueTransfer(async () => {
      const svc = await getSftpService(sessionId);
      await svc.download(transferId, remotePath, localPath, filename);
      return { ok: true as const };
    });
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('sftp:cancel', (_e, sessionId: string, transferId: string) => {
  try {
    const svc = sftpServices.get(sessionId);
    return { ok: svc ? svc.cancel(transferId) : false };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---- 数据库快速查询（经 SSH 会话 exec 远端 mysql/psql CLI）----
ipcMain.handle('db:query', async (_e, sessionId: string, cfg: DbConfig, sql: string) => {
  try {
    const s = getSSH(sessionId);
    if (!s) return { ok: false, error: '数据库查询仅 SSH 会话支持' };
    const result = await runDbQuery(s.exec.bind(s), cfg, sql);
    log('info', `数据库查询 ${cfg.type}@${cfg.host}:${cfg.port}/${cfg.database} ${result.durationMs}ms`);
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('db:test', async (_e, sessionId: string, cfg: DbConfig) => {
  try {
    const s = getSSH(sessionId);
    if (!s) return { ok: false, error: '数据库查询仅 SSH 会话支持' };
    await testDb(s.exec.bind(s), cfg);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---- 本地文件系统（SFTP 左栏）----
ipcMain.handle('local:list', (_e, dir: string) => {
  try {
    const d = dir === '~' ? app.getPath('home') : dir;
    const check = isPathAllowed(d);
    if (!check.ok) return { ok: false, error: check.error };
    const entries = fs.readdirSync(d, { withFileTypes: true });
    const files = entries.map((e) => {
      const full = path.join(d, e.name);
      let size = 0;
      let mtime = 0;
      let mode = 0;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtimeMs;
        mode = st.mode;
      } catch {}
      return {
        name: e.name,
        path: full,
        isDir: e.isDirectory(),
        size,
        modifyTime: mtime,
        mode
      };
    });
    files.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ok: true, files, path: d };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('local:pick-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'] });
  if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'canceled' };
  const check = isPathAllowed(res.filePaths[0]);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, path: res.filePaths[0] };
});

ipcMain.handle('local:pick-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'canceled' };
  const check = isPathAllowed(res.filePaths[0]);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, path: res.filePaths[0] };
});

ipcMain.handle('local:mkdir', (_e, p: string) => {
  try {
    const check = isPathAllowed(p);
    if (!check.ok) return { ok: false, error: check.error };
    fs.mkdirSync(p, { recursive: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('local:delete', (_e, p: string) => {
  try {
    const check = isPathAllowed(p);
    if (!check.ok) return { ok: false, error: check.error };
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('local:rename', (_e, src: string, dest: string) => {
  try {
    const c1 = isPathAllowed(src);
    if (!c1.ok) return { ok: false, error: c1.error };
    const c2 = isPathAllowed(dest);
    if (!c2.ok) return { ok: false, error: c2.error };
    fs.renameSync(src, dest);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('local:home', () => {
  return { ok: true, path: app.getPath('home') };
});
