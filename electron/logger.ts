/**
 * 主进程日志（v1.5 升级）：
 * - 内存环形缓冲（最近 500 条）：供诊断包导出，进程内可查
 * - 文件落盘：userData/Logs/nebula-YYYY-MM-DD.log，按天轮转、保留 7 天
 *   崩溃/重启后可追溯（uncaughtException 等在 main.ts 接入）
 */
import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

const MAX_ENTRIES = 500;
const KEEP_DAYS = 7;
const ring: LogEntry[] = [];

let fileDir: string | null = null;
let fileDate = '';
let fileMkdirOk = true;
/** 连续写失败计数：单次失败（文件被杀软/同步工具短时占用）跳过，连续失败达阈值才熔断 */
let writeFailCount = 0;
const MAX_CONSECUTIVE_WRITE_FAILS = 20;

/** 启用文件日志（main.ts 在 app ready 时调用一次） */
export function initFileLogging(dir: string): void {
  fileDir = dir;
  writeFailCount = 0;
  fileMkdirOk = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    fileMkdirOk = false;
  }
}

export function getLogDir(): string | null {
  return fileDir;
}

function todayStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 清理超出保留天数的旧日志 */
function pruneOldLogs(): void {
  if (!fileDir) return;
  try {
    const cutoff = todayStr(new Date(Date.now() - KEEP_DAYS * 86400000));
    for (const f of fs.readdirSync(fileDir)) {
      const m = /^nebula-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1] < cutoff) {
        try {
          fs.unlinkSync(path.join(fileDir, f));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function writeToFile(entry: LogEntry): void {
  if (!fileDir || !fileMkdirOk) return;
  try {
    const today = todayStr(new Date(entry.ts));
    if (today !== fileDate) {
      fileDate = today;
      pruneOldLogs();
    }
    const line = `${new Date(entry.ts).toISOString()} [${entry.level.toUpperCase()}] ${entry.msg}\n`;
    // appendFileSync：日志量小，同步写保证崩溃前落盘
    fs.appendFileSync(path.join(fileDir, `nebula-${today}.log`), line);
    writeFailCount = 0; // 成功即复位计数
  } catch {
    // 单次写失败大概率是文件被短时占用（杀软扫描/同步工具），跳过本次继续运行；
    // 只有连续多次失败才判定为目录级不可用并熔断（防止每条日志都抛异常拖慢主流程）
    writeFailCount++;
    if (writeFailCount >= MAX_CONSECUTIVE_WRITE_FAILS) fileMkdirOk = false;
  }
}

export function log(level: LogLevel, msg: string): void {
  const entry: LogEntry = { ts: Date.now(), level, msg };
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) ring.shift();
  writeToFile(entry);
}

export function getLogs(): LogEntry[] {
  return [...ring];
}

/** 安装全局异常捕获（崩溃原因可追溯，写入日志文件） */
export function installGlobalErrorLogging(): void {
  process.on('uncaughtException', (err) => {
    log('error', `uncaughtException: ${err?.stack || err?.message || String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    log('error', `unhandledRejection: ${msg}`);
  });
}
