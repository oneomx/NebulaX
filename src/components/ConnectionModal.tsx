import { useState, useEffect } from 'react';
import {
  Server,
  KeyRound,
  Lock,
  Globe,
  Folder,
  LogIn,
  Save,
  Check,
  X,
  Plug,
  Network,
  Usb,
  Terminal,
  Monitor,
  ScreenShare,
  RefreshCw
} from 'lucide-react';
import { useAppStore } from '../store/app';
import { getAPI } from '../lib/api';
import { connectSavedConnection } from '../lib/connect';
import Modal from './ui/Modal';
import { Label, Input } from './ui/Input';
import { Button } from './ui/Button';
import type { SavedConnection, ConnectionType } from '../types';

const COLORS = ['#22d3ee', '#8b5cf6', '#ec4899', '#34d399', '#fbbf24', '#3b82f6', '#f87171', '#a78bfa'];

/** 协议页签（对标 MobaXterm 多协议连接） */
const TYPE_TABS: { id: ConnectionType; label: string; icon: React.ReactNode; defaultPort?: number }[] = [
  { id: 'ssh', label: 'SSH', icon: <Server size={13} />, defaultPort: 22 },
  { id: 'telnet', label: 'Telnet', icon: <Network size={13} />, defaultPort: 23 },
  { id: 'serial', label: '串口', icon: <Usb size={13} /> },
  { id: 'local', label: '本地终端', icon: <Terminal size={13} /> },
  { id: 'rdp', label: 'RDP', icon: <Monitor size={13} />, defaultPort: 3389 },
  { id: 'vnc', label: 'VNC', icon: <ScreenShare size={13} />, defaultPort: 5900 }
];

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400];

export default function ConnectionModal({ onClose, edit }: { onClose: () => void; edit?: SavedConnection }) {
  const { addConnection, updateConnection, addSession, setActiveSession, updateSession, groups, addGroup } = useAppStore();
  const [type, setType] = useState<ConnectionType>(edit?.type || 'ssh');
  const [name, setName] = useState(edit?.name || '');
  const [host, setHost] = useState(edit?.host || '');
  const [port, setPort] = useState(edit?.port || 22);
  const [username, setUsername] = useState(edit?.username || '');
  const [authType, setAuthType] = useState<'password' | 'key'>(edit?.authType === 'key' ? 'key' : 'password');
  const [password, setPassword] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [group, setGroup] = useState(edit?.group || '');
  const [color, setColor] = useState(edit?.color || COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; msg: string }>(null);

  // serial
  const [serialPath, setSerialPath] = useState(edit?.serialPath || '');
  const [baudRate, setBaudRate] = useState(edit?.baudRate || 9600);
  const [dataBits, setDataBits] = useState<5 | 6 | 7 | 8>(edit?.dataBits || 8);
  const [stopBits, setStopBits] = useState<1 | 1.5 | 2>(edit?.stopBits || 1);
  const [parity, setParity] = useState<'none' | 'even' | 'odd' | 'mark' | 'space'>(edit?.parity || 'none');
  const [serialPorts, setSerialPorts] = useState<{ path: string; friendlyName?: string }[]>([]);

  // local
  const [shell, setShell] = useState(edit?.shell || '');
  const [command, setCommand] = useState(edit?.command || '');
  const [shellPresets, setShellPresets] = useState<{ id: string; label: string }[]>([]);
  const [defaultShell, setDefaultShell] = useState('powershell');

  // vnc / rdp
  const [vncViewer, setVncViewer] = useState(edit?.vncViewer || '');
  const [rdpFullscreen, setRdpFullscreen] = useState(!!edit?.rdpFullscreen);

  // ssh 高级：跳板机 + 代理
  const [advOpen, setAdvOpen] = useState(false);
  const [jumpHost, setJumpHost] = useState(edit?.jump?.host || '');
  const [jumpPort, setJumpPort] = useState(edit?.jump?.port || 22);
  const [jumpUser, setJumpUser] = useState(edit?.jump?.username || '');
  const [jumpAuthType, setJumpAuthType] = useState<'password' | 'key'>(edit?.jump?.authType || 'password');
  const [jumpPassword, setJumpPassword] = useState('');
  const [jumpKeyPath, setJumpKeyPath] = useState(edit?.jump?.privateKey || '');
  const [proxyType, setProxyType] = useState<'socks5' | 'http'>(edit?.proxy?.type || 'socks5');
  const [proxyHost, setProxyHost] = useState(edit?.proxy?.host || '');
  const [proxyPort, setProxyPort] = useState(edit?.proxy?.port || 1080);
  const [proxyUser, setProxyUser] = useState(edit?.proxy?.username || '');
  const [proxyPassword, setProxyPassword] = useState('');
  const hasJump = !!edit?.jump?.host;
  const hasProxy = !!edit?.proxy?.host;

  const isEdit = !!edit;
  const isSsh = type === 'ssh';
  const isRemoteApp = type === 'rdp' || type === 'vnc';

  // 挂载：枚举串口 + 拉取 shell 预设
  useEffect(() => {
    const api = getAPI() as any;
    if (api.termSerialPorts) {
      api.termSerialPorts().then((r: any) => {
        if (r?.ok && r.ports) setSerialPorts(r.ports);
      }).catch(() => {});
    }
    if (api.termShells) {
      api.termShells().then((r: any) => {
        if (r?.ok && r.presets) setShellPresets(r.presets);
        if (r?.ok && r.defaultShell) setDefaultShell(r.defaultShell);
      }).catch(() => {});
    }
  }, []);

  const switchType = (t: ConnectionType) => {
    setType(t);
    setTestResult(null);
    const def = TYPE_TABS.find((x) => x.id === t)?.defaultPort;
    if (def) setPort(def);
    if (t === 'local' && !shell) setShell('');
  };

  const canSave =
    type === 'serial'
      ? !!serialPath.trim()
      : type === 'local'
      ? true
      : !!host.trim();

  /** 组装跳板机配置（密码留空时编辑态用已保存值，由 vault 合并） */
  const buildJump = () => {
    if (!jumpHost.trim()) return undefined;
    return {
      host: jumpHost.trim(),
      port: jumpPort || 22,
      username: jumpUser.trim(),
      authType: jumpAuthType,
      password: jumpAuthType === 'password' ? jumpPassword : undefined,
      privateKey: jumpAuthType === 'key' ? jumpKeyPath : undefined
    };
  };

  /** 组装代理配置 */
  const buildProxy = () => {
    if (!proxyHost.trim()) return undefined;
    return {
      type: proxyType,
      host: proxyHost.trim(),
      port: proxyPort || 1080,
      username: proxyUser.trim() || undefined,
      password: proxyUser.trim() ? proxyPassword : undefined
    };
  };

  /** 保存用的元数据：剔除跳板/代理密码（只进 vault 加密存储，绝不落 localStorage） */
  const stripSecrets = <T extends { password?: string }>(c: T | undefined): T | undefined => {
    if (!c) return c;
    const { password: _pw, ...rest } = c;
    return rest as T;
  };

  const testConnection = async () => {
    if (testing || !canSave) return;
    setTesting(true);
    setTestResult(null);
    const api = getAPI() as any;
    try {
      if (isSsh) {
        const cfg: any = {
          host: host.trim(),
          port,
          username: username.trim(),
          password: authType === 'password' ? password : undefined,
          privateKey: authType === 'key' ? privateKeyPath : undefined,
          passphrase: authType === 'key' ? passphrase : undefined,
          authType,
          jump: buildJump(),
          proxy: buildProxy()
        };
        // 编辑模式：新凭据留空时用已保存凭据测试
        if (isEdit && api.vaultGet && (!password || !privateKeyPath)) {
          try {
            const r = await api.vaultGet(edit.id);
            if (r?.ok && r.secrets) {
              cfg.password = cfg.password || r.secrets.password;
              cfg.privateKey = cfg.privateKey || r.secrets.privateKey || r.secrets.privateKeyPath;
              cfg.passphrase = cfg.passphrase || r.secrets.passphrase;
            }
          } catch {
            /* 忽略 */
          }
        }
        const res = await api.sshTest(cfg);
        if (res.ok) {
          const hostname = res.info?.hostname ? `（${res.info.hostname}）` : '';
          setTestResult({ ok: true, msg: `连接成功${hostname}` });
        } else {
          setTestResult({ ok: false, msg: res.error || '连接失败' });
        }
      } else if (type === 'telnet' || type === 'serial') {
        // 快速连通性测试：连上立即断开
        const res = await api.termConnect(
          type === 'telnet'
            ? { type: 'telnet', host: host.trim(), port: port || 23 }
            : { type: 'serial', serialPath: serialPath.trim(), baudRate, dataBits, stopBits, parity }
        );
        if (res.ok && res.sessionId) {
          await api.sshDisconnect(res.sessionId);
          setTestResult({ ok: true, msg: type === 'telnet' ? 'Telnet 连接成功' : `串口 ${serialPath} 打开成功` });
        } else {
          setTestResult({ ok: false, msg: res.error || '连接失败' });
        }
      }
    } catch (e: any) {
      setTestResult({ ok: false, msg: e?.message || '连接失败' });
    } finally {
      setTesting(false);
    }
  };

  const save = async (connectNow: boolean) => {
    if (!canSave) return;
    setSaving(true);

    // 按协议组装保存元数据
    const meta: Partial<SavedConnection> = {
      name: name.trim() || (type === 'local' ? '本地终端' : host || serialPath || type.toUpperCase()),
      type,
      host: type === 'local' ? 'localhost' : host.trim(),
      port: type === 'serial' || type === 'local' ? port : port,
      username: username.trim(),
      authType,
      hasPassword: isSsh
        ? authType === 'password' && (isEdit ? password.length > 0 || !!edit?.hasPassword : password.length > 0)
        : isRemoteApp
        ? isEdit
          ? password.length > 0 || !!edit?.hasPassword
          : password.length > 0
        : false,
      hasPrivateKey: isSsh && authType === 'key' && (isEdit ? privateKeyPath.length > 0 || !!edit?.hasPrivateKey : privateKeyPath.length > 0),
      hasPassphrase: isSsh && authType === 'key' && (isEdit ? passphrase.length > 0 || !!edit?.hasPassphrase : passphrase.length > 0),
      group: group.trim() || undefined,
      color,
      serialPath: type === 'serial' ? serialPath.trim() : undefined,
      baudRate: type === 'serial' ? baudRate : undefined,
      dataBits: type === 'serial' ? dataBits : undefined,
      stopBits: type === 'serial' ? stopBits : undefined,
      parity: type === 'serial' ? parity : undefined,
      shell: type === 'local' ? shell || defaultShell : undefined,
      command: type === 'local' && shell === 'custom' ? command.trim() || undefined : undefined,
      vncViewer: type === 'vnc' ? vncViewer.trim() || undefined : undefined,
      rdpFullscreen: type === 'rdp' ? rdpFullscreen : undefined,
      jump: isSsh ? stripSecrets(buildJump()) : undefined,
      hasJumpPassword: isSsh && jumpAuthType === 'password' && (isEdit ? jumpPassword.length > 0 || !!edit?.hasJumpPassword : jumpPassword.length > 0),
      proxy: isSsh ? stripSecrets(buildProxy()) : undefined,
      hasProxyAuth: isSsh && !!proxyUser.trim() && (isEdit ? proxyPassword.length > 0 || !!edit?.hasProxyAuth : proxyPassword.length > 0)
    };

    const connId = isEdit ? edit.id : addConnection(meta as Omit<SavedConnection, 'id'>);
    if (isEdit) updateConnection(edit.id, meta);

    // 新分组名自动登记到分组列表
    if (meta.group) addGroup(meta.group);

    // 凭据：编辑时留空的字段保持原值（SSH 密钥类 + RDP/VNC 密码类）
    let mergedPassword: string | undefined;
    try {
      const api = getAPI() as any;
      if (api.vaultSet && (isSsh || isRemoteApp)) {
        let old: any = {};
        if (isEdit && api.vaultGet) {
          try {
            const r = await api.vaultGet(edit.id);
            if (r?.ok && r.secrets) old = r.secrets;
          } catch {
            /* 读旧失败则按新填值处理 */
          }
        }
        if (isSsh && authType === 'password') mergedPassword = password || old.password;
        if (isSsh && authType === 'key') mergedPassword = old.password;
        if (isRemoteApp) mergedPassword = password || old.password;
        await api.vaultSet(connId, {
          password: mergedPassword,
          privateKeyPath: isSsh && authType === 'key' ? privateKeyPath || old.privateKeyPath : undefined,
          // 编辑时未重新填写私钥内容 → 保留 vault 中原有的 privateKey，避免密钥被清空
          privateKey: isSsh && authType === 'key' && !privateKeyPath && !passphrase ? old.privateKey : undefined,
          passphrase: isSsh && authType === 'key' ? passphrase || old.passphrase : undefined,
          jumpPassword: isSsh && jumpAuthType === 'password' ? jumpPassword || old.jumpPassword : undefined,
          proxyPassword: isSsh && proxyUser.trim() ? proxyPassword || old.proxyPassword : undefined
        });
      }
    } catch {
      // vault 不可用时降级：本次会话内凭据仍在内存中可用
    }

    if (connectNow) {
      const tabId = `tab_${Date.now()}`;
      addSession({
        id: tabId,
        connectionId: connId,
        title: meta.name || host,
        host: meta.host || '',
        status: 'connecting',
        ...(isRemoteApp ? { external: { kind: type as 'rdp' | 'vnc', host: meta.host || '' } } : {})
      });
      setActiveSession(tabId);
      await connectSavedConnection({ ...(meta as SavedConnection), id: connId }, tabId);
    }
    setSaving(false);
    onClose();
  };

  const activeTab = TYPE_TABS.find((t) => t.id === type)!;

  return (
    <Modal
      title={isEdit ? '编辑连接' : '新建连接'}
      subtitle={
        isRemoteApp
          ? '通过系统程序打开（RDP 用 mstsc / VNC 用本机 viewer）'
          : type === 'local'
          ? '在本机拉起真实终端（ConPTY）'
          : '配置服务器连接信息'
      }
      icon={activeTab.icon}
      onClose={onClose}
      width="600px"
      footer={
        <>
          {testResult && (
            <div
              className={`flex-1 text-xs flex items-center gap-1.5 ${
                testResult.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'
              }`}
            >
              {testResult.ok ? <Check size={13} /> : <X size={13} />}
              {testResult.msg}
            </div>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          {(isSsh || type === 'telnet' || type === 'serial') && (
            <Button variant="secondary" onClick={testConnection} disabled={!canSave || testing}>
              <Plug size={14} />
              {testing ? '测试中…' : '测试连接'}
            </Button>
          )}
          <Button variant="secondary" onClick={() => save(false)} disabled={!canSave || saving}>
            <Save size={14} />
            仅保存
          </Button>
          <Button variant="primary" onClick={() => save(true)} disabled={!canSave || saving}>
            <LogIn size={14} />
            {isRemoteApp ? '保存并打开' : '保存并连接'}
          </Button>
        </>
      }
    >
      {/* 协议选择 */}
      <div>
        <Label text="连接协议" />
        <div className="flex flex-wrap gap-2">
          {TYPE_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => switchType(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition ${
                type === t.id
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Name + Color */}
      <div className="flex gap-3">
        <div className="flex-1">
          <Label text="连接名称" />
          <Input value={name} onChange={setName} placeholder="如：生产环境-Web-01" icon={<Server size={13} />} />
        </div>
        <div>
          <Label text="标识色" />
          <div className="flex gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                aria-label={`选择颜色 ${c}`}
                className={`w-6 h-6 rounded-md transition ${
                  color === c ? 'ring-2 ring-[var(--accent)] scale-110' : 'opacity-60 hover:opacity-100'
                }`}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ---- SSH / Telnet / RDP / VNC：主机端口 ---- */}
      {type !== 'serial' && type !== 'local' && (
        <div className="flex gap-3">
          <div className="flex-1">
            <Label text={type === 'vnc' ? 'VNC 主机' : '主机地址'} />
            <Input value={host} onChange={setHost} placeholder="IP 或域名" icon={<Globe size={13} />} />
          </div>
          <div className="w-24">
            <Label text="端口" />
            <Input value={String(port)} onChange={(v) => setPort(parseInt(v) || port)} placeholder={String(activeTab.defaultPort || '')} />
          </div>
        </div>
      )}

      {/* ---- 串口参数 ---- */}
      {type === 'serial' && (
        <>
          <div className="flex gap-3">
            <div className="flex-1">
              <Label text="串口" />
              <div className="flex gap-1.5">
                <div className="flex-1">
                  <Input
                    value={serialPath}
                    onChange={setSerialPath}
                    placeholder="如：COM3"
                    suggestions={serialPorts.map((p) => p.path)}
                  />
                </div>
                <button
                  onClick={async () => {
                    const r = await (getAPI() as any).termSerialPorts();
                    if (r?.ok && r.ports) setSerialPorts(r.ports);
                  }}
                  title="重新枚举串口"
                  className="px-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--accent)]"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {serialPorts.length > 0 && (
                <div className="mt-1 text-[10px] text-[var(--text-muted)]">
                  检测到：{serialPorts.slice(0, 4).map((p) => `${p.path}${p.friendlyName ? ` (${p.friendlyName})` : ''}`).join('、')}
                </div>
              )}
            </div>
            <div className="w-32">
              <Label text="波特率" />
              <select
                value={baudRate}
                onChange={(e) => setBaudRate(parseInt(e.target.value))}
                className="w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]/50"
              >
                {BAUD_RATES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <Label text="数据位" />
              <select
                value={dataBits}
                onChange={(e) => setDataBits(parseInt(e.target.value) as any)}
                className="w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]/50"
              >
                {[5, 6, 7, 8].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <Label text="停止位" />
              <select
                value={stopBits}
                onChange={(e) => setStopBits(parseFloat(e.target.value) as any)}
                className="w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]/50"
              >
                {[1, 1.5, 2].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <Label text="校验位" />
              <select
                value={parity}
                onChange={(e) => setParity(e.target.value as any)}
                className="w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]/50"
              >
                {['none', 'even', 'odd', 'mark', 'space'].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="text-[10px] text-[var(--text-muted)]">
            交换机/路由器 Console 口常用：9600 波特率、8 数据位、无校验、1 停止位
          </div>
        </>
      )}

      {/* ---- 本地终端 shell 选择 ---- */}
      {type === 'local' && (
        <>
          <div>
            <Label text="Shell" />
            <div className="flex flex-wrap gap-2">
              {shellPresets
                .filter((s) => !s.id || true)
                .map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setShell(s.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs transition ${
                      (shell || defaultShell) === s.id
                        ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
                        : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              <button
                onClick={() => setShell('custom')}
                className={`px-3 py-1.5 rounded-lg text-xs transition ${
                  shell === 'custom'
                    ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
                    : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                自定义命令
              </button>
            </div>
          </div>
          {shell === 'custom' && (
            <div>
              <Label text="启动命令" />
              <Input value={command} onChange={setCommand} placeholder="如：ssh root@10.0.0.1 或 python" />
            </div>
          )}
          <div className="text-[10px] text-[var(--text-muted)]">
            本地终端使用 Windows ConPTY 真实伪终端；WSL 需已安装发行版（wsl --install）
          </div>
        </>
      )}

      {/* ---- RDP 选项 ---- */}
      {type === 'rdp' && (
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={rdpFullscreen} onChange={(e) => setRdpFullscreen(e.target.checked)} />
            全屏启动（mstsc /f）
          </label>
        </div>
      )}

      {/* ---- VNC viewer 路径 ---- */}
      {type === 'vnc' && (
        <div>
          <Label text="VNC Viewer 路径（可选，留空自动探测 TightVNC/RealVNC/UltraVNC）" />
          <Input value={vncViewer} onChange={setVncViewer} placeholder="如：C:\Program Files\TightVNC\tvnviewer.exe" />
        </div>
      )}

      {/* ---- 用户名（SSH/Telnet/RDP/VNC）---- */}
      {type !== 'serial' && type !== 'local' && (
        <div className="flex gap-3">
          <div className="flex-1">
            <Label text={`用户名${isSsh ? '' : '（可选）'}`} />
            <Input
              value={username}
              onChange={setUsername}
              placeholder={isSsh ? '如：root' : '部分场景（如 RDP 自动登录）才需要'}
            />
          </div>
          <div className="flex-1">
            <Label text="分组（可选）" />
            <Input
              value={group}
              onChange={setGroup}
              placeholder="如：生产环境，可选已有分组"
              icon={<Folder size={13} />}
              suggestions={groups}
            />
          </div>
        </div>
      )}
      {type === 'local' && (
        <div>
          <Label text="分组（可选）" />
          <Input value={group} onChange={setGroup} placeholder="如：本机" icon={<Folder size={13} />} suggestions={groups} />
        </div>
      )}

      {/* ---- SSH 认证方式 ---- */}
      {isSsh && (
        <div>
          <Label text="认证方式" />
          <div className="flex gap-2">
            <AuthTab active={authType === 'password'} onClick={() => setAuthType('password')} icon={<Lock size={13} />} label="密码认证" />
            <AuthTab active={authType === 'key'} onClick={() => setAuthType('key')} icon={<KeyRound size={13} />} label="SSH 密钥" />
          </div>
        </div>
      )}

      {/* ---- SSH 认证字段 ---- */}
      {isSsh && (authType === 'password' ? (
        <div>
          <Label text="密码" />
          <Input
            value={password}
            onChange={setPassword}
            type="password"
            placeholder={isEdit && edit?.hasPassword ? '已保存，留空则保持不变' : '登录密码'}
          />
        </div>
      ) : (
        <>
          <div>
            <Label text="私钥文件路径" />
            <Input
              value={privateKeyPath}
              onChange={setPrivateKeyPath}
              placeholder={isEdit && edit?.hasPrivateKey ? '已保存，留空则保持不变' : '如：~/.ssh/id_rsa'}
            />
          </div>
          <div>
            <Label text="密钥密码（可选）" />
            <Input
              value={passphrase}
              onChange={setPassphrase}
              type="password"
              placeholder={isEdit && edit?.hasPassphrase ? '已保存，留空则保持不变' : '私钥密码'}
            />
          </div>
        </>
      ))}

      {/* ---- SSH 高级：跳板机 / 代理（可折叠）---- */}
      {isSsh && (
        <div className="rounded-lg border border-[var(--border-subtle)] overflow-hidden">
          <button
            type="button"
            onClick={() => setAdvOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <span>高级：跳板机 / 代理{hasJump ? '（已配置跳板）' : ''}{hasProxy ? '（已配置代理）' : ''}</span>
            <span className={`transition-transform ${advOpen ? 'rotate-180' : ''}`}>▾</span>
          </button>
          {advOpen && (
            <div className="px-3 pb-3 space-y-3 border-t border-[var(--border-subtle)] pt-3">
              {/* 跳板机 */}
              <div>
                <div className="text-[11px] font-medium theme-text-secondary mb-1.5">跳板机（先连跳板再转发到目标）</div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Input value={jumpHost} onChange={setJumpHost} placeholder="跳板机地址（留空不启用）" />
                  </div>
                  <div className="w-20">
                    <Input value={String(jumpPort)} onChange={(v) => setJumpPort(parseInt(v) || 22)} placeholder="22" />
                  </div>
                </div>
                {jumpHost.trim() && (
                  <div className="flex gap-2 mt-2">
                    <div className="flex-1">
                      <Input value={jumpUser} onChange={setJumpUser} placeholder="跳板机用户名" />
                    </div>
                    <div className="w-28">
                      <select
                        value={jumpAuthType}
                        onChange={(e) => setJumpAuthType(e.target.value as 'password' | 'key')}
                        className="w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-2 py-2.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]/50"
                      >
                        <option value="password">密码</option>
                        <option value="key">密钥</option>
                      </select>
                    </div>
                    {jumpAuthType === 'password' ? (
                      <div className="flex-1">
                        <Input
                          value={jumpPassword}
                          onChange={setJumpPassword}
                          type="password"
                          placeholder={isEdit && edit?.hasJumpPassword ? '已保存，留空保持' : '跳板机密码'}
                        />
                      </div>
                    ) : (
                      <div className="flex-1">
                        <Input value={jumpKeyPath} onChange={setJumpKeyPath} placeholder="如：~/.ssh/id_rsa" />
                      </div>
                    )}
                  </div>
                )}
              </div>
              {/* 代理 */}
              <div>
                <div className="text-[11px] font-medium theme-text-secondary mb-1.5">代理（连接先经代理隧道，SOCKS5/HTTP CONNECT）</div>
                <div className="flex gap-2">
                  <div className="w-28">
                    <select
                      value={proxyType}
                      onChange={(e) => setProxyType(e.target.value as 'socks5' | 'http')}
                      className="w-full rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-2 py-2.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]/50"
                    >
                      <option value="socks5">SOCKS5</option>
                      <option value="http">HTTP</option>
                    </select>
                  </div>
                  <div className="flex-1">
                    <Input value={proxyHost} onChange={setProxyHost} placeholder="代理地址（留空不启用）" />
                  </div>
                  <div className="w-20">
                    <Input value={String(proxyPort)} onChange={(v) => setProxyPort(parseInt(v) || 1080)} placeholder="1080" />
                  </div>
                </div>
                {proxyHost.trim() && proxyUser.trim() && (
                  <div className="flex gap-2 mt-2">
                    <div className="flex-1">
                      <Input value={proxyUser} onChange={setProxyUser} placeholder="代理用户名（可选）" />
                    </div>
                    <div className="flex-1">
                      <Input
                        value={proxyPassword}
                        onChange={setProxyPassword}
                        type="password"
                        placeholder={isEdit && edit?.hasProxyAuth ? '已保存，留空保持' : '代理密码'}
                      />
                    </div>
                  </div>
                )}
                {proxyHost.trim() && !proxyUser.trim() && (
                  <div className="mt-2">
                    <Input value={proxyUser} onChange={setProxyUser} placeholder="代理用户名（无认证留空）" />
                  </div>
                )}
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">
                跳板机与代理同时配置时优先走跳板机。凭据经系统加密保管库存储。
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- RDP/VNC 密码（可选，自动登录用）---- */}
      {isRemoteApp && (
        <div>
          <Label text="登录密码（可选，用于自动登录）" />
          <Input
            value={password}
            onChange={setPassword}
            type="password"
            placeholder={isEdit && edit?.hasPassword ? '已保存，留空则保持不变' : '留空则打开后手动输入'}
          />
        </div>
      )}

      {/* ---- Telnet 说明 ---- */}
      {type === 'telnet' && (
        <div className="text-[10px] text-[var(--text-muted)]">
          Telnet 为明文协议，仅建议用于内网设备调试（网络设备 Console、IoT 模块等）
        </div>
      )}
    </Modal>
  );
}

function AuthTab({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs transition ${
        active
          ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
          : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
