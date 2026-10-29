import { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { onHostKeyPromptChange, resolveHostKeyPrompt } from '../lib/hostKeyPrompt';
import type { HostKeyPrompt } from '../types';

/**
 * 主机指纹确认弹窗（TOFU）：
 * - 首次连接：展示指纹，用户信任后写入 known_hosts
 * - 指纹变更：红色高危警告，只有显式选择"仍然信任（危险）"才放行
 */
export default function HostKeyDialog() {
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null);

  useEffect(() => onHostKeyPromptChange(setPrompt), []);

  if (!prompt) return null;

  const mismatch = prompt.mismatch;
  const fp = `SHA256:${prompt.sha256}`;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.55)' }}>
      <div className="max-w-lg w-full mx-4 rounded-xl glass border p-6" style={{ borderColor: mismatch ? 'rgba(248,113,113,0.5)' : 'var(--border-subtle)' }}>
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background: mismatch ? 'rgba(248,113,113,0.12)' : 'rgba(250,204,21,0.12)',
              border: `1px solid ${mismatch ? 'rgba(248,113,113,0.4)' : 'rgba(250,204,21,0.4)'}`
            }}
          >
            {mismatch ? (
              <ShieldAlert size={20} style={{ color: '#f87171' }} />
            ) : (
              <ShieldCheck size={20} style={{ color: '#facc15' }} />
            )}
          </div>
          <div>
            <div className="text-sm font-semibold theme-text-primary">
              {mismatch ? '⚠️ 主机密钥已变更' : '确认主机指纹'}
            </div>
            <div className="text-[11px] text-[var(--text-muted)] tnum">
              {prompt.host}:{prompt.port}
            </div>
          </div>
          <button
            onClick={() => resolveHostKeyPrompt(false)}
            className="ml-auto p-1.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"
            title="取消连接"
          >
            <X size={15} />
          </button>
        </div>

        {mismatch ? (
          <div className="text-[12px] leading-relaxed text-[var(--error)] mb-3 rounded-lg border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-3 py-2.5">
            该主机此前保存的指纹与本次不符。<b>这可能意味着服务器重装了系统，也可能正在遭遇中间人攻击。</b>
            在未通过其他渠道核实前，<b>强烈建议拒绝连接</b>。
          </div>
        ) : (
          <div className="text-[12px] leading-relaxed text-[var(--text-muted)] mb-3">
            首次连接此主机。请核对以下指纹与服务器端 <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> 的输出是否一致，
            一致则信任并保存。
          </div>
        )}

        <div className="rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2.5 mb-4">
          <div className="text-[10px] text-[var(--text-muted)] mb-1">{prompt.keyType} 指纹</div>
          <div className="text-[12px] font-mono break-all theme-text-primary select-all">{fp}</div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => resolveHostKeyPrompt(false)}
            className="flex-1 py-2 rounded-lg text-xs font-medium border border-[var(--border-subtle)] theme-text-primary hover:bg-[var(--bg-elevated)] transition-colors"
          >
            拒绝连接
          </button>
          {mismatch ? (
            <button
              onClick={() => resolveHostKeyPrompt(true)}
              className="flex-1 py-2 rounded-lg text-xs font-medium transition-colors"
              style={{ background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.5)', color: '#f87171' }}
            >
              仍然信任（危险）
            </button>
          ) : (
            <button
              onClick={() => resolveHostKeyPrompt(true)}
              className="flex-1 py-2 rounded-lg text-xs font-medium theme-btn-primary"
            >
              信任并连接
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
