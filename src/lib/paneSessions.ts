/**
 * Pane 会话管理：分屏时每个 pane 启动独立 SSH shell（复用同一连接配置 + vault 凭据）。
 */
import { getAPI } from './api';
import { setSessionMapping, deleteSessionMapping, getSessionMapping } from './sessionMap';
import type { SavedConnection } from '../types';

/** 为新 pane 建立独立 SSH 会话，映射到 mapKey */
export async function spawnPaneSession(mapKey: string, conn: SavedConnection): Promise<boolean> {
  const api = getAPI();
  // 从 vault 取凭据
  let password: string | undefined;
  let privateKey: string | undefined;
  let passphrase: string | undefined;
  const vault = (api as any).vaultGet;
  if (vault && (conn.hasPassword || conn.hasPrivateKey || conn.hasPassphrase)) {
    try {
      const v = await vault(conn.id);
      if (v?.ok && v.secrets) {
        password = v.secrets.password;
        privateKey = v.secrets.privateKey;
        passphrase = v.secrets.passphrase;
      }
    } catch {
      /* 降级 */
    }
  }
  try {
    const res = await api.sshConnect({
      host: conn.host,
      port: conn.port || 22,
      username: conn.username,
      password,
      privateKey,
      passphrase,
      authType: conn.authType
    });
    if (res.ok && res.sessionId) {
      setSessionMapping(mapKey, res.sessionId);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 关闭 pane 的 SSH 会话并清理映射 */
export async function closePaneSession(mapKey: string): Promise<void> {
  const api = getAPI();
  const sid = getSessionMapping(mapKey);
  if (sid) {
    try {
      await api.sshDisconnect(sid);
    } catch {
      /* ignore */
    }
    deleteSessionMapping(mapKey);
  }
}
