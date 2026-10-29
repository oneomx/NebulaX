import { useState } from 'react';
import { Monitor, ScreenShare, RefreshCw, ExternalLink, Info, Wrench, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useAppStore } from '../store/app';
import { connectSavedConnection } from '../lib/connect';
import { getAPI } from '../lib/api';
import type { SessionTab, DetectedTools } from '../types';

/**
 * RDP/VNC 外部会话面板：通过系统程序（mstsc / VNC viewer）打开远桌面，
 * 标签页展示会话信息卡片与重新打开入口（外部窗口独立于本应用）。
 */
export default function ExternalSessionPane({ session }: { session: SessionTab }) {
  const external = session.external!;
  const conn = useAppStore((s) => s.connections.find((c) => c.id === session.connectionId));
  const [relaunching, setRelaunching] = useState(false);
  const [tools, setTools] = useState<DetectedTools | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState('');
  const isRdp = external.kind === 'rdp';
  const Icon = isRdp ? Monitor : ScreenShare;

  const relaunch = async () => {
    if (!conn || relaunching) return;
    setRelaunching(true);
    try {
      await connectSavedConnection(conn, session.id);
    } finally {
      setRelaunching(false);
    }
  };

  // 检测本机可用的远程桌面工具：RDP 看 mstsc，VNC 列出已安装的 viewer
  const detect = async () => {
    if (detecting) return;
    setDetecting(true);
    setDetectError('');
    try {
      const res = await getAPI().winDetectTools();
      if (res.ok && res.tools) setTools(res.tools);
      else setDetectError(res.error || '检测失败');
    } catch (e: any) {
      setDetectError(e?.message || '检测失败');
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center theme-bg-base">
      <div className="max-w-md w-full mx-6 rounded-xl glass p-8 text-center">
        <div
          className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center mb-4"
          style={{
            background: isRdp ? 'rgba(248,113,113,0.12)' : 'rgba(236,72,153,0.12)',
            border: `1px solid ${isRdp ? 'rgba(248,113,113,0.3)' : 'rgba(236,72,153,0.3)'}`
          }}
        >
          <Icon size={26} style={{ color: isRdp ? '#f87171' : '#ec4899' }} />
        </div>
        <div className="text-base font-semibold theme-text-primary mb-1">
          {isRdp ? '远程桌面 (RDP)' : 'VNC 远程控制'} · {session.title}
        </div>
        <div className="text-xs text-[var(--text-muted)] mb-1 tnum">{external.host}</div>
        <div
          className={`text-[11px] mb-5 flex items-center justify-center gap-1.5 ${
            session.status === 'connected' ? 'text-[var(--success)]' : session.status === 'error' ? 'text-[var(--error)]' : 'text-[var(--warning)]'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              session.status === 'connected' ? 'bg-[var(--success)]' : session.status === 'error' ? 'bg-[var(--error)]' : 'bg-[var(--warning)]'
            }`}
          />
          {session.status === 'connected'
            ? isRdp
              ? '已通过系统远程桌面连接打开'
              : '已通过本机 VNC viewer 打开'
            : session.status === 'error'
            ? '打开失败（检查地址/凭据/本机程序）'
            : '正在打开…'}
        </div>
        {session.status === 'error' && session.error && (
          <div className="mb-4 -mt-3 text-[11px] text-[var(--error)]/90 break-all leading-relaxed">{session.error}</div>
        )}

        <button
          onClick={relaunch}
          disabled={relaunching || !conn}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg theme-btn-primary text-xs font-medium disabled:opacity-50"
        >
          <RefreshCw size={13} className={relaunching ? 'animate-spin' : ''} />
          {relaunching ? '正在打开…' : '重新打开'}
        </button>

        {/* 本机工具检测：确认 mstsc / VNC viewer 是否可用 */}
        <button
          onClick={detect}
          disabled={detecting}
          className="mt-2 w-full flex items-center justify-center gap-2 py-1.5 rounded-lg border border-[var(--border-strong)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] disabled:opacity-50"
        >
          {detecting ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
          {detecting ? '正在检测…' : '检测本机工具'}
        </button>

        {detectError && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[var(--error)] text-[11px]">
            {detectError}
          </div>
        )}

        {tools && (
          <div className="mt-3 rounded-lg bg-[var(--bg-elevated)]/50 border border-[var(--border-subtle)] px-3 py-2.5">
            <div className="text-[10px] text-[var(--text-muted)] mb-1.5">检测结果</div>
            {isRdp ? (
              <div className="flex items-center gap-1.5 text-[11px]">
                {tools.mstsc ? (
                  <>
                    <CheckCircle2 size={12} className="text-[var(--success)]" />
                    <span className="text-[var(--success)]">mstsc（系统远程桌面）可用</span>
                  </>
                ) : (
                  <>
                    <XCircle size={12} className="text-[var(--error)]" />
                    <span className="text-[var(--error)]">未找到 mstsc.exe，请确认 Windows 系统组件完整</span>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                {tools.vncViewers.length > 0 ? (
                  tools.vncViewers.map((v) => (
                    <div key={v.path} className="flex items-center gap-1.5 text-[11px]">
                      <CheckCircle2 size={12} className="text-[var(--success)] shrink-0" />
                      <span className="text-[var(--success)]">{v.name}</span>
                      <span className="text-[var(--text-muted)] truncate">{v.path}</span>
                    </div>
                  ))
                ) : (
                  <div className="flex items-start gap-1.5 text-[11px]">
                    <XCircle size={12} className="text-[var(--error)] mt-0.5 shrink-0" />
                    <span className="text-[var(--error)]">
                      未检测到 VNC 客户端。请安装 TightVNC / RealVNC / UltraVNC，或在连接设置里指定 viewer 路径
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex items-start gap-2 text-left rounded-lg bg-[var(--bg-elevated)]/50 border border-[var(--border-subtle)] px-3 py-2.5">
          <Info size={13} className="text-[var(--text-muted)] mt-0.5 shrink-0" />
          <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
            {isRdp ? (
              <>
                使用 Windows 自带远程桌面 (mstsc) 打开。填了用户名/密码时会先写入系统凭据管理器
                （TERMSRV/主机地址）实现自动登录；连接窗口独立于本应用，关闭窗口不影响此标签。
              </>
            ) : (
              <>
                使用本机 VNC 客户端打开（自动探测 TightVNC / RealVNC / UltraVNC，也可在连接设置里指定
                viewer 路径）。VNC 为明文协议，建议仅在内网使用。
              </>
            )}
            <div className="mt-1 flex items-center gap-1">
              <ExternalLink size={10} />
              双击侧边栏连接或点上方按钮可再次打开
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
