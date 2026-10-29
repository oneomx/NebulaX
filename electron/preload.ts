import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('nebula', {
  // 拖拽/选择的 File 对象 -> 真实磁盘路径（Electron 32+ 移除了 File.path）
  getFilePath: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  // SSH
  sshConnect: (config: unknown) => ipcRenderer.invoke('ssh:connect', config),
  sshTest: (config: unknown) => ipcRenderer.invoke('ssh:test', config),
  sshDisconnect: (sessionId: string) => ipcRenderer.invoke('ssh:disconnect', sessionId),
  sshExec: (sessionId: string, command: string) => ipcRenderer.invoke('ssh:exec', sessionId, command),
  sshWrite: (sessionId: string, data: string) => ipcRenderer.invoke('ssh:write', sessionId, data),
  sshResize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('ssh:resize', sessionId, cols, rows),
  sshGetServerInfo: (sessionId: string) => ipcRenderer.invoke('ssh:server-info', sessionId),
  sshListSessions: () => ipcRenderer.invoke('ssh:list'),

  // 多协议终端（Telnet / 本地终端 / 串口）
  termConnect: (config: unknown) => ipcRenderer.invoke('term:connect', config),
  termShells: () => ipcRenderer.invoke('term:shells'),
  termSerialPorts: () => ipcRenderer.invoke('term:serial-ports'),

  // Windows 适配（RDP/VNC/工具探测）
  winDetectTools: () => ipcRenderer.invoke('win:detect-tools'),
  winLaunchRdp: (opts: unknown) => ipcRenderer.invoke('win:launch-rdp', opts),
  winLaunchVnc: (opts: unknown) => ipcRenderer.invoke('win:launch-vnc', opts),

  // SSH 隧道
  tunnelStart: (sessionId: string, spec: unknown) => ipcRenderer.invoke('tunnel:start', sessionId, spec),
  tunnelStop: (tunnelId: string) => ipcRenderer.invoke('tunnel:stop', tunnelId),
  tunnelList: () => ipcRenderer.invoke('tunnel:list'),

  // 主机指纹（known_hosts，TOFU）
  hostKeysList: () => ipcRenderer.invoke('hostkeys:list'),
  hostKeysRemove: (host: string, port: number) => ipcRenderer.invoke('hostkeys:remove', host, port),

  // 诊断包导出
  diagExport: () => ipcRenderer.invoke('diag:export'),
  openLogDir: () => ipcRenderer.invoke('app:open-logs'),

  // 高阶 SSH 数据采集
  sshAuditData: (sessionId: string) => ipcRenderer.invoke('ssh:audit-data', sessionId),
  sshDiagnosticsBundle: (sessionId: string) => ipcRenderer.invoke('ssh:diagnostics-bundle', sessionId),
  sshMetricsSnapshot: (sessionId: string) => ipcRenderer.invoke('ssh:metrics-snapshot', sessionId),

  // AI
  aiChat: (payload: unknown) => ipcRenderer.invoke('ai:chat', payload),
  aiUsage: () => ipcRenderer.invoke('ai:usage'),
  aiConfigGet: () => ipcRenderer.invoke('ai:config-get'),
  aiConfigSet: (config: unknown) => ipcRenderer.invoke('ai:config-set', config),

  // 高阶 AI 能力
  aiAudit: (payload: unknown) => ipcRenderer.invoke('ai:audit', payload),
  aiPlanDiagnostic: (payload: unknown) => ipcRenderer.invoke('ai:plan-diagnostic', payload),
  aiAnalyzeDiagnostic: (payload: unknown) => ipcRenderer.invoke('ai:analyze-diagnostic', payload),
  aiForecast: (snapshots: unknown[]) => ipcRenderer.invoke('ai:forecast', snapshots),
  aiGenScript: (payload: unknown) => ipcRenderer.invoke('ai:gen-script', payload),
  forecastLinear: (payload: unknown) => ipcRenderer.invoke('forecast:linear', payload),

  // v1.7 场景化 / 多模型路由 / 专项诊断
  aiScenarios: (payload?: unknown) => ipcRenderer.invoke('ai:scenarios', payload),
  aiRoutingGet: () => ipcRenderer.invoke('ai:routing-get'),
  aiRoutingSet: (routing: unknown) => ipcRenderer.invoke('ai:routing-set', routing),
  aiDbDiagnose: (payload: unknown) => ipcRenderer.invoke('ai:db-diagnose', payload),
  aiPerfAnalyze: (payload: unknown) => ipcRenderer.invoke('ai:perf-analyze', payload),

  // 定时巡检与主动预警
  patrolGetConfig: () => ipcRenderer.invoke('patrol:get-config'),
  patrolSetConfig: (config: unknown) => ipcRenderer.invoke('patrol:set-config', config),
  patrolRunNow: () => ipcRenderer.invoke('patrol:run-now'),
  patrolLastReport: () => ipcRenderer.invoke('patrol:last-report'),
  patrolExportReport: () => ipcRenderer.invoke('patrol:export-report'),
  patrolOpenReports: () => ipcRenderer.invoke('patrol:open-reports'),
  onPatrolResult: (cb: (r: unknown) => void) => {
    const handler = (_e: unknown, r: unknown) => cb(r);
    ipcRenderer.on('patrol:result', handler);
    return () => ipcRenderer.removeListener('patrol:result', handler);
  },
  onPatrolAiDiagnosis: (cb: (r: unknown) => void) => {
    const handler = (_e: unknown, r: unknown) => cb(r);
    ipcRenderer.on('patrol:ai-diagnosis', handler);
    return () => ipcRenderer.removeListener('patrol:ai-diagnosis', handler);
  },

  // RAG 知识库
  ragAdd: (payload: unknown) => ipcRenderer.invoke('rag:add', payload),
  ragList: () => ipcRenderer.invoke('rag:list'),
  ragRemove: (id: string) => ipcRenderer.invoke('rag:remove', id),
  ragRetrieve: (query: string) => ipcRenderer.invoke('rag:retrieve', query),
  ragContext: (query: string) => ipcRenderer.invoke('rag:context', query),
  ragRestoreBuiltin: () => ipcRenderer.invoke('rag:restore-builtin'),
  ragBuiltinStats: () => ipcRenderer.invoke('rag:builtin-stats'),

  // 许可激活（离线）
  licenseState: () => ipcRenderer.invoke('license:state'),
  licenseActivate: (code: string) => ipcRenderer.invoke('license:activate', code),
  licenseDeactivate: () => ipcRenderer.invoke('license:deactivate'),

  // Vault 凭据保管库
  vaultStatus: () => ipcRenderer.invoke('vault:status'),
  vaultSet: (id: string, secrets: unknown) => ipcRenderer.invoke('vault:set', id, secrets),
  vaultGet: (id: string) => ipcRenderer.invoke('vault:get', id),
  vaultDelete: (id: string) => ipcRenderer.invoke('vault:delete', id),

  // 剪贴板（终端复制/剪切/粘贴）
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text: string) => ipcRenderer.invoke('clipboard:write', text),

  // SFTP 文件传输
  sftpList: (sessionId: string, dir: string) => ipcRenderer.invoke('sftp:list', sessionId, dir),
  sftpStat: (sessionId: string, p: string) => ipcRenderer.invoke('sftp:stat', sessionId, p),
  sftpMkdir: (sessionId: string, p: string) => ipcRenderer.invoke('sftp:mkdir', sessionId, p),
  sftpRmdir: (sessionId: string, p: string) => ipcRenderer.invoke('sftp:rmdir', sessionId, p),
  sftpUnlink: (sessionId: string, p: string) => ipcRenderer.invoke('sftp:unlink', sessionId, p),
  sftpRename: (sessionId: string, src: string, dest: string) => ipcRenderer.invoke('sftp:rename', sessionId, src, dest),
  sftpUpload: (sessionId: string, transferId: string, localPath: string, remotePath: string, filename: string) =>
    ipcRenderer.invoke('sftp:upload', sessionId, transferId, localPath, remotePath, filename),
  sftpDownload: (sessionId: string, transferId: string, remotePath: string, localPath: string, filename: string) =>
    ipcRenderer.invoke('sftp:download', sessionId, transferId, remotePath, localPath, filename),
  sftpCancel: (sessionId: string, transferId: string) => ipcRenderer.invoke('sftp:cancel', sessionId, transferId),

  // 数据库快速查询（经 SSH exec 远端 CLI）
  dbQuery: (sessionId: string, cfg: unknown, sql: string) => ipcRenderer.invoke('db:query', sessionId, cfg, sql),
  dbTest: (sessionId: string, cfg: unknown) => ipcRenderer.invoke('db:test', sessionId, cfg),
  onSftpProgress: (cb: (p: any) => void) => {
    const handler = (_e: unknown, p: any) => cb(p);
    ipcRenderer.on('sftp:progress', handler);
    return () => ipcRenderer.removeListener('sftp:progress', handler);
  },

  // 本地文件系统（SFTP 左栏）
  localList: (dir: string) => ipcRenderer.invoke('local:list', dir),
  localPickFile: () => ipcRenderer.invoke('local:pick-file'),
  localPickDir: () => ipcRenderer.invoke('local:pick-dir'),
  localMkdir: (p: string) => ipcRenderer.invoke('local:mkdir', p),
  localDelete: (p: string) => ipcRenderer.invoke('local:delete', p),
  localRename: (src: string, dest: string) => ipcRenderer.invoke('local:rename', src, dest),
  localHome: () => ipcRenderer.invoke('local:home'),

  // Window
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),

  // Terminal events from main
  onSshData: (cb: (sessionId: string, data: string) => void) => {
    const handler = (_e: unknown, sessionId: string, data: string) => cb(sessionId, data);
    ipcRenderer.on('ssh:data', handler);
    return () => ipcRenderer.removeListener('ssh:data', handler);
  },
  onSshClose: (cb: (sessionId: string) => void) => {
    const handler = (_e: unknown, sessionId: string) => cb(sessionId);
    ipcRenderer.on('ssh:close', handler);
    return () => ipcRenderer.removeListener('ssh:close', handler);
  },
  onSshError: (cb: (sessionId: string, message: string) => void) => {
    const handler = (_e: unknown, sessionId: string, message: string) => cb(sessionId, message);
    ipcRenderer.on('ssh:error', handler);
    return () => ipcRenderer.removeListener('ssh:error', handler);
  },
  onSshReconnecting: (cb: (sessionId: string, info: { attempt: number; max: number; delayMs: number }) => void) => {
    const handler = (_e: unknown, sessionId: string, info: { attempt: number; max: number; delayMs: number }) => cb(sessionId, info);
    ipcRenderer.on('ssh:reconnecting', handler);
    return () => ipcRenderer.removeListener('ssh:reconnecting', handler);
  },
  onSshReconnected: (cb: (sessionId: string) => void) => {
    const handler = (_e: unknown, sessionId: string) => cb(sessionId);
    ipcRenderer.on('ssh:reconnected', handler);
    return () => ipcRenderer.removeListener('ssh:reconnected', handler);
  }
});
