/**
 * AI Agent 自动故障根因定位
 * 多步：证据收集 → 分析 → 根因 → 修复
 */
import { chat, type ChatMessage } from '../ai';
import { resolveRoute } from './router';
import { chatJson } from './schema';

export interface DiagnosticStep {
  id: string;
  command: string;
  purpose: string;
  stdout?: string;
  stderr?: string;
  status: 'pending' | 'running' | 'success' | 'failed';
}

export interface RootCause {
  hypothesis: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  impact: string;
  fixCommand?: string;
  fixDescription?: string;
}

export interface DiagnosticReport {
  incident: string;
  summary: string;
  rootCauses: RootCause[];
  nextActions: string[];
  allClear: boolean; // 没发现根因时置 true
}

export const DIAGNOSTIC_SYSTEM_PROMPT = `你是 NebulaX 智能诊断 Agent，具备"自主多步排障"能力。

工作流程：
1. 接到故障现象后，**先规划**要执行的诊断命令清单（5-10 条，从宽到窄）
2. 用户/系统执行后，分析每条命令的输出
3. 综合证据，提出**1-3 个根因假设**（按可能性降序）
4. 每个假设给出**修复命令**（一键可执行）和**影响范围**
5. 如果没找到明显根因，明确说"暂未发现"而不是编造

诊断思路（Linux 常见故障）：
- 内存不足 → free、dmesg | grep -i oom、ps aux --sort=-%mem | head
- CPU 高 → top -bn1、mpstat、pidstat
- 磁盘满 → df -h、du -sh /var/log/*、lsof +L1
- 服务挂了 → systemctl status、journalctl -xe -u、ss -lntp
- 网络问题 → ss -lntp、ping、traceroute、ip a、iptables -L
- 应用报错 → 应用日志 + dmesg + 系统调用

输出 JSON 格式：
{
  "steps": [{"command":"...","purpose":"..."}],
  "report": {
    "incident": "故障现象",
    "summary": "1 句总结",
    "rootCauses": [
      {
        "hypothesis": "根因假设",
        "confidence": "high|medium|low",
        "evidence": ["证据1", "证据2"],
        "impact": "影响",
        "fixCommand": "修复命令",
        "fixDescription": "修复说明"
      }
    ],
    "nextActions": ["建议1", "建议2"],
    "allClear": false
  }
}`;

/** 按远端 OS 生成提示词约束：Windows 目标禁止给 Linux 命令 */
function osHint(os?: string): string {
  return os === 'windows'
    ? '\n【重要】目标服务器是 Windows（OpenSSH + PowerShell/cmd 环境）：诊断命令必须用 Windows 原生命令（Get-Process、Get-WinEvent、Get-Service、Get-CimInstance、tasklist、wevtutil 等），禁止给 Linux 命令（top/free/df/journalctl/systemctl/ss 在目标上不可用）。'
    : '\n目标服务器：Linux（默认 shell 为 bash）。';
}

export async function planDiagnosticSteps(incident: string, context?: string, os?: string): Promise<DiagnosticStep[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: DIAGNOSTIC_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `故障现象：${incident}\n${context ? `上下文：${context}\n` : ''}${osHint(os)}\n请规划 5-10 条诊断命令，输出 JSON（只需 steps 部分）。`
    }
  ];
  // 结构化增强：schema 校验 + 校验失败把错误反馈给模型重试（最多 2 次），
  // 显著降低"模型忘了输出 JSON/字段缺失"导致的规划失败率
  const r = await chatJson<{ steps?: any[] }>(messages, {
    spec: {
      type: 'object',
      required: true,
      fields: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            fields: { command: { type: 'string', required: true }, purpose: { type: 'string' } }
          }
        }
      }
    },
    maxTokens: 6000,
    config: resolveRoute('diagnose'),
    retryHint: 'steps 数组每项必须包含 command 与 purpose 字段；命令必须针对目标 OS（Windows 用原生命令，Linux 用 bash 命令）。'
  });
  if (!r.ok || !r.data?.steps?.length) {
    // 与原行为对齐：规划不出步骤时抛错，由调用方展示错误提示
    throw new Error(r.errors?.length ? `诊断规划输出格式校验失败：${r.errors.slice(0, 2).join('；')}` : 'AI 未返回有效诊断步骤');
  }
  const steps: any[] = r.data.steps;
  return steps.map((s, i) => ({
    id: `step-${i}`,
    command: s.command || 'echo "missing"',
    purpose: s.purpose || '诊断',
    status: 'pending' as const
  }));
}

export async function analyzeDiagnosticResult(
  incident: string,
  executedSteps: DiagnosticStep[],
  os?: string
): Promise<DiagnosticReport> {
  const messages: ChatMessage[] = [
    { role: 'system', content: DIAGNOSTIC_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `故障现象：${incident}${osHint(os)}

已执行诊断步骤及结果：

${executedSteps
  .map(
    (s) =>
      `【${s.purpose}】
$ ${s.command}
--- STDOUT ---
${(s.stdout || '').slice(0, 3000)}
${s.stderr ? `--- STDERR ---\n${s.stderr.slice(0, 1500)}` : ''}`
  )
  .join('\n\n')}

请综合分析并输出 JSON（只需 report 部分）。`
    }
  ];
  const r = await chatJson<any>(messages, {
    spec: {
      type: 'object',
      required: true,
      fields: {
        report: {
          type: 'object',
          required: true,
          fields: {
            incident: { type: 'string' },
            summary: { type: 'string', required: true },
            rootCauses: {
              type: 'array',
              items: {
                type: 'object',
                fields: {
                  hypothesis: { type: 'string', required: true },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                  evidence: { type: 'array', items: { type: 'string' } },
                  impact: { type: 'string' },
                  fixCommand: { type: 'string' },
                  fixDescription: { type: 'string' }
                }
              }
            },
            nextActions: { type: 'array', items: { type: 'string' } },
            allClear: { type: 'boolean' }
          }
        }
      }
    },
    maxTokens: 6000,
    config: resolveRoute('diagnose'),
    retryHint: 'report.summary 必填；rootCauses 每项必须有 hypothesis；没有发现根因时给空数组并把 allClear 设为 true。'
  });
  if (r.ok && r.data?.report) {
    const rep = r.data.report;
    return {
      incident: typeof rep.incident === 'string' && rep.incident ? rep.incident : incident,
      summary: rep.summary,
      rootCauses: Array.isArray(rep.rootCauses) ? rep.rootCauses : [],
      nextActions: Array.isArray(rep.nextActions) ? rep.nextActions : [],
      allClear: !!rep.allClear
    };
  }
  // 解析/校验失败不能返回 allClear: true（会把"没看懂输出"显示成"系统正常"）
  return {
    incident,
    summary: `⚠️ AI 输出格式校验失败（已重试 ${r.retries} 次），未能生成诊断结论（不代表系统正常），请重试`,
    rootCauses: [],
    nextActions: ['重试诊断；若持续失败请检查 AI 服务商配置或精简输入'],
    allClear: false
  };
}
