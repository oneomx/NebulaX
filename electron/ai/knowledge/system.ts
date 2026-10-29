/**
 * 内置知识库 · 系统排障与 SSH 远程管理（25 篇）
 * 格式：【现象】【诊断】【处理】【预防】四段式，供本地 TF 检索与 AI 上下文引用
 */

export const SYSTEM_KNOWLEDGE = [
  {
    id: 'builtin-sys-disk-full',
    title: '磁盘空间占满的处理流程',
    category: '系统排障',
    content: `【现象】df -h 显示某分区 Use% 100%，服务写文件失败（No space left on device）。
【诊断】df -h 定位分区；du -xsh /* 2>/dev/null | sort -rh | head 逐层找大目录；du -sh /var/log /var/lib/docker 常见元凶；若 lsof | grep deleted 显示已删除文件仍占空间，说明进程未释放句柄。
【处理】1) 日志清理：journalctl --vacuum-size=500M，清理 /var/log 下轮转旧文件；2) 包缓存：apt-get clean 或 yum clean all；3) Docker：docker system prune -a（确认无用镜像后）；4) 已删除未释放：重启对应进程即释放，勿直接 rm；5) 根本解决：扩容分区或迁移数据目录。
【预防】配置 logrotate 轮转应用日志；磁盘 80% 告警阈值；定期用容量预测趋势提前扩容。`
  },
  {
    id: 'builtin-sys-inode-full',
    title: 'inode 耗尽导致无法创建文件',
    category: '系统排障',
    content: `【现象】df -h 空间仍有剩余，但创建文件报 No space left on device。
【诊断】df -i 查看 IUse%；若 100% 即 inode 耗尽。用 for i in / /*/*; do find $i -xdev -type f 2>/dev/null | head -1 >/dev/null && echo $i; done 或 find / -xdev -type f 2>/dev/null | awk -F/ '{print $2}' | sort | uniq -c | sort -rn 定位小文件爆炸的目录。
【处理】常见元凶是爬虫/会话/缓存小文件（/tmp、/var/lib/nginx、上传目录）。清理：find <目录> -type f -mtime +30 -delete（先 dry-run 确认）；调整应用会话清理策略。
【预防】监控 df -i 而不只 df -h；对缓存类目录设置文件数量上限与 TTL 清理。`
  },
  {
    id: 'builtin-sys-oom',
    title: 'OOM Killer 杀进程（内存耗尽）',
    category: '系统排障',
    content: `【现象】服务突然退出或重启，dmesg / journalctl -k 出现 Out of memory: Killed process。
【诊断】dmesg -T | grep -i 'killed process' 看被杀进程与 oom_score；free -h 看可用内存；ps aux --sort=-rss | head 找内存大户；确认是物理内存不足还是内存泄漏（RSS 持续增长）。
【处理】1) 紧急：重启被杀服务，评估临时调大 swap 或限制单进程内存；2) 定位泄漏：jmap/heaptrack/py-spy 等按语言排查，或对比 RSS 趋势；3) 调整 oom_score_adj 保护关键进程（echo -500 > /proc/<pid>/oom_score_adj）；4) 根本：扩容内存或优化应用。
【预防】监控 available 内存与 swap 使用；对 Java/Python 服务设 -Xmx / 内存上限；告警阈值低于物理内存 10%。`
  },
  {
    id: 'builtin-sys-high-load',
    title: '系统负载过高定位',
    category: '系统排障',
    content: `【现象】uptime 显示 load average 远超 CPU 核数，机器响应缓慢。
【诊断】top 看 %Cpu(s) 的 wa（IO 等待）与 st（虚拟化抢占）：wa 高是磁盘瓶颈，us/sy 高是 CPU 瓶颈，si 高是内存换页；vmstat 1 看 r 列（运行队列）与 b 列（阻塞）；pidstat -d / iostat -xz 1 定位 IO 大户；pidstat -u 找 CPU 大户。
【处理】IO 瓶颈：iostat 定位 %util 高的盘，优化读写（缓存、拆分、迁移 SSD）；CPU 瓶颈：top 找高 CPU 进程，strace -p <pid> 或 perf 热点分析；内存换页：free -h 看 si/so，加内存或减 swap；队列积压：检查下游依赖（数据库、API 超时）。
【预防】load 告警设为 0.7×核数；区分 iowait 与 CPU 使用率做不同告警。`
  },
  {
    id: 'builtin-sys-port-occupied',
    title: '端口被占用（Address already in use）',
    category: '系统排障',
    content: `【现象】服务启动报 Error: listen EADDRINUSE 或 bind: address already in use。
【诊断】ss -lntp | grep :<端口> 或 lsof -i :<端口> 找占用进程；netstat -tlnp 旧系统可用；确认是否为残留旧进程或端口冲突。
【处理】1) 是旧版本残留：kill <pid>（必要时 kill -9），再启动；2) 是其他服务占用：改配置换端口或停用冲突服务；3) TIME_WAIT 过多导致：ss -tan | grep TIME_WAIT | wc -l 检查，属正常短暂状态，持续存在则调 net.ipv4.tcp_tw_reuse=1。
【预防】服务用 systemd 管理避免双开；启动脚本先做端口预检。`
  },
  {
    id: 'builtin-sys-zombie',
    title: '僵尸进程清理',
    category: '系统排障',
    content: `【现象】ps aux 中出现 Z（defunct）状态进程，数量持续增多。
【诊断】ps aux | awk '$8 ~ /Z/' 列出僵尸；ps -o ppid= -p <zombie_pid> 查父进程 PID，ps -p <ppid> 看父进程是谁——僵尸是父进程未 wait() 回收子进程，杀僵尸本身无效。
【处理】1) 重启父进程（systemctl restart <服务>）即可回收；2) 父进程是 shell 且无法重启：kill -CHLD <ppid> 提示回收；3) 父进程为 PID 1 且持续产生：需修复应用代码或换 init（tini/dumb-init）。
【预防】容器内用 --init 或 tini 作为 1 号进程；应用代码规范管理子进程生命周期。`
  },
  {
    id: 'builtin-sys-deleted-space',
    title: '文件已删除但磁盘空间未释放',
    category: '系统排障',
    content: `【现象】rm 删除大文件后 df -h 空间没变化。
【诊断】lsof | grep deleted | grep <文件名> 查看——有输出说明某进程仍持有该文件句柄，空间不会释放。
【处理】1) 找到持有进程：重启该服务释放句柄（systemctl restart <服务>）；2) 无法重启时：echo > /proc/<pid>/fd/<fd号> 可截断释放部分空间（需谨慎，可能影响进程状态）；3) 确认无进程占用后再 df 复查。
【预防】日志用 logrotate 配 copytruncate 或信号轮转而非直接 rm；删大文件前先 lsof 确认。`
  },
  {
    id: 'builtin-sys-ssh-cannot-connect',
    title: 'SSH 无法连接排障',
    category: 'SSH 远程',
    content: `【现象】ssh 用户@主机 无响应、拒绝连接或报错。
【诊断】分层排查：1) ping / telnet <ip> 22 测网络与端口通不通；2) 服务端 ssh -t localhost 或 systemctl status sshd 看服务是否运行；3) 通但拒绝：看 /var/log/auth.log 或 /var/log/secure 拒绝原因（MaxStartups、hosts.deny、fail2ban 封禁）；4) 报 Permission denied：密码/密钥问题；5) 报 Host key verification failed：远端重装导致指纹变化。
【处理】服务未起：systemctl start sshd；被封禁：fail2ban-client status sshd 看并 unbanip；密钥问题：ssh-copy-id 重发公钥；指纹变化：ssh-keygen -R <主机> 清旧记录后重连（先与管理员核实指纹防中间人）。
【预防】保留控制台/带外访问兜底；fail2ban 白名单运维网段。`
  },
  {
    id: 'builtin-sys-ssh-disconnect',
    title: 'SSH 频繁断连的处理',
    category: 'SSH 远程',
    content: `【现象】SSH 连接每隔几分钟或空闲时自动断开。
【诊断】看服务端 /etc/ssh/sshd_config 的 ClientAliveInterval（0=不探测）与 ClientAliveCountMax；网络侧查 NAT/防火墙空闲连接回收（常见 5 分钟掐 TCP）；客户端 ~/.ssh/config 的 ServerAliveInterval。
【处理】1) 服务端加 ClientAliveInterval 30、ClientAliveCountMax 3；2) 客户端 ~/.ssh/config 加 ServerAliveInterval 30；3) 企业网络 NAT 超时：调大上述参数对抗；4) 长任务改用 tmux/screen 或 nohup 防断连丢会话。
【预防】关键操作在 tmux 内执行；跳板机链路逐段测延迟定位丢包点。`
  },
  {
    id: 'builtin-sys-ssh-tunnel',
    title: 'SSH 隧道与端口转发',
    category: 'SSH 远程',
    content: `【现象】需要访问内网数据库/Web 服务但无公网入口，或本地端口被占用无法直连。
【诊断】确认目标服务监听地址（ss -tlnp | grep <端口>）；本地转发用 -L、远程转发用 -R、动态 SOCKS 用 -D；端口冲突看 lsof -i :<本地端口>。
【处理】1) 本地转发：ssh -L 33060:127.0.0.1:3306 user@跳板机，之后连 127.0.0.1:33060 即达内网 MySQL；2) 远程转发（把本机服务暴露给远端）：ssh -R 0.0.0.0:8080:127.0.0.1:80 user@远端，远端需 GatewayPorts yes 才允许非回环监听；3) 动态 SOCKS：ssh -D 1080 user@主机，浏览器/工具配 SOCKS5 代理；4) 后台常驻：加 -N -f 或用 autossh 自动重连；5) 连不上先确认 -L 绑定的是 127.0.0.1 还是 0.0.0.0（安全默认回环）。
【预防】转发只绑 127.0.0.1；跳板机用 ~/.ssh/config 管理别名避免每次手敲长命令。`
  },
  {
    id: 'builtin-sys-ssh-jump-host',
    title: '跳板机与多主机 SSH 配置',
    category: 'SSH 远程',
    content: `【现象】多台服务器密码/密钥混乱，逐层跳转繁琐易断，scp 无法经跳板机传文件。
【诊断】查看 ~/.ssh/config 是否已有 Host 段；OpenSSH 版本决定可用语法（ssh -V，ProxyJump 需 7.3+）；密钥认证失败看服务端 auth.log 是否 Offered public key 后无 Accepted。
【处理】1) 统一配置 ~/.ssh/config：Host web1 → HostName/IP、User、Port、IdentityFile 指定密钥；2) 经跳板：Host app1 加 ProxyJump root@跳板IP（旧版用 ProxyCommand ssh -W %h:%p 跳板）；3) 文件传输同样生效：scp -o ProxyJump=... 或直接 scp 别名:路径；4) 多密钥用 ssh-add ~/.ssh/id_ed25519 加入 agent；5) config 权限须 600 否则被忽略（chmod 600 ~/.ssh/config）。
【预防】密钥统一命名注释便于轮换；跳板机收敛为最小暴露面并开审计。`
  },
  {
    id: 'builtin-sys-ssh-transfer-fail',
    title: 'SCP/SFTP 文件传输失败',
    category: 'SSH 远程',
    content: `【现象】scp/sftp 报权限拒绝、传输中断、速度极慢或卡在 0%。
【诊断】看完整报错：Permission denied 是目标目录权限或密钥问题；No space left on destination 查目标机 df -h；传输中断看双方 auth.log 与网络抖动；卡 0% 常为大文件走了慢链路或限速。
【处理】1) 权限：确认目标目录属主与写权限（ls -ld），必要时先传到 /tmp 再 mv；2) 空间：清理目标分区后重传；3) 断点续传改用 rsync -avzP --partial（ssh 底层同样走 22 端口）；4) 批量/大文件用 sftp 的 reget 或 rsync；5) 传输慢：scp -O 旧协议兼容问题换新协议，或加 -C 压缩文本类文件；6) 主机指纹变化报错时先核实再 ssh-keygen -R 更新。
【预防】重要传输用 rsync 可断点续传；传输脚本先 df 预检空间。`
  },
  {
    id: 'builtin-sys-readonly-fs',
    title: '文件系统变只读（Read-only file system）',
    category: '系统排障',
    content: `【现象】写文件报 Read-only file system，服务无法落盘。
【诊断】dmesg -T | tail -50 查 I/O error、EXT4-fs error、remounted read-only——文件系统检测到错误自动转只读保护数据；df -h 看分区；mount | grep ' / ' 确认当前挂载状态。
【处理】1) 有脏数据先 fsck：卸载分区后 e2fsck -fy <设备>（根分区需从 Live CD 或 single 模式）；2) 重新挂载：mount -o remount,rw /；3) 虚拟机/云盘场景常见磁盘故障，先快照备份再操作；4) 硬件层面 smartctl -a <盘> 检查健康。
【预防】开启磁盘健康监控与 S.M.A.R.T. 告警；关键分区做快照；文件系统错误告警及时处理。`
  },
  {
    id: 'builtin-sys-time-sync',
    title: '系统时间不同步的校正',
    category: '系统排障',
    content: `【现象】日志时间错乱、证书报 expired、数据库主从时间戳不一致。
【诊断】timedatectl 查看 NTP synchronized 是否 no；chronyc tracking 或 ntpstat 看同步源；date 对比标准时间。
【处理】1) 现代系统：timedatectl set-ntp true，并确认 chronyd 运行：systemctl enable --now chronyd；2) 内网无 NTP 服务器：timedatectl set-time '<YYYY-MM-DD HH:MM:SS>' 手动校时后仍建议搭内网 NTP；3) 跳变大时间勿直接回拨（用 chronyc makestep 强制步进）。
【预防】所有服务器统一 NTP 源；证书监控提前 30 天告警。`
  },
  {
    id: 'builtin-sys-kernel-panic',
    title: '内核 panic 与宕机日志分析',
    category: '系统排障',
    content: `【现象】机器宕机重启，或卡死无响应。
【诊断】journalctl -b -1 -p err 看上一次启动的错误；/var/crash 或 /var/log/kern.log；dmesg 搜 panic、Oops、BUG、hardware error；mcelog / rasdaemon 查硬件（内存、ECC）；虚拟化平台看宿主日志。
【处理】1) 软件触发：升级内核、更新驱动（常见 GPU/NVMe 驱动）；2) OOM 引发：调内存与 swap；3) 硬件错误：拔插内存、换盘、迁 VM；4) 复现性 panic：内核参数加 crashkernel、开 kdump 取 vmcore 深入分析。
【预防】开启 kdump；内核与驱动保持稳定版本勿盲目最新；硬件巡检告警。`
  },
  {
    id: 'builtin-sys-raid-degraded',
    title: 'RAID 阵列降级恢复',
    category: '系统排障',
    content: `【现象】开机提示 RAID degraded / 关机报警，或 mdadm --detail 显示 degraded。
【诊断】cat /proc/mdstat 看阵列状态（[UU] 正常、[_U] 降级）；mdadm --detail /dev/md0 找故障盘；smartctl -a /dev/sdX 看盘健康确认是否物理损坏。
【处理】1) 物理盘坏：标记失败 mdadm --fail /dev/md0 /dev/sdX && mdadm --remove 后热插新盘，mdadm --add 自动重建；2) 软阵列重建期间 IO变慢属正常；3) 硬件 RAID（PERC/RAID 卡）进 BIOS 配置界面或用管理工具重建；4) 重建完 mdadm --detail 确认 [UU]。
【预防】配置磁盘故障邮件/ SNMP 告警；备一块同规格热备盘；定期 mdadm --detail 报告巡检。`
  },
  {
    id: 'builtin-sys-lvm-resize',
    title: 'LVM 在线扩容',
    category: '系统排障',
    content: `【现象】云盘/新硬盘挂载后需要扩容根分区或数据分区。
【诊断】lsblk 看分区结构；pvs/vgs/lvs 看物理卷、卷组、逻辑卷剩余空间；df -h 看当前文件系统大小。
【处理】1) 新盘：pvcreate /dev/sdb && vgextend <vg名> /dev/sdb；2) 卷组有剩余：lvextend -l +100%FREE /dev/<vg>/<lv>；3) 在线扩容文件系统：xfs_growfs /（xfs）或 resize2fs /dev/<vg>/<lv>（ext4），均支持在线；4) 无剩余空间则先加盘再走 1-3。
【预防】卷组预留 10-20% 空间应对增长；扩容前先做快照备份。`
  },
  {
    id: 'builtin-sys-find-big-files',
    title: '大文件查找与安全清理',
    category: '系统排障',
    content: `【现象】磁盘紧张需要快速定位大文件。
【诊断】du -xsh /* 2>/dev/null | sort -rh | head 逐层下钻；find / -xdev -type f -size +1G 2>/dev/null 找 GB 级文件；find 按时间：find /var -xdev -type f -mtime +7。
【处理】清理顺序：1) 旧日志与轮转文件；2) 包管理缓存；3) 旧内核（apt-get autoremove --purge）；4) 无用镜像与容器；5) 用户上传/临时目录。删除前用 lsof | grep <文件> 确认无进程占用；重要数据先 tar 备份到别处。
【预防】按目录划分配额（quota）；大文件目录纳入巡检项；rm 前先 du 确认路径展开正确，变量路径加引号防误删。`
  },
  {
    id: 'builtin-sys-cpu-hot-process',
    title: '进程 CPU 飙高定位',
    category: '系统排障',
    content: `【现象】单进程 CPU 持续 100%（或多核打满），机器卡顿。
【诊断】top -c 找 PID；top -H -p <pid> 看线程级 CPU；pidstat -u 1 采样确认持续性；perf top -p <pid>（Linux）看热点函数；Java 用 jstack <pid> 抓线程栈看是否死循环；Python 用 py-spy dump --pid <pid>。
【处理】1) 死循环/递归：看线程栈定位代码修复；2) GC 风暴：jstat -gc <pid> 1s 观察，调堆参数；3) 短时高峰属正常，持续高则限流或扩容；4) 紧急止血：systemctl kill 或 kill -STOP <pid> 暂停后排查。
【预防】CPU 使用率告警（>80% 持续 5 分钟）；应用侧设熔断与限流。`
  },
  {
    id: 'builtin-sys-memory-leak',
    title: '内存泄漏排查',
    category: '系统排障',
    content: `【现象】进程 RSS 随时间单调增长，重启后回落，长期反复。
【诊断】ps -o pid,rss,etime -p <pid> 定时采样画趋势；/proc/<pid>/smaps_rollup 看堆/栈/mmap 分布；Java：jmap -heap + jstat -gcutil；Go：pprof heap；C/C++：valgrind --leak-check=full（测试环境）；Python：objgraph 或 tracemalloc。
【处理】1) 确认增长源后修复代码（未释放引用、缓存无上限、监听器未解绑）；2) 短期缓解：设内存上限（cgroup/systemd MemoryMax）到限即重启；3) 容器场景设 liveness 探针自动重启。
【预防】缓存类结构必须有上限与淘汰策略；上线前压测观察内存曲线 30 分钟以上。`
  },
  {
    id: 'builtin-sys-fd-exhausted',
    title: '文件句柄耗尽（Too many open files）',
    category: '系统排障',
    content: `【现象】服务报 too many open files、EMFILE 或连接建立失败。
【诊断】cat /proc/<pid>/limits 看 Max open files 当前值与上限；ls /proc/<pid>/fd | wc -l 数实际占用；ss -tnp | grep <pid> 看连接数是否与 fd 同步暴涨（连接泄漏）。
【处理】1) 提上限：systemd 服务加 LimitNOFILE=65535（或 /etc/security/limits.conf 配 * soft/hard nofile）；2) 连接泄漏：抓代码未关闭的 socket/文件，用 lsof -p <pid> 看 fd 类型分布；3) 紧急重启服务释放。
【预防】LimitNOFILE 统一基线 ≥65535；监控 fd 占用率（>70% 告警）；代码用连接池并设空闲回收。`
  },
  {
    id: 'builtin-sys-cron-not-run',
    title: 'cron 定时任务不执行',
    category: '系统排障',
    content: `【现象】crontab -l 有条目但到点不运行，或部分执行。
【诊断】1) systemctl status crond/cron 服务是否运行；2) 看邮件或日志：grep CRON /var/log/syslog 或 journalctl -u cron；3) 环境变量差异：cron 最小 PATH（/usr/bin:/bin），脚本里的命令可能找不到；4) 时间/时区确认；5) 脚本本身权限与 shebang。
【处理】1) systemctl enable --now cron；2) 脚本内写绝对路径（/usr/local/bin/xxx）；3) 脚本头部 source /etc/profile 或显式 export PATH；4) 输出重定向到日志便于追踪：0 * * * * /opt/job.sh >> /var/log/job.log 2>&1；5) 确认脚本有执行权限 chmod +x。
【预防】任务统一加日志重置；用 crontab 测试模式逐步上线；关键任务加执行结果监控（完成心跳文件）。`
  },
  {
    id: 'builtin-sys-systemd-autostart',
    title: 'systemd 服务开机不自启排查',
    category: '系统排障',
    content: `【现象】服务器重启后服务没有自动启动。
【诊断】systemctl is-enabled <服务> 看是否 enabled；systemctl status <服务> 看失败原因；journalctl -u <服务> -b 看本次启动日志；检查 unit 文件 After=/Requires= 依赖顺序与网络就绪.target。
【处理】1) systemctl enable <服务> 设置自启；2) 依赖缺失：unit 加 After=network-online.target 并 systemctl enable NetworkManager-wait-online 或 systemd-networkd-wait-online；3) 启动失败：按 journalctl 错误修复（常见配置路径、权限、端口未释放）；4) WantedBy 确认挂在 multi-user.target。
【预防】所有业务服务统一 systemd 管理并 enable；重启演练验证自启链路。`
  },
  {
    id: 'builtin-sys-pkg-lock',
    title: '软件包管理锁与损坏修复',
    category: '系统排障',
    content: `【现象】apt/dpkg 报 Could not get lock 或 dpkg 返回错误导致包装不上。
【诊断】fuser -v /var/lib/dpkg/lock-frontend 查占用进程（apt/dpkg/unattended-upgrades）；ps aux | grep -E 'apt|dpkg' 看是否有残留进程；unattended-upgrades 自动更新常在后台持锁。
【处理】1) 等待自动更新完成（勿强杀）；2) 确认残留后 kill 进程；3) dpkg 损坏：dpkg --configure -a 修复中断的配置；4) 依赖错乱：apt-get -f install；5) 极端情况删 /var/lib/dpkg/lock-* 后重试（仅确认无 dpkg 进程时）。
【预防】生产关闭自动更新改维护窗口；apt 操作前看是否有后台任务。`
  },
  {
    id: 'builtin-sys-missing-so',
    title: '动态库缺失（error while loading shared libraries）',
    category: '系统排障',
    content: `【现象】启动程序报 error while loading shared libraries: libxxx.so.N: cannot open shared object file。
【诊断】ldd <可执行文件> | grep 'not found' 列出全部缺失库；确认是库未安装还是版本不符（so 版本号不同）。
【处理】1) apt/yum 搜索提供该库的包：apt-file search libxxx.so（或 yum whatprovides）；2) 自带的第三方程序：确认随包 lib 目录存在，LD_LIBRARY_PATH 指向它，或 ldconfig 注册路径；3) 版本冲突：安装对应 so 版本或做软链 ln -s libxxx.so.2 libxxx.so.N（确认 ABI 兼容）；4) 改完 ldconfig 刷新缓存。
【预防】部署脚本先跑 ldd 预检；容器镜像内保持运行库完整。`
  },
  {
    id: 'builtin-sys-path-mess',
    title: 'PATH 环境变量混乱',
    category: '系统排障',
    content: `【现象】命令找不到（command not found）、执行到旧版本程序、which 结果与预期不符。
【诊断】echo $PATH 看顺序；which -a <cmd> 列出所有同名命令位置；env -i <命令> 排除环境变量影响测试；登录 shell 与非登录 shell 差异看 /etc/profile、~/.bashrc。
【处理】1) 修正 ~/.bashrc 或 /etc/profile.d/*.sh 中的 PATH，保证 /usr/local/bin 在 /usr/bin 前（自装版本优先）；2) 清理重复/失效条目；3) 改完 source 生效；4) 脚本内建议用绝对路径避免依赖 PATH。
【预防】PATH 统一由 profile.d 管理；安装新版本工具时显式检查优先级。`
  },
  {
    id: 'builtin-sys-d-state',
    title: '进程 D 状态卡死（不可中断睡眠）',
    category: '系统排障',
    content: `【现象】进程状态为 D，kill -9 也杀不掉，系统响应变差。
【诊断】ps aux | awk '$8 ~ /D/' 列出；cat /proc/<pid>/stack 看内核栈（多卡在 IO 等待）；dmesg 查磁盘/存储超时错误；iostat -xz 1 看对应盘 %util 与 await。
【处理】1) 根源是存储故障：检查磁盘、网络存储（NFS/iSCSI）链路，恢复 IO 后 D 进程自动解除；2) NFS 场景：确认服务端与网络，必要时 umount -f -l（谨慎，可能丢数据）；3) 勿反复 kill（无效且加剧队列）。
【预防】存储链路冗余与超时告警；本地盘关注 S.M.A.R.T.；容器宿主避免过载 IO。`
  },
  {
    id: 'builtin-sys-swap-full',
    title: 'Swap 被占满的处理',
    category: '系统排障',
    content: `【现象】free -h 显示 Swap 用满，系统因换页严重变慢。
【诊断】free -h 看 SwapUsed；vmstat 1 看 si/so（换入换出页）是否持续非零；找出占用 swap 的进程：for p in /proc/[0-9]*; do awk '/VmSwap/{if($2>0) print $2, "'"$p"'"}' $p/status 2>/dev/null; done | sort -rn | head。
【处理】1) 内存不足是根因：清理缓存进程或扩容内存；2) 降低 swappiness：sysctl vm.swappiness=10（缓存优先于换页）；3) 某进程异常占 swap：定位泄漏或重启该进程；4) 勿直接 swapoff -a（瞬时内存压力可能触发 OOM）。
【预防】监控 SwapUsed 比例；swappiness 生产建议 10-30；内存规划留 20% 余量。`
  }
];
