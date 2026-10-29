/**
 * AI 智能审计模块 — 识别安全风险
 * 输入：一段终端输出 / 文件内容 / 配置片段
 * 输出：结构化风险列表（严重度 + 修复命令）
 *
 * v1.8 精确化改造：
 * - 本地规则引擎先行（auditRules）：确定性检查 + 证据 + 确定性评分
 * - AI 只做语义归纳与规则外发现；evidence 逐字校验，不实者剔除（降误报）
 * - AI 失败（无 key/网络异常）不再整体失败 → 降级为纯规则审计结果
 */
import { chat, type ChatMessage } from '../ai';
import { resolveRoute } from './router';
import {
  runAuditRules,
  mergeAuditFindings,
  computeScore,
  sortFindings,
  type AuditCheck,
  type AuditSeverity
} from './auditRules';

export interface AuditFinding {
  severity: AuditSeverity;
  category: string;
  title: string;
  description: string;
  evidence: string;
  remediation: string;
  command?: string;
  /** 'rule'=本地确定性规则；'ai'=AI 语义分析（前端区分展示） */
  source?: 'rule' | 'ai';
}

export interface AuditResult {
  summary: string;
  score: number; // 0-100 安全评分（由 findings 确定性计算）
  findings: AuditFinding[];
  scannedAt: number;
  /** 本地规则检查项状态（通过/风险/跳过），透明展示审计覆盖面 */
  checks?: AuditCheck[];
  /** 本地规则发现数 */
  ruleCount?: number;
  /** 通过证据校验保留的 AI 发现数 */
  aiCount?: number;
  /** 证据不实/重复被剔除的 AI 发现数（透明展示降误报动作） */
  droppedCount?: number;
  /** AI 未响应，本次为纯规则审计 */
  aiSkipped?: boolean;
  /** AI 返回内容无法解析为 JSON 报告 */
  parseError?: boolean;
  /** 输出被 max_tokens 截断，findings 为抢救出的部分结果 */
  truncated?: boolean;
  /** 解析失败时的原始返回预览（便于排障） */
  rawExcerpt?: string;
}

export const AUDIT_SYSTEM_PROMPT = `你是 NebulaX 安全审计助手，专注 Linux 服务器安全。

【本地规则已完成的检查（结论见用户消息，禁止重复报告同名问题）】

审计原则：
0. 【最重要】只报告**原文中能逐字找到证据**的风险。evidence 必须是审计原文的逐字摘录（保留原格式）；做不到逐字引用的发现，宁可不报
1. 严格只报告**可验证**的安全风险，不做无依据猜测：
   - 证书是否过期、软件是否有 CVE —— 原文未明确给出的，不要猜
   - 无法确认影响面的，降级为 info 或不报
2. 以下常见形态**不是风险，禁止报告**（本地误报高发项）：
   - /etc/passwd 权限 644（Unix 标准可读设计）
   - /etc/shadow 权限 640 root:shadow
   - 发行版标准 SUID：sudo su passwd chsh chfn newgrp gpasswd mount umount fusermount crontab unix_chkpwd pklib(polkit) ssh-keysign 等
   - SSH 端口 22 监听、80/443 监听
   - 仅绑定 127.0.0.1/::1 的本地监听
   - /tmp、/dev/shm 等带 sticky 位（1777）的公共目录
   - sshd 未显式配置的默认项（PermitRootLogin prohibit-password 等）
   - sudo 中需要口令的常规 (ALL : ALL) 规则
3. 严重度分级：critical（立即处理）> high > medium > low > info（提示）
4. 每个发现必须包含：
   - title：简短标题
   - category：密码安全|权限|SSH|网络|版本|脚本|证书|日志|其他
   - description：风险描述（中文，1-3 句，说明危害与利用方式）
   - evidence：**逐字摘自原文**的代码/配置片段（保留原格式）
   - remediation：修复方案（1-2 句）
   - command：可执行的修复命令（若能给出）
5. 重点关注（规则未覆盖的语义类风险）：
   - 脚本逻辑缺陷、危险的 eval/注入点
   - 明显的业务配置错误导致的安全后果
   - 日志/输出中泄漏的敏感信息（令牌、内网地址拓扑）
   - 组合风险（如公网可达 + 弱认证）

输出格式（严格 JSON，无 markdown 代码块外文本）：
{
  "summary": "整体评估 1 句话",
  "score": 0-100 安全评分（100 最安全），
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "category": "...",
      "title": "...",
      "description": "...",
      "evidence": "逐字摘录",
      "remediation": "...",
      "command": "..."
    }
  ]
}`;

export async function runSecurityAudit(
  content: string,
  contentType: 'terminal' | 'file' | 'config' | 'log',
  context?: string
): Promise<AuditResult> {
  // 1) 本地规则先行：确定性检查、证据与评分基础
  const { checks, findings: ruleFindings } = runAuditRules(content);

  // 2) AI 语义分析（降级容错：无 key / 网络失败 → 纯规则结果，不再整体报错）
  let aiFindings: AuditFinding[] = [];
  let aiSkipped = false;
  let parseError = false;
  let truncated = false;
  let rawExcerpt: string | undefined;
  let aiSummary = '';

  const ruleDigest = checks.length
    ? checks
        .map((c) => `${c.status === 'pass' ? '[通过]' : c.status === 'fail' ? '[风险]' : '[跳过]'}${c.name}${c.detail ? `(${c.detail})` : ''}`)
        .join('；')
    : '无（通用文本模式）';

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: AUDIT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `【本地规则已判定，禁止重复报告】${ruleDigest}

审计以下${contentType === 'terminal' ? '终端输出' : contentType === 'file' ? '文件内容' : contentType === 'config' ? '配置' : '日志'}：

${context ? `【上下文】${context}\n` : ''}
\`\`\`
${content.slice(0, 12000)}
\`\`\`

请只输出 JSON 审计报告（findings 只写规则未覆盖的新增风险）。`
      }
    ];

    const reply = await chat(messages, { ...resolveRoute('audit'), maxTokens: 8000 });
    const parsed = parseAuditResult(reply);
    aiFindings = parsed.findings;
    aiSummary = parsed.summary;
    parseError = !!parsed.parseError;
    truncated = !!parsed.truncated;
    rawExcerpt = parsed.rawExcerpt;
  } catch {
    aiSkipped = true;
  }

  // 3) 合并：AI 证据逐字校验 + 与规则去重（不实者剔除）
  const { findings, dropped } = mergeAuditFindings(ruleFindings, aiFindings, content);

  // 4) 确定性评分（可复现，不再由 AI 随口给分）
  const score = computeScore(findings);
  const ruleCount = ruleFindings.length;
  const aiCount = findings.length - ruleCount;

  const failCount = checks.filter((c) => c.status === 'fail').length;
  const passCount = checks.filter((c) => c.status === 'pass').length;
  const coverage = `${passCount} 项通过 / ${failCount} 项风险 / ${checks.length} 项已检查`;

  let summary: string;
  if (aiSkipped) {
    summary = `本地规则审计完成（${coverage}）。AI 未响应（未配置密钥或网络异常），本次仅含确定性规则结论。`;
  } else if (parseError) {
    summary = `本地规则审计完成（${coverage}）。${aiSummary || 'AI 报告解析失败'}——以下为规则结论${dropped ? `，已剔除 ${dropped} 条证据不实的 AI 结论` : ''}。`;
  } else {
    summary = `${aiSummary || '安全审计完成'}（规则 ${ruleCount} 项 + AI ${aiCount} 项${dropped ? `，剔除证据不实 ${dropped} 条` : ''}；${coverage}）`;
  }

  return {
    summary,
    score,
    findings,
    scannedAt: Date.now(),
    checks,
    ruleCount,
    aiCount,
    droppedCount: dropped,
    aiSkipped: aiSkipped || undefined,
    parseError: parseError || undefined,
    truncated: truncated || undefined,
    rawExcerpt
  };
}

/**
 * 从可能被截断的 JSON 文本中抢救完整的 finding 对象。
 * 用大括号配对逐个提取，只保留已闭合的对象。
 */
function salvageFindings(text: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const key = text.indexOf('"findings"');
  if (key < 0) return findings;
  const start = text.indexOf('[', key);
  if (start < 0) return findings;
  let depth = 0;
  let objStart = -1;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          findings.push(JSON.parse(text.slice(objStart, i + 1)));
        } catch {}
        objStart = -1;
      }
    }
  }
  return findings;
}

export function parseAuditResult(reply: string): AuditResult {
  // 剥离可能的 markdown 代码块
  const cleaned = reply.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const rawExcerpt = reply.slice(0, 500);
  try {
    if (start < 0 || end < 0) throw new Error('no JSON');
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return {
      summary: parsed.summary || '安全审计完成',
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : 50,
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      scannedAt: Date.now()
    };
  } catch {
    // 完整 JSON 解析失败：尝试抢救被截断输出中的完整 findings
    const salvaged = salvageFindings(cleaned).filter(
      (f) => f && typeof f.title === 'string'
    );
    const scoreMatch = cleaned.match(/"score"\s*:\s*(\d+)/);
    const summaryMatch = cleaned.match(/"summary"\s*:\s*"([^"]{0,200})/);
    if (salvaged.length > 0 || scoreMatch) {
      return {
        summary: (summaryMatch?.[1] || 'AI 输出被截断，以下为部分审计结果') + (salvaged.length ? '' : '（风险明细未能解析）'),
        score: scoreMatch ? Math.max(0, Math.min(100, parseInt(scoreMatch[1], 10))) : 50,
        findings: salvaged,
        scannedAt: Date.now(),
        truncated: true,
        rawExcerpt
      };
    }
    return {
      summary: '审计结果解析失败：AI 返回内容不是有效的 JSON 报告',
      score: 50,
      findings: [],
      scannedAt: Date.now(),
      parseError: true,
      rawExcerpt
    };
  }
}

/** 供 UI/测试引用：按严重度排序（与规则引擎一致） */
export { sortFindings };
