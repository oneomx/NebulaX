import { useState, useEffect } from 'react';
import {
  Cpu,
  HardDrive,
  Activity,
  Clock,
  Users,
  Network,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  MemoryStick,
  Monitor,
  Container,
  Globe
} from 'lucide-react';
import { getAPI } from '../lib/api';
import type { SessionTab } from '../types';
import { getSessionMapping } from '../lib/sessionMap';

export default function ServerInfoPanel({ session }: { session: SessionTab }) {
  const [info, setInfo] = useState<any>(session.serverInfo);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const api = getAPI();

  const refresh = async () => {
    if (!session.id) return;
    setLoading(true);
    try {
      // 使用统一 sessionMap 工具
      const sid = getSessionMapping(session.id);
      if (sid) {
        const res = await api.sshGetServerInfo(sid);
        if (res.ok && res.info) setInfo(res.info);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (session.serverInfo) setInfo(session.serverInfo);
  }, [session.serverInfo]);

  if (!info) {
    return (
      <aside className="w-80 border-l border-[var(--border-subtle)] theme-bg-surface/40 flex flex-col">
        <PanelHeader onRefresh={refresh} loading={loading} />
        <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-muted)]">加载服务器信息...</div>
      </aside>
    );
  }

  const memPct = info.memTotal ? Math.round((info.memUsed / info.memTotal) * 100) : 0;

  return (
    <aside className="w-80 flex flex-col border-l border-[var(--border-subtle)] theme-bg-surface/40">
      <PanelHeader onRefresh={refresh} loading={loading} hostname={info.hostname} />

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* CPU / Memory cards */}
        <div className="grid grid-cols-2 gap-2">
          <MetricCard
            icon={<Cpu size={13} />}
            label="CPU 核心"
            value={String(info.cpuCores)}
            sub={info.cpuModel?.slice(0, 20)}
            color="var(--accent)"
          />
          <MetricCard
            icon={<MemoryStick size={13} />}
            label="内存使用"
            value={`${memPct}%`}
            sub={`${(info.memUsed / 1024).toFixed(1)}G / ${(info.memTotal / 1024).toFixed(1)}G`}
            color={memPct > 85 ? 'var(--error)' : 'var(--accent-secondary)'}
          />
        </div>

        {/* Memory bar */}
        <div className="glass rounded-[6px] p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">内存使用</div>
            <div className="text-[10px] text-[var(--text-secondary)]">{memPct}%</div>
          </div>
          <div className="h-2 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${memPct}%`,
                background: memPct > 85 ? 'var(--error)' : 'var(--accent)'
              }}
            />
          </div>
          <div className="flex justify-between mt-2 text-[10px] text-[var(--text-muted)]">
            <span>已用 {(info.memUsed / 1024).toFixed(1)} GB</span>
            <span>总 {(info.memTotal / 1024).toFixed(1)} GB</span>
          </div>
        </div>

        {/* System info */}
        <Section
          title="系统信息"
          icon={<Monitor size={13} />}
          collapsed={collapsed.sys}
          onToggle={() => setCollapsed((c) => ({ ...c, sys: !c.sys }))}
        >
          <InfoRow label="主机名" value={info.hostname} />
          <InfoRow label="操作系统" value={info.os} />
          <InfoRow label="内核" value={info.kernel} />
          <InfoRow label="架构" value={info.arch} />
          <InfoRow label="IP 地址" value={info.ipAddresses?.join(', ') || '-'} />
          <InfoRow label="运行时间" value={info.uptime} />
        </Section>

        {/* Load */}
        <Section
          title="系统负载"
          icon={<Activity size={13} />}
          collapsed={collapsed.load}
          onToggle={() => setCollapsed((c) => ({ ...c, load: !c.load }))}
        >
          <div className="grid grid-cols-3 gap-2">
            {['1 分钟', '5 分钟', '15 分钟'].map((label, i) => (
              <div key={i} className="glass-light rounded-lg p-2 text-center">
                <div className="text-[10px] text-[var(--text-muted)] mb-1">{label}</div>
                <div className="text-sm font-mono text-[var(--text-primary)]">{info.load?.[i] || '0.00'}</div>
              </div>
            ))}
          </div>
        </Section>

        {/* Disk */}
        <Section
          title="磁盘使用"
          icon={<HardDrive size={13} />}
          collapsed={collapsed.disk}
          onToggle={() => setCollapsed((c) => ({ ...c, disk: !c.disk }))}
        >
          <div className="space-y-2">
            {info.diskList?.map((d: any, i: number) => (
              <div key={i} className="glass-light rounded-lg p-2">
                <div className="flex justify-between text-[10px] mb-1">
                  <span className="text-[var(--text-secondary)] truncate">{d.mount}</span>
                  <span className="text-[var(--text-primary)] font-mono">{d.use}</span>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: d.use,
                      background:
                        parseInt(d.use) > 85
                          ? 'var(--error)'
                          : 'var(--accent)'
                    }}
                  />
                </div>
                <div className="flex justify-between text-[9px] text-[var(--text-muted)] mt-1">
                  <span>{d.fs}</span>
                  <span>
                    {d.used} / {d.size} · 可用 {d.avail}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Users */}
        <Section
          title="在线用户"
          icon={<Users size={13} />}
          collapsed={collapsed.users}
          onToggle={() => setCollapsed((c) => ({ ...c, users: !c.users }))}
        >
          <div className="space-y-1">
            {info.users?.map((u: string, i: number) => (
              <div key={i} className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <div className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
                <span className="font-mono">{u}</span>
              </div>
            ))}
            {info.users?.length === 0 && <div className="text-[11px] text-[var(--text-muted)]">无</div>}
          </div>
        </Section>

        {/* Top processes */}
        <Section
          title="内存 TOP 进程"
          icon={<Activity size={13} />}
          collapsed={collapsed.proc}
          onToggle={() => setCollapsed((c) => ({ ...c, proc: !c.proc }))}
        >
          <div className="space-y-1">
            {info.topProcesses?.map((p: string, i: number) => (
              <div key={i} className="text-[10px] font-mono text-[var(--text-secondary)] truncate">
                {p}
              </div>
            ))}
          </div>
        </Section>

        {/* Docker */}
        {info.docker && (
          <Section
            title="Docker 容器"
            icon={<Container size={13} />}
            collapsed={collapsed.docker}
            onToggle={() => setCollapsed((c) => ({ ...c, docker: !c.docker }))}
          >
            <pre className="text-[10px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
              {info.docker}
            </pre>
          </Section>
        )}
      </div>
    </aside>
  );
}

function PanelHeader({
  onRefresh,
  loading,
  hostname
}: {
  onRefresh: () => void;
  loading: boolean;
  hostname?: string;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border-subtle)]">
      <div>
        <div className="text-xs font-semibold theme-text-primary">服务器信息</div>
        {hostname && <div className="text-[10px] text-[var(--text-muted)]">{hostname}</div>}
      </div>
      <button
        onClick={onRefresh}
        className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--accent)] transition"
        title="刷新"
      >
        <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  sub,
  color
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div className="glass rounded-[6px] p-2.5">
      <div className="flex items-center gap-1.5 mb-1">
        <div style={{ color }}>{icon}</div>
        <div className="text-[10px] text-[var(--text-muted)]">{label}</div>
      </div>
      <div className="text-lg font-bold theme-text-primary leading-none">{value}</div>
      {sub && <div className="text-[9px] text-[var(--text-muted)] mt-1 truncate">{sub}</div>}
    </div>
  );
}

function Section({
  title,
  icon,
  collapsed,
  onToggle,
  children
}: {
  title: string;
  icon: React.ReactNode;
  collapsed?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="glass rounded-[6px] overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--bg-elevated)] transition">
        <div className="text-[var(--text-secondary)]">{icon}</div>
        <div className="text-xs font-medium text-[var(--text-primary)]">{title}</div>
        <div className="ml-auto text-[var(--text-muted)]">{collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</div>
      </button>
      {!collapsed && <div className="px-3 pb-3 space-y-1.5">{children}</div>}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 text-[11px]">
      <div className="text-[var(--text-muted)] shrink-0">{label}</div>
      <div className="text-[var(--text-primary)] text-right truncate font-mono">{value}</div>
    </div>
  );
}
