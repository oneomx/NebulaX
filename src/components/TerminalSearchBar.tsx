import { useEffect, useRef, useState } from 'react';
import { Search, ChevronUp, ChevronDown, X, CaseSensitive, Regex } from 'lucide-react';
import type { Terminal } from 'xterm';
import type { SearchAddon } from 'xterm-addon-search';

/**
 * 终端内搜索工具条（对标 VS Code / iTerm2）：
 * Ctrl+F 唤起，Enter 下一个 / Shift+Enter 上一个，Esc 关闭；
 * 支持正则与大小写开关；高亮全部命中并显示当前序号/总数。
 */
export default function TerminalSearchBar({
  term,
  searchAddon,
  onClose
}: {
  term: Terminal;
  searchAddon: SearchAddon;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<{ resultIndex: number; resultCount: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const regexError = useRef(false);

  // 订阅插件的结果变更（含高亮总数）
  useEffect(() => {
    const off = searchAddon.onDidChangeResults((r) => setResult(r));
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      off.dispose();
      searchAddon.clearDecorations();
    };
  }, [searchAddon]);

  const options = (incremental: boolean) => ({
    regex,
    caseSensitive,
    incremental,
    decorations: {
      matchBackground: '#3a5a40',
      matchBorder: '#4a7c59',
      matchOverviewRuler: '#4a7c59',
      activeMatchBackground: '#b58900',
      activeMatchBorder: '#d3a10e',
      activeMatchColorOverviewRuler: '#d3a10e'
    }
  });

  const find = (dir: 'next' | 'prev', incremental = false) => {
    if (!q) {
      searchAddon.clearDecorations();
      setResult(null);
      return;
    }
    // 非法正则不报错刷屏，静默等待用户修正
    if (regex) {
      try {
        new RegExp(q);
        regexError.current = false;
      } catch {
        regexError.current = true;
        return;
      }
    }
    if (dir === 'next') searchAddon.findNext(q, options(incremental));
    else searchAddon.findPrevious(q, options(false));
  };

  // 输入即增量搜索
  useEffect(() => {
    if (q) find('next', true);
    else {
      searchAddon.clearDecorations();
      setResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, regex, caseSensitive]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      find(e.shiftKey ? 'prev' : 'next');
    }
  };

  const total = result?.resultCount ?? 0;
  const idx = result && result.resultIndex >= 0 ? result.resultIndex + 1 : 0;

  return (
    <div
      className="absolute top-8 right-3 z-30 glass shadow-panel rounded-lg px-2 py-1.5 flex items-center gap-1.5"
      onKeyDown={onKeyDown}
    >
      <Search size={13} className="text-[var(--text-muted)] shrink-0" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索终端输出…"
        className="w-52 bg-transparent text-[12px] theme-text-primary outline-none placeholder:text-[var(--text-muted)]"
      />
      {/* 正则开关 */}
      <button
        onClick={() => setRegex((v) => !v)}
        title="正则表达式"
        className={`p-1 rounded transition-colors ${
          regex ? 'text-[var(--accent)] bg-[var(--bg-elevated)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
        }`}
      >
        <Regex size={13} />
      </button>
      {/* 大小写开关 */}
      <button
        onClick={() => setCaseSensitive((v) => !v)}
        title="区分大小写"
        className={`p-1 rounded transition-colors ${
          caseSensitive ? 'text-[var(--accent)] bg-[var(--bg-elevated)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
        }`}
      >
        <CaseSensitive size={13} />
      </button>
      <div className="w-px h-3.5 bg-[var(--border-subtle)] mx-0.5" />
      {/* 命中计数 / 正则错误提示 */}
      <span className="text-[10px] tnum text-[var(--text-muted)] min-w-[44px] text-center">
        {regexError.current ? (
          <span className="text-[var(--error)]">无效正则</span>
        ) : q ? (
          total > 0 ? `${idx}/${total}` : '0/0'
        ) : (
          ''
        )}
      </span>
      <button
        onClick={() => find('prev')}
        disabled={!q || total === 0}
        title="上一个 (Shift+Enter)"
        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
      >
        <ChevronUp size={13} />
      </button>
      <button
        onClick={() => find('next')}
        disabled={!q || total === 0}
        title="下一个 (Enter)"
        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
      >
        <ChevronDown size={13} />
      </button>
      <button
        onClick={onClose}
        title="关闭 (Esc)"
        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--error)] transition-colors"
      >
        <X size={13} />
      </button>
    </div>
  );
}
