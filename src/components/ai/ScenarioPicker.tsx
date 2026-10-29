import { useState, useEffect } from 'react';
import { LayoutGrid, Loader2, Search, X } from 'lucide-react';
import { getAPI, type ScenarioPreset, type ScenarioCategory } from '../../lib/api';
import { useModalEscape } from '../ui/useModalEscape';

/**
 * 场景预设选择器（v1.7）：4 类 23 个常见运维场景一键带入。
 * - 诊断 Agent 模式：带入故障现象 + 上下文提示 + 推荐步骤
 * - 问答模式：带入 quickPrompt 直接发问
 */
interface Props {
  onClose: () => void;
  onSelect: (s: ScenarioPreset) => void;
}

const CATEGORY_ORDER: ScenarioCategory[] = ['ops', 'security', 'database', 'perf'];

export default function ScenarioPicker({ onClose, onSelect }: Props) {
  useModalEscape(onClose);
  const [scenarios, setScenarios] = useState<ScenarioPreset[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<ScenarioCategory | 'all'>('all');
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await getAPI().aiScenarios();
        if (res.ok && res.scenarios) {
          setScenarios(res.scenarios);
          setLabels(res.labels || {});
        }
      } catch {
        /* 预览模式：列表为空 */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = scenarios.filter((s) => {
    if (category !== 'all' && s.category !== category) return false;
    if (keyword.trim()) {
      const k = keyword.trim().toLowerCase();
      return (
        s.name.toLowerCase().includes(k) ||
        s.description.toLowerCase().includes(k) ||
        s.incident.toLowerCase().includes(k)
      );
    }
    return true;
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base)]/80 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="glass rounded-[8px] w-[860px] max-w-[95vw] max-h-[80vh] flex flex-col shadow-panel animate-slide-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border-subtle)]">
          <div className="w-9 h-9 rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)]">
            <LayoutGrid size={16} strokeWidth={1.8} />
          </div>
          <div className="flex-1">
            <div className="text-base font-semibold theme-text-primary">场景预设</div>
            <div className="text-xs text-[var(--text-muted)]">选择贴近当前情况的场景，自动带入诊断要素与推荐步骤</div>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Filters */}
        <div className="px-6 pt-4 flex items-center gap-3">
          <div className="flex gap-1.5 flex-1 flex-wrap">
            <button
              onClick={() => setCategory('all')}
              className={`px-3 py-1.5 rounded-[5px] text-xs transition ${
                category === 'all'
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-transparent hover:text-[var(--text-primary)]'
              }`}
            >
              全部
            </button>
            {CATEGORY_ORDER.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`px-3 py-1.5 rounded-[5px] text-xs transition ${
                  category === c
                    ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
                    : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-transparent hover:text-[var(--text-primary)]'
                }`}
              >
                {labels[c] || c}
              </button>
            ))}
          </div>
          <div className="relative w-52">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索场景..."
              className="w-full rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] pl-8 pr-3 py-2 text-xs theme-text-primary placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] outline-none"
            />
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-[var(--text-muted)] text-xs">
              <Loader2 size={16} className="animate-spin" />
              加载场景中...
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="py-16 text-center text-xs text-[var(--text-muted)]">
              {scenarios.length === 0 ? '浏览器预览模式下无场景数据' : '没有匹配的场景'}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2.5">
            {filtered.map((s) => (
              <button
                key={s.id}
                onClick={() => onSelect(s)}
                className="text-left rounded-[6px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] hover:border-[var(--accent)]/50 hover:bg-[var(--bg-elevated-hover)] transition p-3 group"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base leading-none">{s.icon}</span>
                  <span className="text-xs font-medium theme-text-primary group-hover:text-[var(--accent)] transition-colors">
                    {s.name}
                  </span>
                  <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-base)] text-[var(--text-muted)] border border-[var(--border-subtle)]">
                    {labels[s.category] || s.category}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--text-muted)] leading-relaxed line-clamp-2">{s.description}</div>
                <div className="mt-1.5 text-[10px] text-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity">
                  {s.steps.length} 个推荐诊断步骤 →
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
