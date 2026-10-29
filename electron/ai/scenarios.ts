/**
 * 场景化预设模板库（v1.7）
 * 为常见运维场景提供一键式入口：现象描述 + 上下文提示 + 推荐诊断步骤 + 快捷 prompt。
 * 纯数据模块，无外部依赖，可单测。
 */

export type ScenarioCategory = 'ops' | 'security' | 'database' | 'perf';

export interface ScenarioStep {
  command: string;
  purpose: string;
}

export interface ScenarioPreset {
  id: string;
  category: ScenarioCategory;
  name: string;
  icon: string;
  /** 一句话说明，用于场景选择器卡片 */
  description: string;
  /** 预填故障现象（诊断 Agent 用） */
  incident: string;
  /** 上下文提示（可选补充信息引导） */
  contextHint: string;
  /** 推荐诊断步骤（选中即展示，可复制执行） */
  steps: ScenarioStep[];
  /** 问答面板快捷 prompt */
  quickPrompt: string;
}

export const SCENARIO_CATEGORY_LABELS: Record<ScenarioCategory, string> = {
  ops: '运维排障',
  security: '安全合规',
  database: '数据库运维',
  perf: '性能调优'
};

export const SCENARIOS: ScenarioPreset[] = [
  // ==================== 运维排障 ====================
  {
    id: 'ops-502',
    category: 'ops',
    name: 'Web 服务 502/504',
    icon: '🌐',
    description: '网关超时或后端无响应，页面返回 502/504',
    incident: '网站返回 502 Bad Gateway 或 504 Gateway Timeout，用户无法访问',
    contextHint: '补充：Nginx/网关版本、后端应用类型（Java/PHP/Node）、最近是否有发布或重启',
    steps: [
      { command: 'curl -sI http://127.0.0.1 | head -5', purpose: '本机直连后端，判断是网关问题还是后端问题' },
      { command: 'ss -lntp | grep -E ":80|:443|:8080|:8000"', purpose: '确认监听端口与进程是否存活' },
      { command: 'systemctl status nginx --no-pager 2>/dev/null | head -15', purpose: '查看网关服务状态' },
      { command: "tail -100 /var/log/nginx/error.log 2>/dev/null | tail -30", purpose: '查看网关错误日志定位上游失败原因' },
      { command: 'ps aux --sort=-%cpu | head -10', purpose: '确认后端进程是否崩溃或资源耗尽' }
    ],
    quickPrompt: '网站返回 502/504，帮我排查是网关问题还是后端应用问题，给出排查命令'
  },
  {
    id: 'ops-crash',
    category: 'ops',
    name: '服务进程崩溃/反复重启',
    icon: '💥',
    description: '服务退出、OOM 被杀或 systemd 反复重启',
    incident: '服务进程崩溃或被反复重启（systemd 重启计数增长），需要定位崩溃原因',
    contextHint: '补充：服务名称、崩溃时间点、是否 OOM（内存不足被杀）',
    steps: [
      { command: 'systemctl status <服务名> --no-pager | head -20', purpose: '查看服务状态与最近重启记录' },
      { command: 'journalctl -u <服务名> -n 100 --no-pager | tail -50', purpose: '查看服务日志中的崩溃栈/错误' },
      { command: "dmesg -T 2>/dev/null | grep -iE 'oom|killed process' | tail -20", purpose: '确认是否 OOM Killer 杀掉了进程' },
      { command: 'free -h && cat /proc/meminfo | grep -E "MemTotal|MemAvailable"', purpose: '查看当前内存水位判断 OOM 风险' },
      { command: 'coredumpctl list 2>/dev/null | tail -5', purpose: '查找崩溃 core dump 线索（如有）' }
    ],
    quickPrompt: '服务进程反复崩溃重启，帮我定位是 OOM、代码异常还是配置问题'
  },
  {
    id: 'ops-disk-full',
    category: 'ops',
    name: '磁盘写满',
    icon: '💾',
    description: '磁盘使用率 100%，服务报 No space left',
    incident: '磁盘空间使用率 100%，服务报 No space left on device 错误',
    contextHint: '补充：哪个分区满了、业务类型（数据库/日志密集型）',
    steps: [
      { command: 'df -h | sort -k5 -rh | head -10', purpose: '确认哪些分区使用率最高' },
      { command: 'du -xsh /* 2>/dev/null | sort -rh | head -10', purpose: '定位占用最大的顶层目录' },
      { command: 'du -xsh /var/log/* 2>/dev/null | sort -rh | head -10', purpose: '排查日志目录（最常见元凶）' },
      { command: 'find / -xdev -type f -size +500M -exec ls -lh {} \\; 2>/dev/null | head -10', purpose: '查找超过 500M 的大文件' },
      { command: "lsof +L1 2>/dev/null | head -10", purpose: '查找已删除但未释放的文件句柄' }
    ],
    quickPrompt: '磁盘满了导致服务报 No space left，帮我定位大文件并给出安全清理方案'
  },
  {
    id: 'ops-oom',
    category: 'ops',
    name: '内存耗尽/OOM',
    icon: '🧠',
    description: '内存使用率持续高位，进程被 OOM Killer 杀死',
    incident: '内存使用率持续高于 90%，出现进程被 OOM Killer 杀死的情况',
    contextHint: '补充：哪个服务最耗内存、是否 Java 应用（堆配置）、是否近期流量增长',
    steps: [
      { command: 'free -h', purpose: '查看内存与交换分区水位' },
      { command: 'ps -eo pid,ppid,cmd,%mem,rss --sort=-%mem | head -15', purpose: '定位内存占用最高的进程' },
      { command: "dmesg -T 2>/dev/null | grep -i oom | tail -20", purpose: '查看 OOM Killer 历史记录' },
      { command: 'cat /proc/meminfo | grep -E "Dirty|Writeback"', purpose: '检查脏页堆积（IO 瓶颈信号）' },
      { command: 'grep -i total /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null; cat /sys/fs/cgroup/memory.current 2>/dev/null', purpose: '查看 cgroup 内存限制与用量（容器环境）' }
    ],
    quickPrompt: '内存持续 90%+ 且进程被 OOM 杀，帮我找出内存大户并判断是否泄漏'
  },
  {
    id: 'ops-cpu-high',
    category: 'ops',
    name: 'CPU 负载飙高',
    icon: '🔥',
    description: 'CPU 使用率或 load average 异常升高',
    incident: 'CPU 使用率或 load average 异常升高，服务响应变慢',
    contextHint: '补充：是持续高还是间歇尖峰、是否定时任务触发、最近流量变化',
    steps: [
      { command: 'top -bn1 | head -20', purpose: '一屏快照看 CPU 与进程占用' },
      { command: 'uptime', purpose: '查看 load average 与运行时长' },
      { command: 'ps -eo pid,ppid,cmd,%cpu,%mem --sort=-%cpu | head -12', purpose: '定位 CPU 占用最高的进程' },
      { command: 'mpstat 1 3 2>/dev/null || vmstat 1 3', purpose: '区分是用户态还是内核态/IO 等待高' },
      { command: 'crontab -l 2>/dev/null | tail -10', purpose: '排查是否有定时任务在跑' }
    ],
    quickPrompt: 'CPU 负载突然飙高，帮我定位是哪个进程、是持续高负载还是瞬时尖峰'
  },
  {
    id: 'ops-network',
    category: 'ops',
    name: '网络不通/端口异常',
    icon: '🔌',
    description: '连接超时、端口不通或网络抖动',
    incident: '服务器网络连接异常（连接超时/端口不通/间歇性断连）',
    contextHint: '补充：是入站还是出站问题、是否跨机房、防火墙/安全组是否近期变更',
    steps: [
      { command: 'ip -br a && ip r', purpose: '查看网卡状态与路由表' },
      { command: 'ss -s', purpose: '查看连接数统计（判断连接堆积）' },
      { command: 'ping -c 5 8.8.8.8 2>/dev/null || ping -n 5 8.8.8.8', purpose: '测试外网连通性与丢包率' },
      { command: 'ss -lntup | head -20', purpose: '确认服务监听端口是否正常' },
      { command: 'dmesg -T 2>/dev/null | grep -iE "link|nic|timeout" | tail -15', purpose: '排查网卡/链路层错误' }
    ],
    quickPrompt: '服务器网络异常，帮我判断是本机问题、链路问题还是对端问题'
  },

  // ==================== 安全合规 ====================
  {
    id: 'sec-weaks',
    category: 'security',
    name: '弱口令/凭据泄露排查',
    icon: '🔑',
    description: '排查弱密码、硬编码凭据与明文密钥',
    incident: '需要排查服务器上是否存在弱口令、硬编码密码或明文凭据泄露风险',
    contextHint: '补充：是否公网暴露、是否有多人共用账号、近期是否有人员变动',
    steps: [
      { command: "grep -rInE '(password|passwd|pwd|secret|token)\\s*[=:]\\s*['\\\"']?[A-Za-z0-9]{6,}' /etc /opt /home 2>/dev/null | head -20", purpose: '扫描配置文件中的疑似硬编码凭据' },
      { command: 'awk -F: \'($2 == "" || $2 == "!") {print $1}\' /etc/shadow 2>/dev/null', purpose: '检查是否存在空密码账户' },
      { command: "grep -E '^[^#]' /etc/ssh/sshd_config | grep -iE 'PermitRootLogin|PasswordAuthentication|PermitEmptyPasswords'", purpose: '检查 SSH 高危配置' },
      { command: 'lastb 2>/dev/null | head -20', purpose: '查看最近登录失败记录（暴力破解迹象）' },
      { command: 'cat /etc/passwd | grep -E ":0:" | grep -v root', purpose: '检查是否存在其他 root 权限账户' }
    ],
    quickPrompt: '帮我做一次弱口令与凭据泄露排查，列出风险项和修复命令'
  },
  {
    id: 'sec-ports',
    category: 'security',
    name: '危险端口暴露检查',
    icon: '🚪',
    description: '检查高危端口暴露与防火墙策略',
    incident: '需要检查服务器上是否存在高危端口暴露或防火墙策略缺失',
    contextHint: '补充：服务器公网 IP、业务需要对外暴露的端口清单',
    steps: [
      { command: 'ss -lntup', purpose: '列出所有监听端口与进程' },
      { command: 'systemctl is-active firewalld ufw iptables 2>/dev/null', purpose: '确认防火墙是否启用' },
      { command: 'iptables -L -n 2>/dev/null | head -30 || nft list ruleset 2>/dev/null | head -30', purpose: '查看防火墙规则' },
      { command: 'grep -E "^[^#]" /etc/ssh/sshd_config | grep -i "Port"', purpose: '确认 SSH 端口是否仍为默认 22' },
      { command: 'curl -s --max-time 5 https://api.ipify.org 2>/dev/null || curl -s --max-time 5 ifconfig.me', purpose: '确认公网出口 IP（判断暴露面）' }
    ],
    quickPrompt: '帮我检查哪些端口对公网暴露、防火墙是否生效，列出高危项'
  },
  {
    id: 'sec-perm',
    category: 'security',
    name: '危险权限/SUID 检查',
    icon: '⚠️',
    description: '排查 777 权限、SUID 文件与 sudoers 风险',
    incident: '需要检查文件权限是否过于宽松（777、全局可写、危险 SUID）',
    contextHint: '补充：是否有多人协作开发目录、是否有历史遗留脚本',
    steps: [
      { command: 'find / -xdev -type f -perm -4000 -exec ls -l {} \\; 2>/dev/null | head -20', purpose: '列出所有 SUID 文件' },
      { command: 'find / -xdev -type d -perm -0002 2>/dev/null | head -20', purpose: '列出全局可写目录' },
      { command: 'find /etc /opt /home -xdev -type f -perm -777 2>/dev/null | head -20', purpose: '查找 777 权限文件' },
      { command: 'cat /etc/sudoers 2>/dev/null | grep -v "^#" | grep -v "^$" | head -20', purpose: '检查 sudoers 配置' },
      { command: 'find / -xdev -name "*.sh" -perm -0002 2>/dev/null | head -10', purpose: '查找可被他人篡改的脚本' }
    ],
    quickPrompt: '帮我检查危险文件权限、SUID 文件和 sudoers 配置风险'
  },
  {
    id: 'sec-ssh',
    category: 'security',
    name: 'SSH 配置安全审计',
    icon: '🛡️',
    description: 'SSH 加固检查（root 登录/密码认证/端口）',
    incident: '需要对 SSH 服务做安全加固检查',
    contextHint: '补充：是否使用密钥登录、是否有跳板机/堡垒机',
    steps: [
      { command: 'sshd -T 2>/dev/null | grep -iE "permitrootlogin|passwordauthentication|permitemptypasswords|maxauthtries|x11forwarding"', purpose: '查看 SSH 生效配置（非注释行）' },
      { command: 'grep -E "^[^#]" /etc/ssh/sshd_config', purpose: '查看未注释的 sshd 配置' },
      { command: 'ls -la ~/.ssh/authorized_keys 2>/dev/null && wc -l ~/.ssh/authorized_keys 2>/dev/null', purpose: '检查授权密钥数量与权限' },
      { command: 'journalctl -u ssh -n 50 --no-pager 2>/dev/null | grep -i "failed" | tail -15', purpose: '查看 SSH 登录失败记录' },
      { command: 'fail2ban-client status 2>/dev/null || systemctl is-active fail2ban 2>/dev/null', purpose: '确认防爆破工具是否启用' }
    ],
    quickPrompt: '帮我做 SSH 安全加固检查，给出建议配置和一键修复命令'
  },
  {
    id: 'sec-log',
    category: 'security',
    name: '安全日志审计',
    icon: '📜',
    description: '审计登录行为、异常命令与安全事件',
    incident: '需要审计服务器安全日志，排查异常登录与可疑操作',
    contextHint: '补充：审计时间范围、是否发生过安全事件、重点排查账号',
    steps: [
      { command: 'last -20', purpose: '查看最近成功登录记录' },
      { command: 'lastb 2>/dev/null | head -30', purpose: '查看登录失败记录（暴力破解迹象）' },
      { command: 'grep -h "Accepted" /var/log/secure* /var/log/auth.log* 2>/dev/null | tail -20', purpose: '提取成功登录日志（来源 IP）' },
      { command: 'ausearch -i -m USER_LOGIN 2>/dev/null | tail -20 || grep -i "session opened" /var/log/secure* 2>/dev/null | tail -20', purpose: '审计会话开启记录' },
      { command: 'find / -xdev -name ".*history" -mtime -7 -exec echo "--- {}" \\; -exec tail -15 {} \\; 2>/dev/null | head -60', purpose: '查看最近 7 天各用户命令历史' }
    ],
    quickPrompt: '帮我审计最近的登录行为和命令历史，找出异常登录来源和可疑操作'
  },

  // ==================== 数据库运维 ====================
  {
    id: 'db-slow',
    category: 'database',
    name: '慢查询排查',
    icon: '🐢',
    description: '查询变慢、CPU 被查询打满',
    incident: '数据库查询变慢，出现慢查询堆积，CPU 被查询打满',
    contextHint: '补充：数据库类型（MySQL/PostgreSQL）、哪张表/哪个接口慢、数据量级',
    steps: [
      { command: "mysql -e \"SHOW GLOBAL STATUS LIKE 'Slow_queries'; SHOW GLOBAL VARIABLES LIKE 'slow_query_log';\" 2>/dev/null", purpose: '确认慢查询日志是否开启及累计数量' },
      { command: "mysql -e \"SELECT * FROM information_schema.processlist WHERE Time > 5 ORDER BY Time DESC LIMIT 10;\" 2>/dev/null", purpose: '查看执行超过 5 秒的活跃查询' },
      { command: "mysql -e \"SHOW ENGINE INNODB STATUS\\G\" 2>/dev/null | grep -A 10 'LATEST DETECTED DEADLOCK'", purpose: '检查是否有死锁' },
      { command: "mysql -e \"SHOW GLOBAL STATUS LIKE 'Threads_connected'; SHOW GLOBAL VARIABLES LIKE 'max_connections';\" 2>/dev/null", purpose: '检查连接数是否接近上限' },
      { command: 'iostat -x 1 3 2>/dev/null | tail -10 || vmstat 1 3', purpose: '判断是否磁盘 IO 瓶颈导致查询慢' }
    ],
    quickPrompt: '数据库查询变慢，帮我分析是慢查询、锁等待还是 IO 瓶颈'
  },
  {
    id: 'db-conn',
    category: 'database',
    name: '连接池耗尽',
    icon: '🔗',
    description: 'Too many connections、连接数打满',
    incident: '数据库报 Too many connections 或连接池耗尽，应用无法获取连接',
    contextHint: '补充：数据库类型、连接池大小配置（HikariCP/druid）、应用实例数',
    steps: [
      { command: "mysql -e \"SHOW GLOBAL STATUS LIKE 'Threads_connected'; SHOW GLOBAL STATUS LIKE 'Max_used_connections'; SHOW GLOBAL VARIABLES LIKE 'max_connections';\" 2>/dev/null", purpose: '查看当前/峰值连接数与上限' },
      { command: "mysql -e \"SELECT user, host, db, command, time FROM information_schema.processlist ORDER BY time DESC LIMIT 20;\" 2>/dev/null", purpose: '查看连接分布，找出堆积来源' },
      { command: "mysql -e \"SHOW GLOBAL STATUS LIKE 'Aborted_connects';\" 2>/dev/null", purpose: '查看连接失败计数（异常断连信号）' },
      { command: "mysql -e \"SHOW PROCESSLIST;\" 2>/dev/null | awk '{print $5}' | sort | uniq -c | sort -rn | head -10", purpose: '按连接状态统计（Sleep 多=连接池未复用）' },
      { command: 'ss -tn state established 2>/dev/null | grep ":3306" | wc -l', purpose: '从系统层确认到数据库的连接数' }
    ],
    quickPrompt: '数据库连接数打满报 Too many connections，帮我定位连接堆积来源'
  },
  {
    id: 'db-lock',
    category: 'database',
    name: '锁等待/死锁',
    icon: '🔒',
    description: '行锁等待、表锁导致查询阻塞',
    incident: '数据库出现锁等待或死锁，查询长时间阻塞',
    contextHint: '补充：涉及的表、是否事务嵌套、隔离级别设置',
    steps: [
      { command: "mysql -e \"SELECT * FROM sys.innodb_lock_waits 2>/dev/null || SELECT * FROM information_schema.innodb_lock_waits LIMIT 10;\" 2>/dev/null", purpose: '查看当前锁等待关系' },
      { command: "mysql -e \"SHOW ENGINE INNODB STATUS\\G\" 2>/dev/null | grep -A 30 'LATEST DETECTED DEADLOCK'", purpose: '查看最近一次死锁详情' },
      { command: "mysql -e \"SELECT trx_id, trx_state, trx_started, trx_mysql_thread_id FROM information_schema.innodb_trx ORDER BY trx_started LIMIT 10;\" 2>/dev/null", purpose: '列出运行中的事务，找出长事务' },
      { command: "mysql -e \"SHOW GLOBAL STATUS LIKE 'Innodb_row_lock_waits'; SHOW GLOBAL STATUS LIKE 'Innodb_row_lock_time_avg';\" 2>/dev/null", purpose: '查看行锁等待累计与平均耗时' },
      { command: "mysql -e \"SELECT @@transaction_isolation;\" 2>/dev/null || mysql -e \"SELECT @@tx_isolation;\" 2>/dev/null", purpose: '确认事务隔离级别' }
    ],
    quickPrompt: '数据库出现锁等待和死锁，帮我找出持锁的长事务并给出优化建议'
  },
  {
    id: 'db-repl',
    category: 'database',
    name: '主从延迟/复制中断',
    icon: '🔄',
    description: '主从延迟增大或复制状态异常',
    incident: '数据库主从复制延迟持续增大或复制中断，读写分离出现数据不一致',
    contextHint: '补充：MySQL/PostgreSQL、复制拓扑（一主多从）、延迟秒数',
    steps: [
      { command: "mysql -e \"SHOW SLAVE STATUS\\G\" 2>/dev/null | grep -E 'Seconds_Behind|Slave_IO_Running|Slave_SQL_Running|Last_Error'", purpose: '查看 MySQL 复制状态与延迟' },
      { command: "mysql -e \"SHOW MASTER STATUS;\" 2>/dev/null", purpose: '查看主库当前 binlog 位置' },
      { command: "mysql -e \"SHOW GLOBAL STATUS LIKE 'Com_commit'; SHOW GLOBAL STATUS LIKE 'Com_rollback';\" 2>/dev/null", purpose: '查看主库写入压力' },
      { command: "mysql -e \"SELECT * FROM performance_schema.replication_applier_status_by_worker\\G\" 2>/dev/null | head -30", purpose: '查看从库回放进度与错误' },
      { command: "df -h /var/lib/mysql 2>/dev/null && du -sh /var/lib/mysql 2>/dev/null", purpose: '确认磁盘是否影响复制（binlog 堆积）' }
    ],
    quickPrompt: '主从复制延迟增大甚至中断，帮我定位是网络、从库回放慢还是锁冲突'
  },
  {
    id: 'db-capacity',
    category: 'database',
    name: '数据库容量规划',
    icon: '📈',
    description: '表空间增长、磁盘与连接数容量评估',
    incident: '需要对数据库做容量规划：表空间增长趋势、磁盘容量、连接数上限',
    contextHint: '补充：数据库类型、日均数据增量、当前数据量、预期增长',
    steps: [
      { command: "mysql -e \"SELECT table_schema AS db, ROUND(SUM(data_length+index_length)/1024/1024,1) AS size_mb FROM information_schema.tables GROUP BY table_schema ORDER BY size_mb DESC LIMIT 10;\" 2>/dev/null", purpose: '按库统计数据大小' },
      { command: "mysql -e \"SELECT table_name, ROUND((data_length+index_length)/1024/1024,1) AS size_mb FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY size_mb DESC LIMIT 15;\" 2>/dev/null", purpose: '按表统计找出大表' },
      { command: 'df -h | grep -E "mysql|postgres|data"', purpose: '查看数据库所在分区剩余空间' },
      { command: "mysql -e \"SHOW GLOBAL STATUS LIKE 'Threads_connected'; SHOW GLOBAL VARIABLES LIKE 'max_connections';\" 2>/dev/null", purpose: '评估连接数余量' },
      { command: "mysql -e \"SHOW GLOBAL STATUS LIKE 'Uptime';\" 2>/dev/null", purpose: '查看运行时长（评估稳定性）' }
    ],
    quickPrompt: '帮我做数据库容量规划，分析大表、磁盘增长和连接数余量'
  },

  // ==================== 性能调优 ====================
  {
    id: 'perf-kernel',
    category: 'perf',
    name: '内核参数调优',
    icon: '⚙️',
    description: 'sysctl 内核参数检查与优化建议',
    incident: '需要检查并优化 Linux 内核参数（网络栈、内存管理、文件系统）',
    contextHint: '补充：服务器角色（Web/DB/网关）、并发量级、内核版本',
    steps: [
      { command: 'sysctl net.core.somaxconn net.core.netdev_max_backlog net.ipv4.tcp_max_syn_backlog 2>/dev/null', purpose: '查看连接队列相关参数' },
      { command: 'sysctl net.ipv4.tcp_tw_reuse net.ipv4.tcp_fin_timeout net.ipv4.tcp_keepalive_time 2>/dev/null', purpose: '查看 TIME_WAIT 与保活参数' },
      { command: 'sysctl vm.swappiness vm.dirty_ratio vm.overcommit_memory 2>/dev/null', purpose: '查看内存管理参数' },
      { command: 'sysctl fs.file-max fs.nr_open 2>/dev/null && ulimit -n', purpose: '查看文件句柄限制' },
      { command: 'cat /proc/sys/net/core/somaxconn && cat /proc/net/sockstat | grep -E "sockets|orphans"', purpose: '查看 socket 使用统计' }
    ],
    quickPrompt: '帮我检查 Linux 内核参数是否适合高并发 Web 服务器，给出调优建议和命令'
  },
  {
    id: 'perf-net',
    category: 'perf',
    name: '网络性能调优',
    icon: '📡',
    description: 'TCP 连接、缓冲区与网络吞吐优化',
    incident: '网络吞吐不足或高并发下连接建立慢，需要网络参数调优',
    contextHint: '补充：带宽大小、并发连接数、是否跨机房/国际链路',
    steps: [
      { command: 'sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem 2>/dev/null', purpose: '查看 TCP 读写缓冲区配置' },
      { command: 'sysctl net.core.rmem_max net.core.wmem_max 2>/dev/null', purpose: '查看 socket 缓冲区上限' },
      { command: 'netstat -s 2>/dev/null | grep -iE "retrans|overflow|drop" | head -15 || ss -s', purpose: '查看丢包/重传统计' },
      { command: 'ethtool eth0 2>/dev/null | grep -E "Speed|Duplex|Link detected"', purpose: '确认网卡速率与双工模式' },
      { command: 'ip link show 2>/dev/null | grep -E "state|mtu"', purpose: '检查链路状态与 MTU（Jumbo Frame）' }
    ],
    quickPrompt: '网络吞吐不足、高并发下连接建立慢，帮我检查 TCP 参数并给出调优建议'
  },
  {
    id: 'perf-io',
    category: 'perf',
    name: '磁盘 IO 调优',
    icon: '💿',
    description: 'IO 调度器、读写策略与预读优化',
    incident: '磁盘 IO 成为瓶颈（iowait 高），需要 IO 性能调优',
    contextHint: '补充：磁盘类型（SSD/HDD）、文件系统（ext4/xfs）、业务 IO 模式（随机/顺序）',
    steps: [
      { command: 'cat /sys/block/sda/queue/scheduler 2>/dev/null || cat /sys/block/*/queue/scheduler 2>/dev/null | head -3', purpose: '查看当前 IO 调度器' },
      { command: 'iostat -x 1 3 2>/dev/null | tail -15 || vmstat 1 3', purpose: '查看 IO 等待与吞吐' },
      { command: 'sysctl vm.dirty_ratio vm.dirty_background_ratio 2>/dev/null', purpose: '查看脏页刷盘阈值' },
      { command: 'blockdev --getra /dev/sda 2>/dev/null', purpose: '查看预读扇区数' },
      { command: 'mount | grep -E "ext4|xfs" | head -5', purpose: '确认文件系统与挂载选项' }
    ],
    quickPrompt: 'iowait 很高，帮我检查磁盘 IO 调度器和读写参数，给出优化建议'
  },
  {
    id: 'perf-svc',
    category: 'perf',
    name: '服务配置调优',
    icon: '🛠️',
    description: 'Nginx/应用服务工作进程与连接数配置',
    incident: '需要优化服务配置（Nginx 工作进程、连接数、超时、Keepalive）',
    contextHint: '补充：服务类型与版本、预期并发量、是否反向代理',
    steps: [
      { command: "nginx -T 2>/dev/null | grep -E 'worker_processes|worker_connections|keepalive|timeout' | head -20", purpose: '查看 Nginx 核心并发配置' },
      { command: "nginx -T 2>/dev/null | grep -E 'proxy_connect_timeout|proxy_read_timeout|client_max_body_size' | head -10", purpose: '查看反向代理超时配置' },
      { command: 'ulimit -n && cat /proc/sys/fs/file-max', purpose: '确认系统级与进程级文件句柄' },
      { command: 'ps -eo pid,cmd | grep -E "nginx|java|node" | grep -v grep | head -10', purpose: '查看运行中的服务进程' },
      { command: 'sysctl net.core.somaxconn', purpose: '确认内核连接队列上限（需 ≥ worker_connections）' }
    ],
    quickPrompt: '帮我检查 Nginx/应用服务的并发配置是否合理，给出调优建议'
  }
];

/** 按分类获取场景（不传返回全部） */
export function getScenarios(category?: ScenarioCategory): ScenarioPreset[] {
  return category ? SCENARIOS.filter((s) => s.category === category) : SCENARIOS;
}

/** 按 id 获取场景 */
export function getScenario(id: string): ScenarioPreset | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** 组装诊断 Agent 的故障现象描述（含上下文提示引导） */
export function buildScenarioIncident(s: ScenarioPreset, extra?: string): string {
  const base = s.incident;
  const hint = s.contextHint ? `\n补充信息：${s.contextHint}` : '';
  const extraPart = extra ? `\n实际情况：${extra}` : '';
  return `${base}${hint}${extraPart}`;
}
