/**
 * 数据库快速查询 —— 经 SSH 会话在远端执行 mysql/psql CLI。
 * 设计取舍：
 * - 不引数据库驱动（mysql2/pg）：驱动体积大且需逐版本维护协议；远端服务器通常自带 CLI，
 *   经 SSH exec 调用零依赖、天然加密、且"远端连本地库"场景（-h 127.0.0.1）覆盖最常见需求。
 * - 密码经环境变量（MYSQL_PWD / PGPASSWORD）传递，不进 shell 历史、不进进程命令行参数。
 * - 输出格式：mysql 用 batch 模式 TSV（默认转义，字段内换行/制表符不破坏行结构）；
 *   psql 用 CSV（RFC4180，引号内可含逗号/换行）。两者均首行表头，统一解析为结构化结果。
 */

export interface DbConfig {
  type: 'mysql' | 'postgres';
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
}

export interface DbQueryResult {
  columns: string[];
  rows: (string | number | null)[][];
  affectedRows?: number;
  durationMs: number;
  /** 行数被截断时提示（防超大结果撑爆渲染） */
  truncated?: boolean;
}

type ExecFn = (command: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/** POSIX shell 单引号转义 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const MAX_ROWS = 500;

/** 反转义 mysql batch 默认转义序列（\n \t \r \0 \\） */
function unescapeMysqlCell(c: string): string {
  if (!c.includes('\\')) return c;
  return c.replace(/\\(.)/g, (_m, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '0':
        return '\0';
      default:
        return ch; // \\ -> \
    }
  });
}

/** 数字识别：安全范围内转 number，其余保持字符串 */
function coerceCell(c: string): string | number {
  if (c !== '' && /^-?\d+(\.\d+)?$/.test(c)) {
    const n = Number(c);
    if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
  }
  return c;
}

/**
 * 解析 mysql batch TSV（首行表头；NULL 标记为字面 "NULL"）。
 * @param unescape 是否反转义字段（mysql 默认转义 \n/\t/\\，--raw 时关闭）
 */
function parseTsv(stdout: string, unescape = false): { columns: string[]; rows: (string | number | null)[][]; truncated: boolean } {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  // 去掉尾部空行
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return { columns: [], rows: [], truncated: false };
  const columns = lines[0].split('\t').map((c) => (unescape ? unescapeMysqlCell(c) : c));
  const rawRows = lines.slice(1);
  const truncated = rawRows.length > MAX_ROWS;
  const rows = rawRows.slice(0, MAX_ROWS).map((line) => {
    const cells = line.split('\t');
    return cells.map((c) => {
      if (c === 'NULL') return null; // mysql batch NULL
      return coerceCell(unescape ? unescapeMysqlCell(c) : c);
    });
  });
  return { columns, rows, truncated };
}

/**
 * 解析 psql CSV（RFC4180：引号字段可含逗号/换行，"" 转义双引号）。
 * psql CSV 中 NULL 输出为不带引号的空串，空字符串输出为带引号的 ""，据此区分。
 */
function parseCsv(stdout: string): { columns: string[]; rows: (string | number | null)[][]; truncated: boolean } {
  type Cell = { v: string; q: boolean };
  const records: Cell[][] = [];
  let cur: Cell[] = [];
  let field = '';
  let inQuotes = false;
  let fieldQuoted = false;
  let i = 0;
  const s = stdout;
  const endField = () => {
    cur.push({ v: field, q: fieldQuoted });
    field = '';
    fieldQuoted = false;
  };
  const endRecord = () => {
    endField();
    records.push(cur);
    cur = [];
  };
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch; // 引号内的换行/制表符原样进入字段，不截断记录
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      fieldQuoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' && s[i + 1] === '\n') {
      endRecord();
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      endRecord();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || fieldQuoted || cur.length > 0) endRecord();

  if (records.length === 0) return { columns: [], rows: [], truncated: false };
  const columns = records[0].map((f) => f.v);
  // 过滤空行记录
  const rawRows = records.slice(1).filter((r) => !(r.length === 1 && r[0].v === '' && !r[0].q));
  const truncated = rawRows.length > MAX_ROWS;
  const rows = rawRows.slice(0, MAX_ROWS).map((rec) =>
    rec.map((f) => {
      if (!f.q && f.v === '') return null; // psql CSV：未加引号的空串 = NULL
      return coerceCell(f.v);
    })
  );
  return { columns, rows, truncated };
}

/**
 * 在远端执行一条 SQL。
 * @param exec SSH 会话的 exec 函数（注入便于测试）
 */
export async function runDbQuery(exec: ExecFn, cfg: DbConfig, sql: string, timeoutMs = 30000): Promise<DbQueryResult> {
  const started = Date.now();
  if (!sql.trim()) throw new Error('SQL 为空');

  let cmd: string;
  if (cfg.type === 'mysql') {
    // --batch TSV，不加 --raw：让 mysql 转义字段内的 \n/\t/\\，解析时反转义，
    // 避免字段内换行/制表符破坏行结构（此前 --raw 会让含换行字段拆散行）
    const auth = cfg.password !== undefined ? `MYSQL_PWD=${shq(cfg.password)} ` : '';
    cmd = `${auth}mysql --batch -h ${shq(cfg.host)} -P ${cfg.port} -u ${shq(cfg.user)} -D ${shq(cfg.database)} -e ${shq(sql)}`;
  } else {
    const auth = cfg.password !== undefined ? `PGPASSWORD=${shq(cfg.password)} ` : '';
    // --csv（psql 12+）：RFC4180 引号转义，字段内含逗号/换行/引号均安全；
    // 多语句时 psql 逐条输出，这里取整体
    cmd = `${auth}psql -h ${shq(cfg.host)} -p ${cfg.port} -U ${shq(cfg.user)} -d ${shq(cfg.database)} --csv -c ${shq(sql)}`;
  }

  const { stdout, stderr, code } = await exec(cmd, timeoutMs);

  // CLI 不存在优先判断（退出码非 0 时先给出友好提示而非原始 stderr）
  if (/command not found|not found|未找到命令/.test(stderr)) {
    throw new Error(`远端未安装 ${cfg.type === 'mysql' ? 'mysql' : 'psql'} 客户端，请在服务器上安装后重试`);
  }

  if (code !== 0) {
    const msg = (stderr || stdout).trim() || `退出码 ${code}`;
    throw new Error(msg.length > 800 ? msg.slice(0, 800) + '…' : msg);
  }

  const { columns, rows, truncated } = cfg.type === 'mysql' ? parseTsv(stdout, true) : parseCsv(stdout);
  // DDL/DML 无 SELECT 输出：从 stderr 或 affected 提示判断成功
  const affectedMatch = stderr.match(/(\d+)\s+rows? (?:affected|changed)/i);
  return {
    columns,
    rows,
    affectedRows: affectedMatch ? Number(affectedMatch[1]) : undefined,
    durationMs: Date.now() - started,
    truncated: truncated || undefined
  };
}

/** 测试数据库连通性（SELECT 1） */
export async function testDb(exec: ExecFn, cfg: DbConfig): Promise<void> {
  await runDbQuery(exec, cfg, cfg.type === 'mysql' ? 'SELECT 1' : 'SELECT 1', 10000);
}
