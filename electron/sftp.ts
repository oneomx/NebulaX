/**
 * SFTP 文件传输模块 —— 基于 ssh2 SFTPWrapper
 * 复用已建立的 SSH 连接（同一 Client 实例上的 sftp() 子系统）。
 */
import * as path from 'path';
import * as fs from 'fs';
import type { SFTPWrapper, FileEntryWithStats, Stats } from 'ssh2';
import { EventEmitter } from 'events';

export interface RemoteFile {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifyTime: number;
  mode: number;
}

export interface TransferProgress {
  transferId: string;
  sessionId: string;
  filename: string;
  direction: 'upload' | 'download';
  transferred: number;
  total: number;
  percent: number;
  done: boolean;
  error?: string;
}

function toRemoteFile(dir: string, e: FileEntryWithStats): RemoteFile {
  const isDir = typeof e.attrs?.isDirectory === 'function' ? e.attrs.isDirectory() : false;
  return {
    name: e.filename,
    path: path.posix.join(dir, e.filename),
    isDir,
    size: e.attrs?.size ?? 0,
    modifyTime: (e.attrs?.mtime ?? 0) * 1000,
    mode: e.attrs?.mode ?? 0
  };
}

export class SftpService {
  private sftp: SFTPWrapper;
  private emitter = new EventEmitter();
  /** 进行中的传输流（transferId -> streams），支持取消（实际为 fs/ssh2 流，均带 destroy） */
  private activeStreams = new Map<
    string,
    {
      read?: NodeJS.ReadableStream & { destroy?: () => void };
      write?: NodeJS.WritableStream & { destroy?: () => void };
    }
  >();
  /** 已取消的传输 id（settle 时识别，避免销毁流被误判为成功完成） */
  private canceledIds = new Set<string>();

  constructor(private sessionId: string, sftp: SFTPWrapper) {
    this.sftp = sftp;
    // 进度事件转发
    this.emitter.setMaxListeners(100);
  }

  /** 取消进行中的传输（销毁双端流；settle 会识别为取消而非成功） */
  cancel(transferId: string): boolean {
    const entry = this.activeStreams.get(transferId);
    if (!entry) return false;
    this.canceledIds.add(transferId);
    try {
      (entry.read as unknown as { destroy: () => void })?.destroy();
    } catch {
      /* ignore */
    }
    try {
      (entry.write as unknown as { destroy: () => void })?.destroy();
    } catch {
      /* ignore */
    }
    return true;
  }

  onProgress(cb: (p: TransferProgress) => void) {
    this.emitter.on('progress', cb);
    return () => this.emitter.off('progress', cb);
  }

  private emitProgress(p: TransferProgress) {
    this.emitter.emit('progress', p);
  }

  list(dir: string): Promise<RemoteFile[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, list) => {
        if (err) return reject(err);
        const files = (list || []).map((e) => toRemoteFile(dir, e));
        // 目录优先，再按名称排序
        files.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        resolve(files);
      });
    });
  }

  stat(p: string): Promise<RemoteFile> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(p, (err, stats: Stats) => {
        if (err) return reject(err);
        resolve({
          name: path.posix.basename(p),
          path: p,
          isDir: stats.isDirectory(),
          size: stats.size,
          modifyTime: stats.mtime * 1000,
          mode: stats.mode
        });
      });
    });
  }

  mkdir(p: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.mkdir(p, (err) => (err ? reject(err) : resolve()));
    });
  }

  rmdir(p: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rmdir(p, (err) => (err ? reject(err) : resolve()));
    });
  }

  unlink(p: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.unlink(p, (err) => (err ? reject(err) : resolve()));
    });
  }

  rename(src: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rename(src, dest, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * 上传（带进度 + 断点续传），60 秒空闲超时防止连接异常时永久挂起。
   * 断点续传：远程已存在同名不完整文件（size < 本地）时从偏移处追加写。
   */
  upload(transferId: string, localPath: string, remotePath: string, filename: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let total = 0;
      try {
        total = fs.statSync(localPath).size;
      } catch {
        total = 0;
      }
      // 只结算一次：失败态发出后，后续 close/finish 不得再覆盖为成功
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout>;
      let transferred = 0;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        this.activeStreams.delete(transferId);
        // 取消的传输：流被外部销毁可能触发 close/finish，这里统一按取消失败结算
        const wasCanceled = this.canceledIds.delete(transferId);
        const finalErr = wasCanceled ? new Error('已取消') : err;
        this.emitProgress({
          transferId,
          sessionId: this.sessionId,
          filename,
          direction: 'upload',
          transferred: finalErr ? transferred : total,
          total,
          percent: finalErr ? (total ? Math.round((transferred / total) * 100) : 0) : 100,
          done: true,
          error: finalErr?.message
        });
        if (finalErr) reject(finalErr);
        else resolve();
      };

      const onIdle = () => {
        // 超时必须销毁仍在读写的流，否则网络/文件句柄继续工作且无法再 cancel
        const streams = this.activeStreams.get(transferId);
        try {
          streams?.read?.destroy?.();
        } catch {
          /* ignore */
        }
        try {
          streams?.write?.destroy?.();
        } catch {
          /* ignore */
        }
        settle(new Error('上传超时（60 秒无数据流动）'));
      };
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(onIdle, 60000);
      };

      const begin = (offset: number) => {
        transferred = offset;
        this.emitProgress({
          transferId,
          sessionId: this.sessionId,
          filename,
          direction: 'upload',
          transferred: offset,
          total,
          percent: total ? Math.round((offset / total) * 100) : 0,
          done: false
        });

        const readStream = fs.createReadStream(localPath, offset > 0 ? { start: offset } : undefined);
        // start 偏移：ssh2 支持在写流上指定起始偏移实现续传追加
        const writeStream = this.sftp.createWriteStream(remotePath, offset > 0 ? ({ start: offset } as any) : undefined);
        this.activeStreams.set(transferId, { read: readStream, write: writeStream });

        resetIdle();

        readStream.on('data', (chunk: string | Buffer) => {
          resetIdle();
          transferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
          const percent = total ? Math.round((transferred / total) * 100) : 0;
          this.emitProgress({
            transferId,
            sessionId: this.sessionId,
            filename,
            direction: 'upload',
            transferred,
            total,
            percent,
            done: false
          });
        });

        readStream.on('error', (err: Error) => {
          writeStream.destroy();
          settle(err);
        });

        writeStream.on('error', (err: Error) => {
          readStream.destroy();
          settle(err);
        });

        writeStream.on('close', () => settle());

        readStream.pipe(writeStream);
      };

      // 检查远程是否已有不完整文件（size < 本地）→ 从偏移续传。
      // 续传安全闸门：远程不完整文件的 mtime 不早于本地源文件（说明就是这个文件传了一半、
      // 且本地此后没变过）才续传，避免把不同文件拼接在一起
      const localMtime = (() => {
        try {
          return fs.statSync(localPath).mtimeMs;
        } catch {
          return 0;
        }
      })();
      this.sftp.stat(remotePath, (statErr, stats) => {
        const remoteSize = !statErr && stats ? stats.size : 0;
        // ssh2 Stats.mtime 声明为 number（秒），旧版本运行时可能返回 Date，两种都兼容
        const remoteMtimeRaw = stats ? (stats as any).mtime : 0;
        const remoteMtime = remoteMtimeRaw instanceof Date ? remoteMtimeRaw.getTime() : Number(remoteMtimeRaw || 0) * 1000;
        const offset = remoteSize > 0 && remoteSize < total && remoteMtime >= localMtime ? remoteSize : 0;
        begin(offset);
      });
    });
  }

  /**
   * 下载（带进度 + 断点续传），60 秒空闲超时防止连接异常时永久挂起。
   * 断点续传：本地已存在不完整文件（size < 远程）时以追加模式续写。
   */
  download(transferId: string, remotePath: string, localPath: string, filename: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let total = 0;
      let transferred = 0;
      // 只结算一次：失败态发出后，后续 finish 不得再覆盖为成功
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout>;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        this.activeStreams.delete(transferId);
        // 取消的传输：流被外部销毁可能触发 close/finish，这里统一按取消失败结算
        const wasCanceled = this.canceledIds.delete(transferId);
        const finalErr = wasCanceled ? new Error('已取消') : err;
        this.emitProgress({
          transferId,
          sessionId: this.sessionId,
          filename,
          direction: 'download',
          transferred: finalErr ? transferred : total,
          total,
          percent: finalErr ? (total ? Math.round((transferred / total) * 100) : 0) : 100,
          done: true,
          error: finalErr?.message
        });
        if (finalErr) reject(finalErr);
        else resolve();
      };

      const onIdle = () => {
        // 超时必须销毁仍在读写的流，否则文件句柄继续写入且无法再 cancel
        const streams = this.activeStreams.get(transferId);
        try {
          streams?.read?.destroy?.();
        } catch {
          /* ignore */
        }
        try {
          streams?.write?.destroy?.();
        } catch {
          /* ignore */
        }
        settle(new Error('下载超时（60 秒无数据流动）'));
      };
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(onIdle, 60000);
      };

      const begin = (offset: number) => {
        transferred = offset;
        this.emitProgress({
          transferId,
          sessionId: this.sessionId,
          filename,
          direction: 'download',
          transferred: offset,
          total,
          percent: total ? Math.round((offset / total) * 100) : 0,
          done: false
        });

        const readStream = this.sftp.createReadStream(remotePath, offset > 0 ? ({ start: offset } as any) : undefined);
        const writeStream = fs.createWriteStream(localPath, offset > 0 ? { flags: 'a' } : undefined);
        this.activeStreams.set(transferId, { read: readStream, write: writeStream });

        resetIdle();

        readStream.on('data', (chunk: string | Buffer) => {
          resetIdle();
          transferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
          const percent = total ? Math.round((transferred / total) * 100) : 0;
          this.emitProgress({
            transferId,
            sessionId: this.sessionId,
            filename,
            direction: 'download',
            transferred,
            total,
            percent,
            done: false
          });
        });

        readStream.on('error', (err: Error) => {
          writeStream.destroy();
          settle(err);
        });

        writeStream.on('error', (err: Error) => {
          readStream.destroy();
          settle(err);
        });

        writeStream.on('finish', () => settle());

        readStream.pipe(writeStream);
      };

      // 先获取远程文件大小，再查本地已有偏移。
      // 续传安全闸门：仅当本地不完整文件的 mtime 不早于远程 mtime（说明是同一文件的
      // 未完成下载、且远程内容此后未变过）才续传，避免把不同文件拼接在一起
      this.sftp.stat(remotePath, (statErr, stats) => {
        if (!statErr && stats) total = stats.size;
        let localSize = 0;
        let localMtime = 0;
        try {
          const lst = fs.statSync(localPath);
          localSize = lst.size;
          localMtime = lst.mtimeMs;
        } catch {
          localSize = 0;
        }
        // 同上：兼容 mtime 为 Date 或 number（秒）两种形态
        const remoteMtimeRaw = stats ? (stats as any).mtime : 0;
        const remoteMtime = remoteMtimeRaw instanceof Date ? remoteMtimeRaw.getTime() : Number(remoteMtimeRaw || 0) * 1000;
        const offset = localSize > 0 && localSize < total && localMtime >= remoteMtime ? localSize : 0;
        begin(offset);
      });
    });
  }
}
