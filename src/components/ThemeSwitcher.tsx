import { THEMES, useThemeStore, applyTheme, type ThemeId } from '../store/theme';
import { Check } from 'lucide-react';

interface Props {
  compact?: boolean;
}

export default function ThemeSwitcher({ compact }: Props) {
  const { theme, setTheme } = useThemeStore();

  const onChange = (id: ThemeId) => {
    setTheme(id);
    applyTheme(id);
  };

  if (compact) {
    return (
      <div className="flex items-center gap-1.5">
        {THEMES.map((t) => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            title={`${t.name} · ${t.tag}`}
            className={`w-6 h-6 rounded-[4px] border transition-all ${
              theme === t.id ? 'border-[var(--accent)]' : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
            }`}
            style={{ background: t.preview.bg }}
          >
            <div
              className="w-2.5 h-2.5 mx-auto rounded-[2px]"
              style={{ background: t.preview.accent }}
            />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2.5">
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className="theme-card p-2.5 text-left transition"
          style={{
            borderColor: theme === t.id ? 'var(--accent)' : 'var(--border-subtle)'
          }}
        >
          {/* Preview swatch */}
          <div
            className="h-14 rounded-[4px] mb-2 overflow-hidden relative"
            style={{
              background: t.preview.bg,
              border: '1px solid var(--border-subtle)'
            }}
          >
            {/* accent line */}
            <div
              className="absolute top-2.5 left-2.5 right-2.5 h-px"
              style={{ background: t.preview.accent, opacity: 0.7 }}
            />
            {/* accent block */}
            <div
              className="absolute bottom-2.5 left-2.5 w-5 h-5 rounded-[2px]"
              style={{ background: t.preview.accent }}
            />
            {/* text lines */}
            <div className="absolute bottom-3 left-9 right-2.5 space-y-1">
              <div className="h-px rounded-full opacity-50" style={{ background: t.preview.text }} />
              <div className="h-px rounded-full opacity-30 w-2/3" style={{ background: t.preview.text }} />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                {t.name}
              </div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {t.tag}
              </div>
            </div>
            {theme === t.id && (
              <div
                className="w-4.5 h-4.5 rounded-full flex items-center justify-center"
                style={{ background: 'var(--accent)', width: 18, height: 18 }}
              >
                <Check size={11} strokeWidth={2.5} style={{ color: 'var(--accent-contrast)' }} />
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
