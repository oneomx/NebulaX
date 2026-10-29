import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, Send, TerminalSquare, Loader2, Eraser, AlertTriangle, Lightbulb, FileText } from 'lucide-react';
import type { Terminal } from 'xterm';
import { getAPI } from '../lib/api';

/**
 * 终端内嵌 AI 助手（v1.4）
 * - 上下文感知：自动携带终端当前屏幕内容（最近输出 + 选中文本）
 * - 多轮对话：侧边抽屉式面板，边看终端边问
 * - 命令落地：回复中的 shell 命令可一键插入终端（不自动回车，人工确认后执行）
 */
interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

const QUICK_ACTIONS = [
  { id: 'error', label: '解释最近的报错', icon: AlertTriangle, prompt: '终端最近的输出里有报错，请定位错误原因并给出修复建议。' },
  { id: 'explain', label: '解释当前屏幕', icon: FileText, prompt: '请解释终端当前屏幕上的内容在做什么。' },
  { id: 'next', label: '下一步怎么做', icon: Lightbulb, prompt: '根据当前终端状态，我接下来应该执行什么操作？请给出具体命令。' }
];

/** 抽取回复中的 shell 命令代码块（第一个 sh/bash/console 块，或无语言标注块） */
function extractCommands(reply: string): string[] {
  const out: string[] = [];
  const re = /```(?:sh|bash|shell|console|zsh)?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) {
    const body = m[1]
      .split('\n')
      .map((l) => l.replace(/^\s*[$#%]\s*/, '')) // 去掉 $ / # 提示符
      .join('\n')
      .trim();
    if (body && !body.includes('\n')) out.push(body); // 只收单行命令，避免误插脚本
    if (out.length >= 5) break;
  }
  return out;
}

/** 极简 markdown 渲染：代码块 + 行内代码 + 换行（不引第三方库） */
function renderContent(text: string) {
  const parts = text.split(/```([\s\S]*?)```/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      // 代码块：去掉首行语言标注
      const nl = part.indexOf('\n');
      const body = nl >= 0 ? part.slice(nl + 1) : part;
      return (
        <pre
          key={i}
          className="my-1.5 px-2.5 py-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[11px] font-mono theme-text-primary overflow-x-auto whitespace-pre-wrap break-all"
        >
          {body.replace(/\n$/, '')}
        </pre>
      );
    }
    return part.split('\n').map((line, j) => {
      if (!line.trim()) return <div key={`${i}-${j}`} className="h-2" />;
      // 行内 `code`
      const segs = line.split(/`([^`]+)`/g);
      return (
        <p key={`${i}-${j}`} className="text-[12px] leading-relaxed theme-text-primary">
          {segs.map((s, k) =>
            k % 2 === 1 ? (
              <code key={k} className="px-1 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--accent)] font-mono text-[11px]">
                {s}
              </code>
            ) : (
              <span key={k}>{s}</span>
            )
          )}
        </p>
      );
    });
  });
}

export default function TerminalAIPanel({
  term,
  sessionId,
  host,
  onClose
}: {
  term: Terminal | null;
  sessionId: string | null;
  host: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  /** 收集终端上下文：选中文本优先，否则最近 60 行屏幕输出 */
  const collectContext = (): string => {
    if (!term) return '';
    const sel = term.getSelection();
    const lines: string[] = [];
    const buf = term.buffer.normal;
    const start = Math.max(0, buf.length - 60);
    for (let i = start; i < buf.length; i++) {
      const l = buf.getLine(i);
      if (l) lines.push(l.translateToString(true));
    }
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    const screen = lines.join('\n');
    const parts: string[] = [];
    if (sel.trim()) parts.push(`用户在终端选中的文本：\n${sel.trim().slice(0, 2000)}`);
    if (screen) parts.push(`终端当前屏幕输出（最近部分）：\n${screen.slice(-4000)}`);
    return parts.join('\n\n');
  };

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput('');
    const ctx = collectContext();
    const userMsg: Msg = { role: 'user', content: q };
    const nextMessages: Msg[] = [...messages, userMsg];
    setMessages(nextMessages);
    setBusy(true);
    try {
      const system =
        '你是 NebulaX 终端内嵌的 AI 运维助手，服务于一名正在操作服务器的工程师。' +
        '回答要求：中文、直接、可操作；优先给出具体命令；命令放在 ``` 代码块中（单行一条，方便用户一键插入终端执行）。' +
        '如果用户问的问题从终端输出里看不出来，就直接说明并询问关键信息，不要编造屏幕内容。';
      const history = nextMessages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
      const res = await getAPI().aiChat({
        messages: [{ role: 'system' as const, content: system + (ctx ? `\n\n【终端上下文】\n${ctx}` : '') }, ...history],
        // 解释/问答类请求无需默认 2000 tokens：限制回复长度可明显缩短非流式等待
        config: { maxTokens: 1500 },
        // v1.7 富上下文：巡检 + 趋势 + 命令历史 + 日志尾部 + Runbook（根因类问题有据可依）
        attachRich: true,
        task: 'chat',
        sessionId: sessionId || undefined
      });
      setMessages((cur) => [
        ...cur,
        { role: 'assistant', content: res.ok ? res.reply || '（AI 未返回内容）' : `⚠️ AI 请求失败：${res.error || '未知错误'}\n\n请在「设置」中检查 AI 服务商配置（支持 Ollama 本地模型）。` }
      ]);
    } catch (e: any) {
      setMessages((cur) => [...cur, { role: 'assistant', content: `⚠️ AI 请求异常：${e?.message || e}` }]);
    } finally {
      setBusy(false);
    }
  };

  /** 插入命令到终端：写入但不回车，人工确认后按回车执行 */
  const insertCommand = async (cmd: string) => {
    if (!sessionId || !term) return;
    term.focus();
    await getAPI().sshWrite(sessionId, cmd);
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastCommands = lastAssistant ? extractCommands(lastAssistant.content) : [];

  return (
    <div className="absolute right-0 top-0 bottom-0 z-40 w-[360px] glass shadow-panel border-l border-[var(--border-subtle)] flex flex-col">
      {/* 头部 */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-1.5">
          <Sparkles size={13} className="text-[var(--accent)]" />
          <span className="text-[12px] font-medium theme-text-primary">AI 运维助手</span>
          <span className="text-[10px] text-[var(--text-muted)] truncate max-w-[120px]" title={host}>
            {host}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              title="清空对话"
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <Eraser size={12} />
            </button>
          )}
          <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* 消息区 */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2.5">
        {messages.length === 0 && (
          <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">
            <p className="mb-2">基于当前终端屏幕内容回答你的问题，例如：</p>
            <ul className="list-disc pl-4 space-y-1 mb-3">
              <li>「这个报错是什么意思？怎么修？」</li>
              <li>「磁盘快满了，帮我给清理命令」</li>
              <li>「刚才这条命令的输出说明什么？」</li>
            </ul>
            <p className="text-[10px] opacity-70">选中终端里的文本再提问，AI 会优先分析选中内容。</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div
              className={
                m.role === 'user'
                  ? 'max-w-[85%] px-2.5 py-1.5 rounded-lg bg-[var(--accent)]/15 text-[12px] theme-text-primary whitespace-pre-wrap break-words'
                  : 'max-w-full'
              }
            >
              {m.role === 'assistant' ? renderContent(m.content) : m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <Loader2 size={12} className="animate-spin" />
            思考中…
          </div>
        )}
      </div>

      {/* 最近回复中的命令：一键插入 */}
      {lastCommands.length > 0 && !busy && (
        <div ref={listRef} className="shrink-0 px-3 pb-1.5 space-y-1">
          <div className="text-[10px] text-[var(--text-muted)]">快捷插入（写入终端，回车前可修改）：</div>
          {lastCommands.map((cmd, i) => (
            <button
              key={i}
              onClick={() => void insertCommand(cmd)}
              disabled={!sessionId}
              title={sessionId ? '插入到终端输入行' : '无已连接会话'}
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded bg-[var(--bg-elevated)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/40 text-left group disabled:opacity-40"
            >
              <TerminalSquare size={11} className="text-[var(--accent)] shrink-0" />
              <code className="flex-1 min-w-0 truncate text-[11px] font-mono theme-text-primary">{cmd}</code>
              <span className="text-[9px] text-[var(--text-muted)] group-hover:text-[var(--accent)] shrink-0">插入</span>
            </button>
          ))}
        </div>
      )}

      {/* 快捷动作 */}
      <div className="shrink-0 flex items-center gap-1 px-3 pb-1.5">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.id}
            onClick={() => void send(a.prompt)}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] transition-colors disabled:opacity-40"
          >
            <a.icon size={10} />
            {a.label}
          </button>
        ))}
      </div>

      {/* 输入区 */}
      <div className="shrink-0 px-3 pb-3">
        <div className="flex items-end gap-1.5 bg-[var(--bg-elevated)] rounded-lg border border-[var(--border-subtle)] focus-within:border-[var(--accent)] p-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            onFocus={(e) => e.stopPropagation()}
            placeholder={sessionId ? '问点什么…（Enter 发送）' : '问点什么…（当前无已连接会话）'}
            rows={2}
            className="flex-1 bg-transparent resize-none text-[12px] theme-text-primary outline-none px-1 placeholder:text-[var(--text-muted)]"
          />
          <button
            onClick={() => void send()}
            disabled={busy || !input.trim()}
            className="p-1.5 rounded theme-btn-primary disabled:opacity-40 shrink-0"
            title="发送"
          >
            <Send size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
