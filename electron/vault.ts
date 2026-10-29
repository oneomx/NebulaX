/**
 * 凭据保管库 —— 使用 Electron safeStorage（系统钥匙串 / DPAPI / libsecret）
 * 加密存储 SSH 凭据与 AI API Key。密文落盘 ~/.nebula-ssh/vault.json，
 * 解密结果仅在主进程内存中使用，renderer 只拿 mask 形态。
 */
import { safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const VAULT_FILE = path.join(os.homedir(), '.nebula-ssh', 'vault.json');

export interface VaultSecrets {
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** 跳板机密码（SSH 高级配置） */
  jumpPassword?: string;
  /** 代理认证密码（SSH 高级配置） */
  proxyPassword?: string;
}

interface VaultEntry {
  /** base64 加密后的 JSON secrets */
  enc: string;
  updatedAt: number;
}

interface VaultFile {
  version: 1;
  entries: Record<string, VaultEntry>;
}

function loadVault(): VaultFile {
  try {
    if (fs.existsSync(VAULT_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        return { version: 1, entries: parsed.entries };
      }
    }
  } catch {
    /* corrupted -> start fresh */
  }
  return { version: 1, entries: {} };
}

function saveVault(v: VaultFile): void {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(v, null, 2), { encoding: 'utf8', mode: 0o600 });
  // 已存在文件 writeFileSync 的 mode 不生效，显式收紧（Windows 上 chmod 无效但无害）
  try {
    fs.chmodSync(VAULT_FILE, 0o600);
  } catch {
    /* ignore */
  }
}

export function vaultStatus(): { available: boolean; reason?: string } {
  try {
    return { available: safeStorage.isEncryptionAvailable() };
  } catch (e: any) {
    return { available: false, reason: e?.message || String(e) };
  }
}

export function vaultSet(id: string, secrets: VaultSecrets): { ok: boolean; error?: string } {
  const status = vaultStatus();
  if (!status.available) {
    return { ok: false, error: status.reason || '当前系统不支持加密存储' };
  }
  try {
    const s: VaultSecrets = { ...secrets };
    // 若提供了文件路径但未提供内容，自动读取私钥文件内容（解决跨设备路径失效问题）
    if (s.privateKeyPath && !s.privateKey) {
      try {
        const resolved = s.privateKeyPath.startsWith('~')
          ? path.join(os.homedir(), s.privateKeyPath.slice(1))
          : s.privateKeyPath;
        s.privateKey = fs.readFileSync(resolved, 'utf8');
        // 读取成功后清理路径字段，后续使用内容
        delete s.privateKeyPath;
      } catch (e: any) {
        // 读取失败时保留 privateKeyPath 供后续重试，但不阻塞保存
        s.privateKey = undefined;
      }
    }
    const json = JSON.stringify(s);
    const enc = safeStorage.encryptString(json).toString('base64');
    const v = loadVault();
    v.entries[id] = { enc, updatedAt: Date.now() };
    saveVault(v);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function vaultGet(id: string): { ok: boolean; secrets?: VaultSecrets; error?: string } {
  const status = vaultStatus();
  if (!status.available) {
    return { ok: false, error: status.reason || '当前系统不支持加密存储' };
  }
  try {
    const v = loadVault();
    const entry = v.entries[id];
    if (!entry) return { ok: true, secrets: {} };
    const buf = Buffer.from(entry.enc, 'base64');
    const json = safeStorage.decryptString(buf);
    return { ok: true, secrets: JSON.parse(json) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function vaultDelete(id: string): { ok: boolean } {
  const v = loadVault();
  if (v.entries[id]) {
    delete v.entries[id];
    saveVault(v);
  }
  return { ok: true };
}

/** 仅用于 AI Key 的便捷读写 */
export function vaultSetAIKey(apiKey: string): { ok: boolean; error?: string } {
  return vaultSet('__ai_key__', { password: apiKey });
}

export function vaultGetAIKey(): string | null {
  const r = vaultGet('__ai_key__');
  return r.ok && r.secrets?.password ? r.secrets.password : null;
}
