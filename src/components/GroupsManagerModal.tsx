import { useState } from 'react';
import {
  FolderCog,
  Plus,
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  Check,
  X,
  FolderOpen
} from 'lucide-react';
import { useAppStore } from '../store/app';
import Modal from './ui/Modal';
import { Button } from './ui/Button';

const UNGROUPED = '未分组';

/**
 * 分组管理弹窗：集中完成分组的新建 / 重命名 / 排序 / 删除，
 * 替代侧边栏里悬停才出现的小图标（不易发现）。
 */
export default function GroupsManagerModal({ onClose }: { onClose: () => void }) {
  const { connections, groups, addGroup, renameGroup, removeGroup, moveGroup } = useAppStore();
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [hint, setHint] = useState('');

  // 与 Sidebar 相同的展示顺序：用户分组 → 派生组 → 未分组
  const derived = Array.from(new Set(connections.map((c) => c.group || UNGROUPED)));
  const ordered = [
    ...groups,
    ...derived.filter((g) => g !== UNGROUPED && !groups.includes(g)),
    ...(derived.includes(UNGROUPED) ? [UNGROUPED] : [])
  ];

  const countOf = (g: string) =>
    g === UNGROUPED
      ? connections.filter((c) => !c.group).length
      : connections.filter((c) => c.group === g).length;

  const isVirtual = (g: string) => g === UNGROUPED;
  const isDerived = (g: string) => !isVirtual(g) && !groups.includes(g);

  const handleAdd = () => {
    const n = newName.trim();
    if (!n) return;
    if (ordered.includes(n)) {
      setHint(`分组「${n}」已存在`);
      return;
    }
    addGroup(n);
    setNewName('');
    setHint('');
  };

  const startEdit = (g: string) => {
    setEditing(g);
    setEditValue(g);
    setConfirmDel(null);
    setHint('');
  };

  const confirmEdit = () => {
    if (!editing) return;
    const n = editValue.trim();
    if (!n) return;
    // 与已有分组重名时 store 会自动合并（连接改挂到目标名下）
    renameGroup(editing, n);
    setEditing(null);
    setEditValue('');
    setHint('');
  };

  const handleDelete = (g: string) => {
    const cnt = countOf(g);
    removeGroup(g);
    setConfirmDel(null);
    setHint(cnt > 0 ? `已删除「${g}」，${cnt} 台连接退回未分组` : `已删除「${g}」`);
  };

  return (
    <Modal
      title="分组管理"
      subtitle="新建、重命名、排序、删除连接分组"
      icon={<FolderCog size={18} />}
      onClose={onClose}
      width="560px"
      footer={
        <>
          <div className="flex-1 text-[11px] text-[var(--text-muted)]">
            删除分组不会删除组内连接，连接会退回「未分组」
          </div>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      {/* 新建分组 */}
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            setHint('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          placeholder="新分组名称，回车或点击添加"
          className="flex-1 min-w-0 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/50"
        />
        <Button variant="secondary" onClick={handleAdd} disabled={!newName.trim()}>
          <Plus size={14} />
          添加
        </Button>
      </div>

      {hint && <div className="text-[11px] text-[var(--warning)]">{hint}</div>}

      {/* 分组列表 */}
      <div className="space-y-1.5">
        {ordered.length === 0 && (
          <div className="text-center py-8 text-[var(--text-muted)] text-xs">
            <FolderOpen size={28} className="mx-auto mb-2 opacity-30" />
            <div>还没有任何分组</div>
            <div className="text-[10px] mt-1">在上方输入名称创建，或给连接设置分组后自动出现</div>
          </div>
        )}

        {ordered.map((g, i) => {
          const cnt = countOf(g);
          const virtual = isVirtual(g);
          const derived_ = isDerived(g);
          // 下一项是虚拟「未分组」（恒在最后、不可排序）时也不能下移
          const nextIsVirtual = i + 1 < ordered.length && isVirtual(ordered[i + 1]);
          return (
            <div
              key={g}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 px-3 py-2.5"
            >
              {editing === g ? (
                /* ---- 重命名态 ---- */
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmEdit();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    className="flex-1 min-w-0 rounded bg-[var(--bg-base)] border border-[var(--border-subtle)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]/50"
                  />
                  <button
                    onClick={confirmEdit}
                    title="确认重命名"
                    className="p-1.5 rounded text-[var(--success)] hover:bg-[var(--bg-elevated-hover)]"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={() => setEditing(null)}
                    title="取消"
                    className="p-1.5 rounded text-[var(--text-muted)] hover:bg-[var(--bg-elevated-hover)]"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : confirmDel === g ? (
                /* ---- 删除确认态（两步确认） ---- */
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-xs text-[var(--text-secondary)] truncate">
                    删除「{g}」？
                    {cnt > 0 && (
                      <span className="text-[var(--warning)]"> {cnt} 台连接将退回未分组</span>
                    )}
                  </span>
                  <button
                    onClick={() => handleDelete(g)}
                    className="px-2 py-1 rounded text-[11px] bg-[var(--error)]/15 text-[var(--error)] hover:bg-[var(--error)]/25"
                  >
                    确认删除
                  </button>
                  <button
                    onClick={() => setConfirmDel(null)}
                    className="px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-elevated-hover)]"
                  >
                    取消
                  </button>
                </div>
              ) : (
                /* ---- 常态 ---- */
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm theme-text-primary truncate">{g}</span>
                      {derived_ && (
                        <span
                          title="从连接的分组字段自动识别，操作后会纳管为正式分组"
                          className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider bg-[var(--bg-elevated)] text-[var(--text-muted)] border border-[var(--border-subtle)]"
                        >
                          自动
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                      {virtual ? '未归属分组的连接' : `${cnt} 台连接`}
                    </div>
                  </div>

                  {!virtual && (
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() => moveGroup(g, 'up')}
                        disabled={i === 0}
                        title="上移"
                        className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated-hover)] disabled:opacity-25 disabled:pointer-events-none"
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        onClick={() => moveGroup(g, 'down')}
                        disabled={i >= ordered.length - 1 || nextIsVirtual}
                        title="下移"
                        className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated-hover)] disabled:opacity-25 disabled:pointer-events-none"
                      >
                        <ChevronDown size={14} />
                      </button>
                      <button
                        onClick={() => startEdit(g)}
                        title="重命名"
                        className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated-hover)]"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => {
                          setConfirmDel(g);
                          setEditing(null);
                          setHint('');
                        }}
                        title="删除分组（组内连接保留，退回未分组）"
                        className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error)]/10"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
