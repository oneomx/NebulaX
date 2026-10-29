import { useState, useRef, useEffect } from 'react';
import {
  Bug,
  Play,
  Loader2,
  Copy,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CheckCircle2,
  AlertTriangle,
  Stethoscope,
  Send,
  X,
  Minus,
  LayoutGrid
} from 'lucide-react';
import { getAPI, type ScenarioPreset } from '../../lib/api';
import type { DiagnosticStep, DiagnosticReport } from '../../types/ai';
import { getSessionMapping } from '../../lib/sessionMap';
import { useModalEscape } from '../ui/useModalEscape';
import { useAppStore } from '../../store/app';
import ScenarioPicker from './ScenarioPicker';

interface Props {
  onClose: () => void;
  sessionId?: string | null;
  minimized?: boolean;
  onMinimize?: () => void;
  onStatusChange?: (running: boolean) => void;
}

export default function DiagnosticAgent({ onClose, sessionId, minimized, onMinimize, onStatusChange }: Props) {
  useModalEscape(onClose, !minimized);
  const [incident, setIncident] = useState('');
  const [context, setContext] = useState('');
  const [steps, setSteps] = useState<DiagnosticStep[]>([]);
  const [pendingPlan, setPendingPlan] = useState<DiagnosticStep[] | null>(null);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState<'plan' | 'exec' | 'analyze' | null>(null);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [scenario, setScenario] = useState<ScenarioPreset | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const api = getAPI();

  // 目标远端 OS（从会话的服务器信息推断）：Windows 目标要求 AI 只给原生命令
  const sessionMeta = useAppStore((s) => s.sessions.find((t) => t.id === sessionId));
  const remoteOS = /windows/i.test(sessionMeta?.serverInfo?.os || '') ? 'windows' : 'linux';

  // 向外层报告任务运行状态（供缩小后的悬浮窗显示）
  useEffect(() => {
    onStatusChange?.(loading !== null);
  }, [loading]);

  // 危险命令拦截：诊断流程只允许只读采集，破坏性命令一律拒绝执行
  const isDangerousCommand = (cmd: string): boolean => {
    const c = cmd.toLowerCase();
    return (
      /\brm\s+(-[a-z-]*\s+)*-\S*r\S*f/.test(c) || // rm -rf*
      /\brm\s+.*\s+\/\s*$/.test(c) || // rm ... /
      /\bmkfs/.test(c) ||
      /\bdd\s+[^;|&]*of=\/dev\//.test(c) ||
      /\b(shutdown|reboot|halt|poweroff)\b/.test(c) ||
      /\binit\s+[06]\b/.test(c) ||
      /:\(\)\s*\{.*\|.*&\s*\};\s*:/.test(c) || // fork bomb
      />\s*\/dev\/sd/.test(c)
    );
  };

  /** 用户确认后：顺序执行诊断命令 → 交 AI 分析 */
  const runPlan = async (planned: DiagnosticStep[]) => {
    setPendingPlan(null);
    setError('');
    setLoading('exec');

    try {
      // 使用统一 sessionMap 工具
      const sid = sessionId ? getSessionMapping(sessionId) : null;
      const executed: DiagnosticStep[] = [];

      for (let i = 0; i < planned.length; i++) {
        const step: DiagnosticStep = { ...planned[i], status: 'running' };
        setSteps((prev) => prev.map((s, idx) => (idx === i ? step : s)));

        if (isDangerousCommand(planned[i].command)) {
          step.status = 'failed';
          step.stderr = '危险命令已拦截：诊断流程仅允许只读采集命令';
        } else if (sid) {
          try {
            const res = await api.sshExec(sid, planned[i].command);
            step.stdout = res.stdout || '';
            step.stderr = res.stderr || '';
            // ok 仅代表通道正常；命令本身的成败以退出码判定
            step.status = res.ok && (res.code ?? 0) === 0 ? 'success' : 'failed';
          } catch {
            step.status = 'failed';
            step.stderr = '执行失败';
          }
        } else {
          // 浏览器预览模式
          await new Promise((r) => setTimeout(r, 400));
          step.stdout = `[预览模式] 命令 ${planned[i].command} 模拟执行\n(sample output)`;
          step.status = 'success';
        }
        setSteps((prev) => prev.map((s, idx) => (idx === i ? step : s)));
        executed.push(step);
      }

      // 分析
      setLoading('analyze');
      const analysisRes = await api.aiAnalyzeDiagnostic({ incident, steps: executed, os: remoteOS });
      if (analysisRes.ok && analysisRes.report) {
        setReport(analysisRes.report as DiagnosticReport);
      } else {
        setError(analysisRes.error || '分析失败');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(null);
    }
  };

  /** 仅规划：展示步骤清单，等待用户确认后再执行 */
  const startDiagnostic = async () => {
    if (!incident.trim()) return;
    setError('');
    setReport(null);
    setSteps([]);
    setPendingPlan(null);
    setLoading('plan');
    try {
      const planRes = await api.aiPlanDiagnostic({ incident, context: context || undefined, os: remoteOS });
      if (!planRes.ok || !planRes.steps?.length) {
        setError(planRes.error || '规划失败');
        return;
      }
      const planned = planRes.steps.map((s: any) => ({ ...s, status: 'pending' as const }));
      setSteps(planned);
      setPendingPlan(planned);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(null);
    }
  };

  const cancelPlan = () => {
    setPendingPlan(null);
    setSteps([]);
  };

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  /** 选中场景预设：带入故障现象 + 上下文提示，并展示推荐步骤 */
  const applyScenario = (s: ScenarioPreset) => {
    setScenario(s);
    setIncident(s.incident);
    if (s.contextHint) setContext(s.contextHint);
    setShowPicker(false);
    setReport(null);
    setError('');
  };

  // 缩小到后台：不渲染界面但保持挂载，任务继续执行
  if (minimized) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base)]/80 backdrop-blur-sm">
      <div className="glass rounded-[8px] w-[1100px] max-w-[95vw] h-[85vh] flex flex-col shadow-panel animate-slide-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border-subtle)]">
          <div className="w-9 h-9 rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)]">
            <Stethoscope size={16} strokeWidth={1.8} className="text-[var(--accent)]" />
          </div>
          <div className="flex-1">
            <div className="text-base font-semibold theme-text-primary">AI 故障根因定位</div>
            <div className="text-xs text-[var(--text-muted)]">多步 Agent 自动诊断：规划 → 采集 → 分析 → 定位</div>
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
          {/* Left */}
          <div className="w-[35%] flex flex-col border-r border-[var(--border-subtle)] p-4">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-[var(--text-secondary)]">故障现象描述</label>
              <button
                onClick={() => setShowPicker(true)}
                className="flex items-center gap-1 px-2 py-1 rounded-[4px] text-[10px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition"
                title="从 4 类 23 个预设场景中选择"
              >
                <LayoutGrid size={10} />
                场景预设
              </button>
            </div>
            <textarea
              value={incident}
              onChange={(e) => setIncident(e.target.value)}
              placeholder="如：网站响应缓慢、应用 502、内存溢出..."
              rows={5}
              className="w-full rounded-[6px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-none"
            />

            {/* 场景选中后的推荐步骤预览 */}
            {scenario && (
              <div className="mt-2 rounded-[6px] border border-[var(--accent)]/30 bg-[var(--accent)]/5 overflow-hidden">
                <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[var(--accent)]/20">
                  <div className="text-[10px] text-[var(--accent)] font-medium">
                    {scenario.icon} {scenario.name} · 推荐步骤
                  </div>
                  <button
                    onClick={() => setScenario(null)}
                    className="p-0.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    title="清除场景"
                  >
                    <X size={10} />
                  </button>
                </div>
                <div className="px-2.5 py-1.5 space-y-1 max-h-32 overflow-y-auto">
                  {scenario.steps.map((s, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-[10px]">
                      <span className="text-[var(--accent)] shrink-0 mt-px">{i + 1}.</span>
                      <div className="min-w-0">
                        <div className="font-mono text-[var(--text-primary)] break-all">{s.command}</div>
                        <div className="text-[var(--text-muted)]">{s.purpose}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <label className="text-xs text-[var(--text-secondary)] mb-1.5 mt-3">上下文（可选）</label>
            <input
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="如：Nginx + Java 应用，昨晚发布过"
              className="w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />

            {pendingPlan ? (
              <div className="mt-4 space-y-2">
                <div className="px-3 py-2 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/30 text-[var(--text-secondary)] text-[10px]">
                  已规划 {pendingPlan.length} 条采集命令，请确认后执行（破坏性命令会被自动拦截）
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => runPlan(pendingPlan)}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-[6px] theme-btn-primary font-medium hover:opacity-90"
                  >
                    <Play size={15} />
                    确认执行
                  </button>
                  <button
                    onClick={cancelPlan}
                    className="px-4 py-2.5 rounded-[6px] border border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-xs"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={startDiagnostic}
                disabled={loading !== null || !incident.trim()}
                className="mt-4 flex items-center justify-center gap-2 py-2.5 rounded-[6px] theme-btn-primary font-medium hover:opacity-90"
              >
                {loading ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                {loading === 'plan' ? '规划诊断...' : loading === 'exec' ? '采集中...' : loading === 'analyze' ? '分析中...' : '开始智能诊断'}
              </button>
            )}

            {error && (
              <div className="mt-3 px-3 py-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[var(--error)] text-xs">
                {error}
              </div>
            )}

            {/* Steps */}
            {steps.length > 0 && (
              <div className="mt-4 flex-1 overflow-y-auto">
                <div className="text-xs text-[var(--text-secondary)] mb-2 flex items-center gap-1">
                  <Play size={11} /> 诊断步骤
                </div>
                <div className="space-y-1.5">
                  {steps.map((s, i) => (
                    <div key={s.id} className="glass-light rounded-lg p-2">
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] ${
                            s.status === 'success'
                              ? 'bg-[var(--success)] text-[var(--text-primary)]'
                              : s.status === 'running'
                              ? 'bg-[var(--warning)] text-[var(--text-primary)]'
                              : s.status === 'failed'
                              ? 'bg-[var(--error)] text-[var(--text-primary)]'
                              : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
                          }`}
                        >
                          {s.status === 'success' ? <CheckCircle2 size={10} /> : s.status === 'running' ? <Loader2 size={10} className="animate-spin" /> : s.status === 'failed' ? <CircleAlert size={10} /> : i + 1}
                        </div>
                        <div className="flex-1 text-[11px] text-[var(--text-primary)] truncate">{s.purpose}</div>
                      </div>
                      <div className="mt-1 text-[10px] text-[var(--text-muted)] font-mono truncate">{s.command}</div>
                      {s.stdout && (
                        <button
                          onClick={() => setExpanded((c) => ({ ...c, [s.id]: !c[s.id] }))}
                          className="mt-1 flex items-center gap-1 text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                          {expanded[s.id] ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                          查看输出
                        </button>
                      )}
                      {expanded[s.id] && s.stdout && (
                        <pre className="mt-1 p-2 rounded bg-[var(--bg-elevated)] text-[9px] text-[var(--text-secondary)] font-mono max-h-24 overflow-y-auto whitespace-pre-wrap">{s.stdout.slice(0, 1500)}</pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right */}
          <div className="flex-1 flex flex-col p-4 overflow-y-auto">
            {loading === 'analyze' && (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
                <Loader2 size={28} className="animate-spin text-orange-400" />
                <div className="text-xs">AI 正在综合分析所有证据...</div>
              </div>
            )}

            {!report && loading !== 'analyze' && (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
                <Stethoscope size={36} className="opacity-25" />
                <div className="text-xs">左侧描述故障现象后开始诊断</div>
              </div>
            )}

            {report && (
              <>
                <div className="glass rounded-[6px] p-4 mb-3">
                  <div className="flex items-center gap-2">
                    <Bug size={16} className="text-orange-400" />
                    <div className="text-sm font-semibold theme-text-primary">根因分析</div>
                  </div>
                  <div className="text-xs text-[var(--text-secondary)] mt-2">{report.summary}</div>
                  <div className="mt-2 text-[10px] text-[var(--text-muted)]">故障现象：{report.incident}</div>
                </div>

                {report.allClear && (
                  <div className="px-3 py-2 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/30 text-[var(--success)] text-xs mb-3">
                    ✅ 暂未发现明显根因，系统状态基本正常
                  </div>
                )}

                <div className="space-y-2">
                  {report.rootCauses.map((c, i) => (
                    <RootCauseCard key={i} cause={c} onCopy={copy} copiedId={copiedId} />
                  ))}
                </div>

                {report.nextActions.length > 0 && (
                  <div className="mt-4">
                    <div className="text-xs text-[var(--text-secondary)] mb-2">下一步建议</div>
                    <div className="space-y-1">
                      {report.nextActions.map((a, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                          <div className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] mt-1.5" />
                          <div>{a}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* 场景预设选择器 */}
        {showPicker && <ScenarioPicker onClose={() => setShowPicker(false)} onSelect={applyScenario} />}
      </div>
    </div>
  );
}

function RootCauseCard({
  cause,
  onCopy,
  copiedId
}: {
  cause: any;
  onCopy: (t: string, id: string) => void;
  copiedId: string | null;
}) {
  const confColor = cause.confidence === 'high' ? '#10b981' : cause.confidence === 'medium' ? '#f59e0b' : '#64748b';
  const confLabel = cause.confidence === 'high' ? '高' : cause.confidence === 'medium' ? '中' : '低';

  return (
    <div className="glass rounded-[6px] overflow-hidden">
      <div className="p-3">
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="px-1.5 py-0.5 rounded-[3px] text-[10px] text-[var(--text-primary)]" style={{ background: confColor }}>
                可信度 {confLabel}
              </span>
              <div className="text-xs font-medium text-[var(--text-primary)]">{cause.hypothesis}</div>
            </div>
            <div className="text-[11px] text-[var(--text-secondary)] mt-1.5">{cause.impact}</div>
          </div>
        </div>

        <div className="mt-2 space-y-1">
          {cause.evidence?.map((ev: string, j: number) => (
            <div key={j} className="flex items-start gap-1.5 text-[10px] text-[var(--text-secondary)]">
              <span className="text-[var(--success)] mt-0.5">✓</span>
              <div>{ev}</div>
            </div>
          ))}
        </div>

        {cause.fixCommand && (
          <div className="mt-2.5 rounded-lg overflow-hidden cmd-code">
            <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)]">
              <div className="text-[9px] text-[var(--text-muted)]">{cause.fixDescription || '修复命令'}</div>
              <button
                onClick={() => onCopy(cause.fixCommand, `fix-${cause.hypothesis}`)}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
              >
                {copiedId === `fix-${cause.hypothesis}` ? <CheckCheck size={9} /> : <Copy size={9} />}
                {copiedId === `fix-${cause.hypothesis}` ? '已复制' : '复制'}
              </button>
            </div>
            <pre className="p-2.5 text-[10px] font-mono text-[var(--success)] overflow-x-auto whitespace-pre-wrap">{cause.fixCommand}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
