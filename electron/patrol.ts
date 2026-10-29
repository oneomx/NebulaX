/**
 * 定时巡检与主动预警（v1.4）
 * - 纯逻辑部分（阈值评估 / 报告生成）可单测
 * - 配置落盘 ~/.nebula-ssh/patrol-config.json
 * - 调度与系统通知在 main.ts（需要 Electron 运行时）
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MetricSnapshot } from './ai/forecast';
import { predictDaysToFull } from './ai/forecast';

const CONFIG_FILE = process.env.NEBULA_PATROL_CONFIG || path.join(os.homedir(), '.nebula-ssh', 'patrol-config.json');

export interface PatrolThresholds {
  /** CPU 使用率 % */
  cpu: number;
  /** 内存使用率 % */
  mem: number;
  /** 磁盘使用率 % */
  disk: number;
}

export interface PatrolConfig {
  enabled: boolean;
  /** 巡检间隔（分钟，5~1440） */
  intervalMinutes: number;
  thresholds: PatrolThresholds;
  /** 超阈值时发系统通知 */
  notify: boolean;
  /** 告警时自动生成诊断步骤（本地规则，无需 AI） */
  autoDiagnose: boolean;
  /** 每轮巡检后自动生成报告文件（~/.nebula-ssh/reports/） */
  autoReport: boolean;
  /** 趋势提前预警窗口（天，1~30；0=关闭） */
  trendWarnDays: number;
}

export function defaultPatrolConfig(): PatrolConfig {
  return {
    enabled: false,
    intervalMinutes: 30,
    thresholds: { cpu: 85, mem: 90, disk: 90 },
    notify: true,
    autoDiagnose: true,
    autoReport: false,
    trendWarnDays: 3
  };
}

export function loadPatrolConfig(): PatrolConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const def = defaultPatrolConfig();
      return {
        enabled: !!parsed.enabled,
        intervalMinutes: clampInterval(parsed.intervalMinutes, def.intervalMinutes),
        thresholds: {
          cpu: numOr(parsed.thresholds?.cpu, def.thresholds.cpu),
          mem: numOr(parsed.thresholds?.mem, def.thresholds.mem),
          disk: numOr(parsed.thresholds?.disk, def.thresholds.disk)
        },
        notify: parsed.notify !== false,
        autoDiagnose: parsed.autoDiagnose !== false,
        autoReport: !!parsed.autoReport,
        trendWarnDays: clampTrendDays(parsed.trendWarnDays, def.trendWarnDays)
      };
    }
  } catch {
    /* corrupted -> default */
  }
  return defaultPatrolConfig();
}

export function savePatrolConfig(cfg: PatrolConfig): PatrolConfig {
  const clean: PatrolConfig = {
    enabled: !!cfg.enabled,
    intervalMinutes: clampInterval(cfg.intervalMinutes, 30),
    thresholds: {
      cpu: numOr(cfg.thresholds?.cpu, 85),
      mem: numOr(cfg.thresholds?.mem, 90),
      disk: numOr(cfg.thresholds?.disk, 90)
    },
    notify: cfg.notify !== false,
    autoDiagnose: cfg.autoDiagnose !== false,
    autoReport: !!cfg.autoReport,
    trendWarnDays: clampTrendDays(cfg.trendWarnDays, 3)
  };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), { encoding: 'utf8', mode: 0o600 });
  return clean;
}

function numOr(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

function clampInterval(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 5 && n <= 1440 ? Math.floor(n) : fallback;
}

function clampTrendDays(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 0 && n <= 30 ? Math.floor(n) : fallback;
}

export interface PatrolAlert {
  resource: 'cpu' | 'mem' | 'disk';
  severity: 'warning' | 'critical';
  currentPercent: number;
  threshold: number;
  /** 磁盘告警时为挂载点 */
  mount?: string;
  suggestion: string;
  command?: string;
}

export interface PatrolTrendAlert {
  resource: 'cpu' | 'mem' | 'disk';
  mount?: string;
  /** 预计触顶天数（线性回归）；当前值已超阈值时为 0 */
  daysToFull: number | null;
  currentPercent: number;
  threshold: number;
  suggestion: string;
}

/** 评估一次快照，返回超阈值告警（纯函数，可单测）。
 * 建议命令按远端 OS 分派：Windows 给 PowerShell 等价命令，Linux 给原命令。 */
export function evaluateSnapshot(snap: MetricSnapshot, th: PatrolThresholds): PatrolAlert[] {
  const alerts: PatrolAlert[] = [];
  const isWin = snap.os === 'windows';

  if (snap.cpuPercent >= th.cpu) {
    alerts.push({
      resource: 'cpu',
      severity: snap.cpuPercent >= 95 ? 'critical' : 'warning',
      currentPercent: round1(snap.cpuPercent),
      threshold: th.cpu,
      suggestion: isWin
        ? '定位高 CPU 进程（Get-Process 按 CPU 排序），确认是否预期负载。'
        : '定位高 CPU 进程：top -o %CPU，确认是否预期负载。',
      command: isWin
        ? 'powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 | Format-Table Id,CPU,ProcessName"'
        : 'top -bn1 -o %CPU | head -15'
    });
  }
  if (snap.memPercent >= th.mem) {
    alerts.push({
      resource: 'mem',
      severity: snap.memPercent >= 95 ? 'critical' : 'warning',
      currentPercent: round1(snap.memPercent),
      threshold: th.mem,
      suggestion: '查看内存大户并评估是否需要重启服务或扩容。',
      command: isWin
        ? 'powershell -NoProfile -Command "Get-Process | Sort-Object WS -Descending | Select-Object -First 10 | Format-Table Id,@{N=\'MB\';E={[int]($_.WS/1MB)}},ProcessName"'
        : 'ps aux --sort=-%mem | head -10'
    });
  }
  for (const d of snap.disk || []) {
    if (d.usePercent >= th.disk) {
      const critical = d.usePercent >= 95;
      alerts.push({
        resource: 'disk',
        severity: critical ? 'critical' : 'warning',
        currentPercent: d.usePercent,
        threshold: th.disk,
        mount: d.mount,
        suggestion: critical
          ? '磁盘即将写满，立即清理大文件/日志，必要时扩容。'
          : '排查大文件并清理日志/缓存。',
        command: isWin
          ? `powershell -NoProfile -Command "Get-ChildItem '${d.mount}\\' -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 10 Name,@{N='GB';E={[math]::Round($_.Length/1GB,2)}}"`
          : `du -xsh ${d.mount}/* 2>/dev/null | sort -rh | head -10`
      });
    }
  }
  return alerts;
}

/**
 * 趋势提前预警（纯函数，可单测）：对同一主机的历史快照做线性回归，
 * 在指标**尚未超阈值**但按趋势将于 warnDays 内触顶时提前发出预警。
 * 已超阈值的项交给 evaluateSnapshot（避免重复告警）。
 * @param history 该主机最近 N 次快照（时间升序）
 * @param th 当前巡检阈值
 * @param intervalMinutes 采样间隔（巡检间隔）
 * @param warnDays 预警窗口（默认 3 天）
 */
export function evaluateTrend(
  history: MetricSnapshot[],
  th: PatrolThresholds,
  intervalMinutes: number,
  warnDays = 3
): PatrolTrendAlert[] {
  if (history.length < 4) return []; // 样本太少，回归不可信
  const out: PatrolTrendAlert[] = [];
  const last = history[history.length - 1];

  // 资源序列：CPU/内存整体使用率 + 各挂载点磁盘使用率
  const series: { resource: 'cpu' | 'mem' | 'disk'; mount?: string; points: number[]; threshold: number }[] = [
    { resource: 'cpu', points: history.map((s) => s.cpuPercent), threshold: th.cpu },
    { resource: 'mem', points: history.map((s) => s.memPercent), threshold: th.mem }
  ];
  for (const d of last.disk || []) {
    series.push({
      resource: 'disk',
      mount: d.mount,
      points: history.map((s) => (s.disk || []).find((x) => x.mount === d.mount)?.usePercent ?? 0),
      threshold: th.disk
    });
  }

  for (const item of series) {
    const current = item.points[item.points.length - 1];
    if (current >= item.threshold) continue; // 已超阈值 → 常规告警负责，不重复
    const days = predictDaysToFull(item.points, intervalMinutes, item.threshold);
    if (days === null || days > warnDays || days <= 0) continue;
    out.push({
      resource: item.resource,
      mount: item.mount,
      daysToFull: round1(days),
      currentPercent: round1(current),
      threshold: item.threshold,
      suggestion:
        item.resource === 'disk'
          ? `按当前增长趋势约 ${round1(days)} 天后达到 ${item.threshold}%，建议提前清理或扩容。`
          : item.resource === 'mem'
          ? `内存呈持续上涨趋势，约 ${round1(days)} 天后触顶，建议排查缓慢泄漏。`
          : `CPU 呈持续上涨趋势，约 ${round1(days)} 天后触顶，建议关注新增负载。`
    });
  }
  return out;
}

/** 自动诊断步骤（告警触发，无需 AI 即可生成的基础采集清单） */
export interface AutoDiagStep {
  command: string;
  purpose: string;
}

/**
 * 按告警项生成基础诊断步骤（纯函数，可单测）。
 * 覆盖 CPU/内存/磁盘 × Linux/Windows，作为 AI 诊断 Agent 的降级路径：
 * 未配置 AI key 时巡检告警也能给出可执行的排查命令。
 */
export function buildAutoDiagSteps(alerts: PatrolAlert[], osType?: 'linux' | 'windows'): AutoDiagStep[] {
  const isWin = osType === 'windows';
  const steps: AutoDiagStep[] = [];
  const has = (r: string) => alerts.some((a) => a.resource === r);

  if (has('cpu')) {
    steps.push(
      isWin
        ? {
            command: 'powershell -NoProfile -Command "Get-Counter \'\\Processor(_Total)\\% Processor Time\' -SampleInterval 5 -MaxSamples 3 | ForEach-Object { $_.CounterSamples.CookedValue }"',
            purpose: '连续采样 CPU 使用率，确认是持续高负载还是瞬时尖峰'
          }
        : { command: 'top -bn3 -d 2 -o %CPU | grep -E "^%Cpu|load average" | head -6', purpose: '连续采样 CPU 使用率与负载，确认是持续高负载还是瞬时尖峰' },
      isWin
        ? { command: 'powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Id,CPU,ProcessName | Format-Table -AutoSize"', purpose: '列出累计 CPU 时间最高的进程' }
        : { command: 'ps -eo pid,ppid,cmd,%cpu,%mem --sort=-%cpu | head -12', purpose: '列出 CPU 占用最高的进程' }
    );
  }
  if (has('mem')) {
    steps.push(
      isWin
        ? { command: 'powershell -NoProfile -Command "Get-Process | Sort-Object WS -Descending | Select-Object -First 10 Id,@{N=\'MB\';E={[int]($_.WS/1MB)}},ProcessName | Format-Table -AutoSize"', purpose: '列出内存占用最高的进程' }
        : { command: 'ps -eo pid,ppid,cmd,%mem,rss --sort=-%mem | head -12', purpose: '列出内存占用最高的进程' },
      isWin
        ? { command: 'powershell -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | ForEach-Object { \'FreeMB=\' + [int]($_.FreePhysicalMemory/1KB) + \' TotalMB=\' + [int]($_.TotalVisibleMemorySize/1KB) }"', purpose: '查看物理内存总量与剩余' }
        : { command: 'free -h && cat /proc/meminfo | grep -E "MemTotal|MemAvailable|SwapTotal|SwapFree|Dirty"', purpose: '查看内存/交换分区明细与脏页堆积' }
    );
  }
  if (has('disk')) {
    for (const a of alerts.filter((x) => x.resource === 'disk')) {
      const mount = a.mount || '/';
      steps.push(
        isWin
          ? { command: `powershell -NoProfile -Command "Get-ChildItem '${mount}\\' -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 15 Name,@{N='GB';E={[math]::Round($_.Length/1GB,2)}} | Format-Table -AutoSize"`, purpose: `列出 ${mount} 下最大的文件/目录` }
          : { command: `du -xsh ${mount}/* 2>/dev/null | sort -rh | head -15`, purpose: `列出 ${mount} 下最大的目录` },
        isWin
          ? { command: 'powershell -NoProfile -Command "Get-ChildItem C:\\Windows\\Logs C:\\Windows\\Temp -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 100MB } | Sort-Object Length -Descending | Select-Object -First 10 FullName,@{N=\'GB\';E={[math]::Round($_.Length/1GB,2)}} | Format-Table -AutoSize"', purpose: '排查系统日志/临时目录中的超大文件' }
          : { command: `find ${mount} -xdev -type f -size +500M -exec ls -lh {} \\; 2>/dev/null | head -10`, purpose: `查找 ${mount} 内超过 500M 的大文件` }
      );
    }
  }
  return steps;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface PatrolHostResult {
  host: string;
  ok: boolean;
  error?: string;
  snapshot?: MetricSnapshot;
  alerts: PatrolAlert[];
  /** 趋势提前预警（未超阈值但按趋势将触顶） */
  trendAlerts?: PatrolTrendAlert[];
  /** 告警自动触发的基础诊断步骤（本地生成，无需 AI） */
  autoDiagSteps?: AutoDiagStep[];
}

/** 生成巡检报告（markdown 文本） */
export function formatPatrolReport(results: PatrolHostResult[], startedAt: Date): string {
  const lines: string[] = [];
  const totalAlerts = results.reduce((n, r) => n + r.alerts.length, 0);
  const criticals = results.reduce((n, r) => n + r.alerts.filter((a) => a.severity === 'critical').length, 0);
  const totalTrends = results.reduce((n, r) => n + (r.trendAlerts?.length || 0), 0);
  lines.push(`# 巡检报告 ${startedAt.toLocaleString('zh-CN')}`);
  lines.push('');
  lines.push(`- 巡检主机：${results.length} 台`);
  lines.push(`- 异常项：${totalAlerts}（严重 ${criticals}）`);
  if (totalTrends > 0) lines.push(`- 趋势预警：${totalTrends}（未超阈值但按趋势将触顶）`);
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.host}`);
    if (!r.ok) {
      lines.push(`- ❌ 巡检失败：${r.error || '未知错误'}`);
      lines.push('');
      continue;
    }
    const s = r.snapshot!;
    lines.push(`- CPU ${round1(s.cpuPercent)}% · 内存 ${round1(s.memPercent)}% · 负载 ${s.load1} · 连接数 ${s.connections}`);
    for (const d of s.disk || []) {
      lines.push(`- 磁盘 ${d.mount}：${d.usePercent}%（剩余 ${d.availGB}G）`);
    }
    if (r.alerts.length === 0 && !(r.trendAlerts && r.trendAlerts.length)) {
      lines.push('- ✅ 各项指标正常');
    } else {
      for (const a of r.alerts) {
        const tag = a.severity === 'critical' ? '🔴 严重' : '🟡 警告';
        const where = a.resource === 'disk' ? `磁盘 ${a.mount}` : a.resource.toUpperCase();
        lines.push(`- ${tag} ${where} ${a.currentPercent}%（阈值 ${a.threshold}%）—— ${a.suggestion}`);
        if (a.command) lines.push(`  \`${a.command}\``);
      }
      for (const t of r.trendAlerts || []) {
        const where = t.resource === 'disk' ? `磁盘 ${t.mount}` : t.resource.toUpperCase();
        lines.push(`- 🔵 趋势预警 ${where} 当前 ${t.currentPercent}%（阈值 ${t.threshold}%，预计 ${t.daysToFull} 天触顶）—— ${t.suggestion}`);
      }
    }
    if (r.autoDiagSteps && r.autoDiagSteps.length > 0) {
      lines.push('');
      lines.push('自动诊断步骤（告警触发，可直接执行）：');
      for (const st of r.autoDiagSteps) {
        lines.push(`- ${st.purpose}：\`${st.command}\``);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
