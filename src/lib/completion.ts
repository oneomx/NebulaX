import type { Terminal } from 'xterm';
import type { NebulaAPI } from './api';

/**
 * 终端命令智能补全引擎（IDEA 式）。
 *
 * 候选来源：
 *  1. 命令名：远程 `compgen -c`（按会话缓存）∪ 本地精选命令库
 *  2. 子命令 / 参数：本地精选库（git/docker/systemctl 等）
 *  3. 文件路径：远程 `compgen -f`（实时查询，按输入前缀）
 */

export interface CompletionItem {
  label: string;
  /** 灰色提示（来源/说明） */
  hint?: string;
  /** 对该候选（尤其是参数）的一句话解释，显示在弹窗底部 */
  explain?: string;
  /** 候选来源 */
  kind?: 'ai' | 'cmd' | 'sub' | 'flag' | 'file';
}

/** 常用参数解释（选中即显示；AI 联想会补充更具体的解释） */
export const FLAGS_EXPLAIN: Record<string, string> = {
  '--help': '显示帮助信息',
  '-h': '显示帮助 / 人类可读格式',
  '-r': '递归处理子目录',
  '-R': '递归处理（含所有子目录）',
  '-f': '强制执行，忽略提示',
  '-y': '所有确认自动回答 yes',
  '-v': '显示详细执行过程',
  '-q': '静默模式，减少输出',
  '-n': '显示行号 / 数量',
  '-a': '显示所有（含隐藏文件）',
  '-l': '长格式（详细）列表',
  '-i': '忽略大小写 / 交互模式',
  '-u': '指定用户 / 更新',
  '-t': '按时间排序 / 分配终端',
  '-p': '指定端口 / 协议 / 进程',
  '-o': '输出到文件 / 指定排序字段',
  '-e': '编辑模式 / 精确匹配',
  '-s': '静默 / 仅摘要',
  '-c': '执行次数 / 创建 / 计数',
  '-d': '后台运行 / 指定目录 / 删除',
  '-x': '解压 / 排除匹配',
  '-z': 'gzip 压缩/解压',
  '-j': 'bzip2 压缩/解压',
  '-C': '先切换到指定目录再执行',
  '-w': '持续监视 / 宽输出',
  '-N': '不执行远程命令（仅转发端口）',
  '-L': '本地端口转发',
  '-R_': '远程端口转发',
  '-it': '交互式终端（可进容器 shell）',
  '-avz': '归档 + 详细 + 压缩（常用同步组合）',
  '--rm': '容器退出后自动删除',
  '--amend': '修改最近一次提交',
  '--cached': '只操作暂存区',
  '--hard': '硬重置（会丢弃工作区改动）',
  '--soft': '软重置（保留改动在暂存区）',
  '--all': '所有分支 / 所有对象',
  '--no-pager': '输出不分页',
  '--since': '按起始时间过滤',
  '--until': '按截止时间过滤',
  '--delete': '删除目标端多余文件（rsync）',
  '--dry-run': '试运行，不实际执行',
  '--name': '指定名称',
  '--now': '立即执行（enable/disable 同时启停）',
  '--graph': '图形化提交历史'
};

export interface LineContext {
  /** 光标前整行文本（含提示符） */
  before: string;
  /** 去掉提示符后的命令段文本 */
  stripped: string;
  /** 光标前正在输入的词 */
  word: string;
  /** 是否处于"命令名"位置（命令段第一个词） */
  isCommand: boolean;
  /** 当前命令段已输入的命令名（word 本身是命令名时为空串） */
  cmdName: string;
  /** 当前词是否以 - 开头（参数补全） */
  isFlag: boolean;
}

interface CuratedCmd {
  desc?: string;
  subcommands?: string[];
  flags?: string[];
}

/** 精选命令库：子命令 / 常用参数（IDEA 式"懂你的命令"） */
export const CURATED: Record<string, CuratedCmd> = {
  git: {
    desc: '版本控制',
    subcommands: ['status', 'add', 'commit', 'push', 'pull', 'clone', 'checkout', 'branch', 'merge', 'rebase', 'log', 'diff', 'stash', 'fetch', 'reset', 'remote', 'tag', 'cherry-pick', 'revert', 'show', 'blame'],
    flags: ['-A', '-a', '-m', '-u', '-p', '-f', '-b', '-d', '-r', '-c', '--hard', '--soft', '--mixed', '--amend', '--cached', '--oneline', '--all', '--graph', '--help']
  },
  docker: {
    desc: '容器管理',
    subcommands: ['ps', 'images', 'build', 'run', 'exec', 'logs', 'stop', 'start', 'restart', 'rm', 'rmi', 'pull', 'push', 'tag', 'volume', 'network', 'inspect', 'stats', 'system', 'compose', 'cp'],
    flags: ['-d', '-it', '-t', '-p', '-v', '-e', '-w', '--rm', '--name', '-f', '--no-cache', '--help']
  },
  systemctl: {
    desc: '服务管理',
    subcommands: ['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'daemon-reload', 'list-units', 'list-timers', 'is-active', 'is-enabled', 'mask', 'unmask', 'cat'],
    flags: ['-f', '--now', '--no-pager', '--full', '--help']
  },
  apt: {
    desc: '包管理',
    subcommands: ['update', 'upgrade', 'install', 'remove', 'purge', 'autoremove', 'search', 'show', 'list', 'check', 'edit-sources'],
    flags: ['-y', '-q', '-s', '--no-install-recommends', '--help']
  },
  'apt-get': {
    desc: '包管理',
    subcommands: ['update', 'upgrade', 'install', 'remove', 'purge', 'autoremove', 'dist-upgrade', 'search', 'show', 'check'],
    flags: ['-y', '-q', '--no-install-recommends', '--help']
  },
  yum: {
    desc: '包管理(CentOS)',
    subcommands: ['install', 'update', 'remove', 'search', 'list', 'info', 'clean', 'check-update'],
    flags: ['-y', '-q', '--help']
  },
  kubectl: {
    desc: 'K8s 管理',
    subcommands: ['get', 'describe', 'apply', 'delete', 'logs', 'exec', 'scale', 'rollout', 'port-forward', 'config', 'top', 'create', 'edit', 'explain', 'events', 'cp'],
    flags: ['-n', '-o', '-f', '-l', '-w', '-c', '--all-namespaces', '--help']
  },
  npm: {
    desc: 'Node 包管理',
    subcommands: ['install', 'run', 'start', 'build', 'test', 'init', 'publish', 'update', 'audit', 'list', 'ci', 'run-script'],
    flags: ['-g', '-D', '-S', '--save-dev', '--production', '--help']
  },
  journalctl: { desc: '日志查看', flags: ['-u', '-f', '-n', '-e', '--since', '--until', '--no-pager', '--disk-usage', '--help'] },
  tar: { desc: '归档压缩', flags: ['-x', '-c', '-z', '-j', '-v', '-f', '-t', '-C', '-r', '--help'] },
  grep: { desc: '文本搜索', flags: ['-r', '-R', '-i', '-n', '-v', '-E', '-w', '-l', '-c', '-A', '-B', '-C', '--help'] },
  find: { desc: '查找文件', flags: ['-name', '-type', '-mtime', '-size', '-exec', '-maxdepth', '-user', '-perm', '-help'] },
  ps: { desc: '进程查看', flags: ['-ef', '-aux', '-eo', '-f', '-u', '--help'] },
  ls: { desc: '列出目录', flags: ['-l', '-a', '-h', '-t', '-r', '-R', '-S', '-1', '-la', '-lh', '--help'] },
  cd: { desc: '切换目录' },
  cat: { desc: '查看文件', flags: ['-n', '-A', '-b', '--help'] },
  tail: { desc: '查看文件尾', flags: ['-f', '-n', '-c', '--help'] },
  head: { desc: '查看文件头', flags: ['-n', '-c', '--help'] },
  df: { desc: '磁盘占用', flags: ['-h', '-i', '-T', '--help'] },
  du: { desc: '目录大小', flags: ['-h', '-s', '-a', '-d', '--help'] },
  free: { desc: '内存占用', flags: ['-h', '-m', '-g', '-b', '--help'] },
  top: { desc: '资源监控', flags: ['-o', '-u', '-p', '-n', '-b', '--help'] },
  curl: { desc: 'HTTP 请求', flags: ['-I', '-L', '-o', '-X', '-H', '-s', '-k', '-v', '-d', '--help'] },
  wget: { desc: '下载', flags: ['-O', '-q', '-r', '-c', '-b', '--help'] },
  ssh: { desc: '远程登录', flags: ['-p', '-i', '-L', '-R', '-N', '-v', '-C', '--help'] },
  scp: { desc: '远程拷贝', flags: ['-P', '-r', '-i', '-C', '--help'] },
  rsync: { desc: '增量同步', flags: ['-avz', '-a', '-v', '-z', '-r', '-e', '--delete', '--dry-run', '--help'] },
  chmod: { desc: '改权限', flags: ['-R', '-v', '--help'] },
  chown: { desc: '改属主', flags: ['-R', '-v', '--help'] },
  vim: { desc: '编辑器' },
  crontab: { desc: '定时任务', flags: ['-l', '-e', '-r', '--help'] },
  mount: { desc: '挂载', flags: ['-a', '-t', '-o', '--help'] },
  ping: { desc: '连通测试', flags: ['-c', '-i', '-s', '-t', '--help'] },
  ss: { desc: '连接查看', flags: ['-t', '-u', '-l', '-p', '-n', '-a', '-tulpn', '--help'] },
  netstat: { desc: '连接查看', flags: ['-tulpn', '-an', '-t', '-u', '-l', '--help'] },
  uname: { desc: '系统信息', flags: ['-a', '-r', '-n', '-m', '--help'] },
  history: { desc: '命令历史' },
  clear: { desc: '清屏' },
  uptime: { desc: '运行时长' },
  whoami: { desc: '当前用户' }
};

/** 常见命令名兜底（远程 compgen 不可用时） */
const FALLBACK_COMMANDS = Object.keys(CURATED).concat([
  'echo', 'pwd', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'ln', 'which', 'whereis',
  'sed', 'awk', 'sort', 'uniq', 'wc', 'cut', 'xargs', 'less', 'more', 'file', 'stat',
  'kill', 'killall', 'pkill', 'nohup', 'screen', 'tmux', 'env', 'export', 'source',
  'service', 'ufw', 'firewall-cmd', 'iptables', 'useradd', 'usermod', 'passwd', 'su', 'sudo',
  'hostname', 'ip', 'ifconfig', 'traceroute', 'dig', 'nslookup', 'telnet', 'lsof', 'iotop',
  'htop', 'vmstat', 'iostat', 'dmesg', 'lsblk', 'fdisk', 'mkfs', 'fsck', 'ln', 'date', 'cal'
]);

/**
 * 按会话缓存远程命令列表。
 * 成功与失败都写缓存：compgen -c | sort -u 是慢命令，
 * 失败时用短 TTL 负缓存，避免每次按键都远程重跑。
 */
const cmdListCache = new Map<string, { list: string[]; ts: number }>();
const CMD_TTL_OK_MS = 30 * 60 * 1000; // 成功缓存 30 分钟
const CMD_TTL_FAIL_MS = 5 * 60 * 1000; // 失败负缓存 5 分钟

/** 文件路径补全缓存（按 会话+前缀词） */
const fileCache = new Map<string, { list: string[]; ts: number }>();
const FILE_TTL_OK_MS = 60 * 1000; // 有结果缓存 60 秒
const FILE_TTL_FAIL_MS = 15 * 1000; // 无结果负缓存 15 秒
const FILE_CACHE_MAX = 400;

export function clearCompletionCache(sid: string): void {
  cmdListCache.delete(sid);
  for (const k of fileCache.keys()) {
    if (k.startsWith(sid + '\u0000')) fileCache.delete(k);
  }
}

/** 从 xterm 缓冲读取"光标前文本"，解析出补全上下文 */
export function getLineContext(term: Terminal): LineContext | null {
  const buf = term.buffer.active;
  const row = buf.baseY + buf.cursorY;
  const line = buf.getLine(row)?.translateToString(false) ?? '';
  const before = line.slice(0, Math.min(buf.cursorX, line.length));
  const stripped = stripPrompt(before);

  const wordMatch = stripped.match(/([^\s;&|()><'"`]+)$/);
  const word = wordMatch ? wordMatch[1] : '';
  const segStart = stripped.slice(0, stripped.length - word.length);
  const seg = (segStart.split(/[;&|]/).pop() ?? '').trim();
  const tokens = seg ? seg.split(/\s+/) : [];
  return {
    before,
    stripped,
    word,
    isCommand: tokens.length === 0,
    cmdName: tokens[0] || '',
    isFlag: word.startsWith('-')
  };
}

/** 启发式去掉 shell 提示符（root@host:~# / user@host:~$ 等） */
function stripPrompt(text: string): string {
  // 最后一个 "# " / "$ " / "% " / "> " 之后视为用户输入
  const m = text.match(/(?:^|.*[\s\w~\/])[$#%>]\s([\s\S]*)$/);
  if (m) return m[1];
  // 无提示符特征：整行视为输入（但整行无空格且含 @ : 时多半是提示符本身）
  if (!/\s/.test(text) && /[@:]/.test(text)) return '';
  return text;
}

async function runExec(api: NebulaAPI, sid: string, cmd: string): Promise<string[]> {
  try {
    const r = await api.sshExec(sid, cmd);
    if (r.ok && r.stdout) {
      return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** 取远程命令名列表（按会话缓存；失败也负缓存，不反复重跑慢命令） */
async function getRemoteCommands(api: NebulaAPI, sid: string): Promise<string[]> {
  const now = Date.now();
  const hit = cmdListCache.get(sid);
  if (hit && now - hit.ts < (hit.list.length > 0 ? CMD_TTL_OK_MS : CMD_TTL_FAIL_MS)) {
    return hit.list;
  }
  const list = await runExec(api, sid, 'compgen -c 2>/dev/null | sort -u | head -3000');
  cmdListCache.set(sid, { list, ts: now });
  return list;
}

/** 取远程文件/目录候选（按 会话+前缀词 本地缓存，避免每次按键远程 exec） */
async function getRemoteFiles(api: NebulaAPI, sid: string, word: string, force = false): Promise<string[]> {
  // 空词会列出整个目录：慢且候选无意义，仅 Ctrl+Space 强制时允许
  if (!word && !force) return [];
  const key = `${sid}\u0000${word}`;
  const now = Date.now();
  const hit = fileCache.get(key);
  if (hit && now - hit.ts < (hit.list.length > 0 ? FILE_TTL_OK_MS : FILE_TTL_FAIL_MS)) {
    return hit.list;
  }
  const w = shq(word);
  let files = await runExec(api, sid, `compgen -f -- ${w} 2>/dev/null | head -60`);
  if (files.length === 0) {
    // 非 bash 兜底：glob 展开
    files = await runExec(api, sid, `printf '%s\\n' ${w}* 2>/dev/null | head -60`);
  }
  fileCache.set(key, { list: files, ts: now });
  if (fileCache.size > FILE_CACHE_MAX) {
    const first = fileCache.keys().next().value;
    if (first) fileCache.delete(first);
  }
  return files;
}

/**
 * 计算补全候选。
 * @param force 为 true 时（Ctrl+Space）空词也给候选
 */
export async function fetchCompletions(
  api: NebulaAPI,
  sid: string,
  ctx: LineContext,
  force = false
): Promise<CompletionItem[]> {
  const { word, isCommand, cmdName, isFlag } = ctx;

  // ---- 参数补全：命令的常用 flags ----
  if (isFlag && cmdName && CURATED[cmdName]?.flags) {
    return CURATED[cmdName].flags!
      .filter((f) => f.startsWith(word))
      .slice(0, 20)
      .map((f) => ({ label: f, hint: `${cmdName} 参数`, explain: FLAGS_EXPLAIN[f], kind: 'flag' as const }));
  }

  // ---- 命令名补全 ----
  if (isCommand) {
    if (!word && !force) return [];
    const remote = await getRemoteCommands(api, sid);
    const seen = new Set<string>();
    const items: CompletionItem[] = [];
    for (const c of CURATED_KEYS) {
      if (c.startsWith(word) && !seen.has(c)) {
        seen.add(c);
        items.push({ label: c, hint: CURATED[c]?.desc || '命令', kind: 'cmd' });
      }
    }
    for (const c of remote) {
      if (items.length >= 30) break;
      if (c.startsWith(word) && !seen.has(c)) {
        seen.add(c);
        items.push({ label: c, hint: 'PATH', kind: 'cmd' });
      }
    }
    if (items.length === 0) {
      for (const c of FALLBACK_COMMANDS) {
        if (c.startsWith(word) && !seen.has(c)) {
          seen.add(c);
          items.push({ label: c, hint: CURATED[c]?.desc || '命令', kind: 'cmd' });
        }
      }
    }
    return items.slice(0, 30);
  }

  // ---- 子命令补全：命令后第一个词 ----
  const segTokens = (ctx.stripped.slice(0, ctx.stripped.length - word.length).split(/[;&|]/).pop() ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const sub = CURATED[cmdName]?.subcommands;
  if (sub && segTokens.length === 1 && !isFlag) {
    const hits = sub.filter((s) => s.startsWith(word)).slice(0, 20);
    if (hits.length > 0) return hits.map((s) => ({ label: s, hint: `${cmdName} 子命令`, kind: 'sub' as const }));
  }

  // ---- 文件路径补全（默认） ----
  if (!word && !force) return [];
  const files = await getRemoteFiles(api, sid, word, force);
  return files.slice(0, 30).map((f) => ({ label: f, hint: f.endsWith('/') ? '目录' : '文件', kind: 'file' as const }));
}

const CURATED_KEYS = Object.keys(CURATED);
