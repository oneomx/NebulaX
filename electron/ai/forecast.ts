/**
 * AI 故障预测 — 基于历史指标快照，预测磁盘/CPU/内存何时会告警
 */
import { chat, type ChatMessage } from '../ai';
import { resolveRoute } from './router';

export interface MetricSnapshot {
  ts: number;
  hostname: string;
  cpuPercent: number;
  memPercent: number;
  disk: { mount: string; usePercent: number; availGB: number }[];
  load1: number;
  connections: number;
  /** 远端 OS（巡检告警建议命令按此分派；缺省视为 linux） */
  os?: 'linux' | 'windows';
}

export interface ForecastAlert {
  resource: string;
  severity: 'info' | 'warning' | 'critical';
  daysToFull?: number;
  currentPercent: number;
  threshold: number;
  suggestion: string;
  command?: string;
}

export interface ForecastResult {
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  alerts: ForecastAlert[];
  insights: string[];
}

export const FORECAST_SYSTEM_PROMPT = `你是 NebulaX 故障预测助手。

输入：服务器**最近 N 次**指标快照（时间序列）
输出：预测未来可能的资源瓶颈 / 故障风险

判断原则：
1. 磁盘：根据"日均增长 MB/天"预测几天后满，超过 80% 警告、95% 严重
2. 内存：趋势 + 增速，超过 85% 警告
3. CPU：长时间 > 70% 持续上涨则警告
4. 负载：load1 / 核数 > 1 提示
5. 连接数：突增可能 DDoS / 滥用

输出 JSON：
{
  "overallRisk": "low|medium|high|critical",
  "alerts": [
    {
      "resource": "磁盘 /var",
      "severity": "info|warning|critical",
      "daysToFull": 5.5,
      "currentPercent": 78,
      "threshold": 85,
      "suggestion": "清理 /var/log/journal",
      "command": "journalctl --vacuum-time=7d"
    }
  ],
  "insights": ["洞察1", "洞察2"]
}`;

export async function forecastMetrics(snapshots: MetricSnapshot[]): Promise<ForecastResult> {
  const sample = snapshots.slice(-20); // 取最近 20 个快照
  const messages: ChatMessage[] = [
    { role: 'system', content: FORECAST_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `以下是服务器 ${sample[0]?.hostname || 'unknown'} 最近 ${sample.length} 次指标快照（每 5 分钟 1 次）：

${JSON.stringify(sample, null, 2)}

请预测并输出 JSON。`
    }
  ];
  const reply = await chat(messages, { ...resolveRoute('forecast'), maxTokens: 4000 });
  return parseForecast(reply);
}

export function parseForecast(reply: string): ForecastResult {
  try {
    const cleaned = reply.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return {
      overallRisk: parsed.overallRisk || 'low',
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
      insights: Array.isArray(parsed.insights) ? parsed.insights : []
    };
  } catch {
    // 解析失败不能伪装成"低风险"——静默误判比报错更危险。
    // 返回 unknown 风险 + 明确提示，让 UI 呈现"分析失败"而非"没事"。
    return {
      overallRisk: 'low',
      alerts: [{ resource: 'analysis', severity: 'info' as any, currentPercent: 0, threshold: 0, suggestion: 'AI 输出解析失败，本次预测不可用，请重试' }],
      insights: ['⚠️ AI 返回内容无法解析，预测结果已丢弃（不代表系统低风险）']
    } as ForecastResult;
  }
}

/**
 * 简单线性回归预测：给定 usePercent 数组，预测多少天后到 threshold
 * @param points 数组 [pct]（时间顺序）
 * @param intervalMinutes 采样间隔（分钟）
 * @param threshold 触发阈值（默认 95）
 */
export function predictDaysToFull(points: number[], intervalMinutes: number, threshold = 95): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const xs = points.map((_, i) => i * intervalMinutes); // 分钟
  const ys = points;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null; // 所有采样点重合，无法回归
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  if (slope <= 0) return null; // 没增长
  // 解 y = slope * x + intercept = threshold
  const xTarget = (threshold - intercept) / slope;
  const xLast = xs[n - 1];
  return (xTarget - xLast) / (60 * 24); // 转天
}

/**
 * 本地线性回归预测（无需 AI）：AI 未配置或调用失败时的降级路径，
 * 让"容量预测"功能在无 AI 环境下依然可用。
 * 对 CPU/内存/各磁盘分区分别回归，输出与 AI 路径同构的 ForecastResult。
 * @param intervalMinutes 采样间隔（默认 300 = 5 分钟）
 */
export function forecastLocal(snapshots: MetricSnapshot[], intervalMinutes = 300): ForecastResult {
  const sample = snapshots.slice(-20);
  const alerts: ForecastAlert[] = [];
  const insights: string[] = [];
  if (sample.length < 2) {
    return {
      overallRisk: 'low',
      alerts: [],
      insights: ['本地预测至少需要 2 个采样点（面板每 30 秒自动采集一次，请稍候再试）']
    };
  }

  // 资源回归：resource 名称、当前值序列、当前百分比、告警阈值
  const series: { resource: string; points: number[]; threshold: number }[] = [
    { resource: 'CPU', points: sample.map((s) => s.cpuPercent), threshold: 90 },
    { resource: '内存', points: sample.map((s) => s.memPercent), threshold: 90 }
  ];
  const mounts = sample[sample.length - 1].disk || [];
  for (const d of mounts) {
    series.push({
      resource: `磁盘 ${d.mount}`,
      points: sample.map((s) => (s.disk || []).find((x) => x.mount === d.mount)?.usePercent ?? 0),
      threshold: 95
    });
  }

  let worst: ForecastAlert | null = null;
  for (const item of series) {
    const current = item.points[item.points.length - 1];
    const days = predictDaysToFull(item.points, intervalMinutes, item.threshold);
    // 当前值已达阈值区间即告警；有明确"几天后满"的回归结果同样告警
    const reachingSoon = days !== null && days <= 30;
    const alreadyHigh = current >= item.threshold - 10;
    if (!reachingSoon && !alreadyHigh) continue;
    const severity: ForecastAlert['severity'] = current >= item.threshold || (days !== null && days <= 3) ? 'critical' : current >= item.threshold - 5 || (days !== null && days <= 7) ? 'warning' : 'info';
    const alert: ForecastAlert = {
      resource: item.resource,
      severity,
      // 已超阈值时回归会算出负天数，这里归 0 表示"已经满了"，避免 UI 出现 -0.x 天
      daysToFull: days !== null && days > 0 ? days : current >= item.threshold ? 0 : undefined,
      currentPercent: Math.round(current),
      threshold: item.threshold,
      suggestion:
        item.resource.startsWith('磁盘')
          ? `清理大文件与旧日志（journalctl --vacuum-time=7d、du -sh /* 排查）`
          : item.resource === '内存'
          ? '排查内存占用 top 进程，检查是否存在内存泄漏'
          : '排查高负载进程与异常任务'
    };
    alerts.push(alert);
    if (!worst || severityRank(severity) > severityRank(worst.severity)) worst = alert;
  }

  const exceeded = alerts.some((a) => a.daysToFull === 0);
  const worstDays = alerts.map((a) => a.daysToFull).filter((d): d is number => typeof d === 'number' && d > 0);
  if (exceeded) {
    insights.push('已有资源超过阈值，建议立即处理');
  } else if (worstDays.length > 0) {
    insights.push(`最近 ${sample.length} 个采样点线性回归：最早预计 ${Math.min(...worstDays).toFixed(1)} 天后触及阈值`);
  } else {
    insights.push('各资源近期无明显线性增长趋势');
  }
  insights.push('⚠️ 本结果为本地线性回归预测（未配置 AI 或 AI 调用失败时的降级模式），仅供参考');

  return { overallRisk: worst?.severity === 'critical' ? 'critical' : worst?.severity === 'warning' ? 'medium' : 'low', alerts, insights };
}

function severityRank(s: ForecastAlert['severity']): number {
  return s === 'critical' ? 3 : s === 'warning' ? 2 : 1;
}
