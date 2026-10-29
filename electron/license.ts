import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { log } from './logger';

/**
 * 纯离线许可激活体系（v2.0）
 *
 * 激活码结构（Crockford Base32 编码，前缀 NBX1-）：
 *   payload(22B) = version(1) | machine(16) | type(1) | expDays(4 BE, 自 2020-01-01 起天数)
 *   mac(12B)     = HMAC-SHA256(key, payload)[0:12]
 * 验签只需内置对称密钥；私钥与本密钥一致，仅存在于发码工具侧由厂商保管。
 *
 * 状态机：trial（14 天全功能）/ activated（永久或订阅期内）/ expired（只读）。
 * 时间回拨防护：trial.json 与 license.json 持续记录见过的最大时间戳 maxSeenTs。
 */

export const LICENSE_EPOCH = Date.UTC(2020, 0, 1);
export const TRIAL_DAYS = 14;
export const CODE_PREFIX = 'NBX1-';

// 内置 HMAC 密钥（base64 32B）。测试可用 NEBULA_LICENSE_KEY 覆盖。
const DEFAULT_LICENSE_KEY_B64 = process.env.NEBULA_LICENSE_KEY || 'REPLACE_WITH_YOUR_OWN_KEY_base64_32B==' // 部署前替换为自己的密钥（勿提交真实密钥到仓库）;

export type LicenseType = 'perpetual' | 'subscription';

export interface ParsedLicense {
  machine: string; // 32 hex
  type: LicenseType;
  expDays: number | null; // subscription 到期天数；perpetual 为 null
}

export interface LicenseInfo {
  type: LicenseType;
  expiresAt: string | null; // ISO 日期；perpetual 为 null
  activatedAt: string;
  code: string;
}

export interface LicenseState {
  status: 'trial' | 'activated' | 'expired';
  machineCode: string; // 显示格式 XXXX-XXXX-...
  trialDaysLeft: number | null; // trial 状态剩余天数；其余 null
  license: LicenseInfo | null;
}

function licenseKey(): Buffer {
  const b64 = process.env.NEBULA_LICENSE_KEY || DEFAULT_LICENSE_KEY_B64;
  return Buffer.from(b64, 'base64');
}

/** 文件存放目录（惰性读取 env，便于测试隔离） */
function licenseDir(): string {
  return process.env.NEBULA_LICENSE_DIR || path.join(os.homedir(), '.nebula-ssh');
}

function trialFile(): string {
  return path.join(licenseDir(), 'trial.json');
}

function licenseFile(): string {
  return path.join(licenseDir(), 'license.json');
}

/* ---------- 机器码 ---------- */

/** 原始机器指纹 16 字节：sha256(hostname|MAC列表|username) 截断 */
export function rawMachineCode(): Buffer {
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && !i.internal && !!i.mac && i.mac !== '00:00:00:00:00:00')
    .map((i) => i.mac)
    .sort()
    .join(',');
  const seed = `${os.hostname()}|${macs}|${os.userInfo().username}`;
  return crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
}

/** 显示格式：32 hex 分组 XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX */
export function machineCode(): string {
  return formatMachineCode(rawMachineCode().toString('hex'));
}

export function formatMachineCode(hex: string): string {
  return (hex.toUpperCase().match(/.{1,4}/g) || []).join('-');
}

export function normalizeMachineCode(input: string): string | null {
  const hex = input.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 32 ? hex : null;
}

/* ---------- Crockford Base32 ---------- */

const B32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/-/g, '').replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0');
  if (!clean.length || /[^0-9A-Z]/.test(clean.replace(new RegExp(`[${B32_ALPHABET}]`, 'g'), ''))) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ---------- 签发 / 验签 ---------- */

function hmac(payload: Buffer): Buffer {
  return crypto.createHmac('sha256', licenseKey()).update(payload).digest().subarray(0, 12);
}

export function tsToDay(ts: number): number {
  return Math.floor((ts - LICENSE_EPOCH) / 86400000);
}

export function dayToTs(day: number): number {
  return LICENSE_EPOCH + day * 86400000;
}

/**
 * 签发激活码（供测试与发码工具复用；工具侧同逻辑独立实现于 tools/license-gen）
 * rawMachineHex: 32 hex；type=perpetual 时 expDays 传 null
 */
export function issueLicenseCode(rawMachineHex: string, type: LicenseType, expDays: number | null): string {
  if (!/^[0-9a-fA-F]{32}$/.test(rawMachineHex)) throw new Error('机器码须为 32 位十六进制');
  const payload = Buffer.alloc(22);
  payload.writeUInt8(1, 0);
  Buffer.from(rawMachineHex, 'hex').copy(payload, 1);
  payload.writeUInt8(type === 'perpetual' ? 1 : 2, 17);
  payload.writeUInt32BE(type === 'perpetual' ? 0xffffffff : expDays === null ? 0 : expDays, 18);
  const code = Buffer.concat([payload, hmac(payload)]);
  const b32 = base32Encode(code);
  return CODE_PREFIX + (b32.match(/.{1,5}/g) || []).join('-');
}

/** 验签：格式/HMAC/机器码 绑定校验；失败返回 null */
export function verifyLicenseCode(code: string, machineHex?: string): ParsedLicense | null {
  // 前缀与连字符均为展示层格式：解析时全部剥除（Crockford 容错）
  const cleaned = code.trim().toUpperCase().replace(/-/g, '');
  if (!cleaned.startsWith('NBX1')) return null;
  const raw = base32Decode(cleaned.slice(4));
  if (!raw || raw.length !== 34) return null;
  const payload = raw.subarray(0, 22);
  const mac = raw.subarray(22);
  if (!crypto.timingSafeEqual(hmac(payload), mac)) return null;
  if (payload.readUInt8(0) !== 1) return null;
  const machine = payload.subarray(1, 17).toString('hex').toUpperCase();
  if (machineHex && machine !== machineHex.toUpperCase()) return null;
  const typeByte = payload.readUInt8(17);
  if (typeByte !== 1 && typeByte !== 2) return null;
  const expRaw = payload.readUInt32BE(18);
  return {
    machine,
    type: typeByte === 1 ? 'perpetual' : 'subscription',
    expDays: typeByte === 1 ? null : expRaw,
  };
}

/* ---------- 试用与状态机 ---------- */

interface TimeRecord {
  startTs?: number;
  maxSeenTs: number;
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    log('warn', `license: 写入 ${file} 失败: ${e}`);
  }
}

/** 读取并推进时间记录（maxSeenTs 单调不减，防系统时间回拨绕过订阅到期/延长试用） */
function bumpTimeRecord(file: string, extra?: Record<string, unknown>): TimeRecord & Record<string, unknown> {
  const rec = readJson(file) || {};
  const now = Date.now();
  const merged: TimeRecord & Record<string, unknown> = { ...rec, ...extra, maxSeenTs: Math.max(Number(rec.maxSeenTs) || 0, now) };
  writeJson(file, merged);
  return merged;
}

function readLicenseRecord(): { code: string; activatedAt: string; maxSeenTs: number } | null {
  const rec = readJson(licenseFile());
  if (!rec || typeof rec.code !== 'string') return null;
  return rec;
}

/** 当前许可状态（每次调用都会推进 maxSeenTs 记录） */
export function getLicenseState(): LicenseState {
  const machine = machineCode();
  const machineHex = rawMachineCode().toString('hex').toUpperCase();

  const rec = readJson(trialFile());
  const initStartTs = rec && rec.startTs ? undefined : { startTs: Date.now() };
  const trialRec = bumpTimeRecord(trialFile(), initStartTs);
  const startTs = Number(trialRec.startTs) || Date.now();

  const licRec = readLicenseRecord();
  let licMaxSeenTs = 0;
  if (licRec) {
    bumpTimeRecord(licenseFile());
    licMaxSeenTs = Number(licRec.maxSeenTs) || 0;
  }
  // 生效时间取「见过的最大值」：试用与激活文件各自记录，防止拨回系统时间绕过订阅到期/延长试用
  const effectiveNow = Math.max(Date.now(), Number(trialRec.maxSeenTs) || 0, licMaxSeenTs);

  if (licRec) {
    const parsed = verifyLicenseCode(licRec.code, machineHex);
    if (parsed) {
      let expired = false;
      if (parsed.type === 'subscription' && parsed.expDays !== null) {
        expired = tsToDay(effectiveNow) > parsed.expDays;
      }
      const info: LicenseInfo = {
        type: parsed.type,
        expiresAt:
          parsed.type === 'subscription' && parsed.expDays !== null
            ? new Date(dayToTs(parsed.expDays) + 86399999).toISOString()
            : null,
        activatedAt: licRec.activatedAt,
        code: licRec.code,
      };
      return {
        status: expired ? 'expired' : 'activated',
        machineCode: machine,
        trialDaysLeft: null,
        license: info,
      };
    }
    log('warn', 'license: 激活文件验签失败（机器不匹配或文件被篡改），按未激活处理');
  }

  const trialMs = (effectiveNow - startTs) / 86400000;
  const daysLeft = Math.ceil(TRIAL_DAYS - trialMs);
  if (daysLeft > 0) {
    return { status: 'trial', machineCode: machine, trialDaysLeft: daysLeft, license: null };
  }
  return { status: 'expired', machineCode: machine, trialDaysLeft: null, license: null };
}

/** 激活：验签通过后落盘 license.json */
export function activateLicense(code: string): { ok: boolean; error?: string; state?: LicenseState } {
  const machineHex = rawMachineCode().toString('hex').toUpperCase();
  const parsed = verifyLicenseCode(code, machineHex);
  if (!parsed) {
    // 区分「机器不匹配」与「码无效」提示
    const anyMachine = verifyLicenseCode(code);
    return {
      ok: false,
      error: anyMachine ? '该激活码绑定的是其他机器，请核对机器码后联系换码' : '激活码无效，请检查是否完整复制',
    };
  }
  if (parsed.type === 'subscription' && parsed.expDays !== null && tsToDay(Date.now()) > parsed.expDays) {
    return { ok: false, error: '该订阅激活码已过期，请续费后获取新码' };
  }
  bumpTimeRecord(licenseFile(), {
    code: code.trim(),
    activatedAt: new Date().toISOString(),
  });
  log('info', `license: 激活成功（${parsed.type}）`);
  return { ok: true, state: getLicenseState() };
}

/** 注销激活（换机前使用），回到试用状态（试用起点不变） */
export function deactivateLicense(): { ok: boolean } {
  try {
    if (fs.existsSync(licenseFile())) fs.rmSync(licenseFile());
    log('info', 'license: 已注销激活');
  } catch (e) {
    log('warn', `license: 注销失败: ${e}`);
    return { ok: false };
  }
  return { ok: true };
}

/** 到期/试用耗尽后的只读判定：核心写操作入口调用 */
export function isReadOnly(): boolean {
  return getLicenseState().status === 'expired';
}
