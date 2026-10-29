import { useState, useEffect } from 'react';
import {
  ScrollText,
  Sparkles,
  Loader2,
  Copy,
  CheckCheck,
  Play,
  Terminal,
  Info,
  X,
  Minus
} from 'lucide-react';
import { getAPI } from '../../lib/api';
import type { GeneratedScript } from '../../types/ai';
import { useModalEscape } from '../ui/useModalEscape';

interface Props {
  onClose: () => void;
  sessionId?: string | null;
  minimized?: boolean;
  onMinimize?: () => void;
  onStatusChange?: (running: boolean) => void;
}

export default function ScriptGenPanel({ onClose, sessionId, minimized, onMinimize, onStatusChange }: Props) {
  useModalEscape(onClose, !minimized);
  const [requirement, setRequirement] = useState('');
  const [context, setContext] = useState('');
  const [script, setScript] = useState<GeneratedScript | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const api = getAPI();

  // 向外层报告任务运行状态（供缩小后的悬浮窗显示）
  useEffect(() => {
    onStatusChange?.(loading);
  }, [loading]);

  const generate = async () => {
    if (!requirement.trim()) return;
    setLoading(true);
    setError('');
    setScript(null);
    try {
      const res = await api.aiGenScript({ requirement, context: context || undefined });
      if (res.ok && res.script) {
        setScript(res.script as GeneratedScript);
      } else {
        setError(res.error || '生成失败');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  // 缩小到后台：不渲染界面但保持挂载，任务继续执行
  if (minimized) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base)]/80 backdrop-blur-sm">
      <div className="glass rounded-[8px] w-[1100px] max-w-[95vw] h-[85vh] flex flex-col shadow-panel animate-slide-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border-subtle)]">
          <div className="w-9 h-9 rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)]">
            <ScrollText size={18} style={{ color: "var(--accent-contrast)" }} />
          </div>
          <div className="flex-1">
            <div className="text-base font-semibold theme-text-primary">AI 自然语言生成脚本</div>
            <div className="text-xs text-[var(--text-muted)]">一句话描述需求 → AI 生成可生产使用的 bash 脚本</div>
          </div>
          {onMinimize && (
            <button onClick={onMinimize} title="缩小到后台运行" className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              <Minus size={18} />
            </button>
          )}
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Left input */}
          <div className="w-[35%] flex flex-col border-r border-[var(--border-subtle)] p-4">
            <label className="text-xs text-[var(--text-secondary)] mb-1.5">脚本需求描述</label>
            <textarea
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              placeholder="如：每天凌晨 3 点备份 MySQL 到 /backup，保留 7 天"
              rows={8}
              className="w-full rounded-[6px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-none"
            />

            <label className="text-xs text-[var(--text-secondary)] mb-1.5 mt-3">上下文（可选）</label>
            <input
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="如：服务器 Ubuntu 22.04，用 systemd"
              className="w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />

            <button
              onClick={generate}
              disabled={loading || !requirement.trim()}
              className="mt-4 flex items-center justify-center gap-2 py-2.5 rounded-[6px] theme-btn-primary font-medium hover:opacity-90"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {loading ? '生成中...' : '生成脚本'}
            </button>

            {error && (
              <div className="mt-3 px-3 py-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[var(--error)] text-xs">{error}</div>
            )}

            <div className="mt-4 px-3 py-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
              <div className="flex items-start gap-1.5">
                <Info size={12} className="text-[var(--warning)] mt-0.5" />
                <div className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                  生成的脚本严格遵守：shebang、set -euo pipefail、错误处理、日志、可配置变量
                </div>
              </div>
            </div>
          </div>

          {/* Right result */}
          <div className="flex-1 flex flex-col p-4 overflow-y-auto">
            {!script && !loading && (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
                <ScrollText size={36} className="opacity-25" />
                <div className="text-xs">描述你的需求，AI 生成专业脚本</div>
              </div>
            )}

            {loading && (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
                <Loader2 size={28} className="animate-spin text-[var(--warning)]" />
                <div className="text-xs">AI 正在编写脚本...</div>
                <div className="text-[10px] text-[var(--text-muted)] opacity-70">通常需要 10~60 秒，脚本越长越慢</div>
              </div>
            )}

            {script && !loading && script.parseError && (
              <div className="glass rounded-[6px] p-4 border border-[var(--warning)]/40">
                <div className="flex items-start gap-2.5">
                  <Info size={16} className="text-[var(--warning)] shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[var(--warning)]">脚本生成失败：AI 返回内容解析异常</div>
                    <div className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed">
                      AI 已返回内容，但不是有效的 JSON。常见原因：输出被 max_tokens 截断、模型不支持 JSON 输出。
                      可尝试精简需求描述后重新生成，或在设置中更换模型。
                    </div>
                    {script.rawExcerpt && (
                      <pre className="mt-2.5 px-2.5 py-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] font-mono overflow-x-auto whitespace-pre-wrap max-h-40">
                        {script.rawExcerpt}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            )}

            {script && !loading && !script.parseError && (
              <>
                {script.truncated && (
                  <div className="mb-3 px-3 py-2 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/30 text-[var(--warning)] text-xs">
                    ⚠ AI 输出被截断，脚本主体已抢救展示但末尾可能不完整，部署命令/安全提示缺失，请人工复核后再使用。
                  </div>
                )}

                <div className="glass rounded-[6px] p-4 mb-3">
                  <div className="flex items-start gap-2">
                    <ScrollText size={15} className="text-[var(--warning)] mt-0.5" />
                    <div className="flex-1">
                      <div className="text-sm font-semibold theme-text-primary">{script.title}</div>
                      <div className="text-xs text-[var(--text-secondary)] mt-1">{script.description}</div>
                    </div>
                  </div>
                  {script.safetyNotes.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {script.safetyNotes.map((n, i) => (
                        <div key={i} className="flex items-start gap-1.5 text-[10px] text-[var(--warning)]">
                          <span>⚠️</span>
                          <div>{n}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Bash script */}
                <div className="rounded-[6px] overflow-hidden cmd-code">
                  <div className="flex items-center justify-between px-3 py-2 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)]">
                    <div className="text-xs text-[var(--text-primary)] flex items-center gap-1.5">
                      <Terminal size={12} className="text-[var(--warning)]" /> {script.title}.sh
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => copy(script.bash, 'bash')}
                        className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                      >
                        {copied === 'bash' ? <CheckCheck size={10} /> : <Copy size={10} />}
                        {copied === 'bash' ? '已复制' : '复制'}
                      </button>
                    </div>
                  </div>
                  <pre className="p-3 text-[11px] font-mono text-[var(--success)] overflow-auto max-h-[280px] whitespace-pre">
                    {script.bash}
                  </pre>
                </div>

                {script.cron && (
                  <div className="mt-3">
                    <div className="text-xs text-[var(--text-secondary)] mb-1.5">⏰ Crontab 配置</div>
                    <div className="rounded-lg overflow-hidden cmd-code">
                      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)]">
                        <div className="text-[9px] text-[var(--text-muted)]">crontab -e</div>
                        <button
                          onClick={() => copy(script.cron!, 'cron')}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                        >
                          {copied === 'cron' ? <CheckCheck size={9} /> : <Copy size={9} />}
                          {copied === 'cron' ? '已复制' : '复制'}
                        </button>
                      </div>
                      <pre className="p-2.5 text-[10px] font-mono text-[var(--warning)]">{script.cron}</pre>
                    </div>
                  </div>
                )}

                {script.deployCommands.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs text-[var(--text-secondary)] mb-1.5">🚀 部署命令</div>
                    <div className="space-y-1">
                      {script.deployCommands.map((c, i) => (
                        <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
                          <div className="text-[9px] text-[var(--text-muted)] w-4">{i + 1}.</div>
                          <pre className="flex-1 text-[10px] font-mono text-cyan-300">{c}</pre>
                          <button
                            onClick={() => copy(c, `deploy-${i}`)}
                            className="p-1 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                          >
                            {copied === `deploy-${i}` ? <CheckCheck size={10} /> : <Copy size={10} />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
