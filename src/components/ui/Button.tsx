import type { ReactNode } from 'react';

/** 统一按钮样式 */
export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  className = ''
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  className?: string;
}) {
  const base =
    'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm transition disabled:opacity-50 disabled:cursor-not-allowed';
  const variants: Record<string, string> = {
    primary: 'theme-btn-primary font-medium',
    secondary: 'bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-elevated-hover)]',
    ghost: 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]',
    danger: 'bg-[var(--error)]/15 text-[var(--error)] hover:bg-[var(--error)]/25'
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}
