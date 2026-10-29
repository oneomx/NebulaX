import { useState } from 'react';
import { KeyRound, Copy, Check, Loader2, AlertTriangle, BadgeCheck, Clock, MonitorSmartphone } from 'lucide-react';
import { getAPI } from '../lib/api';
import { useAppStore } from '../store/app';
import Modal from './ui/Modal';
import { Label, Input } from './ui/Input';
import { Button } from './ui/Button';

/**
 * 许可激活弹窗（v2.0 离线激活）
 * - 试用中：显示剩余天数 + 机器码 + 激活码输入
 * - 已激活：显示许可类型/到期日 + 注销激活（换机前使用）
 * - 已到期：只读提示 + 激活码输入
 */
export default function LicenseModal({ onClose }: { onClose: () => void }) {
  const api = getAPI();
  const { licenseStatus, setLicenseStatus } = useAppStore();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<null | { ok: boolean; text: string }>(null);
  const [copied, setCopied] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  const st = licenseStatus;

  const copyMachine = async () => {
    if (!st) return;
    try {
      await navigator.clipboard.writeText(st.machineCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时忽略（机器码仍可见可手抄） */
    }
  };

  const doActivate = async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      setMsg({ ok: false, text: '请输入激活码' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.licenseActivate(trimmed);
      if (r.ok) {
        setMsg({ ok: true, text: '激活成功！全部功能已解锁' });
        if (r.state) setLicenseStatus(r.state);
        setCode('');
      } else {
        setMsg({ ok: false, text: r.error || '激活失败' });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || '激活失败' });
    } finally {
      setBusy(false);
    }
  };

  const doDeactivate = async () => {
    if (!confirm('注销后本机将回到试用状态（换机前请先注销，再在新机器激活）。确定注销？')) return;
    setDeactivating(true);
    try {
      const r = await api.licenseDeactivate();
      if (r.ok) {
        const s = await api.licenseState();
        if (s.ok && s.state) setLicenseStatus(s.state);
        setMsg({ ok: true, text: '已注销激活' });
      } else {
        setMsg({ ok: false, text: r.error || '注销失败' });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || '注销失败' });
    } finally {
      setDeactivating(false);
    }
  };

  const statusBadge = st?.status === 'activated' ? (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--success)]/15 text-[var(--success)]">
      <BadgeCheck size={13} /> 已激活
    </span>
  ) : st?.status === 'trial' ? (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--accent)]/15 text-[var(--accent)]">
      <Clock size={13} /> 试用中 · 剩余 {st.trialDaysLeft} 天
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--error)]/15 text-[var(--error)]">
      <AlertTriangle size={13} /> 已到期（只读）
    </span>
  );

  return (
    <Modal
      title="许可激活"
      subtitle="离线激活 · 一次激活长期可用"
      icon={<KeyRound size={18} />}
      onClose={onClose}
      width="540px"
    >
      {/* 当前状态 */}
      <div className="rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium theme-text-primary">当前许可</span>
          {statusBadge}
        </div>
        {st?.status === 'activated' && st.license && (
          <div className="text-xs theme-text-secondary space-y-1">
            <div>
              类型：{st.license.type === 'perpetual' ? '永久买断' : '订阅授权'}
              {st.license.type === 'subscription' && st.license.expiresAt && (
                <> · 到期 {st.license.expiresAt.slice(0, 10)}</>
              )}
            </div>
            <div>激活时间：{st.license.activatedAt.slice(0, 19).replace('T', ' ')}</div>
          </div>
        )}
        {st?.status === 'expired' && (
          <div className="text-xs text-[var(--error)]">
            试用期已结束，当前为只读模式：可查看已保存的主机与历史数据，新建连接、终端会话与 AI 功能已锁定。输入激活码即可恢复全部功能。
          </div>
        )}
        {/* 机器码 */}
        <div>
          <Label text="本机机器码（发给厂商换取激活码）" />
          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-lg bg-[var(--bg-base)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm font-mono theme-text-primary break-all">
              {st?.machineCode || '...'}
            </div>
            <button
              onClick={copyMachine}
              title="复制机器码"
              className="shrink-0 p-2.5 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition-colors"
            >
              {copied ? <Check size={15} className="text-[var(--success)]" /> : <Copy size={15} />}
            </button>
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--text-muted)] flex items-center gap-1">
            <MonitorSmartphone size={11} /> 机器码与本机硬件绑定，激活码仅对这台机器有效
          </div>
        </div>
      </div>

      {/* 激活码输入（已激活时也可输入新码续费/换码） */}
      <div className="space-y-2">
        <Label text={st?.status === 'activated' ? '输入新激活码（续费 / 换码）' : '输入激活码'} />
        <Input
          value={code}
          onChange={setCode}
          placeholder="NBX1-XXXXX-XXXXX-...（完整复制粘贴）"
          disabled={busy}
        />
        {msg && (
          <div className={`text-xs ${msg.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>{msg.text}</div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button onClick={doActivate} disabled={busy || !code.trim()} variant="primary">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            {busy ? '验证中...' : '激活'}
          </Button>
          {st?.status === 'activated' && (
            <button
              onClick={doDeactivate}
              disabled={deactivating}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--error)] transition-colors px-2 py-1.5"
            >
              {deactivating ? '注销中...' : '注销激活（换机前使用）'}
            </button>
          )}
        </div>
      </div>

      <div className="text-[11px] text-[var(--text-muted)] leading-relaxed border-t border-[var(--border-subtle)] pt-3">
        试用期 14 天全功能体验。激活码通过机器码一对一签发，请将上方机器码提供给厂商获取。
        换电脑时先在本机「注销激活」，再到新机器输入同一激活码。
      </div>
    </Modal>
  );
}
