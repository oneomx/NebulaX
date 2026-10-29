/**
 * 上下文深度增强（v1.7）
 * 聚合多源上下文注入 AI 问答/诊断：最近命令历史、系统日志尾部、
 * 巡检趋势预警、Runbook 匹配结果——让回答贴合当前实际情况而非泛泛而谈。
 *
 * 纯组装逻辑（buildRichContext）可单测；数据采集在 main.ts 侧完成。
 */
import { retrieve, type RetrievalResult } from './rag';

export interface RichContextInput {
  /** 主机标识（日志/巡检归属） */
  host?: string;
  /** 远端 OS（决定日志采集命令与说明文案） */
  os?: 'linux' | 'windows';
  /** 最近执行过的命令（新→旧，最多保留 N 条） */
  recentCommands?: string[];
  /** 系统日志尾部（已由调用方采集好） */
  logTail?: string;
  /** 巡检上下文摘要（buildOpsContext 输出） */
  opsSummary?: string;
  /** 巡检趋势预警行（可选，来自 evaluateTrend） */
  trendLines?: string[];
  /** 与用户问题匹配的 Runbook 片段 */
  runbookMatches?: { title: string; excerpt: string; score: number }[];
  /** 用户本轮问题（用于 Runbook 检索） */
  question?: string;
  /** token 预算（字符近似，控制注入总量防超长；默认 6000 字符） */
  budgetChars?: number;
}

/** 每类上下文的字符上限（合计受 budgetChars 约束，按优先级裁剪） */
const SECTION_LIMITS = {
  ops: 1500,
  trends: 600,
  commands: 800,
  logs: 2500,
  runbooks: 1200
} as const;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n…（已截断）';
}

/**
 * 组装富上下文文本（纯函数）。按优先级装入预算：
 * 巡检/趋势 > 命令历史 > 日志尾部 > Runbook。
 * 全部为空时返回空字符串。
 */
export function buildRichContext(input: RichContextInput): string {
  const budget = input.budgetChars ?? 6000;
  const parts: { priority: number; text: string }[] = [];

  if (input.opsSummary) {
    parts.push({ priority: 100, text: `【巡检指标（最近一轮）】\n${clip(input.opsSummary, SECTION_LIMITS.ops)}` });
  }
  if (input.trendLines && input.trendLines.length > 0) {
    parts.push({ priority: 95, text: `【趋势预警（未超阈值但将触顶）】\n${clip(input.trendLines.join('\n'), SECTION_LIMITS.trends)}` });
  }
  if (input.recentCommands && input.recentCommands.length > 0) {
    const lines = input.recentCommands.slice(0, 15).map((c, i) => `${i + 1}. ${c}`);
    parts.push({ priority: 80, text: `【最近执行的命令（新→旧）】\n${clip(lines.join('\n'), SECTION_LIMITS.commands)}` });
  }
  if (input.logTail) {
    const osLabel = input.os === 'windows' ? 'Windows（PowerShell/事件日志）' : 'Linux（journalctl/syslog）';
    parts.push({ priority: 70, text: `【系统日志尾部 · ${osLabel}】\n${clip(input.logTail, SECTION_LIMITS.logs)}` });
  }
  if (input.runbookMatches && input.runbookMatches.length > 0) {
    const lines = input.runbookMatches
      .slice(0, 3)
      .map((m) => `《${m.title}》（相似度 ${(m.score * 100).toFixed(0)}%）：\n${m.excerpt}`);
    parts.push({ priority: 60, text: `【知识库 Runbook 匹配】\n${clip(lines.join('\n\n'), SECTION_LIMITS.runbooks)}` });
  }

  if (parts.length === 0) return '';
  parts.sort((a, b) => b.priority - a.priority);

  let used = 0;
  const out: string[] = [];
  for (const p of parts) {
    if (used + p.text.length > budget) {
      // 预算不足时至少保留一段（第一段），避免全丢
      if (out.length === 0) {
        out.push(clip(p.text, budget));
        used = budget;
      }
      break;
    }
    out.push(p.text);
    used += p.text.length;
  }
  return out.join('\n\n');
}

/** 从用户问题检索 Runbook 匹配（封装 rag.retrieve，失败返回空） */
export function matchRunbooks(question: string, topK = 2): { title: string; excerpt: string; score: number }[] {
  try {
    if (!question || !question.trim()) return [];
    return retrieve(question, topK).map((r: RetrievalResult) => ({
      title: r.doc.title,
      excerpt: r.excerpt,
      score: r.score
    }));
  } catch {
    return [];
  }
}

/** 日志采集命令（按 OS 分派，只读安全；调用方负责执行） */
export function logTailCommand(osType?: 'linux' | 'windows', lines = 40): string {
  if (osType === 'windows') {
    return `powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-EventLog -LogName System -Newest ${lines} -ErrorAction SilentlyContinue | ForEach-Object { '[' + $_.TimeGenerated + '] ' + $_.EntryType + ': ' + (\$_.Message -replace \\\"\\r?\\n\\\", ' ') }"`;
  }
  // Linux：最近 N 行系统日志（journalctl 优先，降级 syslog）
  return `journalctl -n ${lines} --no-pager -o short-iso 2>/dev/null || tail -n ${lines} /var/log/syslog 2>/dev/null || tail -n ${lines} /var/log/messages 2>/dev/null`;
}
