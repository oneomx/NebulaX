/**
 * 主机指纹保管（known_hosts，TOFU 模型）
 * - 密文落盘 ~/.nebula-ssh/known_hosts.json（结构化，便于查询/删除/展示）
 * - 信任模型：首次连接未见过的主机 → 让用户确认指纹后写入；已见过但指纹不符 → 一律拦截（防中间人）
 * - 校验用指纹：SHA256（OpenSSH 风格，base64 无填充），兼容 md5 展示
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const KH_FILE = path.join(os.homedir(), '.nebula-ssh', 'known_hosts.json');

export interface HostKeyEntry {
  /** host:port（port 省略默认 22 时仍带端口，避免同机不同端口混淆） */
  host: string;
  port: number;
  /** 密钥算法（ssh-ed25519 / ssh-rsa 等） */
  keyType: string;
  /** SHA256 指纹（base64，无 SHA256: 前缀） */
  sha256: string;
  /** 首次信任时间 */
  trustedAt: number;
}

interface KHFile {
  version: 1;
  entries: HostKeyEntry[];
}

function load(): KHFile {
  try {
    if (fs.existsSync(KH_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(KH_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.entries)) return { version: 1, entries: parsed.entries };
    }
  } catch {
    /* corrupted -> start fresh */
  }
  return { version: 1, entries: [] };
}

function save(kh: KHFile): void {
  fs.mkdirSync(path.dirname(KH_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KH_FILE, JSON.stringify(kh, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(KH_FILE, 0o600);
  } catch {
    /* Windows 上无效但无害 */
  }
}

/** 计算 OpenSSH 风格 SHA256 指纹（base64 去掉 '=' 填充） */
export function sha256Fingerprint(key: Buffer): string {
  return crypto
    .createHash('sha256')
    .update(key)
    .digest('base64')
    .replace(/=+$/, '');
}

/** 从 ssh2 给的公钥 buffer（含算法名前缀）解析算法名 */
export function extractKeyType(key: Buffer): string {
  // SSH 公钥 wire 格式：uint32 长度 + 算法名 + ...
  if (key.length < 5) return 'unknown';
  const len = key.readUInt32BE(0);
  if (len <= 0 || len > 32 || 4 + len > key.length) return 'unknown';
  return key.subarray(4, 4 + len).toString('utf8');
}

export function getEntry(host: string, port: number): HostKeyEntry | undefined {
  return load().entries.find((e) => e.host === host && e.port === port);
}

/** 校验：已知主机指纹一致返回 'match'；未知返回 'unknown'；已知但不一致返回 'mismatch' */
export function checkHostKey(host: string, port: number, key: Buffer): 'match' | 'unknown' | 'mismatch' {
  const entry = getEntry(host, port);
  if (!entry) return 'unknown';
  return entry.sha256 === sha256Fingerprint(key) ? 'match' : 'mismatch';
}

/** 信任并记录指纹（首次连接用户确认后调用；重复记录会覆盖为最新指纹） */
export function trustHostKey(host: string, port: number, key: Buffer): HostKeyEntry {
  const kh = load();
  const entry: HostKeyEntry = {
    host,
    port,
    keyType: extractKeyType(key),
    sha256: sha256Fingerprint(key),
    trustedAt: Date.now()
  };
  const idx = kh.entries.findIndex((e) => e.host === host && e.port === port);
  if (idx >= 0) kh.entries[idx] = entry;
  else kh.entries.push(entry);
  save(kh);
  return entry;
}

export function removeHostKey(host: string, port: number): boolean {
  const kh = load();
  const before = kh.entries.length;
  kh.entries = kh.entries.filter((e) => !(e.host === host && e.port === port));
  if (kh.entries.length === before) return false;
  save(kh);
  return true;
}

export function listHostKeys(): HostKeyEntry[] {
  return load().entries;
}
