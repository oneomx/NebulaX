import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nanoid } from './nanoid';
import type { SavedConnection, SessionTab, AIMessage, AIConfig, ServerInfo, Macro } from '../types';
import type { LicenseState } from '../types/license';

interface AppState {
  connections: SavedConnection[];
  /** 用户自建分组名列表（连接通过 group 字段归属） */
  groups: string[];
  sessions: SessionTab[];
  activeSessionId: string | null;
  aiMessages: AIMessage[];
  aiConfig: AIConfig | null;
  sidebarOpen: boolean;
  aiPanelOpen: boolean;
  infoPanelOpen: boolean;
  /** 同步输入：开启后按键广播到所有已连接的终端会话（对标 MobaXterm broadcast） */
  syncInput: boolean;
  /** 宏库（持久化；keys 为按顺序录制的按键序列） */
  macros: Macro[];
  /** 宏录制中暂存的按键序列；null = 未录制 */
  recordingKeys: string[] | null;
  /** 许可状态（v2.0；每次启动从主进程拉取，不持久化） */
  licenseStatus: LicenseState | null;
  /** 许可激活弹窗开关（全局，TopBar 徽章与多处入口共用） */
  licenseModalOpen: boolean;
  setLicenseStatus: (s: LicenseState | null) => void;
  setLicenseModalOpen: (open: boolean) => void;
  addConnection: (c: Omit<SavedConnection, 'id'>) => string;
  removeConnection: (id: string) => void;
  updateConnection: (id: string, patch: Partial<SavedConnection>) => void;
  addGroup: (name: string) => void;
  renameGroup: (oldName: string, newName: string) => void;
  removeGroup: (name: string) => void;
  moveGroup: (name: string, direction: 'up' | 'down') => void;
  addSession: (s: SessionTab) => void;
  removeSession: (id: string) => void;
  updateSession: (id: string, patch: Partial<SessionTab>) => void;
  setActiveSession: (id: string | null) => void;
  addAiMessage: (m: AIMessage) => void;
  updateAiMessage: (id: string, patch: Partial<AIMessage>) => void;
  clearAiMessages: () => void;
  setAiConfig: (c: AIConfig | null) => void;
  toggleSidebar: () => void;
  toggleAiPanel: () => void;
  toggleInfoPanel: () => void;
  toggleSyncInput: () => void;
  startMacroRecording: () => void;
  /** 停止录制并保存；name 为空则放弃 */
  stopMacroRecording: (name: string) => void;
  cancelMacroRecording: () => void;
  appendMacroKey: (data: string) => void;
  removeMacro: (id: string) => void;
}

const defaultConnections: SavedConnection[] = [];

/** 虚拟分组名：未归属任何分组的连接展示在这里（与 Sidebar 保持一致） */
const UNGROUPED = '未分组';

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      connections: defaultConnections,
      groups: [],
      sessions: [],
      activeSessionId: null,
      aiMessages: [
        {
          id: 'welcome',
          role: 'assistant',
          content:
            '👋 你好，我是 **NebulaX AI 助手**。我熟悉你的服务器信息，可以：\n\n• 自然语言转命令：「看下内存占用最高的 5 个进程」\n• 解释报错 / 日志\n• 帮你做诊断 / 巡检建议\n\n试试问我一句话，或点击下方快捷命令。',
          type: 'text',
          ts: Date.now()
        }
      ],
      aiConfig: null,
      sidebarOpen: true,
      // AI 运维助手默认不启用（不自动打开）；用户可通过顶栏 AI 按钮手动开启
      aiPanelOpen: false,
      infoPanelOpen: true,
      syncInput: false,
      macros: [],
      recordingKeys: null,
      licenseStatus: null,
      licenseModalOpen: false,

      setLicenseStatus: (s) => set({ licenseStatus: s }),
      setLicenseModalOpen: (open) => set({ licenseModalOpen: open }),

      addConnection: (c) => {
        const id = nanoid();
        set((s) => ({ connections: [...s.connections, { ...c, id }] }));
        return id;
      },
      removeConnection: (id) => set((s) => ({ connections: s.connections.filter((c) => c.id !== id) })),
      updateConnection: (id, patch) =>
        set((s) => ({ connections: s.connections.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
      addGroup: (name) =>
        set((s) => {
          const n = name.trim();
          if (!n || s.groups.includes(n)) return {};
          return { groups: [...s.groups, n] };
        }),
      renameGroup: (oldName, newName) =>
        set((s) => {
          const n = newName.trim();
          if (!n || n === oldName) return {};
          // 目标名已存在时合并（连接改挂到目标名下）；新名始终登记
          const groups = Array.from(new Set(s.groups.filter((g) => g !== oldName).concat(n)));
          return {
            groups,
            connections: s.connections.map((c) => (c.group === oldName ? { ...c, group: n } : c))
          };
        }),
      removeGroup: (name) =>
        set((s) => ({
          groups: s.groups.filter((g) => g !== name),
          // 组内连接退回未分组，不删连接
          connections: s.connections.map((c) => (c.group === name ? { ...c, group: undefined } : c))
        })),
      moveGroup: (name, direction) =>
        set((s) => {
          // 与 Sidebar 渲染顺序一致：用户分组 → 连接里派生的组（未分组恒在最后）
          const derived = Array.from(new Set(s.connections.map((c) => c.group || UNGROUPED)));
          const full = [...s.groups, ...derived.filter((g) => g !== UNGROUPED && !s.groups.includes(g))];
          const idx = full.indexOf(name);
          if (idx < 0) return {};
          const to = direction === 'up' ? idx - 1 : idx + 1;
          if (to < 0 || to >= full.length) return {};
          const next = [...full];
          next.splice(idx, 1);
          next.splice(to, 0, name);
          // 排序会把派生组一并纳管（写入 groups），保证顺序可持久化
          return { groups: next };
        }),
      addSession: (s) => set((st) => ({ sessions: [...st.sessions, s] })),
      removeSession: (id) =>
        set((s) => ({
          sessions: s.sessions.filter((t) => t.id !== id),
          activeSessionId: s.activeSessionId === id ? (s.sessions.find((t) => t.id !== id)?.id ?? null) : s.activeSessionId
        })),
      updateSession: (id, patch) =>
        set((s) => ({ sessions: s.sessions.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
      setActiveSession: (id) => set({ activeSessionId: id }),
      addAiMessage: (m) => set((s) => ({ aiMessages: [...s.aiMessages, m] })),
      updateAiMessage: (id, patch) =>
        set((s) => ({ aiMessages: s.aiMessages.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
      clearAiMessages: () => set({ aiMessages: [] }),
      setAiConfig: (c) => set({ aiConfig: c }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
      toggleInfoPanel: () => set((s) => ({ infoPanelOpen: !s.infoPanelOpen })),
      toggleSyncInput: () => set((s) => ({ syncInput: !s.syncInput })),
      startMacroRecording: () => set({ recordingKeys: [] }),
      stopMacroRecording: (name) =>
        set((s) => {
          const n = name.trim();
          if (!n || !s.recordingKeys || s.recordingKeys.length === 0) return { recordingKeys: null };
          const macro: Macro = { id: nanoid(), name: n, keys: s.recordingKeys, createdAt: Date.now() };
          return { macros: [...s.macros, macro], recordingKeys: null };
        }),
      cancelMacroRecording: () => set({ recordingKeys: null }),
      appendMacroKey: (data) =>
        set((s) => (s.recordingKeys ? { recordingKeys: [...s.recordingKeys, data] } : {})),
      removeMacro: (id) => set((s) => ({ macros: s.macros.filter((m) => m.id !== id) }))
    }),
    {
      name: 'nebula-connections',
      storage: createJSONStorage(() => localStorage),
      // 仅持久化连接元数据与分组（不含凭据，凭据走 vault）+ 宏库。
      // 安全：跳板机/代理密码绝不落 localStorage（历史上曾明文持久化，这里同时清洗存量数据）
      partialize: (s) =>
        ({
          connections: s.connections.map((c) => ({
            ...c,
            jump: c.jump ? { ...c.jump, password: undefined } : c.jump,
            proxy: c.proxy ? { ...c.proxy, password: undefined } : c.proxy
          })),
          groups: s.groups,
          macros: s.macros
        }) as AppState,
      // 启动水合后清洗存量 localStorage 中已落盘的明文跳板机/代理密码
      onRehydrateStorage: () => (state) => {
        const st = state as unknown as { connections?: SavedConnection[] } | undefined;
        const conns = st?.connections;
        if (!Array.isArray(conns)) return;
        const dirty = conns.some((c) => c.jump?.password || c.proxy?.password);
        if (!dirty) return;
        try {
          const raw = localStorage.getItem('nebula-connections');
          if (!raw) return;
          const parsed = JSON.parse(raw);
          const list = parsed?.state?.connections;
          if (Array.isArray(list)) {
            for (const c of list) {
              if (c.jump?.password) c.jump.password = undefined;
              if (c.proxy?.password) c.proxy.password = undefined;
            }
            localStorage.setItem('nebula-connections', JSON.stringify(parsed));
          }
        } catch {
          /* ignore */
        }
      }
    }
  )
);
