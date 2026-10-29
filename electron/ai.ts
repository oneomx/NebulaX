import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vaultGetAIKey } from './vault';

export interface AIConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'zhipu' | 'qwen' | 'moonshot' | 'ollama' | 'custom';
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** 是否启用模型思维链（默认关闭：推理模型开思考会慢 5-8 倍且吃掉输出预算） */
  enableThinking: boolean;
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.3,
  maxTokens: 2000,
  enableThinking: false
};

const CONFIG_FILE = path.join(os.homedir(), '.nebula-ssh', 'ai-config.json');

export function loadAIConfig(): AIConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_AI_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch {}
  return { ...DEFAULT_AI_CONFIG };
}

/**
 * 保存配置。apiKey **绝不**明文落盘，完全由 vault（safeStorage 加密）承载。
 * 若检测到旧版 ai-config.json 中残留明文 apiKey，自动清除。
 */
export function saveAIConfig(config: Partial<AIConfig>): AIConfig {
  const current = loadAIConfig();
  const patch: Partial<AIConfig> = { ...config };
  // 空 apiKey 不覆盖已存密钥
  if (patch.apiKey === '') delete patch.apiKey;

  const merged = { ...current, ...patch };

  // 确保磁盘文件不含任何 apiKey（历史残留也清理）
  const diskSafe = { ...merged };
  delete (diskSafe as any).apiKey;

  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(diskSafe, null, 2), { encoding: 'utf8', mode: 0o600 });
  return merged;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function chat(messages: ChatMessage[], config?: Partial<AIConfig>): Promise<string> {
  return chatWithUsage(messages, config).then((r) => r.content);
}

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  /** 服务端返回的用量（Ollama/OpenAI 兼容端点均返回；Anthropic 为 usage.input_tokens/output_tokens） */
  usage?: AIUsage;
}

/**
 * 带用量返回的对话。Ollama 本地模型无需 apiKey（localhost 服务默认免鉴权）。
 */
export function chatWithUsage(messages: ChatMessage[], config?: Partial<AIConfig>): Promise<ChatResult> {
  const cfg = { ...loadAIConfig(), ...config };
  // Ollama 本地模型无需 Key；其余 provider 仍需（vault 兜底）
  const needKey = cfg.provider !== 'ollama';
  if (!cfg.apiKey) {
    const vaultKey = vaultGetAIKey();
    if (vaultKey) cfg.apiKey = vaultKey;
  }
  if (needKey && !cfg.apiKey) {
    return Promise.reject(
      new Error(
        cfg.provider === 'ollama'
          ? 'Ollama 服务不可达，请确认本机已安装并启动 Ollama（ollama serve）'
          : '未配置 AI API Key。请在设置中填写 API Key 后使用智能助手。'
      )
    );
  }

  const isAnthropic = cfg.provider === 'anthropic';
  const url = new URL(cfg.baseUrl.endsWith('/') ? cfg.baseUrl.slice(0, -1) : cfg.baseUrl);
  // Ollama 原生 API 是 /api/chat，但官方也提供 OpenAI 兼容层 /v1/chat/completions；
  // baseUrl 若已含 /v1 则走兼容层（与其余 OpenAI 兼容 provider 统一处理）
  const endpoint = isAnthropic ? '/v1/messages' : '/chat/completions';
  const isHttps = url.protocol === 'https:';

  // Anthropic 需要把 system 消息单独提取，保留其余消息顺序
  const systemMsg = messages.find((m) => m.role === 'system');
  const chatMessages = messages.filter((m) => m.role !== 'system');
  const body = isAnthropic
    ? {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        messages: chatMessages,
        system: systemMsg?.content
      }
    : {
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        // 推理模型默认关思维链：显著提速且避免思维链吃掉 max_tokens 输出预算
        // （不支持该参数的兼容服务端会忽略未知字段）
        ...(cfg.enableThinking ? {} : { enable_thinking: false })
      };

  const bodyStr = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(bodyStr))
  };
  if (isAnthropic) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (cfg.apiKey) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  }

  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      fn();
    };
    // 绝对总时长上限：非流式请求在服务端生成期间 socket 无数据流动，
    // 不能用 socket 空闲超时（会误杀正常慢响应），统一用绝对计时器兜底
    const absoluteTimer = setTimeout(() => {
      req.destroy();
      done(() => reject(new Error('AI 请求超时（总时长超过 180 秒），请精简输入后重试')));
    }, 180000);
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname.replace(/\/$/, '') + endpoint,
        method: 'POST',
        headers,
        timeout: 0
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('error', (e) => done(() => reject(new Error(`AI 响应流出错: ${e?.message || e}`))));
        res.on('end', () => {
          try {
            // HTTP 非 200 状态码处理
            if (res.statusCode && res.statusCode >= 400) {
              done(() => reject(new Error(`AI 请求失败 (HTTP ${res.statusCode}): ${data.slice(0, 400)}`)));
              return;
            }
            const json = JSON.parse(data);
            if (json.error) {
              done(() => reject(new Error(json.error.message || JSON.stringify(json.error))));
              return;
            }
            // 兼容多种 OpenAI 兼容响应结构（部分模型把正文放在 reasoning_content 之外的字段）
            const choice = json.choices?.[0];
            const content =
              (isAnthropic ? json.content?.[0]?.text : undefined) ??
              choice?.message?.content ??
              choice?.text ??
              json.output_text ??
              '';
            // content 为空但有思维链时退回思维链，避免静默返回空字符串
            const fallback = choice?.message?.reasoning_content || '';
            const finalText = (typeof content === 'string' && content.trim()) ? content : fallback;
            if (!finalText || !finalText.trim()) {
              done(() => reject(new Error(`AI 返回内容为空（响应结构无法识别）：${data.slice(0, 300)}`)));
              return;
            }
            // 用量提取：OpenAI 兼容 usage.prompt_tokens/completion_tokens；Anthropic usage.input_tokens/output_tokens
            const u = json.usage || {};
            const usage: AIUsage | undefined =
              u.prompt_tokens !== undefined || u.input_tokens !== undefined
                ? {
                    promptTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
                    completionTokens: u.completion_tokens ?? u.output_tokens ?? 0,
                    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? u.input_tokens ?? 0) + (u.completion_tokens ?? u.output_tokens ?? 0)
                  }
                : undefined;
            done(() => resolve({ content: finalText, usage }));
          } catch (e) {
            done(() => reject(new Error(`AI 响应解析失败: ${data.slice(0, 200)}`)));
          }
        });
      }
    );
    req.on('error', (e) => done(() => reject(e)));
    req.on('timeout', () => {
      req.destroy();
      done(() => reject(new Error('AI 请求超时')));
    });
    req.write(bodyStr);
    req.end();
  });
}
