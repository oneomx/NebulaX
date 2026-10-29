/**
 * 内置知识库 · 网络安全与加固（20 篇）
 */

export const SECURITY_KNOWLEDGE = [
  {
    id: 'builtin-sec-ssh-hardening',
    title: 'SSH 加固基线配置',
    category: '网络安全',
    content: `【现象】安全扫描或等保要求 SSH 配置加固。
【诊断】对照基线检查 /etc/ssh/sshd_config：PermitRootLogin、PasswordAuthentication、PermitEmptyPasswords、MaxAuthTries、Protocol、AllowUsers/AllowGroups。
【处理】推荐基线：PermitRootLogin prohibit-password（禁止密码 root 直登，保留密钥）；PasswordAuthentication no（全员密钥后开启）；PermitEmptyPasswords no；MaxAuthTries 3；AllowGroups ssh-users 收口可登录组；改完 sshd -t 语法校验，再 systemctl reload sshd，保留现有会话验证新连接不被锁。
【预防】修改前先开第二条会话验证；配置纳入审计规则自动检查；变更走工单留痕。`
  },
  {
    id: 'builtin-sec-key-auth',
    title: 'SSH 密钥认证配置（ssh-copy-id）',
    category: '网络安全',
    content: `【现象】需要从密码登录过渡到密钥登录。
【诊断】检查远端 ~/.ssh/authorized_keys 是否存在、权限是否正确（.ssh 700、authorized_keys 600）；sshd_config 中 PubkeyAuthentication 是否为 yes。
【处理】1) 本地生成：ssh-keygen -t ed25519 -C "ops@$(hostname)"（设短语可选）；2) 分发：ssh-copy-id -i ~/.ssh/id_ed25519.pub user@host（密码登录状态执行）；3) 验证密钥登录成功后再关闭密码认证；4) 权限修复：chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys。
【预防】私钥设 passphrase 并用 ssh-agent 管理；公钥纳入团队统一发放与回收流程。`
  },
  {
    id: 'builtin-sec-fail2ban',
    title: 'fail2ban 防爆破部署',
    category: '网络安全',
    content: `【现象】SSH 端口暴露公网，auth.log 出现大量 Failed password。
【诊断】grep 'Failed password' /var/log/auth.log | awk '{print $(NF-3)}' | sort | uniq -c | sort -rn | head 看来源 IP 分布；确认 fail2ban 是否安装运行。
【处理】1) 安装：apt-get install -y fail2ban；2) 配置 /etc/fail2ban/jail.local：[sshd] enabled=true, maxretry=5, bantime=1h, ignoreip=127.0.0.1/8 <运维网段>；3) systemctl enable --now fail2ban；4) 验证：fail2ban-client status sshd；5) 解封：fail2ban-client unbanip <IP>。
【预防】bantime 递增（findtime/bantime 调大）；封禁事件接邮件/Webhook 告警；定期导出 banned IP 复盘。`
  },
  {
    id: 'builtin-sec-ufw-firewall',
    title: 'ufw 防火墙配置',
    category: '网络安全',
    content: `【现象】需要收敛端口暴露面，仅放行必要服务。
【诊断】ufw status verbose 看当前规则与默认策略；ss -lntup 看实际监听端口对比应开放清单。
【处理】1) 默认拒绝入站：ufw default deny incoming、ufw default allow outgoing；2) 先放行 SSH 防锁死：ufw allow 22/tcp；3) 按需放行：ufw allow 80,443/tcp、ufw allow from 10.0.0.0/8 to any port 3306（数据库仅内网）；4) ufw enable（会提示既有连接保留）；5) 紧急解锁：ufw disable 或 ufw allow from <本机IP>。
【预防】规则写注释：ufw allow 8443/tcp # 内网管理端口；定期 ufw status numbered 清理冗余；云安全组与主机防火墙双层配合。`
  },
  {
    id: 'builtin-sec-firewalld',
    title: 'firewalld 防火墙配置（CentOS/RHEL）',
    category: '网络安全',
    content: `【现象】RHEL 系发行版需要配置防火墙白名单。
【诊断】firewall-cmd --state 看是否运行；firewall-cmd --list-all 看当前 zone 的端口、服务与富规则。
【处理】1) 放行服务：firewall-cmd --permanent --add-service=http --add-service=https；2) 放行端口：firewall-cmd --permanent --add-port=8443/tcp；3) 限定来源：firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.0.0.0/8" port port="3306" protocol="tcp" accept'；4) 重载生效：firewall-cmd --reload；5) 移除用 --remove-* 同语法。
【预防】permanent + reload 成对操作；变更前确认 SSH 端口已放行；规则数量大时用 zone 分组管理。`
  },
  {
    id: 'builtin-sec-intrusion-check',
    title: '服务器入侵排查流程',
    category: '网络安全',
    content: `【现象】发现异常：进程 CPU 高、不明外联、文件被改、报警提示可疑。
【诊断】1) w/last 看登录记录与来源 IP；2) cat /etc/passwd 查非预期用户与 /bin/bash 的账户；3) crontab -l 及 /etc/cron.* 查恶意定时任务；4) ps aux --sort=-etime 找陌生/长驻进程；5) ss -tnp 查异常外联；6) find / -mtime -2 -type f 排除系统路径查近期改动文件；7) grep -r <可疑IP> /var/log 看横向痕迹；8) rootkit 检查：rkhunter --check 或 chkrootkit。
【处理】1) 先取证（截图 ps/ss/crontab 与可疑文件 hash）再处置；2) 断开可疑外联（防火墙封 IP）；3) 清理持久化（cron、systemd 单元、authorized_keys、ld.so.preload）；4) 从干净备份恢复被篡改文件；5) 轮换全部凭据（密码、密钥、证书）；6) 必要时重装并迁数据。
【预防】最小权限与密钥登录；文件完整性监控（AIDE/Tripwire）；出网白名单；日志集中收集防篡改。`
  },
  {
    id: 'builtin-sec-suid-check',
    title: 'SUID 提权风险排查',
    category: '网络安全',
    content: `【现象】等保/渗透测试报告提示存在危险 SUID 程序。
【诊断】find / -perm -4000 -type f 2>/dev/null 列出全部 SUID；对照发行版白名单（sudo/su/passwd/mount/crontab/pkexec/ssh-keysign 等为标准），非白名单项（如自装的 python、find、nmap）风险最高；ls -l 看属主是否 root。
【处理】1) 确认业务必要：无需 SUID 立即去除：chmod u-s /path/to/bin；2) 必须保留的（如 sudo）确保版本无已知 CVE（CVE-2021-4034 pkexec、CVE-2021-3156 sudo 漏洞要打补丁）；3) 排查利用痕迹：history 与 auditd 日志中对这些二进制的调用。
【预防】禁止给脚本/解释器加 SUID；新装软件后复查 SUID 清单；纳入定期审计项。`
  },
  {
    id: 'builtin-sec-weak-password',
    title: '弱口令排查与整改',
    category: '网络安全',
    content: `【现象】安全扫描报告弱口令，或怀疑账号被爆破。
【诊断】1) passwd -S <user> 看口令状态；2) chage -l <user> 看有效期；3) /etc/login.defs 的 PASS_MAX_DAYS；4) 用安全工具（如 hydra 在授权范围内）自测弱口令；5) auth.log Failed/Success 序列看是否有爆破成功迹象。
【处理】1) 强制改密：passwd <user>，复杂度要求 ≥12 位含大小写/数字/符号（pam_pwquality 配置 minlen=12）；2) 锁定无人使用账号：usermod -L <user>；3) 检测到爆破成功：立即改密 + 查该账号登录后操作；4) 关键账号启用双因素（SSH 密钥 + OTP）。
【预防】口令有效期 ≤90 天；新装系统统一初始化口令流程；堡垒机统一入口。`
  },
  {
    id: 'builtin-sec-file-permissions',
    title: '敏感文件权限基线',
    category: '网络安全',
    content: `【现象】权限审计不通过或存在越权读取风险。
【诊断】stat -c '%a %U:%G' 检查关键文件：/etc/shadow(640 root:shadow)、/etc/sudoers(440)、/etc/passwd(644)、authorized_keys(600)、私钥文件(600)；find / -perm -o+w -type f 找全局可写文件；find /etc /usr -perm -o+w -type d ! -perm -1000 找无 sticky 的可写目录。
【处理】1) 逐项收紧：chmod 640 /etc/shadow、chmod 440 /etc/sudoers、chmod 600 私钥；2) 全局可写文件：chmod o-w 后确认无服务依赖（误改可能导致服务异常，改前确认属主与用途）；3) 目录加 sticky：chmod +t /path（/tmp 类共享目录）。
【预防】权限基线纳入安全审计自动检查（NebulaX 安全审计已内置这些规则）；变更后复扫。`
  },
  {
    id: 'builtin-sec-auditd',
    title: 'auditd 关键操作审计配置',
    category: '网络安全',
    content: `【现象】需要记录敏感文件访问与提权操作（等保要求）。
【诊断】auditctl -l 看现有规则；systemctl status auditd 看运行状态；audit2why 分析日志。
【处理】1) 启用：systemctl enable --now auditd；2) 关键规则：auditctl -w /etc/passwd -p wa -k identity（账号文件改动）、-w /etc/sudoers -p wa、-w /usr/bin/sudo -p x（提权执行）、-w /root/.ssh -p wa；3) 持久化写入 /etc/audit/rules.d/；4) 查询：ausearch -k identity -i；5) 日志空间：-b 8192 与 logrotate 配置防撑爆磁盘。
【预防】规则精简防日志爆炸；审计日志定期外送集中存储（防攻击者本地清删）。`
  },
  {
    id: 'builtin-sec-cve-scan',
    title: '系统漏洞（CVE）排查流程',
    category: '网络安全',
    content: `【现象】收到 CVE预警（如 OpenSSL、sudo、glibc 高危漏洞），需确认本机是否受影响。
【诊断】1) 确认软件与版本：dpkg -l | grep <pkg> 或 rpm -qa | grep <pkg>；2) 对照 CVE 影响版本区间；3) 内核：uname -r；4) 有扫描器（nessus/openvas）跑认证扫描；5) 无扫描器看发行版安全公告：ubuntu-security-notices / RHSA。
【处理】1) 受影响：apt-get update && apt-get install --only-upgrade <pkg> 或 yum update <pkg>；2) 需重启的（内核/glibc）安排维护窗口 reboot；3) 无法升级的缓解：防火墙限制访问面、WAF 规则、关闭受影响功能；4) 升级后复扫验证。
【预防】订阅安全公告邮件；每月例行漏洞扫描；建立受影响资产清单（版本指纹）。`
  },
  {
    id: 'builtin-sec-ssl-cert',
    title: 'SSL/TLS 证书管理与续签',
    category: '网络安全',
    content: `【现象】浏览器报证书过期/不信任，或证书即将到期告警。
【诊断】echo | openssl s_client -connect <域名>:443 -servername <域名> 2>/dev/null | openssl x509 -noout -dates 查有效期；本地证书文件：openssl x509 -in cert.pem -noout -dates；-text 看签发者与 SAN。
【处理】1) Let's Encrypt 自动续签：certbot renew --dry-run 测试，配置 systemd timer/cron 每天跑；2) 手动申请：certbot certonly --webroot -w /var/www/html -d <域名>；3) 企业证书：走 CA 流程重新签发，nginx/apache 换文件后 reload；4) 链证书缺失：补 fullchain.pem 而非单独 cert.pem。
【预防】到期前 30 天监控告警（openssl 探测）；统一证书台账；私钥文件权限 600 并考虑 HSM/加密存储。`
  },
  {
    id: 'builtin-sec-port-exposure',
    title: '端口暴露面收敛',
    category: '网络安全',
    content: `【现象】扫描发现大量对外开放端口，或数据库/中间件暴露公网。
【诊断】ss -lntup 看监听地址：0.0.0.0 表示全网卡暴露、127.0.0.1 仅本地；对照业务需要梳理应开放清单；云安全组/安全组规则同步核对。
【处理】1) 仅本地服务改 bind 127.0.0.1（MySQL redis nginx 上游等）；2) 内网服务限制来源 IP（防火墙富规则/安全组）；3) 高危端口（3389/6379/27017/2375/9200）非必要直接关闭；4) 管理入口收敛到 VPN/堡垒机；5) 改完 reload 服务并 ss 复核。
【预防】基线：新增服务先问"必须公网吗"；季度暴露面扫描；云资产与主机防火墙对账。`
  },
  {
    id: 'builtin-sec-jump-host',
    title: '跳板机与 SSH 代理转发',
    category: '网络安全',
    content: `【现象】内网服务器不能直连，需经跳板机中转。
【诊断】确认跳板机可同时访问内网目标；本地 ssh -J 或 ProxyJump 能力（OpenSSH ≥7.3）。
【处理】1) 一条命令中转：ssh -J user@跳板机 user@目标机；2) 持久配置 ~/.ssh/config：Host target 写 ProxyJump user@jump；3) 动态 SOCKS 代理（浏览器/数据库工具用）：ssh -D 1080 user@跳板机；4) 端口转发把内网服务映射本地：ssh -L 3306:db-host:3306 user@跳板机；5) 免密：跳板机对目标配密钥转发（AgentForwarding 慎用，有会话劫持面）。
【预防】跳板机开审计录像；转发端口仅绑 127.0.0.1；用完关闭隧道。`
  },
  {
    id: 'builtin-sec-known-hosts',
    title: 'known_hosts 指纹验证（防中间人）',
    category: '网络安全',
    content: `【现象】连接报 WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED 或 Host key verification failed。
【诊断】ssh-keygen -F <主机> 查本地记录；远端 ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub 取当前指纹；错误提示中给出的新指纹与远端实际指纹对比。
【处理】1) 指纹不一致的两种可能：远端重装系统（正常）或中间人攻击（危险）——必须先通过独立渠道（控制台/管理员）核实；2) 确认正常后清除旧记录：ssh-keygen -R <主机>（含端口写 <主机>:<端口>）再连接接受新指纹；3) 企业环境用 known_hosts 团队分发统一指纹。
【预防】绝不盲目 -o StrictHostKeyChecking=no；首次连接核对控制台显示的指纹。`
  },
  {
    id: 'builtin-sec-key-rotation',
    title: '凭据泄露应急轮换',
    category: '网络安全',
    content: `【现象】私钥/密码/Token 疑似或确认泄露（仓库提交、员工离职、入侵事件）。
【诊断】确认泄露范围：哪些账号、哪些机器、是否已被使用（登录日志、命令历史、出网记录）。
【处理】1) 立即止损：吊销泄露凭据（改密、删 authorized_keys 对应公钥、Token 作废）；2) 排查滥用痕迹：last、auth.log、应用日志；3) 全量轮换：所有复用该凭据的服务、脚本、CI 变量、监控探针；4) 云环境：AK/SK 在 IAM 控制台禁用并生成新的；5) 事件复盘记录时间线。
【预防】密钥不进代码仓库（pre-commit 钩子扫 secret）；一机一密不复用；离职流程含凭据回收清单。`
  },
  {
    id: 'builtin-sec-classification-20',
    title: '等保 2.0 常见检查项速查',
    category: '网络安全',
    content: `【现象】需要对照等保 2.0 三级要求做自查。
【诊断】重点核查：1) 身份鉴别（双因素、口令复杂度、登录失败处理）；2) 访问控制（最小权限、默认无权限、特权账户分离）；3) 安全审计（auditd 覆盖重要操作、日志留存 ≥6 个月）；4) 入侵防范（漏洞修复、防爆破、最小开放端口）；5) 数据完整性（校验、备份恢复测试）；6) 剩余信息保护（磁盘擦除）。
【处理】按差距整改：口令策略（pwquality）、fail2ban、端口收敛、auditd 规则、日志集中服务器（rsyslog→中心）、定期备份并季度恢复演练、关闭未用服务。
【预防】每半年自查一次；整改项进任务清单跟踪；扫描器定期复测。`
  },
  {
    id: 'builtin-sec-auth-log',
    title: 'auth.log 攻击痕迹排查',
    category: '网络安全',
    content: `【现象】需要确认某主机是否被爆破成功或存在异常登录。
【诊断】grep 'Failed password' /var/log/auth.log | awk '{print $11}' | sort | uniq -c | sort -rn 看爆破来源；grep 'Accepted' /var/log/auth.log 看成功登录时间与来源 IP；对比业务登录白名单；sshd 启用 LogLevel VERBOSE 可记录密钥指纹辅助确认。
【处理】1) 发现异常成功登录：按入侵排查流程处理（见入侵排查篇）；2) 爆破量大：部署/调优 fail2ban 并封禁来源；3) 来源 IP 属云厂商段：可封整段或上威胁情报查询；4) 日志被清：/var/log/auth.log 大小突变或 lastb 异常，警惕攻击者抹痕迹，启用远程日志。
【预防】日志转发行（rsyslog forwarding）到不可篡改的集中存储；auth.log 轮转与容量监控。`
  },
  {
    id: 'builtin-sec-docker-baseline',
    title: 'Docker 容器安全基线',
    category: '网络安全',
    content: `【现象】容器安全扫描提示风险，或需要容器环境加固。
【诊断】docker info 看 root 权限运行；docker ps 看特权容器（Privileged）、--net=host、挂载 /var/run/docker.sock；镜像来源是否可信；容器内是否以 root 跑业务。
【处理】1) 业务容器加 --security-opt no-new-privileges、非 root 用户运行（USER 指令）；2) 禁特权与 host 网络，除非明确需要；3) docker.sock 不挂载进容器（等价 root）；4) 镜像用官方或内网仓库并扫描（trivy image <name>）；5) 资源限制 --memory --cpus 防资源耗尽；6) 只读根文件系统 --read-only + tmpfs。
【预防】Docker daemon 开 live-restore 与日志限额；镜像签名准入；定期基线扫描纳入巡检。`
  }
];
