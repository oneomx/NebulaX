/**
 * AI 自然语言脚本生成
 * 输入："每天凌晨 3 点备份 MySQL 到 /backup 并清理 7 天前"
 * 输出：bash 脚本 + crontab 配置 + 部署命令
 */
import { chat, type ChatMessage } from '../ai';
import { resolveRoute } from './router';

export interface GeneratedScript {
  title: string;
  description: string;
  bash: string;
  cron?: string;
  deployCommands: string[];
  safetyNotes: string[];
  /** AI 返回内容无法解析为 JSON */
  parseError?: boolean;
  /** 输出被截断，bash 为抢救出的主体 */
  truncated?: boolean;
  /** 解析失败时的原始返回预览 */
  rawExcerpt?: string;
}

export const SCRIPT_GEN_SYSTEM_PROMPT = `你是 NebulaX 脚本生成助手，专注生成**可生产使用**的 bash 脚本。

输出 JSON：
{
  "title": "脚本标题",
  "description": "脚本功能简述",
  "bash": "完整 bash 脚本内容（带 shebang、set -euo pipefail、错误处理、日志）",
  "cron": "如需定时执行则给出 crontab 行（如 0 3 * * * /path/xxx.sh）",
  "deployCommands": ["创建脚本目录", "写入脚本", "赋执行权限", "加入 crontab"],
  "safetyNotes": ["安全提示1", "安全提示2"]
}

生成要求：
1. 必须有 shebang #!/usr/bin/env bash
2. 必须 set -euo pipefail
3. 必须有日志函数 log()
4. 必须 trap 错误并打印行号
5. 所有路径使用变量、便于配置
6. 危险操作（rm、shred）前 echo 提示并 [[ -n "$CONFIRM" ]] 才执行
7. crontab 行严格按格式
8. deployCommands 每条都是可复制的 bash 命令`;

export async function generateScript(requirement: string, context?: string): Promise<GeneratedScript> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SCRIPT_GEN_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `需求描述：${requirement}
${context ? `上下文：${context}\n` : ''}

请输出 JSON。`
    }
  ];
  const reply = await chat(messages, { ...resolveRoute('script'), maxTokens: 8000 });
  return parseScript(reply, requirement);
}

export function parseScript(reply: string, fallbackTitle: string): GeneratedScript {
  const cleaned = reply.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  const rawExcerpt = reply.slice(0, 500);
  try {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return {
      title: parsed.title || fallbackTitle,
      description: parsed.description || '',
      bash: parsed.bash || '#!/usr/bin/env bash\necho "script not generated"',
      cron: parsed.cron,
      deployCommands: Array.isArray(parsed.deployCommands) ? parsed.deployCommands : [],
      safetyNotes: Array.isArray(parsed.safetyNotes) ? parsed.safetyNotes : []
    };
  } catch {
    // 截断抢救：从残片中提取 bash 字段内容（JSON 字符串转义还原），保住核心产物
    const bashMatch = cleaned.match(/"bash"\s*:\s*"((?:[^"\\]|\\.)*)/);
    let bash = '';
    if (bashMatch) {
      try {
        // 用 JSON.parse 试完整还原；截断时手动处理常见转义
        bash = JSON.parse('"' + bashMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') + '"');
      } catch {
        bash = bashMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    const titleMatch = cleaned.match(/"title"\s*:\s*"([^"]{0,120})/);
    const descMatch = cleaned.match(/"description"\s*:\s*"([^"]{0,300})/);
    if (bash.trim()) {
      return {
        title: titleMatch?.[1] || fallbackTitle,
        description: (descMatch?.[1] || 'AI 输出被截断，以下为抢救出的脚本主体（末尾可能不完整，请人工检查）'),
        bash,
        deployCommands: [],
        safetyNotes: ['⚠ AI 输出被截断，部署命令与安全提示未能解析，请人工复核脚本后再上线'],
        truncated: true,
        rawExcerpt
      };
    }
    return {
      title: fallbackTitle,
      description: '脚本生成失败：AI 返回内容不是有效的 JSON（可能输出被截断或模型响应异常）',
      bash: '#!/usr/bin/env bash\necho "生成失败，请重试"',
      deployCommands: [],
      safetyNotes: [],
      parseError: true,
      rawExcerpt
    };
  }
}
