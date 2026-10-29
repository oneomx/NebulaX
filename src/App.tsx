import { useEffect, useState, useCallback, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import TerminalPanel, { disposeTerminalCache } from './components/TerminalPanel';
import AIPanel from './components/AIPanel';
import ServerInfoPanel from './components/ServerInfoPanel';
import ConnectionModal from './components/ConnectionModal';
import SettingsModal from './components/SettingsModal';
import WelcomeScreen from './components/WelcomeScreen';
import SftpPanel from './components/SftpPanel';
import TerminalPaneLayout from './components/TerminalPaneLayout';
import ExternalSessionPane from './components/ExternalSessionPane';
import TunnelManagerModal from './components/TunnelManagerModal';
import HostKeyDialog from './components/HostKeyDialog';
import HostKeysModal from './components/HostKeysModal';
import DatabaseModal from './components/DatabaseModal';
import PatrolModal from './components/PatrolModal';
import LicenseModal from './components/LicenseModal';
import { useAppStore } from './store/app';
import { useThemeStore, applyTheme } from './store/theme';
import { getAPI } from './lib/api';
import { getSessionMapping, deleteSessionMapping } from './lib/sessionMap';
import { restoreSessionTabs } from './lib/sessionRestore';
import { createLeaf, splitPane, closePane, collectLeaves } from './lib/paneTree';
import { spawnPaneSession, closePaneSession } from './lib/paneSessions';
import type { PaneNode, SavedConnection } from './types';

export default function App() {
  const {
    sessions,
    activeSessionId,
    sidebarOpen,
    aiPanelOpen,
    infoPanelOpen,
    licenseStatus,
    licenseModalOpen,
    setLicenseStatus,
    setLicenseModalOpen
  } = useAppStore();
  const theme = useThemeStore((s) => s.theme);

  const [showConnModal, setShowConnModal] = useState(false);
  const [editingConn, setEditingConn] = useState<SavedConnection | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTunnels, setShowTunnels] = useState(false);
  const [showHostKeys, setShowHostKeys] = useState(false);
  const [showDb, setShowDb] = useState(false);
  const [showPatrol, setShowPatrol] = useState(false);
  const [viewMode, setViewMode] = useState<'terminal' | 'files'>('terminal');
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);

  // 初始化 + 主题切换时应用
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 会话恢复：把上次未关闭的标签恢复为"未连接"状态（双击连接后重连）
  useEffect(() => {
    restoreSessionTabs();
  }, []);

  // v2.0 许可状态：启动时从主进程拉取
  useEffect(() => {
    (async () => {
      try {
        const r = await getAPI().licenseState();
        if (r.ok && r.state) setLicenseStatus(r.state);
      } catch {
        /* 老版本主进程无此通道 */
      }
    })();
  }, [setLicenseStatus]);

  // 到期只读：新建连接改为唤起许可弹窗（编辑已有连接不受限——只读可查看）
  const handleNewConnection = useCallback(() => {
    if (useAppStore.getState().licenseStatus?.status === 'expired') {
      setLicenseModalOpen(true);
      return;
    }
    setShowConnModal(true);
  }, [setLicenseModalOpen]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;
  const rootPane = useMemo(() => {
    return activeSession?.rootPane ?? (activeSession ? createLeaf(activeSession.id) : null);
  }, [activeSession?.id, activeSession?.rootPane]);

  const updateRootPane = useCallback(
    (next: PaneNode) => {
      if (!activeSession) return;
      useAppStore.getState().updateSession(activeSession.id, { rootPane: next });
    },
    [activeSession]
  );

  // 分屏：给当前焦点 pane（或第一个 leaf）分裂出新 pane
  const doSplit = useCallback(
    async (dir: 'row' | 'col') => {
      if (!activeSession || !rootPane) return;
      const leaves = collectLeaves(rootPane);
      const target = (focusedPaneId && leaves.includes(focusedPaneId) ? focusedPaneId : leaves[0]) as string;
      const newLeafId = `pane_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const next = splitPane(rootPane, target, dir, newLeafId);
      updateRootPane(next);
      // 为新 pane 建立独立 SSH 会话
      const connId = activeSession.connectionId;
      const conn = useAppStore.getState().connections.find((c) => c.id === connId);
      if (conn) {
        await spawnPaneSession(newLeafId, conn);
      }
      setFocusedPaneId(newLeafId);
    },
    [activeSession, rootPane, focusedPaneId, updateRootPane]
  );

  // 关闭当前焦点 pane
  const doClosePane = useCallback(async () => {
    if (!activeSession || !rootPane) return;
    const leaves = collectLeaves(rootPane);
    if (leaves.length <= 1) return; // 最后一个 pane 不关（用 Tab 关）
    const target = (focusedPaneId && leaves.includes(focusedPaneId) ? focusedPaneId : leaves[0]) as string;
    const next = closePane(rootPane, target);
    if (next) {
      updateRootPane(next);
      await closePaneSession(target);
      disposeTerminalCache(target);
      const remaining = collectLeaves(next);
      setFocusedPaneId(remaining[0] ?? null);
    }
  }, [activeSession, rootPane, focusedPaneId, updateRootPane]);

  // 快捷键：Cmd/Ctrl+\ 竖分、Cmd/Ctrl+Shift+\ 横分、Cmd/Ctrl+W 关闭 pane
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === '\\') {
        e.preventDefault();
        doSplit(e.shiftKey ? 'col' : 'row');
      } else if (e.key === 'w' && activeSession && viewMode === 'terminal') {
        // 仅在分屏（多 leaf）时拦截，否则走默认 Tab 关闭
        if (rootPane && collectLeaves(rootPane).length > 1) {
          e.preventDefault();
          doClosePane();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSplit, doClosePane, activeSession, rootPane, viewMode]);

  return (
    <div className="h-screen w-screen flex flex-col theme-bg-base theme-text-primary overflow-hidden bg-mesh">
      {/* Titlebar */}
      <TopBar
        onNewConnection={handleNewConnection}
        onOpenSettings={() => setShowSettings(true)}
        onOpenTunnels={() => setShowTunnels(true)}
        onOpenHostKeys={() => setShowHostKeys(true)}
        onOpenDb={() => setShowDb(true)}
        onOpenPatrol={() => setShowPatrol(true)}
      />

      {/* v2.0 到期只读横幅 */}
      {licenseStatus?.status === 'expired' && (
        <div className="flex items-center justify-center gap-2 px-4 py-1.5 bg-[var(--error)]/12 border-b border-[var(--error)]/25 text-[11px] text-[var(--error)]">
          <span>⚠ 试用已到期，当前为只读模式 — 新建连接与 AI 功能已锁定</span>
          <button onClick={() => setLicenseModalOpen(true)} className="underline font-medium hover:opacity-80">
            输入激活码
          </button>
        </div>
      )}

      {/* Main layout */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        {sidebarOpen && (
          <Sidebar
            onNewConnection={handleNewConnection}
            onEditConnection={(c) => setEditingConn(c)}
          />
        )}

        {/* Center area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tabs */}
          {sessions.length > 0 && (
            <TabBar viewMode={viewMode} setViewMode={setViewMode} />
          )}

          <div className="flex-1 flex min-h-0">
            {/* Terminal / SFTP / Welcome */}
            <div className="flex-1 flex flex-col min-w-0">
              {activeSession ? (
                activeSession.external ? (
                  // RDP/VNC：外部程序会话卡片
                  <ExternalSessionPane session={activeSession} />
                ) : viewMode === 'files' ? (
                  <SftpPanel session={activeSession} onClose={() => setViewMode('terminal')} />
                ) : rootPane && collectLeaves(rootPane).length > 1 ? (
                  <TerminalPaneLayout root={rootPane} session={activeSession} onChange={updateRootPane} onFocusPane={setFocusedPaneId} />
                ) : (
                  <div className="flex-1 min-h-0 flex" onFocus={() => setFocusedPaneId(rootPane && rootPane.type === 'leaf' ? rootPane.id : null)}>
                    <TerminalPanel session={activeSession} />
                  </div>
                )
              ) : (
                <WelcomeScreen onNewConnection={handleNewConnection} />
              )}
            </div>

            {/* Right info panel */}
            {activeSession && infoPanelOpen && viewMode === 'terminal' && (
              <ServerInfoPanel session={activeSession} />
            )}
          </div>
        </div>

        {/* AI Panel */}
        {aiPanelOpen && <AIPanel />}
      </div>

      {showConnModal && <ConnectionModal onClose={() => setShowConnModal(false)} />}
      {editingConn && (
        <ConnectionModal
          edit={editingConn}
          onClose={() => setEditingConn(null)}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showPatrol && <PatrolModal onClose={() => setShowPatrol(false)} />}
      {showHostKeys && <HostKeysModal onClose={() => setShowHostKeys(false)} />}
      {showDb && activeSession && !activeSession.external && (
        <DatabaseModal session={activeSession} onClose={() => setShowDb(false)} />
      )}
      {showTunnels && activeSessionId && (
        <TunnelManagerModal
          sessionId={getSessionMapping(activeSessionId) || activeSessionId}
          onClose={() => setShowTunnels(false)}
        />
      )}
      {/* 主机指纹确认弹窗（常驻挂载，由 connect 流程唤起） */}
      <HostKeyDialog />
      {/* v2.0 许可激活弹窗（全局开关，TopBar 徽章/只读横幅/多处入口唤起） */}
      {licenseModalOpen && <LicenseModal onClose={() => setLicenseModalOpen(false)} />}
    </div>
  );
}

function TabBar({ viewMode, setViewMode }: { viewMode: 'terminal' | 'files'; setViewMode: (m: 'terminal' | 'files') => void }) {
  const { sessions, activeSessionId, setActiveSession, removeSession } = useAppStore();

  const close = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const api = getAPI();
    const st = useAppStore.getState();
    const tab = st.sessions.find((s) => s.id === id);
    // 关闭该 tab 下所有 pane 会话（含分屏产生的）
    const paneIds = tab?.rootPane ? collectLeaves(tab.rootPane) : [id];
    for (const pid of paneIds) {
      const sshSid = getSessionMapping(pid);
      if (sshSid) {
        try {
          await api.sshDisconnect(sshSid);
        } catch {
          /* ignore */
        }
        deleteSessionMapping(pid);
      }
      disposeTerminalCache(pid);
    }
    // 也清理 tab 自身映射（单 pane 时 paneId === tab.id，已覆盖）
    const tabSid = getSessionMapping(id);
    if (tabSid) {
      await api.sshDisconnect(tabSid).catch(() => {});
      deleteSessionMapping(id);
    }
    disposeTerminalCache(id);
    removeSession(id);
  };

  return (
    <div className="flex items-end gap-1 px-2 pt-2 theme-bg-surface border-b border-[var(--border-subtle)] overflow-x-auto">
      {sessions.map((s) => (
        <button
          key={s.id}
          onClick={() => setActiveSession(s.id)}
          className={`drag-region-no flex items-center gap-2 px-3 py-2 rounded-t-lg text-xs font-medium transition-all ${
            s.id === activeSessionId
              ? 'tab-active text-[var(--text-primary)]'
              : 'tab-inactive text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              s.status === 'connected'
                ? 'bg-[var(--success)]'
                : s.status === 'connecting'
                ? 'bg-[var(--warning)]'
                : s.status === 'error'
                ? 'bg-[var(--error)]'
                : 'bg-[var(--text-muted)]'
            }`}
          />
          <span className="max-w-[140px] truncate">{s.title}</span>
          <span
            onClick={(e) => close(s.id, e)}
            className="drag-region-no ml-1 w-4 h-4 flex items-center justify-center rounded hover:bg-[var(--bg-elevated-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ×
          </span>
        </button>
      ))}

      {activeSessionId && (
        <div className="ml-auto flex items-center gap-1 pb-1">
          <button
            onClick={() => setViewMode('terminal')}
            className={`px-2 py-1 rounded text-[11px] transition ${
              viewMode === 'terminal'
                ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            终端
          </button>
          <button
            onClick={() => setViewMode('files')}
            className={`px-2 py-1 rounded text-[11px] transition ${
              viewMode === 'files'
                ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            文件
          </button>
        </div>
      )}
    </div>
  );
}
