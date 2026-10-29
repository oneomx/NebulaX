/**
 * 会话映射工具：统一管理 tabId -> 真实 ssh sessionId 的映射，
 * 避免各组件直接操作 window.__nebulaSessionMap 导致泄漏。
 */
const KEY = '__nebulaSessionMap';

type MapType = Record<string, string>;

function getMap(): MapType {
  const w = window as unknown as Record<string, unknown>;
  if (!w[KEY]) w[KEY] = {};
  return w[KEY] as MapType;
}

export function setSessionMapping(tabId: string, sshSessionId: string): void {
  getMap()[tabId] = sshSessionId;
}

export function getSessionMapping(tabId: string): string | undefined {
  return getMap()[tabId];
}

export function deleteSessionMapping(tabId: string): void {
  delete getMap()[tabId];
}
