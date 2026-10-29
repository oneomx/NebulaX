import { useState } from 'react';
import { Database, Play, Loader2, X, Plug, Table2, Stethoscope, Copy, CheckCheck, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { getAPI } from '../lib/api';
import type { DbConfig, DbQueryResult, SessionTab } from '../types';
import type { DbDiagReport } from '../types/ai';

/**
 * 数据库快速查询 —— 经当前 SSH 会话在远端执行 mysql/psql。
 * 典型场景：DB 在内网仅 SSH 可达，本地无客户端/驱动时直接查。
 * 密码仅内存传递（环境变量方式发给远端 CLI），不落盘不进 argv。
 */
const DEFAULTS = {
  mysql: { port: 3306, host: '127.0.0.1' },
  postgres: { port: 5432, host: '127.0.0.1' }
};

export default function DatabaseModal({ session, onClose }: { session: SessionTab; onClose: () => void }) {
  const sid = session.host; // 仅展示用
  const [cfg, setCfg] = useState<DbConfig>({
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: ''
  });
  const [sql, setSql] = useState('SELECT VERSION()');
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  // v1.7 数据库专项 AI 诊断
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagReport, setDiagReport] = useState<DbDiagReport | null>(null);
  const [diagDegraded, setDiagDegraded] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  // 由父组件通过 props 传入真实 sessionId（session.id -> sessionMap）
  const sidReal = getDbSid(session);

  const patch = (p: Partial<DbConfig>) => setCfg((c) => ({ ...c, ...p }));

  const switchType = (t: 'mysql' | 'postgres') => {
    setCfg((c) => ({ ...c, type: t, port: DEFAULTS[t].port }));
    setTestOk(false);
  };

  const doTest = async () => {
    if (!sidReal) return;
    setTesting(true);
    setTestOk(false);
    const res = await getAPI().dbTest(sidReal, cfg);
    setTesting(false);
    if (res.ok) setTestOk(true);
    else setError(res.error || '连接失败');
  };

  const doRun = async () => {
    if (!sidReal) return;
    setRunning(true);
    setError(null);
    setResult(null);
    const res = await getAPI().dbQuery(sidReal, cfg, sql);
    setRunning(false);
    if (res.ok && res.result) setResult(res.result);
    else setError(res.error || '查询失败');
  };

  /** v1.7 数据库专项 AI 诊断：只读采集连接/慢查询/锁/复制/大表 → 本地规则 + AI 分析 */
  const doDiagnose = async () => {
    if (!sidReal || diagLoading) return;
    setDiagLoading(true);
    setDiagError(null);
    setDiagReport(null);
    try {
      const res = await getAPI().aiDbDiagnose({
        sessionId: sidReal,
        dialect: cfg.type,
        context: cfg.database ? `数据库：${cfg.database}` : undefined
      });
      if (res.ok && res.report) {
        setDiagReport(res.report as DbDiagReport);
        setDiagDegraded(!!res.degraded);
      } else {
        setDiagError(res.error || '诊断失败');
      }
    } catch (e: any) {
      setDiagError(e?.message || String(e));
    } finally {
      setDiagLoading(false);
    }
  };

  const copyCmd = (cmd: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedCmd(cmd);
    setTimeout(() => setCopiedCmd(null), 2000);
  };

  const inputCls =
    'bg-[var(--bg-elevated)] rounded px-2 py-1 text-[12px] theme-text-primary outline-none border border-[var(--border-subtle)] focus:border-[var(--accent)] w-full';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="max-w-4xl w-full mx-4 rounded-xl glass border border-[var(--border-subtle)] max-h-[84vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2">
            <Database size={16} style={{ color: 'var(--accent)' }} />
            <span className="text-sm font-semibold">数据库快速查询</span>
            <span className="text-[11px] text-[var(--text-muted)]">经 SSH · {sid}</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]">
            <X size={16} />
          </button>
        </div>

        {/* 连接配置 */}
        <div className="px-5 py-3 border-b border-[var(--border-subtle)] grid grid-cols-7 gap-2 items-end">
          <div className="col-span-1">
            <label className="text-[10px] text-[var(--text-muted)] block mb-1">类型</label>
            <select
              value={cfg.type}
              onChange={(e) => switchType(e.target.value as 'mysql' | 'postgres')}
              className={inputCls}
            >
              <option value="mysql">MySQL</option>
              <option value="postgres">PostgreSQL</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="text-[10px] text-[var(--text-muted)] block mb-1">主机</label>
            <input value={cfg.host} onChange={(e) => patch({ host: e.target.value })} className={inputCls} placeholder="127.0.0.1（SSH 侧地址）" />
          </div>
          <div className="col-span-1">
            <label className="text-[10px] text-[var(--text-muted)] block mb-1">端口</label>
            <input type="number" value={cfg.port} onChange={(e) => patch({ port: Number(e.target.value) || 0 })} className={inputCls} />
          </div>
          <div className="col-span-1">
            <label className="text-[10px] text-[var(--text-muted)] block mb-1">用户</label>
            <input value={cfg.user} onChange={(e) => patch({ user: e.target.value })} className={inputCls} />
          </div>
          <div className="col-span-1">
            <label className="text-[10px] text-[var(--text-muted)] block mb-1">密码</label>
            <input type="password" value={cfg.password} onChange={(e) => patch({ password: e.target.value })} className={inputCls} placeholder="可空" />
          </div>
          <div className="col-span-1">
            <label className="text-[10px] text-[var(--text-muted)] block mb-1">数据库</label>
            <input value={cfg.database} onChange={(e) => patch({ database: e.target.value })} className={inputCls} />
          </div>
          <div className="col-span-7 flex items-center gap-2">
            <button
              onClick={() => void doTest()}
              disabled={testing || !sidReal}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-[11px] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-40 transition-colors"
            >
              {testing ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
              测试连接
            </button>
            {testOk && <span className="text-[11px] text-[var(--success)]">连接正常</span>}
            <button
              onClick={() => void doDiagnose()}
              disabled={diagLoading || !sidReal}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-[11px] border border-[var(--accent)]/40 text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40 transition-colors"
              title="只读采集连接数/慢查询/锁/复制/大表状态，本地规则 + AI 综合分析"
            >
              {diagLoading ? <Loader2 size={12} className="animate-spin" /> : <Stethoscope size={12} />}
              {diagLoading ? '采集中（约 10-20 秒）...' : 'AI 诊断'}
            </button>
            <span className="text-[10px] text-[var(--text-muted)] ml-auto">
              密码经环境变量传递，不进进程命令行；查询在 SSH 会话远端执行
            </span>
          </div>
        </div>

        {/* SQL 编辑区 */}
        <div className="px-5 py-3 border-b border-[var(--border-subtle)]">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-[var(--text-muted)]">SQL（Ctrl+Enter 执行）</span>
            <button
              onClick={() => void doRun()}
              disabled={running || !sidReal || !sql.trim()}
              className="flex items-center gap-1.5 px-3 py-1 rounded theme-btn-primary text-[11px] disabled:opacity-40"
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && e.ctrlKey) void doRun();
              }}
            >
              {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              执行
            </button>
          </div>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                void doRun();
              }
            }}
            rows={5}
            spellCheck={false}
            className={`${inputCls} font-mono resize-y leading-relaxed`}
          />
        </div>

        {/* 结果区 */}
        <div className="flex-1 overflow-auto px-5 py-3 min-h-[120px]">
          {/* v1.7 AI 诊断报告（结构化卡片，优先于查询结果展示） */}
          {diagError && (
            <div className="rounded-lg border border-[var(--error)]/40 bg-[var(--error)]/10 px-3 py-2 text-[12px] text-[var(--error)] mb-3">
              诊断失败：{diagError}
            </div>
          )}
          {diagReport && (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <Stethoscope size={13} style={{ color: 'var(--accent)' }} />
                <span className="text-[12px] font-medium theme-text-primary">
                  数据库诊断报告（{diagReport.dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'}）
                </span>
                {diagDegraded && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)] border border-[var(--warning)]/30">
                    AI 未响应 · 仅本地规则
                  </span>
                )}
                <button
                  onClick={() => setDiagReport(null)}
                  className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  收起
                </button>
              </div>
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/50 px-3 py-2 text-[12px] text-[var(--text-secondary)] leading-relaxed mb-2">
                {diagReport.summary}
              </div>
              {diagReport.failedSamples.length > 0 && (
                <div className="text-[10px] text-[var(--text-muted)] mb-2">
                  采集失败项（不影响结论）：{diagReport.failedSamples.join('、')}
                </div>
              )}
              {diagReport.findings.length === 0 ? (
                <div className="rounded-lg border border-[var(--success)]/30 bg-[var(--success)]/10 px-3 py-2 text-[12px] text-[var(--success)]">
                  <CheckCircle2 size={12} className="inline mr-1.5 -mt-0.5" />
                  各项数据库指标均在正常范围内
                </div>
              ) : (
                <div className="space-y-2">
                  {diagReport.findings.map((f, i) => (
                    <DbFindingCard key={i} finding={f} onCopy={copyCmd} copied={copiedCmd === f.command} />
                  ))}
                </div>
              )}
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-[var(--error)]/40 bg-[var(--error)]/10 px-3 py-2 text-[12px] text-[var(--error)] font-mono whitespace-pre-wrap break-all">
              {error}
            </div>
          )}
          {result && (
            <div>
              <div className="flex items-center gap-3 text-[11px] text-[var(--text-muted)] mb-2">
                <span className="flex items-center gap-1">
                  <Table2 size={11} />
                  {result.rows.length} 行
                </span>
                <span>{result.durationMs} ms</span>
                {result.affectedRows !== undefined && <span>影响 {result.affectedRows} 行</span>}
                {result.truncated && <span className="text-[var(--warning)]">结果超 500 行已截断</span>}
              </div>
              {result.rows.length > 0 ? (
                <div className="rounded-lg border border-[var(--border-subtle)] overflow-auto max-h-[46vh]">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0">
                      <tr className="bg-[var(--bg-elevated)]">
                        {result.columns.map((c, i) => (
                          <th key={i} className="text-left px-2.5 py-1.5 font-medium theme-text-primary border-b border-[var(--border-subtle)] whitespace-nowrap">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, ri) => (
                        <tr key={ri} className="hover:bg-[var(--bg-elevated)]/50">
                          {row.map((cell, ci) => (
                            <td
                              key={ci}
                              className="px-2.5 py-1 border-b border-[var(--border-subtle)]/50 font-mono whitespace-nowrap max-w-[280px] truncate"
                              title={cell === null ? 'NULL' : String(cell)}
                            >
                              {cell === null ? <span className="text-[var(--text-muted)] italic">NULL</span> : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-[11px] text-[var(--text-muted)]">
                  查询成功，无返回行{result.affectedRows !== undefined ? `（影响 ${result.affectedRows} 行）` : ''}
                </div>
              )}
            </div>
          )}
          {!result && !error && (
            <div className="text-center text-xs text-[var(--text-muted)] py-8">
              配置连接后执行 SQL。数据库需能被 SSH 会话所在服务器访问（主机填 SSH 侧地址，通常是 127.0.0.1）。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 从 session.id 反查真实 SSH sessionId（sessionMap） */
function getDbSid(session: SessionTab): string | null {
  // sessionMap 由 TerminalPanel 写入；这里同步读取 window 缓存
  const w = window as unknown as Record<string, unknown>;
  const map = (w['__nebulaSessionMap'] || {}) as Record<string, string>;
  return map[session.id] || null;
}

/** v1.7 诊断发现项卡片（severity 色条 + 当前/建议值 + 可复制 SQL） */
function DbFindingCard({
  finding,
  onCopy,
  copied
}: {
  finding: import('../types/ai').DbFinding;
  onCopy: (cmd: string) => void;
  copied: boolean;
}) {
  const meta: Record<string, { color: string; label: string }> = {
    critical: { color: '#ef4444', label: '严重' },
    high: { color: '#f97316', label: '高' },
    medium: { color: '#f59e0b', label: '中' },
    low: { color: '#3b82f6', label: '低' },
    info: { color: '#64748b', label: '提示' }
  };
  const m = meta[finding.severity] || meta.info;

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/50 overflow-hidden" style={{ borderLeft: `3px solid ${m.color}` }}>
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0" style={{ background: `${m.color}22`, color: m.color, border: `1px solid ${m.color}55` }}>
            {m.label}
          </span>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)] shrink-0">
            {finding.source === 'rule' ? '本地规则' : 'AI 分析'}
          </span>
          <span className="text-[12px] font-medium theme-text-primary truncate">{finding.title}</span>
          {finding.currentValue && (
            <span className="ml-auto text-[10px] font-mono text-[var(--text-muted)] shrink-0">当前 {finding.currentValue}</span>
          )}
        </div>
        <div className="mt-1.5 text-[11px] text-[var(--text-secondary)] leading-relaxed">{finding.detail}</div>
        {finding.recommended && (
          <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
            <span className="text-[var(--accent)]">建议：</span>{finding.recommended}
          </div>
        )}
        {finding.command && (
          <div className="mt-1.5 flex items-start gap-2 rounded bg-[var(--bg-base)] px-2 py-1.5 border border-[var(--border-subtle)]">
            <pre className="flex-1 text-[10px] font-mono text-[var(--accent)] whitespace-pre-wrap break-all">{finding.command}</pre>
            <button
              onClick={() => onCopy(finding.command!)}
              className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
            >
              {copied ? <CheckCheck size={9} /> : <Copy size={9} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
