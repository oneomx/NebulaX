import { useState, useEffect, useCallback } from 'react';
import { Route, Plus, Trash2, RefreshCw, Wifi, Globe2 } from 'lucide-react';
import { getAPI } from '../lib/api';
import Modal from './ui/Modal';
import { Label, Input } from './ui/Input';
import { Button } from './ui/Button';
import type { TunnelInfo } from '../types';

/**
 * SSH 隧道管理（对标 MobaXterm Tunneling）：
 * - 本地转发：本地端口 → 远程主机:端口（如把内网数据库映射到 127.0.0.1:13306）
 * - 动态 SOCKS：任意程序代理指向本地端口，流量经 SSH 出去（翻墙/内网穿透常用）
 */
export default function TunnelManagerModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [type, setType] = useState<'local' | 'dynamic'>('local');
  const [localPort, setLocalPort] = useState('');
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<null | { ok: boolean; text: string }>(null);

  const refresh = useCallback(async () => {
    const api = getAPI();
    const res = await api.tunnelList();
    if (res.ok && res.tunnels) setTunnels(res.tunnels.filter((t) => t.sessionId === sessionId));
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const add = async () => {
    if (busy) return;
    const lp = parseInt(localPort);
    if (!lp || lp < 1 || lp > 65535) {
      setMsg({ ok: false, text: '本地端口需为 1-65535' });
      return;
    }
    if (type === 'local') {
      if (!remoteHost.trim() || !parseInt(remotePort)) {
        setMsg({ ok: false, text: '本地转发需要目标主机与端口' });
        return;
      }
    }
    setBusy(true);
    setMsg(null);
    const api = getAPI();
    const res = await api.tunnelStart(sessionId, {
      type,
      localPort: lp,
      remoteHost: type === 'local' ? remoteHost.trim() : undefined,
      remotePort: type === 'local' ? parseInt(remotePort) : undefined
    });
    if (res.ok) {
      setMsg({ ok: true, text: type === 'local' ? `已创建：127.0.0.1:${lp} → ${remoteHost}:${remotePort}` : `SOCKS5 代理已启动：127.0.0.1:${lp}` });
      setLocalPort('');
      setRemoteHost('');
      setRemotePort('');
      await refresh();
    } else {
      setMsg({ ok: false, text: res.error || '创建失败' });
    }
    setBusy(false);
  };

  const stop = async (id: string) => {
    await getAPI().tunnelStop(id);
    await refresh();
  };

  return (
    <Modal
      title="SSH 隧道"
      subtitle="本地端口转发 / SOCKS5 动态代理（流量全程走 SSH 加密通道）"
      icon={<Route size={18} />}
      onClose={onClose}
      width="580px"
      footer={
        <div className="flex-1 flex items-center justify-end gap-2">
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      }
    >
      {/* 新建隧道 */}
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 p-3 space-y-3">
        <div className="flex gap-2">
          <button
            onClick={() => setType('local')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition ${
              type === 'local'
                ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
                : 'bg-[var(--bg-base)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Globe2 size={13} />
            本地转发 (ssh -L)
          </button>
          <button
            onClick={() => setType('dynamic')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition ${
              type === 'dynamic'
                ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
                : 'bg-[var(--bg-base)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Wifi size={13} />
            SOCKS5 代理 (ssh -D)
          </button>
        </div>

        <div className="flex gap-2 items-end">
          <div className="w-28">
            <Label text="本地端口" />
            <Input value={localPort} onChange={setLocalPort} placeholder={type === 'local' ? '13306' : '1080'} />
          </div>
          {type === 'local' && (
            <>
              <div className="flex-1">
                <Label text="目标主机（SSH 可达的内网主机）" />
                <Input value={remoteHost} onChange={setRemoteHost} placeholder="如：10.0.0.5 或 db.internal" />
              </div>
              <div className="w-24">
                <Label text="目标端口" />
                <Input value={remotePort} onChange={setRemotePort} placeholder="3306" />
              </div>
            </>
          )}
          <Button variant="secondary" onClick={add} disabled={busy}>
            <Plus size={14} />
            {busy ? '创建中…' : '创建'}
          </Button>
        </div>

        {type === 'dynamic' && (
          <div className="text-[10px] text-[var(--text-muted)]">
            创建后把系统/浏览器代理指向 127.0.0.1:端口（SOCKS5），访问内网服务的流量将经 SSH 隧道加密传输
          </div>
        )}
        {msg && (
          <div className={`text-[11px] ${msg.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>{msg.text}</div>
        )}
      </div>

      {/* 隧道列表 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-[var(--text-secondary)] font-medium">当前隧道（{tunnels.length}）</span>
          <button onClick={() => void refresh()} title="刷新" className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)]">
            <RefreshCw size={12} />
          </button>
        </div>

        {tunnels.length === 0 && (
          <div className="text-center py-6 text-[var(--text-muted)] text-xs">
            <Route size={24} className="mx-auto mb-2 opacity-30" />
            暂无隧道，用上方表单创建
          </div>
        )}

        {tunnels.map((t) => (
          <div
            key={t.id}
            className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 px-3 py-2.5"
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs theme-text-primary truncate">
                {t.type === 'local' ? (
                  <>
                    <span className="tnum">127.0.0.1:{t.localPort}</span>
                    <span className="text-[var(--text-muted)]"> → </span>
                    <span className="tnum">
                      {t.remoteHost}:{t.remotePort}
                    </span>
                  </>
                ) : (
                  <>
                    SOCKS5 代理
                    <span className="text-[var(--text-muted)]"> · </span>
                    <span className="tnum">127.0.0.1:{t.localPort}</span>
                  </>
                )}
              </div>
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                {t.type === 'local' ? '本地转发' : '动态代理'} · 活动连接 {t.connections}
                {t.error ? ` · 错误：${t.error}` : ''}
              </div>
            </div>
            <button
              onClick={() => stop(t.id)}
              title="停止隧道"
              className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error)]/10"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
