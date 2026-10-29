import { useRef, useState, useCallback, useEffect } from 'react';
import type { PaneNode, SessionTab } from '../types';
import TerminalPanel from './TerminalPanel';
import { setRatio } from '../lib/paneTree';

/**
 * 递归渲染 PaneNode 树，支持拖拽分割条调整比例。
 * 每个 leaf 用独立的 TerminalPanel（独立 xterm 实例与 sessionMap 条目）。
 */
export default function TerminalPaneLayout({
  root,
  session,
  onChange,
  onFocusPane
}: {
  root: PaneNode;
  session: SessionTab;
  onChange: (next: PaneNode) => void;
  onFocusPane?: (paneId: string) => void;
}) {
  return <PaneView node={root} session={session} onChange={onChange} onFocusPane={onFocusPane} />;
}

function PaneView({
  node,
  session,
  onChange,
  onFocusPane
}: {
  node: PaneNode;
  session: SessionTab;
  onChange: (next: PaneNode) => void;
  onFocusPane?: (paneId: string) => void;
}) {
  if (node.type === 'leaf') {
    return (
      <div
        className="flex-1 min-w-0 min-h-0 flex flex-col relative group/pane"
        onMouseDown={() => onFocusPane?.(node.id)}
      >
        <TerminalPanel session={session} mapKey={node.id} />
      </div>
    );
  }

  return <SplitView node={node} session={session} onChange={onChange} onFocusPane={onFocusPane} />;
}

function SplitView({
  node,
  session,
  onChange,
  onFocusPane
}: {
  node: Extract<PaneNode, { type: 'split' }>;
  session: SessionTab;
  onChange: (next: PaneNode) => void;
  onFocusPane?: (paneId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // 组件卸载时强制清理全局事件监听器，防止 pane 关闭后事件泄漏
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setDragging(true);
      const target = e.target as HTMLElement;
      target.setPointerCapture?.(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        let ratio: number;
        if (node.dir === 'row') {
          ratio = (ev.clientX - rect.left) / rect.width;
        } else {
          ratio = (ev.clientY - rect.top) / rect.height;
        }
        onChange(setRatio(node, node.id, ratio));
      };
      const onUp = () => {
        setDragging(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        cleanupRef.current = null;
      };
      cleanupRef.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [node, onChange]
  );

  const isRow = node.dir === 'row';

  return (
    <div
      ref={containerRef}
      className={`flex-1 min-w-0 min-h-0 flex ${isRow ? 'flex-row' : 'flex-col'}`}
      style={{ userSelect: dragging ? 'none' : 'auto' }}
    >
      <div style={isRow ? { width: `${node.ratio * 100}%` } : { height: `${node.ratio * 100}%` }} className="min-w-0 min-h-0 flex">
        <PaneView node={node.children[0]} session={session} onChange={onChange} onFocusPane={onFocusPane} />
      </div>

      <div
        onPointerDown={onPointerDown}
        className={`shrink-0 bg-[var(--border-subtle)] hover:bg-[var(--accent)]/50 transition-colors ${
          isRow ? 'w-[3px] cursor-col-resize' : 'h-[3px] cursor-row-resize'
        }`}
        role="separator"
        aria-orientation={isRow ? 'vertical' : 'horizontal'}
      />

      <div style={isRow ? { width: `${(1 - node.ratio) * 100}%` } : { height: `${(1 - node.ratio) * 100}%` }} className="min-w-0 min-h-0 flex">
        <PaneView node={node.children[1]} session={session} onChange={onChange} onFocusPane={onFocusPane} />
      </div>
    </div>
  );
}
