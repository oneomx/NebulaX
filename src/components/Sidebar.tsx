import { useState } from 'react';
import {
  Server,
  Plus,
  Search,
  Trash2,
  LogIn,
  ChevronDown,
  ChevronRight,
  Pencil,
  Check,
  X,
  FolderPlus,
  FolderCog,
  Globe,
  Network,
  Usb,
  Terminal,
  Monitor,
  ScreenShare
} from 'lucide-react';
import { useAppStore } from '../store/app';
import { getAPI } from '../lib/api';
import { connectSavedConnection, openLocalTerminal } from '../lib/connect';
import GroupsManagerModal from './GroupsManagerModal';
import type { SavedConnection, ConnectionType } from '../types';

const UNGROUPED = '未分组';

/** 本地终端 shell 显示名 */
function shellLabel(shellId?: string): string {
  const map: Record<string, string> = {
    powershell: 'PowerShell',
    pwsh: 'PowerShell 7',
    cmd: 'CMD',
    wsl: 'WSL',
    'git-bash': 'Git Bash',
    bash: 'Bash',
    custom: '自定义'
  };
  return map[shellId || 'powershell'] || shellId || 'PowerShell';
}

/** 各协议类型图标与提示 */
const TYPE_ICONS: Record<ConnectionType, { icon: React.ReactNode; label: string }> = {
  ssh: { icon: <Server size={14} />, label: 'SSH' },
  telnet: { icon: <Network size={14} />, label: 'Telnet' },
  serial: { icon: <Usb size={14} />, label: '串口' },
  local: { icon: <Terminal size={14} />, label: '本地终端' },
  rdp: { icon: <Monitor size={14} />, label: 'RDP 远程桌面' },
  vnc: { icon: <ScreenShare size={14} />, label: 'VNC' }
};

/** 默认标识色按类型区分 */
const TYPE_COLORS: Record<ConnectionType, string> = {
  ssh: '#22d3ee',
  telnet: '#34d399',
  serial: '#fbbf24',
  local: '#a78bfa',
  rdp: '#f87171',
  vnc: '#ec4899'
};

export default function Sidebar({
  onNewConnection,
  onEditConnection
}: {
  onNewConnection: () => void;
  onEditConnection: (conn: SavedConnection) => void;
}) {
  const {
    connections,
    groups,
    removeConnection,
    addSession,
    setActiveSession,
    updateConnection,
    addGroup,
    renameGroup,
    removeGroup
  } = useAppStore();
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [showGroupMgr, setShowGroupMgr] = useState(false);

  // 拖拽换组：把连接挂到目标分组（未分组 = 清空 group 字段）
  const dropToGroup = (e: React.DragEvent, g: string) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    if (id) {
      const target = g === UNGROUPED ? undefined : g;
      const conn = useAppStore.getState().connections.find((c) => c.id === id);
      if (conn && (conn.group || UNGROUPED) !== g) {
        updateConnection(id, { group: target });
      }
    }
    setDragId(null);
    setDragOverGroup(null);
  };

  const keyword = q.trim().toLowerCase();
  const searching = keyword.length > 0;
  const filtered = connections.filter(
    (c) =>
      !keyword ||
      c.name.toLowerCase().includes(keyword) ||
      c.host.toLowerCase().includes(keyword) ||
      (c.username || '').toLowerCase().includes(keyword) ||
      (c.group || '').toLowerCase().includes(keyword)
  );

  // 分组顺序：用户分组（store 顺序）→ 连接里派生出的组名 → 未分组
  const derived = Array.from(new Set(connections.map((c) => c.group || UNGROUPED)));
  const orderedGroups = [
    ...groups,
    ...derived.filter((g) => g !== UNGROUPED && !groups.includes(g)),
    ...(derived.includes(UNGROUPED) ? [UNGROUPED] : [])
  ];

  const itemsByGroup: Record<string, SavedConnection[]> = {};
  filtered.forEach((c) => {
    const g = c.group || UNGROUPED;
    (itemsByGroup[g] ||= []).push(c);
  });

  // 搜索时展示有匹配项的组；非搜索时展示全部组（含空分组，便于管理）
  const visibleGroups = searching
    ? orderedGroups.filter((g) => (itemsByGroup[g]?.length ?? 0) > 0)
    : orderedGroups;

  const confirmNewGroup = () => {
    const n = newGroupName.trim();
    if (n) addGroup(n);
    setNewGroupName('');
    setAddingGroup(false);
  };

  const confirmRenameGroup = () => {
    if (editingGroup) renameGroup(editingGroup, editingGroupName);
    setEditingGroup(null);
    setEditingGroupName('');
  };

  const handleConnect = async (conn: SavedConnection) => {
    if (connecting) return;
    setConnecting(conn.id);
    const type = conn.type || 'ssh';
    const tabId = `tab_${Date.now()}`;
    addSession({
      id: tabId,
      connectionId: conn.id,
      title: conn.name || conn.host || conn.serialPath || type.toUpperCase(),
      host: conn.host,
      status: 'connecting',
      // RDP/VNC 走外部程序，标签页展示启动卡片
      ...(type === 'rdp' || type === 'vnc' ? { external: { kind: type, host: conn.host } } : {})
    });
    setActiveSession(tabId);
    try {
      await connectSavedConnection(conn, tabId);
    } finally {
      setConnecting(null);
    }
  };

  /** 快捷入口：无需保存配置直接开本地终端 */
  const handleLocalTerminal = async () => {
    if (connecting) return;
    setConnecting('__local__');
    try {
      await openLocalTerminal();
    } finally {
      setConnecting(null);
    }
  };

  return (
    <aside className="w-64 flex flex-col border-r border-[var(--border-subtle)] theme-bg-surface">
      {/* Search */}
      <div className="p-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索服务器..."
            className="w-full pl-8 pr-7 py-2 rounded-lg theme-input text-xs"
          />
          {q && (
            <button
              onClick={() => setQ('')}
              title="清空搜索"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Group management */}
      <div className="px-3 pb-2 flex items-center justify-between">
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">分组</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowGroupMgr(true)}
            title="分组管理：重命名 / 排序 / 删除"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)]"
          >
            <FolderCog size={11} />
            管理
          </button>
          <button
            onClick={() => {
              setAddingGroup((v) => !v);
              setNewGroupName('');
            }}
            title="新建分组"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)]"
          >
            <FolderPlus size={11} />
            新建分组
          </button>
        </div>
      </div>
      {addingGroup && (
        <div className="px-3 pb-2 flex items-center gap-1">
          <input
            autoFocus
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmNewGroup();
              if (e.key === 'Escape') {
                setAddingGroup(false);
                setNewGroupName('');
              }
            }}
            placeholder="分组名称，回车确认"
            className="flex-1 min-w-0 px-2 py-1 rounded theme-input text-[11px]"
          />
          <button
            onClick={confirmNewGroup}
            title="确认"
            className="p-1 rounded text-[var(--success)] hover:bg-[var(--bg-elevated)]"
          >
            <Check size={12} />
          </button>
          <button
            onClick={() => {
              setAddingGroup(false);
              setNewGroupName('');
            }}
            title="取消"
            className="p-1 rounded text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 pb-3 theme-scroll">
        {visibleGroups.map((g) => {
          const items = itemsByGroup[g] || [];
          // 搜索时强制展开，避免折叠组里的匹配项被隐藏
          const isCollapsed = !searching && !!collapsed[g];
          const isVirtual = g === UNGROUPED;
          return (
            <div
              key={g}
              className={`mb-3 rounded-lg transition-colors ${
                dragOverGroup === g ? 'ring-1 ring-[var(--accent)] bg-[var(--accent)]/10' : ''
              }`}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDragOverGroup(g);
              }}
              onDragLeave={(e) => {
                // 仅在真正离开该分组区域时取消高亮（避免子元素间移动闪烁）
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOverGroup((cur) => (cur === g ? null : cur));
                }
              }}
              onDrop={(e) => dropToGroup(e, g)}
            >
              <div className="group/head flex items-center gap-1 px-2 py-1.5 w-full">
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [g]: !c[g] }))}
                  className="flex items-center gap-1 flex-1 min-w-0 text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider hover:text-[var(--text-primary)]"
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span className="truncate">{g}</span>
                  <span className="ml-auto text-[var(--text-muted)] font-normal">{items.length}</span>
                </button>
                {!isVirtual &&
                  (editingGroup === g ? (
                    <span className="flex items-center gap-0.5">
                      <input
                        autoFocus
                        value={editingGroupName}
                        onChange={(e) => setEditingGroupName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') confirmRenameGroup();
                          if (e.key === 'Escape') {
                            setEditingGroup(null);
                            setEditingGroupName('');
                          }
                        }}
                        className="w-20 px-1 py-0.5 rounded theme-input text-[10px]"
                      />
                      <button
                        onClick={confirmRenameGroup}
                        title="确认重命名"
                        className="p-0.5 rounded text-[var(--success)] hover:bg-[var(--bg-elevated)]"
                      >
                        <Check size={11} />
                      </button>
                    </span>
                  ) : (
                    <span className="hidden group-hover/head:flex items-center gap-0.5">
                      <button
                        onClick={() => {
                          setEditingGroup(g);
                          setEditingGroupName(g);
                        }}
                        title="重命名分组"
                        className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)]"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={() => removeGroup(g)}
                        title="删除分组（组内连接保留，退回未分组）"
                        className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-elevated)]"
                      >
                        <Trash2 size={11} />
                      </button>
                    </span>
                  ))}
              </div>

              {!isCollapsed && items.length === 0 && (
                <div className="px-3 py-1.5 text-[10px] text-[var(--text-muted)]">（空分组）</div>
              )}

              {!isCollapsed &&
                items.map((c) => {
                  const ctype = c.type || 'ssh';
                  const tmeta = TYPE_ICONS[ctype];
                  const ccolor = c.color || TYPE_COLORS[ctype];
                  return (
                  <div
                    key={c.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', c.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(c.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDragOverGroup(null);
                    }}
                    title={`双击${ctype === 'rdp' || ctype === 'vnc' ? '打开' : '连接'} · ${tmeta.label}${ctype === 'serial' ? ` (${c.serialPath || ''})` : ''} · 可拖动到其他分组`}
                    className={`group flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-[var(--bg-elevated)] cursor-pointer ${
                      dragId === c.id ? 'opacity-40' : ''
                    }`}
                    onDoubleClick={() => handleConnect(c)}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: `${ccolor}20`, border: `1px solid ${ccolor}40` }}
                    >
                      <span style={{ color: ccolor }}>{tmeta.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium theme-text-primary truncate">{c.name}</div>
                      <div className="text-[10px] text-[var(--text-muted)] truncate">
                        {ctype === 'serial'
                          ? `${c.serialPath || ''} @${c.baudRate || 9600}`
                          : ctype === 'local'
                          ? `${shellLabel(c.shell)} · 本地`
                          : ctype === 'ssh'
                          ? `${c.username}@${c.host}`
                          : `${tmeta.label} · ${c.host}${c.port && c.port !== 0 ? `:${c.port}` : ''}`}
                      </div>
                    </div>
                    <div className="hidden group-hover:flex items-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleConnect(c);
                        }}
                        title="连接"
                        className="p-1 rounded hover:bg-[var(--bg-elevated-hover)] text-[var(--accent)]"
                      >
                        <LogIn size={13} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditConnection(c);
                        }}
                        title="编辑"
                        className="p-1 rounded hover:bg-[var(--bg-elevated-hover)] text-[var(--text-secondary)]"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeConnection(c.id);
                          // 同步清理 vault 中该连接的凭据（密码/私钥等），避免残留孤儿密钥
                          try {
                            const api = getAPI() as { vaultDelete?: (id: string) => Promise<unknown> };
                            if (api.vaultDelete) void api.vaultDelete(c.id);
                          } catch { /* vault 不可用时忽略 */ }
                        }}
                        title="删除"
                        className="p-1 rounded hover:bg-[var(--error)]/20 text-[var(--error)]"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  );
                })}
            </div>
          );
        })}

        {searching && filtered.length === 0 && (
          <div className="text-center py-10 text-[var(--text-muted)] text-xs">
            <Search size={28} className="mx-auto mb-2 opacity-30" />
            <div>没有匹配「{q.trim()}」的服务器</div>
            <div className="text-[10px] mt-1">支持按名称 / 主机 / 用户名 / 分组搜索</div>
          </div>
        )}

        {!searching && connections.length === 0 && groups.length === 0 && (
          <div className="text-center py-12 text-[var(--text-muted)] text-xs">
            <Globe size={32} className="mx-auto mb-3 opacity-30" />
            <div>暂无保存的服务器</div>
            <div className="text-[10px] mt-1">点击下方按钮添加</div>
          </div>
        )}
      </div>

      {/* Add button */}
      <div className="p-3 border-t border-[var(--border-subtle)] space-y-2">
        <button
          onClick={handleLocalTerminal}
          title="打开本机终端（PowerShell / CMD / WSL）"
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-[var(--bg-elevated)] hover:bg-[var(--bg-elevated-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-xs transition"
        >
          <Terminal size={14} />
          本地终端
        </button>
        <button
          onClick={onNewConnection}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-dashed border-[var(--border-strong)] hover:border-[var(--accent)] hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-xs transition"
        >
          <Plus size={14} />
          新建连接
        </button>
      </div>

      {/* 分组管理弹窗（集中新建/重命名/排序/删除） */}
      {showGroupMgr && <GroupsManagerModal onClose={() => setShowGroupMgr(false)} />}
    </aside>
  );
}
