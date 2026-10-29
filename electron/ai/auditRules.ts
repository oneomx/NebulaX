/**
 * 安全审计本地规则引擎 — 确定性检查，压降 AI 误报
 *
 * 设计（v1.8）：
 * 1. 采集文本按 AUDIT_SECTION 分段，逐段跑确定性规则 → checks（通过/风险/跳过）+ findings
 * 2. AI 只负责语义归纳与规则外发现；其 evidence 必须逐字来自原文（verifyEvidence），否则剔除
 * 3. 评分由 findings 确定性计算（computeScore），可复现、可单测
 * 4. 白名单/常见正常形态显式排除（标准 SUID、644 passwd、127.0.0.1 监听、sticky /tmp 等）→ 减少误报
 *
 * 所有函数均为纯函数，可在无网络/无 Electron 环境下单测。
 */

export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AuditCheck {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

export interface RuleFinding {
  severity: AuditSeverity;
  category: string;
  title: string;
  description: string;
  evidence: string;
  remediation: string;
  command?: string;
  source: 'rule';
}

export interface RuleRunResult {
  checks: AuditCheck[];
  findings: RuleFinding[];
}

/* ---------------- section 解析 ---------------- */

/** 从采集文本中解析 `=== AUDIT_SECTION: NAME ===` 分段；无 section 返回空对象 */
export function parseAuditSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const re = /=== AUDIT_SECTION: (\w+) ===\r?\n([\s\S]*?)(?=\r?\n?=== AUDIT_SECTION:|\r?\n?=== AUDIT_END ===|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    sections[m[1]] = (m[2] || '').trim();
  }
  return sections;
}

/* ---------------- 通用工具 ---------------- */

const SEV_ORDER: Record<AuditSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function sortFindings<T extends { severity: AuditSeverity }>(list: T[]): T[] {
  return [...list].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

/** 确定性评分：按严重度线性扣分，封底 0 */
export function computeScore(findings: Array<{ severity: AuditSeverity }>): number {
  const COST: Record<AuditSeverity, number> = { critical: 25, high: 15, medium: 8, low: 3, info: 1 };
  const total = findings.reduce((sum, f) => sum + (COST[f.severity] ?? 0), 0);
  return Math.max(0, 100 - total);
}

/**
 * AI 发现的证据校验：evidence 必须能在原文中逐字找到（忽略空白差异）。
 * 找不到 = AI 转述/编造 → 调用方应剔除（误报主源之一）。
 */
export function verifyEvidence(evidence: string, content: string): boolean {
  if (!evidence || !evidence.trim()) return false;
  const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/^["'`]+|["'`]+$/g, '').trim().toLowerCase();
  const nContent = norm(content);
  const pieces = evidence
    .split(/\n|…|\.\.\./)
    .map((p) => norm(p))
    .filter((p) => p.length >= 8);
  if (!pieces.length) return false;
  return pieces.some((p) => nContent.includes(p));
}

/* ---------------- 规则实现 ---------------- */

/** 发行版标准 SUID 程序白名单（按 basename 匹配）——经典误报源，必须排除 */
const SAFE_SUID_BASENAMES = new Set([
  'sudo', 'su', 'passwd', 'chsh', 'chfn', 'newgrp', 'gpasswd',
  'mount', 'umount', 'fusermount', 'fusermount3', 'ntfs-3c',
  'crontab', 'at', 'unix_chkpwd', 'pkexec', 'chage', 'expiry',
  'newuidmap', 'newgidmap', 'ssh-keysign', 'ksu', 'wall', 'write',
  'locate', 'mlocate', 'plocate', 'bsd-write',
  'dbus-daemon-launch-helper', 'polkit-agent-helper-1',
  'ssh-agent', // 部分发行版
]);

/** 绑定非本地地址即视为风险的高危服务端口 */
const DANGER_PORTS: Record<number, { name: string; severity: AuditSeverity }> = {
  21: { name: 'FTP', severity: 'high' },
  23: { name: 'Telnet', severity: 'high' },
  25: { name: 'SMTP', severity: 'medium' },
  110: { name: 'POP3', severity: 'medium' },
  143: { name: 'IMAP', severity: 'medium' },
  389: { name: 'LDAP', severity: 'medium' },
  445: { name: 'SMB', severity: 'high' },
  1433: { name: 'MSSQL', severity: 'high' },
  2375: { name: 'Docker API(无TLS)', severity: 'critical' },
  3306: { name: 'MySQL', severity: 'high' },
  3389: { name: 'RDP', severity: 'high' },
  5432: { name: 'PostgreSQL', severity: 'high' },
  5900: { name: 'VNC', severity: 'high' },
  6379: { name: 'Redis', severity: 'high' },
  6380: { name: 'Redis', severity: 'high' },
  9200: { name: 'Elasticsearch', severity: 'high' },
  11211: { name: 'Memcached', severity: 'high' },
  27017: { name: 'MongoDB', severity: 'high' },
};

/** 本地回环地址判定（本地监听不算暴露） */
function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.') || addr === '[::1]';
}

const push = (list: AuditCheck[], c: AuditCheck) => list.push(c);

/* ---- SSH 配置 ---- */

function ruleSshConfig(text: string | undefined, checks: AuditCheck[], findings: RuleFinding[]): void {
  if (text === undefined) {
    push(checks, { id: 'sshd_config', name: 'sshd 安全配置', status: 'skip', detail: '未采集到该段' });
    return;
  }
  if (!text || /无 \/etc\/ssh\/sshd_config 访问权限/.test(text)) {
    push(checks, { id: 'sshd_config', name: 'sshd 安全配置', status: 'skip', detail: '无 sshd_config 读取权限' });
    return;
  }

  const pick = (key: string): string | null => {
    const m = text.match(new RegExp(`^${key}\\s+(\\S+)`, 'm'));
    return m ? m[1].toLowerCase() : null;
  };

  // PermitRootLogin
  const plr = pick('PermitRootLogin');
  if (plr === null) {
    push(checks, { id: 'sshd_permit_root', name: 'SSH root 直登', status: 'skip', detail: '未显式配置（多为默认 prohibit-password）' });
  } else if (plr === 'yes') {
    push(checks, { id: 'sshd_permit_root', name: 'SSH root 直登', status: 'fail', detail: 'PermitRootLogin yes' });
    findings.push({
      severity: 'high', category: 'SSH', source: 'rule',
      title: 'SSH 允许 root 直接登录',
      description: 'PermitRootLogin yes 使暴力破解只需猜测 root 密码，且失败日志难以定位到具体操作人。建议改为 prohibit-password 或 no，用普通用户 + sudo。',
      evidence: text.split('\n').find((l) => /^PermitRootLogin\b/.test(l)) || `PermitRootLogin ${plr}`,
      remediation: '改用密钥登录普通用户，禁止 root 直登。',
      command: "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && systemctl reload sshd"
    });
  } else {
    push(checks, { id: 'sshd_permit_root', name: 'SSH root 直登', status: 'pass', detail: `PermitRootLogin ${plr}` });
  }

  // PermitEmptyPasswords
  const pep = pick('PermitEmptyPasswords');
  if (pep === null) {
    push(checks, { id: 'sshd_empty_pw', name: 'SSH 空密码登录', status: 'skip', detail: '未显式配置（默认 no）' });
  } else if (pep === 'yes') {
    push(checks, { id: 'sshd_empty_pw', name: 'SSH 空密码登录', status: 'fail', detail: 'PermitEmptyPasswords yes' });
    findings.push({
      severity: 'critical', category: 'SSH', source: 'rule',
      title: 'SSH 允许空密码登录',
      description: 'PermitEmptyPasswords yes 允许无密码账户直接登录，等同于对网络开放无认证入口。',
      evidence: text.split('\n').find((l) => /^PermitEmptyPasswords\b/.test(l)) || 'PermitEmptyPasswords yes',
      remediation: '立即关闭空密码登录。',
      command: "sed -i 's/^#\\?PermitEmptyPasswords.*/PermitEmptyPasswords no/' /etc/ssh/sshd_config && systemctl reload sshd"
    });
  } else {
    push(checks, { id: 'sshd_empty_pw', name: 'SSH 空密码登录', status: 'pass', detail: 'PermitEmptyPasswords no' });
  }

  // PasswordAuthentication（yes 不是漏洞本身，只降级提示，避免误报）
  const pwa = pick('PasswordAuthentication');
  if (pwa === null) {
    push(checks, { id: 'sshd_password_auth', name: 'SSH 密码认证', status: 'skip', detail: '未显式配置' });
  } else if (pwa === 'yes') {
    push(checks, { id: 'sshd_password_auth', name: 'SSH 密码认证', status: 'pass', detail: 'PasswordAuthentication yes（可用，建议配合 fail2ban）' });
  } else {
    push(checks, { id: 'sshd_password_auth', name: 'SSH 密码认证', status: 'pass', detail: `PasswordAuthentication ${pwa}` });
  }

  // PubkeyAuthentication 关闭 → 提示（只允许密码，属可用性/策略提示）
  const pka = pick('PubkeyAuthentication');
  if (pka === 'no') {
    push(checks, { id: 'sshd_pubkey', name: 'SSH 公钥认证', status: 'fail', detail: 'PubkeyAuthentication no' });
    findings.push({
      severity: 'info', category: 'SSH', source: 'rule',
      title: 'SSH 已禁用公钥认证',
      description: 'PubkeyAuthentication no 时只能密码登录，无法使用密钥审计溯源，建议启用密钥登录并禁用密码认证。',
      evidence: 'PubkeyAuthentication no',
      remediation: '启用公钥认证，逐步过渡到仅密钥登录。',
      command: "sed -i 's/^#\\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config && systemctl reload sshd"
    });
  } else {
    push(checks, { id: 'sshd_pubkey', name: 'SSH 公钥认证', status: pka === null ? 'skip' : 'pass', detail: pka ? `PubkeyAuthentication ${pka}` : '未显式配置（默认 yes）' });
  }
}

/* ---- SUID ---- */

function ruleSuid(text: string | undefined, checks: AuditCheck[], findings: RuleFinding[]): void {
  if (text === undefined) {
    push(checks, { id: 'suid', name: 'SUID 程序', status: 'skip', detail: '未采集到该段' });
    return;
  }
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
  if (!lines.length) {
    push(checks, { id: 'suid', name: 'SUID 程序', status: 'pass', detail: '未发现 SUID 文件（或无搜索权限）' });
    return;
  }
  const risky = lines.filter((p) => {
    const base = p.split('/').pop() || '';
    // 白名单 +常见 helper 目录（lib/openssh、libexec/polkit、lib/dbus 等）
    if (SAFE_SUID_BASENAMES.has(base)) return false;
    if (/^\/(usr\/)?lib(64)?\/.*(ssh-keysign|polkit-agent-helper|dbus-daemon-launch-helper|openssh)/.test(p)) return false;
    if (/^\/snap\//.test(p)) return false;
    return true;
  });
  if (!risky.length) {
    push(checks, { id: 'suid', name: 'SUID 程序', status: 'pass', detail: `${lines.length} 个 SUID 均为发行版标准程序` });
    return;
  }
  push(checks, { id: 'suid', name: 'SUID 程序', status: 'fail', detail: `${risky.length}/${lines.length} 个非标准 SUID` });
  findings.push({
    severity: 'high', category: '权限', source: 'rule',
    title: `发现 ${risky.length} 个非标准 SUID 程序`,
    description: 'SUID 程序以 root 权限执行，非白名单程序若存在提权漏洞（如历史上的 pkexec/ sudo 漏洞）可直接获取 root。请确认这些程序确有 SUID 必要，否则去除位。',
    evidence: risky.slice(0, 10).join('\n') + (risky.length > 10 ? `\n... 共 ${risky.length} 个` : ''),
    remediation: '逐个确认业务必要性；无需 SUID 的程序执行 chmod u-s 去除。',
    command: `chmod u-s ${risky[0]}   # 确认无用后逐个去除`
  });
}

/* ---- 全局可写目录 ---- */

function ruleWorldWritable(text: string | undefined, checks: AuditCheck[], findings: RuleFinding[]): void {
  if (text === undefined) {
    push(checks, { id: 'world_writable', name: '全局可写目录', status: 'skip', detail: '未采集到该段' });
    return;
  }
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
  // sticky 位公共目录（/tmp、/dev/shm 等）是 Unix标准形态，不算风险 → 误报排除
  const risky = lines.filter((p) => !/\/(tmp|shm)(\/|$)/.test(p) && !p.startsWith('/var/tmp'));
  if (!risky.length) {
    push(checks, { id: 'world_writable', name: '全局可写目录', status: 'pass', detail: lines.length ? '仅 sticky 公共目录（正常）' : '未发现' });
    return;
  }
  push(checks, { id: 'world_writable', name: '全局可写目录', status: 'fail', detail: `${risky.length} 个非 sticky 全局可写目录` });
  findings.push({
    severity: 'medium', category: '权限', source: 'rule',
    title: `发现 ${risky.length} 个全局可写目录`,
    description: '非 sticky 的全局可写目录允许任意用户植入/替换文件，若其中含脚本、配置或库文件可被用于提权或持久化。',
    evidence: risky.slice(0, 10).join('\n'),
    remediation: '收回全局写权限（chmod o-w），或为目录加 sticky 位（chmod +t）。',
    command: `chmod o-w ${risky[0]}`
  });
}

/* ---- 敏感文件权限 ---- */

function ruleSensitiveFiles(text: string | undefined, checks: AuditCheck[], findings: RuleFinding[]): void {
  if (text === undefined) {
    push(checks, { id: 'sensitive_files', name: '敏感文件权限', status: 'skip', detail: '未采集到该段' });
    return;
  }
  const re = /^--- (\S+) \(permission: ([^)]+)\) ---/gm;
  const files: Array<{ path: string; perm: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) files.push({ path: m[1], perm: m[2].trim() });

  if (!files.length) {
    push(checks, { id: 'sensitive_files', name: '敏感文件权限', status: 'skip', detail: '未解析到文件权限信息' });
    return;
  }

  const mode3 = (raw: string): string | null => {
    const mm = raw.match(/(\d{3,4})/);
    if (!mm) return null;
    return mm[1].slice(-3);
  };
  const otherWritable = (m3: string): boolean => (parseInt(m3[2], 8) & 2) !== 0;
  const otherReadable = (m3: string): boolean => (parseInt(m3[2], 8) & 4) !== 0;
  const groupWritable = (m3: string): boolean => (parseInt(m3[1], 8) & 2) !== 0;

  for (const f of files) {
    const m3 = mode3(f.perm);
    const evidence = `--- ${f.path} (permission: ${f.perm}) ---`;

    if (f.path === '/etc/shadow') {
      if (!m3) {
        push(checks, { id: 'shadow_perm', name: '/etc/shadow 权限', status: 'skip', detail: '无法读取权限' });
      } else if (otherReadable(m3) || otherWritable(m3)) {
        push(checks, { id: 'shadow_perm', name: '/etc/shadow 权限', status: 'fail', detail: `权限 ${f.perm}` });
        findings.push({
          severity: 'high', category: '权限', source: 'rule',
          title: '/etc/shadow 对其他人可读',
          description: '口令哈希文件若允许 other 读取，任何本地用户可离线暴力破解口令。标准权限应为 640 root:shadow（或 600）。',
          evidence,
          remediation: '立即收紧权限并检查是否已被读取。',
          command: 'chmod 640 /etc/shadow && chown root:shadow /etc/shadow'
        });
      } else {
        push(checks, { id: 'shadow_perm', name: '/etc/shadow 权限', status: 'pass', detail: `权限 ${f.perm}` });
      }
      continue;
    }

    if (f.path === '/etc/sudoers') {
      if (!m3) {
        push(checks, { id: 'sudoers_perm', name: '/etc/sudoers 权限', status: 'skip', detail: '无法读取权限' });
      } else if (m3 !== '440' && m3 !== '600') {
        push(checks, { id: 'sudoers_perm', name: '/etc/sudoers 权限', status: 'fail', detail: `权限 ${f.perm}（应为 440）` });
        findings.push({
          severity: 'high', category: '权限', source: 'rule',
          title: '/etc/sudoers 权限过宽',
          description: 'sudoers 可被普通用户写入即可直接提权（如追加 ALL=(ALL) NOPASSWD: ALL）。标准权限为 440 root:root。',
          evidence,
          remediation: '恢复 sudoers 为只读（440），用 visudo 编辑。',
          command: 'chmod 440 /etc/sudoers'
        });
      } else {
        push(checks, { id: 'sudoers_perm', name: '/etc/sudoers 权限', status: 'pass', detail: `权限 ${f.perm}` });
      }
      continue;
    }

    if (f.path === '/root/.ssh/authorized_keys') {
      if (!m3) {
        push(checks, { id: 'authorized_keys_perm', name: 'authorized_keys 权限', status: 'skip', detail: '文件不存在或无法读取' });
      } else if (otherWritable(m3) || groupWritable(m3)) {
        push(checks, { id: 'authorized_keys_perm', name: 'authorized_keys 权限', status: 'fail', detail: `权限 ${f.perm}` });
        findings.push({
          severity: 'high', category: '权限', source: 'rule',
          title: 'authorized_keys 可被他人写入',
          description: 'authorized_keys 若组/其他人可写，攻击者可植入自己的公钥直接登录 root。标准权限 600。',
          evidence,
          remediation: '收紧权限并检查是否已有异常公钥。',
          command: 'chmod 600 /root/.ssh/authorized_keys'
        });
      } else {
        push(checks, { id: 'authorized_keys_perm', name: 'authorized_keys 权限', status: 'pass', detail: `权限 ${f.perm}` });
      }
      continue;
    }

    if (f.path === '/etc/passwd') {
      // 644 可读是 Unix 标准设计 —— 绝不报警（经典误报点）
      if (m3 && otherWritable(m3)) {
        push(checks, { id: 'passwd_perm', name: '/etc/passwd 权限', status: 'fail', detail: `权限 ${f.perm}` });
        findings.push({
          severity: 'critical', category: '权限', source: 'rule',
          title: '/etc/passwd 可被任意用户写入',
          description: '可写 passwd 文件即可任意增删用户/改 shell，等同于直接提权。标准权限 644（可读不可写）。',
          evidence,
          remediation: '立即恢复只读。',
          command: 'chmod 644 /etc/passwd && chown root:root /etc/passwd'
        });
      } else {
        push(checks, { id: 'passwd_perm', name: '/etc/passwd 权限', status: 'pass', detail: `权限 ${f.perm}（644 可读属正常）` });
      }
      continue;
    }
  }
}

/* ---- 开放端口 ---- */

function ruleOpenPorts(text: string | undefined, checks: AuditCheck[], findings: RuleFinding[]): void {
  if (text === undefined) {
    push(checks, { id: 'open_ports', name: '高危端口暴露', status: 'skip', detail: '未采集到该段' });
    return;
  }
  const lines = text.split('\n').filter((l) => /LISTEN/.test(l));
  if (!lines.length) {
    push(checks, { id: 'open_ports', name: '高危端口暴露', status: 'skip', detail: '未解析到监听端口（ss 不可用或无监听）' });
    return;
  }

  let localOnly = 0;
  let knownSafe = 0;
  const risky: Array<{ line: string; port: number; addr: string; info: (typeof DANGER_PORTS)[number] }> = [];

  for (const line of lines) {
    // 形如：LISTEN 0 128 0.0.0.0:6379 0.0.0.0:* users:(("redis-server",...
    const m = line.match(/(\[[0-9a-f:]+\]|[0-9.]+):(\d+)\s/);
    if (!m) continue;
    const addr = m[1].replace(/^\[|\]$/g, '');
    const port = parseInt(m[2], 10);
    const info = DANGER_PORTS[port];
    if (!info) {
      if (port === 22 || port === 80 || port === 443 || port === 8080) knownSafe++;
      continue;
    }
    if (isLoopback(addr)) {
      localOnly++;
      continue;
    }
    risky.push({ line: line.trim(), port, addr, info });
  }

  if (!risky.length) {
    push(checks, {
      id: 'open_ports', name: '高危端口暴露', status: 'pass',
      detail: `${lines.length} 个监听中${localOnly ? `，${localOnly} 个高危端口仅本地监听` : ''}${knownSafe ? `，常规端口 ${knownSafe} 个` : ''}`
    });
    return;
  }

  push(checks, { id: 'open_ports', name: '高危端口暴露', status: 'fail', detail: `${risky.length} 个高危端口对非本地地址监听` });
  for (const r of risky.slice(0, 8)) {
    findings.push({
      severity: r.info.severity, category: '网络', source: 'rule',
      title: `${r.info.name} (${r.port}) 对外开放`,
      description: `${r.info.name} 监听在 ${r.addr}:${r.port}（非回环地址）。${r.info.severity === 'critical' ? '该服务通常无认证或认证薄弱，暴露公网极易被直接利用。' : '若非业务必需，应限制为内网/回环访问或加防火墙策略。'}`,
      evidence: r.line,
      remediation: '绑定内网/回环地址，或用防火墙限制来源 IP；数据库类服务不应直接对外。',
      command: r.info.name.startsWith('Docker')
        ? 'ufw deny 2375/tcp   # Docker API 必须走 TLS(2376)'
        : `ufw deny ${r.port}/tcp   # 或修改服务 bind 地址为 127.0.0.1`
    });
  }
}

/* ---- sudo 规则 ---- */

function ruleSudo(text: string | undefined, checks: AuditCheck[], findings: RuleFinding[]): void {
  if (text === undefined) {
    push(checks, { id: 'sudo_rules', name: 'sudo 配置', status: 'skip', detail: '未采集到该段' });
    return;
  }
  if (/无 sudo 权限/.test(text) || !text.trim()) {
    push(checks, { id: 'sudo_rules', name: 'sudo 配置', status: 'skip', detail: '当前用户无 sudo 权限' });
    return;
  }
  const lines = text.split('\n');
  const nopassAll = lines.find((l) => /NOPASSWD:\s*ALL\b/.test(l));
  const noAuth = lines.find((l) => /!authenticate/.test(l));
  const nopassCmd = lines.filter((l) => /NOPASSWD:/.test(l) && !/NOPASSWD:\s*ALL\b/.test(l));

  if (nopassAll) {
    push(checks, { id: 'sudo_rules', name: 'sudo 配置', status: 'fail', detail: '存在 NOPASSWD: ALL 免密全权规则' });
    findings.push({
      severity: 'medium', category: '权限', source: 'rule',
      title: 'sudo 免密全权（NOPASSWD: ALL）',
      description: '该规则使任何拿到该用户会话的攻击者无需口令即可以 root 执行任意命令（键盘记录/恶意进程可直接利用）。若为自动化需要，建议收窄到具体命令。',
      evidence: nopassAll.trim(),
      remediation: '为自动化场景限定具体命令，移除 ALL。',
      command: 'visudo   # 将 NOPASSWD: ALL 收窄为具体命令列表'
    });
  } else if (noAuth) {
    push(checks, { id: 'sudo_rules', name: 'sudo 配置', status: 'fail', detail: '存在 !authenticate 规则' });
    findings.push({
      severity: 'high', category: '权限', source: 'rule',
      title: 'sudo 配置禁用了认证（!authenticate）',
      description: '!authenticate 跳过口令校验，效果等同免密提权。',
      evidence: noAuth.trim(),
      remediation: '移除 !authenticate，恢复口令认证。',
      command: 'visudo   # 删除 !authenticate 选项'
    });
  } else if (nopassCmd.length) {
    push(checks, { id: 'sudo_rules', name: 'sudo 配置', status: 'pass', detail: `${nopassCmd.length} 条限定命令的 NOPASSWD（常见运维配置）` });
  } else {
    push(checks, { id: 'sudo_rules', name: 'sudo 配置', status: 'pass', detail: 'sudo 规则均需口令认证' });
  }
}

/* ---- 附加采集段（v1.8 细化）---- */

function ruleDockerSocket(text: string | undefined, checks: AuditCheck[], findings: RuleFinding[]): void {
  if (text === undefined) {
    push(checks, { id: 'docker_socket', name: 'Docker socket', status: 'skip', detail: '未采集到该段' });
    return;
  }
  if (/none/.test(text) || !text.trim()) {
    push(checks, { id: 'docker_socket', name: 'Docker socket', status: 'pass', detail: '不存在 docker.sock' });
    return;
  }
  const m = text.match(/(\d{3,4})\s+(\S+)/);
  if (!m) {
    push(checks, { id: 'docker_socket', name: 'Docker socket', status: 'skip', detail: '无法解析权限' });
    return;
  }
  const mode = m[1].slice(-3);
  const otherWrite = (parseInt(mode[2], 8) & 2) !== 0;
  const groupWrite = (parseInt(mode[1], 8) & 2) !== 0 && !/^\s*(root|docker)\s*:\s*(root|docker)\s*$/m.test(text) && !/ root:root| root:docker| docker:docker/.test(text);
  if (otherWrite || (groupWrite && !/root:/.test(m[2]))) {
    push(checks, { id: 'docker_socket', name: 'Docker socket', status: 'fail', detail: `权限 ${m[1]} ${m[2]}` });
    findings.push({
      severity: 'high', category: '权限', source: 'rule',
      title: 'docker.sock 可被非特权用户访问',
      description: '控制 Docker socket 等价于 root 权限（可挂载宿主机根目录启动容器）。仅 root/docker 组可访问是标准配置。',
      evidence: text.trim().split('\n')[0],
      remediation: '将 socket 权限收紧为 root:docker 660，非运维用户移出 docker 组。',
      command: 'chmod 660 /var/run/docker.sock && chown root:docker /var/run/docker.sock'
    });
  } else {
    push(checks, { id: 'docker_socket', name: 'Docker socket', status: 'pass', detail: `权限 ${m[1]} ${m[2]}` });
  }
}

function ruleAuthPolicy(text: string | undefined, checks: AuditCheck[], findings: RuleFinding[]): void {
  if (text === undefined) {
    push(checks, { id: 'pass_policy', name: '口令有效期策略', status: 'skip', detail: '未采集到该段' });
    return;
  }
  const m = text.match(/PASS_MAX_DAYS\s+(\d+)/);
  if (!m) {
    push(checks, { id: 'pass_policy', name: '口令有效期策略', status: 'skip', detail: 'login.defs 未配置 PASS_MAX_DAYS' });
    return;
  }
  const days = parseInt(m[1], 10);
  if (days <= 0 || days > 90) {
    push(checks, { id: 'pass_policy', name: '口令有效期策略', status: 'fail', detail: `PASS_MAX_DAYS=${days}` });
    findings.push({
      severity: 'low', category: '密码安全', source: 'rule',
      title: '口令有效期过长或不过期',
      description: `PASS_MAX_DAYS=${days}${days <= 0 ? '（0 表示永不过期）' : ''}，超过 90 天的口令策略难以约束泄露口令的生命周期。等保/ISO 27001 通常要求 ≤ 90 天。`,
      evidence: `PASS_MAX_DAYS ${days}`,
      remediation: '将口令有效期设为 90 天内。',
      command: 'sed -i "s/^PASS_MAX_DAYS.*/PASS_MAX_DAYS 90/" /etc/login.defs'
    });
  } else {
    push(checks, { id: 'pass_policy', name: '口令有效期策略', status: 'pass', detail: `PASS_MAX_DAYS=${days}` });
  }
}

function ruleFail2ban(text: string | undefined, checks: AuditCheck[], findings: RuleFinding[]): void {
  if (text === undefined) {
    push(checks, { id: 'fail2ban', name: '防爆破（fail2ban）', status: 'skip', detail: '未采集到该段' });
    return;
  }
  if (/^active/.test(text.trim())) {
    push(checks, { id: 'fail2ban', name: '防爆破（fail2ban）', status: 'pass', detail: 'fail2ban 运行中' });
    return;
  }
  push(checks, { id: 'fail2ban', name: '防爆破（fail2ban）', status: 'fail', detail: 'fail2ban 未运行' });
  findings.push({
    severity: 'low', category: '网络', source: 'rule',
    title: '未启用 fail2ban 防爆破',
    description: 'SSH 对外开放且无自动封禁机制时，弱口令会持续遭受暴力尝试。fail2ban 可按日志自动封禁来源 IP。',
    evidence: `fail2ban: ${text.trim().split('\n')[0] || 'inactive'}`,
    remediation: '安装并启用 fail2ban，配置 sshd jail。',
    command: 'apt-get install -y fail2ban && systemctl enable --now fail2ban'
  });
}

/* ---- 通用机密/危险模式（对任意粘贴内容生效；pass 不登记，仅 fail 报告）---- */

function ruleGeneric(content: string, checks: AuditCheck[], findings: RuleFinding[]): void {
  const lineOf = (re: RegExp): string | null => {
    const m = content.match(re);
    if (!m) return null;
    const idx = content.indexOf(m[0]);
    const start = content.lastIndexOf('\n', idx) + 1;
    const end = content.indexOf('\n', idx);
    return content.slice(start, end < 0 ? undefined : end).trim();
  };

  // 私钥块
  const pk = lineOf(/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/);
  if (pk) {
    push(checks, { id: 'generic_private_key', name: '私钥泄漏', status: 'fail' });
    findings.push({
      severity: 'critical', category: '密码安全', source: 'rule',
      title: '内容中包含私钥',
      description: '私钥出现在配置/日志/终端输出中意味着凭据已随内容流转（日志采集、AI 分析、工单系统均会二次扩散）。应立即确认是否为真实私钥并轮换。',
      evidence: pk,
      remediation: '从内容中移除私钥，若已泄露立即在服务器 authorized_keys 中吊销并重新生成。',
      command: 'ssh-keygen -y -f /path/to/key   # 确认是否真实私钥后立即轮换'
    });
  }

  // AWS AccessKey
  const aws = lineOf(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/);
  if (aws) {
    push(checks, { id: 'generic_aws_key', name: '云 AccessKey 泄漏', status: 'fail' });
    findings.push({
      severity: 'critical', category: '密码安全', source: 'rule',
      title: '疑似 AWS AccessKey ID',
      description: '内容包含形如 AKIA/ASIA 的 16 位 AccessKey ID。若伴随 secret key 泄露可直接操作云资源，务必在 IAM 中轮换。',
      evidence: aws,
      remediation: '在 AWS IAM 中禁用并轮换该 AccessKey，检查 CloudTrail 异常操作。',
      command: 'aws iam update-access-key --user-name <user> --access-key-id <AKIA...> --status Inactive'
    });
  }

  // 明文密码赋值（排除占位符/变量插值，减少误报）
  const pwLine = content.split('\n').find((l) => {
    if (/(password|passwd|pwd)\s*[:=]/i.test(l)) {
      const v = l.replace(/.*(?:password|passwd|pwd)\s*[:=]\s*/i, '').trim().replace(/^["']|["']$/g, '');
      if (!v) return false;
      if (/^(x+|\*+|nologin|false|<.*>|\$\{.*\}|%s|\?+|your[_-].*|example.*|change[_-]?me|password|passwd|secret|123456.*|test.*|dummy.*|null|none)$/i.test(v)) return false;
      if (v.includes('$(') || v.startsWith('$')) return false;
      return v.length >= 6;
    }
    return false;
  });
  if (pwLine) {
    push(checks, { id: 'generic_plaintext_pw', name: '明文口令', status: 'fail' });
    findings.push({
      severity: 'high', category: '密码安全', source: 'rule',
      title: '疑似明文口令硬编码',
      description: '配置/脚本中出现非占位符的明文口令赋值。此类值会随仓库、日志、AI 分析扩散，应改用密钥管理或环境变量注入。',
      evidence: pwLine.trim().slice(0, 200),
      remediation: '改用 secrets 管理（vault/环境变量），并轮换该口令。',
      command: 'grep -rn --include="*" -iE "(password|passwd)\\s*[:=]" .   # 定位所有硬编码点'
    });
  }

  // curl | sh
  const pipe = lineOf(/\b(?:curl|wget)\b[^|;\n]*\|\s*(?:ba|z|k|da)?sh\b/);
  if (pipe) {
    push(checks, { id: 'generic_pipe_shell', name: '远程脚本直灌 shell', status: 'fail' });
    findings.push({
      severity: 'medium', category: '脚本', source: 'rule',
      title: '远程脚本直接管道执行',
      description: '`curl | sh` 在脚本执行瞬间内容不可审计，上游被篡改或 DNS 劫持即在本机执行任意代码。应先下载、审阅再执行。',
      evidence: pipe,
      remediation: '下载脚本人工审阅后执行，或校验 checksum/签名。',
      command: 'curl -fsSL <url> -o /tmp/install.sh && less /tmp/install.sh'
    });
  }

  // chmod 777
  const c777 = lineOf(/\bchmod\s+(?:-[rR]\s+)?0?777\b/);
  if (c777) {
    push(checks, { id: 'generic_chmod777', name: 'chmod 777', status: 'fail' });
    findings.push({
      severity: 'medium', category: '权限', source: 'rule',
      title: '使用 chmod 777 授予全权限',
      description: '777 使任何用户可读写执行，常被用于"图省事"排障但会留下持久的权限洞，应改为按属主最小授权。',
      evidence: c777,
      remediation: '按实际需要授予（通常 755 目录 / 644 文件）。',
      command: `# ${c777.slice(0, 80)}\n# 改为按需授权，如 chmod 755 <dir>`
    });
  }

  // rm -rf /
  const rmrf = lineOf(/\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:--no-preserve-root\s+)?\/(?:\s|\*|$)/);
  if (rmrf) {
    push(checks, { id: 'generic_rm_rf_root', name: 'rm -rf 根目录', status: 'fail' });
    findings.push({
      severity: 'high', category: '脚本', source: 'rule',
      title: '存在删除根目录的命令',
      description: '`rm -rf /`（或 /*）会摧毁整个系统。若出现在脚本/历史记录中必须立即确认变量是否可能展开为根路径。',
      evidence: rmrf,
      remediation: '删除或加保护判断（变量为空即退出）。',
      command: 'grep -rn "rm -rf" --include="*.sh" .   # 排查所有脚本'
    });
  }
}

/* ---------------- 主入口 ---------------- */

/**
 * 对审计内容跑全部本地规则。
 * - 含 AUDIT_SECTION 的服务器采集文本 → 逐段架构性检查（pass/fail/skip 全登记）
 * - 通用机密模式扫描始终执行（仅 fail 时登记，避免噪音）
 */
export function runAuditRules(content: string): RuleRunResult {
  const checks: AuditCheck[] = [];
  const findings: RuleFinding[] = [];

  const sections = parseAuditSections(content);
  const isServerCapture = Object.keys(sections).length > 0;

  if (isServerCapture) {
    // Windows 远端：如实说明未执行
    if (sections.NOTE && /仅支持 Linux/.test(sections.NOTE)) {
      push(checks, { id: 'platform', name: '审计平台支持', status: 'skip', detail: 'Windows 检查集规划中，本次未执行规则审计' });
      return { checks, findings: sortFindings(findings) };
    }

    ruleSshConfig(sections.SSH_CONFIG, checks, findings);
    ruleSuid(sections.SUID_BINARIES, checks, findings);
    ruleWorldWritable(sections.WORLD_WRITABLE_DIRS, checks, findings);
    ruleSensitiveFiles(sections.SENSITIVE_FILES, checks, findings);
    ruleOpenPorts(sections.OPEN_PORTS, checks, findings);
    ruleSudo(sections.SUDO_RULES, checks, findings);
    ruleDockerSocket(sections.DOCKER_SOCKET, checks, findings);
    ruleAuthPolicy(sections.AUTH_POLICY, checks, findings);
    ruleFail2ban(sections.FAIL2BAN, checks, findings);

    // 仅展示、不判定的清单段（透明登记，避免"漏报"疑虑）
    const displayOnly: Array<[string, string]> = [
      ['RUNNING_SERVICES', '运行服务清单'],
      ['CRON_JOBS', '定时任务'],
      ['SSL_CERTS', 'SSL 证书文件']
    ];
    for (const [key, name] of displayOnly) {
      if (sections[key] !== undefined) {
        push(checks, { id: key.toLowerCase(), name, status: 'skip', detail: '清单已采集，需人工复核（自动判定易误报）' });
      }
    }
  }

  // 通用模式：对服务器采集与用户粘贴内容都生效
  ruleGeneric(content, checks, findings);

  return { checks, findings: sortFindings(findings) };
}

/* ---------------- AI 结果合并 ---------------- */

export interface MergeableFinding {
  severity: AuditSeverity;
  category?: string;
  title?: string;
  description?: string;
  evidence?: string;
  remediation?: string;
  command?: string;
  source?: string;
}

export interface MergeOutcome<T> {
  findings: T[];
  dropped: number;
}

/**
 * 合并规则与 AI 发现：
 * - AI finding 证据必须逐字命中原文，否则剔除（记入 dropped，前端透明展示）
 * - 与规则结论重复（标题相近或证据同源）的 AI finding 剔除（规则版更可靠）
 * - severity 归一化，非法值降级为 info
 */
export function mergeAuditFindings<T extends MergeableFinding>(
  ruleFindings: T[],
  aiFindings: T[],
  content: string
): MergeOutcome<T> {
  const normalized = (s: string | undefined): string => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const ruleTitles = new Set(ruleFindings.map((f) => normalized(f.title)));
  const ruleEvidences = ruleFindings.map((f) => normalized(f.evidence)).filter(Boolean);
  const kept: T[] = [];
  let dropped = 0;

  for (const f of aiFindings) {
    const title = normalized(f.title);
    if (!title) { dropped++; continue; }
    // 标题重复（相同或互为包含）
    let dup = ruleTitles.has(title);
    if (!dup) {
      for (const rt of ruleTitles) {
        if (rt.includes(title) || title.includes(rt)) { dup = true; break; }
      }
    }
    // 证据同源：AI 描述的其实是规则已覆盖的同一处配置
    if (!dup) {
      const ev = normalized(f.evidence);
      if (ev && ev.length >= 8 && ruleEvidences.some((re) => re === ev || re.includes(ev) || ev.includes(re))) {
        dup = true;
      }
    }
    if (dup) { dropped++; continue; }
    // 证据必须逐字命中原文
    if (!verifyEvidence(f.evidence || '', content)) { dropped++; continue; }
    if (!['critical', 'high', 'medium', 'low', 'info'].includes(f.severity as string)) {
      f.severity = 'info';
    }
    kept.push(f);
  }

  const merged = sortFindings<T>([...ruleFindings, ...kept]);
  return { findings: merged, dropped };
}
