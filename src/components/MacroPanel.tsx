import { useState } from 'react';
import { Circle, Square, Play, Trash2, X, Zap } from 'lucide-react';
import { useAppStore } from '../store/app';
import { getAPI } from '../lib/api';

/**
 * 宏 / 快捷指令面板：
 * - 录制：捕获终端按键序列，命名保存（持久化）
 * - 回放：按顺序写入当前已连接会话（逐条 30ms 间隔，避免刷屏丢键）
 * - 宏本身即快捷指令：保存一条 `htop\r` 就是最常用的快速命令
 */
export default function MacroPanel({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const { macros, recordingKeys, startMacroRecording, stopMacroRecording, cancelMacroRecording, removeMacro } =
    useAppStore();
  const [name, setName] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);

  const recording = recordingKeys !== null;

  const play = async (id: string) => {
    const macro = macros.find((m) => m.id === id);
    if (!macro || !sessionId || playingId) return;
    setPlayingId(id);
    try {
      const api = getAPI();
      for (const k of macro.keys) {
        await api.sshWrite(sessionId, k);
        await new Promise((r) => setTimeout(r, 30));
      }
    } finally {
      setPlayingId(null);
    }
  };

  const onSave = () => {
    if (!name.trim()) return;
    stopMacroRecording(name);
    setName('');
  };

  return (
    <div className="absolute right-3 bottom-3 z-40 w-[320px] glass shadow-panel rounded-xl flex flex-col overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-1.5">
          <Zap size={13} className="text-[var(--accent)]" />
          <span className="text-[12px] font-medium theme-text-primary">宏 / 快捷指令</span>
          {recording && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--error)]">
              <Circle size={7} fill="currentColor" className="animate-pulse" />
              录制中（{recordingKeys!.length} 键）
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          <X size={13} />
        </button>
      </div>

      {/* 录制控制区 */}
      <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
        {recording ? (
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') onSave();
              }}
              placeholder="宏名称（如：重启 nginx）"
              autoFocus
              className="flex-1 bg-[var(--bg-elevated)] rounded px-2 py-1 text-[12px] theme-text-primary outline-none border border-[var(--border-subtle)] focus:border-[var(--accent)]"
            />
            <button
              onClick={onSave}
              disabled={!name.trim()}
              className="px-2.5 py-1 rounded theme-btn-primary text-[11px] disabled:opacity-40"
            >
              保存
            </button>
            <button
              onClick={() => {
                cancelMacroRecording();
                setName('');
              }}
              className="px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--error)] border border-[var(--border-subtle)]"
            >
              放弃
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={startMacroRecording}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] text-[var(--error)] border border-[var(--error)]/40 hover:bg-[var(--error)]/10 transition-colors"
            >
              <Circle size={8} fill="currentColor" />
              开始录制
            </button>
            <span className="text-[10px] text-[var(--text-muted)]">在终端里的按键将被顺序记录</span>
          </div>
        )}
      </div>

      {/* 宏列表 */}
      <div className="max-h-[240px] overflow-y-auto">
        {macros.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">
            还没有宏。点击「开始录制」，把常用命令序列存成一键指令。
          </div>
        ) : (
          macros.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-elevated)] group"
            >
              <div className="min-w-0">
                <div className="text-[12px] theme-text-primary truncate">{m.name}</div>
                <div className="text-[10px] text-[var(--text-muted)] truncate font-mono">
                  {m.keys
                    .join('')
                    .replace(/\r/g, '⏎')
                    .slice(0, 48)}
                </div>
              </div>
              <div className="flex items-center gap-0.5 shrink-0 ml-2">
                <button
                  onClick={() => void play(m.id)}
                  disabled={!sessionId || !!playingId}
                  title={sessionId ? '回放到当前会话' : '无已连接会话'}
                  className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--success)] hover:bg-[var(--bg-elevated-hover)] disabled:opacity-30"
                >
                  <Play size={13} />
                </button>
                <button
                  onClick={() => removeMacro(m.id)}
                  title="删除宏"
                  className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-elevated-hover)] opacity-0 group-hover:opacity-100"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
