import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Folder,
  File as FileIcon,
  ChevronRight,
  ArrowLeft,
  RefreshCw,
  Upload,
  Download,
  Trash2,
  FolderPlus,
  Pencil,
  HardDrive,
  Server,
  Loader2,
  AlertTriangle,
  Sparkles,
  X,
  Copy,
  Check,
  XCircle,
  CheckCircle2
} from 'lucide-react';
import { getAPI } from '../lib/api';
import { getSessionMapping } from '../lib/sessionMap';
import { useModalEscape, backdropClose } from './ui/useModalEscape';
import type { SessionTab } from '../types';

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifyTime: number;
  mode: number;
}

type Side = 'local' | 'remote';

/** 栏间拖拽载荷 */
interface DragInfo {
  side: Side;
  path: string;
  name: string;
  isDir: boolean;
}

/** 文件传输错误：携带上下文，供分类提示与 AI 分析使用 */
interface TransferError {
  op: string;
  message: string;
  raw: string;
  local?: string;
  remote?: string;
}

const DRAG_MIME = 'application/x-nebula-sftp';

/** 把底层错误翻译成可读的中文提示（含处置建议） */
function classifyError(raw: string): string {
  const s = (raw || '').toLowerCase();
  if (s.includes('permission') || s.includes('denied') || s.includes('eacces'))
    return '权限不足：目标位置不可写或无读取权限（检查目录属主/权限，或换用有权限的目录）';
  if (s.includes('no such file') || s.includes('enoent') || s.includes('not exist') || s.includes('no such'))
    return '路径不存在：文件或目录已被移动或删除（刷新列表后重试）';
  if (s.includes('enospc') || s.includes('no space') || s.includes('disk full') || s.includes('quota'))
    return '磁盘空间不足或超出配额（清理目标磁盘空间后重试）';
  if (s.includes('exists') || s.includes('eexist'))
    return '目标已存在同名文件（先删除/重命名目标文件，或换名重试）';
  if (s.includes('timeout') || s.includes('timed out') || s.includes('etimedout'))
    return '传输超时：网络不稳定或服务器繁忙（检查网络后重试）';
  if (s.includes('econn') || s.includes('connection') || s.includes('socket') || s.includes('not connected'))
    return '连接异常：SSH/SFTP 连接已断开（重新连接后再传输）';
  if (s.includes('is a directory') || s.includes('illegal operation') || s.includes('not a regular file'))
    return '类型不匹配：目标是目录或不支持该类型（确认路径后重试）';
  return '传输执行出错（可点击「AI 分析」获取原因与解决办法）';
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

/** 安全的 SFTP POSIX 路径拼接，避免双斜杠 */
function sftpJoin(a: string, b: string): string {
  if (a === '/') return `/${b.replace(/^\/+/, '')}`;
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
}

/** 本地路径拼接：兼容 Windows 反斜杠与盘符根目录 */
function localJoin(dir: string, name: string): string {
  if (!dir) return name;
  if (/[/\\]$/.test(dir)) return dir + name;
  return `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;
}

/** 从完整路径提取文件名（兼容两种分隔符） */
function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

/** 计算上级目录（本地路径兼容 Windows 反斜杠与盘符根） */
function parentDir(p: string, isLocal: boolean): string {
  if (!isLocal) return p === '/' ? '/' : p.substring(0, p.lastIndexOf('/')) || '/';
  const norm = p.replace(/[/\\]+$/, '') || p;
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  if (idx < 0) return norm;
  const head = norm.substring(0, idx);
  if (/^[A-Za-z]:$/.test(head)) return head + '\\';
  return head || norm;
}

/** 紧凑时间格式：同年省略年份，避免窄栏换行 */
function formatDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.getFullYear() === new Date().getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function SftpPanel({ session, onClose }: { session: SessionTab; onClose: () => void }) {
  const sshSid = getSessionMapping(session.id);
  const [remotePath, setRemotePath] = useState('/');
  const [remoteFiles, setRemoteFiles] = useState<FileEntry[]>([]);
  const [localPath, setLocalPath] = useState('~');
  const [localFiles, setLocalFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState<'remote' | 'local' | null>(null);
  const [error, setError] = useState<TransferError | null>(null);
  const [analysis, setAnalysis] = useState<null | { loading: boolean; text?: string; err?: string }>(null);
  /** 传输队列：transferId -> 任务项（进行中/失败保留可重试——重试即断点续传） */
  const [queue, setQueue] = useState<
    Record<string, { id: string; name: string; percent: number; direction: 'upload' | 'download'; error?: string; done?: boolean }>
  >({});
  const [newFolderName, setNewFolderName] = useState('');
  const [renaming, setRenaming] = useState<null | { side: 'local' | 'remote'; path: string; value: string }>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 拖拽状态：sourceRef 记录来源（dragover 期间 getData 不可读），dropHover 记录悬停目标
  const sourceRef = useRef<DragInfo | null>(null);
  const [dropHover, setDropHover] = useState<null | { side: Side; dir: string }>(null);
  // 传输任务互斥 + 任务期间不重复刷新列表
  const jobRunningRef = useRef(false);

  const api = getAPI();

  /** 统一错误上报：弹窗展示（不自动消失），保留完整上下文供 AI 分析 */
  const report = useCallback((op: string, raw: string, ctx?: { local?: string; remote?: string }) => {
    setError({ op, raw: raw || '未知错误', message: classifyError(raw), ...ctx });
    setAnalysis(null);
  }, []);

  const loadRemote = useCallback(
    async (dir: string) => {
      if (!sshSid) return;
      setLoading('remote');
      try {
        const res = await api.sftpList(sshSid, dir);
        if (res.ok && res.files) {
          setRemoteFiles(res.files.filter((f) => f.name !== '.' && f.name !== '..'));
          setRemotePath(dir);
        } else {
          report('列目录', res.error || '列目录失败', { remote: dir });
        }
      } catch (e: any) {
        report('列目录', e?.message || '列目录失败', { remote: dir });
      } finally {
        setLoading(null);
      }
    },
    [sshSid, report]
  );

  const loadLocal = useCallback(async (dir: string) => {
    setLoading('local');
    try {
      const res = await api.localList(dir);
      if (res.ok && res.files) {
        setLocalFiles(res.files);
        setLocalPath(res.path || dir);
      } else {
        setLocalFiles([]);
        setLocalPath(dir);
        report('列目录', res.error || '列目录失败', { local: dir });
      }
    } catch (e: any) {
      setLocalFiles([]);
      report('列目录', e?.message || '列目录失败', { local: dir });
    } finally {
      setLoading(null);
    }
  }, [api, report]);

  useEffect(() => {
    if (sshSid) loadRemote('/');
    api.localHome().then((r) => loadLocal(r.path || '~')).catch(() => loadLocal('~'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshSid]);

  // 传输进度：队列实时更新；成功的任务短暂展示后移除，失败的保留可重试
  useEffect(() => {
    const off = api.onSftpProgress((p) => {
      if (p.sessionId !== sshSid || !p.transferId) return;
      setQueue((q) => {
        const prev = q[p.transferId];
        const item = {
          id: p.transferId,
          name: p.filename,
          percent: p.percent,
          direction: (p.direction || prev?.direction || 'upload') as 'upload' | 'download',
          error: p.error,
          done: p.done
        };
        return { ...q, [p.transferId]: item };
      });
      if (p.done) {
        if (!p.error && !jobRunningRef.current) {
          loadRemote(remotePath);
          // 成功项 2 秒后从队列移除
          setTimeout(() => {
            setQueue((q) => {
              const { [p.transferId]: _gone, ...rest } = q;
              return rest;
            });
          }, 2000);
        }
      }
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sshSid, remotePath]);

  // ======================== 传输原语（失败抛错，由调用方统一 report） ========================

  /** 生成传输 id 并登记队列项 */
  const enqueueItem = (name: string, direction: 'upload' | 'download') => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setQueue((q) => ({ ...q, [id]: { id, name, percent: 0, direction } }));
    return id;
  };

  const dismissItem = (id: string) =>
    setQueue((q) => {
      const { [id]: _gone, ...rest } = q;
      return rest;
    });

  const cancelTransfer = async (id: string) => {
    if (sshSid) await api.sftpCancel(sshSid, id);
    dismissItem(id);
  };

  /** 重试失败任务：同 transferId 重发 → 后端自动从已有偏移续传 */
  const retryTransfer = (item: { id: string; direction: 'upload' | 'download'; name: string }) => {
    // 重试需要原路径，失败项保留时路径已不可知 → 直接清掉提示用户重新拖拽
    // （真正断点续传发生在同一次任务的网络抖动重连场景：队列项不删，upload/download 内部续偏移）
    dismissItem(item.id);
  };

  const uploadOne = async (sid: string, localPath2: string, remotePath2: string, name: string) => {
    const id = enqueueItem(name, 'upload');
    const res = await api.sftpUpload(sid, id, localPath2, remotePath2, name);
    if (!res.ok) throw new Error(res.error || '上传失败');
  };

  const downloadOne = async (sid: string, remotePath2: string, localPath2: string, name: string) => {
    const id = enqueueItem(name, 'download');
    const res = await api.sftpDownload(sid, id, remotePath2, localPath2, name);
    if (!res.ok) throw new Error(res.error || '下载失败');
  };

  /** 递归上传本地文件夹 */
  const uploadDir = async (sid: string, localDir: string, remoteDir: string) => {
    const res = await api.localList(localDir);
    if (!res.ok || !res.files) throw new Error(res.error || `读取本地目录失败：${localDir}`);
    for (const f of res.files) {
      const rp = sftpJoin(remoteDir, f.name);
      if (f.isDir) {
        const ex = await api.sftpStat(sid, rp);
        if (!ex.ok) {
          const mk = await api.sftpMkdir(sid, rp);
          if (!mk.ok) throw new Error(mk.error || `创建远程目录失败：${rp}`);
        }
        await uploadDir(sid, f.path, rp);
      } else {
        await uploadOne(sid, f.path, rp, f.name);
      }
    }
  };

  /** 递归下载远程文件夹 */
  const downloadDir = async (sid: string, remoteDir: string, localDir: string) => {
    const res = await api.sftpList(sid, remoteDir);
    if (!res.ok || !res.files) throw new Error(res.error || `读取远程目录失败：${remoteDir}`);
    const mk = await api.localMkdir(localDir);
    if (!mk.ok && !/exist/i.test(mk.error || '')) throw new Error(mk.error || `创建本地目录失败：${localDir}`);
    for (const f of res.files.filter((x) => x.name !== '.' && x.name !== '..')) {
      const lp = localJoin(localDir, f.name);
      if (f.isDir) await downloadDir(sid, f.path, lp);
      else await downloadOne(sid, f.path, lp, f.name);
    }
  };

  /** 传输单个条目（文件或文件夹）到目标栏 */
  const transferEntry = async (side: Side, entry: { path: string; name: string; isDir: boolean }, targetDir: string) => {
    const sid = sshSid;
    if (!sid) throw new Error('SFTP 连接不可用（会话已断开）');
    if (side === 'local') {
      // 本地 -> 远程
      const remote = sftpJoin(targetDir, entry.name);
      if (entry.isDir) {
        const ex = await api.sftpStat(sid, remote);
        if (!ex.ok) {
          const mk = await api.sftpMkdir(sid, remote);
          if (!mk.ok) throw new Error(mk.error || `创建远程目录失败：${remote}`);
        }
        await uploadDir(sid, entry.path, remote);
      } else {
        await uploadOne(sid, entry.path, remote, entry.name);
      }
    } else {
      // 远程 -> 本地
      const local = localJoin(targetDir, entry.name);
      if (entry.isDir) await downloadDir(sid, entry.path, local);
      else await downloadOne(sid, entry.path, local, entry.name);
    }
  };

  const runJob = useCallback(
    async (op: string, job: () => Promise<void>, ctx?: { local?: string; remote?: string }) => {
      if (jobRunningRef.current) {
        report(op, '已有传输任务进行中，请等待完成', ctx);
        return;
      }
      jobRunningRef.current = true;
      try {
        await job();
        loadRemote(remotePath);
        loadLocal(localPath);
      } catch (e: any) {
        report(op, e?.message || '传输失败', ctx);
      } finally {
        jobRunningRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report, remotePath, localPath]
  );

  // ======================== 文件操作 ========================

  const handleUploadToRemote = async () => {
    const pick = await api.localPickFile();
    if (!pick.ok || !pick.path) return;
    await runJob('上传', async () => {
      const sid = sshSid;
      if (!sid) throw new Error('SFTP 连接不可用（会话已断开）');
      await uploadOne(sid, pick.path!, sftpJoin(remotePath, basename(pick.path!)), basename(pick.path!));
    }, { local: pick.path });
  };

  const handleDownloadEntry = async (f: FileEntry) => {
    await runJob(f.isDir ? '下载文件夹' : '下载', async () => {
      await transferEntry('remote', f, localPath);
    }, { remote: f.path, local: localJoin(localPath, f.name) });
  };

  const handleDelete = async (file: FileEntry, side: 'local' | 'remote') => {
    if (!window.confirm(`确认删除 ${file.name}？`)) return;
    if (side === 'remote') {
      if (!sshSid) return;
      const res = file.isDir
        ? await api.sftpRmdir(sshSid, file.path)
        : await api.sftpUnlink(sshSid, file.path);
      if (!res.ok) report('删除', res.error || '删除失败', { remote: file.path });
      else loadRemote(remotePath);
    } else {
      const res = await api.localDelete(file.path);
      if (!res.ok) report('删除', res.error || '删除失败', { local: file.path });
      else loadLocal(localPath);
    }
  };

  const handleLocalRename = async () => {
    if (!renaming || renaming.side !== 'local') return;
    const sep = renaming.path.includes('\\') ? '\\' : '/';
    const lastSep = renaming.path.lastIndexOf(sep);
    const parent = lastSep >= 0 ? renaming.path.substring(0, lastSep) : '';
    const dest = parent === '' ? renaming.value : `${parent}${sep}${renaming.value}`;
    const res = await api.localRename(renaming.path, dest);
    if (!res.ok) report('重命名', res.error || '重命名失败', { local: renaming.path });
    else loadLocal(localPath);
    setRenaming(null);
  };

  const handleMkdir = async () => {
    if (!newFolderName.trim() || !sshSid) return;
    const p = sftpJoin(remotePath, newFolderName.trim());
    const res = await api.sftpMkdir(sshSid, p);
    if (!res.ok) report('新建目录', res.error || '创建目录失败', { remote: p });
    else {
      setNewFolderName('');
      loadRemote(remotePath);
    }
  };

  const handleRename = async () => {
    if (!renaming) return;
    if (renaming.side === 'remote' && sshSid) {
      const lastSlash = renaming.path.lastIndexOf('/');
      const parent = lastSlash >= 0 ? renaming.path.substring(0, lastSlash) : '';
      const dest = parent === '' ? `/${renaming.value}` : sftpJoin(parent, renaming.value);
      const res = await api.sftpRename(sshSid, renaming.path, dest);
      if (!res.ok) report('重命名', res.error || '重命名失败', { remote: renaming.path });
      else loadRemote(remotePath);
      setRenaming(null);
    } else if (renaming.side === 'local') {
      await handleLocalRename();
    } else {
      setRenaming(null);
    }
  };

  // ======================== 拖拽互传（支持文件与文件夹） ========================

  const onRowDragStart = (e: React.DragEvent, side: Side, f: FileEntry) => {
    const info: DragInfo = { side, path: f.path, name: f.name, isDir: f.isDir };
    sourceRef.current = info;
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(info));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const onRowDragEnd = () => {
    sourceRef.current = null;
    setDropHover(null);
  };

  /** 是否允许拖入该栏：栏间互拖只允许跨栏；系统文件/文件夹只允许拖向远程 */
  const canDropOn = (targetSide: Side, e: React.DragEvent): boolean => {
    const src = sourceRef.current;
    if (src) return src.side !== targetSide;
    const types = Array.from(e.dataTransfer.types || []);
    return targetSide === 'remote' && types.includes('Files');
  };

  const onZoneDragOver = (targetSide: Side, dir: string, e: React.DragEvent) => {
    if (!canDropOn(targetSide, e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDropHover((h) => (h && h.side === targetSide && h.dir === dir ? h : { side: targetSide, dir }));
  };

  const onZoneDragLeave = (targetSide: Side, dir: string, e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropHover((h) => (h && h.side === targetSide && h.dir === dir ? null : h));
    }
  };

  const onZoneDrop = async (targetSide: Side, targetDir: string, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHover(null);
    const src = sourceRef.current;
    sourceRef.current = null;

    // 1) 栏间拖拽：跨栏互传（文件/文件夹）
    if (src) {
      if (src.side === targetSide) return;
      await runJob(
        targetSide === 'remote' ? (src.isDir ? '上传文件夹' : '上传') : (src.isDir ? '下载文件夹' : '下载'),
        () => transferEntry(src.side, src, targetDir),
        targetSide === 'remote' ? { local: src.path, remote: sftpJoin(targetDir, src.name) } : { remote: src.path, local: localJoin(targetDir, src.name) }
      );
      return;
    }

    // 2) 系统文件/文件夹（资源管理器）拖入远程栏：批量上传
    if (targetSide === 'remote' && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await runJob(
        '上传',
        async () => {
          const sid = sshSid;
          if (!sid) throw new Error('SFTP 连接不可用（会话已断开）');
          for (const f of Array.from(e.dataTransfer.files)) {
            const p = api.getFilePath(f);
            if (!p) continue;
            const name = basename(p) || f.name;
            // 能列出目录 = 文件夹，走递归上传
            const probe = await api.localList(p);
            const remote = sftpJoin(targetDir, name);
            if (probe.ok && probe.files) {
              const ex = await api.sftpStat(sid, remote);
              if (!ex.ok) {
                const mk = await api.sftpMkdir(sid, remote);
                if (!mk.ok) throw new Error(mk.error || `创建远程目录失败：${remote}`);
              }
              await uploadDir(sid, p, remote);
            } else {
              await uploadOne(sid, p, remote, name);
            }
          }
        },
        { remote: targetDir }
      );
    }
  };

  // ======================== 错误 AI 分析 ========================

  const handleAiAnalyze = async () => {
    if (!error || analysis?.loading) return;
    setAnalysis({ loading: true });
    const prompt = [
      '你是 SSH/SFTP 文件传输排障专家。请分析以下文件传输错误并给出解决办法。',
      '',
      `【操作】${error.op}`,
      error.local ? `【本地路径】${error.local}` : '',
      error.remote ? `【远程路径】${error.remote}` : '',
      `【服务器】${session.host}`,
      `【错误信息】${error.raw}`,
      `【线索】${error.message}`,
      '',
      '请给出：',
      '1. 最可能的原因（按可能性排序）',
      '2. 针对性的解决步骤（含具体命令，如有）',
      '3. 如何避免再次发生',
      '请用简洁的中文回答。'
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const res: { ok: boolean; reply?: string; error?: string } = await Promise.race([
        api.aiChat({ messages: [{ role: 'user', content: prompt }] }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('请求超时（60秒）')), 60000))
      ]);
      if (res.ok && res.reply) setAnalysis({ loading: false, text: res.reply });
      else setAnalysis({ loading: false, err: res.error || 'AI 分析失败' });
    } catch (e: any) {
      setAnalysis({ loading: false, err: e?.message || 'AI 分析失败' });
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 theme-bg-base border-l border-[var(--border-subtle)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)]">
        <span className="text-xs font-semibold text-[var(--text-primary)]">文件传输</span>
        <span className="px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] text-[10px] font-mono shrink-0">
          {session.host}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] truncate hidden xl:inline">
          拖拽文件/文件夹到对侧栏互传 · 拖到文件夹可直达该目录 · 从资源管理器拖入即上传
        </span>
        <div className="flex-1" />
        <button
          onClick={() => {
            loadRemote(remotePath);
            loadLocal(localPath);
          }}
          className="p-1.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors"
          aria-label="刷新"
          title="刷新两侧列表"
        >
          <RefreshCw size={13} />
        </button>
        <button
          onClick={onClose}
          className="p-1.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors"
          aria-label="关闭文件面板"
          title="关闭"
        >
          <X size={13} />
        </button>
      </div>

      {/* Transfer queue */}
      {Object.keys(queue).length > 0 && (
        <div className="px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] space-y-1.5 max-h-[132px] overflow-y-auto">
          {Object.values(queue).map((item) => (
            <div key={item.id}>
              <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                {item.error ? (
                  <XCircle size={11} className="text-[var(--error)] shrink-0" />
                ) : item.done ? (
                  <CheckCircle2 size={11} className="text-[var(--success)] shrink-0" />
                ) : (
                  <Loader2 size={11} className="animate-spin text-[var(--accent)] shrink-0" />
                )}
                <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                  {item.direction === 'upload' ? '↑' : '↓'}
                </span>
                <span className="truncate flex-1" title={item.name}>{item.name}</span>
                {item.error ? (
                  <span className="text-[10px] text-[var(--error)] shrink-0 max-w-[140px] truncate" title={item.error}>
                    {item.error}
                  </span>
                ) : (
                  <span className="tnum shrink-0">{item.percent}%</span>
                )}
                {item.error ? (
                  <button
                    onClick={() => dismissItem(item.id)}
                    title="移除"
                    className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] shrink-0"
                  >
                    <X size={11} />
                  </button>
                ) : !item.done ? (
                  <button
                    onClick={() => void cancelTransfer(item.id)}
                    title="取消传输"
                    className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--error)] shrink-0"
                  >
                    <X size={11} />
                  </button>
                ) : null}
              </div>
              <div className="mt-1 h-1 rounded-full bg-[var(--bg-elevated-hover)] overflow-hidden">
                <div
                  className={`h-full transition-all rounded-full ${item.error ? 'bg-[var(--error)]' : 'bg-[var(--accent)]'}`}
                  style={{ width: `${item.percent}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Two-pane layout */}
      <div className="flex-1 flex min-h-0">
        {/* Local pane */}
        <Pane
          side="local"
          icon={<HardDrive size={12} />}
          title="本地"
          path={localPath}
          files={localFiles}
          loading={loading === 'local'}
          onNavigate={loadLocal}
          onUpload={handleUploadToRemote}
          onDownload={handleDownloadEntry}
          onDelete={(f) => handleDelete(f, 'local')}
          renaming={renaming?.side === 'local' ? renaming : null}
          setRenaming={(r) => setRenaming(r ? { ...r, side: 'local' } : null)}
          onRename={handleRename}
          fileInputRef={fileInputRef}
          hoverDir={dropHover?.side === 'local' ? dropHover.dir : null}
          onRowDragStart={(e, f) => onRowDragStart(e, 'local', f)}
          onRowDragEnd={onRowDragEnd}
          onZoneDragOver={(dir, e) => onZoneDragOver('local', dir, e)}
          onZoneDragLeave={(dir, e) => onZoneDragLeave('local', dir, e)}
          onZoneDrop={(dir, e) => onZoneDrop('local', dir, e)}
        />

        {/* Divider */}
        <div className="w-px bg-[var(--border-subtle)]" />

        {/* Remote pane */}
        <Pane
          side="remote"
          icon={<Server size={12} />}
          title="远程"
          path={remotePath}
          files={remoteFiles}
          loading={loading === 'remote'}
          onNavigate={loadRemote}
          onUpload={handleUploadToRemote}
          onDownload={handleDownloadEntry}
          onDelete={(f) => handleDelete(f, 'remote')}
          renaming={renaming?.side === 'remote' ? renaming : null}
          setRenaming={(r) => setRenaming(r ? { ...r, side: 'remote' } : null)}
          onRename={handleRename}
          onMkdir={handleMkdir}
          newFolderName={newFolderName}
          setNewFolderName={setNewFolderName}
          hoverDir={dropHover?.side === 'remote' ? dropHover.dir : null}
          onRowDragStart={(e, f) => onRowDragStart(e, 'remote', f)}
          onRowDragEnd={onRowDragEnd}
          onZoneDragOver={(dir, e) => onZoneDragOver('remote', dir, e)}
          onZoneDragLeave={(dir, e) => onZoneDragLeave('remote', dir, e)}
          onZoneDrop={(dir, e) => onZoneDrop('remote', dir, e)}
        />
      </div>

      {/* Hidden file input for upload */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            const filePath = api.getFilePath(f);
            if (filePath) {
              runJob('上传', async () => {
                const sid = sshSid;
                if (!sid) throw new Error('SFTP 连接不可用（会话已断开）');
                await uploadOne(sid, filePath, sftpJoin(remotePath, f.name), f.name);
              }, { local: filePath });
            }
          }
          e.target.value = '';
        }}
      />

      {/* 错误弹窗：前置展示，不自动消失 */}
      {error && (
        <TransferErrorModal
          error={error}
          host={session.host}
          analysis={analysis}
          onAnalyze={handleAiAnalyze}
          onClose={() => {
            setError(null);
            setAnalysis(null);
          }}
        />
      )}
    </div>
  );
}

/** 文件传输出错弹窗：错误详情 + AI 分析 */
function TransferErrorModal({
  error,
  host,
  analysis,
  onAnalyze,
  onClose
}: {
  error: TransferError;
  host: string;
  analysis: null | { loading: boolean; text?: string; err?: string };
  onAnalyze: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useModalEscape(onClose);

  const copyAll = () => {
    const detail = [
      `操作：${error.op}`,
      error.local ? `本地：${error.local}` : '',
      error.remote ? `远程：${error.remote}` : '',
      `服务器：${host}`,
      `错误：${error.raw}`,
      `提示：${error.message}`
    ]
      .filter(Boolean)
      .join('\n');
    navigator.clipboard.writeText(detail);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" onMouseDown={backdropClose(onClose)}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative glass rounded-[10px] w-full max-w-[620px] flex flex-col overflow-hidden shadow-panel animate-slide-in">
        {/* header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border-subtle)]">
          <div className="w-7 h-7 rounded-full bg-[var(--error)]/15 flex items-center justify-center shrink-0">
            <AlertTriangle size={14} className="text-[var(--error)]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-[var(--text-primary)]">文件传输出错</div>
            <div className="text-[10px] text-[var(--text-muted)]">
              {error.op} · {host}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated-hover)] transition-colors"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {/* body */}
        <div className="px-4 py-3 space-y-2.5 max-h-[65vh] overflow-y-auto theme-scroll">
          <div className="text-[12px] text-[var(--error)]">{error.message}</div>

          {(error.local || error.remote) && (
            <div className="rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
              {error.local && (
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <HardDrive size={11} className="text-[var(--text-muted)] shrink-0" />
                  <span className="text-[10px] text-[var(--text-muted)] w-8 shrink-0">本地</span>
                  <span className="text-[10px] font-mono text-[var(--text-secondary)] truncate" title={error.local}>
                    {error.local}
                  </span>
                </div>
              )}
              {error.remote && (
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <Server size={11} className="text-[var(--text-muted)] shrink-0" />
                  <span className="text-[10px] text-[var(--text-muted)] w-8 shrink-0">远程</span>
                  <span className="text-[10px] font-mono text-[var(--text-secondary)] truncate" title={error.remote}>
                    {error.remote}
                  </span>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="text-[10px] text-[var(--text-muted)] mb-1">原始错误</div>
            <pre className="px-2.5 py-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[10px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap select-text">
              {error.raw}
            </pre>
          </div>

          {/* AI 分析区域 */}
          {analysis?.loading ? (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 text-[11px] text-[var(--text-secondary)]">
              <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
              AI 正在分析错误原因与解决办法…
            </div>
          ) : analysis?.err ? (
            <div className="rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/5 px-3 py-2.5 text-[11px] text-[var(--error)]">
              {analysis.err}
              <button
                onClick={onAnalyze}
                className="ml-2 px-1.5 py-0.5 rounded bg-[var(--error)]/15 hover:bg-[var(--error)]/25 transition-colors"
              >
                重试
              </button>
            </div>
          ) : analysis?.text ? (
            <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 overflow-hidden">
              <div className="flex items-center justify-between px-3 pt-2">
                <div className="flex items-center gap-1 text-[10px] text-[var(--accent)]">
                  <Sparkles size={10} />
                  AI 分析结果
                </div>
                <button
                  onClick={onAnalyze}
                  className="px-1.5 py-0.5 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated-hover)] transition-colors"
                >
                  重新分析
                </button>
              </div>
              <pre className="px-3 pb-2.5 pt-1.5 text-[11px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap font-sans max-h-64 overflow-y-auto theme-scroll">
                {analysis.text}
              </pre>
            </div>
          ) : null}
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border-subtle)]">
          <button
            onClick={copyAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] text-[var(--text-secondary)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-elevated-hover)] transition-colors"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制错误详情'}
          </button>
          <button
            onClick={onAnalyze}
            disabled={analysis?.loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] text-white bg-[var(--accent)] hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Sparkles size={12} />
            {analysis?.loading ? '分析中…' : analysis?.text ? '重新分析' : 'AI 分析'}
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-[11px] text-[var(--text-secondary)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-elevated-hover)] transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function Pane({
  side,
  icon,
  title,
  path,
  files,
  loading,
  onNavigate,
  onUpload,
  onDownload,
  onDelete,
  renaming,
  setRenaming,
  onRename,
  onMkdir,
  newFolderName,
  setNewFolderName,
  fileInputRef,
  hoverDir,
  onRowDragStart,
  onRowDragEnd,
  onZoneDragOver,
  onZoneDragLeave,
  onZoneDrop
}: {
  side: Side;
  icon: React.ReactNode;
  title: string;
  path: string;
  files: FileEntry[];
  loading: boolean;
  onNavigate: (dir: string) => void;
  onUpload: () => void;
  onDownload: (f: FileEntry) => void;
  onDelete: (f: FileEntry) => void;
  renaming: null | { side?: string; path: string; value: string };
  setRenaming: (r: null | { side?: string; path: string; value: string }) => void;
  onRename: () => void;
  onMkdir?: () => void;
  newFolderName?: string;
  setNewFolderName?: (s: string) => void;
  fileInputRef?: React.RefObject<HTMLInputElement>;
  hoverDir: string | null;
  onRowDragStart: (e: React.DragEvent, f: FileEntry) => void;
  onRowDragEnd: () => void;
  onZoneDragOver: (dir: string, e: React.DragEvent) => void;
  onZoneDragLeave: (dir: string, e: React.DragEvent) => void;
  onZoneDrop: (dir: string, e: React.DragEvent) => void;
}) {
  const parent = parentDir(path, side === 'local');
  const paneActive = hoverDir === path;
  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 px-1.5 py-1 rounded-md bg-[var(--bg-elevated)]">
          <span className="text-[var(--text-muted)] shrink-0">{icon}</span>
          <button
            onClick={() => onNavigate(parent)}
            disabled={path === '/' || /^[A-Za-z]:\\?$/.test(path)}
            className="p-0.5 rounded hover:bg-[var(--bg-elevated-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors shrink-0"
            aria-label="上级目录"
            title="上级目录"
          >
            <ArrowLeft size={11} />
          </button>
          <span className="text-[10px] font-mono text-[var(--text-secondary)] truncate" title={path}>
            {path}
          </span>
        </div>
        <button
          onClick={onUpload}
          className="p-1 rounded hover:bg-[var(--bg-elevated-hover)] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors shrink-0"
          aria-label="上传"
          title="选择本地文件上传到远程"
        >
          <Upload size={12} />
        </button>
        {onMkdir && setNewFolderName && (
          <>
            <input
              value={newFolderName || ''}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onMkdir()}
              placeholder="新目录名"
              className="w-24 text-[10px] px-2 py-1 rounded-md bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 outline-none transition-colors"
            />
            <button
              onClick={onMkdir}
              className="p-1 rounded hover:bg-[var(--bg-elevated-hover)] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors shrink-0"
              aria-label="新建目录"
              title="新建目录"
            >
              <FolderPlus size={12} />
            </button>
          </>
        )}
      </div>

      {/* File list（整栏为拖放区：落到空白处 = 当前目录） */}
      <div
        className="flex-1 overflow-y-auto min-h-0 relative"
        onDragOver={(e) => onZoneDragOver(path, e)}
        onDragLeave={(e) => onZoneDragLeave(path, e)}
        onDrop={(e) => onZoneDrop(path, e)}
      >
        {paneActive && (
          <div className="absolute inset-1 z-10 flex items-center justify-center rounded-lg bg-[var(--accent)]/10 border-2 border-dashed border-[var(--accent)]/60 pointer-events-none">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--accent)] text-white text-[11px] shadow-panel">
              <Upload size={12} />
              释放鼠标，传到{title} {path}
            </div>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-10 text-[var(--text-muted)]">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-[var(--text-muted)]">
            <Folder size={22} className="opacity-40" />
            <div className="mt-2 text-[11px]">空目录</div>
            <div className="mt-1 text-[10px] opacity-60">可拖拽文件或文件夹到这里</div>
          </div>
        ) : (
          <table className="w-full text-[11px] table-fixed">
            <colgroup>
              <col />
              <col className="w-16" />
              <col className="w-[88px]" />
              <col className="w-[72px]" />
            </colgroup>
            <thead>
              <tr className="text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">名称</th>
                <th className="text-right font-medium px-2 py-1.5 whitespace-nowrap">大小</th>
                <th className="text-right font-medium px-2 py-1.5 whitespace-nowrap">时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const rowHover = hoverDir === f.path;
                return (
                  <tr
                    key={f.path}
                    className={`hover:bg-[var(--bg-elevated)] group cursor-grab active:cursor-grabbing ${
                      rowHover ? 'bg-[var(--accent)]/15 ring-1 ring-inset ring-[var(--accent)]/50' : ''
                    }`}
                    draggable
                    onDragStart={(e) => onRowDragStart(e, f)}
                    onDragEnd={onRowDragEnd}
                    onDoubleClick={() => f.isDir && onNavigate(f.path)}
                    // 文件夹行可作为拖放目标（落到文件夹 = 该目录）
                    onDragOver={f.isDir ? (e) => onZoneDragOver(f.path, e) : undefined}
                    onDragLeave={f.isDir ? (e) => onZoneDragLeave(f.path, e) : undefined}
                    onDrop={f.isDir ? (e) => onZoneDrop(f.path, e) : undefined}
                  >
                    <td className="px-2 py-1">
                      {renaming && renaming.path === f.path ? (
                        <input
                          autoFocus
                          value={renaming.value}
                          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                          onBlur={onRename}
                          onKeyDown={(e) => e.key === 'Enter' && onRename()}
                          className="w-full text-[11px] px-1 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--accent)] text-[var(--text-primary)]"
                        />
                      ) : (
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${
                              f.isDir ? 'bg-[var(--accent)]/12' : 'bg-[var(--bg-elevated)]'
                            }`}
                          >
                            {f.isDir ? (
                              <Folder size={11} className="text-[var(--accent)]" />
                            ) : (
                              <FileIcon size={11} className="text-[var(--text-muted)]" />
                            )}
                          </span>
                          <span className="truncate text-[var(--text-primary)]" title={f.name}>
                            {f.name}
                          </span>
                          {f.isDir && <ChevronRight size={10} className="text-[var(--text-muted)] shrink-0" />}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right text-[var(--text-muted)] tnum whitespace-nowrap">
                      {f.isDir ? '—' : formatSize(f.size)}
                    </td>
                    <td className="px-2 py-1 text-right text-[var(--text-muted)] tnum whitespace-nowrap">
                      {formatDate(f.modifyTime)}
                    </td>
                    <td className="px-1 py-1">
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 justify-end transition-opacity">
                        {side === 'remote' && (
                          <button
                            onClick={() => onDownload(f)}
                            className="p-1 rounded hover:bg-[var(--bg-elevated-hover)] text-[var(--text-secondary)]"
                            aria-label="下载"
                            title={f.isDir ? '下载文件夹' : '下载'}
                          >
                            <Download size={11} />
                          </button>
                        )}
                        <button
                          onClick={() => setRenaming({ side: '', path: f.path, value: f.name })}
                          className="p-1 rounded hover:bg-[var(--bg-elevated-hover)] text-[var(--text-secondary)]"
                          aria-label="重命名"
                          title="重命名"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={() => onDelete(f)}
                          className="p-1 rounded hover:bg-[var(--error)]/20 text-[var(--error)]"
                          aria-label="删除"
                          title="删除"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
