import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { X, Copy, Check, Download, ChevronUp, ChevronDown, Search, ScrollText } from 'lucide-react';
import { useModalEscape, backdropClose } from './ui/useModalEscape';

interface Match {
  line: number;
  start: number;
  gi: number;
}

/**
 * 终端"全部输出"查看器：
 * 把 xterm 滚动缓冲完整导出为可搜索、可复制、可导出的文本视图，
 * 解决命令输出过多刷屏后"看不见了"的问题。
 */
export default function TerminalOutputModal({
  lines,
  title,
  onClose
}: {
  lines: string[];
  title: string;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(0);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useModalEscape(onClose);

  const query = q.trim();
  const ql = query.toLowerCase();

  const matches = useMemo<Match[]>(() => {
    if (!ql) return [];
    const out: Match[] = [];
    lines.forEach((l, i) => {
      const low = l.toLowerCase();
      let idx = low.indexOf(ql);
      while (idx !== -1) {
        out.push({ line: i, start: idx, gi: out.length });
        idx = low.indexOf(ql, idx + ql.length);
      }
    });
    return out;
  }, [ql, lines]);

  const byLine = useMemo(() => {
    const m = new Map<number, Match[]>();
    for (const mt of matches) {
      const arr = m.get(mt.line);
      if (arr) arr.push(mt);
      else m.set(mt.line, [mt]);
    }
    return m;
  }, [matches]);

  const n = matches.length;
  const activeGi = n > 0 ? ((cur % n) + n) % n : -1;

  // 滚动到当前匹配
  useEffect(() => {
    if (activeGi < 0) return;
    bodyRef.current?.querySelector(`[data-mi="${activeGi}"]`)?.scrollIntoView({ block: 'center' });
  }, [activeGi, byLine]);

  const goto = (d: number) => {
    if (n === 0) return;
    setCur((c) => (((c + d) % n) + n) % n);
  };

  const copyAll = () => {
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportTxt = () => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nebula-ssh-output-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-6"
      onMouseDown={backdropClose(onClose)}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative glass rounded-[8px] w-full h-full max-w-[980px] max-h-[86vh] flex flex-col overflow-hidden shadow-panel animate-slide-in">
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2 min-w-0">
            <ScrollText size={14} className="text-[var(--accent)] shrink-0" />
            <div className="text-[12px] font-medium text-[var(--text-primary)] truncate">全部输出</div>
            <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">{title}</div>
            <div className="text-[10px] text-[var(--text-muted)] shrink-0">{lines.length} 行</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={copyAll}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-elevated-hover)] transition-colors"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? '已复制' : '复制全部'}
            </button>
            <button
              onClick={exportTxt}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-elevated-hover)] transition-colors"
            >
              <Download size={12} />
              导出 .txt
            </button>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated-hover)] transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* search bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded bg-[var(--bg-elevated)] border border-[var(--border-subtle)] focus-within:border-[var(--accent)]/60 transition-colors">
            <Search size={12} className="text-[var(--text-muted)] shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setCur(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  goto(e.shiftKey ? -1 : 1);
                }
              }}
              placeholder="搜索输出内容，回车跳转下一个匹配"
              className="flex-1 bg-transparent text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => goto(-1)}
              disabled={n === 0}
              className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-secondary)] hover:text-[var(--accent)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-elevated-hover)] disabled:opacity-30 disabled:pointer-events-none transition-colors"
            >
              <ChevronUp size={13} />
            </button>
            <button
              onClick={() => goto(1)}
              disabled={n === 0}
              className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-secondary)] hover:text-[var(--accent)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-elevated-hover)] disabled:opacity-30 disabled:pointer-events-none transition-colors"
            >
              <ChevronDown size={13} />
            </button>
          </div>
          <div className="w-[86px] text-right text-[10px] font-mono text-[var(--text-muted)]">
            {query ? (n > 0 ? `${activeGi + 1} / ${n}` : '0 处匹配') : ''}
          </div>
        </div>

        {/* body */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto py-2 theme-scroll">
          {lines.length === 0 ? (
            <div className="h-full flex items-center justify-center text-[11px] text-[var(--text-muted)]">
              暂无可查看的输出
            </div>
          ) : (
            lines.map((text, i) => (
              <OutputRow
                key={i}
                n={i + 1}
                text={text}
                marks={byLine.get(i)}
                activeGi={activeGi}
                qLen={query.length}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** 单行输出：无匹配的行 props 稳定，搜索/跳转时只重渲染命中行 */
const OutputRow = memo(function OutputRow({
  n,
  text,
  marks,
  activeGi,
  qLen
}: {
  n: number;
  text: string;
  marks?: Match[];
  activeGi: number;
  qLen: number;
}) {
  const active = !!marks && marks.some((m) => m.gi === activeGi);

  let content: React.ReactNode;
  if (!marks || marks.length === 0) {
    content = text || ' ';
  } else {
    const nodes: React.ReactNode[] = [];
    let pos = 0;
    for (let j = 0; j < marks.length; j++) {
      const m = marks[j];
      if (m.start > pos) nodes.push(<span key={`t${j}`}>{text.slice(pos, m.start)}</span>);
      nodes.push(
        <mark
          key={`m${j}`}
          data-mi={m.gi}
          style={
            m.gi === activeGi
              ? { background: 'var(--accent)', color: '#fff', borderRadius: '2px' }
              : { background: 'rgba(96,165,250,0.35)', color: 'inherit', borderRadius: '2px' }
          }
        >
          {text.slice(m.start, m.start + qLen)}
        </mark>
      );
      pos = m.start + qLen;
    }
    if (pos < text.length) nodes.push(<span key="tail">{text.slice(pos)}</span>);
    content = <>{nodes}</>;
  }

  return (
    <div
      className={`flex text-[11px] leading-[16px] font-mono px-2 ${active ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-elevated)]/40'}`}
    >
      <span className="w-12 shrink-0 text-right pr-3 text-[var(--text-muted)] opacity-40 select-none">{n}</span>
      <span className="flex-1 whitespace-pre text-[var(--text-primary)]">{content}</span>
    </div>
  );
});
