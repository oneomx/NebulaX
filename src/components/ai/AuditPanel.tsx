import { useState, useEffect } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Play,
  Copy,
  CheckCheck,
  Loader2,
  RefreshCw,
  FileWarning,
  AlertTriangle,
  Bug,
  Terminal,
  FileText,
  Settings2,
  Activity,
  X,
  Minus
} from 'lucide-react';
import { getAPI } from '../../lib/api';
import type { AuditResult, AuditFinding, AuditCheck } from '../../types/ai';
import { getSessionMapping } from '../../lib/sessionMap';
import { useAppStore } from '../../store/app';
import { useModalEscape } from '../ui/useModalEscape';

interface Props {
  onClose: () => void;
  initialContent?: string;
  sessionId?: string | null;
  minimized?: boolean;
  onMinimize?: () => void;
  onStatusChange?: (running: boolean) => void;
}

export default function AuditPanel({ onClose, initialContent, sessionId, minimized, onMinimize, onStatusChange }: Props) {
  useModalEscape(onClose, !minimized);
  const [content, setContent] = useState(initialContent || '');
  const [contentType, setContentType] = useState<'terminal' | 'file' | 'config' | 'log'>('file');
  const [context, setContext] = useState('');
  const [result, setResult] = useState<AuditResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [autoFetching, setAutoFetching] = useState(false);

  const api = getAPI();

  // 活动会话（优先用外部传入的 tabId，缺失时回落到 store）——采集按钮的可用性判断
  const { sessions, activeSessionId: storeActiveId, connections } = useAppStore();
  const tabId = sessionId ?? storeActiveId ?? null;
  const activeTab = tabId ? sessions.find((s) => s.id === tabId) || null : null;
  const activeConn = activeTab ? connections.find((c) => c.id === activeTab.connectionId) || null : null;
  // 仅 SSH 会话支持服务器采集（Telnet/串口/本地/RDP/VNC 没有 SSH 通道）
  const isSSHSession =
    !!activeTab && !activeTab.external && (!activeConn || (activeConn.type || 'ssh') === 'ssh');
  const canAutoFetch = !!tabId && isSSHSession;
  const fetchBtnHint = !tabId
    ? '先在侧边栏双击连接一台 SSH 服务器，即可自动采集'
    : !isSSHSession
    ? '仅 SSH 会话支持自动采集（当前为 Telnet/串口/本地/RDP/VNC 会话）'
    : '自动采集服务器敏感配置、权限、端口等信息';

  // 向外层报告任务运行状态（供缩小后的悬浮窗显示）
  useEffect(() => {
    onStatusChange?.(loading);
  }, [loading]);

  const autoFetchFromServer = async () => {
    if (autoFetching) return;
    if (!tabId) {
      setError('请先打开一个 SSH 会话（侧边栏双击连接即可）');
      return;
    }
    if (!isSSHSession) {
      setError('仅 SSH 会话支持自动采集，当前会话不是 SSH 连接');
      return;
    }
    setAutoFetching(true);
    setError('');
    try {
      // 使用统一 sessionMap 工具
      const sid = getSessionMapping(tabId);
      if (!sid) {
        setError('未找到 SSH 会话（连接可能已断开，请重新连接）');
        return;
      }
      const res = await api.sshAuditData(sid);
      if (res.ok && res.data) {
        setContent(res.data);
        setContentType('config');
        setContext('自动从服务器采集的敏感配置 / 权限 / 端口信息');
      } else {
        setError(res.error || '采集失败');
      }
    } finally {
      setAutoFetching(false);
    }
  };

  const runAudit = async () => {
    if (!content.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await api.aiAudit({ content, contentType, context: context || undefined });
      if (res.ok && res.result) {
        setResult(res.result as AuditResult);
      } else {
        setError(res.error || '审计失败');
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

  // 缩小到后台：不渲染界面但保持挂载，任务继续执行
  if (minimized) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base)]/80 backdrop-blur-sm">
      <div className="glass rounded-[8px] w-[1100px] max-w-[95vw] h-[85vh] flex flex-col shadow-panel animate-slide-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border-subtle)]">
          <div className="w-9 h-9 rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)]">
            <ShieldCheck size={16} strokeWidth={1.8} className="text-[var(--accent)]" />
          </div>
          <div className="flex-1">
            <div className="text-base font-semibold theme-text-primary">AI 智能安全审计</div>
            <div className="text-xs text-[var(--text-muted)]">
              识别弱密码、危险权限、明文凭据、误配置、版本漏洞
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
          {/* Left input */}
          <div className="w-[45%] flex flex-col border-r border-[var(--border-subtle)] p-4">
            <div className="flex gap-2 mb-3">
              <TypeTab active={contentType === 'file'} onClick={() => setContentType('file')} icon={<FileText size={12} />} label="文件" />
              <TypeTab active={contentType === 'config'} onClick={() => setContentType('config')} icon={<Settings2 size={12} />} label="配置" />
              <TypeTab active={contentType === 'log'} onClick={() => setContentType('log')} icon={<Activity size={12} />} label="日志" />
              <TypeTab active={contentType === 'terminal'} onClick={() => setContentType('terminal')} icon={<Terminal size={12} />} label="终端" />
            </div>

            {/* 服务器自动采集入口：常驻显示，按状态提示（不再因无会话而消失） */}
            <button
              onClick={autoFetchFromServer}
              disabled={autoFetching || !canAutoFetch}
              title={fetchBtnHint}
              className={`mb-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs border transition ${
                canAutoFetch
                  ? 'bg-[var(--bg-elevated)] hover:border-[var(--accent)]/50 text-[var(--text-primary)] border-[var(--border-subtle)]'
                  : 'bg-[var(--bg-elevated)]/50 text-[var(--text-muted)] border-[var(--border-subtle)] cursor-not-allowed opacity-70'
              }`}
            >
              {autoFetching ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} className={canAutoFetch ? 'text-[var(--success)]' : ''} />
              )}
              {autoFetching
                ? '正在从服务器采集...'
                : canAutoFetch
                ? `从服务器采集（${activeTab?.title || activeTab?.host || 'SSH 会话'}）`
                : fetchBtnHint}
            </button>

            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="粘贴要审计的代码、配置、日志、终端输出..."
              className="flex-1 w-full rounded-[6px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono resize-none"
            />

            <div className="mt-3">
              <label className="text-xs text-[var(--text-secondary)] mb-1.5 block">上下文说明（可选）</label>
              <input
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="如：这是 nginx 的配置文件"
                className="w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>

            <button
              onClick={runAudit}
              disabled={loading || !content.trim()}
              className="mt-3 flex items-center justify-center gap-2 py-2.5 rounded-[6px] theme-btn-primary font-medium hover:opacity-90"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
              {loading ? '审计中...' : '开始 AI 审计'}
            </button>
          </div>

          {/* Right result */}
          <div className="flex-1 flex flex-col p-4 overflow-y-auto">
            {error && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[var(--error)] text-xs">
                {error}
              </div>
            )}

            {loading && (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
                <Loader2 size={28} className="animate-spin text-[var(--success)]" />
                <div className="text-xs">AI 正在深度审计中...</div>
                <div className="text-[10px] text-[var(--text-muted)] opacity-70">通常需要 10~60 秒，输入内容越多越慢</div>
              </div>
            )}

            {!loading && !result && !error && (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
                <ShieldCheck size={36} className="opacity-25" />
                <div className="text-xs">左侧输入内容后开始审计</div>
              </div>
            )}

            {result && !loading && result.parseError && (
              <div className="glass rounded-[6px] p-4 border border-[var(--warning)]/40">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[var(--warning)]">审计结果解析失败</div>
                    <div className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed">
                      AI 已返回内容，但不是有效的 JSON 报告。常见原因：输出被 max_tokens 截断、模型不支持 JSON 输出、或响应结构异常。
                      可尝试精简输入内容后重新审计，或在设置中更换模型。
                    </div>
                    {result.rawExcerpt && (
                      <pre className="mt-2.5 px-2.5 py-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] font-mono overflow-x-auto whitespace-pre-wrap max-h-40">
                        {result.rawExcerpt}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            )}

            {result && !loading && !result.parseError && (
              <>
                {result.truncated && (
                  <div className="mb-3 px-3 py-2 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/30 text-[var(--warning)] text-xs">
                    ⚠ AI 输出被截断，以下为抢救出的部分审计结果，建议精简输入后重新审计以获得完整报告。
                  </div>
                )}

                {result.aiSkipped && (
                  <div className="mb-3 px-3 py-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] text-xs">
                    AI 未响应（未配置密钥或网络异常），本次为<b className="text-[var(--text-primary)]">纯本地规则审计</b>——结论确定、无误报，但不含语义类风险分析。
                  </div>
                )}

                {!result.aiSkipped && (result.droppedCount || 0) > 0 && (
                  <div className="mb-3 px-3 py-2 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/30 text-[var(--success)] text-xs">
                    ✓ 已剔除 {result.droppedCount} 条证据无法逐字匹配原文的 AI 结论（防幻觉误报）
                  </div>
                )}

                {/* Score card */}
                <div className="glass rounded-[6px] p-4 mb-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-14 h-14 rounded-[6px] flex items-center justify-center text-[var(--text-primary)] text-2xl font-bold"
                      style={{
                        background:
                          result.score >= 80
                            ? 'var(--success)'
                            : result.score >= 60
                            ? 'var(--warning)'
                            : 'var(--error)'
                      }}
                    >
                      {result.score}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-semibold theme-text-primary">
                        安全评分 · {result.findings.length} 个风险
                      </div>
                      <div className="text-xs text-[var(--text-secondary)] mt-1">{result.summary}</div>
                      <div className="text-[10px] text-[var(--text-muted)] mt-1.5">
                        规则 {result.ruleCount ?? 0} 项 · AI {result.aiCount ?? 0} 项 · 评分由风险项确定性计算
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 text-[10px]">
                      <Badge count={result.findings.filter((f) => f.severity === 'critical').length} color="var(--error)" />
                      <Badge count={result.findings.filter((f) => f.severity === 'high').length} color="#fb923c" />
                      <Badge count={result.findings.filter((f) => f.severity === 'medium').length} color="var(--warning)" />
                    </div>
                  </div>
                </div>

                {/* 检查项覆盖：本地规则审计了哪些项、各自结论 */}
                {result.checks && result.checks.length > 0 && <ChecksPanel checks={result.checks} />}

                {/* Findings */}
                <div className="space-y-2">
                  {result.findings.map((f, i) => (
                    <FindingCard key={i} finding={f} onCopy={copy} copiedId={copiedId} />
                  ))}
                  {result.findings.length === 0 && (
                    <div className="text-center text-[var(--text-muted)] text-xs py-8">
                      {result.truncated ? '⚠ 输出被截断，未能解析出风险明细，请精简输入后重试' : '🎉 未发现安全风险'}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TypeTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition ${
        active ? 'bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/30' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function Badge({ count, color }: { count: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      <span className="text-[var(--text-secondary)]">{count}</span>
    </div>
  );
}

/** 检查项覆盖面板：本地规则审计了哪些项、各自结论（通过/风险/跳过） */
function ChecksPanel({ checks }: { checks: AuditCheck[] }) {
  const [expanded, setExpanded] = useState(false);
  const pass = checks.filter((c) => c.status === 'pass');
  const fail = checks.filter((c) => c.status === 'fail');
  const skip = checks.filter((c) => c.status === 'skip');

  return (
    <div className="glass rounded-[6px] p-3 mb-3">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 text-left">
        <ShieldCheck size={13} className="text-[var(--success)] shrink-0" />
        <span className="text-xs font-medium text-[var(--text-primary)]">规则检查项</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--success)]/15 text-[var(--success)]">通过 {pass.length}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--error)]/15 text-[var(--error)]">风险 {fail.length}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)]">跳过 {skip.length}</span>
        <span className="flex-1" />
        <span className="text-[10px] text-[var(--text-muted)]">{expanded ? '收起 ▲' : '展开明细 ▼'}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
          {checks.map((c) => (
            <div key={c.id} className="flex items-start gap-2 px-1.5 py-1 rounded text-[11px]">
              <span
                className="shrink-0 w-4 text-center font-medium"
                style={{ color: c.status === 'pass' ? 'var(--success)' : c.status === 'fail' ? 'var(--error)' : 'var(--text-muted)' }}
              >
                {c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '○'}
              </span>
              <span className="text-[var(--text-primary)] shrink-0">{c.name}</span>
              {c.detail && <span className="text-[var(--text-muted)] truncate">{c.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FindingCard({ finding, onCopy, copiedId }: { finding: AuditFinding; onCopy: (t: string, id: string) => void; copiedId: string | null }) {
  const sevColor =
    finding.severity === 'critical'
      ? '#ef4444'
      : finding.severity === 'high'
      ? '#fb923c'
      : finding.severity === 'medium'
      ? 'var(--warning)'
      : finding.severity === 'low'
      ? '#38bdf8'
      : '#64748b';
  const sevLabel =
    finding.severity === 'critical'
      ? '严重'
      : finding.severity === 'high'
      ? '高危'
      : finding.severity === 'medium'
      ? '中危'
      : finding.severity === 'low'
      ? '低危'
      : '提示';
  const sevIcon = finding.severity === 'critical' || finding.severity === 'high' ? <ShieldAlert size={12} /> : <Bug size={12} />;

  return (
    <div className="glass rounded-[6px] overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-primary)] shrink-0"
          style={{ background: sevColor }}
        >
          {sevIcon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="px-1.5 py-0.5 rounded-[3px] text-[10px] font-medium text-[var(--text-primary)]"
              style={{ background: sevColor }}
            >
              {sevLabel}
            </span>
            <span
              className="px-1.5 py-0.5 rounded-[3px] text-[10px] font-medium"
              style={
                finding.source === 'rule'
                  ? { background: 'rgba(16,185,129,0.15)', color: 'var(--success)' }
                  : { background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }
              }
              title={finding.source === 'rule' ? '本地确定性规则判定，结论可复现' : 'AI 语义分析，证据已逐字校验'}
            >
              {finding.source === 'rule' ? '规则·确定' : 'AI 分析'}
            </span>
            <span className="text-[10px] text-[var(--text-muted)] px-1.5 py-0.5 rounded-[3px] bg-[var(--bg-elevated)]">{finding.category}</span>
            <div className="text-xs font-medium text-[var(--text-primary)] truncate">{finding.title}</div>
          </div>
          <div className="text-[11px] text-[var(--text-secondary)] mt-1.5 leading-relaxed">{finding.description}</div>
          {finding.evidence && (
            <pre className="mt-2 px-2.5 py-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] font-mono overflow-x-auto whitespace-pre-wrap">
              {finding.evidence.slice(0, 300)}
            </pre>
          )}
          <div className="mt-2.5 flex items-start gap-2">
            <div className="text-[11px] text-[var(--success)] flex items-start gap-1.5">
              <span className="text-[var(--success)]">✓</span>
              <span>{finding.remediation}</span>
            </div>
          </div>
          {finding.command && (
            <div className="mt-2 rounded-lg overflow-hidden cmd-code">
              <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)]">
                <div className="text-[9px] text-[var(--text-muted)] font-mono">修复命令</div>
                <button
                  onClick={() => onCopy(finding.command!, `cmd-${finding.title}`)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                >
                  {copiedId === `cmd-${finding.title}` ? <CheckCheck size={9} /> : <Copy size={9} />}
                  {copiedId === `cmd-${finding.title}` ? '已复制' : '复制'}
                </button>
              </div>
              <pre className="p-2.5 text-[10px] font-mono text-[var(--success)] overflow-x-auto whitespace-pre-wrap">{finding.command}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
