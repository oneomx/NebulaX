/**
 * 数据库专项 AI 诊断（v1.7）
 * 基于预置采集 SQL（MySQL/PostgreSQL 方言）在远端执行，采集状态数据后：
 * - 本地规则先做确定性判断（连接数/慢查询/锁等待/复制延迟）
 * - AI 再做综合分析，输出结构化诊断报告
 *
 * 采集全部只读（SHOW/SELECT/performance_schema），不改任何数据。
 */
import { chat, type ChatMessage } from '../ai';
import { resolveRoute } from './router';
import { chatJson, type FieldSpec } from './schema';

export type DbDialect = 'mysql' | 'postgres';

export interface DbCollectItem {
  id: string;
  label: string;
  /** 只读采集 SQL（单条，由调用方经 SSH 执行） */
  sql: string;
  /** 单条超时（ms） */
  timeoutMs?: number;
}

export interface DbSampleResult {
  id: string;
  label: string;
  ok: boolean;
  /** TSV 文本（首行表头）或错误信息 */
  output: string;
  error?: string;
}

export interface DbFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  /** 当前值（可展示） */
  currentValue?: string;
  /** 建议值 */
  recommended?: string;
  /** 可执行的修复/优化 SQL（只读检查或明确的 DDL，由用户确认后执行） */
  command?: string;
  source: 'rule' | 'ai';
}

export interface DbDiagReport {
  dialect: DbDialect;
  summary: string;
  findings: DbFinding[];
  /** 未采集成功的项（不影响整体报告） */
  failedSamples: string[];
}

/** 采集清单（MySQL）：连接/慢查询/锁/复制/容量/大表 */
export const MYSQL_COLLECT: DbCollectItem[] = [
  {
    id: 'conn',
    label: '连接数与上限',
    sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Max_used_connections','Aborted_connects','Connection_errors_max_connections'); SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','wait_timeout');"
  },
  {
    id: 'slow',
    label: '慢查询与全表扫描',
    sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Slow_queries','Select_scan','Select_full_join'); SHOW GLOBAL VARIABLES WHERE Variable_name IN ('slow_query_log','long_query_time');"
  },
  {
    id: 'innodb',
    label: 'InnoDB 缓冲池与行锁',
    sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests','Innodb_row_lock_waits','Innodb_row_lock_time_avg','Innodb_log_waits'); SHOW GLOBAL VARIABLES WHERE Variable_name IN ('innodb_buffer_pool_size');"
  },
  {
    id: 'queries',
    label: '查询吞吐与临时表',
    sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Questions','Com_commit','Com_rollback','Created_tmp_disk_tables','Created_tmp_tables','Handler_read_rnd_next');"
  },
  {
    id: 'processlist',
    label: '当前活跃查询 Top 10',
    sql: 'SELECT id, db, user, command, time, state, LEFT(info, 120) AS query FROM information_schema.processlist WHERE command != "Sleep" AND info IS NOT NULL ORDER BY time DESC LIMIT 10;',
    timeoutMs: 8000
  },
  {
    id: 'repl',
    label: '主从复制状态',
    sql: 'SHOW SLAVE STATUS\\G',
    timeoutMs: 8000
  },
  {
    id: 'bigs',
    label: '最大的 8 张表',
    sql: 'SELECT table_name, ROUND((data_length+index_length)/1024/1024,1) AS size_mb, table_rows FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY (data_length+index_length) DESC LIMIT 8;',
    timeoutMs: 15000
  }
];

/** 采集清单（PostgreSQL）：连接/缓存/锁/复制/表大小 */
export const POSTGRES_COLLECT: DbCollectItem[] = [
  {
    id: 'conn',
    label: '连接数与上限',
    sql: "SELECT count(*) AS current_conn, (SELECT setting FROM pg_settings WHERE name='max_connections') AS max_conn, count(*) FILTER (WHERE state='active') AS active_conn, count(*) FILTER (WHERE state='idle') AS idle_conn FROM pg_stat_activity;"
  },
  {
    id: 'slow',
    label: '慢查询 Top 10',
    sql: "SELECT pid, now()-query_start AS duration, state, LEFT(query,120) AS query FROM pg_stat_activity WHERE state='active' AND now()-query_start > interval '3 seconds' ORDER BY duration DESC LIMIT 10;"
  },
  {
    id: 'cache',
    label: '缓存命中率',
    sql: "SELECT 'hit_ratio' AS metric, round(100.0*blks_hit/nullif(blks_hit+blks_read,0),2) AS value FROM pg_stat_database WHERE datname=current_database();"
  },
  {
    id: 'lock',
    label: '锁等待',
    sql: "SELECT blocked_locks.pid AS blocked_pid, blocking_locks.pid AS blocking_pid, left(blocked_activity.query,100) AS blocked_query FROM pg_locks blocked_locks JOIN pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid NOT IN (SELECT pid FROM pg_locks WHERE NOT granted) WHERE NOT blocked_locks.granted LIMIT 10;",
    timeoutMs: 8000
  },
  {
    id: 'repl',
    label: '复制槽状态',
    sql: "SELECT slot_name, active, restart_lsn, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS replication_lag FROM pg_replication_slots;",
    timeoutMs: 8000
  },
  {
    id: 'bigs',
    label: '最大的 8 张表',
    sql: "SELECT relname AS table_name, pg_size_pretty(pg_total_relation_size(relid)) AS total_size, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 8;",
    timeoutMs: 15000
  }
];

export function collectItems(dialect: DbDialect): DbCollectItem[] {
  return dialect === 'mysql' ? MYSQL_COLLECT : POSTGRES_COLLECT;
}

/** 把采集结果解析成 TSV 行（首行表头）；失败项跳过 */
function tsvRows(sample: DbSampleResult): Record<string, string>[] {
  if (!sample.ok) return [];
  const lines = sample.output.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ''));
    return row;
  });
}

function num(v: unknown): number {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 本地规则诊断（纯函数，可单测）：对采集结果做确定性判断。
 * 覆盖连接数打满、慢查询高、缓冲池命中率低、行锁等待多、磁盘表临时表、大表等。
 */
export function localDbFindings(dialect: DbDialect, samples: DbSampleResult[]): DbFinding[] {
  const out: DbFinding[] = [];
  const get = (id: string) => samples.find((s) => s.id === id);

  // ---- 连接数 ----
  const conn = get('conn');
  if (conn?.ok) {
    const rows = tsvRows(conn);
    if (dialect === 'mysql') {
      const byName = new Map(rows.map((r) => [r.Variable_name || r.variable_name, r.Value || r.value]));
      const cur = num(byName.get('Threads_connected'));
      const maxUsed = num(byName.get('Max_used_connections'));
      const maxConn = num(byName.get('max_connections'));
      const aborted = num(byName.get('Aborted_connects'));
      if (Number.isFinite(cur) && Number.isFinite(maxConn) && maxConn > 0) {
        const pct = (cur / maxConn) * 100;
        if (pct >= 90) {
          out.push({
            severity: 'critical',
            title: '连接数接近上限',
            detail: `当前连接 ${cur}/${maxConn}（${pct.toFixed(0)}%），峰值 ${Number.isFinite(maxUsed) ? maxUsed : '?'}。可能随时出现 Too many connections。`,
            currentValue: `${cur}/${maxConn}`,
            recommended: '排查连接池配置与长连接堆积；必要时调大 max_connections 并重启应用连接池',
            command: "SHOW FULL PROCESSLIST;  -- 查看连接来源\nSHOW VARIABLES LIKE 'wait_timeout';  -- 空闲连接回收",
            source: 'rule'
          });
        } else if (pct >= 70) {
          out.push({
            severity: 'medium',
            title: '连接数偏高',
            detail: `当前连接 ${cur}/${maxConn}（${pct.toFixed(0)}%），建议关注增长趋势。`,
            currentValue: `${cur}/${maxConn}`,
            source: 'rule'
          });
        }
      }
      if (Number.isFinite(aborted) && aborted > 100) {
        out.push({
          severity: 'medium',
          title: '连接失败累计较多',
          detail: `Aborted_connects=${aborted}，存在客户端连接被拒或异常断开。`,
          currentValue: String(aborted),
          source: 'rule'
        });
      }
    } else {
      // postgres: 行为 count(*) / max_conn 字段
      const cur = num(rows[0]?.current_conn);
      const maxConn = num(rows[0]?.max_conn);
      const idle = num(rows[0]?.idle_conn);
      if (Number.isFinite(cur) && Number.isFinite(maxConn) && maxConn > 0 && cur / maxConn >= 0.9) {
        out.push({
          severity: 'critical',
          title: '连接数接近上限',
          detail: `当前连接 ${cur}/${maxConn}，其中 idle=${Number.isFinite(idle) ? idle : '?'}（空闲连接过多说明应用侧未复用）。`,
          currentValue: `${cur}/${maxConn}`,
          recommended: '检查应用连接池 minIdle/maxIdle 配置，回收空闲连接',
          source: 'rule'
        });
      }
    }
  }

  // ---- 慢查询 ----
  const slow = get('slow');
  if (slow?.ok) {
    const rows = tsvRows(slow);
    if (dialect === 'mysql') {
      const byName = new Map(rows.map((r) => [r.Variable_name || r.variable_name, r.Value || r.value]));
      const slowQ = num(byName.get('Slow_queries'));
      const scan = num(byName.get('Select_scan'));
      const diskTmp = num(byName.get('Created_tmp_disk_tables'));
      if (Number.isFinite(slowQ) && slowQ > 50) {
        out.push({
          severity: 'medium',
          title: '慢查询累计较多',
          detail: `Slow_queries=${slowQ}，Select_scan=${Number.isFinite(scan) ? scan : '?'}（全表扫描次数）。`,
          currentValue: String(slowQ),
          recommended: '开启慢查询日志定位 Top SQL，为高频 WHERE/JOIN 列加索引',
          command: "SET GLOBAL slow_query_log=ON; SET GLOBAL long_query_time=1;",
          source: 'rule'
        });
      }
      if (Number.isFinite(diskTmp) && diskTmp > 100) {
        out.push({
          severity: 'medium',
          title: '磁盘临时表较多',
          detail: `Created_tmp_disk_tables=${diskTmp}，说明内存不足或排序字段缺索引，IO 压力增大。`,
          currentValue: String(diskTmp),
          recommended: '调大 tmp_table_size/max_heap_table_size，或为 ORDER BY/GROUP BY 字段加索引',
          source: 'rule'
        });
      }
    } else {
      // postgres 慢查询行本身即时长
      if (rows.length >= 3) {
        out.push({
          severity: 'medium',
          title: '存在多个慢查询（>3s）',
          detail: `当前活跃慢查询 ${rows.length} 条，最长 ${rows[0]?.duration || '?'}。`,
          currentValue: `${rows.length} 条`,
          recommended: '用 EXPLAIN ANALYZE 分析 Top SQL，检查缺失索引与 JOIN 策略',
          source: 'rule'
        });
      }
    }
  }

  // ---- InnoDB / 缓存 ----
  const innodb = get('innodb') || get('cache');
  if (innodb?.ok) {
    const rows = tsvRows(innodb);
    if (dialect === 'mysql') {
      const byName = new Map(rows.map((r) => [r.Variable_name || r.variable_name, r.Value || r.value]));
      const reads = num(byName.get('Innodb_buffer_pool_reads'));
      const reqs = num(byName.get('Innodb_buffer_pool_read_requests'));
      if (Number.isFinite(reads) && Number.isFinite(reqs) && reads + reqs > 1000) {
        const hit = (reqs / (reads + reqs)) * 100;
        if (hit < 95) {
          out.push({
            severity: hit < 90 ? 'high' : 'medium',
            title: 'InnoDB 缓冲池命中率偏低',
            detail: `命中率 ${hit.toFixed(2)}%（磁盘读 ${reads} 次）。低于 95% 说明 buffer_pool_size 不足，查询频繁落盘。`,
            currentValue: `${hit.toFixed(2)}%`,
            recommended: '将 innodb_buffer_pool_size 调到物理内存的 50-70%（需重启）',
            source: 'rule'
          });
        }
      }
      const lockWaits = num(byName.get('Innodb_row_lock_waits'));
      const lockAvg = num(byName.get('Innodb_row_lock_time_avg'));
      if (Number.isFinite(lockWaits) && lockWaits > 100 && Number.isFinite(lockAvg) && lockAvg > 500) {
        out.push({
          severity: 'high',
          title: '行锁等待较多',
          detail: `行锁等待 ${lockWaits} 次，平均 ${lockAvg}ms。可能存在长事务或热点行竞争。`,
          currentValue: `${lockWaits} 次 / ${lockAvg}ms`,
          recommended: '检查长事务（information_schema.innodb_trx），拆分大事务、优化热点行更新',
          source: 'rule'
        });
      }
    } else {
      const hit = num(rows[0]?.value);
      if (Number.isFinite(hit) && hit < 95) {
        out.push({
          severity: hit < 90 ? 'high' : 'medium',
          title: '缓存命中率偏低',
          detail: `共享缓冲区命中率 ${hit.toFixed(2)}%，低于 95% 说明 shared_buffers 不足。`,
          currentValue: `${hit.toFixed(2)}%`,
          recommended: "调大 shared_buffers（建议内存 25%）并检查 effective_cache_size",
          source: 'rule'
        });
      }
    }
  }

  // ---- 复制延迟 ----
  const repl = get('repl');
  if (repl) {
    if (!repl.ok) {
      // 采集失败不报问题（可能非主从架构）
    } else if (dialect === 'mysql') {
      const m = repl.output.match(/Seconds_Behind_Master:\s*(\d+)/);
      const ioRunning = /Slave_IO_Running:\s*(\w+)/.exec(repl.output);
      const sqlRunning = /Slave_SQL_Running:\s*(\w+)/.exec(repl.output);
      if (ioRunning && ioRunning[1] === 'No') {
        out.push({
          severity: 'critical',
          title: '复制 IO 线程已停止',
          detail: 'Slave_IO_Running=No，从库已停止拉取 binlog，复制中断。',
          recommended: '检查网络连通、主库 binlog 位置与凭据',
          command: 'SHOW SLAVE STATUS\\G  -- 查看 Last_IO_Error',
          source: 'rule'
        });
      } else if (sqlRunning && sqlRunning[1] === 'No') {
        out.push({
          severity: 'critical',
          title: '复制 SQL 线程已停止',
          detail: 'Slave_SQL_Running=No，从库回放中断，数据已不一致。',
          recommended: '查看 Last_SQL_Error，修复冲突后 START SLAVE',
          source: 'rule'
        });
      } else if (m && num(m[1]) > 30) {
        out.push({
          severity: num(m[1]) > 300 ? 'critical' : 'high',
          title: '主从复制延迟较大',
          detail: `Seconds_Behind_Master=${m[1]} 秒，读写分离可能出现数据不一致。`,
          currentValue: `${m[1]}s`,
          recommended: '检查从库回放并发（slave_parallel_workers）、大事务与从库负载',
          source: 'rule'
        });
      }
    } else {
      const lagMatch = /(\d+(?:\.\d+)?)\s*(?:kB|MB|GB|B)?\s*$/m.exec(repl.output.split('\n').find((l) => l.includes('replication_lag')) || '');
      if (lagMatch) {
        // pg_wal_lsn_diff 输出带单位，粗略提示即可
        out.push({
          severity: 'info',
          title: '复制延迟已采集',
          detail: `复制槽延迟：${lagMatch[0].trim()}。持续增大需关注从库性能。`,
          source: 'rule'
        });
      }
    }
  }

  // ---- 大表 ----
  const bigs = get('bigs');
  if (bigs?.ok) {
    const rows = tsvRows(bigs);
    const first = rows[0];
    if (first) {
      const sizeStr = first.size_mb || first.total_size || '';
      const sizeMb = num(sizeStr);
      const name = first.table_name || '?';
      if ((Number.isFinite(sizeMb) && sizeMb > 10240) || /GB/.test(sizeStr)) {
        out.push({
          severity: 'medium',
          title: '存在超大表',
          detail: `表 ${name} 大小 ${sizeStr}${Number.isFinite(sizeMb) ? 'MB' : ''}，会影响备份与 DDL 耗时。`,
          currentValue: `${name}: ${sizeStr}`,
          recommended: '评估分区/归档策略；DDL 用 gh-ost/pt-online-schema-change 避免锁表',
          source: 'rule'
        });
      }
    }
  }

  return out;
}

const DB_REPORT_SPEC: FieldSpec = {
  type: 'object',
  required: true,
  fields: {
    summary: { type: 'string', required: true },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        fields: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          title: { type: 'string', required: true },
          detail: { type: 'string' },
          currentValue: { type: 'string' },
          recommended: { type: 'string' },
          command: { type: 'string' }
        }
      }
    }
  }
};

const DB_SYSTEM_PROMPT = `你是 NebulaX 数据库诊断专家。输入是数据库状态采集结果（SHOW STATUS/系统视图查询输出，TSV 格式）。
任务：综合分析，找出性能瓶颈与风险，输出结构化诊断 JSON。

判断重点：
- 连接数接近 max_connections、连接失败激增
- 慢查询/全表扫描/磁盘临时表过多
- InnoDB 缓冲池命中率 < 95%、行锁等待多
- 主从复制中断或延迟 > 30s
- 超大表（>10GB）
- 其他与采集数据相关的异常

输出严格 JSON：
{
  "summary": "2-3 句整体评估",
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "title": "简短标题",
      "detail": "问题描述（引用具体数值）",
      "currentValue": "当前值",
      "recommended": "建议",
      "command": "可执行的检查/优化 SQL（只读优先）"
    }
  ]
}
只报告采集数据能支撑的问题，不要编造。没有问题就返回空 findings 数组并说明状态良好。`;

/**
 * 数据库 AI 诊断：本地规则 + AI 综合分析合并。
 * AI 不可用时仍返回本地规则结果（degraded=true）。
 */
export async function diagnoseDatabase(
  dialect: DbDialect,
  samples: DbSampleResult[],
  context?: string
): Promise<{ report: DbDiagReport; degraded: boolean }> {
  const ruleFindings = localDbFindings(dialect, samples);
  const failedSamples = samples.filter((s) => !s.ok).map((s) => s.label);

  const okSamples = samples.filter((s) => s.ok && s.output.trim());
  const samplesText = okSamples.map((s) => `### ${s.label}\n\`\`\`\n${s.output.slice(0, 2500)}\n\`\`\``).join('\n\n');

  let aiFindings: DbFinding[] = [];
  let aiSummary = '';
  let degraded = false;

  if (okSamples.length > 0) {
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: DB_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `数据库类型：${dialect}${context ? `\n业务背景：${context}` : ''}\n\n采集结果：\n\n${samplesText.slice(0, 12000)}\n\n请输出诊断 JSON。`
        }
      ];
      const r = await chatJson<{ summary?: string; findings?: any[] }>(messages, {
        spec: DB_REPORT_SPEC,
        maxTokens: 3000,
        config: resolveRoute('db')
      });
      if (r.ok && r.data) {
        aiSummary = typeof r.data.summary === 'string' ? r.data.summary : '';
        aiFindings = (Array.isArray(r.data.findings) ? r.data.findings : []).map((f) => ({
          severity: (['critical', 'high', 'medium', 'low', 'info'].includes(f?.severity) ? f.severity : 'info') as DbFinding['severity'],
          title: String(f?.title || 'AI 发现'),
          detail: String(f?.detail || ''),
          currentValue: f?.currentValue ? String(f.currentValue) : undefined,
          recommended: f?.recommended ? String(f.recommended) : undefined,
          command: f?.command ? String(f.command) : undefined,
          source: 'ai' as const
        }));
      } else {
        degraded = true;
      }
    } catch {
      degraded = true;
    }
  } else {
    degraded = true;
  }

  // 合并：规则结果优先（确定性），AI 结果去重（标题相近的跳过）
  const merged: DbFinding[] = [...ruleFindings];
  for (const f of aiFindings) {
    const dup = merged.some((m) => m.title === f.title || (m.detail && f.detail && m.detail.slice(0, 30) === f.detail.slice(0, 30)));
    if (!dup) merged.push(f);
  }

  const summary =
    aiSummary ||
    (merged.length === 0
      ? '各项数据库指标均在正常范围内。'
      : `基于 ${okSamples.length} 项采集发现 ${merged.length} 个问题点（${merged.filter((f) => f.severity === 'critical' || f.severity === 'high').length} 个高优先级）。`);

  return { report: { dialect, summary, findings: merged, failedSamples }, degraded };
}
