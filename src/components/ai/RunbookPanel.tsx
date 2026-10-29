import { useState, useEffect, useRef } from 'react';
import {
  BookOpen,
  Upload,
  Trash2,
  Search,
  FileText,
  Loader2,
  Sparkles,
  Copy,
  CheckCheck,
  X,
  Minus,
  RotateCcw
} from 'lucide-react';
import { getAPI } from '../../lib/api';
import type { RunbookDoc, RetrievalResult } from '../../types/ai';
import { useModalEscape } from '../ui/useModalEscape';

interface Props {
  onClose: () => void;
  onUseContext?: (ctx: string) => void;
  minimized?: boolean;
  onMinimize?: () => void;
  onStatusChange?: (running: boolean) => void;
}

export default function RunbookPanel({ onClose, onUseContext, minimized, onMinimize, onStatusChange }: Props) {
  useModalEscape(onClose, !minimized);
  const [docs, setDocs] = useState<RunbookDoc[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RetrievalResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [builtin, setBuiltin] = useState<{ total: number; present: number } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const api = getAPI();

  // 向外层报告任务运行状态（供缩小后的悬浮窗显示）
  useEffect(() => {
    onStatusChange?.(loading || uploading || restoring);
  }, [loading, uploading, restoring]);

  useEffect(() => {
    loadDocs();
    loadBuiltinStats();
  }, []);

  const loadDocs = async () => {
    const res = await api.ragList();
    if (res.ok && res.docs) setDocs(res.docs as RunbookDoc[]);
  };

  const loadBuiltinStats = async () => {
    const res = await api.ragBuiltinStats();
    if (res.ok && typeof res.total === 'number') setBuiltin({ total: res.total, present: res.present ?? 0 });
  };

  const restoreBuiltin = async () => {
    if (restoring) return;
    setRestoring(true);
    setRestoreMsg('');
    try {
      const res = await api.ragRestoreBuiltin();
      if (res.ok) {
        setRestoreMsg(res.added ? `已补回 ${res.added} 篇内置知识` : '内置知识已齐全，无需恢复');
        await loadDocs();
        await loadBuiltinStats();
        setTimeout(() => setRestoreMsg(''), 3000);
      } else {
        setRestoreMsg(res.error || '恢复失败');
      }
    } finally {
      setRestoring(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setUploading(true);
    for (const f of Array.from(files)) {
      const text = await f.text();
      await api.ragAdd({ title: f.name.replace(/\.[^.]+$/, ''), filename: f.name, content: text });
    }
    await loadDocs();
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const remove = async (id: string) => {
    await api.ragRemove(id);
    await loadDocs();
  };

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await api.ragRetrieve(query);
      if (res.ok && res.results) setResults(res.results as RetrievalResult[]);
    } finally {
      setLoading(false);
    }
  };

  const useAllContext = async () => {
    const res = await api.ragContext(query);
    if (res.ok && res.context) {
      navigator.clipboard.writeText(res.context);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onUseContext?.(res.context);
    }
  };

  // 缩小到后台：不渲染界面但保持挂载，任务继续执行
  if (minimized) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base)]/80 backdrop-blur-sm">
      <div className="glass rounded-[8px] w-[1000px] max-w-[95vw] h-[85vh] flex flex-col shadow-panel animate-slide-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border-subtle)]">
          <div className="w-9 h-9 rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)]">
            <BookOpen size={16} strokeWidth={1.8} className="text-[var(--accent)]" />
          </div>
          <div className="flex-1">
            <div className="text-base font-semibold theme-text-primary">RAG 知识库 · Runbook</div>
            <div className="text-xs text-[var(--text-muted)]">
              上传 SOP / 故障处理流程 / 团队 Wiki，AI 会基于这些知识回答你的问题
            </div>
          </div>
          {onMinimize && (
            <button onClick={onMinimize} title="缩小到后台运行" className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              <Minus size={18} />
            </button>
          )}
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Left docs */}
          <div className="w-[35%] flex flex-col border-r border-[var(--border-subtle)] p-4">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.md,.markdown,.log,.sh,.yaml,.yml,.json"
              className="hidden"
              onChange={handleFile}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center justify-center gap-2 py-2.5 rounded-[6px] border border-dashed border-[var(--border-subtle)] hover:border-[var(--accent)]/50 hover:bg-[var(--accent)]/5 text-[var(--text-primary)] text-xs transition"
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              上传文档（txt/md/log/yaml/json）
            </button>

            <div className="mt-4 flex-1 overflow-y-auto space-y-1.5">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-[var(--text-secondary)]">
                  已上传文档（{docs.length}
                  {builtin && builtin.present > 0 ? `，内置 ${builtin.present}/${builtin.total}` : ''}）
                </div>
                <button
                  onClick={restoreBuiltin}
                  disabled={restoring || !builtin}
                  title="补回被删除的内置知识（幂等，不重复）"
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition disabled:opacity-50"
                >
                  {restoring ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                  恢复内置知识
                </button>
              </div>
              {restoreMsg && (
                <div className="mb-1 px-2 py-1.5 rounded bg-[var(--accent)]/10 border border-[var(--accent)]/30 text-[10px] text-[var(--accent)]">
                  {restoreMsg}
                </div>
              )}
              {docs.map((d) => (
                <div key={d.id} className="glass-light rounded-lg p-2.5">
                  <div className="flex items-start gap-2">
                    <FileText size={13} className="text-violet-400 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-[var(--text-primary)] truncate">{d.title}</span>
                        {d.builtin && (
                          <span
                            className="shrink-0 px-1 py-px rounded-[3px] text-[9px] bg-[var(--success)]/15 text-[var(--success)]"
                            title="产品内置的运维知识，可删除，可用右侧按钮恢复"
                          >
                            内置
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] truncate">{d.filename}</div>
                    </div>
                    <button
                      onClick={() => remove(d.id)}
                      className="p-1 rounded hover:bg-[var(--error)]/20 text-[var(--error)] shrink-0"
                      title="删除"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
              {docs.length === 0 && (
                <div className="text-center text-[var(--text-muted)] text-xs py-12">
                  <BookOpen size={28} className="mx-auto mb-2 opacity-25" />
                  暂无文档，点击上方上传
                </div>
              )}
            </div>
          </div>

          {/* Right query */}
          <div className="flex-1 flex flex-col p-4">
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && search()}
                  placeholder="检索知识库... 如：怎么处理 OOM？"
                  className="w-full pl-9 pr-3 py-2.5 rounded-[6px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                />
              </div>
              <button
                onClick={search}
                disabled={loading || !query.trim()}
                className="px-4 rounded-[6px] theme-btn-primary text-xs hover:opacity-90"
              >
                {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              </button>
            </div>

            <div className="mt-3 flex-1 overflow-y-auto space-y-2">
              {results.length > 0 && (
                <>
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-[var(--text-secondary)]">检索到 {results.length} 个相关片段</div>
                    <button
                      onClick={useAllContext}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] bg-[var(--bg-elevated)] hover:bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                    >
                      {copied ? <CheckCheck size={12} /> : <Copy size={12} />}
                      {copied ? '已复制' : '复制 RAG 上下文'}
                    </button>
                  </div>
                  {results.map((r, i) => (
                    <div key={i} className="glass rounded-[6px] p-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="px-1.5 py-0.5 rounded-[3px] text-[9px] bg-[var(--accent)]/15 text-[var(--accent)]">
                          {(r.score * 100).toFixed(0)}% 相关
                        </span>
                        <div className="text-xs text-[var(--text-primary)] truncate">{r.doc.title}</div>
                      </div>
                      <pre className="text-[10px] text-[var(--text-secondary)] font-mono whitespace-pre-wrap leading-relaxed">
                        {r.excerpt}
                      </pre>
                    </div>
                  ))}
                </>
              )}

              {results.length === 0 && !loading && (
                <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-2">
                  <BookOpen size={32} className="opacity-25" />
                  <div className="text-xs">输入问题检索知识库</div>
                </div>
              )}
            </div>

            <div className="mt-3 px-3 py-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
              <div className="flex items-start gap-1.5">
                <Sparkles size={12} className="text-violet-400 mt-0.5" />
                <div className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                  将检索到的片段粘贴到 AI 对话中，AI 会**按照你公司的 SOP** 来回答运维问题。
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
