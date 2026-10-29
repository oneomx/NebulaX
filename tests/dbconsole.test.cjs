/**
 * v1.3 数据库快速查询模块测试（node:test）
 * 覆盖：TSV 解析、NULL/数字识别、行数截断、shell 转义、密码走环境变量不进 argv、错误翻译
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { runDbQuery } = require(path.join(__dirname, '..', 'dist-electron', 'dbconsole.js'));

/** 记录命令的 mock exec */
function mockExec(stdout, stderr = '', code = 0) {
  const fn = async (cmd, timeoutMs) => {
    fn.lastCmd = cmd;
    fn.lastTimeout = timeoutMs;
    return { stdout, stderr, code };
  };
  return fn;
}

const baseCfg = { type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: 'pw', database: 'app' };

describe('dbconsole 查询', () => {
  test('SELECT 结果解析：表头 + 行 + 数字识别', async () => {
    const exec = mockExec('id\tname\tage\n1\talice\t30\n2\tbob\t25\n');
    const r = await runDbQuery(exec, baseCfg, 'SELECT id,name,age FROM users');
    assert.deepStrictEqual(r.columns, ['id', 'name', 'age']);
    assert.strictEqual(r.rows.length, 2);
    assert.deepStrictEqual(r.rows[0], [1, 'alice', 30]);
    assert.ok(r.durationMs >= 0);
  });

  test('NULL 识别：mysql 的 NULL 与 psql CSV 的空串', async () => {
    const exec = mockExec('a\tb\nNULL\tx\n');
    const r = await runDbQuery(exec, baseCfg, 'SELECT 1');
    assert.strictEqual(r.rows[0][0], null);

    // psql --csv：NULL 输出为不带引号的空串，空字符串输出为带引号的 ""
    const exec2 = mockExec('a,b\n,x\n');
    const r2 = await runDbQuery(exec2, { ...baseCfg, type: 'postgres' }, 'SELECT 1');
    assert.strictEqual(r2.rows[0][0], null);
    assert.strictEqual(r2.rows[0][1], 'x');

    const exec3 = mockExec('a,b\n"",y\n');
    const r3 = await runDbQuery(exec3, { ...baseCfg, type: 'postgres' }, 'SELECT 1');
    assert.strictEqual(r3.rows[0][0], ''); // 空字符串 ≠ NULL
  });

  test('字段内含换行/制表符不破坏行结构', async () => {
    // mysql 默认转义：字段内换行 -> \n、制表符 -> \t（命令中不再使用 --raw）
    const exec = mockExec('id\tnote\n1\tline1\\nline2\\tend\n2\tplain\n');
    const r = await runDbQuery(exec, baseCfg, 'SELECT id,note FROM t');
    assert.strictEqual(r.rows.length, 2);
    assert.strictEqual(r.rows[0][1], 'line1\nline2\tend');

    // psql CSV：引号包裹的字段可含换行与逗号
    const exec2 = mockExec('id,note\n1,"line1\nline2, with comma"\n2,plain\n');
    const r2 = await runDbQuery(exec2, { ...baseCfg, type: 'postgres' }, 'SELECT id,note FROM t');
    assert.strictEqual(r2.rows.length, 2);
    assert.strictEqual(r2.rows[0][1], 'line1\nline2, with comma');

    // CSV 双引号转义
    const exec3 = mockExec('a\n"say ""hi"""\n');
    const r3 = await runDbQuery(exec3, { ...baseCfg, type: 'postgres' }, 'SELECT 1');
    assert.strictEqual(r3.rows[0][0], 'say "hi"');
  });

  test('超 500 行截断并标记 truncated', async () => {
    const lines = ['n'];
    for (let i = 0; i < 600; i++) lines.push(String(i));
    const exec = mockExec(lines.join('\n') + '\n');
    const r = await runDbQuery(exec, baseCfg, 'SELECT 1');
    assert.strictEqual(r.rows.length, 500);
    assert.strictEqual(r.truncated, true);
  });

  test('密码经环境变量前缀，不作为参数出现在 mysql/psql 命令行', async () => {
    const exec = mockExec('1\n');
    await runDbQuery(exec, baseCfg, 'SELECT 1');
    assert.ok(exec.lastCmd.startsWith("MYSQL_PWD='pw' mysql "), `实际命令：${exec.lastCmd}`);
    // 命令行中不出现 -p'pw' 形式
    assert.ok(!exec.lastCmd.includes("-p'pw'"), '密码不应作为 argv');
  });

  test('shell 单引号转义：密码/SQL 含单引号不破坏命令', async () => {
    const exec = mockExec('1\n');
    await runDbQuery(exec, { ...baseCfg, password: "a'b" }, "SELECT 'hi'");
    // POSIX 转义：' -> '\''
    assert.ok(exec.lastCmd.includes(`MYSQL_PWD='a'\\''b'`), `实际命令：${exec.lastCmd}`);
    assert.ok(exec.lastCmd.includes(`-e 'SELECT '\\''hi'\\'''`), `SQL 转义错误：${exec.lastCmd}`);
  });

  test('postgres 命令构造：psql 参数与 PGPASSWORD', async () => {
    const exec = mockExec('1\n');
    await runDbQuery(exec, { ...baseCfg, type: 'postgres', port: 5432, user: 'pg', database: 'prod' }, 'SELECT 1');
    assert.ok(exec.lastCmd.startsWith("PGPASSWORD='pw' psql "), `实际命令：${exec.lastCmd}`);
    assert.ok(exec.lastCmd.includes("-h '127.0.0.1' -p 5432 -U 'pg' -d 'prod'"));
  });

  test('非零退出码：抛出 stderr 信息', async () => {
    const exec = mockExec('', "ERROR: relation \"nope\" does not exist", 1);
    await assert.rejects(runDbQuery(exec, baseCfg, 'SELECT * FROM nope'), /relation "nope" does not exist/);
  });

  test('CLI 不存在：友好提示', async () => {
    const exec = mockExec('', 'bash: mysql: command not found', 127);
    await assert.rejects(runDbQuery(exec, baseCfg, 'SELECT 1'), /远端未安装 mysql 客户端/);
  });

  test('空 SQL 直接拒绝，不发命令', async () => {
    const exec = mockExec('1\n');
    await assert.rejects(runDbQuery(exec, baseCfg, '   '), /SQL 为空/);
    assert.strictEqual(exec.lastCmd, undefined);
  });

  test('affected rows 从 stderr 提取（DML 场景）', async () => {
    const exec = mockExec('', 'Query OK, 3 rows affected', 0);
    const r = await runDbQuery(exec, baseCfg, 'UPDATE t SET a=1');
    assert.strictEqual(r.affectedRows, 3);
    assert.strictEqual(r.rows.length, 0);
  });
});
