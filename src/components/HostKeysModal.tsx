import { useEffect, useState } from 'react';
import { ShieldCheck, Trash2, X } from 'lucide-react';
import { getAPI } from '../lib/api';
import type { HostKeyEntry } from '../types';

/** 主机指纹管理：查看/删除已保存的 known_hosts 条目（删除后下次连接会重新询问） */
export default function HostKeysModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<HostKeyEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = async () => {
    const res = await getAPI().hostKeysList();
    setEntries(res.entries || []);
    setLoaded(true);
  };
  useEffect(() => {
    reload();
  }, []);

  const remove = async (host: string, port: number) => {
    await getAPI().hostKeysRemove(host, port);
    reload();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="max-w-2xl w-full mx-4 rounded-xl glass border border-[var(--border-subtle)] max-h-[70vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} style={{ color: 'var(--success)' }} />
            <span className="text-sm font-semibold">主机指纹管理</span>
            <span className="text-[11px] text-[var(--text-muted)]">known_hosts</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {!loaded && <div className="text-center text-xs text-[var(--text-muted)] py-6">加载中…</div>}
          {loaded && entries.length === 0 && (
            <div className="text-center text-xs text-[var(--text-muted)] py-6">
              暂无已保存的主机指纹。首次连接某台 SSH 主机并确认指纹后会记录在这里。
            </div>
          )}
          {entries.map((e) => (
            <div
              key={`${e.host}:${e.port}`}
              className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/50 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium theme-text-primary tnum">
                  {e.host}:{e.port}
                </div>
                <div className="text-[10px] font-mono text-[var(--text-muted)] break-all">
                  {e.keyType} · SHA256:{e.sha256}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                  信任于 {new Date(e.trustedAt).toLocaleString()}
                </div>
              </div>
              <button
                onClick={() => remove(e.host, e.port)}
                className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--error)] hover:bg-[rgba(248,113,113,0.1)] transition-colors"
                title="删除后下次连接会重新询问指纹"
              >
                <Trash2 size={12} />
                删除
              </button>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)] leading-relaxed">
          指纹用于校验 SSH 服务器身份（防中间人攻击）。若某台主机重装系统导致指纹变化，连接时会被拦截提示——
          确认是本人操作后，删除旧指纹并重新信任即可。
        </div>
      </div>
    </div>
  );
}
