import { useState, useEffect } from 'react';
import {
  Gauge,
  Play,
  Loader2,
  Copy,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  X,
  Minus,
  Zap
} from 'lucide-react';
import { getAPI } from '../../lib/api';
import type { PerfReport, PerfItem } from '../../types/ai';
import { getSessionMapping } from '../../lib/sessionMap';
import { useAppStore } from '../../store/app';
import { useModalEscape } from '../ui/useModalEscape';

interface Props {
  onClose: () => void;
  sessionId?: string | null;
  minimized?: boolean;
  onMinimize?: () => void;
  onStatusChange?: (running: boolean) => void;
}

const CATEGORY_LABELS: Record<PerfItem['category'], string> = {
  kernel: '内核参数',
  network: '网络栈',
  io: '磁盘 IO',
  limits: '资源限制',
  service: '服务配置'
};

const SEVERITY_META: Record<PerfItem['severity'], { color: string; label: string }> = {
  critical: { color: '#ef4444', label: '严重' },
  warning: { color: '#f59e0b', label: '警告' },
  info: { color: '#10b981', label: '良好' }
};

/**
 * 性能调优建议面板（v1.7）：
 * 只读采集内核/网络/IO/文件句柄参数 → 本地规则给出确定性建议 → AI 补充。
 * **绝不自动修改任何参数**，所有命令由用户复制确认后自行执行。
 */
export default function PerfTunePanel({ onClose, sessionId, minimized, onMinimize, onStatusChange }: Props) {
  useModalEscape(onClose, !minimized);
  const [role, setRole] = useState('');
  const [report, setReport] = useState<PerfReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<'all' | 'issues'>('all');
  const api = getAPI();

  const { sessions, activeSessionId: storeActiveId } = useAppStore();
  const tabId = sessionId ?? storeActiveId ?? null;
  const activeTab = tabId ? sessions.find((s) => s.id === tabId) || null : null;
  const isSSHSession = !!activeTab && !activeTab.external;
  const canRun = !!tabId && isSSHSession;
  const runHint = !tabId
    ? '先在侧边栏双击连接一台服务器'
    : !isSSHSession
    ? '仅 SSH 会话支持性能采集'
    : '只读采集，不会修改任何参数';

  useEffect(() => {
    onStatusChange?.(loading);
  }, [loading]);

  const analyze = async () => {
    if (!canRun || loading) return;
    const sid = getSessionMapping(tabId!);
    if (!sid) {
      setError('未找到 SSH 会话（连接可能已断开，请重新连接）');
      return;
    }
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const res = await api.aiPerfAnalyze({ sessionId: sid, role: role || undefined });
      if (res.ok && res.report) {
        setReport(res.report as PerfReport);
      } else {
        setError(res.error || '分析失败');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (minimized) return null;

  const items = report ? (filter === 'issues' ? report.items.filter((i) => !i.ok) : report.items) : [];
  const issueCount = report ? report.items.filter((i) => !i.ok).length : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base)]/80 backdrop-blur-sm">
      <div className="glass rounded-[8px] w-[1100px] max-w-[95vw] h-[85vh] flex flex-col shadow-panel animate-slide-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border-subtle)]">
          <div className="w-9 h-9 rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)]">
            <Gauge size={16} strokeWidth={1.8} />
          </div>
          <div className="flex-1">
            <div className="text-base font-semibold theme-text-primary">性能调优建议</div>
            <div className="text-xs text-[var(--text-muted)]">只读采集内核/网络/IO 参数 → 本地规则 + AI 给出建议（不会自动修改）</div>
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
          {/* Left: controls */}
          <div className="w-[32%] flex flex-col border-r border-[var(--border-subtle)] p-4">
            <label className="text-xs text-[var(--text-secondary)] mb-1.5">服务器角色（可选，影响建议取向）</label>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="如：高并发 Web / 数据库 / 缓存"
              className="w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] outline-none"
            />

            <div className="mt-2 flex flex-wrap gap-1.5">
              {['高并发 Web', '数据库', '缓存服务', '网关'].map((r) => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  className="px-2 py-1 rounded-[4px] text-[10px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition"
                >
                  {r}
                </button>
              ))}
            </div>

            <button
              onClick={analyze}
              disabled={loading || !canRun}
              className="mt-4 flex items-center justify-center gap-2 py-2.5 rounded-[6px] theme-btn-primary font-medium hover:opacity-90 disabled:opacity-40"
              title={runHint}
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
              {loading ? '采集中（约 5-15 秒）...' : '开始性能分析'}
            </button>
            <div className="mt-2 text-[10px] text-[var(--text-muted)]">{runHint}</div>

            {error && (
              <div className="mt-3 px-3 py-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[var(--error)] text-xs">
                {error}
              </div>
            )}

            {loading && (
              <div className="mt-4 space-y-2">
                {['网络内核参数', 'TCP 缓冲区', '文件句柄限制', 'IO 调度器'].map((label, i) => (
                  <div key={label} className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]" style={{ animationDelay: `${i * 300}ms` }}>
                    <Loader2 size={11} className="animate-spin text-[var(--accent)]" />
                    正在采集：{label}...
                  </div>
                ))}
                <div className="text-[10px] text-[var(--text-muted)] mt-2">全部为只读命令（sysctl/ulimit/cat），不修改任何配置</div>
              </div>
            )}

            {/* 汇总 */}
            {report && (
              <div className="mt-4 space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-[var(--bg-elevated)] rounded-lg px-2 py-2 text-center">
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{report.items.length}</div>
                    <div className="text-[9px] text-[var(--text-muted)]">检查项</div>
                  </div>
                  <div className="bg-[var(--bg-elevated)] rounded-lg px-2 py-2 text-center">
                    <div className="text-sm font-semibold" style={{ color: issueCount > 0 ? '#f59e0b' : '#10b981' }}>{issueCount}</div>
                    <div className="text-[9px] text-[var(--text-muted)]">待优化</div>
                  </div>
                  <div className="bg-[var(--bg-elevated)] rounded-lg px-2 py-2 text-center">
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{report.os === 'windows' ? 'Win' : 'Linux'}</div>
                    <div className="text-[9px] text-[var(--text-muted)]">目标系统</div>
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setFilter('all')}
                    className={`flex-1 py-1.5 rounded-[5px] text-[10px] transition ${
                      filter === 'all' ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-transparent'
                    }`}
                  >
                    全部 {report.items.length}
                  </button>
                  <button
                    onClick={() => setFilter('issues')}
                    className={`flex-1 py-1.5 rounded-[5px] text-[10px] transition ${
                      filter === 'issues' ? 'bg-[var(--warning)]/15 text-[var(--warning)] border border-[var(--warning)]/30' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-transparent'
                    }`}
                  >
                    仅问题项 {issueCount}
                  </button>
                </div>
                {report.failed.length > 0 && (
                  <div className="text-[10px] text-[var(--text-muted)]">采集失败（不影响其余判断）：{report.failed.join('、')}</div>
                )}
              </div>
            )}
          </div>

          {/* Right: report */}
          <div className="flex-1 flex flex-col p-4 overflow-y-auto">
            {!report && !loading && (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
                <Gauge size={36} className="opacity-25" />
                <div className="text-xs">选择服务器角色后点击「开始性能分析」</div>
                <div className="text-[10px] max-w-xs text-center leading-relaxed">
                  采集 sysctl、ulimit、IO 调度器、socket 统计等只读指标，本地规则先给出确定性建议，AI 再结合角色补充
                </div>
              </div>
            )}

            {loading && (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
                <Loader2 size={28} className="animate-spin text-[var(--accent)]" />
                <div className="text-xs">正在采集参数并分析...</div>
              </div>
            )}

            {report && (
              <>
                <div className="glass rounded-[6px] p-4 mb-3 flex items-start gap-2.5">
                  <Zap size={15} className="text-[var(--accent)] mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="text-xs font-medium theme-text-primary">分析总结</div>
                    <div className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">{report.summary}</div>
                  </div>
                  {report.degraded && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)] border border-[var(--warning)]/30 shrink-0">
                      AI 未响应 · 仅本地规则
                    </span>
                  )}
                </div>

                <div className="space-y-2">
                  {items.map((item, i) => (
                    <PerfItemCard
                      key={`${item.name}-${i}`}
                      item={item}
                      onCopy={copy}
                      copiedId={copiedId}
                      expanded={!!expanded[`${item.name}-${i}`]}
                      toggleExpand={() => setExpanded((c) => ({ ...c, [`${item.name}-${i}`]: !c[`${item.name}-${i}`] }))}
                    />
                  ))}
                  {items.length === 0 && filter === 'issues' && (
                    <div className="px-3 py-4 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/30 text-[var(--success)] text-xs text-center">
                      <CheckCircle2 size={14} className="inline mr-1.5 -mt-0.5" />
                      所有检查项均符合推荐值，无需调整
                    </div>
                  )}
                </div>

                <div className="mt-4 px-3 py-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)] leading-relaxed">
                  <AlertTriangle size={10} className="inline mr-1 -mt-0.5 text-[var(--warning)]" />
                  所有命令仅作建议展示，不会自动执行。复制后请人工确认再运行；生产环境建议先在灰度节点验证。
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PerfItemCard({
  item,
  onCopy,
  copiedId,
  expanded,
  toggleExpand
}: {
  item: PerfItem;
  onCopy: (t: string, id: string) => void;
  copiedId: string | null;
  expanded: boolean;
  toggleExpand: () => void;
}) {
  const meta = SEVERITY_META[item.severity];
  const cmdId = `perf-${item.name}`;

  return (
    <div
      className="glass rounded-[6px] overflow-hidden"
      style={{ borderLeft: `3px solid ${meta.color}` }}
    >
      <div className="p-3">
        <div className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded-[3px] text-[9px] font-medium shrink-0" style={{ background: `${meta.color}22`, color: meta.color, border: `1px solid ${meta.color}55` }}>
            {meta.label}
          </span>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)] shrink-0">
            {CATEGORY_LABELS[item.category]}
          </span>
          <div className="flex-1 text-xs font-medium text-[var(--text-primary)] font-mono truncate" title={item.name}>
            {item.name}
          </div>
          {item.ok ? (
            <CheckCircle2 size={13} className="text-[var(--success)] shrink-0" />
          ) : (
            <AlertTriangle size={13} style={{ color: meta.color }} className="shrink-0" />
          )}
        </div>

        <div className="mt-2 flex items-center gap-3 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--text-muted)]">当前</span>
            <span className="font-mono theme-text-primary">{item.currentValue}</span>
          </div>
          {item.recommended && (
            <>
              <span className="text-[var(--text-muted)]">→</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[var(--text-muted)]">推荐</span>
                <span className="font-mono" style={{ color: meta.color }}>{item.recommended}</span>
              </div>
            </>
          )}
        </div>

        <div className="mt-1.5 text-[11px] text-[var(--text-secondary)] leading-relaxed">{item.reason}</div>

        {item.command && (
          <div className="mt-2">
            <button
              onClick={toggleExpand}
              className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              {item.ok ? '查看命令' : '优化命令'}
            </button>
            {expanded && (
              <div className="mt-1.5 rounded-[5px] overflow-hidden cmd-code">
                <div className="flex items-center justify-between px-2.5 py-1 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)]">
                  <div className="text-[9px] text-[var(--text-muted)]">复制后人工确认执行</div>
                  <button
                    onClick={() => onCopy(item.command!, cmdId)}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated-hover)]"
                  >
                    {copiedId === cmdId ? <CheckCheck size={9} /> : <Copy size={9} />}
                    {copiedId === cmdId ? '已复制' : '复制'}
                  </button>
                </div>
                <pre className="p-2.5 text-[10px] font-mono text-[var(--accent)] overflow-x-auto whitespace-pre-wrap">{item.command}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
