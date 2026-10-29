import { Terminal, Bot, Cpu, ArrowRight, Plus, Command } from 'lucide-react';

export default function WelcomeScreen({ onNewConnection }: { onNewConnection: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-10">
      <div className="max-w-xl w-full">
        {/* 顶部标识：细线 + 标签 */}
        <div className="flex items-center gap-3 mb-8">
          <div className="h-px flex-1 bg-[var(--border-subtle)]" />
          <span className="text-[10px] tracking-[0.3em] uppercase text-[var(--text-muted)]">Server Operations</span>
          <div className="h-px flex-1 bg-[var(--border-subtle)]" />
        </div>

        {/* 标题区 */}
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight theme-text-primary mb-3">
          连接你的服务器
        </h1>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)] max-w-md mb-8">
          安全的 SSH 会话管理，辅以智能运维工具，帮助你更快地发现、诊断与处理问题。
        </p>

        <button
          onClick={onNewConnection}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-[6px] theme-btn-primary text-[13px] font-medium"
        >
          <Plus size={15} strokeWidth={2.2} />
          新建 SSH 连接
          <ArrowRight size={14} strokeWidth={1.8} className="opacity-70" />
        </button>

        {/* 能力列表：线条分隔，不用卡片 */}
        <div className="mt-12 border-t border-[var(--border-subtle)]">
          {[
            {
              icon: <Terminal size={15} strokeWidth={1.6} />,
              title: '多标签终端',
              desc: '多会话并行管理，完整 ANSI 色彩支持'
            },
            {
              icon: <Bot size={15} strokeWidth={1.6} />,
              title: 'AI 运维助手',
              desc: '自然语言描述问题，获得可执行的诊断命令'
            },
            {
              icon: <Cpu size={15} strokeWidth={1.6} />,
              title: '实时服务器信息',
              desc: '连接即刻呈现资源占用、进程与服务状态'
            }
          ].map((f, i) => (
            <div
              key={f.title}
              className={`flex items-start gap-4 py-4 ${
                i !== 2 ? 'border-b border-[var(--border-subtle)]' : ''
              }`}
            >
              <div className="w-8 h-8 rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)] shrink-0 mt-0.5">
                {f.icon}
              </div>
              <div>
                <div className="text-[13px] font-medium theme-text-primary">{f.title}</div>
                <div className="text-xs text-[var(--text-muted)] mt-0.5 leading-relaxed">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* 底部提示 */}
        <div className="mt-10 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
          <Command size={11} strokeWidth={1.8} />
          <span>支持密码与 SSH Key 两种认证方式 · 配置仅存本机</span>
        </div>
      </div>
    </div>
  );
}
