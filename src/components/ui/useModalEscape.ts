import { useEffect } from 'react';

/**
 * 统一弹窗交互：Escape 关闭 + 点击遮罩关闭。
 * 传入 onClose 与弹窗根元素 ref。
 * enabled=false 时不监听（用于弹窗缩小到后台运行的场景）。
 */
export function useModalEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, enabled]);
}

/** 遮罩 onMouseDown 处理器：仅当点击的是遮罩本身（非内容）时关闭 */
export function backdropClose(onClose: () => void) {
  return (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };
}
