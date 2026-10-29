/**
 * AI 输出结构化增强（v1.7）
 * - JSON 输出 schema 校验（轻量级，只支持本项目 AI 模块需要的子集）
 * - 校验失败自动重试：把校验错误反馈给模型再生成（最多 N 次）
 * - 统一的"解析失败"语义：调用方能区分"AI 没按格式输出"与"业务上没问题"
 */
import { chat, type ChatMessage, type AIConfig } from '../ai';

export interface FieldSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
  /** array 时的元素规格 */
  items?: FieldSpec;
  /** object 时的字段规格 */
  fields?: Record<string, FieldSpec>;
  /** 是否必填（object 字段 / 顶层校验用；缺省非必填） */
  required?: boolean;
  /** string/number 白名单 */
  enum?: (string | number)[];
}

export interface ParseResult<T> {
  ok: boolean;
  data?: T;
  /** 校验/解析错误（ok=false 时有值），已合并所有重试的最后一次错误 */
  errors?: string[];
  /** 重试次数（0=一次成功） */
  retries: number;
  /** 最后一次 AI 原始输出片段（排障用） */
  rawExcerpt?: string;
}

/** 从 AI 回复中提取 JSON 文本（剥离 markdown 代码块围栏与前后杂文本） */
export function extractJsonText(reply: string): string {
  const cleaned = reply.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  const start = cleaned.indexOf('{');
  const startArr = cleaned.indexOf('[');
  // 对象或数组，取更靠前的合法起点
  let s = -1;
  if (start >= 0 && (startArr < 0 || start <= startArr)) s = start;
  else if (startArr >= 0) s = startArr;
  if (s < 0) return cleaned;
  const open = cleaned[s];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  return end > s ? cleaned.slice(s, end + 1) : cleaned.slice(s);
}

/** 校验值是否符合字段规格；返回错误列表（空数组 = 通过）。纯函数，可单测 */
export function validateField(value: unknown, spec: FieldSpec, path = '$'): string[] {
  const errors: string[] = [];
  if (value === undefined || value === null) {
    if (spec.required) errors.push(`${path}: 必填字段缺失`);
    return errors;
  }
  if (spec.type === 'any') return errors;
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: 应为 string，实际 ${typeof value}`);
      else if (spec.enum && !spec.enum.includes(value)) errors.push(`${path}: 值 "${String(value).slice(0, 40)}" 不在允许枚举内`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path}: 应为有限 number，实际 ${JSON.stringify(value)?.slice(0, 60)}`);
      else if (spec.enum && !spec.enum.includes(value)) errors.push(`${path}: 值 ${value} 不在允许枚举内`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: 应为 boolean`);
      break;
    case 'array':
      if (!Array.isArray(value)) errors.push(`${path}: 应为 array`);
      else if (spec.items) {
        value.forEach((item, i) => errors.push(...validateField(item, spec.items!, `${path}[${i}]`)));
      }
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: 应为 object`);
      } else if (spec.fields) {
        const obj = value as Record<string, unknown>;
        for (const [key, fs2] of Object.entries(spec.fields)) {
          errors.push(...validateField(obj[key], fs2, `${path}.${key}`));
        }
      }
      break;
  }
  return errors;
}

export interface ChatJsonOptions {
  /** 输出必须符合的 schema */
  spec: FieldSpec;
  /** 校验失败自动重试次数（默认 2，最多 3） */
  maxRetries?: number;
  /** 覆盖 AI 配置（模型路由/温度等） */
  config?: Partial<AIConfig>;
  /** 单次调用 maxTokens（默认 4000） */
  maxTokens?: number;
  /** 重试反馈给模型时附加的额外提示 */
  retryHint?: string;
}

/**
 * 要求 AI 输出 JSON 并校验；失败时把校验错误反馈给模型重试。
 * 与直接 chat+parse 的区别：不是"解析失败就降级"，而是主动纠正 1-2 次，
 * 显著降低"AI 忘了输出 JSON/字段缺失"导致的功能失败率。
 */
export async function chatJson<T = unknown>(messages: ChatMessage[], opts: ChatJsonOptions): Promise<ParseResult<T>> {
  const maxRetries = Math.max(0, Math.min(3, opts.maxRetries ?? 2));
  const maxTokens = opts.maxTokens ?? 4000;
  let allErrors: string[] = [];
  let lastRaw = '';
  let convo = [...messages];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const reply = await chat(convo, { ...(opts.config || {}), maxTokens });
    lastRaw = reply;
    const jsonText = extractJsonText(reply);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e: any) {
      allErrors = [`JSON 语法错误：${e?.message || e}`];
    }
    if (parsed !== undefined) {
      const errs = validateField(parsed, opts.spec);
      if (errs.length === 0) {
        return { ok: true, data: parsed as T, retries: attempt, rawExcerpt: reply.slice(0, 300) };
      }
      allErrors = errs;
    }
    // 还有重试机会 → 把错误反馈给模型再生成
    if (attempt < maxRetries) {
      convo = [
        ...messages,
        { role: 'assistant', content: reply },
        {
          role: 'user',
          content:
            `你上一次的输出未通过格式校验，错误如下：\n${allErrors.slice(0, 8).join('\n')}\n\n` +
            '请重新输出**完整**的 JSON（不要输出任何 JSON 之外的解释文本，不要用 markdown 代码块包裹）。' +
            (opts.retryHint ? `\n${opts.retryHint}` : '')
        }
      ];
    }
  }
  return { ok: false, errors: allErrors, retries: maxRetries, rawExcerpt: lastRaw.slice(0, 300) };
}

/**
 * 便捷包装：chatJson + 把 ParseResult 折叠成 { ok, data?, error? }，
 * 供现有 IPC handler 直接替换 chat+parse 使用。
 */
export async function chatJsonSimple<T = unknown>(
  messages: ChatMessage[],
  opts: ChatJsonOptions
): Promise<{ ok: boolean; data?: T; error?: string; retries?: number }> {
  const r = await chatJson<T>(messages, opts);
  if (r.ok) return { ok: true, data: r.data, retries: r.retries };
  return {
    ok: false,
    error: `AI 输出格式校验失败（已重试 ${r.retries} 次）：${(r.errors || []).slice(0, 3).join('；')}`,
    retries: r.retries
  };
}
