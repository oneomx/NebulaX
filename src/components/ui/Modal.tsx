import { type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useModalEscape, backdropClose } from './useModalEscape';

/**
 * 统一弹窗容器：Esc 关闭 + 点击遮罩关闭 + 语义化可访问性。
 */
export default function Modal({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  width = '560px'
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useModalEscape(onClose);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base)]/80 backdrop-blur-sm"
      onMouseDown={backdropClose(onClose)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="glass rounded-[8px] max-h-[90vh] overflow-hidden shadow-panel animate-slide-in"
        style={{ width }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-3">
            {icon && (
              <div className="w-9 h-9 rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)]">
                {icon}
              </div>
            )}
            <div>
              <div className="text-base font-semibold theme-text-primary">{title}</div>
              {subtitle && <div className="text-xs text-[var(--text-muted)]">{subtitle}</div>}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto max-h-[65vh]">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="px-6 py-4 border-t border-[var(--border-subtle)] flex items-center gap-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
