import type { NebulaAPI } from './api';
import type { CompletionItem, LineContext } from './completion';

/**
 * AI 联想补全：把当前命令行上下文交给模型，
 * 猜测最可能的后续补全候选，并给出每个候选（尤其参数）的一句话解释。
 *
 * - 按"输入行+待补全词"缓存，重复触发零成本
 * - 结果过期（输入已变化）由调用方丢弃
 */

const cache = new Map<string, CompletionItem[]>();
const MAX_CACHE = 80;

/** 最小输入长度：太短的词本地精选库已能即时补全，不值得打模型 */
const MIN_WORD_LEN = 2;
/** 单次 AI 联想超时：超过即放弃（本地候选已展示），不阻塞补全体验 */
const SUGGEST_TIMEOUT_MS = 8000;
/** 联想只需 3~8 条短候选，没必要用默认 2000 tokens */
const SUGGEST_MAX_TOKENS = 300;

/** 同 key 并发去重：上一次同上下文请求还在路上时直接复用，不重复打模型 */
const pending = new Map<string, Promise<CompletionItem[]>>();

function cacheKey(ctx: LineContext): string {
  return ctx.stripped + ' ' + ctx.word;
}

export async function aiSuggest(api: NebulaAPI, ctx: LineContext): Promise<CompletionItem[]> {
  // 输入太短直接跳过（本地补全已覆盖），从源头减少 LLM 调用
  if (ctx.word.trim().length < MIN_WORD_LEN) return [];

  const key = cacheKey(ctx);
  const hit = cache.get(key);
  if (hit) return hit;
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const task = doSuggest(api, ctx, key).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

async function doSuggest(api: NebulaAPI, ctx: LineContext, key: string): Promise<CompletionItem[]> {
  const posDesc = ctx.isCommand
    ? '命令名位置'
    : ctx.isFlag
    ? `命令 "${ctx.cmdName}" 的参数位置`
    : `命令 "${ctx.cmdName}" 的参数/路径位置`;

  const prompt = [
    '你是 Linux 命令行智能补全助手。用户正在终端输入命令，请给出最可能的补全候选，并解释每个候选（尤其是参数的作用）。',
    `当前输入行：${JSON.stringify(ctx.stripped)}`,
    `待补全词：${JSON.stringify(ctx.word)}`,
    `光标位置：${posDesc}`,
    '严格只返回 JSON，不要任何其他文字，格式：',
    '{"items":[{"label":"补全文本","explain":"一句话解释这个参数/子命令做什么，不超过40字"}]}',
    '要求：items 给 3~8 个；label 是可以直接补全到光标处的文本（参数要带前导 -，文件路径给完整可输入路径）；按可能性从高到低排列。'
  ].join('\n');

  const r = await Promise.race([
    api.aiChat({ messages: [{ role: 'user', content: prompt }], config: { maxTokens: SUGGEST_MAX_TOKENS } }),
    new Promise<{ ok: boolean; reply?: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false }), SUGGEST_TIMEOUT_MS)
    )
  ]);
  if (!r.ok || !r.reply) return [];

  const items = parseItems(r.reply);
  if (items.length > 0) {
    cache.set(key, items);
    if (cache.size > MAX_CACHE) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
  }
  return items;
}

/** 从模型回复中稳健解析 JSON（容忍代码块/多余文字） */
function parseItems(reply: string): CompletionItem[] {
  try {
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    const obj = JSON.parse(reply.slice(start, end + 1)) as { items?: unknown[] };
    const arr = Array.isArray(obj?.items) ? obj.items : [];
    const out: CompletionItem[] = [];
    for (const raw of arr) {
      const o = raw as { label?: unknown; explain?: unknown };
      if (!o || typeof o.label !== 'string' || !o.label.trim()) continue;
      out.push({
        label: o.label.trim().slice(0, 60),
        explain: typeof o.explain === 'string' ? o.explain.trim().slice(0, 60) : undefined,
        hint: 'AI 联想',
        kind: 'ai'
      });
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** 清空缓存（切换 AI 配置后可调用） */
export function clearAiSuggestCache(): void {
  cache.clear();
}
