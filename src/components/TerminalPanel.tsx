import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon } from 'xterm-addon-search';
import { ScrollText, Copy, Scissors, ClipboardPaste, CheckSquare, Eraser, Search, Zap, LineChart, Sparkles } from 'lucide-react';
import 'xterm/css/xterm.css';
import { getAPI } from '../lib/api';
import { getTerminalTheme } from '../lib/terminalThemes';
import { getSessionMapping } from '../lib/sessionMap';
import { getLineContext, fetchCompletions, type CompletionItem, type LineContext } from '../lib/completion';
import { aiSuggest } from '../lib/aiSuggest';
import { useAppStore } from '../store/app';
import { useThemeStore } from '../store/theme';
import type { SessionTab } from '../types';
import TerminalOutputModal from './TerminalOutputModal';
import TerminalSearchBar from './TerminalSearchBar';
import MacroPanel from './MacroPanel';
import SerialPlotter from './SerialPlotter';
import TerminalAIPanel from './TerminalAIPanel';

/**
 * 终端实例缓存：切标签/切到文件视图时组件会卸载重建，
 * 若直接 dispose 会丢失全部滚动缓冲（命令输出"看不见了"）。
 * 这里让终端实例（含缓冲与数据订阅）活在模块缓存里，
 * 重挂载时把已有 DOM 挂回新容器即可完整恢复；关闭标签/分屏时才真正销毁。
 */
interface CachedTerminal {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  destroy: () => void;
}

const termCache = new Map<string, CachedTerminal>();

/** 关闭标签/分屏时调用：真正销毁终端与其缓冲 */
export function disposeTerminalCache(key: string): void {
  const entry = termCache.get(key);
  if (entry) {
    termCache.delete(key);
    try {
      entry.destroy();
    } catch {
      /* ignore */
    }
  }
}

/** 读取滚动缓冲全文（去掉行尾空白与末尾空行），供输出查看器使用 */
export function readTerminalBuffer(term: Terminal): string[] {
  const buf = term.buffer.normal;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

function createCachedTerminal(
  key: string,
  tabId: string,
  container: HTMLElement,
  theme: Parameters<typeof getTerminalTheme>[0]
): CachedTerminal {
  const term = new Terminal({
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Consolas', 'Menlo', monospace",
    cursorBlink: true,
    cursorStyle: 'bar',
    theme: getTerminalTheme(theme),
    allowTransparency: true,
    scrollback: 10000
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  const search = new SearchAddon();
  term.loadAddon(search);
  term.open(container);

  const api = getAPI();
  // 数据/关闭/错误订阅跟随终端生命周期（而非组件挂载生命周期），
  // 这样切到其他标签时输出继续写入缓冲，切回来即可完整看到
  const off = api.onSshData((sid, data) => {
    if (getSessionMapping(key) === sid) {
      term.write(data);
    }
  });
  const offClose = api.onSshClose((sid) => {
    if (getSessionMapping(key) === sid) {
      term.write('\r\n\x1b[31m[连接已关闭]\x1b[0m\r\n');
      useAppStore.getState().updateSession(tabId, { status: 'disconnected' });
    }
  });
  const offError = api.onSshError((sid, message) => {
    if (getSessionMapping(key) === sid) {
      term.write(`\r\n\x1b[31m[连接错误] ${message}\x1b[0m\r\n`);
      useAppStore.getState().updateSession(tabId, { status: 'error', error: message });
    }
  });
  const offReconnecting = (api as any).onSshReconnecting?.((sid: string, info: { attempt: number; max: number }) => {
    if (getSessionMapping(key) === sid) {
      term.write(`\r\n\x1b[33m[网络中断，自动重连中… 第 ${info.attempt}/${info.max} 次]\x1b[0m\r\n`);
      useAppStore.getState().updateSession(tabId, { status: 'connecting', error: undefined });
    }
  });
  const offReconnected = (api as any).onSshReconnected?.((sid: string) => {
    if (getSessionMapping(key) === sid) {
      term.write(`\r\n\x1b[32m[已重连]\x1b[0m\r\n`);
      useAppStore.getState().updateSession(tabId, { status: 'connected', error: undefined });
    }
  });

  return {
    term,
    fit,
    search,
    destroy: () => {
      off();
      offClose();
      offError();
      offReconnecting?.();
      offReconnected?.();
      term.dispose();
    }
  };
}

export default function TerminalPanel({ session, mapKey }: { session: SessionTab; mapKey?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const theme = useThemeStore((s) => s.theme);
  const recording = useAppStore((s) => s.recordingKeys !== null);
  const recordingKeys = useAppStore((s) => s.recordingKeys);
  // 串口会话才有绘图入口
  const isSerial = useAppStore((s) => {
    const conn = s.connections.find((c) => c.id === session.connectionId);
    return (conn?.type || 'ssh') === 'serial';
  });
  // mapKey 用于 sessionMap 索引：分屏时每个 pane 用 paneId，否则用 tab id
  const key = mapKey || session.id;
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [macroOpen, setMacroOpen] = useState(false);
  const [plotOpen, setPlotOpen] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSel: boolean } | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const tipTimer = useRef<number | null>(null);

  // ---------- 命令智能补全（IDEA 式弹窗） ----------
  const [comp, setComp] = useState<{
    items: CompletionItem[];
    index: number;
    word: string;
    x: number;
    y: number;
  } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const compRef = useRef<typeof comp>(null);
  compRef.current = comp;
  const compTimer = useRef<number | null>(null);
  const compSeq = useRef(0);
  const aiSeq = useRef(0);
  const aiThrottle = useRef(0);
  const compListRef = useRef<HTMLDivElement>(null);

  // 选中项始终滚入可视区（↑↓ 导航时）
  useEffect(() => {
    if (!comp) return;
    compListRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [comp?.index, comp?.items]);

  const closeComp = () => setComp(null);

  // 计算光标屏幕坐标（弹窗定位）
  const cursorScreenPos = (): { x: number; y: number } | null => {
    const term = termRef.current;
    const el = term?.element;
    if (!term || !el) return null;
    const rect = el.getBoundingClientRect();
    const cellW = rect.width / term.cols;
    const cellH = rect.height / term.rows;
    const buf = term.buffer.active;
    return {
      x: rect.left + buf.cursorX * cellW,
      y: rect.top + (buf.cursorY + 1) * cellH
    };
  };

  const runComp = async (force = false) => {
    const term = termRef.current;
    if (!term) return;
    const sid = getSessionMapping(key);
    if (!sid) {
      closeComp();
      return;
    }
    const ctx = getLineContext(term);
    if (!ctx) return;
    const seq = ++compSeq.current;
    const items = await fetchCompletions(getAPI(), sid, ctx, force);
    // 丢弃过期结果（输入已变化）
    if (seq !== compSeq.current) return;
    if (items.length === 0 && !force) {
      closeComp();
      return;
    }
    const pos = cursorScreenPos();
    if (!pos) return;
    setComp({ items, index: 0, word: ctx.word, x: pos.x, y: pos.y });
    // 并行触发 AI 联想（结果回来后合并到列表顶部）
    void runAiSuggest(ctx, seq);
  };

  // AI 联想：猜参数 + 给解释，回来后合并进弹窗
  const AI_SUGGEST_MIN_INTERVAL_MS = 800;
  const runAiSuggest = async (ctx: LineContext, seq: number) => {
    // 独立节流：本地补全可每次按键触发，AI 请求最快每 800ms 一次
    const now = Date.now();
    if (now - aiThrottle.current < AI_SUGGEST_MIN_INTERVAL_MS) return;
    aiThrottle.current = now;
    const myAi = ++aiSeq.current;
    setAiBusy(true);
    try {
      const aiItems = await aiSuggest(getAPI(), ctx);
      if (myAi !== aiSeq.current || seq !== compSeq.current || aiItems.length === 0) return;
      setComp((c) => {
        if (!c) return c;
        // AI 候选置顶，按 label 去重（本地同名候选让位给带解释的 AI 版）
        const rest = c.items.filter((it) => !aiItems.some((a) => a.label === it.label));
        const merged = [...aiItems, ...rest].slice(0, 40);
        // 尽量保持用户当前选中项不跳
        const curLabel = c.items[c.index]?.label;
        const idx = Math.max(0, merged.findIndex((it) => it.label === curLabel));
        return { ...c, items: merged, index: curLabel ? idx : 0 };
      });
    } catch {
      /* AI 不可用时静默降级为纯本地补全 */
    } finally {
      if (myAi === aiSeq.current) setAiBusy(false);
    }
  };

  // 输入停顿后自动触发
  const scheduleComp = () => {
    if (compTimer.current) window.clearTimeout(compTimer.current);
    compTimer.current = window.setTimeout(() => void runComp(false), 250);
  };
  const scheduleCompRef = useRef(scheduleComp);
  scheduleCompRef.current = scheduleComp;

  // 采纳候选：删除当前词并输入候选文本
  const acceptComp = (label: string) => {
    const term = termRef.current;
    if (!term) return;
    const ctx = getLineContext(term);
    const del = ctx ? ctx.word.length : compRef.current?.word.length || 0;
    const sid = getSessionMapping(key);
    if (sid) {
      void getAPI().sshWrite(sid, '\x7f'.repeat(del) + label);
    }
    closeComp();
  };

  const moveComp = (delta: number) => {
    setComp((c) => {
      if (!c || c.items.length === 0) return c;
      const n = c.items.length;
      return { ...c, index: (c.index + delta + n) % n };
    });
  };

  const showTip = (msg: string) => {
    setTip(msg);
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip(null), 1800);
  };

  // ---------- 复制 / 剪切 / 粘贴 / 全选 ----------
  const copySelection = async () => {
    const term = termRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (!sel) {
      showTip('未选中内容');
      return;
    }
    const res = await getAPI().clipboardWrite?.(sel);
    showTip(res?.ok === false ? res.error || '复制失败' : '已复制');
    term.clearSelection();
  };

  const cutSelection = async () => {
    const term = termRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (!sel) {
      showTip('未选中内容');
      return;
    }
    await getAPI().clipboardWrite?.(sel);
    // 仅当单行选区位于当前命令行输入内且不越过光标时，才真正删除（退格 + 重打尾部）
    // 其余情况（历史输出等）终端缓冲不可改写，退化为复制
    const pos = term.getSelectionPosition();
    const buf = term.buffer.active;
    const cursorRow = buf.baseY + buf.cursorY;
    const cursorCol = buf.cursorX;
    if (pos && pos.start.y === pos.end.y && pos.start.y === cursorRow && pos.end.x <= cursorCol) {
      const line = buf.getLine(cursorRow)?.translateToString(false) ?? '';
      const tail = line.slice(pos.end.x, cursorCol);
      const del = pos.end.x - pos.start.x + tail.length;
      if (del > 0) {
        const sid = getSessionMapping(key);
        if (!sid) {
          showTip('未连接，无法删除');
          return;
        }
        // 退格删掉选区+尾部，再回打尾部（等效于删除选中片段）
        await getAPI().sshWrite(sid, '\x7f'.repeat(del) + tail);
      }
      term.clearSelection();
      showTip('已剪切');
    } else {
      term.clearSelection();
      showTip('已复制（选区不在当前输入行，无法删除）');
    }
  };

  const pasteClipboard = async () => {
    const term = termRef.current;
    if (!term) return;
    const res = await getAPI().clipboardRead?.();
    const text = res?.text || '';
    if (!text) {
      showTip(res?.ok === false ? res.error || '粘贴失败' : '剪贴板为空');
      return;
    }
    term.paste(text);
  };

  const selectAllText = () => {
    termRef.current?.selectAll();
  };

  const clearScreen = () => {
    termRef.current?.clear();
  };

  // 快捷键（xterm 按键钩子）：
  // Ctrl+Shift+C/X/V 复制/剪切/粘贴；Ctrl+V 粘贴；
  // Ctrl+C 有选区时复制，无选区保持 Ctrl+C = 中断（SIGINT）
  // 补全弹窗打开时：↑↓ 选择、Tab 采纳、Esc 关闭、Enter 关闭并执行
  const handleTermKey = (e: KeyboardEvent): boolean => {
    // xterm 会在 keydown/keyup/keypress 三个阶段都调用本钩子，
    // 只处理 keydown，否则一次按键会触发两次（↑↓ 移动两格的 bug）
    if (e.type !== 'keydown') return true;
    // 输入法组字过程不拦截
    if (e.isComposing) return true;
    const compNow = compRef.current;
    if (compNow) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveComp(1);
        return false;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveComp(-1);
        return false;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const item = compNow.items[compNow.index];
        if (item) acceptComp(item.label);
        return false;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeComp();
        return false;
      }
      if (e.key === 'Enter') {
        // 关闭弹窗，回车照常发给 shell
        closeComp();
        return true;
      }
      if (e.key === 'PageDown') {
        e.preventDefault();
        moveComp(10);
        return false;
      }
      if (e.key === 'PageUp') {
        e.preventDefault();
        moveComp(-10);
        return false;
      }
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return true;
    const k = e.key.toLowerCase();
    if (e.shiftKey && k === 'c') {
      e.preventDefault();
      void copySelection();
      return false;
    }
    if (e.shiftKey && k === 'x') {
      e.preventDefault();
      void cutSelection();
      return false;
    }
    if (k === 'v') {
      e.preventDefault();
      void pasteClipboard();
      return false;
    }
    if (!e.shiftKey && k === 'c' && termRef.current?.hasSelection()) {
      e.preventDefault();
      void copySelection();
      return false;
    }
    // Ctrl+F 终端内搜索
    if (!e.shiftKey && k === 'f') {
      e.preventDefault();
      setSearchOpen(true);
      return false;
    }
    // Ctrl+Space 手动触发补全
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      void runComp(true);
      return false;
    }
    return true;
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let entry = termCache.get(key);
    if (!entry) {
      entry = createCachedTerminal(key, session.id, container, theme);
      termCache.set(key, entry);
    } else if (entry.term.element && entry.term.element.parentElement !== container) {
      // 重新挂载：把已有终端（含全部历史缓冲）挂回新容器
      container.appendChild(entry.term.element);
    }
    const term = entry.term;
    const fit = entry.fit;
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = entry.search;

    // 复制/剪切/粘贴快捷键（覆盖 xterm 默认按键处理）
    term.attachCustomKeyEventHandler(handleTermKey);

    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    term.focus();

    const api = getAPI();
    const dataSub = term.onData((data) => {
      const sid = getSessionMapping(key);
      // 宏录制：把发往本会话的按键原样记录（录制状态从 store 实时读取）
      if (useAppStore.getState().recordingKeys !== null) {
        useAppStore.getState().appendMacroKey(data);
      }
      if (sid) {
        api.sshWrite(sid, data);
        // 同步输入：把按键同样广播到其他所有已连接的终端会话（RDP/VNC 外部会话除外）
        const st = useAppStore.getState();
        if (st.syncInput) {
          for (const s of st.sessions) {
            if (s.id === session.id || s.external || s.status !== 'connected') continue;
            const otherSid = getSessionMapping(s.id);
            if (otherSid && otherSid !== sid) api.sshWrite(otherSid, data);
          }
        }
      }
      // 键入后停顿自动弹出补全
      scheduleCompRef.current();
    });

    const doFit = () => {
      try {
        fit.fit();
        const sid = getSessionMapping(key);
        if (sid) api.sshResize(sid, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    };
    const resizeObs = new ResizeObserver(doFit);
    resizeObs.observe(container);

    // initial resize
    const timer = setTimeout(doFit, 100);

    // 字体加载完成会改变单元格高度，补一次 fit，避免末行溢出被裁
    document.fonts?.ready?.then(() => {
      if (termRef.current === term) doFit();
    });

    return () => {
      dataSub.dispose();
      resizeObs.disconnect();
      clearTimeout(timer);
      // 摘下 DOM 但不销毁终端：缓冲保留到关闭标签/分屏为止
      if (term.element && term.element.parentElement === container) {
        container.removeChild(term.element);
      }
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // 主题切换时热更新终端配色（无需重建终端）
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getTerminalTheme(theme);
    }
  }, [theme]);

  const openOutput = () => {
    if (!termRef.current) return;
    setOutputLines(readTerminalBuffer(termRef.current));
    setOutputOpen(true);
  };

  return (
    <div
      className="flex-1 flex flex-col theme-terminal-bg min-h-0 scanline-overlay relative"
      onContextMenu={(e) => {
        // 右键调出终端编辑菜单
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY, hasSel: !!termRef.current?.getSelection() });
      }}
    >
      {/* top status bar —— 普通 flex 行，不再悬浮遮盖终端内容 */}
      <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-[var(--border-subtle)]" style={{ background: "var(--terminal-bg)" }}>
        <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
          <span>{session.title}</span>
          <span className="opacity-30">|</span>
          <span>{session.host}</span>
          <span className="opacity-30">|</span>
          <span className="uppercase">{session.status}</span>
          {session.status === 'error' && session.error && (
            <span className="text-[var(--error)] normal-case max-w-[420px] truncate" title={session.error}>
              · {session.error}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {recording && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-[var(--error)] bg-[var(--error)]/10">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--error)] animate-pulse" />
              录制中 {recordingKeys?.length ?? 0}
            </span>
          )}
          {isSerial && (
            <button
              onClick={() => setPlotOpen((v) => !v)}
              title="串口绘图：实时绘制数据行里的数值曲线"
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
                plotOpen
                  ? 'text-[var(--accent)] bg-[var(--bg-elevated)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              <LineChart size={11} />
              <span>绘图</span>
            </button>
          )}
          <button
            onClick={() => setAiPanelOpen((v) => !v)}
            title="AI 运维助手（基于当前屏幕内容问答，命令可一键插入）"
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
              aiPanelOpen
                ? 'text-[var(--accent)] bg-[var(--bg-elevated)]'
                : 'text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)]'
            }`}
          >
            <Sparkles size={11} />
            <span>AI 助手</span>
          </button>
          <button
            onClick={() => setMacroOpen((v) => !v)}
            title="宏 / 快捷指令（录制常用命令序列，一键回放）"
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
              macroOpen || recording
                ? 'text-[var(--accent)] bg-[var(--bg-elevated)]'
                : 'text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)]'
            }`}
          >
            <Zap size={11} />
            <span>宏</span>
          </button>
          <button
            onClick={() => setSearchOpen((v) => !v)}
            title="搜索终端输出（Ctrl+F）"
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
              searchOpen
                ? 'text-[var(--accent)] bg-[var(--bg-elevated)]'
                : 'text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)]'
            }`}
          >
            <Search size={11} />
            <span>搜索</span>
          </button>
          <button
            onClick={openOutput}
            title="查看全部输出（可搜索、复制、导出）"
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <ScrollText size={11} />
            <span>全部输出</span>
          </button>
        </div>
      </div>

      {/* 终端内搜索工具条（Ctrl+F 唤起） */}
      {searchOpen && termRef.current && searchRef.current && (
        <TerminalSearchBar
          term={termRef.current}
          searchAddon={searchRef.current}
          onClose={() => {
            setSearchOpen(false);
            termRef.current?.focus();
          }}
        />
      )}

      {/* 宏 / 快捷指令面板 */}
      {macroOpen && (
        <MacroPanel sessionId={getSessionMapping(key) ?? null} onClose={() => setMacroOpen(false)} />
      )}

      {/* 终端内嵌 AI 助手 */}
      {aiPanelOpen && (
        <TerminalAIPanel
          term={termRef.current}
          sessionId={getSessionMapping(key) ?? null}
          host={session.host}
          onClose={() => {
            setAiPanelOpen(false);
            termRef.current?.focus();
          }}
        />
      )}

      {/* 串口实时绘图（仅串口会话） */}
      {plotOpen && isSerial && getSessionMapping(key) && (
        <SerialPlotter sid={getSessionMapping(key)!} onClose={() => setPlotOpen(false)} />
      )}

      {/* 终端容器零内边距、精确占满剩余高度：
          FitAddon 测量的父容器高度即真实可用高度，末行不会再被面板边框裁切 */}
      <div ref={containerRef} className="flex-1 min-h-0" />

      {outputOpen && (
        <TerminalOutputModal
          lines={outputLines}
          title={`${session.title} · ${session.host}`}
          onClose={() => setOutputOpen(false)}
        />
      )}

      {/* 右键编辑菜单 */}
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-[99]"
            onMouseDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div
            className="fixed z-[100] min-w-[184px] py-1 rounded-lg glass shadow-panel"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 200),
              top: Math.min(ctxMenu.y, window.innerHeight - 230)
            }}
          >
            <CtxItem
              icon={<Copy size={13} />}
              label="复制"
              hint="Ctrl+Shift+C"
              disabled={!ctxMenu.hasSel}
              onClick={() => {
                setCtxMenu(null);
                void copySelection();
              }}
            />
            <CtxItem
              icon={<Scissors size={13} />}
              label="剪切"
              hint="Ctrl+Shift+X"
              disabled={!ctxMenu.hasSel}
              onClick={() => {
                setCtxMenu(null);
                void cutSelection();
              }}
            />
            <CtxItem
              icon={<ClipboardPaste size={13} />}
              label="粘贴"
              hint="Ctrl+V"
              onClick={() => {
                setCtxMenu(null);
                void pasteClipboard();
              }}
            />
            <CtxItem
              icon={<CheckSquare size={13} />}
              label="全选"
              onClick={() => {
                setCtxMenu(null);
                selectAllText();
              }}
            />
            <div className="my-1 h-px bg-[var(--border-subtle)]" />
            <CtxItem
              icon={<Eraser size={13} />}
              label="清屏"
              onClick={() => {
                setCtxMenu(null);
                clearScreen();
              }}
            />
          </div>
        </>
      )}

      {/* 命令补全弹窗（IDEA 式） */}
      {comp && (
        <div
          className="fixed z-[90] min-w-[280px] max-w-[440px] rounded-lg glass shadow-panel overflow-hidden"
          style={{
            left: Math.min(comp.x, window.innerWidth - 460),
            top: Math.min(comp.y, window.innerHeight - 320)
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="max-h-[240px] overflow-y-auto theme-scroll" ref={compListRef}>
            {comp.items.map((it, i) => (
              <button
                key={`${it.label}-${i}`}
                data-sel={i === comp.index ? '1' : undefined}
                onClick={() => acceptComp(it.label)}
                onMouseEnter={() => setComp((c) => (c ? { ...c, index: i } : c))}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  i === comp.index
                    ? 'bg-[var(--solid-accent)] text-[var(--accent-contrast)] font-medium'
                    : 'text-[var(--text-primary)]'
                }`}
              >
                {it.kind === 'ai' && (
                  <span
                    className={`text-[9px] shrink-0 px-1 rounded ${
                      i === comp.index ? 'bg-[var(--accent-contrast)]/25 text-[var(--accent-contrast)]' : 'text-[var(--accent)]'
                    }`}
                  >
                    AI
                  </span>
                )}
                <span className="font-mono truncate">{it.label}</span>
                {it.hint && (
                  <span
                    className={`ml-auto text-[9px] truncate ${
                      i === comp.index ? 'text-[var(--accent-contrast)]/75' : 'text-[var(--text-muted)]'
                    }`}
                  >
                    {it.hint}
                  </span>
                )}
              </button>
            ))}
          </div>
          {/* 选中项解释栏（参数解释） */}
          <div className="px-3 py-1.5 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] min-h-[28px]">
            {comp.items[comp.index]?.explain ? (
              <span>
                <span className="text-[var(--accent)]">💡 </span>
                {comp.items[comp.index].explain}
              </span>
            ) : aiBusy ? (
              <span className="text-[var(--text-muted)]">✨ AI 联想与参数解释生成中…</span>
            ) : (
              <span className="text-[var(--text-muted)]">
                {comp.items[comp.index]?.hint || '选中候选可查看参数解释'}
              </span>
            )}
          </div>
          <div className="px-3 py-1 border-t border-[var(--border-subtle)] text-[9px] text-[var(--text-muted)] flex items-center gap-2">
            <span>Tab 采纳</span>
            <span>↑↓ 选择</span>
            <span>Esc 关闭</span>
            <span className="ml-auto">{aiBusy ? '✨ AI 联想中…' : 'Ctrl+Space 手动补全'}</span>
          </div>
        </div>
      )}

      {/* 轻提示 */}
      {tip && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-primary)] shadow-panel pointer-events-none">
          {tip}
        </div>
      )}
    </div>
  );
}

function CtxItem({
  icon,
  label,
  hint,
  disabled,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--accent)]/15 disabled:opacity-35 disabled:hover:bg-transparent transition-colors"
    >
      <span className="text-[var(--text-secondary)]">{icon}</span>
      <span>{label}</span>
      {hint && <span className="ml-auto text-[9px] text-[var(--text-muted)]">{hint}</span>}
    </button>
  );
}
