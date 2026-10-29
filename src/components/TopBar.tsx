import { Settings, Plus, Bot, PanelLeft, Cpu, Zap, Route, ShieldCheck, Stethoscope, Radio, Database, ShieldAlert, KeyRound } from 'lucide-react';
import { useAppStore } from '../store/app';
import { getAPI } from '../lib/api';

export default function TopBar({
  onNewConnection,
  onOpenSettings,
  onOpenTunnels,
  onOpenHostKeys,
  onOpenDb,
  onOpenPatrol
}: {
  onNewConnection: () => void;
  onOpenSettings: () => void;
  onOpenTunnels?: () => void;
  onOpenHostKeys?: () => void;
  onOpenDb?: () => void;
  onOpenPatrol?: () => void;
}) {
  const {
    toggleSidebar,
    toggleAiPanel,
    toggleInfoPanel,
    sidebarOpen,
    aiPanelOpen,
    infoPanelOpen,
    sessions,
    activeSessionId,
    connections,
    syncInput,
    toggleSyncInput,
    licenseStatus,
    setLicenseModalOpen
  } = useAppStore();
  const active = sessions.find((s) => s.id === activeSessionId);
  // 隧道入口仅对 SSH 会话显示（telnet/本地/串口/RDP/VNC 无 SSH 通道）
  const activeConn = active ? connections.find((c) => c.id === active.connectionId) : null;
  const canTunnel = !!active && !active.external && (!activeConn || (activeConn.type || 'ssh') === 'ssh');

  return (
    <header className="drag-region h-12 flex items-center justify-between px-4 theme-bg-surface border-b border-[var(--border-subtle)]">
      {/* Left: logo */}
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-[5px] theme-btn-primary flex items-center justify-center">
          <Zap size={14} strokeWidth={2} style={{ color: 'var(--accent-contrast)' }} />
        </div>
        <div className="flex items-baseline gap-1.5">
          <div className="text-[13px] font-semibold tracking-wide theme-text-primary">
            Nebula<span className="gradient-text">X</span>
          </div>
          <div className="text-[9px] text-[var(--text-muted)] tracking-[0.18em] uppercase">Server Ops</div>
        </div>
      </div>

      {/* Center: quick info */}
      <div className="flex items-center gap-2">
        {active && (
          <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded-[4px] glass-light text-[11px] tnum">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                active.status === 'connected' ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'
              }`}
            />
            <span className="theme-text-secondary">{active.host}</span>
            <span className="text-[var(--border-strong)]">|</span>
            <span className="theme-text-muted">{active.serverInfo?.os || '...'}</span>
          </div>
        )}
      </div>

      {/* Right: controls */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={toggleSidebar}
          title="切换侧栏"
          className={`drag-region-no p-2 rounded-[5px] transition-colors ${
            sidebarOpen ? 'text-[var(--accent)] bg-[var(--bg-elevated)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
          }`}
        >
          <PanelLeft size={15} strokeWidth={1.8} />
        </button>
        <button
          onClick={toggleInfoPanel}
          title="切换服务器信息面板"
          className={`drag-region-no p-2 rounded-[5px] transition-colors ${
            infoPanelOpen ? 'text-[var(--accent)] bg-[var(--bg-elevated)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
          }`}
        >
          <Cpu size={15} strokeWidth={1.8} />
        </button>
        <button
          onClick={toggleAiPanel}
          title="切换 AI 助手"
          className={`drag-region-no p-2 rounded-[5px] transition-colors ${
            aiPanelOpen ? 'text-[var(--accent)] bg-[var(--bg-elevated)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
          }`}
        >
          <Bot size={15} strokeWidth={1.8} />
        </button>
        {canTunnel && onOpenTunnels && (
          <button
            onClick={onOpenTunnels}
            title="SSH 隧道（本地转发 / SOCKS5 代理）"
            className="drag-region-no p-2 rounded-[5px] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <Route size={15} strokeWidth={1.8} />
          </button>
        )}
        {canTunnel && onOpenDb && (
          <button
            onClick={onOpenDb}
            title="数据库快速查询（经 SSH 在远端执行 mysql/psql）"
            className="drag-region-no p-2 rounded-[5px] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <Database size={15} strokeWidth={1.8} />
          </button>
        )}
        {onOpenHostKeys && (
          <button
            onClick={onOpenHostKeys}
            title="主机指纹管理（known_hosts）"
            className="drag-region-no p-2 rounded-[5px] text-[var(--text-muted)] hover:text-[var(--success)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <ShieldCheck size={15} strokeWidth={1.8} />
          </button>
        )}
        {onOpenPatrol && (
          <button
            onClick={onOpenPatrol}
            title="定时巡检与预警（自动采集指标，超阈值主动通知）"
            className="drag-region-no p-2 rounded-[5px] text-[var(--text-muted)] hover:text-[var(--warning)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <ShieldAlert size={15} strokeWidth={1.8} />
          </button>
        )}
        <button
          onClick={toggleSyncInput}
          title={
            syncInput
              ? '同步输入已开启：按键将广播到所有已连接终端（点击关闭）'
              : '同步输入：将按键广播到所有已连接的终端会话（批量操作多台服务器时使用）'
          }
          className={`drag-region-no p-2 rounded-[5px] transition-colors ${
            syncInput
              ? 'text-[var(--warning)] bg-[var(--bg-elevated)] animate-pulse'
              : 'text-[var(--text-muted)] hover:text-[var(--warning)] hover:bg-[var(--bg-elevated)]'
          }`}
        >
          <Radio size={15} strokeWidth={1.8} />
        </button>
        <button
          onClick={async () => {
            const res = await getAPI().diagExport();
            if (res.ok && res.path) {
              alert(`诊断包已导出：\n${res.path}`);
            } else if (res.error && res.error !== 'canceled') {
              alert(`导出失败：${res.error}`);
            }
          }}
          title="导出诊断包（日志+环境信息，用于问题反馈）"
          className="drag-region-no p-2 rounded-[5px] text-[var(--text-muted)] hover:text-[var(--warning)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Stethoscope size={15} strokeWidth={1.8} />
        </button>
        {/* v2.0 许可状态徽章 */}
        <button
          onClick={() => setLicenseModalOpen(true)}
          title={
            licenseStatus?.status === 'activated'
              ? '已激活（点击查看许可详情）'
              : licenseStatus?.status === 'trial'
              ? `试用中，剩余 ${licenseStatus.trialDaysLeft} 天（点击查看/输入激活码）`
              : '试用已到期，只读模式（点击输入激活码）'
          }
          className={`drag-region-no hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] text-[10px] font-medium transition-colors ${
            licenseStatus?.status === 'activated'
              ? 'text-[var(--success)] bg-[var(--success)]/10 hover:bg-[var(--success)]/15'
              : licenseStatus?.status === 'trial'
              ? (licenseStatus.trialDaysLeft ?? 99) <= 3
                  ? 'text-[var(--warning)] bg-[var(--warning)]/10 hover:bg-[var(--warning)]/15'
                  : 'text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/15'
              : 'text-[var(--error)] bg-[var(--error)]/10 hover:bg-[var(--error)]/15'
          }`}
        >
          <KeyRound size={11} strokeWidth={2.2} />
          {licenseStatus?.status === 'activated'
            ? '已激活'
            : licenseStatus?.status === 'trial'
            ? `试用 ${licenseStatus.trialDaysLeft} 天`
            : '已到期'}
        </button>
        <div className="w-px h-4 bg-[var(--border-subtle)] mx-2" />
        <button
          onClick={onNewConnection}
          title="新建连接"
          className="drag-region-no flex items-center gap-1.5 px-3 py-1.5 rounded-[5px] theme-btn-primary text-[11px] font-medium tracking-wide"
        >
          <Plus size={13} strokeWidth={2.2} />
          <span>新建连接</span>
        </button>
        <button
          onClick={onOpenSettings}
          title="设置"
          className="drag-region-no p-2 rounded-[5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Settings size={15} strokeWidth={1.8} />
        </button>

        {/* Window controls */}
        <WindowControls />
      </div>
    </header>
  );
}

function WindowControls() {
  const api = getAPI();
  return (
    <div className="drag-region-no flex items-center gap-0.5 ml-3">
      <button
        onClick={() => api.winMinimize?.()}
        className="w-6 h-6 rounded-[4px] hover:bg-[var(--bg-elevated-hover)] flex items-center justify-center text-[var(--text-muted)]"
      >
        <span className="w-2.5 h-px bg-current" />
      </button>
      <button
        onClick={() => api.winMaximize?.()}
        className="w-6 h-6 rounded-[4px] hover:bg-[var(--bg-elevated-hover)] flex items-center justify-center text-[var(--text-muted)]"
      >
        <span className="w-2 h-2 border border-current" />
      </button>
      <button
        onClick={() => api.winClose?.()}
        className="w-6 h-6 rounded-[4px] hover:bg-[var(--error)] hover:text-[var(--text-primary)] flex items-center justify-center text-[var(--text-muted)]"
      >
        <span className="w-2.5 h-px bg-current rotate-45 absolute" />
        <span className="w-2.5 h-px bg-current -rotate-45 absolute" />
      </button>
    </div>
  );
}
