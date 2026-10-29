import { getAPI } from './api';
import { setSessionMapping } from './sessionMap';
import { useAppStore } from '../store/app';
import { promptHostKey } from './hostKeyPrompt';
import type { SavedConnection, SSHConfig, HostKeyPrompt } from '../types';

/** 解析 ssh2 hostVerifier 拦截产生的结构化错误，转为弹窗载荷 */
function parseHostKeyError(msg: string): HostKeyPrompt | null {
  const m = /^__(HOSTKEY_UNKNOWN|HOSTKEY_MISMATCH)__\|(.+)\|(\d+)\|([^|]+)\|([^|]+)$/.exec(msg || '');
  if (!m) return null;
  return {
    host: m[2],
    port: parseInt(m[3], 10),
    sha256: m[4],
    keyType: m[5],
    mismatch: m[1] === 'HOSTKEY_MISMATCH'
  };
}

/** 带主机指纹确认的 SSH 连接（首次询问信任 / 指纹变更警示） */
async function sshConnectWithHostKeyCheck(api: ReturnType<typeof getAPI>, config: SSHConfig) {
  let res = await api.sshConnect(config);
  // 指纹拦截 → 弹窗确认 → 放行则重试（变更指纹需先删除旧记录）
  for (let i = 0; i < 2 && res.hostKeyPrompt; i++) {
    const prompt = res.hostKeyPrompt;
    const accept = await promptHostKey(prompt);
    if (!accept) {
      return { ok: false, error: prompt.mismatch ? '已拒绝：主机指纹不匹配' : '已拒绝连接（未信任主机指纹）' };
    }
    if (prompt.mismatch) {
      // 用户明确选择信任变更后的指纹：删除旧记录再重试
      await api.hostKeysRemove(prompt.host, prompt.port);
    }
    res = await api.sshConnect({ ...config, acceptHostKey: true });
  }
  return res;
}

/**
 * 统一连接入口：按连接类型分流到对应后端（SSH/Telnet/本地/串口 → 终端会话；RDP/VNC → 外部程序）。
 * 调用方负责先建好 SessionTab（status: connecting；RDP/VNC 需带 external 标记）。
 */
export async function connectSavedConnection(conn: SavedConnection, tabId: string): Promise<void> {
  const api = getAPI();
  const type = conn.type || 'ssh';
  const updateSession = useAppStore.getState().updateSession;
  const updateConnection = useAppStore.getState().updateConnection;

  const fail = (reason?: string) => updateSession(tabId, { status: 'error', error: reason || '连接失败' });
  const ok = () => {
    updateConnection(conn.id, { lastConnected: new Date().toISOString() });
    updateSession(tabId, { status: 'connected', error: undefined });
  };

  try {
    if (type === 'ssh') {
      // 优先从 vault 取凭据
      let password: string | undefined;
      let privateKey: string | undefined;
      let passphrase: string | undefined;
      let jumpPassword: string | undefined;
      let proxyPassword: string | undefined;
      const vault = (api as any).vaultGet;
      if (vault && (conn.hasPassword || conn.hasPrivateKey || conn.hasPassphrase || conn.hasJumpPassword || conn.hasProxyAuth)) {
        try {
          const v = await vault(conn.id);
          if (v?.ok && v.secrets) {
            password = v.secrets.password;
            privateKey = v.secrets.privateKey;
            passphrase = v.secrets.passphrase;
            jumpPassword = v.secrets.jumpPassword;
            proxyPassword = v.secrets.proxyPassword;
          }
        } catch {
          /* vault 不可用则降级 */
        }
      }
      const res = await sshConnectWithHostKeyCheck(api, {
        host: conn.host,
        port: conn.port || 22,
        username: conn.username,
        password,
        privateKey,
        passphrase,
        authType: conn.authType || 'password',
        proxy: conn.proxy ? { ...conn.proxy, password: conn.proxy.password || proxyPassword } : undefined,
        jump: conn.jump
          ? {
              ...conn.jump,
              password: conn.jump.authType === 'password' ? conn.jump.password || jumpPassword : undefined
            }
          : undefined
      });
      if (res.ok && res.sessionId) {
        setSessionMapping(tabId, res.sessionId);
        // 服务器信息采集仅 SSH 有意义
        const infoRes = await api.sshGetServerInfo(res.sessionId);
        const patch: any = { status: 'connected' as const, error: undefined };
        if (infoRes.ok && infoRes.info) patch.serverInfo = infoRes.info;
        updateConnection(conn.id, { lastConnected: new Date().toISOString() });
        updateSession(tabId, patch);
      } else {
        fail(res.error);
      }
      return;
    }

    if (type === 'telnet' || type === 'local' || type === 'serial') {
      const res = await api.termConnect({
        type,
        host: conn.host,
        port: conn.port || 23,
        shell: conn.shell,
        command: conn.command,
        serialPath: conn.serialPath,
        baudRate: conn.baudRate,
        dataBits: conn.dataBits,
        stopBits: conn.stopBits,
        parity: conn.parity
      });
      if (res.ok && res.sessionId) {
        setSessionMapping(tabId, res.sessionId);
        ok();
      } else {
        fail(res.error);
      }
      return;
    }

    if (type === 'rdp' || type === 'vnc') {
      // 外部程序凭据从 vault 取（保存时已写入）
      let password: string | undefined;
      const vault = (api as any).vaultGet;
      if (vault && conn.hasPassword) {
        try {
          const v = await vault(conn.id);
          if (v?.ok && v.secrets) password = v.secrets.password;
        } catch {
          /* ignore */
        }
      }
      const res =
        type === 'rdp'
          ? await api.winLaunchRdp({
              host: conn.host,
              port: conn.port || 3389,
              username: conn.username || undefined,
              password,
              fullscreen: conn.rdpFullscreen
            })
          : await api.winLaunchVnc({ host: conn.host, port: conn.port || 5900, viewerPath: conn.vncViewer });
      if (res.ok) ok();
      else fail(res.error);
      return;
    }

    fail(`不支持的连接类型：${type}`);
  } catch (e: any) {
    fail(e?.message || '连接异常');
  }
}

/** 直接打开本地终端（无需保存连接）：探测默认 shell，建 tab 并连接 */
export async function openLocalTerminal(title?: string): Promise<string | null> {
  const api = getAPI();
  const { addSession, setActiveSession, updateSession } = useAppStore.getState();
  let shell = 'powershell';
  try {
    const s = await api.termShells();
    if (s.ok && s.defaultShell) shell = s.defaultShell;
  } catch {
    /* 降级 powershell */
  }
  const tabId = `tab_${Date.now()}`;
  addSession({
    id: tabId,
    connectionId: '__local__',
    title: title || '本地终端',
    host: 'localhost',
    status: 'connecting'
  });
  setActiveSession(tabId);
  try {
    const res = await api.termConnect({ type: 'local', shell });
    if (res.ok && res.sessionId) {
      setSessionMapping(tabId, res.sessionId);
      updateSession(tabId, { status: 'connected', error: undefined });
    } else {
      updateSession(tabId, { status: 'error', error: res.error || '本地终端启动失败' });
    }
  } catch (e: any) {
    updateSession(tabId, { status: 'error', error: e?.message || '本地终端启动异常' });
  }
  return tabId;
}
