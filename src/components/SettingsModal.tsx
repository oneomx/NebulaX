import { useState, useEffect } from 'react';
import { Sparkles, Save, KeyRound, Globe, Cpu, TestTube, Check, AlertTriangle, Loader2, Palette, BarChart3, ShieldCheck, ShieldAlert, FolderOpen, Route } from 'lucide-react';
import { getAPI, type RoutingConfigShape, type AiTaskType } from '../lib/api';
import { useAppStore } from '../store/app';
import ThemeSwitcher from './ThemeSwitcher';
import Modal from './ui/Modal';
import { Label, Input } from './ui/Input';
import { Button } from './ui/Button';

const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'anthropic', label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
  { id: 'ollama', label: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', label: '自定义', baseUrl: '', model: '' }
];

interface UsageView {
  today: { promptTokens: number; completionTokens: number; totalTokens: number; calls: number };
  daily: { date: string; model: string; promptTokens: number; completionTokens: number; calls: number }[];
  byModel: { model: string; promptTokens: number; completionTokens: number; totalTokens: number; calls: number }[];
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const api = getAPI();
  const { setAiConfig } = useAppStore();
  const [provider, setProvider] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('deepseek-chat');
  const [temperature, setTemperature] = useState(0.3);
  const [maxTokens, setMaxTokens] = useState(2000);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; msg: string }>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [vault, setVault] = useState<{ available: boolean; reason?: string } | null>(null);
  const [logMsg, setLogMsg] = useState('');
  // v1.7 多模型智能路由
  const [routing, setRouting] = useState<RoutingConfigShape | null>(null);
  const [taskLabels, setTaskLabels] = useState<Record<string, string>>({});
  const [routingSaved, setRoutingSaved] = useState(false);

  const openLogs = async () => {
    setLogMsg('');
    try {
      const r = await api.openLogDir();
      setLogMsg(r.ok ? `已打开：${r.path || '日志目录'}` : r.error || '打开失败');
    } catch (e: any) {
      setLogMsg(e?.message || '打开失败');
    }
  };

  useEffect(() => {
    (async () => {
      const res = await api.aiConfigGet();
      if (res.ok && res.config) {
        setProvider(res.config.provider);
        setBaseUrl(res.config.baseUrl);
        setModel(res.config.model);
        setTemperature(res.config.temperature);
        setMaxTokens(res.config.maxTokens);
      }
      const u = await api.aiUsage();
      if (u.ok && u.usage) setUsage(u.usage);
      // v1.7 多模型路由配置
      try {
        const r = await api.aiRoutingGet();
        if (r.ok && r.routing) {
          setRouting(r.routing);
          setTaskLabels(r.taskLabels || {});
        }
      } catch {
        /* 老版本主进程无此通道 */
      }
      // 凭据保管库状态：让用户确认密码/私钥是否在系统级加密下存储
      try {
        const v = await (api as any).vaultStatus?.();
        if (v?.ok) setVault({ available: !!v.available, reason: v.reason });
      } catch {
        /* 忽略：老版本主进程无此通道 */
      }
    })();
  }, []);

  const save = async () => {
    // 空 apiKey 不发送，避免覆盖磁盘已存密钥
    const payload: any = { provider, baseUrl, model, temperature, maxTokens };
    if (apiKey.trim()) payload.apiKey = apiKey.trim();
    const res = await api.aiConfigSet(payload);
    if (res.ok) {
      setAiConfig(res.config || null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  /** v1.7 保存多模型路由配置 */
  const saveRouting = async () => {
    if (!routing) return;
    try {
      const res = await api.aiRoutingSet(routing);
      if (res.ok) {
        setRoutingSaved(true);
        setTimeout(() => setRoutingSaved(false), 2000);
      }
    } catch {
      /* 保存失败保持原状态 */
    }
  };

  const patchRouteRule = (task: AiTaskType, patch: { model?: string; baseUrl?: string; maxTokens?: number }) => {
    setRouting((r) => {
      if (!r) return r;
      const cur = r.rules[task] || {};
      const nextRule = { ...cur };
      if ('model' in patch) {
        if (patch.model?.trim()) nextRule.model = patch.model.trim();
        else delete nextRule.model;
      }
      if ('baseUrl' in patch) {
        if (patch.baseUrl?.trim()) nextRule.baseUrl = patch.baseUrl.trim();
        else delete nextRule.baseUrl;
      }
      if ('maxTokens' in patch) {
        if (patch.maxTokens && patch.maxTokens > 0) nextRule.maxTokens = patch.maxTokens;
        else delete nextRule.maxTokens;
      }
      const rules = { ...r.rules };
      if (Object.keys(nextRule).length === 0) delete rules[task];
      else rules[task] = nextRule;
      return { ...r, rules };
    });
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.aiChat({
        messages: [{ role: 'user', content: '你好，请回复 OK 表示你正常工作' }],
        config: { provider, baseUrl, apiKey: apiKey || undefined, model, temperature, maxTokens }
      });
      if (res.ok) {
        setTestResult({ ok: true, msg: '连接成功，AI 已响应' });
      } else {
        setTestResult({ ok: false, msg: `测试失败：${res.error}` });
      }
    } catch (e: any) {
      setTestResult({ ok: false, msg: `测试失败：${e?.message}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal
      title="AI 助手设置"
      subtitle="配置 LLM 接口 · 支持多家服务商"
      icon={<Sparkles size={16} strokeWidth={1.8} />}
      onClose={onClose}
      footer={
        <>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" onClick={save}>
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? '已保存' : '保存配置'}
          </Button>
        </>
      }
    >
      {/* UI Theme */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Palette size={14} className="text-[var(--accent)]" />
          <Label text="界面风格" />
        </div>
        <ThemeSwitcher />
      </div>

      {/* Divider */}
      <div className="border-t border-[var(--border-subtle)] pt-4">
        <Label text="AI 助手配置" />
      </div>

      {/* Provider */}
      <div>
        <Label text="服务商" />
        <div className="grid grid-cols-4 gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setProvider(p.id);
                setBaseUrl(p.baseUrl);
                setModel(p.model);
              }}
              className={`px-3 py-2 rounded-lg text-xs transition ${
                provider === p.id
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-transparent'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Base URL */}
      <div>
        <Label text="Base URL" />
        <Input value={baseUrl} onChange={setBaseUrl} placeholder="https://api.deepseek.com/v1" icon={<Globe size={13} />} />
      </div>

      {/* API Key */}
      <div>
        <Label text="API Key" />
        <Input
          value={apiKey}
          onChange={setApiKey}
          type="password"
          placeholder={provider === 'ollama' ? '本地 Ollama 无需密钥' : 'sk-...（留空则保持已存密钥不变）'}
          icon={<KeyRound size={13} />}
        />
        <div className="text-[10px] text-[var(--text-muted)] mt-1">
          {provider === 'ollama'
            ? 'Ollama 运行在本机，无需 API Key；请先 ollama pull 拉取所填模型'
            : '密钥由系统安全存储加密保存，不会明文落盘'}
        </div>
      </div>

      {/* Model */}
      <div>
        <Label text="模型名称" />
        <Input value={model} onChange={setModel} placeholder="deepseek-chat" icon={<Cpu size={13} />} />
      </div>

      {/* Params */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label text={`温度：${temperature}`} />
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            className="w-full accent-[var(--accent)]"
          />
          <div className="flex justify-between text-[9px] text-[var(--text-muted)]">
            <span>精确</span>
            <span>创意</span>
          </div>
        </div>
        <div>
          <Label text="最大 Token 数" />
          <Input value={String(maxTokens)} onChange={(v) => setMaxTokens(parseInt(v) || 2000)} />
        </div>
      </div>

      {/* Test result */}
      {testResult && (
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
            testResult.ok ? 'bg-[var(--success)]/10 text-[var(--success)]' : 'bg-[var(--error)]/10 text-[var(--error)]'
          }`}
        >
          {testResult.ok ? <Check size={13} /> : <AlertTriangle size={13} />}
          {testResult.msg}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={testConnection} disabled={testing || (provider !== 'ollama' && !apiKey)}>
          {testing ? <Loader2 size={13} className="animate-spin" /> : <TestTube size={13} />}
          测试连接
        </Button>
      </div>

      {/* v1.7 多模型智能路由 */}
      {routing && (
        <div className="border-t border-[var(--border-subtle)] pt-4">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <Route size={14} className="text-[var(--accent)]" />
              <Label text="多模型智能路由" />
            </div>
            <button
              onClick={() => setRouting((r) => (r ? { ...r, enabled: !r.enabled } : r))}
              className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${
                routing.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--bg-elevated)] border border-[var(--border-strong)]'
              }`}
              title={routing.enabled ? '点击关闭路由' : '点击开启路由'}
              role="switch"
              aria-checked={routing.enabled}
            >
              <span
                className={`absolute top-[2px] w-[16px] h-[16px] rounded-full bg-white transition-all ${
                  routing.enabled ? 'left-[21px]' : 'left-[3px]'
                }`}
              />
            </button>
          </div>
          <div className="text-[10px] text-[var(--text-muted)] mb-2.5">
            按任务类型路由到不同模型：简单问答用快模型省 token，诊断/审计用强模型保质量。留空 = 用上方主配置；路由不改变 API Key（始终走主配置加密存储）。
          </div>
          {routing.enabled && (
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {(Object.keys(taskLabels) as AiTaskType[]).map((task) => {
                const rule = routing.rules[task] || {};
                return (
                  <div key={task} className="flex items-center gap-2 rounded-lg bg-[var(--bg-elevated)] px-2.5 py-2">
                    <div className="w-[72px] text-[11px] text-[var(--text-secondary)] shrink-0">{taskLabels[task]}</div>
                    <input
                      value={rule.model || ''}
                      onChange={(e) => patchRouteRule(task, { model: e.target.value })}
                      placeholder="模型（留空不路由）"
                      className="flex-1 min-w-0 rounded bg-[var(--bg-base)] border border-[var(--border-subtle)] px-2 py-1.5 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] outline-none font-mono"
                    />
                    <input
                      value={rule.baseUrl || ''}
                      onChange={(e) => patchRouteRule(task, { baseUrl: e.target.value })}
                      placeholder="API 地址（可选）"
                      className="flex-1 min-w-0 rounded bg-[var(--bg-base)] border border-[var(--border-subtle)] px-2 py-1.5 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] outline-none"
                    />
                    <input
                      type="number"
                      value={rule.maxTokens || ''}
                      onChange={(e) => patchRouteRule(task, { maxTokens: parseInt(e.target.value, 10) || 0 })}
                      placeholder="Tokens"
                      className="w-[74px] shrink-0 rounded bg-[var(--bg-base)] border border-[var(--border-subtle)] px-2 py-1.5 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] outline-none"
                    />
                  </div>
                );
              })}
              <div className="flex items-center gap-2 pt-1">
                <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={saveRouting}>
                  {routingSaved ? <Check size={13} /> : <Save size={13} />}
                  {routingSaved ? '已保存' : '保存路由'}
                </Button>
                <span className="text-[10px] text-[var(--text-muted)]">
                  配置存于 ~/.nebula-ssh/ai-routing.json（不含任何密钥）
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Token 用量统计 */}
      {usage && usage.byModel.length > 0 && (
        <div className="border-t border-[var(--border-subtle)] pt-4">
          <div className="flex items-center gap-2 mb-2">
            <BarChart3 size={14} className="text-[var(--accent)]" />
            <Label text="Token 用量统计" />
          </div>
          <div className="grid grid-cols-4 gap-2 mb-3">
            {[
              { label: '今日 Tokens', value: usage.today.totalTokens.toLocaleString() },
              { label: '今日输入', value: usage.today.promptTokens.toLocaleString() },
              { label: '今日输出', value: usage.today.completionTokens.toLocaleString() },
              { label: '今日调用', value: String(usage.today.calls) }
            ].map((s) => (
              <div key={s.label} className="bg-[var(--bg-elevated)] rounded-lg px-3 py-2">
                <div className="text-[10px] text-[var(--text-muted)]">{s.label}</div>
                <div className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">{s.value}</div>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] mb-1">按模型汇总（近 90 天）</div>
          <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
            {usage.byModel.slice(0, 8).map((m) => (
              <div key={m.model} className="flex items-center justify-between text-[11px] px-2 py-1 rounded bg-[var(--bg-elevated)]">
                <span className="text-[var(--text-primary)] truncate max-w-[45%]">{m.model}</span>
                <span className="text-[var(--text-muted)]">
                  {m.totalTokens.toLocaleString()} tokens · {m.calls} 次
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 凭据保管库状态 */}
      {vault && (
        <div className="border-t border-[var(--border-subtle)] pt-4">
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck size={14} className="text-[var(--accent)]" />
            <Label text="凭据保管库" />
          </div>
          <div
            className={`flex items-start gap-2 rounded-lg px-3 py-2.5 border ${
              vault.available
                ? 'bg-[var(--success)]/10 border-[var(--success)]/30'
                : 'bg-[var(--error)]/10 border-[var(--error)]/30'
            }`}
          >
            {vault.available ? (
              <ShieldCheck size={14} className="text-[var(--success)] mt-0.5 shrink-0" />
            ) : (
              <ShieldAlert size={14} className="text-[var(--error)] mt-0.5 shrink-0" />
            )}
            <div className="text-[11px] leading-relaxed">
              <div className={vault.available ? 'text-[var(--success)]' : 'text-[var(--error)]'}>
                {vault.available ? '系统级加密可用（safeStorage）' : '加密不可用，凭据无法安全保存'}
              </div>
              <div className="text-[var(--text-muted)] mt-0.5">
                {vault.available
                  ? '连接密码、私钥、跳板/代理凭据均经操作系统加密后存储，不会以明文落盘。'
                  : vault.reason
                  ? `原因：${vault.reason}`
                  : '请检查系统密钥环/DPAPI 是否可用；不可用时保存连接将无法记住密码。'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 运行日志（崩溃排查） */}
      <div className="border-t border-[var(--border-subtle)] pt-4">
        <div className="flex items-center gap-2 mb-2">
          <FolderOpen size={14} className="text-[var(--accent)]" />
          <Label text="运行日志" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">
            主进程日志按天落盘（保留 7 天），异常与崩溃原因可在此追溯；
            也可在「诊断包导出」中附带最近 500 条日志。
          </div>
          <Button variant="secondary" className="!px-3 !py-1.5 text-xs shrink-0" onClick={openLogs}>
            打开日志目录
          </Button>
        </div>
        {logMsg && (
          <div className={`text-[11px] mt-2 ${logMsg.startsWith('已打开') ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
            {logMsg}
          </div>
        )}
      </div>
    </Modal>
  );
}
