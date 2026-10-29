/**
 * 性能调优建议模块（v1.7）
 * 只读采集内核/网络/IO/文件句柄参数 → 本地规则给出确定性建议 →（可选）AI 补充。
 * 设计原则：**绝不自动修改任何参数**，只输出当前值/推荐值/风险说明 + 可复制命令，
 * 由用户确认后自行执行。
 */
import { chat, type ChatMessage } from '../../ai';
import { resolveRoute } from '../router';
import { chatJson, type FieldSpec } from '../schema';

export interface PerfItem {
  category: 'kernel' | 'network' | 'io' | 'limits' | 'service';
  /** 参数名（如 net.core.somaxconn） */
  name: string;
  /** 当前值 */
  currentValue: string;
  /** 推荐值（为空表示当前值已合理） */
  recommended?: string;
  /** 说明（为什么这样推荐 / 风险） */
  reason: string;
  /** 一键设置命令（sysctl -w / echo 配置），仅建议展示 */
  command?: string;
  /** 当前值是否符合推荐 */
  ok: boolean;
  severity: 'info' | 'warning' | 'critical';
}

export interface PerfReport {
  os: 'linux' | 'windows';
  items: PerfItem[];
  summary: string;
  /** 采集失败的项（不影响其余判断） */
  failed: string[];
  degraded?: boolean;
}

export interface CollectItem {
  id: string;
  label: string;
  /** 只读采集命令（Linux/Windows 分派由调用方处理或直接给 shell） */
  command: string;
  timeoutMs?: number;
}

/** Linux 只读采集命令集（全部只读，无副作用） */
export const LINUX_COLLECT: CollectItem[] = [
  { id: 'sysctl-net', label: '网络内核参数', command: 'sysctl net.core.somaxconn net.core.netdev_max_backlog net.ipv4.tcp_max_syn_backlog net.ipv4.tcp_tw_reuse net.ipv4.tcp_fin_timeout net.ipv4.tcp_keepalive_time 2>/dev/null' },
  { id: 'sysctl-buf', label: 'TCP 缓冲区', command: 'sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem net.core.rmem_max net.core.wmem_max 2>/dev/null' },
  { id: 'sysctl-vm', label: '内存管理参数', command: 'sysctl vm.swappiness vm.dirty_ratio vm.dirty_background_ratio vm.overcommit_memory 2>/dev/null' },
  { id: 'limits', label: '文件句柄限制', command: 'sysctl fs.file-max fs.nr_open 2>/dev/null; ulimit -n; cat /proc/sys/fs/file-nr 2>/dev/null' },
  { id: 'sched', label: 'IO 调度器', command: 'for d in /sys/block/*/queue/scheduler; do echo "$d: $(cat $d 2>/dev/null)"; done 2>/dev/null | head -5' },
  { id: 'load', label: '负载与 CPU', command: 'nproc; uptime; cat /proc/loadavg' },
  { id: 'sockstat', label: 'socket 统计', command: 'cat /proc/net/sockstat 2>/dev/null; ss -s 2>/dev/null | head -5' },
  { id: 'mtu', label: '网卡与 MTU', command: 'ip -br a 2>/dev/null | head -5; for i in $(ls /sys/class/net 2>/dev/null | head -3); do echo "$i mtu=$(cat /sys/class/net/$i/mtu 2>/dev/null) speed=$(cat /sys/class/net/$i/speed 2>/dev/null)Mbps"; done' }
];

/** Windows 只读采集命令集（PowerShell，经 psCommand 编码执行） */
export const WINDOWS_COLLECT: CollectItem[] = [
  { id: 'netsh', label: 'TCP 参数', command: 'powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; netsh int tcp show global; netsh int tcp show supplemental" ' },
  { id: 'mem', label: '内存与页面文件', command: 'powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_OperatingSystem | ForEach-Object { \'FreeMB=\' + [int]($_.FreePhysicalMemory/1KB) + \' TotalMB=\' + [int]($_.TotalVisibleMemorySize/1KB) + \' VirtualMB=\' + [int]($_.TotalVirtualMemorySize/1KB) }" ' },
  { id: 'proc', label: '进程与句柄', command: 'powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Process | Measure-Object -Property HandleCount -Sum | ForEach-Object { \'TotalHandles=\' + $_.Sum }; (Get-Process).Count" ' },
  { id: 'power', label: '电源与性能计划', command: 'powershell -NoProfile -Command "powercfg /getactivescheme" ' },
  { id: 'service', label: '关键服务状态', command: 'powershell -NoProfile -Command "Get-Service WinDefend,wuauserv,Spooler | Format-Table Name,Status,StartType -AutoSize | Out-String" ' }
];

export function collectItems(os: 'linux' | 'windows'): CollectItem[] {
  return os === 'windows' ? WINDOWS_COLLECT : LINUX_COLLECT;
}

function num(v: unknown): number {
  const n = parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : NaN;
}

/** 从 sysctl 风格输出（key: value）提取值 */
function sysctlVal(text: string, key: string): number | null {
  const m = new RegExp(`^${key.replace(/\./g, '\\.')}\\s*[=:]\\s*(.+)$`, 'm').exec(text);
  if (!m) return null;
  const v = num(m[1].split(/\s+/)[0]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Linux 本地规则诊断（纯函数，可单测）：根据采集输出给出确定性调优建议。
 * @param collected id → 输出文本 的映射
 */
export function analyzeLinuxLocal(collected: Record<string, string>): PerfItem[] {
  const items: PerfItem[] = [];
  const all = Object.values(collected).join('\n');
  const get = (id: string) => collected[id] || '';

  // ---- 连接队列 ----
  const somax = sysctlVal(get('sysctl-net'), 'net.core.somaxconn');
  if (somax !== null) {
    const ok = somax >= 1024;
    items.push({
      category: 'network',
      name: 'net.core.somaxconn',
      currentValue: String(somax),
      recommended: ok ? undefined : '4096 或更高',
      reason: ok
        ? '监听队列上限充足，适合高并发 accept。'
        : '过小会在高并发时丢弃连接（表现为偶发 502/连接重置），Web/网关服务器建议 ≥4096。',
      command: ok ? undefined : 'sudo sysctl -w net.core.somaxconn=4096 && echo "net.core.somaxconn = 4096" | sudo tee -a /etc/sysctl.d/99-nebula.conf',
      ok,
      severity: ok ? 'info' : 'warning'
    });
  }
  const finTo = sysctlVal(get('sysctl-net'), 'net.ipv4.tcp_fin_timeout');
  if (finTo !== null) {
    const ok = finTo <= 30;
    items.push({
      category: 'network',
      name: 'net.ipv4.tcp_fin_timeout',
      currentValue: String(finTo),
      recommended: ok ? undefined : '15-30 秒',
      reason: ok ? 'FIN_WAIT 超时合理。' : '默认 60s 会让 FIN_WAIT_2 堆积，占满连接数。降低可加速连接回收（注意不影响长连接业务）。',
      command: ok ? undefined : 'sudo sysctl -w net.ipv4.tcp_fin_timeout=30',
      ok,
      severity: ok ? 'info' : 'warning'
    });
  }
  const tw = sysctlVal(get('sysctl-net'), 'net.ipv4.tcp_tw_reuse');
  if (tw !== null && tw === 0) {
    items.push({
      category: 'network',
      name: 'net.ipv4.tcp_tw_reuse',
      currentValue: '0',
      recommended: '1',
      reason: '高并发短连接场景 TIME_WAIT 会耗尽本地端口；启用复用可缓解（仅对出站连接生效，安全）。',
      command: 'sudo sysctl -w net.ipv4.tcp_tw_reuse=1',
      ok: false,
      severity: 'warning'
    });
  }

  // ---- TCP 缓冲区 ----
  const rmem = get('sysctl-buf');
  const wmem = sysctlVal(rmem, 'net.ipv4.tcp_wmem');
  if (wmem !== null) {
    const parts = rmem.split('\n').find((l) => l.includes('tcp_wmem')) || '';
    const vals = (parts.match(/[\d.]+/g) || []).map(num);
    const maxBuf = vals.length >= 3 ? vals[2] : NaN;
    const ok = Number.isFinite(maxBuf) && maxBuf >= 4096 * 16; // ≥64KB
    if (Number.isFinite(maxBuf)) {
      items.push({
        category: 'network',
        name: 'net.ipv4.tcp_wmem（max）',
        currentValue: `${(maxBuf / 1024).toFixed(0)} KB`,
        recommended: ok ? undefined : '≥ 4 MB（高带宽长连接）',
        reason: ok ? 'TCP 写缓冲上限足够。' : '带宽时延积大的链路（跨境/高带宽）缓冲过小会限制吞吐。',
        command: ok ? undefined : 'sudo sysctl -w net.ipv4.tcp_wmem="4096 16384 4194304"',
        ok,
        severity: ok ? 'info' : 'warning'
      });
    }
  }

  // ---- 内存 ----
  const swappiness = sysctlVal(get('sysctl-vm'), 'vm.swappiness');
  if (swappiness !== null) {
    // 数据库/内存型服务建议低 swappiness；通用服务 10-30 合理
    const ok = swappiness <= 30;
    items.push({
      category: 'kernel',
      name: 'vm.swappiness',
      currentValue: String(swappiness),
      recommended: ok ? undefined : '10-30',
      reason: ok
        ? '换出积极性适中，减少不必要的 swap 抖动。'
        : '值过高会过早把页换出到 swap，导致内存型应用（DB/缓存）性能抖动。',
      command: ok ? undefined : 'sudo sysctl -w vm.swappiness=10',
      ok,
      severity: ok ? 'info' : 'warning'
    });
  }
  const dirty = sysctlVal(get('sysctl-vm'), 'vm.dirty_ratio');
  if (dirty !== null) {
    const ok = dirty <= 20;
    items.push({
      category: 'io',
      name: 'vm.dirty_ratio',
      currentValue: String(dirty) + '%',
      recommended: ok ? undefined : '≤ 20%',
      reason: ok ? '脏页比例合理。' : '过高会在写入突发时堆积大量脏页，触发长时间刷盘阻塞进程（IO 卡顿）。',
      command: ok ? undefined : 'sudo sysctl -w vm.dirty_ratio=10',
      ok,
      severity: ok ? 'info' : 'warning'
    });
  }

  // ---- 文件句柄 ----
  const fileMax = sysctlVal(get('limits'), 'fs.file-max');
  const ulimitLine = get('limits').split('\n').find((l) => /^\d+$/.test(l.trim()));
  const ulimitN = ulimitLine ? num(ulimitLine.trim()) : NaN;
  if (Number.isFinite(ulimitN)) {
    const ok = ulimitN >= 65535;
    items.push({
      category: 'limits',
      name: 'ulimit -n（进程文件句柄）',
      currentValue: String(ulimitN),
      recommended: ok ? undefined : '65535+',
      reason: ok ? '句柄上限充足。' : '过低会在高并发时出现 too many open files，建议调整 /etc/security/limits.conf 与 systemd LimitNOFILE。',
      command: ok ? undefined : '# /etc/security/limits.conf\n* soft nofile 65535\n* hard nofile 65535\n# systemd 服务加：LimitNOFILE=65535',
      ok,
      severity: ok ? 'info' : 'critical'
    });
  }
  if (fileMax !== null) {
    const ok = fileMax >= 1000000;
    items.push({
      category: 'limits',
      name: 'fs.file-max（系统总句柄）',
      currentValue: String(fileMax),
      recommended: ok ? undefined : '≥ 1000000',
      reason: ok ? '系统级句柄上限充足。' : '系统总量过低会在多服务并发时耗尽。',
      command: ok ? undefined : 'sudo sysctl -w fs.file-max=1000000',
      ok,
      severity: ok ? 'info' : 'warning'
    });
  }

  // ---- 负载 ----
  const loadavg = get('load');
  const loadMatch = /load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(loadavg);
  const nprocLine = get('load').split('\n').find((l) => /^\d+$/.test(l.trim()));
  const cores = nprocLine ? num(nprocLine.trim()) : NaN;
  if (loadMatch && Number.isFinite(cores) && cores > 0) {
    const load1 = num(loadMatch[1]);
    const ratio = load1 / cores;
    if (ratio >= 1) {
      items.push({
        category: 'kernel',
        name: 'load average / CPU 核数',
        currentValue: `${load1} / ${cores} 核（${(ratio * 100).toFixed(0)}%）`,
        recommended: '< 0.7 × 核数',
        reason: ratio >= 2 ? '负载超过核数 2 倍，进程大量排队，需立即排查 CPU 大户。' : '负载偏高，接近或超过核数，响应延迟将增大。',
        command: 'top -bn1 | head -15; ps -eo pid,cmd,%cpu --sort=-%cpu | head -10',
        ok: false,
        severity: ratio >= 2 ? 'critical' : 'warning'
      });
    }
  }

  // ---- IO 调度器 ----
  const sched = get('sched');
  if (sched) {
    const hasNone = sched.includes('[none]');
    const hasNvme = sched.includes('nvme');
    // SSD/NVMe 用 none/noop 合理；HDD 用 mq-deadline 合理——这里只提示不误报
    if (hasNone && !hasNvme) {
      items.push({
        category: 'io',
        name: 'IO 调度器',
        currentValue: 'none',
        recommended: 'SSD 可保持 none；机械盘建议 mq-deadline',
        reason: '调度器 none 适合 SSD；若为机械硬盘，mq-deadline 能减少寻道抖动。',
        ok: true,
        severity: 'info'
      });
    }
  }

  // ---- socket 统计（诊断性信息）----
  const sock = get('sockstat');
  if (sock) {
    const orphans = /orphans:\s*(\d+)/.exec(sock);
    if (orphans && num(orphans[1]) > 10000) {
      items.push({
        category: 'network',
        name: '孤儿 socket 数',
        currentValue: orphans[1],
        recommended: '< 10000',
        reason: '孤儿 socket 过多通常意味着应用异常退出连接未回收，或存在连接泄漏。',
        ok: false,
        severity: 'warning'
      });
    }
  }

  return items;
}

/**
 * Windows 本地规则诊断（纯函数）：netsh/内存/进程句柄输出。
 */
export function analyzeWindowsLocal(collected: Record<string, string>): PerfItem[] {
  const items: PerfItem[] = [];
  const netsh = get2(collected, 'netsh');

  // TCP 模板/自动调优
  if (/Receive Window Auto-Tuning Level\s*:\s*disabled/i.test(netsh)) {
    items.push({
      category: 'network',
      name: 'TCP 窗口自动调优',
      currentValue: 'disabled',
      recommended: 'normal',
      reason: '禁用自动调优会限制高带宽链路吞吐（尤其长连接/大文件传输）。',
      command: 'netsh int tcp set global autotuninglevel=normal',
      ok: false,
      severity: 'warning'
    });
  }
  // RSS/RSC 提示
  if (/Receive-Side Scaling\s*:\s*disabled/i.test(netsh)) {
    items.push({
      category: 'network',
      name: 'RSS（接收端缩放）',
      currentValue: 'disabled',
      recommended: 'enabled',
      reason: '禁用 RSS 时网络中断集中在单核，高流量下 CPU 成瓶颈。',
      command: 'netsh int tcp set global rss=enabled',
      ok: false,
      severity: 'warning'
    });
  }

  // 内存
  const mem = get2(collected, 'mem');
  const freeMb = /FreeMB=(\d+)/.exec(mem);
  const totalMb = /TotalMB=(\d+)/.exec(mem);
  if (freeMb && totalMb) {
    const free = num(freeMb[1]);
    const total = num(totalMb[1]);
    const pct = (free / total) * 100;
    if (pct < 10) {
      items.push({
        category: 'kernel',
        name: '可用物理内存',
        currentValue: `${free}MB / ${total}MB（${pct.toFixed(1)}%）`,
        recommended: '≥ 10% 可用',
        reason: '可用内存低于 10%，系统会频繁使用页面文件，整体响应变慢。',
        command: 'Get-Process | Sort-Object WS -Descending | Select-Object -First 10 Name,@{N="MB";E={[int]($_.WS/1MB)}}',
        ok: false,
        severity: pct < 5 ? 'critical' : 'warning'
      });
    } else {
      items.push({
        category: 'kernel',
        name: '可用物理内存',
        currentValue: `${free}MB / ${total}MB（${pct.toFixed(1)}%）`,
        ok: true,
        severity: 'info',
        reason: '内存水位正常。'
      });
    }
  }

  // 电源计划
  const power = get2(collected, 'power');
  if (/节能/i.test(power) || /Power saver/i.test(power)) {
    items.push({
      category: 'service',
      name: '电源计划',
      currentValue: '节能/Power saver',
      recommended: '高性能/High performance',
      reason: '节能模式会限制 CPU 频率与 PCIe省电，服务器场景应使用高性能计划。',
      command: 'powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  // 高性能',
      ok: false,
      severity: 'warning'
    });
  } else if (power) {
    items.push({
      category: 'service',
      name: '电源计划',
      currentValue: power.trim().split('\n')[0].slice(0, 80),
      ok: true,
      severity: 'info',
      reason: '电源计划非节能模式。'
    });
  }

  return items;
}

function get2(m: Record<string, string>, k: string): string {
  return m[k] || '';
}

/** 采集输出超长时截断，控制发给 AI 的 token 量 */
function clipAll(collected: Record<string, string>, perItem = 1200): string {
  return Object.entries(collected)
    .map(([k, v]) => `### ${k}\n${(v || '').slice(0, perItem)}`)
    .join('\n\n');
}

const PERF_SPEC: FieldSpec = {
  type: 'object',
  required: true,
  fields: {
    summary: { type: 'string', required: true },
    items: {
      type: 'array',
      items: {
        type: 'object',
        fields: {
          category: { type: 'string', enum: ['kernel', 'network', 'io', 'limits', 'service'] },
          name: { type: 'string', required: true },
          currentValue: { type: 'string' },
          recommended: { type: 'string' },
          reason: { type: 'string' },
          command: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warning', 'critical'] }
        }
      }
    }
  }
};

const PERF_PROMPT = `你是 NebulaX 系统性能调优专家。输入是服务器只读采集的参数（sysctl/netsh/系统状态）。
任务：给出调优评估，输出严格 JSON。

原则：
- 只基于采集到的值判断；当前值合理就不列（宁缺毋滥）
- 每项给出 currentValue/recommended/reason/command（command 必须是可直接复制的设置命令）
- 绝对不要建议破坏性操作（关闭防火墙、禁用 SELinux 等高风险项要标注风险）
- severity: critical=必须处理, warning=建议处理, info=仅提示

输出 JSON：
{"summary":"整体评估 2-3 句","items":[{"category":"kernel|network|io|limits|service","name":"参数名","currentValue":"...","recommended":"...","reason":"...","command":"...","severity":"info|warning|critical"}]}`;

/**
 * 性能调优分析：本地规则 + AI 补充。
 * @param collected id → 采集输出
 * @param os 目标 OS
 */
export async function analyzePerf(
  collected: Record<string, string>,
  os: 'linux' | 'windows',
  extraContext?: string
): Promise<PerfReport> {
  const ruleItems = os === 'linux' ? analyzeLinuxLocal(collected) : analyzeWindowsLocal(collected);
  const failed: string[] = Object.entries(collected)
    .filter(([, v]) => !v || !v.trim())
    .map(([k]) => k);

  let aiItems: PerfItem[] = [];
  let summary = '';
  let degraded = false;

  const payload = clipAll(collected);
  if (payload.trim()) {
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: PERF_PROMPT },
        {
          role: 'user',
          content: `目标 OS：${os}${extraContext ? `\n服务器角色：${extraContext}` : ''}\n\n采集数据：\n\n${payload.slice(0, 10000)}\n\n请输出调优评估 JSON。`
        }
      ];
      const r = await chatJson<{ summary?: string; items?: any[] }>(messages, {
        spec: PERF_SPEC,
        maxTokens: 3000,
        config: resolveRoute('perf')
      });
      if (r.ok && r.data) {
        summary = typeof r.data.summary === 'string' ? r.data.summary : '';
        aiItems = (Array.isArray(r.data.items) ? r.data.items : []).map((it) => ({
          category: (['kernel', 'network', 'io', 'limits', 'service'].includes(it?.category) ? it.category : 'kernel') as PerfItem['category'],
          name: String(it?.name || '未知参数'),
          currentValue: it?.currentValue ? String(it.currentValue) : '',
          recommended: it?.recommended ? String(it.recommended) : undefined,
          reason: String(it?.reason || ''),
          command: it?.command ? String(it.command) : undefined,
          ok: false,
          severity: (['critical', 'warning', 'info'].includes(it?.severity) ? it.severity : 'info') as PerfItem['severity']
        }));
      } else {
        degraded = true;
      }
    } catch {
      degraded = true;
    }
  } else {
    degraded = true;
  }

  // 合并：本地规则优先，AI 项按 name 去重
  const merged = [...ruleItems];
  for (const it of aiItems) {
    if (!merged.some((m) => m.name === it.name)) merged.push(it);
  }

  const criticals = merged.filter((i) => i.severity === 'critical').length;
  const warnings = merged.filter((i) => i.severity === 'warning').length;
  const finalSummary =
    summary ||
    (merged.length === 0
      ? '各项参数均在合理范围内，暂无需调整。'
      : `发现 ${criticals} 项需立即处理、${warnings} 项建议优化（共 ${merged.length} 项）。所有建议均为只读分析，不会自动修改系统。`);

  return { os, items: merged, summary: finalSummary, failed, degraded };
}
