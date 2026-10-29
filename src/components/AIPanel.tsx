import { useState, useRef, useEffect } from 'react';
import {
  Bot,
  Send,
  Sparkles,
  Play,
  Copy,
  CheckCheck,
  Loader2,
  Trash2,
  ChevronDown,
  ChevronUp,
  X,
  AlertTriangle,
  ShieldCheck,
  Stethoscope,
  BookOpen,
  Activity,
  ScrollText,
  Wrench,
  LayoutGrid,
  Gauge
} from 'lucide-react';
import { useAppStore } from '../store/app';
import { getAPI } from '../lib/api';
import { nanoid } from '../store/nanoid';
import type { AIMessage } from '../types';
import AuditPanel from './ai/AuditPanel';
import DiagnosticAgent from './ai/DiagnosticAgent';
import RunbookPanel from './ai/RunbookPanel';
import HealthDashboard from './ai/HealthDashboard';
import ScriptGenPanel from './ai/ScriptGenPanel';
import PerfTunePanel from './ai/PerfTunePanel';
import ScenarioPicker from './ai/ScenarioPicker';
import VoiceInput from './ai/VoiceInput';
import { getSessionMapping } from '../lib/sessionMap';

const QUICK_PROMPTS = [
  { icon: '🔍', label: '看下内存占用最高的 5 个进程', prompt: '看下内存占用最高的 5 个进程' },
  { icon: '⚡', label: '查看系统负载和 CPU 使用情况', prompt: '查看系统负载和 CPU 使用情况，告诉我有没有异常' },
  { icon: '💾', label: '磁盘空间使用情况', prompt: '磁盘空间使用情况，哪些分区快满了？' },
  { icon: '📊', label: '一键服务器健康巡检', prompt: '帮我做一次服务器健康巡检，总结当前状态，指出潜在问题' },
  { icon: '🔥', label: '最近 5 分钟的日志错误', prompt: '看看系统日志里最近 5 分钟有没有错误或告警，帮我解释' }
];

const TOOLS = [
  { id: 'audit', icon: ShieldCheck, label: '安全审计', desc: '识别弱密码/危险权限', color: '#10b981' },
  { id: 'diagnostic', icon: Stethoscope, label: '根因诊断', desc: '多步 Agent 排障', color: '#f97316' },
  { id: 'runbook', icon: BookOpen, label: '知识库', desc: 'RAG 检索 SOP', color: '#a855f7' },
  { id: 'health', icon: Activity, label: '健康看板', desc: '趋势 + 故障预测', color: '#06b6d4' },
  { id: 'scriptgen', icon: ScrollText, label: '脚本生成', desc: '自然语言写 bash', color: '#f59e0b' },
  { id: 'perf', icon: Gauge, label: '性能调优', desc: '内核/网络/IO 参数建议', color: '#ec4899' }
];

export default function AIPanel() {
  const { aiMessages, addAiMessage, updateAiMessage, clearAiMessages, sessions, activeSessionId } = useAppStore();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [minimizedTools, setMinimizedTools] = useState<string[]>([]);
  const [runningTools, setRunningTools] = useState<Record<string, boolean>>({});
  const [showScenarioPicker, setShowScenarioPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const api = getAPI();

  // 工具窗口调度：最小化 = 保持挂载在后台执行；恢复 = 重新显示
  const minimizeTool = (id: string) => {
    setMinimizedTools((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveTool(null);
  };
  const restoreTool = (id: string) => {
    setMinimizedTools((prev) => prev.filter((x) => x !== id));
    setActiveTool(id);
  };
  const closeTool = (id: string) => {
    setMinimizedTools((prev) => prev.filter((x) => x !== id));
    setRunningTools((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setActiveTool(null);
  };
  const setToolRunning = (id: string, running: boolean) => {
    setRunningTools((prev) => ({ ...prev, [id]: running }));
  };

  const active = sessions.find((s) => s.id === activeSessionId);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [aiMessages]);

  const sendMessage = async (content?: string) => {
    const text = (content || input).trim();
    if (!text || loading) return;

    const userMsg: AIMessage = { id: nanoid(), role: 'user', content: text, ts: Date.now() };
    addAiMessage(userMsg);
    setInput('');
    setLoading(true);

    const aiMsgId = nanoid();
    const aiMsg: AIMessage = { id: aiMsgId, role: 'assistant', content: '...', type: 'text', ts: Date.now() };
    addAiMessage(aiMsg);

    try {
      // Build context
      const sysMsg = {
        role: 'system' as const,
        content: `你是 NebulaX 智能运维助手，帮助用户管理和诊断 Linux 服务器。请用中文回答，简洁、准确、可执行。
当用户询问运维问题时：
1. 优先给出可以直接复制/执行的命令（用 \`\`\` 代码块包裹）
2. 如果需要执行命令才能回答，先给出命令并说明用途，由用户确认后执行
3. 多个步骤请分点列出
4. 涉及危险操作（rm、shutdown、systemctl stop 重要服务等）务必提醒风险
5. 如果上下文中有服务器信息，充分利用这些信息给出针对性建议
${active?.serverInfo ? `\n当前服务器信息：\n主机名: ${active.serverInfo.hostname}\n系统: ${active.serverInfo.os}\nCPU: ${active.serverInfo.cpuModel} (${active.serverInfo.cpuCores} 核)\n内存: ${(active.serverInfo.memUsed / 1024).toFixed(1)}G / ${(active.serverInfo.memTotal / 1024).toFixed(1)}G\n负载: ${active.serverInfo.load?.join(', ')}\n` : ''}`
      };

      const history = aiMessages
        .filter((m) => m.id !== 'welcome' && !m.error)
        .slice(-12)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      // v1.7 富上下文：巡检 + 趋势 + 命令历史 + 日志尾部 + Runbook（需真实 SSH sessionId）
      const realSid = active && !active.external ? getSessionMapping(active.id) : undefined;

      const res = await Promise.race([
        api.aiChat({
          messages: [sysMsg, ...history, { role: 'user', content: text }],
          task: 'chat',
          attachRich: true,
          sessionId: realSid
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('请求超时（30秒）')), 30000)
        )
      ]);

      if (res.ok && res.reply) {
        updateAiMessage(aiMsgId, { content: res.reply });
      } else {
        updateAiMessage(aiMsgId, {
          content: `❌ 出错了：${res.error || '未知错误'}\n\n请在「设置」中检查 API Key 配置。`,
          error: true
        });
      }
    } catch (e: any) {
      updateAiMessage(aiMsgId, {
        content: `❌ 请求失败：${e?.message || String(e)}`,
        error: true
      });
    } finally {
      setLoading(false);
    }
  };

  const executeCommand = async (command: string) => {
    if (!active || active.status !== 'connected') {
      addAiMessage({
        id: nanoid(),
        role: 'assistant',
        content: '⚠️ 当前没有活动的 SSH 会话，无法执行命令。请先连接一台服务器。',
        ts: Date.now(),
        error: true
      });
      return;
    }

    // 使用统一 sessionMap 工具
    const sid = getSessionMapping(active.id);
    if (!sid) return;

    // Send command to terminal as if user typed it
    await api.sshWrite(sid, command + '\n');

    addAiMessage({
      id: nanoid(),
      role: 'assistant',
      content: `✅ 已在终端执行命令：\n\`\`\`bash\n${command}\n\`\`\``,
      ts: Date.now()
    });
  };

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <aside className="w-[380px] flex flex-col border-l border-[var(--border-subtle)] theme-bg-surface/50">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border-subtle)]">
        <div className="w-7 h-7 rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)]">
          <Bot size={14} strokeWidth={1.8} />
        </div>
        <div className="flex-1">
          <div className="text-[13px] font-semibold theme-text-primary">AI 运维助手</div>
          <div className="text-[10px] text-[var(--text-muted)]">自然语言转命令 · 报错分析 · 智能巡检</div>
        </div>
        <button
          onClick={clearAiMessages}
          title="清空对话"
          className="p-1.5 rounded-[5px] hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {aiMessages.map((m) => (
          <MessageBubble
            key={m.id}
            msg={m}
            onExecute={executeCommand}
            onCopy={copyText}
            copiedId={copiedId}
            expanded={expanded[m.id]}
            toggleExpand={() => setExpanded((c) => ({ ...c, [m.id]: !c[m.id] }))}
          />
        ))}

        {loading && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            <span>AI 思考中...</span>
          </div>
        )}
      </div>

      {/* AI 工具箱 */}
      <div className="px-3 pb-2">
        <div className="text-[10px] text-[var(--text-muted)] mb-2 flex items-center gap-1">
          <Wrench size={10} className="text-[var(--accent)]" />
          AI 工具箱
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => (minimizedTools.includes(t.id) ? restoreTool(t.id) : setActiveTool(t.id))}
              className="flex flex-col items-center gap-1 py-2 rounded-lg bg-[var(--bg-elevated)] hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition border border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
              title={t.desc}
            >
              <t.icon size={14} style={{ color: t.color }} />
              <div className="text-[9px] leading-tight">{t.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Quick prompts */}
      <div className="px-3 pb-2">
        <div className="text-[10px] text-[var(--text-muted)] mb-2 flex items-center gap-1">
          <Sparkles size={10} className="text-[var(--accent-secondary)]" />
          快捷指令
          <button
            onClick={() => setShowScenarioPicker(true)}
            className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] text-[9px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition"
            title="4 类 23 个场景预设：运维排障 / 安全合规 / 数据库运维 / 性能调优"
          >
            <LayoutGrid size={9} />
            场景库
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_PROMPTS.map((q, i) => (
            <button
              key={i}
              onClick={() => sendMessage(q.prompt)}
              disabled={loading}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-[4px] text-[10px] bg-[var(--bg-elevated)] hover:bg-[var(--bg-elevated-hover)] text-[var(--text-secondary)] transition-colors border border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
            >
              <span>{q.icon}</span>
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="p-3 border-t border-[var(--border-subtle)]">
        <div className="flex items-end gap-2">
          <VoiceInput onResult={(text) => setInput((prev) => (prev ? prev + ' ' : '') + text)} className="mb-1" />
          <div className="flex-1 relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="描述你要做的事... (Shift+Enter 换行，可语音)"
              rows={2}
              className="w-full resize-none rounded-[6px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2.5 pr-10 text-xs theme-text-primary placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] transition-colors"
            />
            <button
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              className="absolute right-2 bottom-2 p-1.5 rounded-[5px] theme-btn-primary disabled:opacity-40"
            >
              <Send size={13} />
            </button>
          </div>
        </div>
        <div className="text-[9px] text-[var(--text-muted)] mt-1.5 px-1">
          AI 生成的命令需要您确认后才会执行 · Enter 发送
        </div>
      </div>

      {/* Tool panels：激活时全屏显示；最小化时保持挂载在后台执行 */}
      {(activeTool === 'audit' || minimizedTools.includes('audit')) && (
        <AuditPanel
          onClose={() => closeTool('audit')}
          onMinimize={() => minimizeTool('audit')}
          minimized={activeTool !== 'audit'}
          onStatusChange={(r) => setToolRunning('audit', r)}
          sessionId={activeSessionId}
        />
      )}
      {(activeTool === 'diagnostic' || minimizedTools.includes('diagnostic')) && (
        <DiagnosticAgent
          onClose={() => closeTool('diagnostic')}
          onMinimize={() => minimizeTool('diagnostic')}
          minimized={activeTool !== 'diagnostic'}
          onStatusChange={(r) => setToolRunning('diagnostic', r)}
          sessionId={activeSessionId}
        />
      )}
      {(activeTool === 'runbook' || minimizedTools.includes('runbook')) && (
        <RunbookPanel
          onClose={() => closeTool('runbook')}
          onMinimize={() => minimizeTool('runbook')}
          minimized={activeTool !== 'runbook'}
          onStatusChange={(r) => setToolRunning('runbook', r)}
          onUseContext={(ctx) => setInput(ctx)}
        />
      )}
      {(activeTool === 'health' || minimizedTools.includes('health')) && (
        <HealthDashboard
          onClose={() => closeTool('health')}
          onMinimize={() => minimizeTool('health')}
          minimized={activeTool !== 'health'}
          onStatusChange={(r) => setToolRunning('health', r)}
          sessionId={activeSessionId}
        />
      )}
      {(activeTool === 'scriptgen' || minimizedTools.includes('scriptgen')) && (
        <ScriptGenPanel
          onClose={() => closeTool('scriptgen')}
          onMinimize={() => minimizeTool('scriptgen')}
          minimized={activeTool !== 'scriptgen'}
          onStatusChange={(r) => setToolRunning('scriptgen', r)}
          sessionId={activeSessionId}
        />
      )}
      {(activeTool === 'perf' || minimizedTools.includes('perf')) && (
        <PerfTunePanel
          onClose={() => closeTool('perf')}
          onMinimize={() => minimizeTool('perf')}
          minimized={activeTool !== 'perf'}
          onStatusChange={(r) => setToolRunning('perf', r)}
          sessionId={activeSessionId}
        />
      )}

      {/* 场景预设选择器：选中后把 quickPrompt 作为问题发送 */}
      {showScenarioPicker && (
        <ScenarioPicker
          onClose={() => setShowScenarioPicker(false)}
          onSelect={(s) => {
            setShowScenarioPicker(false);
            void sendMessage(s.quickPrompt);
          }}
        />
      )}

      {/* 后台任务坞：显示最小化运行中的工具，点击恢复 */}
      {minimizedTools.length > 0 && (
        <div className="fixed right-[396px] bottom-4 z-[60] flex flex-col gap-2">
          {minimizedTools.map((id) => {
            const t = TOOLS.find((x) => x.id === id);
            if (!t) return null;
            const running = runningTools[id];
            return (
              <div
                key={id}
                className="glass flex items-center gap-2.5 pl-3 pr-2 py-2 rounded-[8px] border border-[var(--border-subtle)] shadow-panel"
              >
                <t.icon size={14} style={{ color: t.color }} className={running ? 'animate-pulse-soft' : ''} />
                <div className="min-w-0">
                  <div className="text-[11px] theme-text-primary font-medium leading-tight">{t.label}</div>
                  <div className="text-[9px] text-[var(--text-muted)] leading-tight">
                    {running ? (
                      <span className="flex items-center gap-1">
                        <Loader2 size={9} className="animate-spin" />
                        后台运行中...
                      </span>
                    ) : (
                      '已就绪 · 后台待命'
                    )}
                  </div>
                </div>
                <button
                  onClick={() => restoreTool(id)}
                  title="恢复窗口"
                  className="p-1.5 rounded-[5px] hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  onClick={() => closeTool(id)}
                  title="关闭"
                  className="p-1.5 rounded-[5px] hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--error)]"
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

function MessageBubble({
  msg,
  onExecute,
  onCopy,
  copiedId,
  expanded,
  toggleExpand
}: {
  msg: AIMessage;
  onExecute: (cmd: string) => void;
  onCopy: (text: string, id: string) => void;
  copiedId: string | null;
  expanded: boolean;
  toggleExpand: () => void;
}) {
  const isUser = msg.role === 'user';
  const isLong = msg.content.length > 600;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[92%] ${isUser ? '' : ''}`}>
        {/* role badge */}
        {!isUser && (
          <div className="flex items-center gap-1.5 mb-1.5 px-1">
            <div className="w-4 h-4 rounded-[3px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)]">
              <Bot size={9} strokeWidth={2} />
            </div>
            <span className="text-[10px] text-[var(--text-muted)]">AI</span>
            {msg.error && <AlertTriangle size={10} className="text-[var(--error)]" />}
          </div>
        )}

        <div
          className={`rounded-[6px] px-3.5 py-2.5 text-xs leading-relaxed ${
            isUser
              ? 'bg-[var(--solid-accent)] text-[var(--accent-contrast)]'
              : msg.error
              ? 'glass-light border border-[var(--error)]/30 text-[var(--text-secondary)]'
              : 'glass text-[var(--text-secondary)]'
          }`}
        >
          {/* Parse content with code blocks */}
          <MessageContent content={msg.content} onExecute={onExecute} onCopy={onCopy} copiedId={copiedId} />
        </div>

        {/* actions */}
        {!isUser && !msg.error && (
          <div className="flex items-center gap-1.5 mt-1 px-1">
            {isLong && (
              <button
                onClick={toggleExpand}
                className="flex items-center gap-1 text-[9px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                {expanded ? '收起' : '展开全文'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MessageContent({
  content,
  onExecute,
  onCopy,
  copiedId
}: {
  content: string;
  onExecute: (cmd: string) => void;
  onCopy: (text: string, id: string) => void;
  copiedId: string | null;
}) {
  const parts = content.split(/(```[\s\S]*?```|`[^`]+`)/g);

  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('```')) {
          const code = p.replace(/```\w*\n?/g, '').replace(/```$/, '').trim();
          return (
            <div key={i} className="my-2 rounded-[5px] overflow-hidden cmd-code">
              <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)]">
                <div className="text-[9px] text-[var(--text-muted)] font-mono uppercase tracking-wider">bash</div>
                <div className="flex gap-1">
                  <button
                    onClick={() => onCopy(code, `code-${i}`)}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-[3px] text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated-hover)]"
                  >
                    {copiedId === `code-${i}` ? <CheckCheck size={9} /> : <Copy size={9} />}
                    {copiedId === `code-${i}` ? '已复制' : '复制'}
                  </button>
                  <button
                    onClick={() => onExecute(code)}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-[3px] text-[9px] theme-btn-primary"
                  >
                    <Play size={9} />
                    执行
                  </button>
                </div>
              </div>
              <pre className="p-3 text-[11px] font-mono text-[var(--accent)] overflow-x-auto whitespace-pre-wrap">
                {code}
              </pre>
            </div>
          );
        } else if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
          return (
            <code key={i} className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--accent)] text-[10px] font-mono">
              {p.slice(1, -1)}
            </code>
          );
        } else {
          return (
            <span key={i} className="whitespace-pre-wrap">
              {p}
            </span>
          );
        }
      })}
    </>
  );
}
