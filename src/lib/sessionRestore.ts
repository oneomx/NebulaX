import { useAppStore } from '../store/app';
import type { SessionTab } from '../types';

/**
 * 会话恢复：把上次未关闭的标签记为"未连接"状态，应用重启后恢复成可点连接的标签。
 * 只持久化元信息（connectionId/title/host/external），不持久化凭据与终端内容。
 * 用户双击侧边栏连接，或在标签上点"重连"后才真正建连。
 */
const KEY = 'nebula-restore-sessions';
/** 空壳占位：重启后恢复的标签都是未连接状态 */
const RESTORED_STATUS: SessionTab['status'] = 'disconnected';

interface RestorableTab {
  connectionId: string;
  title: string;
  host: string;
  external?: { kind: 'rdp' | 'vnc'; host: string };
}

/** 订阅 store，任何标签变化都把"当前该保留的标签"写入 localStorage */
let subscribed = false;
function ensurePersistHook(): void {
  if (subscribed) return;
  subscribed = true;
  useAppStore.subscribe((state) => {
    try {
      // 只记录仍有意义的标签（非空壳标题）
      const tabs: RestorableTab[] = state.sessions
        .filter((s) => !s.title.startsWith('pane_') && !!s.connectionId)
        .map((s) => ({
          connectionId: s.connectionId,
          title: s.title,
          host: s.host,
          external: s.external
        }));
      // 应用真正退出前（有标签）才保留；全关了就清空，避免下次恢复一堆空标签
      if (tabs.length > 0) {
        localStorage.setItem(KEY, JSON.stringify(tabs));
      } else {
        localStorage.removeItem(KEY);
      }
    } catch {
      /* ignore */
    }
  });
}

/** App 启动时调用：把上次的标签恢复成 disconnected 状态（不自动重连） */
export function restoreSessionTabs(): void {
  ensurePersistHook();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let tabs: RestorableTab[] = [];
  try {
    tabs = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(tabs) || tabs.length === 0) return;

  const st = useAppStore.getState();
  const connections = st.connections;
  const restored: SessionTab[] = [];
  for (const t of tabs) {
    // 连接已被删除的标签不恢复
    if (t.connectionId !== '__local__' && !connections.some((c) => c.id === t.connectionId)) continue;
    restored.push({
      id: `tab_restore_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      connectionId: t.connectionId,
      title: t.title,
      host: t.host,
      status: RESTORED_STATUS,
      external: t.external
    });
  }
  if (restored.length === 0) return;
  for (const r of restored) st.addSession(r);
  st.setActiveSession(restored[0].id);
}
