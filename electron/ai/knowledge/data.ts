/**
 * 内置知识库 · 数据库与中间件（20 篇）
 */

export const DATA_KNOWLEDGE = [
  {
    id: 'builtin-db-mysql-connections',
    title: 'MySQL 连接数占满（Too many connections）',
    category: '数据库',
    content: `【现象】应用报 Too many connections，无法新建连接。
【诊断】SHOW GLOBAL STATUS LIKE 'Threads_connected' 与 max_connections 对比；SHOW PROCESSLIST 看连接来源与状态（Sleep 空闲连接堆积最常见）；SHOW GLOBAL VARIABLES LIKE 'max_connections'。
【处理】1) 紧急：SHOW PROCESSLIST 找长 Sleep/异常连接 KILL <id>；2) 调大：SET GLOBAL max_connections=500（持久化到 my.cnf）；3) 根因治理：应用侧配连接池（HikariCP maximumPoolSize、maxIdle）并设 wait_timeout 回收空闲连接（interactive_timeout/wait_timeout=600）；4) 若连接被慢查询堵住：先解决慢 SQL。
【预防】连接数监控（Threads_connected/max_connections > 80% 告警）；应用与数据库连接池配比核算（应用实例数×池大小 < max_connections）。`
  },
  {
    id: 'builtin-db-mysql-slow-query',
    title: 'MySQL 慢查询定位与优化',
    category: '数据库',
    content: `【现象】数据库响应慢、CPU 高，应用超时增多。
【诊断】slow_query_log=ON、long_query_time=1 开启慢日志；SHOW PROCESSLIST 看当前执行长的 SQL；EXPLAIN 分析执行计划（type=ALL 全表扫描、rows 过大、Using filesort/temporary）；sys.statement_analysis 视图聚合。
【处理】1) 高频慢 SQL：加合适索引（联合索引遵循最左前缀），EXPLAIN 确认 type 变 range/ref；2) 确无用索引清理：SHOW INDEX 看冗余；3) 大表深度分页改游标（WHERE id > ? LIMIT n）；4) 临时表/文件排序：优化 JOIN 顺序与索引；5) 读写分离或归档历史数据。
【预防】上线前对核心 SQL EXPLAIN 审查；慢查询日志接入监控统计 Top N；大表变更走 pt-online-schema-change。`
  },
  {
    id: 'builtin-db-mysql-replication-lag',
    title: 'MySQL 主从复制延迟',
    category: '数据库',
    content: `【现象】从库 Seconds_Behind_Master 持续增大或为 NULL。
【诊断】SHOW SLAVE STATUS 看 Seconds_Behind_Master、Slave_SQL_Running（报错则为断开）、延迟数值变化趋势；主库 SHOW MASTER LOG 看大事务；从库性能（单线程回放瓶颈）。
【处理】1) SQL 线程报错：按报错定位（表不存在/重复键）→ 跳过错误 STOP SLAVE; SET GLOBAL sql_slave_skip_counter=1; START SLAVE（谨慎，仅确认无害时）或从备份恢复；2) 大事务：拆分批量提交；3) 单线程瓶颈：MySQL 5.7+ 开 slave_parallel_workers=8、slave_parallel_type=LOGICAL_CLOCK；4) 从库硬件/IO 优化。
【预防】监控延迟告警（>10s）；避免主库大事务；从库用 SSD 并与主库同规格。`
  },
  {
    id: 'builtin-db-mysql-binlog-full',
    title: 'MySQL binlog 占满磁盘',
    category: '数据库',
    content: `【现象】数据库磁盘满，服务拒绝写入；/var/lib/mysql 下 binlog 文件堆积。
【诊断】df -h 确认分区；SHOW BINARY LOGS 看各 binlog 大小；SHOW VARIABLES LIKE 'expire_logs_days' / 'binlog_expire_logs_seconds' 看保留策略；du -sh 查 binlog 目录。
【处理】1) 紧急清理：PURGE BINARY LOGS BEFORE DATE_SUB(NOW(), INTERVAL 3)（确认从库已同步/不需 PITR）；2) 设自动过期：SET GLOBAL binlog_expire_logs_seconds=259200（3 天，写入 my.cnf 持久化）；3) 若从库还在拉取：先确认从库位点再清；4) 磁盘满导致服务异常：清理后 RESTART。
【预防】binlog 过期 ≥ 主从延迟余量 + 备份周期；磁盘 80% 告警提前发现；大事务控制减少 binlog 膨胀。`
  },
  {
    id: 'builtin-db-postgres-connections',
    title: 'PostgreSQL 连接与性能问题',
    category: '数据库',
    content: `【现象】PG 报 too many connections 或查询缓慢。
【诊断】SELECT count(*), state FROM pg_stat_activity GROUP BY state; 看连接数与状态分布；pg_stat_statements 看 Top 慢 SQL（需 shared_preload_libraries）；EXPLAIN ANALYZE 分析执行计划。
【处理】1) 连接满：调 max_connections（默认 100 偏小）或前置 pgbouncer 连接池（生产推荐 pgbouncer）；2) 空闲连接：设置 idle_in_transaction_session_timeout 自动清理；3) 慢查询：加索引、调 work_mem（防每连接过大）、autovacuum 确认在跑（表膨胀会导致性能劣化）；4) 锁等待：pg_locks 查阻塞链。
【预防】连接池统一收口；慢查询日志 log_min_duration_statement=500；autovacuum 参数按表规模调优。`
  },
  {
    id: 'builtin-db-backup-restore',
    title: '数据库备份与恢复验证',
    category: '数据库',
    content: `【现象】需要建立备份策略或恢复演练。
【诊断】现状核查：mysqldump/xtrabackup/pg_dump 是否定时跑、备份文件完整性（大小、日期）、异地存放、最近一次恢复演练时间。
【处理】1) MySQL 逻辑备份：mysqldump --all-databases --single-transaction --routines --triggers > backup.sql（配合 cron 每日执行）；2) 大库用 xtrabackup 物理备份；3) 恢复验证：mysql < backup.sql 到临时实例，抽查表与行数；4) 保留策略：本地 7 天 + 异地/对象存储 30 天；5) binlog 保留以支持按时间点恢复（PITR）。
【预防】备份三副本原则（本地+异地+一份离线）；每月恢复演练并记录 RTO/RPO；备份有效性监控（完成心跳+大小突变告警）。`
  },
  {
    id: 'builtin-db-redis-memory',
    title: 'Redis 内存满与驱逐策略',
    category: '数据库',
    content: `【现象】Redis 报 OOM command not allowed 或内存持续增长。
【诊断】INFO memory 看 used_memory_human 与 maxmemory；INFO stats 看 evicted_keys（驱逐计数）；CONFIG GET maxmemory-policy 看当前淘汰策略；bigkeys 扫大 key。
【处理】1) 设上限与策略：CONFIG SET maxmemory 8gb、maxmemory-policy allkeys-lru（缓存场景）或 volatile-lru（有 TTL 的键优先）；持久化场景勿用 allkeys-* 防丢数据；2) 大 key 清理：redis-cli --bigkeys 定位后 UNLINK 异步删除（勿 DEL 阻塞）；3) 内存碎片：INFO memory mem_fragmentation_ratio>1.5 考虑重启或 activedefrag；4) 过期键堆积：expire批量设置。
【预防】maxmemory 必须设置（默认 0=无限会打爆内存）；内存使用率 70% 告警；业务键设计设 TTL。`
  },
  {
    id: 'builtin-db-redis-persistence',
    title: 'Redis 持久化与故障恢复',
    category: '数据库',
    content: `【现象】Redis 重启后数据丢失，或持久化文件异常。
【诊断】CONFIG GET save 看 RDB 策略；CONFIG GET appendonly 看 AOF 是否开启；redis.log 中 Background saving / AOF 错误；磁盘满会导致持久化失败。
【处理】1) 生产建议 AOF + RDB 组合：appendonly yes、appendfsync everysec、save 900 1；2) AOF 损坏修复：redis-check-aof --fix appendonly.aof；3) RDB 损坏换用上一个正常 dump.rdb；4) 主从 + 哨兵/Cluster 保障高可用，单点故障自动切换；5) 恢复：停实例、放回 dump.rdb、启服务。
【预防】持久化文件纳入备份；AOF 与磁盘空间监控；定期跑 redis-cli --rdb 测试持久化可用。`
  },
  {
    id: 'builtin-db-mongodb',
    title: 'MongoDB 常见故障处理',
    category: '数据库',
    content: `【现象】MongoDB 连接失败、查询缓慢或副本集异常。
【诊断】mongosh 执行 rs.status() 看副本集成员状态（SECONDARY 掉线、PRIMARY 选举）；db.serverStatus() 看连接与锁；慢查询开 profiler：db.setProfilingLevel(1, 200)；磁盘与 journal 空间。
【处理】1) 成员 down：确认网络与 auth.log，重新启动 mongod，必要时 rs.remove/add 重建；2) 选举失败：多数派不足，检查主机与 votes 配置；3) 慢查询：ensureIndex 建索引（db.coll.createIndex({field:1})）；4) 内存：wiredTigerCacheSizeGB 默认取内存 50% 上限 10GB，容器内注意 cgroup 限制误判；5) 磁盘满：清理 journal（--journalCommitInterval 调优）与 oplog 调整（rs.printReplicationInfo）。
【预防】副本集 ≥3 节点跨机架；监控主从状态与连接数；索引覆盖查询字段清单。`
  },
  {
    id: 'builtin-web-nginx-502',
    title: 'Nginx 502/504 Bad Gateway',
    category: 'Web与中间件',
    content: `【现象】访问站点间歇或持续返回 502 Bad Gateway / 504 Gateway Time-out。
【诊断】1) 502：后端进程挂了或端口不通：curl 127.0.0.1:<upstream_port> 直测；ss -lntp 看后端监听；2) 504：后端慢/卡死：后端日志、慢查询、下游超时；3) Nginx error.log 看 connect() failed / upstream timed out 具体原因；4) 检查 proxy_buffer 是否撑爆（large_client_header_buffers）。
【处理】1) 后端挂：systemctl restart <后端> 并查崩溃日志；2) 连接数不足：upstream 中 keepalive、后端 worker_connections 调整；3) 超时调大：proxy_connect_timeout 5s、proxy_read_timeout 120s（按业务）；4) unix socket 场景检查权限；5) 后端 5xx 引起的 502：修后端。
【预防】后端健康检查与自动拉起；error_log 告警；upstream 多实例冗余。`
  },
  {
    id: 'builtin-web-nginx-404',
    title: 'Nginx 404 与静态资源问题',
    category: 'Web与中间件',
    content: `【现象】页面或接口返回 404，静态资源 404。
【诊断】看 error.log 中 404 的 URI；确认 root/alias 指向目录与实际文件路径（末尾斜杠陷阱：location /static/ { alias /data/static/; } 拼接差异）；SPA 单页应用刷新 404 是缺少 try_files 回退；权限：nginx worker 用户（www-data/nginx）对文件有无读取权限（permission denied 常伪装 404）。
【处理】1) 路径修正：nginx -T | grep -A5 location 核对配置；2) SPA 回退：try_files $uri $uri/ /index.html；3) 权限：chown -R nginx:nginx <目录> && chmod 755；4) 文件确实不存在：部署脚本核对产物路径；5) 改完 nginx -t && nginx -s reload。
【预防】部署后 curl 关键路径做冒烟检查；目录权限纳入部署基线。`
  },
  {
    id: 'builtin-web-nginx-reload',
    title: 'Nginx 配置语法检查与热重载',
    category: 'Web与中间件',
    content: `【现象】改 Nginx 配置怕改错断服务，或 reload 不生效。
【诊断】nginx -t 输出 syntax is ok / test is successful 才可重载；nginx -T 输出合并后完整配置（含 include）；nginx -V 看编译参数与配置路径（/etc/nginx/nginx.conf）。
【处理】1) 标准流程：vim 改配置 → nginx -t 校验 → nginx -s reload（或 systemctl reload nginx）；2) reload 零停机：旧 worker 处理完存量连接后退出，新连接走新配置；3) 大版本升级：nginx -s quit 优雅退出再启；4) 配置报错回滚：git/备份恢复后再次 reload；5) 端口被占启动失败：ss -lntp 查占用。
【预防】配置进 git 版本管理；变更窗口操作并保留回滚命令；用 nginx -T 输出归档基线。`
  },
  {
    id: 'builtin-web-tomcat',
    title: 'Tomcat 内存与线程问题',
    category: 'Web与中间件',
    content: `【现象】Tomcat 响应变慢、OutOfMemoryError 或线程堆满。
【诊断】catalina.out 看异常栈；jstat -gc <pid> 1s 看老年代是否只增不减（泄漏）；jstack <pid> 抓线程栈，grep http-nio 线程数是否打满 maxThreads；netstat 看连接积压。
【处理】1) OOM：调 catalina.sh 中 CATALINA_OPTS="-Xms2g -Xmx4g -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/tmp"，拿到 heap dump 用 MAT 分析；2) 线程满：server.xml 中 maxThreads 调大或优化慢接口（根因是下游慢）；3) 会话内存：改 Redis Session 或缩短 session timeout；4) 僵死线程：jstack 输出中出现大量 WAITING 且业务无进展，查锁竞争。
【预防】JVM 参数统一基线；接入 APM 看 GC 与线程指标；-XX:+ExitOnOutOfMemoryError 快速失败重启。`
  },
  {
    id: 'builtin-docker-start-fail',
    title: 'Docker 容器启动失败排查',
    category: 'Web与中间件',
    content: `【现象】docker run 报错退出，或容器反复重启。
【诊断】docker logs --tail 100 <容器> 看应用日志；docker inspect <容器> 看 State.ExitCode 与 OOMKilled（137=被 OOM 杀）；docker events 看启动序列；宿主侧 dmesg | grep -i oom 看内核 OOM。
【处理】1) 应用配置错（端口/路径/环境变量）：按日志修 Dockerfile 或 -e 参数；2) OOMKilled：-m 内存限制太小或应用泄漏，调 --memory 或查泄漏；3) 127/入口命令不存在：检查 Dockerfile WORKDIR 与 CMD 路径、文件是否 COPY 进去；4) 端口冲突：-p 映射宿主端口被占，换端口；5) 反复重启：restart policy 为 always 时先 docker stop再排查，避免日志刷屏。
【预防】镜像构建后本地先跑通；设合理资源限制与 healthcheck；退出码纳入监控。`
  },
  {
    id: 'builtin-docker-disk-full',
    title: 'Docker 磁盘占满清理',
    category: 'Web与中间件',
    content: `【现象】/var/lib/docker 占用数百 GB，磁盘告警。
【诊断】docker system df 看镜像/容器/卷/构建缓存占用；docker images -a | head、docker ps -a 看悬空对象；du -sh /var/lib/docker/overlay2 定位。
【处理】1) 清悬空镜像与停止容器：docker image prune -f && docker container prune -f；2) 深度清理（确认无用镜像后）：docker system prune -a --volumes -f；3) 构建缓存：docker builder prune；4) 日志撑爆：/var/lib/docker/containers/*/*-json.log 轮转，daemon.json 配 "log-opts": {"max-size": "50m", "max-file": "3"}；5) 迁移数据盘：停服务、mv /var/lib/docker /data/docker、软链回来。
【预防】log-opts 限额必配；定期 docker system prune 纳入巡检；镜像仓库定期清理冗余 tag。`
  },
  {
    id: 'builtin-sysd-service-manage',
    title: 'systemd 服务管理速查',
    category: 'Web与中间件',
    content: `【现象】需要查看、启动、重启或开机自启服务。
【诊断】systemctl status <服务> 看状态与最近日志；systemctl cat <服务> 看 unit 文件内容与来源；journalctl -u <服务> -f 实时日志。
【处理】常用命令：systemctl start/stop/restart/reload <服务>；systemctl enable/disable 设置自启；systemctl daemon-reload 修改 unit 文件后必执行；查看依赖：systemctl list-dependencies <服务>；失败排查：systemctl --failed 列出启动失败单元。自定义服务写 /etc/systemd/system/<名>.service（ExecStart 绝对路径、Restart=always、WantedBy=multi-user.target）。
【预防】所有业务服务 systemd 化；unit 文件进 git；变更后 daemon-reload 再 restart。`
  },
  {
    id: 'builtin-mq-backlog',
    title: '消息队列积压处理（RabbitMQ/Kafka）',
    category: 'Web与中间件',
    content: `【现象】MQ 消息堆积持续增长，消费延迟，下游告警。
【诊断】RabbitMQ：rabbitmqctl list_queues name messages consumers 看各队列堆积与消费者数；Kafka：kafka-consumer-groups.sh --describe --group <组> 看 LAG；确认是消费端故障（重启、异常）还是流量突增（对比生产速率）。
【处理】1) 消费者挂了：恢复消费者实例，优先级最高；2) 消费慢：扩消费者（Kafka 分区数限制并行度需同步扩分区）、优化消费逻辑（批量 DB 写、异步化）、查下游瓶颈；3) 紧急泄洪：临时扩容消费组或对可丢弃消息跳过（Kafka seek 到最新 offset，需业务确认）；4) 死信队列处理异常消息防阻塞。
【预防】堆积量与消费延迟双告警；容量按峰值流量 2 倍设计；消费端幂等设计。`
  },
  {
    id: 'builtin-es-health',
    title: 'Elasticsearch 集群红黄绿状态',
    category: 'Web与中间件',
    content: `【现象】集群 health 从 green 变 yellow 或 red，写入/查询报错。
【诊断】GET _cluster/health 看 status 与未分配分片数；GET _cat/shards?v 找 unassigned 分片与原因（GET _cluster/allocation/explain）；yellow 通常=副本分片无节点可放（单节点副本数>0）；red=主分片丢失（数据损坏或节点宕）。
【处理】1) yellow 单节点：副本改 0（PUT idx/_settings {"number_of_replicas":0}）或加节点；2) 节点宕机导致 unassigned：等节点回来自动分配，或手动 reroute；3) red：定位损坏分片，从副本/快照恢复（DELETE坏分片后 restore）；4) 磁盘水位：flood_stage 阻写，清理或调 cluster.routing.allocation.disk.watermark；5) 堆内存：-Xms 与 -Xmx 设为物理内存一半且不超 32GB。
【预防】至少 3 节点跨机架；磁盘水位 75% 告警；每日快照到对象存储。`
  },
  {
    id: 'builtin-db-lock-wait',
    title: '数据库锁等待与死锁处理',
    category: '数据库',
    content: `【现象】应用卡住、事务长时间不提交，MySQL 报 Deadlock found。
【诊断】MySQL：SHOW ENGINE INNODB STATUS 看 LATEST DETECTED DEADLOCK 段（事务顺序、持有的锁）；information_schema.innodb_trx 看运行中事务（trx_started 越久越可疑）；sys.innodb_lock_waits 看等待链。PostgreSQL：pg_locks + pg_stat_activity 组合查阻塞者。
【处理】1) 死锁：InnoDB 自动回滚一方，应用捕获异常重试即可；2) 长事务阻塞：定位长事务（未提交的 BEGIN）确认是否应用 bug，必要时 KILL <trx_mysql_thread_id>；3) 优化：统一事务内访问顺序（按主键排序更新）缩短持锁时间、拆大事务、降低隔离级别（业务允许时 RC）；4) 热点行更新：改队列串行化或乐观锁重试。
【预防】事务超时设置（innodb_lock_wait_timeout=10）；慢事务监控（trx_started>10s 告警）；避免在事务内调用外部接口。`
  }
];
