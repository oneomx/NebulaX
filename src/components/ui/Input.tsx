import type { ReactNode } from 'react';

/** 统一表单输入框：主题变量驱动，避免硬编码 text-[var(--text-primary)] / placeholder-slate */
export function Label({ text }: { text: string }) {
  return <label className="block text-xs text-[var(--text-secondary)] mb-1.5 font-medium">{text}</label>;
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  icon,
  disabled,
  suggestions
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** 可选联想项（datalist），输入时给出已有选项提示 */
  suggestions?: string[];
}) {
  const listId = suggestions && suggestions.length > 0 ? `dl-${Math.random().toString(36).slice(2, 8)}` : undefined;
  return (
    <div className="relative">
      {icon && <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">{icon}</div>}
      <input
        type={type}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        list={listId}
        className={`w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/50 disabled:opacity-50 ${
          icon ? 'pl-9' : ''
        }`}
      />
      {listId && (
        <datalist id={listId}>
          {suggestions!.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
