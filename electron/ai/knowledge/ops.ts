/**
 * 内置知识库 · 性能调优 / Windows 运维 / 监控与应急（20 篇）
 */

export const OPS_KNOWLEDGE = [
  {
    id: 'builtin-perf-cpu',
    title: 'CPU 性能分析方法（top/mpstat）',
    category: '性能调优',
    content: `【现象】CPU 使用率高或负载上涨，需要定位瓶颈类型。
【诊断】top 看 %us（用户态）/%sy（内核态）/%wa（IO 等待）/%st（虚拟化抢占）；mpstat -P ALL 1 看单核是否倾斜（单核打满是应用单线程瓶颈）；pidstat -u 1 找进程；perf top -g 看热点函数（需 debuginfo）。
【处理】1) us 高：应用逻辑优化、加实例水平扩展；2) sy 高：系统调用过频（频繁小 IO/网络），strace -c 统计调用；3) wa 高：转磁盘 IO 篇处理；4) st 高：宿主机超卖，迁机器或升配；5) 单核瓶颈：应用多线程化或拆分实例。
【预防】CPU 按核数设告警线（>70% 持续 5 分钟）；业务高峰前压测核数需求。`
  },
  {
    id: 'builtin-perf-memory',
    title: '内存性能分析（free/vmstat）',
    category: '性能调优',
    content: `【现象】内存告警或系统变慢怀疑换页。
【诊断】free -h 看 available（关键指标，非 buff/cache）；vmstat 1 看 si/so 持续非零=在换页、bi/bo 磁盘读写；/proc/meminfo 细看 Slab（内核缓存）与 Committed_AS。
【处理】1) available 低：清理可回收缓存（sync && echo 3 > /proc/sys/vm/drop_caches 仅应急）、限制大户、扩容；2) 换页严重：减小 swappiness（vm.swappiness=10）、加物理内存；3) Slab 持续涨：内核缓存泄漏（dentry/inode 缓存可清， slabtop 观察）；4) overcommit：vm.overcommit_memory=2 严格模式防 OOM。
【预防】监控 available 而非 used；容器设 MemoryMax；内存预留 20% 余量。`
  },
  {
    id: 'builtin-perf-disk-io',
    title: '磁盘 IO 分析（iostat）',
    category: '性能调优',
    content: `【现象】磁盘 IO 瓶颈：%util 高、await 长，应用 IO 等待。
【诊断】iostat -xz 1 看：r/s、w/s（吞吐）、await（平均时延）、%util（单盘接近 100%=饱和，多队列 SSD 可超 100%）；iotop 找 IO 大户进程；判断随机小 IO 还是顺序大 IO（rg/s vs rMB/s 比值）。
【处理】1) 时延高：await 对比基线（SSD 应 <10ms，HDD <20ms），坏盘先换；2) 随机 IO 密集：上 SSD、拆分热点数据、加缓存（Redis/本机缓存）；3) 顺序读写大：调大 block size、异步 IO；4) 应用层：合并写、批量提交、队列限流平滑峰值；5) 云盘类型升配（gp3/io2）。
【预防】%util 与 await 双指标告警；磁盘类型匹配负载特征；数据库与日志盘分离。`
  },
  {
    id: 'builtin-perf-network',
    title: '网络带宽与延迟诊断（iftop/mtr）',
    category: '性能调优',
    content: `【现象】网络传输慢、跨机调用超时。
【诊断】iftop -nP 或 nload 看带宽占用与对端；mtr -rw <目标> 看逐跳延迟与丢包（区分本机出、运营商、对端入）；ping 看 RTT 抖动；ss -ti 看 TCP RTT 与重传（tcpi 字段）；ethtool <网卡> 看速率双工、错误计数 ifconfig 看 errors/drops。
【处理】1) 丢包在内网：查交换机端口错误计数、网线/光模块；2) 跨运营商：换线路或 CDN；3) 带宽打满：iftop 找大流量会话，限速（tc qdisc）或扩容带宽；4) TCP 重传高：net.core.rmem/wmem 调优或查中间设备 MTU 黑洞（ping -M do -s 1472 探测）；5) 网卡错误：换口/换线。
【预防】带宽 70% 告警；mtr 定期对关键对端基线测试；MTU 全链路一致。`
  },
  {
    id: 'builtin-perf-tcp-states',
    title: 'TCP 连接状态分析（ss/netstat）',
    category: '性能调优',
    content: `【现象】连接异常、TIME_WAIT 堆积或连接建立失败。
【诊断】ss -s 汇总；ss -tan state time-wait | wc -l 数 TIME_WAIT；ss -tan state syn-recv/syn-sent 看半开连接；ss -tnp 看进程连接分布；syn flood 特征=syn-recv 大量堆积。
【处理】1) TIME_WAIT 多：属主动关闭方正常态（2MSL 后回收），量大影响端口复用时开 net.ipv4.tcp_tw_reuse=1（仅出向连接）；2) SYN 队列满：tcp_max_syn_backlog、somaxconn 调大，tcp_syncookies=1；3) CLOSE_WAIT 多：应用未 close，查代码 fd 泄漏；4) 连接耗尽：文件句柄与端口范围 ip_local_port_range 检查。
【预防】监控各状态计数（CLOSE_WAIT>0 持续即告警）；压测观察连接曲线。`
  },
  {
    id: 'builtin-perf-sysctl',
    title: '内核参数调优基线（sysctl）',
    category: '性能调优',
    content: `【现象】高并发场景连接建立慢、队列溢出、端口不足。
【诊断】sysctl net.core.somaxconn、net.ipv4.tcp_max_syn_backlog、net.ipv4.ip_local_port_range、fs.file-max 当前值；dmesg 中 SYN flood、request_sock 超限告警。
【处理】高并发基线（写入 /etc/sysctl.d/99-tuning.conf 后 sysctl -p）：net.core.somaxconn=65535；net.ipv4.tcp_max_syn_backlog=65535；net.ipv4.tcp_tw_reuse=1；net.ipv4.tcp_fin_timeout=15；net.ipv4.ip_local_port_range=1024 65535；fs.file-max=1048576；net.core.netdev_max_backlog=65535。应用侧 accept 队列（backlog）需 ≤ somaxconn 才生效。
【预防】调参前记录原值可回滚；每次只改一类参数观察效果；容器宿主统一基线。`
  },
  {
    id: 'builtin-perf-ulimit',
    title: '文件句柄与 ulimit 配置',
    category: '性能调优',
    content: `【现象】应用报 Too many open files、fork 失败（Cannot allocate memory 但内存有剩余）。
【诊断】ulimit -a 看当前 shell 限制（nofile/nproc）；cat /proc/<pid>/limits 看进程实际生效值；systemd 服务默认 LimitNOFILE 可能仅 1024/4096。
【处理】1) systemd 服务：unit 加 LimitNOFILE=65535、LimitNPROC=65535 后 daemon-reload + restart；2) 全局：/etc/security/limits.conf 配 * soft nofile 65535 / * hard nofile 65535（需 pam_limits 生效）；3) 内核上限 fs.file-max 同步调大；4) 容器：docker run --ulimit nofile=65535:65535 或 compose 的 ulimits。
【预防】基线统一 65535；启动脚本断言 ulimit 检查不达标拒绝启动；fd 使用率监控。`
  },
  {
    id: 'builtin-ops-patrol',
    title: '服务器巡检要点清单',
    category: '监控与应急',
    content: `【现象】需要例行巡检或交接检查。
【诊断】按维度检查：1) 负载：uptime、CPU/内存/磁盘使用率；2) 磁盘：df -h 与 df -i、大文件增量；3) 服务：systemctl --failed、关键端口监听；4) 日志：journalctl -p err -n 50、auth.log 异常登录；5) 安全：fail2ban 状态、SUID 新增、可疑进程与外联；6) 备份：最近备份时间与大小；7) 时间同步：timedatectl；8) RAID/SMART 健康。
【处理】巡检发现项分级：紧急（服务挂/磁盘满/入侵迹象）立即处理；重要（容量趋势/证书到期）排期；记录巡检表归档，异常项转工单跟踪。
【预防】用自动化巡检（NebulaX 定时巡检可自动采集告警+趋势预测+报告落盘）替代纯人工；巡检项季度复盘增删。`
  },
  {
    id: 'builtin-ops-capacity-forecast',
    title: '磁盘容量预测与提前扩容',
    category: '监控与应急',
    content: `【现象】磁盘持续增长，希望提前预知何时写满并规划扩容。
【诊断】df -h 取近 7/30 天使用率数据（监控系统或手动记录）；du 按目录看增长源（日志/数据/备份）；区分线性增长（业务数据）与突发增长（日志暴涨/异常写入）。
【处理】1) 趋势预测：对使用率序列做线性回归，外推触顶日期（NebulaX 容量预测/巡检趋势预警已内置该算法）；2) 触顶前动作：清理策略（日志轮转/过期数据）→ 迁移数据目录 → 扩容（LVM/云盘在线扩容）；3) 突发增长先查异常（失控任务、攻击写入）。
【预防】80% 告警 + 30 天触顶预测双保险；数据保留策略先行（日志 N 天、备份 N 份）；扩容演练一次验证在线扩容流程。`
  },
  {
    id: 'builtin-ops-log-analysis',
    title: '日志分析技巧（journalctl/grep）',
    category: '监控与应急',
    content: `【现象】海量日志中定位问题线索效率低。
【诊断】journalctl 常用：-u <服务> 按单元、--since/--until 按时间、-p err 按级别、-f 实时、-b/-b -1 本次/上次启动、--no-pager -n 100 取尾部；文件日志用 grep -n 关键词 + -A/-B 上下文；时间窗组合 --since "2026-10-27 14:00" --until "14:30"。
【处理】1) 先定时间窗再缩范围，避免全量扫描；2) 多关键词：grep -E 'error|fail|timeout' -i；3) 结构化日志用 jq 处理（cat app.json.log | jq 'select(.level=="ERROR")'）；4) 频次统计：grep -o 'code=[0-9]*' app.log | sort | uniq -c | sort -rn；5) 大文件用 zgrep 处理轮转压缩包；6) 异常模式：统计单位时间错误数突增（awk 按分钟聚合）。
【预防】日志规范（级别、traceId、结构化 JSON）；集中日志平台检索；错误日志带告警。`
  },
  {
    id: 'builtin-win-disk-clean',
    title: 'Windows 磁盘空间清理',
    category: 'Windows运维',
    content: `【现象】C 盘爆红，系统变慢。
【诊断】此电脑看各分区；cleanmgr /? 或 设置-系统-存储看分类占用；PowerShell：Get-ChildItem C:\\ -Directory | ForEach { $s=(Get-ChildItem $_.FullName -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum; [PSCustomObject]@{Dir=$_.Name;GB=[math]::Round($s/1GB,1)} } | Sort GB -Desc 排大目录。
【处理】1) 磁盘清理：cleanmgr /sageset:1 配置后 /sagerun:1（含系统更新清理）；2) Windows 更新缓存：停 wuauserv，删 C:\\Windows\\SoftwareDistribution\\Download，启服务；3) 休眠文件：powercfg -h off（不需要休眠时）；4) 系统还原点：vssadmin list shadows 删除旧卷影；5) 临时目录：清理 %TEMP%；6) 转移页面文件/用户目录到 D 盘；7) DISM 组件清理：Dism /Online /Cleanup-Image /StartComponentCleanup。
【预防】存储感知自动清理开启；数据盘与系统盘分离；大目录纳入定期巡检。`
  },
  {
    id: 'builtin-win-event-viewer',
    title: 'Windows 事件查看器排障',
    category: 'Windows运维',
    content: `【现象】Windows 异常（蓝屏、服务失败、登录异常）需要查根因。
【诊断】eventvwr.msc 或 PowerShell Get-WinEvent；关键日志：System（系统级错误/蓝屏 Kernel-Power 41）、Application（应用崩溃）、Security（登录事件 4624/4625 成功/失败）；快速过滤：Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=(Get-Date).AddHours(-24)} 取近 24 小时错误；蓝屏看 Event ID 1001 BugCheck 与 C:\\Windows\\Minidump。
【处理】1) 蓝屏：WinDbg 分析 dump（!analyze -v），常见驱动/内存；2) 服务失败：属性看退出码，依赖服务是否先挂；3) 登录失败暴增：查来源 IP（Event 4625 含网络信息），封防火墙；4) 磁盘错误：Event 7/51（disk），chkdsk /f 修复。
【预防】转发安全日志到集中平台；启用长期日志保留（默认 20MB 会滚动覆盖）；关键服务器开完整转储。`
  },
  {
    id: 'builtin-win-service-powershell',
    title: 'Windows 服务与进程管理（PowerShell）',
    category: 'Windows运维',
    content: `【现象】需要在 Windows 上管理服务、查进程、远程执行。
【诊断】Get-Service 查服务状态（Status/StartType）；Get-Process 查进程（Handle、WS 内存）；Get-CimInstance Win32_Service 查服务可执行路径；Get-NetTCPConnection 看端口占用（-State Listen）。
【处理】1) 服务：Start-Service/Stop-Service/Restart-Service <名>，Set-Service <名> -StartupType Automatic 设自启；2) 杀进程：Stop-Process -Name <名> -Force；3) 端口冲突：Get-NetTCPConnection -LocalPort 8080 | Select OwningProcess 后查进程；4) 远程：Enable-PSRemoting -Force 后 Enter-PSSession -ComputerName <主机>（域环境用 Kerberos）；5) 批量执行：Invoke-Command -ComputerName (Get-Content hosts.txt) -ScriptBlock { ... }。
【预防】远程管理走 WinRM+TLS；服务账号用最小权限专用账户；变更走计划任务窗口。`
  },
  {
    id: 'builtin-win-rdp',
    title: 'Windows 远程桌面（RDP）连接问题',
    category: 'Windows运维',
    content: `【现象】mstsc 远程桌面连不上：拒绝、黑屏、卡顿、频繁断开。
【诊断】1) 连接拒绝：目标机 RDP 未启用（系统属性-远程-允许远程连接）、防火墙 3389 未放行（Get-NetFirewallRule -DisplayGroup '远程桌面'）；2) 远程会话数满：tsadmin / 或查询 qwinsta，断开的会话仍占位；3) 黑屏/卡顿：显卡驱动、网络带宽；4) 频繁断：网络抖动或会话超时策略。
【处理】1) 启用 RDP：Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' fDenyTSConnections 0 + 防火墙放行；2) 清理会话：query session /id:<n> 后 tscon <id> /dest:console 或 qwinsta 看后用 logoff <id>；3) 并发不足：升级许可证或改用多用户方案；4) 断线重连：客户端"自动重新连接"，服务端调 KeepAlive。
【预防】RDP 不暴露公网（经 VPN/堡垒机）；开启网络级认证 NLA；改默认 3389 端口并配合 fail2ban 类封禁。`
  },
  {
    id: 'builtin-win-update-fail',
    title: 'Windows 更新失败处理',
    category: 'Windows运维',
    content: `【现象】Windows Update 反复失败（错误码 0x80073712、0x800f0988 等）。
【诊断】设置-更新历史看失败项与代码；C:\\Windows\\Logs\\CBS\\CBS.log 查详细；DISM /Online /Cleanup-Image /ScanHealth 查组件存储损坏。
【处理】标准修复序列：1) sfc /scannow 修复系统文件；2) DISM /Online /Cleanup-Image /RestoreHealth 修复组件存储（需可用的更新源或 WIM）；3) 重置更新组件：停 wuauserv、cryptsvc、bits，重命名 SoftwareDistribution 与 catroot2，重启服务；4) 0x800f0988（累积更新残留）：先卸载最近更新再重试；5) 实在不行用 Microsoft 更新目录手动下载 .msu 安装。
【预防】更新前建还原点/快照；测试环境先行；预留 C 盘 20% 以上空间。`
  },
  {
    id: 'builtin-incident-service-crash',
    title: '应急响应：服务雪崩处置',
    category: '监控与应急',
    content: `【现象】核心服务大面积超时/失败，告警风暴，用户投诉。
【诊断】1) 先看范围：单实例还是全量（负载均衡健康检查、监控曲线）；2) 最近变更：发布记录、配置变更、依赖方故障公告；3) 资源层：CPU/内存/连接数/磁盘是否打满；4) 下游链路：数据库慢查询、第三方 API 超时、消息积压；5) 错误日志 Top 错误码聚合。
【处理】按止血优先级：1) 回滚最近变更（发布/配置）——最常见根因且最快；2) 扩容（水平加实例）；3) 限流熔断保护核心链路（降级非核心功能）；4) 重启故障实例（先保留现场：日志/core dump）；5) 切流量到备用集群/机房；6) 恢复后监控观察 30 分钟，同步通报进展（每 15 分钟一次）。
【预防】发布可一键回滚；容量冗余 50%；依赖超时与熔断默认开启；预演故障剧本（GameDay）。`
  },
  {
    id: 'builtin-incident-data-recovery',
    title: '应急响应：数据误删恢复',
    category: '监控与应急',
    content: `【现象】误删数据库记录/表、rm 误删文件。
【诊断】1) 先评估影响面与时间点（什么时候删的、谁操作的）；2) 数据库：确认备份策略（全量时间、binlog 覆盖）；3) 文件：确认文件系统（ext4 删除靠 inode 回收，XFS 类似）、是否被覆盖；4) 判断恢复路径：应用层软删/回收站 → 数据库备份 → binlog/PITR → 专业恢复工具。
【处理】1) 数据库表级：有备份→恢复到临时库再对比回填（避免全库回滚丢新数据）；MySQL binlog 按时间点恢复：mysqlbinlog --start-datetime --stop-datetime 播放；2) 文件：ext4 若 inode 未复用可 testdisk/photorect 恢复，立即停写该分区；3) 云数据库用控制台时间点恢复（PITR）；4) 恢复后校验行数与关键字段，业务确认后关闭应急。
【预防】UPDATE/DELETE 强制带 WHERE 并先 SELECT 预览；生产库账号区分只读/读写；每日备份+binlog≥7 天，季度恢复演练。`
  },
  {
    id: 'builtin-incident-ddos',
    title: '应急响应：DDoS/CC 攻击缓解',
    category: '监控与应急',
    content: `【现象】带宽打满或 Web 层请求暴增，正常用户无法访问。
【诊断】1) 层次判断：带宽耗尽（外层流量突增，iftop 看源 IP 分布）vs 应用层 CC（QPS 暴涨但带宽不大，nginx access.log 聚合 URI 与 UA）；2) 攻击特征：请求 URI 集中、UA 异常、单一 IP 高频、地理集中；3) 确认真实用户占比与核心接口。
【处理】1) 云环境：立即开启云厂商 DDoS 高防/IP 洗涤（控制台一键）；2) 边缘限速：nginx limit_req/limit_conn 按 IP 限流（limit_req_zone $binary_remote_addr zone=one:10m rate=10r/s）；3) CC 防护：WAF 规则、验证码/JS 挑战放行真人；4) 黑洞/封禁源 IP（uFW deny 或安全组）；5) 缩暴露面：非核心域名先下线；6) 通报并保留日志取证。
【预防】接入高防/CDN 前置；分层限流基线预置；压测了解自身承载阈值；应急预案与厂商联系方式演练到位。`
  },
  {
    id: 'builtin-ops-release-rollback',
    title: '发布回滚流程',
    category: '监控与应急',
    content: `【现象】新版本发布后异常，需要快速回滚。
【诊断】确认异常与版本相关（对比上一版本行为）、影响范围（接口错误率曲线）、回滚方式（部署系统一键 or 手动）；检查是否有不可逆变更（数据库 schema 变更、数据迁移）。
【处理】标准流程：1) 决策：错误率 > 阈值或核心功能不可用立即回滚，不等根因查清；2) 回滚执行：部署平台回滚到上一版本或镜像 tag；3) 数据库兼容：回滚代码须兼容新 schema（变更遵循"先加后删"两阶段，保证任一方向可回滚）；4) 验证：关键路径冒烟 + 错误率恢复曲线；5) 复现排查：本地/预发复现后再修复前滚。
【预防】发布清单含回滚步骤与预计耗时；灰度发布（5%→20%→100%）每档观察 15 分钟；不可逆操作单独走变更审批。`
  }
];
