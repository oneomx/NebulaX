import type {
  SSHConfig,
  VaultSecrets,
  ChatMessage,
  SftpFileEntry,
  ServerInfo,
  AIConfig,
  TermConnectConfig,
  TunnelSpec,
  TunnelInfo,
  DetectedTools,
  SerialPortInfo,
  HostKeyPrompt,
  HostKeyEntry,
  DbConfig,
  DbQueryResult
} from '../types';
import type { LicenseState } from '../types/license';

/** 巡检配置（与主进程 patrol.ts PatrolConfig 对齐） */
export interface PatrolConfigShape {
  enabled: boolean;
  intervalMinutes: number;
  thresholds: { cpu: number; mem: number; disk: number };
  notify: boolean;
  /** 告警时自动生成诊断步骤（本地规则，无需 AI） */
  autoDiagnose: boolean;
  /** 每轮巡检后自动生成报告文件 */
  autoReport: boolean;
  /** 趋势提前预警窗口（天，0=关闭） */
  trendWarnDays: number;
}

/** v1.7 AI 任务类型（多模型路由用） */
export type AiTaskType = 'chat' | 'diagnose' | 'audit' | 'script' | 'forecast' | 'db' | 'perf';

/** v1.7 场景分类 */
export type ScenarioCategory = 'ops' | 'security' | 'database' | 'perf';

/** v1.7 场景预设（与主进程 scenarios.ts 对齐） */
export interface ScenarioPreset {
  id: string;
  category: ScenarioCategory;
  name: string;
  icon: string;
  description: string;
  incident: string;
  contextHint: string;
  steps: { command: string; purpose: string }[];
  quickPrompt: string;
}

/** v1.7 路由配置（与主进程 router.ts 对齐） */
export interface RoutingConfigShape {
  enabled: boolean;
  rules: Partial<Record<AiTaskType, { model?: string; baseUrl?: string; maxTokens?: number }>>;
}

export interface NebulaAPI {
  sshConnect: (config: SSHConfig) => Promise<{ ok: boolean; sessionId?: string; error?: string; hostKeyPrompt?: HostKeyPrompt }>;
  sshTest: (config: SSHConfig) => Promise<{ ok: boolean; info?: ServerInfo; error?: string }>;
  sshDisconnect: (id: string) => Promise<{ ok: boolean }>;
  sshExec: (id: string, cmd: string) => Promise<{ ok: boolean; stdout?: string; stderr?: string; code?: number | null; error?: string }>;
  sshWrite: (id: string, data: string) => Promise<{ ok: boolean }>;
  sshResize: (id: string, cols: number, rows: number) => Promise<{ ok: boolean }>;
  sshGetServerInfo: (id: string) => Promise<{ ok: boolean; info?: ServerInfo; error?: string }>;
  sshListSessions: () => Promise<{ ok: boolean; sessions: string[] }>;

  // 多协议终端（Telnet / 本地终端 / 串口）
  termConnect: (config: TermConnectConfig) => Promise<{ ok: boolean; sessionId?: string; mode?: 'pty' | 'pipe'; error?: string }>;
  termShells: () => Promise<{ ok: boolean; presets?: { id: string; label: string; win?: boolean; unix?: boolean }[]; defaultShell?: string }>;
  termSerialPorts: () => Promise<{ ok: boolean; ports?: SerialPortInfo[]; error?: string }>;

  // Windows 适配
  winDetectTools: () => Promise<{ ok: boolean; tools?: DetectedTools; error?: string }>;
  winLaunchRdp: (opts: { host: string; port?: number; username?: string; password?: string; fullscreen?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  winLaunchVnc: (opts: { host: string; port?: number; viewerPath?: string }) => Promise<{ ok: boolean; viewer?: string; error?: string }>;

  // SSH 隧道
  tunnelStart: (sessionId: string, spec: TunnelSpec) => Promise<{ ok: boolean; tunnel?: TunnelInfo; error?: string }>;
  tunnelStop: (tunnelId: string) => Promise<{ ok: boolean }>;
  tunnelList: () => Promise<{ ok: boolean; tunnels?: TunnelInfo[] }>;

  // 主机指纹（known_hosts，TOFU）
  hostKeysList: () => Promise<{ ok: boolean; entries?: HostKeyEntry[] }>;
  hostKeysRemove: (host: string, port: number) => Promise<{ ok: boolean }>;
  // 诊断包导出
  diagExport: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  openLogDir: () => Promise<{ ok: boolean; path?: string; error?: string }>;

  aiChat: (payload: { messages: ChatMessage[]; config?: Partial<AIConfig>; attachOps?: boolean; task?: AiTaskType; attachRich?: boolean; sessionId?: string }) => Promise<{ ok: boolean; reply?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; modelUsed?: string; error?: string }>;
  aiConfigGet: () => Promise<{ ok: boolean; config?: AIConfig }>;
  aiConfigSet: (config: Partial<AIConfig>) => Promise<{ ok: boolean; config?: AIConfig }>;
  aiUsage: () => Promise<{
    ok: boolean;
    usage?: {
      today: { promptTokens: number; completionTokens: number; totalTokens: number; calls: number };
      daily: { date: string; model: string; promptTokens: number; completionTokens: number; calls: number }[];
      byModel: { model: string; promptTokens: number; completionTokens: number; totalTokens: number; calls: number }[];
    };
    error?: string;
  }>;

  // 高阶 SSH 数据采集
  sshAuditData: (id: string) => Promise<{ ok: boolean; data?: string; error?: string }>;
  sshDiagnosticsBundle: (id: string) => Promise<{ ok: boolean; bundle?: unknown; error?: string }>;
  sshMetricsSnapshot: (id: string) => Promise<{ ok: boolean; snapshot?: unknown; error?: string }>;

  // 高阶 AI
  aiAudit: (payload: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  aiPlanDiagnostic: (payload: unknown) => Promise<{ ok: boolean; steps?: unknown[]; error?: string }>;
  aiAnalyzeDiagnostic: (payload: unknown) => Promise<{ ok: boolean; report?: unknown; error?: string }>;
  aiForecast: (snapshots: unknown[]) => Promise<{ ok: boolean; result?: unknown; degraded?: boolean; error?: string }>;
  aiGenScript: (payload: unknown) => Promise<{ ok: boolean; script?: unknown; error?: string }>;
  forecastLinear: (payload: unknown) => Promise<{ ok: boolean; days?: number | null }>;

  // v1.7 场景化预设 / 多模型路由 / 专项诊断
  aiScenarios: (payload?: { category?: ScenarioCategory }) => Promise<{ ok: boolean; scenarios?: ScenarioPreset[]; labels?: Record<string, string>; error?: string }>;
  aiRoutingGet: () => Promise<{ ok: boolean; routing?: RoutingConfigShape; taskLabels?: Record<string, string>; error?: string }>;
  aiRoutingSet: (routing: RoutingConfigShape) => Promise<{ ok: boolean; routing?: unknown; error?: string }>;
  aiDbDiagnose: (payload: { sessionId: string; dialect: 'mysql' | 'postgres'; context?: string }) => Promise<{ ok: boolean; report?: unknown; degraded?: boolean; error?: string }>;
  aiPerfAnalyze: (payload: { sessionId: string; role?: string }) => Promise<{ ok: boolean; report?: unknown; error?: string }>;

  // 定时巡检与主动预警
  patrolGetConfig: () => Promise<{ ok: boolean; config?: PatrolConfigShape }>;
  patrolSetConfig: (config: PatrolConfigShape) => Promise<{ ok: boolean; config?: unknown; error?: string }>;
  patrolRunNow: () => Promise<{ ok: boolean; results?: unknown[]; report?: string; error?: string }>;
  patrolExportReport: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  patrolOpenReports: () => Promise<{ ok: boolean; path?: string; lastReport?: string; error?: string }>;
  patrolLastReport: () => Promise<{ ok: boolean; report?: string; results?: unknown[] }>;
  onPatrolResult: (cb: (r: unknown) => void) => () => void;
  onPatrolAiDiagnosis: (cb: (r: unknown) => void) => () => void;

  // RAG
  ragAdd: (payload: unknown) => Promise<{ ok: boolean; doc?: unknown; error?: string }>;
  ragList: () => Promise<{ ok: boolean; docs?: unknown[] }>;
  ragRemove: (id: string) => Promise<{ ok: boolean }>;
  ragRetrieve: (query: string) => Promise<{ ok: boolean; results?: unknown[] }>;
  ragContext: (query: string) => Promise<{ ok: boolean; context?: string }>;
  ragRestoreBuiltin: () => Promise<{ ok: boolean; added?: number; total?: number; error?: string }>;
  ragBuiltinStats: () => Promise<{ ok: boolean; total?: number; present?: number; error?: string }>;

  // 许可激活（离线）
  licenseState: () => Promise<{ ok: boolean; state?: LicenseState; error?: string }>;
  licenseActivate: (code: string) => Promise<{ ok: boolean; error?: string; state?: LicenseState }>;
  licenseDeactivate: () => Promise<{ ok: boolean; error?: string }>;

  // Vault 凭据保管库
  vaultStatus: () => Promise<{ ok: boolean; available: boolean; reason?: string }>;
  vaultSet: (id: string, secrets: VaultSecrets) => Promise<{ ok: boolean; error?: string }>;
  vaultGet: (id: string) => Promise<{ ok: boolean; secrets?: VaultSecrets; error?: string }>;
  vaultDelete: (id: string) => Promise<{ ok: boolean }>;

  // 剪贴板（终端复制/剪切/粘贴）
  clipboardRead: () => Promise<{ ok: boolean; text?: string; error?: string }>;
  clipboardWrite: (text: string) => Promise<{ ok: boolean; error?: string }>;

  // SFTP 文件传输
  sftpList: (sessionId: string, dir: string) => Promise<{ ok: boolean; files?: SftpFileEntry[]; error?: string }>;
  sftpStat: (sessionId: string, p: string) => Promise<{ ok: boolean; file?: SftpFileEntry; error?: string }>;
  sftpMkdir: (sessionId: string, p: string) => Promise<{ ok: boolean; error?: string }>;
  sftpRmdir: (sessionId: string, p: string) => Promise<{ ok: boolean; error?: string }>;
  sftpUnlink: (sessionId: string, p: string) => Promise<{ ok: boolean; error?: string }>;
  sftpRename: (sessionId: string, src: string, dest: string) => Promise<{ ok: boolean; error?: string }>;
  sftpUpload: (sessionId: string, transferId: string, localPath: string, remotePath: string, filename: string) => Promise<{ ok: boolean; error?: string }>;
  sftpDownload: (sessionId: string, transferId: string, remotePath: string, localPath: string, filename: string) => Promise<{ ok: boolean; error?: string }>;
  sftpCancel: (sessionId: string, transferId: string) => Promise<{ ok: boolean; error?: string }>;
  onSftpProgress: (cb: (p: { transferId: string; sessionId: string; filename: string; direction?: 'upload' | 'download'; transferred?: number; total?: number; percent: number; done: boolean; error?: string }) => void) => () => void;

  // 数据库快速查询（经 SSH exec 远端 mysql/psql）
  dbQuery: (sessionId: string, cfg: DbConfig, sql: string) => Promise<{ ok: boolean; result?: DbQueryResult; error?: string }>;
  dbTest: (sessionId: string, cfg: DbConfig) => Promise<{ ok: boolean; error?: string }>;

  // 本地文件系统
  localList: (dir: string) => Promise<{ ok: boolean; files?: SftpFileEntry[]; path?: string; error?: string }>;
  localPickFile: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  localPickDir: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  localMkdir: (p: string) => Promise<{ ok: boolean; error?: string }>;
  localDelete: (p: string) => Promise<{ ok: boolean; error?: string }>;
  localRename: (src: string, dest: string) => Promise<{ ok: boolean; error?: string }>;
  localHome: () => Promise<{ ok: boolean; path?: string }>;
  getFilePath: (file: File) => string;

  winMinimize: () => void;
  winMaximize: () => void;
  winClose: () => void;
  onSshData: (cb: (sessionId: string, data: string) => void) => () => void;
  onSshClose: (cb: (sessionId: string) => void) => () => void;
  onSshError: (cb: (sessionId: string, message: string) => void) => () => void;
  onSshReconnecting: (cb: (sessionId: string, info: { attempt: number; max: number; delayMs: number }) => void) => () => void;
  onSshReconnected: (cb: (sessionId: string) => void) => () => void;
}

declare global {
  interface Window {
    nebula?: NebulaAPI;
  }
}

/** Browser-only mock used when running outside Electron (for UI preview). */
export function getAPI(): NebulaAPI {
  if (typeof window !== 'undefined' && window.nebula) {
    return window.nebula;
  }
  // Mock API for browser preview
  const mockInfo = {
    hostname: 'web-preview-host',
    os: 'Ubuntu 22.04.4 LTS',
    kernel: '5.15.0-91-generic',
    arch: 'x86_64',
    cpuModel: 'AMD EPYC 7B13 (preview)',
    cpuCores: 8,
    memTotal: 16384,
    memUsed: 7423,
    memFree: 8961,
    swapTotal: 4096,
    swapUsed: 512,
    diskList: [
      { fs: '/dev/sda1', size: '200G', used: '87G', avail: '103G', use: '46%', mount: '/' },
      { fs: '/dev/sdb1', size: '1.0T', used: '210G', avail: '790G', use: '21%', mount: '/data' }
    ],
    load: ['0.32', '0.18', '0.09'],
    uptime: 'up 14 days, 3 hours, 22 minutes',
    users: ['root', 'admin', 'deploy', 'nginx'],
    topProcesses: ['java 8.2', 'mysqld 4.1', 'docker 2.0', 'node 1.5', 'python 1.2'],
    docker: 'nginx-web  Up 3 days\nredis-cache  Up 7 days\nmysql-primary  Up 14 days',
    ipAddresses: ['192.168.1.100', '10.0.0.5']
  };
  return {
    sshConnect: async () => ({ ok: true, sessionId: 'mock-session' }),
    sshTest: async () => ({ ok: true, info: mockInfo }),
    sshDisconnect: async () => ({ ok: true }),
    sshExec: async (_id, _cmd) => ({ ok: true, stdout: '(browser preview) 命令已模拟执行\n' }),
    sshWrite: async () => ({ ok: true }),
    sshResize: async () => ({ ok: true }),
    sshGetServerInfo: async () => ({ ok: true, info: mockInfo }),
    sshListSessions: async () => ({ ok: true, sessions: ['mock-session'] }),
    termConnect: async () => ({ ok: true, sessionId: 'mock-term', mode: 'pty' }),
    termShells: async () => ({
      ok: true,
      presets: [
        { id: 'powershell', label: 'Windows PowerShell', win: true },
        { id: 'pwsh', label: 'PowerShell 7 (pwsh)', win: true },
        { id: 'cmd', label: '命令提示符 (CMD)', win: true },
        { id: 'wsl', label: 'WSL (Linux)', win: true },
        { id: 'git-bash', label: 'Git Bash', win: true }
      ],
      defaultShell: 'powershell'
    }),
    termSerialPorts: async () => ({ ok: true, ports: [{ path: 'COM1', friendlyName: '(预览模式) 通信端口' }] }),
    winDetectTools: async () => ({
      ok: true,
      tools: { platform: 'win32', mstsc: true, wsl: true, wslDistros: [], pwsh: false, gitBash: false, vncViewers: [] }
    }),
    winLaunchRdp: async () => ({ ok: false, error: '浏览器预览模式不可用，请在桌面应用中使用' }),
    winLaunchVnc: async () => ({ ok: false, error: '浏览器预览模式不可用，请在桌面应用中使用' }),
    tunnelStart: async () => ({ ok: false, error: '浏览器预览模式不可用' }),
    tunnelStop: async () => ({ ok: false }),
    tunnelList: async () => ({ ok: true, tunnels: [] }),
    hostKeysList: async () => ({ ok: true, entries: [] }),
    hostKeysRemove: async () => ({ ok: false }),
    diagExport: async () => ({ ok: false, error: '浏览器预览模式不可用' }),
    openLogDir: async () => ({ ok: false, error: '浏览器预览模式不可用' }),
    aiChat: async (payload) => {
      // Simple deterministic reply so UI can be tested without an API key
      const last = payload.messages[payload.messages.length - 1]?.content ?? '';
      const preview =
        '[浏览器预览模式 — 未连接 Electron]\n\n' +
        '针对你的问题：「' + last.slice(0, 40) + '」\n\n' +
        '本功能将在桌面应用中接入真实 AI 接口。\n' +
        '请安装依赖后运行 npm run dev 启动 Electron 体验完整功能。\n\n' +
        '```\necho "hello from NebulaX"\n```\n' +
        '命令需经确认后才会执行。';
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, reply: preview };
    },
    aiConfigGet: async () => ({ ok: true, config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', temperature: 0.3, maxTokens: 2000 } }),
    aiConfigSet: async (config: any) => ({ ok: true, config }),
    aiUsage: async () => ({
      ok: true,
      usage: { today: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 }, daily: [], byModel: [] }
    }),
    sshAuditData: async () => ({
      ok: true,
      data: '=== AUDIT_SECTION: SSH_CONFIG ===\nPermitRootLogin yes\nPasswordAuthentication yes\n\n=== AUDIT_SECTION: SUID_BINARIES ===\n/usr/bin/passwd\n/usr/bin/sudo\n'
    }),
    sshDiagnosticsBundle: async () => ({
      ok: true,
      bundle: {
        TOP: 'top output...',
        FREE: 'Mem: 15G 8G 7G',
        DF: '/dev/sda1 200G 87G 103G 46% /',
        DMESG_OOM: 'Out of memory: Kill process 1234',
        JOURNAL_ERRORS: 'systemd: Service foo failed',
        PS_TOP_MEM: 'java 8.2G',
        NETWORK: 'LISTEN 0 128 0.0.0.0:22',
        SYSTEMD_FAILED: 'foo.service failed'
      }
    }),
    sshMetricsSnapshot: async () => ({
      ok: true,
      snapshot: {
        ts: Date.now(),
        hostname: 'web-preview-host',
        cpuPercent: 35,
        memPercent: 48,
        disk: [{ mount: '/', usePercent: 46, availGB: 103 }],
        load1: 0.32,
        connections: 42
      }
    }),
    aiAudit: async () => ({
      ok: true,
      result: {
        summary: '[预览模式] 发现 2 个安全风险',
        score: 68,
        findings: [
          {
            severity: 'high',
            category: 'SSH',
            title: 'SSH 允许 root 登录',
            description: 'sshd_config 中 PermitRootLogin yes，攻击者可暴力破解 root 密码',
            evidence: 'PermitRootLogin yes',
            remediation: '改为 prohibit-password 或 no',
            command: "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && systemctl restart sshd"
          },
          {
            severity: 'medium',
            category: '密码安全',
            title: 'SSH 允许密码认证',
            description: 'PasswordAuthentication yes 会暴露给暴力破解',
            evidence: 'PasswordAuthentication yes',
            remediation: '建议改用密钥认证',
            command: "sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl restart sshd"
          }
        ],
        scannedAt: Date.now()
      }
    }),
    aiPlanDiagnostic: async (payload: any) => ({
      ok: true,
      steps: [
        { id: 's1', command: 'free -h', purpose: '查看内存使用', status: 'pending' },
        { id: 's2', command: 'dmesg | tail -50', purpose: '查看内核消息 / OOM', status: 'pending' },
        { id: 's3', command: 'ps aux --sort=-%mem | head', purpose: '找出内存大户', status: 'pending' },
        { id: 's4', command: 'journalctl -p err -n 50 --no-pager', purpose: '查看系统错误日志', status: 'pending' }
      ]
    }),
    aiAnalyzeDiagnostic: async () => ({
      ok: true,
      report: {
        incident: '[预览模式] 服务器响应慢',
        summary: '疑似内存压力导致 swap 频繁，建议清理高内存进程',
        rootCauses: [
          {
            hypothesis: 'Java 应用占用过多内存',
            confidence: 'high',
            evidence: ['ps aux 显示 java 占用 8.2G', 'free 显示可用仅 500MB'],
            impact: '系统 swap 抖动，应用响应延迟',
            fixCommand: 'systemctl restart java-app',
            fixDescription: '重启 Java 应用释放内存'
          }
        ],
        nextActions: ['监控内存 5 分钟', '排查 Java 内存泄漏'],
        allClear: false
      }
    }),
    aiForecast: async () => ({
      ok: true,
      result: {
        overallRisk: 'medium',
        alerts: [
          {
            resource: '磁盘 /var',
            severity: 'warning',
            daysToFull: 12,
            currentPercent: 72,
            threshold: 85,
            suggestion: '清理 journald 旧日志',
            command: 'journalctl --vacuum-time=7d'
          }
        ],
        insights: ['磁盘 /var 日均增长 1.2G', '内存使用稳定']
      }
    }),
    aiGenScript: async () => ({
      ok: true,
      script: {
        title: 'MySQL 每日备份脚本',
        description: '每日备份 mysql 到 /backup 并清理 7 天前的备份',
        bash: '#!/usr/bin/env bash\nset -euo pipefail\n\nBACKUP_DIR="/backup"\nRETENTION_DAYS=7\n\nlog() { echo "[$(date "+%Y-%m-%d %H:%M:%S")] $*"; }\n\nlog "Starting backup..."\nmkdir -p "$BACKUP_DIR"\ndump_file="$BACKUP_DIR/mysql-$(date +%F).sql.gz"\nmysqldump --all-databases | gzip > "$dump_file"\nlog "Backup done: $dump_file"\n\nfind "$BACKUP_DIR" -name "mysql-*.sql.gz" -mtime +$RETENTION_DAYS -delete\nlog "Cleanup done."',
        cron: '0 3 * * * /opt/scripts/mysql-backup.sh >> /var/log/mysql-backup.log 2>&1',
        deployCommands: [
          'mkdir -p /opt/scripts',
          'nano /opt/scripts/mysql-backup.sh  # 粘贴脚本',
          'chmod +x /opt/scripts/mysql-backup.sh',
          '(crontab -l 2>/dev/null; echo "0 3 * * * /opt/scripts/mysql-backup.sh") | crontab -'
        ],
        safetyNotes: ['mysqldump 需要 my.cnf 配置认证', '请先在测试环境验证脚本', '备份文件包含敏感数据，注意目录权限']
      }
    }),
    forecastLinear: async (payload: any) => ({ ok: true, days: 12.5 }),
    aiScenarios: async () => ({ ok: true, scenarios: [], labels: {} }),
    aiRoutingGet: async () => ({
      ok: true,
      routing: { enabled: false, rules: {} },
      taskLabels: { chat: '日常问答', diagnose: '故障诊断', audit: '安全审计', script: '脚本生成', forecast: '容量预测', db: '数据库诊断', perf: '性能调优' }
    }),
    aiRoutingSet: async (routing) => ({ ok: true, routing }),
    aiDbDiagnose: async () => ({ ok: false, error: '浏览器预览模式不可用' }),
    aiPerfAnalyze: async () => ({ ok: false, error: '浏览器预览模式不可用' }),
    patrolGetConfig: async () => ({
      ok: true,
      config: {
        enabled: false,
        intervalMinutes: 30,
        thresholds: { cpu: 85, mem: 90, disk: 90 },
        notify: true,
        autoDiagnose: true,
        autoReport: false,
        trendWarnDays: 3
      }
    }),
    patrolSetConfig: async (config) => ({ ok: true, config }),
    patrolRunNow: async () => ({ ok: false, error: '浏览器预览模式不可用' }),
    patrolExportReport: async () => ({ ok: false, error: '浏览器预览模式不可用' }),
    patrolOpenReports: async () => ({ ok: false, error: '浏览器预览模式不可用' }),
    patrolLastReport: async () => ({ ok: true, report: '', results: [] }),
    onPatrolResult: () => () => {},
    onPatrolAiDiagnosis: () => () => {},
    ragAdd: async (payload: any) => ({
      ok: true,
      doc: {
        id: 'preview-doc',
        title: payload.title,
        filename: payload.filename,
        content: payload.content,
        tokens: [],
        addedAt: Date.now()
      }
    }),
    ragList: async () => ({
      ok: true,
      docs: [
        {
          id: 'preview-doc',
          title: '线上故障处理 SOP',
          filename: 'sop-incident.md',
          content: '# 线上故障处理 SOP\n1. 立即隔离故障机\n2. 通知 SRE\n3. 查看监控\n...',
          tokens: [],
          addedAt: Date.now()
        }
      ]
    }),
    ragRemove: async () => ({ ok: true }),
    ragRetrieve: async () => ({
      ok: true,
      results: [
        {
          doc: {
            id: 'preview-doc',
            title: '线上故障处理 SOP',
            content: '# SOP',
            tokens: [],
            addedAt: Date.now(),
            filename: 'sop.md'
          },
          score: 0.75,
          excerpt: '# 线上故障处理 SOP\n1. 立即隔离故障机\n2. 通知 SRE\n3. 查看监控'
        }
      ]
    }),
    ragContext: async () => ({ ok: true, context: '【检索到 SOP】1. 立即隔离故障机 2. 通知 SRE' }),
    ragRestoreBuiltin: async () => ({ ok: true, added: 0, total: 0 }),
    ragBuiltinStats: async () => ({ ok: true, total: 85, present: 85 }),

    // 许可激活（mock：恒为试用中）
    licenseState: async () => ({
      ok: true,
      state: { status: 'trial', machineCode: 'MOCK-DEMO-1234-5678-9ABC-DEF0-1234-5678', trialDaysLeft: 14, license: null },
    }),
    licenseActivate: async () => ({ ok: false, error: 'mock 模式不支持激活' }),
    licenseDeactivate: async () => ({ ok: true }),
    vaultStatus: async () => ({ ok: true, available: true }),
    vaultSet: async () => ({ ok: true }),
    vaultGet: async () => ({ ok: true, secrets: {} }),
    vaultDelete: async () => ({ ok: true }),
    clipboardRead: async () => {
      try {
        return { ok: true, text: await navigator.clipboard.readText() };
      } catch {
        return { ok: false, error: '读取剪贴板失败' };
      }
    },
    clipboardWrite: async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        return { ok: true };
      } catch {
        return { ok: false, error: '写入剪贴板失败' };
      }
    },
    sftpList: async () => ({
      ok: true,
      files: [
        { name: '.', path: '.', isDir: true, size: 0, modifyTime: Date.now(), mode: 0o755 },
        { name: '..', path: '..', isDir: true, size: 0, modifyTime: Date.now(), mode: 0o755 },
        { name: 'etc', path: '/etc', isDir: true, size: 4096, modifyTime: Date.now(), mode: 0o755 },
        { name: 'var', path: '/var', isDir: true, size: 4096, modifyTime: Date.now(), mode: 0o755 },
        { name: 'README.md', path: '/README.md', isDir: false, size: 1234, modifyTime: Date.now(), mode: 0o644 }
      ]
    }),
    sftpStat: async () => ({ ok: true, file: { name: 'file', path: '/file', isDir: false, size: 0, modifyTime: Date.now(), mode: 0o644 } }),
    sftpMkdir: async () => ({ ok: true }),
    sftpRmdir: async () => ({ ok: true }),
    sftpUnlink: async () => ({ ok: true }),
    sftpRename: async () => ({ ok: true }),
    sftpUpload: async () => ({ ok: true }),
    sftpDownload: async () => ({ ok: true }),
    sftpCancel: async () => ({ ok: true }),
    dbQuery: async () => ({ ok: false, error: 'mock' }),
    dbTest: async () => ({ ok: false, error: 'mock' }),
    onSftpProgress: () => () => {},
    localList: async () => ({ ok: true, files: [], path: '~' }),
    localPickFile: async () => ({ ok: true, path: '/tmp/file' }),
    localPickDir: async () => ({ ok: true, path: '~' }),
    localMkdir: async () => ({ ok: true }),
    localDelete: async () => ({ ok: true }),
    localRename: async () => ({ ok: true }),
    localHome: async () => ({ ok: true, path: '~' }),
    getFilePath: () => '',
    winMinimize: () => {},
    winMaximize: () => {},
    winClose: () => {},
    onSshData: () => () => {},
    onSshClose: () => () => {},
    onSshError: () => () => {},
    onSshReconnecting: () => () => {},
    onSshReconnected: () => () => {}
  };
}
