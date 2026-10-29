/**
 * 多模型智能路由（v1.7）
 * 按任务类型把请求路由到不同模型：简单问答用快模型、复杂诊断用强模型、
 * 长文本（日志分析）用大上下文模型。无配置时回落用户默认 AI 配置。
 *
 * 配置落盘 ~/.nebula-ssh/ai-routing.json（不含任何 key，key 始终走主配置/vault）
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AIConfig } from '../ai';

export type AiTaskType = 'chat' | 'diagnose' | 'audit' | 'script' | 'forecast' | 'db' | 'perf';

export const AI_TASK_LABELS: Record<AiTaskType, string> = {
  chat: '日常问答',
  diagnose: '故障诊断',
  audit: '安全审计',
  script: '脚本生成',
  forecast: '容量预测',
  db: '数据库诊断',
  perf: '性能调优'
};

export interface RouteRule {
  /** 目标模型名（留空 = 不路由，用主配置模型） */
  model?: string;
  /** 目标 API 地址（留空 = 用主配置 baseUrl） */
  baseUrl?: string;
  /** 输出 token 上限（留空 = 用主配置 maxTokens） */
  maxTokens?: number;
}

export interface RoutingConfig {
  enabled: boolean;
  rules: Partial<Record<AiTaskType, RouteRule>>;
}

const ROUTING_FILE = path.join(os.homedir(), '.nebula-ssh', 'ai-routing.json');

export function defaultRoutingConfig(): RoutingConfig {
  return { enabled: false, rules: {} };
}

export function loadRoutingConfig(): RoutingConfig {
  try {
    if (fs.existsSync(ROUTING_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8'));
      return normalizeRouting(parsed);
    }
  } catch {
    /* corrupted -> default */
  }
  return defaultRoutingConfig();
}

export function saveRoutingConfig(cfg: RoutingConfig): RoutingConfig {
  const clean = normalizeRouting(cfg);
  fs.mkdirSync(path.dirname(ROUTING_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ROUTING_FILE, JSON.stringify(clean, null, 2), { encoding: 'utf8', mode: 0o600 });
  return clean;
}

function normalizeRouting(parsed: any): RoutingConfig {
  const rules: Partial<Record<AiTaskType, RouteRule>> = {};
  const src = parsed && typeof parsed.rules === 'object' ? parsed.rules : {};
  for (const key of Object.keys(AI_TASK_LABELS) as AiTaskType[]) {
    const r = src[key];
    if (!r || typeof r !== 'object') continue;
    const rule: RouteRule = {};
    if (typeof r.model === 'string' && r.model.trim()) rule.model = r.model.trim();
    if (typeof r.baseUrl === 'string' && r.baseUrl.trim()) rule.baseUrl = r.baseUrl.trim();
    const mt = typeof r.maxTokens === 'number' ? r.maxTokens : parseInt(String(r.maxTokens), 10);
    if (Number.isFinite(mt) && mt > 0) rule.maxTokens = Math.min(mt, 32000);
    if (rule.model || rule.baseUrl || rule.maxTokens) rules[key] = rule;
  }
  return { enabled: !!parsed?.enabled, rules };
}

/**
 * 解析任务对应的 AI 配置覆盖项。
 * 返回值直接作为 chat(messages, config) 的 config 传入（chat 内部会与主配置合并）。
 * 路由关闭或规则为空时返回 {}（完全走主配置）。
 */
export function resolveRoute(task: AiTaskType, routing?: RoutingConfig): Partial<AIConfig> {
  const r = routing ?? loadRoutingConfig();
  if (!r.enabled) return {};
  const rule = r.rules[task];
  if (!rule) return {};
  const out: Partial<AIConfig> = {};
  if (rule.model) out.model = rule.model;
  if (rule.baseUrl) out.baseUrl = rule.baseUrl;
  if (rule.maxTokens) out.maxTokens = rule.maxTokens;
  return out;
}
