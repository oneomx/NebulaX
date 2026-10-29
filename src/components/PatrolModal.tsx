import { useEffect, useState } from 'react';
import { ShieldAlert, Play, Loader2, Save, Check, Bell, BellOff, FileDown, FolderOpen, TrendingUp, Stethoscope } from 'lucide-react';
import { getAPI } from '../lib/api';
import Modal from './ui/Modal';
import { Label, Input } from './ui/Input';
import { Button } from './ui/Button';

interface PatrolConfig {
  enabled: boolean;
  intervalMinutes: number;
  thresholds: { cpu: number; mem: number; disk: number };
  notify: boolean;
  autoDiagnose: boolean;
  autoReport: boolean;
  trendWarnDays: number;
}

interface AlertItem {
  resource: 'cpu' | 'mem' | 'disk';
  severity: 'warning' | 'critical';
  currentPercent: number;
  threshold: number;
  mount?: string;
  suggestion: string;
  command?: string;
}

interface TrendAlertItem {
  resource: 'cpu' | 'mem' | 'disk';
  mount?: string;
  daysToFull: number | null;
  currentPercent: number;
  threshold: number;
  suggestion: string;
}

interface AutoDiagStep {
  command: string;
  purpose: string;
}

interface HostResult {
  host: string;
  ok: boolean;
  error?: string;
  cpuPercent?: number;
  memPercent?: number;
  disk?: { mount: string; usePercent: number; availGB: number }[];
  alerts: AlertItem[];
  trendAlerts?: TrendAlertItem[];
  autoDiagSteps?: AutoDiagStep[];
}

/** AI 巡检诊断结果（主进程告警后异步规划，通过 patrol:ai-diagnosis 推送） */
interface AiDiagnosis {
  host: string;
  incident: string;
  steps: { id: string; command: string; purpose: string }[];
}

/**
 * 定时巡检与主动预警面板：
 * - 配置巡检间隔与阈值，开启/关闭自动巡检
 * - 「立即巡检」手动跑一轮并展示结果
 * - 主进程每轮巡检后通过 onPatrolResult 推送，面板实时刷新
 */
export default function PatrolModal({ onClose }: { onClose: () => void }) {
  const api = getAPI();
  const [cfg, setCfg] = useState<PatrolConfig | null>(null);
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState(false);
  const [results, setResults] = useState<HostResult[]>([]);
  const [lastTs, setLastTs] = useState<number | null>(null);
  const [exported, setExported] = useState('');
  const [aiDiag, setAiDiag] = useState<AiDiagnosis | null>(null);

  useEffect(() => {
    (async () => {
      const res = await api.patrolGetConfig();
      if (res.ok && res.config) setCfg(res.config as PatrolConfig);
      const last = await api.patrolLastReport();
      if (last.ok && Array.isArray(last.results) && last.results.length > 0) {
        setResults(last.results as HostResult[]);
      }
    })();
    const off = api.onPatrolResult((r: any) => {
      if (r && Array.isArray(r.results)) {
        setResults(r.results);
        setLastTs(r.ts || Date.now());
      }
    });
    const offAi = api.onPatrolAiDiagnosis((r: any) => {
      if (r && r.host && Array.isArray(r.steps) && r.steps.length > 0) {
        setAiDiag({ host: r.host, incident: r.incident || '', steps: r.steps });
      }
    });
    return () => {
      off();
      offAi();
    };
  }, []);

  const save = async () => {
    if (!cfg) return;
    const res = await api.patrolSetConfig(cfg);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await api.patrolRunNow();
      if (res.ok && Array.isArray(res.results)) {
        setResults(res.results as HostResult[]);
        setLastTs(Date.now());
      } else if (res.error) {
        alert(`巡检失败：${res.error}`);
      }
    } finally {
      setRunning(false);
    }
  };

  const totalAlerts = results.reduce((n, r) => n + r.alerts.length, 0);
  const totalTrends = results.reduce((n, r) => n + (r.trendAlerts?.length || 0), 0);

  /** 导出最近一次巡检报告为 Markdown 文件 */
  const exportReport = async () => {
    setExported('');
    const res = await api.patrolExportReport();
    if (res.ok) {
      setExported(`已导出：${res.path || 'Markdown 报告'}`);
      setTimeout(() => setExported(''), 4000);
    } else if (res.error && res.error !== 'canceled') {
      alert(`导出失败：${res.error}`);
    }
  };

  /** 打开自动报告目录（~/.nebula-ssh/reports/） */
  const openReports = async () => {
    const res = await api.patrolOpenReports();
    if (!res.ok && res.error) alert(`打开失败：${res.error}`);
  };

  return (
    <Modal
      title="定时巡检与预警"
      subtitle="自动采集指标 · 超阈值主动通知"
      icon={<ShieldAlert size={16} strokeWidth={1.8} />}
      onClose={onClose}
      width="680px"
      footer={
        <>
          <div className="flex-1 items-center gap-2 min-w-0">
            {exported && (
              <span className="text-[11px] text-[var(--success)] truncate" title={exported}>
                {exported}
              </span>
            )}
          </div>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="secondary" onClick={openReports}>
            <FolderOpen size={14} />
            报告目录
          </Button>
          <Button variant="secondary" onClick={exportReport} disabled={results.length === 0}>
            <FileDown size={14} />
            导出报告（Markdown）
          </Button>
          <Button variant="secondary" onClick={runNow} disabled={running || !cfg}>
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            立即巡检
          </Button>
          <Button variant="primary" onClick={save} disabled={!cfg}>
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? '已保存' : '保存并生效'}
          </Button>
        </>
      }
    >
      {cfg && (
        <>
          {/* 开关与间隔 */}
          <div className="grid grid-cols-3 gap-3 items-end">
            <div>
              <Label text="自动巡检" />
              <button
                onClick={() => setCfg({ ...cfg, enabled: !cfg.enabled })}
                className={`w-full px-3 py-2 rounded-lg text-xs border transition ${
                  cfg.enabled
                    ? 'bg-[var(--success)]/10 text-[var(--success)] border-[var(--success)]/30'
                    : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-transparent'
                }`}
              >
                {cfg.enabled ? '已开启' : '已关闭'}
              </button>
            </div>
            <div>
              <Label text="巡检间隔（分钟，5~1440）" />
              <Input
                value={String(cfg.intervalMinutes)}
                onChange={(v) => setCfg({ ...cfg, intervalMinutes: Math.max(5, Math.min(1440, parseInt(v) || 30)) })}
              />
            </div>
            <div>
              <Label text="系统通知" />
              <button
                onClick={() => setCfg({ ...cfg, notify: !cfg.notify })}
                className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs border transition ${
                  cfg.notify
                    ? 'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/30'
                    : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-transparent'
                }`}
              >
                {cfg.notify ? <Bell size={12} /> : <BellOff size={12} />}
                {cfg.notify ? '严重告警发通知' : '不发通知'}
              </button>
            </div>
          </div>

          {/* 阈值 */}
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                ['cpu', 'CPU 阈值 (%)'],
                ['mem', '内存 阈值 (%)'],
                ['disk', '磁盘 阈值 (%)']
              ] as const
            ).map(([k, label]) => (
              <div key={k}>
                <Label text={label} />
                <Input
                  value={String(cfg.thresholds[k])}
                  onChange={(v) =>
                    setCfg({ ...cfg, thresholds: { ...cfg.thresholds, [k]: Math.max(1, Math.min(100, parseInt(v) || 85)) } })
                  }
                />
              </div>
            ))}
          </div>

          {/* AI 运维深化：自动诊断 / 趋势预警 / 报告落盘 */}
          <div className="grid grid-cols-3 gap-3 items-end">
            <div>
              <Label text="告警自动诊断" />
              <button
                onClick={() => setCfg({ ...cfg, autoDiagnose: !cfg.autoDiagnose })}
                className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs border transition ${
                  cfg.autoDiagnose
                    ? 'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/30'
                    : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-transparent'
                }`}
              >
                <Stethoscope size={12} />
                {cfg.autoDiagnose ? '告警时生成诊断步骤' : '不自动诊断'}
              </button>
            </div>
            <div>
              <Label text="趋势预警窗口（天，0=关）" />
              <Input
                value={String(cfg.trendWarnDays)}
                onChange={(v) => setCfg({ ...cfg, trendWarnDays: Math.max(0, Math.min(30, parseInt(v) || 0)) })}
              />
            </div>
            <div>
              <Label text="报告自动落盘" />
              <button
                onClick={() => setCfg({ ...cfg, autoReport: !cfg.autoReport })}
                className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs border transition ${
                  cfg.autoReport
                    ? 'bg-[var(--success)]/10 text-[var(--success)] border-[var(--success)]/30'
                    : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-transparent'
                }`}
              >
                <FileDown size={12} />
                {cfg.autoReport ? '每轮保存 Markdown' : '不自动保存'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* 巡检结果 */}
      <div className="border-t border-[var(--border-subtle)] pt-3">
        <div className="flex items-center justify-between mb-2">
          <Label text={lastTs ? `最近一轮巡检结果（${new Date(lastTs).toLocaleTimeString('zh-CN')}）` : '最近一轮巡检结果'} />
          <span className="text-[10px] text-[var(--text-muted)]">
            {results.length > 0
              ? `${results.length} 台主机 · ${totalAlerts} 项告警${totalTrends > 0 ? ` · ${totalTrends} 项趋势预警` : ''}`
              : '尚未巡检（需有已连接的 SSH 会话）'}
          </span>
        </div>
        <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
          {results.length === 0 && (
            <div className="text-[11px] text-[var(--text-muted)] py-4 text-center">
              开启自动巡检后将按间隔对所有已连接 SSH 会话采集指标；也可点「立即巡检」手动跑一轮。
            </div>
          )}
          {results.map((r, i) => (
            <div key={i} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium theme-text-primary">{r.host}</span>
                {!r.ok ? (
                  <span className="text-[10px] text-[var(--error)]">巡检失败：{r.error}</span>
                ) : r.alerts.length === 0 ? (
                  <span className="text-[10px] text-[var(--success)]">✅ 正常</span>
                ) : (
                  <span className="text-[10px] text-[var(--warning)]">{r.alerts.length} 项告警</span>
                )}
              </div>
              {r.ok && (
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5 font-mono">
                  CPU {r.cpuPercent?.toFixed(1)}% · 内存 {r.memPercent?.toFixed(1)}% · 磁盘{' '}
                  {r.disk?.map((d) => `${d.mount} ${d.usePercent}%`).join(' / ')}
                </div>
              )}
              {r.alerts.map((a, j) => (
                <div
                  key={j}
                  className={`mt-1.5 rounded px-2 py-1 text-[10px] ${
                    a.severity === 'critical' ? 'bg-[var(--error)]/10 text-[var(--error)]' : 'bg-[var(--warning)]/10 text-[var(--warning)]'
                  }`}
                >
                  <span className="font-medium">
                    {a.severity === 'critical' ? '🔴' : '🟡'} {a.resource === 'disk' ? `磁盘 ${a.mount}` : a.resource.toUpperCase()}{' '}
                    {a.currentPercent}%（阈值 {a.threshold}%）
                  </span>
                  <div className="opacity-80 mt-0.5">{a.suggestion}</div>
                  {a.command && <code className="block mt-0.5 font-mono opacity-70 break-all">{a.command}</code>}
                </div>
              ))}
              {/* 趋势提前预警（未超阈值但按线性回归将触顶） */}
              {(r.trendAlerts || []).map((t, j) => (
                <div key={`t-${j}`} className="mt-1.5 rounded px-2 py-1 text-[10px] bg-[var(--accent)]/10 text-[var(--accent)]">
                  <span className="font-medium flex items-center gap-1">
                    <TrendingUp size={10} />
                    趋势预警 {t.resource === 'disk' ? `磁盘 ${t.mount}` : t.resource.toUpperCase()} 当前 {t.currentPercent}%
                    {t.daysToFull !== null && t.daysToFull > 0 && <> · 预计 {t.daysToFull} 天触顶（阈值 {t.threshold}%）</>}
                  </span>
                  <div className="opacity-80 mt-0.5">{t.suggestion}</div>
                </div>
              ))}
              {/* 告警自动诊断步骤（本地规则生成，可复制执行） */}
              {r.autoDiagSteps && r.autoDiagSteps.length > 0 && (
                <details className="mt-1.5 rounded px-2 py-1 text-[10px] bg-[var(--bg-base)]/50 border border-[var(--border-subtle)]">
                  <summary className="cursor-pointer text-[var(--text-secondary)] flex items-center gap-1">
                    <Stethoscope size={10} />
                    自动诊断步骤（{r.autoDiagSteps.length} 条，点击展开）
                  </summary>
                  <div className="mt-1 space-y-1">
                    {r.autoDiagSteps.map((s, k) => (
                      <div key={k}>
                        <div className="text-[var(--text-secondary)]">{s.purpose}</div>
                        <code className="block font-mono text-[var(--text-muted)] break-all">{s.command}</code>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}
          {/* AI 巡检诊断（告警后异步规划，推送展示） */}
          {aiDiag && (
            <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--accent)]">
                <Stethoscope size={11} />
                AI 诊断方案 · {aiDiag.host}
              </div>
              {aiDiag.incident && <div className="text-[10px] text-[var(--text-secondary)] mt-1">{aiDiag.incident}</div>}
              <div className="mt-1.5 space-y-1">
                {aiDiag.steps.map((s, k) => (
                  <div key={s.id || k} className="text-[10px]">
                    <span className="text-[var(--text-secondary)]">{s.purpose}</span>
                    <code className="block font-mono text-[var(--text-muted)] break-all">{s.command}</code>
                  </div>
                ))}
              </div>
              <button onClick={() => setAiDiag(null)} className="mt-1.5 text-[9px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                收起
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
