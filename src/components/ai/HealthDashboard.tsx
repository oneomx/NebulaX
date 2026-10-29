import { useState, useEffect, useRef } from 'react';
import {
  Activity,
  RefreshCw,
  Loader2,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Info,
  Zap,
  X,
  Minus
} from 'lucide-react';
import { getAPI } from '../../lib/api';
import type { MetricSnapshot, ForecastResult, ForecastAlert } from '../../types/ai';
import { getSessionMapping } from '../../lib/sessionMap';
import { useModalEscape } from '../ui/useModalEscape';

interface Props {
  onClose: () => void;
  sessionId?: string | null;
  minimized?: boolean;
  onMinimize?: () => void;
  onStatusChange?: (running: boolean) => void;
}

export default function HealthDashboard({ onClose, sessionId, minimized, onMinimize, onStatusChange }: Props) {
  useModalEscape(onClose, !minimized);
  const [snapshots, setSnapshots] = useState<MetricSnapshot[]>([]);
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [loading, setLoading] = useState<'collect' | 'forecast' | null>(null);
  const [error, setError] = useState('');
  const timerRef = useRef<number | null>(null);
  const api = getAPI();

  // 向外层报告任务运行状态（供缩小后的悬浮窗显示）
  useEffect(() => {
    onStatusChange?.(loading !== null);
  }, [loading]);

  const collectSnapshot = async () => {
    if (!sessionId) return;
    // 使用统一 sessionMap 工具
    const sid = getSessionMapping(sessionId);
    if (!sid) return;
    try {
      const res = await api.sshMetricsSnapshot(sid);
      if (res.ok && res.snapshot) {
        setSnapshots((prev) => [...prev.slice(-19), res.snapshot as MetricSnapshot]);
      }
    } catch {}
  };

  useEffect(() => {
    if (!sessionId) return;
    // 立即采集一次
    collectSnapshot();
    // 每 30 秒自动采集
    timerRef.current = window.setInterval(collectSnapshot, 30000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [sessionId]);

  const runForecast = async () => {
    if (snapshots.length === 0) return;
    setLoading('forecast');
    setError('');
    setDegraded(false);
    try {
      const res = await api.aiForecast(snapshots);
      if (res.ok && res.result) {
        setForecast(res.result as ForecastResult);
        // AI 不可用时主进程自动降级本地线性回归（degraded=true）
        setDegraded(!!res.degraded);
      } else {
        setError(res.error || '预测失败');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(null);
    }
  };

  const last = snapshots[snapshots.length - 1];

  // 缩小到后台：不渲染界面但保持挂载，定时采样与任务继续执行
  if (minimized) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base)]/80 backdrop-blur-sm">
      <div className="glass rounded-[8px] w-[1100px] max-w-[95vw] h-[85vh] flex flex-col shadow-panel animate-slide-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border-subtle)]">
          <div className="w-9 h-9 rounded-[5px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--accent)]">
            <Activity size={16} strokeWidth={1.8} className="text-[var(--accent)]" />
          </div>
          <div className="flex-1">
            <div className="text-base font-semibold theme-text-primary">AI 健康看板 · 故障预测</div>
            <div className="text-xs text-[var(--text-muted)]">
              周期采样 + 趋势分析 + AI 预测磁盘/内存何时会告警
            </div>
          </div>
          <button
            onClick={collectSnapshot}
            disabled={loading !== null}
            className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title="手动采集一次"
          >
            <RefreshCw size={14} />
          </button>
          {onMinimize && (
            <button onClick={onMinimize} title="缩小到后台运行" className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              <Minus size={18} />
            </button>
          )}
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {!last ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3 py-20">
              <Loader2 size={28} className="animate-spin text-cyan-400" />
              <div className="text-xs">正在采集服务器指标...</div>
            </div>
          ) : (
            <>
              {/* Metric cards */}
              <div className="grid grid-cols-4 gap-3">
                <MetricCard label="CPU 使用" value={`${last.cpuPercent.toFixed(1)}%`} icon={<CpuIcon />} color="var(--accent)" />
                <MetricCard label="内存使用" value={`${last.memPercent.toFixed(1)}%`} icon={<MemIcon />} color="var(--accent-secondary)" />
                <MetricCard label="系统负载" value={last.load1.toFixed(2)} icon={<Activity size={14} />} color="#f59e0b" />
                <MetricCard label="TCP 连接" value={String(last.connections)} icon={<Zap size={14} />} color="#10b981" />
              </div>

              {/* Disk */}
              <div className="mt-5">
                <div className="text-sm font-semibold text-[var(--text-primary)] mb-2 flex items-center gap-1.5">
                  <DiskIcon /> 磁盘使用
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {last.disk.map((d, i) => (
                    <div key={i} className="glass rounded-[6px] p-3">
                      <div className="flex justify-between text-xs mb-2">
                        <span style={{ color: "var(--accent-contrast)" }}>{d.mount}</span>
                        <span className={d.usePercent > 85 ? 'text-[var(--error)]' : 'text-[var(--text-primary)]'}>{d.usePercent}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${d.usePercent}%`,
                            background:
                              d.usePercent > 85
                                ? 'var(--error)'
                                : 'var(--accent)'
                          }}
                        />
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] mt-1.5">可用 {d.availGB} GB</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Trend */}
              <div className="mt-5">
                <div className="text-sm font-semibold text-[var(--text-primary)] mb-2 flex items-center gap-1.5">
                  <TrendingUp size={15} className="text-cyan-400" /> 趋势（最近 {snapshots.length} 次）
                </div>
                <TrendChart snapshots={snapshots} />
              </div>

              {/* Forecast button */}
              <button
                onClick={runForecast}
                disabled={loading !== null}
                className="mt-5 flex items-center gap-2 px-5 py-2.5 rounded-[6px] theme-btn-primary font-medium hover:opacity-90"
              >
                {loading === 'forecast' ? <Loader2 size={15} className="animate-spin" /> : <TrendingUp size={15} />}
                {loading === 'forecast' ? '预测分析中...' : '容量与故障预测'}
              </button>

              {error && (
                <div className="mt-3 px-3 py-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[var(--error)] text-xs">{error}</div>
              )}

              {forecast && (
                <div className="mt-5">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="text-sm font-semibold theme-text-primary">{degraded ? '容量预测结果（本地回归）' : 'AI 预测结果'}</div>
                    <RiskBadge risk={forecast.overallRisk} />
                  </div>

                  {degraded && (
                    <div className="mb-3 px-3 py-2 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/30 text-[var(--text-secondary)] text-xs">
                      AI 未配置或调用失败，已自动降级为本地线性回归预测。在「设置 → AI 助手配置」填入 API Key 可获得更精准的 AI 分析。
                    </div>
                  )}

                  {forecast.alerts.length > 0 && (
                    <div className="space-y-2 mb-3">
                      {forecast.alerts.map((a, i) => (
                        <AlertCard key={i} alert={a} />
                      ))}
                    </div>
                  )}

                  {forecast.insights.length > 0 && (
                    <div className="glass rounded-[6px] p-3">
                      <div className="text-xs text-[var(--text-secondary)] mb-2">{degraded ? '💡 预测洞察' : '💡 AI 洞察'}</div>
                      <div className="space-y-1">
                        {forecast.insights.map((ins, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
                            <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] mt-1.5" />
                            <div>{ins}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
  return (
    <div className="glass rounded-[6px] p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <div style={{ color }}>{icon}</div>
        <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
      </div>
      <div className="text-xl font-bold text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

function TrendChart({ snapshots }: { snapshots: MetricSnapshot[] }) {
  const W = 900;
  const H = 180;
  const padX = 30;
  const padY = 20;
  const n = snapshots.length;
  if (n === 0) return null;

  const xs = (i: number) => padX + (i / Math.max(n - 1, 1)) * (W - 2 * padX);
  const ys = (v: number) => H - padY - (v / 100) * (H - 2 * padY);

  const cpuPath = snapshots.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xs(i)} ${ys(s.cpuPercent)}`).join(' ');
  const memPath = snapshots.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xs(i)} ${ys(s.memPercent)}`).join(' ');

  return (
    <div className="glass rounded-[6px] p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {[0, 25, 50, 75, 100].map((v) => (
          <line key={v} x1={padX} y1={ys(v)} x2={W - padX} y2={ys(v)} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        ))}
        {[0, 50, 100].map((v) => (
          <text key={v} x={padX - 5} y={ys(v) + 3} fill="#64748b" fontSize="9" textAnchor="end">{v}%</text>
        ))}
        <path d={cpuPath} fill="none" stroke="var(--accent)" strokeWidth="2" />
        <path d={memPath} fill="none" stroke="var(--accent-secondary)" strokeWidth="2" />
        {snapshots.map((s, i) => (
          <circle key={`c-${i}`} cx={xs(i)} cy={ys(s.cpuPercent)} r="2.5" fill="var(--accent)" />
        ))}
        {snapshots.map((s, i) => (
          <circle key={`m-${i}`} cx={xs(i)} cy={ys(s.memPercent)} r="2.5" fill="var(--accent-secondary)" />
        ))}
      </svg>
      <div className="flex items-center gap-4 mt-2 text-[10px]">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-0.5 rounded" style={{ background: 'var(--accent)' }} />
          <span className="text-[var(--text-secondary)]">CPU</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-0.5 rounded" style={{ background: 'var(--accent-secondary)' }} />
          <span className="text-[var(--text-secondary)]">内存</span>
        </div>
      </div>
    </div>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  const map: Record<string, { label: string; color: string }> = {
    low: { label: '风险低', color: '#10b981' },
    medium: { label: '风险中', color: '#f59e0b' },
    high: { label: '风险高', color: '#fb923c' },
    critical: { label: '严重', color: '#ef4444' }
  };
  const m = map[risk] || map.low;
  return (
    <span className="px-2 py-0.5 rounded-[3px] text-[10px] text-[var(--text-primary)] tnum" style={{ background: m.color }}>
      {m.label}
    </span>
  );
}

function AlertCard({ alert }: { alert: ForecastAlert }) {
  const color = alert.severity === 'critical' ? '#ef4444' : alert.severity === 'warning' ? '#f59e0b' : '#38bdf8';
  const icon = alert.severity === 'critical' ? <AlertTriangle size={13} /> : alert.severity === 'warning' ? <AlertTriangle size={13} /> : <Info size={13} />;

  return (
    <div className="glass rounded-[6px] p-3" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="flex items-start gap-2">
        <div style={{ color }} className="mt-0.5">{icon}</div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-[var(--text-primary)]">{alert.resource}</div>
            <div className="text-[10px] text-[var(--text-muted)]">
              当前 {alert.currentPercent}% · 阈值 {alert.threshold}%
            </div>
            {alert.daysToFull && (
              <div className="px-1.5 py-0.5 rounded-[3px] text-[9px] tnum" style={{ background: `${color}20`, color }}>
                预计 {alert.daysToFull.toFixed(1)} 天后到阈值
              </div>
            )}
          </div>
          <div className="text-[11px] text-[var(--text-secondary)] mt-1">{alert.suggestion}</div>
          {alert.command && (
            <pre className="mt-1.5 px-2.5 py-1.5 rounded bg-[var(--bg-elevated)] text-[10px] font-mono text-[var(--success)] overflow-x-auto">
              {alert.command}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function CpuIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v2M15 1v2M9 21v2M15 21v2M21 9h2M21 15h2M1 9h2M1 15h2" />
    </svg>
  );
}

function MemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10v4M10 10v4M14 10v4M18 10v4" />
    </svg>
  );
}

function DiskIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
      <path d="M22 12H2M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
      <line x1="6" y1="16" x2="6.01" y2="16" />
      <line x1="10" y1="16" x2="10.01" y2="16" />
    </svg>
  );
}
