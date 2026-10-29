/**
 * v1.2 核心模块测试基线（node:test）
 * 覆盖：Telnet IAC 分包解析、known_hosts TOFU、SOCKS5/HTTP CONNECT 代理握手
 * 运行：npm run build:electron && node --test tests/
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIST = path.join(__dirname, '..', 'dist-electron');

// ============================ Telnet IAC ============================
describe('Telnet IAC 解析', () => {
  const { TelnetSession } = require(path.join(DIST, 'telnet.js'));
  const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;

  function newSession() {
    return new TelnetSession('t1', { host: 'test', port: 23 });
  }

  test('纯数据透传，无 IAC 时原样输出', () => {
    const s = newSession();
    const { clean, replies } = s.processIAC(Buffer.from('Hello\r\n', 'utf8'));
    assert.strictEqual(clean.toString('utf8'), 'Hello\r\n');
    assert.strictEqual(replies.length, 0);
  });

  test('IAC WILL ECHO → 回 DO ECHO（支持的选项）', () => {
    const s = newSession();
    const { clean, replies } = s.processIAC(Buffer.from([IAC, WILL, 1]));
    assert.strictEqual(clean.length, 0);
    assert.strictEqual(replies.length, 1);
    assert.deepStrictEqual([...replies[0]], [IAC, DO, 1]);
  });

  test('IAC WILL 不支持选项 → 回 DONT', () => {
    const s = newSession();
    const { replies } = s.processIAC(Buffer.from([IAC, WILL, 42]));
    assert.deepStrictEqual([...replies[0]], [IAC, DONT, 42]);
  });

  test('IAC DO SGA（支持）→ WILL；IAC DO 其他 → WONT', () => {
    const s = newSession();
    assert.deepStrictEqual([...s.processIAC(Buffer.from([IAC, DO, 3])).replies[0]], [IAC, WILL, 3]);
    assert.deepStrictEqual([...s.processIAC(Buffer.from([IAC, DO, 99])).replies[0]], [IAC, WONT, 99]);
  });

  test('重复的 WILL/DO 只应答一次（防协商循环）', () => {
    const s = newSession();
    s.processIAC(Buffer.from([IAC, WILL, 1]));
    const { replies } = s.processIAC(Buffer.from([IAC, WILL, 1]));
    assert.strictEqual(replies.length, 0);
  });

  test('IAC IAC 转义 → 输出单个 0xFF 数据字节', () => {
    const s = newSession();
    const { clean } = s.processIAC(Buffer.from([0x41, IAC, IAC, 0x42]));
    assert.deepStrictEqual([...clean], [0x41, 0xFF, 0x42]);
  });

  test('IAC SB ... IAC SE 子协商整块跳过', () => {
    const s = newSession();
    const chunk = Buffer.from([0x41, IAC, SB, 24, 1, 2, 3, IAC, SE, 0x42]);
    const { clean } = s.processIAC(chunk);
    assert.deepStrictEqual([...clean], [0x41, 0x42]);
  });

  test('跨包分包：协商命令被 TCP 切成两半', () => {
    const s = newSession();
    // 第一包只有 IAC WILL（缺 option 字节）
    const r1 = s.processIAC(Buffer.from([0x41, IAC, WILL]));
    assert.strictEqual(r1.clean.toString(), 'A');
    assert.strictEqual(r1.replies.length, 0); // 不完整，暂存
    // 第二包补上 option
    const r2 = s.processIAC(Buffer.from([1, 0x42]));
    assert.strictEqual(r2.clean.toString(), 'B');
    assert.deepStrictEqual([...r2.replies[0]], [IAC, DO, 1]);
  });

  test('跨包分包：子协商块被切成两半', () => {
    const s = newSession();
    const r1 = s.processIAC(Buffer.from([IAC, SB, 24, 9, 9]));
    assert.strictEqual(r1.clean.length, 0);
    assert.strictEqual(r1.replies.length, 0);
    const r2 = s.processIAC(Buffer.from([8, IAC, SE, 0x43]));
    assert.strictEqual(r2.clean.toString(), 'C');
  });

  test('协商与数据混合的一次多选项场景', () => {
    const s = newSession();
    const chunk = Buffer.from([IAC, WILL, 1, 0x68, 0x69, IAC, DO, 3]); // WILL ECHO "hi" DO SGA
    const { clean, replies } = s.processIAC(chunk);
    assert.strictEqual(clean.toString(), 'hi');
    assert.strictEqual(replies.length, 2);
  });
});

// ============================ known_hosts ============================
describe('known_hosts TOFU 指纹', () => {
  let kh;
  let tmpHome;

  before(() => {
    // 重定向 homedir 到临时目录，避免污染真实 ~/.nebula-ssh
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-kh-'));
    process.env.USERPROFILE = tmpHome; // Windows os.homedir 读取此变量
    process.env.HOME = tmpHome;
    kh = require(path.join(DIST, 'knownhosts.js'));
  });

  function fakeKey(algo = 'ssh-ed25519', seed = 'x') {
    const name = Buffer.from(algo, 'utf8');
    const body = crypto.createHash('sha256').update(seed).digest(); // 32 字节伪公钥体
    const buf = Buffer.alloc(4 + name.length + body.length);
    buf.writeUInt32BE(name.length, 0);
    name.copy(buf, 4);
    body.copy(buf, 4 + name.length);
    return buf;
  }

  test('sha256Fingerprint 与 OpenSSH 风格一致（base64 无填充）', () => {
    const key = Buffer.from('dummy-key-material');
    const fp = kh.sha256Fingerprint(key);
    const expected = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    assert.strictEqual(fp, expected);
    assert.ok(!fp.includes('='), '不应含 = 填充');
    assert.ok(!fp.startsWith('SHA256:'), '不含前缀（前缀由 UI 加）');
  });

  test('extractKeyType 解析 SSH wire 格式算法名', () => {
    assert.strictEqual(kh.extractKeyType(fakeKey('ssh-ed25519')), 'ssh-ed25519');
    assert.strictEqual(kh.extractKeyType(fakeKey('ssh-rsa')), 'ssh-rsa');
    assert.strictEqual(kh.extractKeyType(Buffer.from([0, 0])), 'unknown'); // 过短
  });

  test('TOFU 流程：unknown → trust → match → mismatch → remove', () => {
    const host = '10.0.0.1', port = 22;
    const key1 = fakeKey('ssh-ed25519', 'host1-key');
    const key2 = fakeKey('ssh-ed25519', 'host1-key-ROTATED');

    // 1. 首次未知
    assert.strictEqual(kh.checkHostKey(host, port, key1), 'unknown');

    // 2. 信任后匹配
    const entry = kh.trustHostKey(host, port, key1);
    assert.strictEqual(entry.keyType, 'ssh-ed25519');
    assert.ok(entry.sha256.length > 0);
    assert.strictEqual(kh.checkHostKey(host, port, key1), 'match');

    // 3. 密钥变化 → mismatch（防中间人）
    assert.strictEqual(kh.checkHostKey(host, port, key2), 'mismatch');

    // 4. 列表与删除
    assert.ok(kh.listHostKeys().some((e) => e.host === host && e.port === port));
    assert.strictEqual(kh.removeHostKey(host, port), true);
    assert.strictEqual(kh.checkHostKey(host, port, key1), 'unknown');
    assert.strictEqual(kh.removeHostKey(host, port), false); // 已删除
  });

  test('同主机不同端口视为不同条目', () => {
    const key = fakeKey('ssh-ed25519', 'multiport');
    kh.trustHostKey('10.0.0.2', 22, key);
    kh.trustHostKey('10.0.0.2', 2222, fakeKey('ssh-rsa', 'other'));
    assert.strictEqual(kh.checkHostKey('10.0.0.2', 22, key), 'match');
    assert.strictEqual(kh.checkHostKey('10.0.0.2', 2222, key), 'mismatch');
    kh.removeHostKey('10.0.0.2', 22);
    kh.removeHostKey('10.0.0.2', 2222);
  });
});

// ============================ SOCKS5 / HTTP CONNECT ============================
describe('代理隧道握手', () => {
  const { openProxySocket } = require(path.join(DIST, 'ssh.js'));

  /** 本地 mock SOCKS5 代理：支持无认证与用户名密码认证，CONNECT 后回显数据 */
  function startSocks5Server(opts = {}) {
    return new Promise((resolve) => {
      const server = net.createServer((sock) => {
        let stage = 'greet';
        let buf = Buffer.alloc(0);
        sock.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          if (stage === 'greet') {
            if (buf.length < 2) return;
            const n = buf[1];
            if (buf.length < 2 + n) return;
            const methods = buf.subarray(2, 2 + n);
            if (opts.requireAuth) {
              if (!methods.includes(0x02)) { sock.write(Buffer.from([0x05, 0xff])); return; }
              sock.write(Buffer.from([0x05, 0x02]));
            } else {
              sock.write(Buffer.from([0x05, 0x00]));
            }
            buf = Buffer.alloc(0);
            stage = opts.requireAuth ? 'auth' : 'connect';
          } else if (stage === 'auth') {
            if (buf.length < 2) return;
            const ulen = buf[1];
            if (buf.length < 2 + ulen + 1) return;
            const plen = buf[2 + ulen];
            if (buf.length < 2 + ulen + 1 + plen) return;
            const user = buf.subarray(2, 2 + ulen).toString();
            const pass = buf.subarray(2 + ulen + 1, 2 + ulen + 1 + plen).toString();
            if (user === (opts.user || 'u') && pass === (opts.pass || 'p')) {
              sock.write(Buffer.from([0x01, 0x00]));
            } else {
              sock.write(Buffer.from([0x01, 0x01]));
            }
            buf = Buffer.alloc(0);
            stage = 'connect';
          } else if (stage === 'connect') {
            if (buf.length < 5) return;
            // 记录请求的目标地址类型
            server.lastReqAtyp = buf[3];
            server.lastTargetHostLen = buf[4];
            if (opts.failConnect) {
              sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              return;
            }
            sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
            buf = Buffer.alloc(0);
            stage = 'data';
            sock.on('data', (d) => sock.write(d)); // 回显
          }
        });
        sock.on('error', () => {});
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  /** 本地 mock HTTP CONNECT 代理：200 后回显 */
  function startHttpProxyServer(opts = {}) {
    return new Promise((resolve) => {
      const server = net.createServer((sock) => {
        let head = Buffer.alloc(0);
        let established = false;
        sock.on('data', (chunk) => {
          if (!established) {
            head = Buffer.concat([head, chunk]);
            const s = head.toString('latin1');
            const idx = s.indexOf('\r\n\r\n');
            if (idx < 0) return;
            server.lastRequest = s.slice(0, idx);
            if (opts.fail) { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
            sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
            established = true;
            sock.on('data', (d) => sock.write(d)); // 回显
          }
        });
        sock.on('error', () => {});
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  test('SOCKS5 无认证：隧道建立、域名方式请求、数据回显', async () => {
    const server = await startSocks5Server();
    try {
      const sock = await openProxySocket(
        { type: 'socks5', host: '127.0.0.1', port: server.address().port },
        'example.com', 22
      );
      assert.strictEqual(server.lastReqAtyp, 0x03, '应使用域名地址类型');
      assert.strictEqual(server.lastTargetHostLen, 'example.com'.length);
      const got = await new Promise((res) => {
        sock.once('data', (d) => res(d.toString()));
        sock.write('ping');
      });
      assert.strictEqual(got, 'ping');
      sock.destroy();
    } finally {
      server.close();
    }
  });

  test('SOCKS5 用户名密码认证成功', async () => {
    const server = await startSocks5Server({ requireAuth: true, user: 'alice', pass: 'secret' });
    try {
      const sock = await openProxySocket(
        { type: 'socks5', host: '127.0.0.1', port: server.address().port, username: 'alice', password: 'secret' },
        'target.host', 3306
      );
      const got = await new Promise((res) => {
        sock.once('data', (d) => res(d.toString()));
        sock.write('authed');
      });
      assert.strictEqual(got, 'authed');
      sock.destroy();
    } finally {
      server.close();
    }
  });

  test('SOCKS5 认证失败 → 拒绝连接', async () => {
    // 服务端只接受 alice/secret，客户端故意发错密码
    const server = await startSocks5Server({ requireAuth: true, user: 'alice', pass: 'secret' });
    try {
      await assert.rejects(
        openProxySocket(
          { type: 'socks5', host: '127.0.0.1', port: server.address().port, username: 'alice', password: 'WRONG' },
          't', 1
        ),
        /认证失败/
      );
    } finally {
      server.close();
    }
  });

  test('SOCKS5 隧道建立失败（状态码非 0）→ 拒绝', async () => {
    const server = await startSocks5Server({ failConnect: true });
    try {
      await assert.rejects(
        openProxySocket({ type: 'socks5', host: '127.0.0.1', port: server.address().port }, 't', 1),
        /隧道建立失败/
      );
    } finally {
      server.close();
    }
  });

  test('HTTP CONNECT：握手头正确、200 后数据回显', async () => {
    const server = await startHttpProxyServer();
    try {
      const sock = await openProxySocket(
        { type: 'http', host: '127.0.0.1', port: server.address().port },
        'web.example.org', 443
      );
      assert.ok(server.lastRequest.startsWith('CONNECT web.example.org:443 HTTP/1.1'), 'CONNECT 行格式');
      assert.ok(server.lastRequest.includes('Host: web.example.org:443'), 'Host 头');
      const got = await new Promise((res) => {
        sock.once('data', (d) => res(d.toString()));
        sock.write('tls-hello');
      });
      assert.strictEqual(got, 'tls-hello');
      sock.destroy();
    } finally {
      server.close();
    }
  });

  test('HTTP CONNECT 带 Basic 认证头', async () => {
    const server = await startHttpProxyServer();
    try {
      const sock = await openProxySocket(
        { type: 'http', host: '127.0.0.1', port: server.address().port, username: 'bob', password: 'pw' },
        'h', 80
      );
      const expect = `Proxy-Authorization: Basic ${Buffer.from('bob:pw').toString('base64')}`;
      assert.ok(server.lastRequest.includes(expect), `请求应含 ${expect}`);
      sock.destroy();
    } finally {
      server.close();
    }
  });

  test('HTTP 代理拒绝（非 2xx）→ 拒绝连接', async () => {
    const server = await startHttpProxyServer({ fail: true });
    try {
      await assert.rejects(
        openProxySocket({ type: 'http', host: '127.0.0.1', port: server.address().port }, 't', 1),
        /拒绝隧道请求/
      );
    } finally {
      server.close();
    }
  });
});

// ============================ 本地线性回归预测（容量预测降级路径） ============================
describe('本地容量预测（forecastLocal / predictDaysToFull）', () => {
  const { forecastLocal, predictDaysToFull } = require(path.join(DIST, 'ai', 'forecast.js'));

  /** 构造等间隔指标快照：diskPct 每次增长 stepPct 个百分点 */
  function makeSnapshots(n, { cpu = 30, mem = 50, diskStart = 50, stepPct = 2 } = {}) {
    const snaps = [];
    for (let i = 0; i < n; i++) {
      snaps.push({
        ts: Date.now() + i * 300000,
        hostname: 'test-host',
        cpuPercent: cpu,
        memPercent: mem,
        disk: [{ mount: '/', usePercent: diskStart + i * stepPct, availGB: 100 - i }],
        load1: 0.5,
        connections: 10
      });
    }
    return snaps;
  }

  test('predictDaysToFull：线性增长序列能算出天数', () => {
    // 每点 +1%（300 分钟间隔），10 个点后已到 59%，距 95% 还差 36 个点
    // = 36 * 300 / (60*24) = 7.5 天
    const points = Array.from({ length: 10 }, (_, i) => 50 + i);
    const days = predictDaysToFull(points, 300, 95);
    assert.ok(Math.abs(days - 7.5) < 0.01, `days=${days}`);
  });

  test('predictDaysToFull：无增长返回 null', () => {
    assert.strictEqual(predictDaysToFull([50, 50, 50, 50], 300, 95), null);
    assert.strictEqual(predictDaysToFull([80], 300, 95), null); // 点数不足
  });

  test('forecastLocal：磁盘快速增长 → 产出 critical 预警与天数', () => {
    // 60% 起每点 +2%，10 点后到 78%（未超阈值），距 95% 约 1.77 天
    const snaps = makeSnapshots(10, { diskStart: 60, stepPct: 2 });
    const r = forecastLocal(snaps, 300);
    assert.strictEqual(r.overallRisk, 'critical');
    const diskAlert = r.alerts.find((a) => a.resource.includes('磁盘'));
    assert.ok(diskAlert, '应有磁盘告警');
    assert.strictEqual(diskAlert.severity, 'critical');
    assert.ok(typeof diskAlert.daysToFull === 'number' && diskAlert.daysToFull > 0);
    // 必须声明是本地降级模式，不能伪装成 AI 结果
    assert.ok(r.insights.some((s) => s.includes('本地线性回归')));
  });

  test('forecastLocal：已超阈值 → daysToFull 归 0 而非负数', () => {
    const snaps = makeSnapshots(10, { diskStart: 96, stepPct: 1 }); // 96%→105%，已超 95%
    const r = forecastLocal(snaps, 300);
    const diskAlert = r.alerts.find((a) => a.resource.includes('磁盘'));
    assert.ok(diskAlert, '应有磁盘告警');
    assert.strictEqual(diskAlert.daysToFull, 0);
    assert.strictEqual(diskAlert.severity, 'critical');
  });

  test('forecastLocal：平稳低负载 → 无告警', () => {
    const snaps = makeSnapshots(10, { cpu: 20, mem: 30, diskStart: 30, stepPct: 0 });
    const r = forecastLocal(snaps, 300);
    assert.strictEqual(r.alerts.length, 0);
    assert.strictEqual(r.overallRisk, 'low');
  });

  test('forecastLocal：采样点不足 → 不报错，给出提示', () => {
    const r = forecastLocal(makeSnapshots(1), 300);
    assert.strictEqual(r.alerts.length, 0);
    assert.ok(r.insights.some((s) => s.includes('至少需要 2 个采样点')));
  });
});

// ============================ Windows 远端适配（v1.5） ============================
describe('Windows 远端适配（wincommands / 巡检分派）', () => {
  const { psCommand, windowsLoadArray, WIN_SERVER_INFO_SCRIPT, WIN_DIAG_SCRIPT, WIN_METRICS_SCRIPT } = require(path.join(DIST, 'wincommands.js'));

  test('psCommand：编码为 UTF-16LE base64 且可完整解码还原', () => {
    const cmd = psCommand('Write-Output "测试 $env:COMPUTERNAME"');
    assert.ok(cmd.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive -EncodedCommand '));
    const b64 = cmd.split(' ').pop();
    const decoded = Buffer.from(b64, 'base64').toString('utf16le');
    assert.strictEqual(decoded, 'Write-Output "测试 $env:COMPUTERNAME"');
  });

  test('psCommand：含引号/换行/特殊字符的脚本编码后不含裸引号（规避 cmd 转义）', () => {
    const script = 'Get-Process | Where-Object { $_.Name -like "*svc*" } # "双引号" \'单引号\'';
    const cmd = psCommand(script);
    assert.ok(!cmd.includes('"'), '编码后的命令行不应含裸双引号');
    assert.ok(Buffer.from(cmd.split(' ').pop(), 'base64').toString('utf16le') === script);
  });

  test('Windows 脚本包含与 Linux 版相同的解析标记', () => {
    for (const marker of ['__HOST__', '__MEM__', '__SWAP__', '__LOAD__', '__DISK__', '__PROC__', '__END__']) {
      assert.ok(WIN_SERVER_INFO_SCRIPT.includes(marker), `serverInfo 缺少标记 ${marker}`);
    }
    for (const marker of ['=== M_HOST ===', '=== M_CPU ===', '=== M_MEM ===', '=== M_DISK ===', '=== M_CONN ===', '=== M_END ===']) {
      assert.ok(WIN_METRICS_SCRIPT.includes(marker), `metrics 缺少标记 ${marker}`);
    }
    for (const marker of ['=== DIAG: TOP ===', '=== DIAG: FREE ===', '=== DIAG: JOURNAL_ERRORS ===', '=== DIAG_END ===']) {
      assert.ok(WIN_DIAG_SCRIPT.includes(marker), `diagnostics 缺少标记 ${marker}`);
    }
  });

  test('windowsLoadArray：单值 → [值, N/A, N/A]；三值原样；空 → 空', () => {
    assert.deepStrictEqual(windowsLoadArray(['12']), ['12', 'N/A', 'N/A']);
    assert.deepStrictEqual(windowsLoadArray(['1', '2', '3']), ['1', '2', '3']);
    assert.deepStrictEqual(windowsLoadArray([]), []);
  });

  test('v1.5.1 修复：所有 Windows 脚本声明 UTF-8 输出编码（防中文系统 GBK 乱码）', () => {
    const { WIN_AUDIT_SCRIPT } = require(path.join(DIST, 'wincommands.js'));
    for (const [name, script] of Object.entries({ WIN_SERVER_INFO_SCRIPT, WIN_DIAG_SCRIPT, WIN_METRICS_SCRIPT, WIN_AUDIT_SCRIPT })) {
      assert.ok(
        script.includes('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8'),
        `${name} 缺少 UTF-8 输出编码声明`
      );
    }
  });

  test('v1.5.1 修复：磁盘容量保留 1 位小数（<1GB 分区不再截断为 0G）', () => {
    assert.ok(!WIN_SERVER_INFO_SCRIPT.includes('[int]($_.Size'), 'serverInfo 不应再用 [int] 截断容量');
    assert.ok(!WIN_METRICS_SCRIPT.includes('[math]::Round($_.Size / 1GB)'), 'metrics 不应再四舍五入到整数 GB');
    assert.ok(WIN_SERVER_INFO_SCRIPT.includes('[math]::Round($_.Size / 1GB, 1)'));
    assert.ok(WIN_METRICS_SCRIPT.includes('[math]::Round($_.FreeSpace / 1GB, 1)'));
  });

  test('evaluateSnapshot：Windows 快照的告警建议命令为 Windows 原生命令', () => {
    const { evaluateSnapshot } = require(path.join(DIST, 'patrol.js'));
    const th = { cpu: 80, mem: 85, disk: 90 };
    const snap = {
      ts: Date.now(),
      hostname: 'win-host',
      cpuPercent: 92,
      memPercent: 95,
      disk: [{ mount: 'C:', usePercent: 96, availGB: 3 }],
      load1: 90,
      connections: 50,
      os: 'windows'
    };
    const alerts = evaluateSnapshot(snap, th);
    assert.strictEqual(alerts.length, 3);
    for (const a of alerts) {
      assert.ok(a.command.includes('powershell'), `${a.resource} 告警命令应为 PowerShell：${a.command}`);
      assert.ok(!/\b(top|ps aux|du)\b/.test(a.command), `${a.resource} 告警命令不应含 Linux 命令`);
    }
  });

  test('evaluateSnapshot：Linux 快照（或缺省 os）保持原命令', () => {
    const { evaluateSnapshot } = require(path.join(DIST, 'patrol.js'));
    const snap = {
      ts: Date.now(),
      hostname: 'nix-host',
      cpuPercent: 92,
      memPercent: 50,
      disk: [],
      load1: 9,
      connections: 5
    };
    const alerts = evaluateSnapshot(snap, { cpu: 80, mem: 85, disk: 90 });
    assert.strictEqual(alerts.length, 1);
    assert.ok(alerts[0].command.includes('top -bn1'));
  });
});

// ============================ AI 运维深化：趋势预警 + 自动诊断 ============================
describe('AI 运维深化（evaluateTrend / buildAutoDiagSteps / PatrolConfig 新字段）', () => {
  const DIST2 = path.join(__dirname, '..', 'dist-electron');

  function makeSnap(overrides) {
    return {
      ts: Date.now(),
      hostname: 'h1',
      cpuPercent: 30,
      memPercent: 50,
      disk: [{ mount: '/data', usePercent: 60, availGB: 100 }],
      load1: 0.5,
      connections: 5,
      os: 'linux',
      ...overrides
    };
  }

  test('evaluateTrend：磁盘快速增长且未超阈值 → 产出趋势预警与天数', () => {
    const { evaluateTrend } = require(path.join(DIST2, 'patrol.js'));
    // 60→75% over 9 intervals of 30min = 4.5h；到 90% 还需约 (90-75)/(15/4.5) ≈ 4.5 天 → 超 3 天窗口？用更陡的增长
    // 60→80 over 9 intervals (4.5h)：斜率 ≈ 20/4.5 ≈ 4.4%/h；(90-80)/4.4 ≈ 2.3h ≈ 0.09 天 → 在 3 天窗口内
    const hist = [];
    for (let i = 0; i < 10; i++) {
      hist.push(makeSnap({ disk: [{ mount: '/data', usePercent: 60 + i * (20 / 9), availGB: 100 }] }));
    }
    const alerts = evaluateTrend(hist, { cpu: 85, mem: 90, disk: 90 }, 30, 3);
    const diskAlert = alerts.find((a) => a.resource === 'disk' && a.mount === '/data');
    assert.ok(diskAlert, '应产出 /data 磁盘趋势预警');
    assert.ok(diskAlert.daysToFull > 0 && diskAlert.daysToFull <= 3, `daysToFull 应在 3 天窗口内，实际 ${diskAlert.daysToFull}`);
    assert.ok(diskAlert.suggestion.includes('天'));
  });

  test('evaluateTrend：已超阈值的项不重复产出（交给 evaluateSnapshot）', () => {
    const { evaluateTrend } = require(path.join(DIST2, 'patrol.js'));
    const hist = [];
    for (let i = 0; i < 10; i++) {
      hist.push(makeSnap({ disk: [{ mount: '/data', usePercent: 85 + i, availGB: 20 }] }));
    }
    const alerts = evaluateTrend(hist, { cpu: 85, mem: 90, disk: 90 }, 30, 3);
    assert.strictEqual(alerts.filter((a) => a.resource === 'disk').length, 0, '已超阈值磁盘不应重复预警');
  });

  test('evaluateTrend：样本不足（<4）返回空', () => {
    const { evaluateTrend } = require(path.join(DIST2, 'patrol.js'));
    const hist = [makeSnap({}), makeSnap({})];
    assert.deepStrictEqual(evaluateTrend(hist, { cpu: 85, mem: 90, disk: 90 }, 30, 3), []);
  });

  test('evaluateTrend：平稳序列无预警', () => {
    const { evaluateTrend } = require(path.join(DIST2, 'patrol.js'));
    const hist = [];
    for (let i = 0; i < 10; i++) hist.push(makeSnap({}));
    const alerts = evaluateTrend(hist, { cpu: 85, mem: 90, disk: 90 }, 30, 3);
    assert.strictEqual(alerts.length, 0);
  });

  test('evaluateTrend：trendWarnDays=0 由调用方跳过（函数本身仍可用）', () => {
    const { evaluateTrend } = require(path.join(DIST2, 'patrol.js'));
    const hist = [];
    for (let i = 0; i < 10; i++) {
      hist.push(makeSnap({ disk: [{ mount: '/data', usePercent: 60 + i * (20 / 9), availGB: 100 }] }));
    }
    // main.ts 在 trendWarnDays=0 时不调用 evaluateTrend；此处仅验证函数在窗口 0 下会过滤所有预警
    const alerts = evaluateTrend(hist, { cpu: 85, mem: 90, disk: 90 }, 30, 0);
    assert.strictEqual(alerts.length, 0);
  });

  test('buildAutoDiagSteps：Linux CPU 告警 → top/ps 命令', () => {
    const { buildAutoDiagSteps } = require(path.join(DIST2, 'patrol.js'));
    const steps = buildAutoDiagSteps([{ resource: 'cpu', severity: 'warning', currentPercent: 90, threshold: 85, suggestion: '' }], 'linux');
    assert.ok(steps.length >= 2);
    assert.ok(steps.some((s) => s.command.includes('top')));
    assert.ok(steps.some((s) => s.command.includes('ps ')));
    for (const s of steps) assert.ok(!s.command.includes('powershell'), 'Linux 步骤不应含 PowerShell');
  });

  test('buildAutoDiagSteps：Windows 内存告警 → PowerShell Get-Process', () => {
    const { buildAutoDiagSteps } = require(path.join(DIST2, 'patrol.js'));
    const steps = buildAutoDiagSteps([{ resource: 'mem', severity: 'critical', currentPercent: 96, threshold: 90, suggestion: '' }], 'windows');
    assert.ok(steps.length >= 2);
    for (const s of steps) {
      assert.ok(s.command.includes('powershell'), `Windows 步骤应为 PowerShell：${s.command}`);
      assert.ok(!/\b(free|ps aux|top)\b/.test(s.command), `Windows 步骤不应含 Linux 命令：${s.command}`);
    }
  });

  test('buildAutoDiagSteps：磁盘告警逐挂载点生成大文件排查步骤', () => {
    const { buildAutoDiagSteps } = require(path.join(DIST2, 'patrol.js'));
    const steps = buildAutoDiagSteps(
      [
        { resource: 'disk', severity: 'warning', currentPercent: 92, threshold: 90, mount: '/var', suggestion: '' },
        { resource: 'disk', severity: 'critical', currentPercent: 97, threshold: 90, mount: '/data', suggestion: '' }
      ],
      'linux'
    );
    assert.ok(steps.some((s) => s.command.includes('/var')), '应含 /var 排查命令');
    assert.ok(steps.some((s) => s.command.includes('/data')), '应含 /data 排查命令');
  });

  test('buildAutoDiagSteps：无告警返回空数组', () => {
    const { buildAutoDiagSteps } = require(path.join(DIST2, 'patrol.js'));
    assert.deepStrictEqual(buildAutoDiagSteps([], 'linux'), []);
  });

  test('PatrolConfig 新字段：load/save 往返保持 autoDiagnose/autoReport/trendWarnDays', () => {
    // 用隔离配置文件，避免覆盖用户真实的 ~/.nebula-ssh/patrol-config.json
    const tmpCfg = path.join(os.tmpdir(), `nebula-patrol-test-${process.pid}.json`);
    process.env.NEBULA_PATROL_CONFIG = tmpCfg;
    try {
      // 清除模块缓存使 CONFIG_FILE 重新读取 env
      delete require.cache[require.resolve(path.join(DIST2, 'patrol.js'))];
      const { savePatrolConfig, loadPatrolConfig, defaultPatrolConfig } = require(path.join(DIST2, 'patrol.js'));
      const def = defaultPatrolConfig();
      assert.strictEqual(def.autoDiagnose, true, '默认开启告警自动诊断');
      assert.strictEqual(def.autoReport, false, '默认关闭报告落盘');
      assert.strictEqual(def.trendWarnDays, 3, '默认趋势窗口 3 天');
      savePatrolConfig({ ...def, autoDiagnose: false, autoReport: true, trendWarnDays: 7 });
      const loaded = loadPatrolConfig();
      assert.strictEqual(loaded.autoDiagnose, false);
      assert.strictEqual(loaded.autoReport, true);
      assert.strictEqual(loaded.trendWarnDays, 7);
      // 非法值回落默认
      savePatrolConfig({ ...def, trendWarnDays: 999 });
      assert.strictEqual(loadPatrolConfig().trendWarnDays, 3);
    } finally {
      delete process.env.NEBULA_PATROL_CONFIG;
      try { fs.unlinkSync(tmpCfg); } catch { /* ignore */ }
      delete require.cache[require.resolve(path.join(DIST2, 'patrol.js'))];
    }
  });

  test('formatPatrolReport：含趋势预警与自动诊断步骤段落', () => {
    const { formatPatrolReport } = require(path.join(DIST2, 'patrol.js'));
    const results = [
      {
        host: 'h1',
        ok: true,
        snapshot: makeSnap({}),
        alerts: [{ resource: 'cpu', severity: 'warning', currentPercent: 90, threshold: 85, suggestion: 's', command: 'top' }],
        trendAlerts: [{ resource: 'disk', mount: '/data', daysToFull: 2.5, currentPercent: 82, threshold: 90, suggestion: 't' }],
        autoDiagSteps: [{ command: 'top -bn1', purpose: 'p' }]
      }
    ];
    const report = formatPatrolReport(results, new Date());
    assert.ok(report.includes('趋势预警'), '报告应含趋势预警');
    assert.ok(report.includes('2.5'), '报告应含预测天数');
    assert.ok(report.includes('自动诊断步骤'), '报告应含自动诊断步骤段');
    assert.ok(report.includes('top -bn1'), '报告应含诊断命令');
  });
});

// ============================ v1.7 AI 工具优化与场景化 ============================
describe('v1.7 场景化预设模板库', () => {
  const scenarios = require(path.join(DIST, 'ai', 'scenarios.js'));

  test('4 类场景齐全：ops/security/database/perf 均有预设', () => {
    const { SCENARIOS, getScenarios } = scenarios;
    assert.ok(SCENARIOS.length >= 20, `场景总数应 >=20，实际 ${SCENARIOS.length}`);
    for (const cat of ['ops', 'security', 'database', 'perf']) {
      const list = getScenarios(cat);
      assert.ok(list.length >= 4, `分类 ${cat} 应至少 4 个场景，实际 ${list.length}`);
      assert.ok(list.every((s) => s.category === cat), `分类 ${cat} 内混入其他分类`);
    }
    // 四大用户场景逐一覆盖
    assert.ok(getScenarios('ops').some((s) => s.id === 'ops-502'));
    assert.ok(getScenarios('security').some((s) => s.id === 'sec-ssh'));
    assert.ok(getScenarios('database').some((s) => s.id === 'db-slow'));
    assert.ok(getScenarios('perf').some((s) => s.id === 'perf-kernel'));
  });

  test('每个场景字段完整：id 唯一、含 incident/steps/quickPrompt', () => {
    const { SCENARIOS } = scenarios;
    const ids = new Set(SCENARIOS.map((s) => s.id));
    assert.strictEqual(ids.size, SCENARIOS.length, '场景 id 必须唯一');
    for (const s of SCENARIOS) {
      assert.ok(s.incident && s.incident.length > 5, `${s.id} 缺 incident`);
      assert.ok(Array.isArray(s.steps) && s.steps.length >= 3, `${s.id} 推荐步骤应 >=3`);
      for (const st of s.steps) {
        assert.ok(st.command && st.purpose, `${s.id} 步骤缺 command/purpose`);
      }
      assert.ok(s.quickPrompt && s.quickPrompt.length > 5, `${s.id} 缺 quickPrompt`);
      assert.ok(s.contextHint, `${s.id} 缺 contextHint`);
    }
  });

  test('buildScenarioIncident：拼接现象 + 上下文提示 + 实际情况', () => {
    const { getScenario, buildScenarioIncident } = scenarios;
    const s = getScenario('ops-disk-full');
    assert.ok(s, 'ops-disk-full 应存在');
    const out = buildScenarioIncident(s, '分区 /data 满了');
    assert.ok(out.includes(s.incident), '应包含原始现象');
    assert.ok(out.includes(s.contextHint), '应包含上下文提示');
    assert.ok(out.includes('分区 /data 满了'), '应包含用户补充');
    assert.strictEqual(buildScenarioIncident(s), `${s.incident}\n补充信息：${s.contextHint}`);
  });

  test('场景步骤均为只读/诊断类命令（不含破坏性操作）', () => {
    const { SCENARIOS } = scenarios;
    const dangerous = /\brm\s+-rf|\bmkfs\b|\bshutdown\b|\bdd\s+.*of=\/dev\//;
    for (const s of SCENARIOS) {
      for (const st of s.steps) {
        assert.ok(!dangerous.test(st.command), `${s.id} 步骤含危险命令：${st.command}`);
      }
    }
  });
});

describe('v1.7 多模型智能路由', () => {
  const router = require(path.join(DIST, 'ai', 'router.js'));

  test('resolveRoute：路由关闭返回空覆盖（完全走主配置）', () => {
    const out = router.resolveRoute('diagnose', { enabled: false, rules: { diagnose: { model: 'big' } } });
    assert.deepStrictEqual(out, {});
  });

  test('resolveRoute：开启且有规则 → 返回 model/baseUrl/maxTokens 覆盖', () => {
    const cfg = {
      enabled: true,
      rules: { db: { model: 'qwen-max', baseUrl: 'https://x/v1', maxTokens: 4000 } }
    };
    const out = router.resolveRoute('db', cfg);
    assert.strictEqual(out.model, 'qwen-max');
    assert.strictEqual(out.baseUrl, 'https://x/v1');
    assert.strictEqual(out.maxTokens, 4000);
  });

  test('resolveRoute：开启但该任务无规则 → 空（回落主配置）', () => {
    const cfg = { enabled: true, rules: { chat: { model: 'fast' } } };
    assert.deepStrictEqual(router.resolveRoute('audit', cfg), {});
  });

  test('AI_TASK_LABELS 覆盖全部 7 种任务类型', () => {
    const keys = Object.keys(router.AI_TASK_LABELS);
    assert.strictEqual(keys.length, 7);
    for (const t of ['chat', 'diagnose', 'audit', 'script', 'forecast', 'db', 'perf']) {
      assert.ok(router.AI_TASK_LABELS[t], `任务 ${t} 缺中文标签`);
    }
  });

  test('defaultRoutingConfig：默认关闭', () => {
    const def = router.defaultRoutingConfig();
    assert.strictEqual(def.enabled, false);
    assert.deepStrictEqual(def.rules, {});
  });
});

describe('v1.7 AI 输出结构化增强（schema 校验）', () => {
  const schema = require(path.join(DIST, 'ai', 'schema.js'));

  test('extractJsonText：剥离 markdown 围栏与前后杂文本', () => {
    const raw = '好的，以下是结果：\n```json\n{"a": 1}\n```\n以上供参考';
    assert.strictEqual(schema.extractJsonText(raw), '{"a": 1}');
    assert.strictEqual(schema.extractJsonText('前缀 [1,2] 后缀'), '[1,2]');
    assert.strictEqual(schema.extractJsonText('没有 JSON'), '没有 JSON');
  });

  test('validateField：类型/必填/枚举逐项校验', () => {
    const spec = {
      type: 'object',
      fields: {
        summary: { type: 'string', required: true },
        severity: { type: 'string', enum: ['critical', 'high', 'low'] },
        count: { type: 'number' },
        items: { type: 'array', items: { type: 'object', fields: { title: { type: 'string', required: true } } } }
      }
    };
    // 合法
    assert.deepStrictEqual(
      schema.validateField({ summary: 'ok', severity: 'high', count: 3, items: [{ title: 't' }] }, spec),
      []
    );
    // 缺必填
    const e1 = schema.validateField({ severity: 'high' }, spec);
    assert.ok(e1.some((x) => x.includes('summary') && x.includes('必填')), `缺 summary 应报必填：${e1}`);
    // 枚举外
    const e2 = schema.validateField({ summary: 's', severity: 'fatal' }, spec);
    assert.ok(e2.some((x) => x.includes('severity') && x.includes('枚举')), `枚举外应报错：${e2}`);
    // 类型错
    const e3 = schema.validateField({ summary: 123 }, spec);
    assert.ok(e3.some((x) => x.includes('summary') && x.includes('string')), `类型错应报错：${e3}`);
    // 数组元素缺字段
    const e4 = schema.validateField({ summary: 's', items: [{ noTitle: 1 }] }, spec);
    assert.ok(e4.some((x) => x.includes('items[0].title')), `数组元素应定位到路径：${e4}`);
    // null/undefined 必填
    assert.ok(schema.validateField(null, { type: 'string', required: true }).length === 1);
    assert.deepStrictEqual(schema.validateField(undefined, { type: 'string' }), []);
  });
});

describe('v1.7 上下文深度增强（buildRichContext）', () => {
  const context = require(path.join(DIST, 'ai', 'context.js'));

  test('全空输入返回空串', () => {
    assert.strictEqual(context.buildRichContext({}), '');
  });

  test('各段按优先级装入且带段落标题', () => {
    const out = context.buildRichContext({
      opsSummary: 'CPU 95%',
      trendLines: ['disk /data 82% → 2.5 天触顶'],
      recentCommands: ['df -h', 'top'],
      logTail: 'error: something failed',
      runbookMatches: [{ title: '磁盘满处理', excerpt: '清理步骤...', score: 0.8 }]
    });
    assert.ok(out.includes('巡检指标'), '应含巡检段');
    assert.ok(out.includes('趋势预警'), '应含趋势段');
    assert.ok(out.includes('最近执行的命令'), '应含命令段');
    assert.ok(out.includes('系统日志尾部'), '应含日志段');
    assert.ok(out.includes('Runbook'), '应含知识库段');
    // 优先级：巡检在前，Runbook 在后
    assert.ok(out.indexOf('巡检指标') < out.indexOf('Runbook'), '巡检段应排在 Runbook 前');
    assert.ok(out.indexOf('df -h') > out.indexOf('最近执行的命令'));
  });

  test('预算约束：超预算时截断且首段保留', () => {
    const out = context.buildRichContext({
      opsSummary: 'x'.repeat(3000),
      logTail: 'y'.repeat(3000),
      budgetChars: 1000
    });
    assert.ok(out.length <= 1000 + 20, `预算 1000 时输出不应超太多，实际 ${out.length}`);
    assert.ok(out.includes('巡检指标'), '首段（最高优先级）必须保留');
    assert.ok(!out.includes('系统日志尾部'), '预算不足时低优先级段应被裁掉');
  });

  test('命令历史最多取 15 条', () => {
    const cmds = Array.from({ length: 30 }, (_, i) => `cmd-${i}`);
    const out = context.buildRichContext({ recentCommands: cmds });
    assert.ok(out.includes('cmd-0') && out.includes('cmd-14'), '前 15 条应保留');
    assert.ok(!out.includes('cmd-29'), '第 30 条应被裁剪');
  });

  test('logTailCommand：linux journalctl / windows Get-EventLog', () => {
    const l = context.logTailCommand('linux', 40);
    assert.ok(l.includes('journalctl') && l.includes('40'));
    const w = context.logTailCommand('windows', 30);
    assert.ok(w.includes('Get-EventLog') && w.includes('30'));
    assert.ok(!w.includes('journalctl'));
  });
});

describe('v1.7 数据库专项诊断（localDbFindings 本地规则）', () => {
  const dbdiag = require(path.join(DIST, 'ai', 'dbdiag.js'));

  function mysqlSample(id, label, tsv) {
    return { id, label, ok: true, output: tsv };
  }

  test('MySQL 连接数 >=90% → critical', () => {
    const findings = dbdiag.localDbFindings('mysql', [
      mysqlSample('conn', '连接数', 'Variable_name\tValue\nThreads_connected\t180\nmax_connections\t200\nMax_used_connections\t190\nAborted_connects\t0')
    ]);
    const f = findings.find((x) => x.title.includes('连接数接近上限'));
    assert.ok(f, `应报连接数接近上限：${JSON.stringify(findings.map((x) => x.title))}`);
    assert.strictEqual(f.severity, 'critical');
    assert.strictEqual(f.source, 'rule');
    assert.ok(f.currentValue.includes('180/200'));
  });

  test('MySQL 连接数 70-90% → medium，<70% 不报', () => {
    const mid = dbdiag.localDbFindings('mysql', [
      mysqlSample('conn', 'c', 'Variable_name\tValue\nThreads_connected\t150\nmax_connections\t200')
    ]);
    assert.ok(mid.some((x) => x.title.includes('连接数偏高')));
    const low = dbdiag.localDbFindings('mysql', [
      mysqlSample('conn', 'c', 'Variable_name\tValue\nThreads_connected\t50\nmax_connections\t200')
    ]);
    assert.strictEqual(low.filter((x) => x.title.includes('连接数')).length, 0);
  });

  test('MySQL 复制 IO 线程停止 → critical', () => {
    const findings = dbdiag.localDbFindings('mysql', [
      mysqlSample('repl', '复制', 'Slave_IO_Running: No\nSlave_SQL_Running: Yes\nSeconds_Behind_Master: 0')
    ]);
    const f = findings.find((x) => x.title.includes('IO 线程已停止'));
    assert.ok(f, '应报 IO 线程停止');
    assert.strictEqual(f.severity, 'critical');
  });

  test('MySQL 复制延迟 >30s → high/critical（按 300s 分级）', () => {
    const f45 = dbdiag.localDbFindings('mysql', [
      mysqlSample('repl', '复制', 'Slave_IO_Running: Yes\nSlave_SQL_Running: Yes\nSeconds_Behind_Master: 45')
    ]).find((x) => x.title.includes('复制延迟'));
    assert.ok(f45 && f45.severity === 'high', `45s 应为 high：${JSON.stringify(f45)}`);
    const f600 = dbdiag.localDbFindings('mysql', [
      mysqlSample('repl', '复制', 'Slave_IO_Running: Yes\nSlave_SQL_Running: Yes\nSeconds_Behind_Master: 600')
    ]).find((x) => x.title.includes('复制延迟'));
    assert.ok(f600 && f600.severity === 'critical', `600s 应为 critical`);
  });

  test('缓冲池命中率 <95% → 报警；采集失败项不报', () => {
    const hit = dbdiag.localDbFindings('mysql', [
      mysqlSample('innodb', 'InnoDB', 'Variable_name\tValue\nInnodb_buffer_pool_reads\t100000\nInnodb_buffer_pool_read_requests\t1050000\nInnodb_row_lock_waits\t0\nInnodb_row_lock_time_avg\t0')
    ]).find((x) => x.title.includes('命中率'));
    assert.ok(hit, '命中率约 95.2%? 100000/(100000+1050000)=9.5% 应报');
    assert.ok(['high', 'medium'].includes(hit.severity));
    // 采集失败（ok:false）不产生任何发现
    assert.deepStrictEqual(
      dbdiag.localDbFindings('mysql', [{ id: 'conn', label: 'c', ok: false, output: '', error: 'denied' }]),
      []
    );
  });

  test('PostgreSQL 连接 >=90% → critical；缓存命中 <95% → 报警', () => {
    const findings = dbdiag.localDbFindings('postgres', [
      { id: 'conn', label: 'c', ok: true, output: 'current_conn\tmax_conn\tactive_conn\tidle_conn\n190\t200\t10\t180' },
      { id: 'cache', label: 'cache', ok: true, output: 'metric\tvalue\nhit_ratio\t91.5' }
    ]);
    assert.ok(findings.some((x) => x.title.includes('连接数接近上限') && x.severity === 'critical'));
    assert.ok(findings.some((x) => x.title.includes('缓存命中率偏低')));
  });

  test('采集全部正常且无问题 → 空 findings（语义：系统正常 ≠ 解析失败）', () => {
    const findings = dbdiag.localDbFindings('mysql', [
      mysqlSample('conn', 'c', 'Variable_name\tValue\nThreads_connected\t10\nmax_connections\t500'),
      mysqlSample('slow', 's', 'Variable_name\tValue\nSlow_queries\t1\nSelect_scan\t0\nCreated_tmp_disk_tables\t0'),
      mysqlSample('innodb', 'i', 'Variable_name\tValue\nInnodb_buffer_pool_reads\t10\nInnodb_buffer_pool_read_requests\t10000000\nInnodb_row_lock_waits\t0\nInnodb_row_lock_time_avg\t0')
    ]);
    assert.deepStrictEqual(findings, []);
  });

  test('MySQL/PostgreSQL 采集清单各自非空且 SQL 只读', () => {
    const mysql = dbdiag.collectItems('mysql');
    const pg = dbdiag.collectItems('postgres');
    assert.ok(mysql.length >= 6 && pg.length >= 5);
    const writeSql = /^\s*(insert|update|delete|drop|truncate|alter|create)\b/i;
    for (const item of [...mysql, ...pg]) {
      assert.ok(!writeSql.test(item.sql.replace(/--[^\n]*/g, '').trim()), `采集 SQL 疑似写操作：${item.sql}`);
    }
  });
});

describe('v1.7 性能调优建议（analyzeLinuxLocal / analyzeWindowsLocal）', () => {
  const perf = require(path.join(DIST, 'ai', 'perf', 'perftune.js'));

  test('采集清单：linux 8 项 / windows 5 项，均为只读命令', () => {
    const linux = perf.collectItems('linux');
    const win = perf.collectItems('windows');
    assert.strictEqual(linux.length, 8);
    assert.strictEqual(win.length, 5);
    // 剔除无副作用的 /dev/null 重定向后再判断是否含写操作
    const strip = (cmd) => cmd.replace(/\d*>\s*\/dev\/null\b/g, '');
    const mutating = /\bsysctl\s+-w\b|>(?!\/dev\/null)\s*\/(?!dev\/)|\btee\b|\bchmod\b|\breboot\b|\bSet-ItemProperty\b/;
    for (const item of [...linux, ...win]) {
      assert.ok(!mutating.test(strip(item.command)), `采集命令疑似有副作用：${item.command}`);
    }
  });

  test('somaxconn=128 → warning + 建议 4096 + 可复制命令', () => {
    const items = perf.analyzeLinuxLocal({
      'sysctl-net': 'net.core.somaxconn = 128\nnet.ipv4.tcp_fin_timeout = 60\nnet.ipv4.tcp_tw_reuse = 1'
    });
    const somax = items.find((i) => i.name === 'net.core.somaxconn');
    assert.ok(somax, '应检查 somaxconn');
    assert.strictEqual(somax.ok, false);
    assert.strictEqual(somax.severity, 'warning');
    assert.ok(somax.recommended.includes('4096'));
    assert.ok(somax.command.includes('sysctl -w net.core.somaxconn=4096'));
    const fin = items.find((i) => i.name === 'net.ipv4.tcp_fin_timeout');
    assert.ok(fin && fin.ok === false, 'fin_timeout 60 应判为待优化');
    assert.strictEqual(items.find((i) => i.name === 'net.ipv4.tcp_tw_reuse'), undefined, 'tw_reuse=1 合理不报');
  });

  test('参数合理时 ok=true 且 severity=info、无修改命令', () => {
    const items = perf.analyzeLinuxLocal({
      'sysctl-net': 'net.core.somaxconn = 65535\nnet.ipv4.tcp_fin_timeout = 15\nnet.ipv4.tcp_tw_reuse = 1',
      'sysctl-vm': 'vm.swappiness = 10\nvm.dirty_ratio = 10',
      limits: 'fs.file-max = 9223372036854775807\n65535'
    });
    for (const i of items) {
      if (i.ok) {
        assert.strictEqual(i.severity, 'info', `${i.name} 合理项应为 info`);
        assert.strictEqual(i.command, undefined, `${i.name} 合理项不应给修改命令`);
      }
    }
    assert.ok(items.some((i) => i.name === 'vm.swappiness' && i.ok));
    assert.ok(items.some((i) => i.name.includes('ulimit') && i.ok));
  });

  test('ulimit -n 过低 → critical', () => {
    const items = perf.analyzeLinuxLocal({ limits: 'fs.file-max = 1000000\n1024' });
    const ul = items.find((i) => i.name.includes('ulimit'));
    assert.ok(ul && ul.ok === false && ul.severity === 'critical', `1024 句柄应为 critical：${JSON.stringify(ul)}`);
  });

  test('load 超核数 → 报警并给排查命令', () => {
    const items = perf.analyzeLinuxLocal({ load: '4\n 3.50, 3.20, 2.90\nload average: 8.50, 3.20, 2.90' });
    const load = items.find((i) => i.name.includes('load average'));
    assert.ok(load, `负载 8.5/4核 应报警：${JSON.stringify(items.map((i) => i.name))}`);
    assert.ok(load.ok === false);
    assert.ok(load.severity === 'critical' || load.severity === 'warning');
    assert.ok(load.command.includes('top') || load.command.includes('ps'));
  });

  test('Windows：TCP 自动调优禁用 → warning + netsh 命令', () => {
    const items = perf.analyzeWindowsLocal({
      netsh: 'TCP Global Parameters\nReceive Window Auto-Tuning Level    : disabled\nReceive-Side Scaling    : enabled'
    });
    const t = items.find((i) => i.name.includes('自动调优'));
    assert.ok(t, '应报自动调优禁用');
    assert.strictEqual(t.ok, false);
    assert.ok(t.command.includes('netsh int tcp set global autotuninglevel=normal'));
  });

  test('空采集 → 空建议（不编造）', () => {
    assert.deepStrictEqual(perf.analyzeLinuxLocal({}), []);
    assert.deepStrictEqual(perf.analyzeWindowsLocal({}), []);
  });
});

// ============================ v1.8 安全审计本地规则引擎 ============================
describe('v1.8 安全审计本地规则引擎（runAuditRules / 降误报）', () => {
  const rules = require(path.join(DIST, 'ai', 'auditRules.js'));

  const CAPTURE = (extra = '') => [
    '=== AUDIT_SECTION: SSH_CONFIG ===',
    'PermitRootLogin yes',
    'PasswordAuthentication yes',
    'PermitEmptyPasswords no',
    'PubkeyAuthentication yes',
    '',
    '=== AUDIT_SECTION: SUID_BINARIES ===',
    '/usr/bin/sudo',
    '/usr/bin/passwd',
    '/usr/bin/mount',
    '/usr/local/bin/custom-backup',
    '',
    '=== AUDIT_SECTION: WORLD_WRITABLE_DIRS ===',
    '/etc/myapp',
    '/tmp',
    '',
    '=== AUDIT_SECTION: SENSITIVE_FILES ===',
    '--- /etc/shadow (permission: 640 root:shadow) ---',
    '--- /etc/sudoers (permission: 440 root:root) ---',
    '--- /root/.ssh/authorized_keys (permission: 600 root:root) ---',
    '--- /etc/passwd (permission: 644 root:root) ---',
    '',
    '=== AUDIT_SECTION: OPEN_PORTS ===',
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
    'LISTEN 0 128 127.0.0.1:6379 0.0.0.0:* users:(("redis-server",pid=2,fd=3))',
    '',
    '=== AUDIT_SECTION: SUDO_RULES ===',
    'User app may run the following commands:',
    '    (ALL : ALL) ALL',
    '',
    '=== AUDIT_END ===',
    extra
  ].join('\n');

  test('section 解析：多段采集文本正确分段', () => {
    const s = rules.parseAuditSections(CAPTURE());
    assert.ok(s.SSH_CONFIG.includes('PermitRootLogin'));
    assert.ok(s.SUID_BINARIES.includes('custom-backup'));
    assert.strictEqual(s.OPEN_PORTS.split('\n').length, 2);
    assert.deepStrictEqual(rules.parseAuditSections('普通文本无 section'), {}, '无 section 应返回空对象');
  });

  test('sshd PermitRootLogin yes → high 风险 + 有检查项', () => {
    const { checks, findings } = rules.runAuditRules(CAPTURE());
    const f = findings.find((x) => x.title.includes('root 直接登录'));
    assert.ok(f, '应报 root 直登');
    assert.strictEqual(f.severity, 'high');
    assert.strictEqual(f.source, 'rule');
    const c = checks.find((x) => x.id === 'sshd_permit_root');
    assert.strictEqual(c.status, 'fail');
  });

  test('sshd prohibit-password → 通过（不误报）', () => {
    const { checks, findings } = rules.runAuditRules(CAPTURE().replace('PermitRootLogin yes', 'PermitRootLogin prohibit-password'));
    const c = checks.find((x) => x.id === 'sshd_permit_root');
    assert.strictEqual(c.status, 'pass');
    assert.ok(!findings.some((x) => x.title.includes('root 直接登录')));
  });

  test('PermitEmptyPasswords yes → critical', () => {
    const { findings } = rules.runAuditRules(CAPTURE().replace('PermitEmptyPasswords no', 'PermitEmptyPasswords yes'));
    const f = findings.find((x) => x.title.includes('空密码'));
    assert.ok(f);
    assert.strictEqual(f.severity, 'critical');
  });

  test('标准 SUID 白名单不报（经典误报排除），非标准才报', () => {
    const only = CAPTURE().replace('/usr/local/bin/custom-backup\n', '');
    const r1 = rules.runAuditRules(only);
    assert.strictEqual(r1.checks.find((c) => c.id === 'suid').status, 'pass', '纯标准 SUID 应通过');
    assert.ok(!r1.findings.some((f) => f.title.includes('SUID')));

    const r2 = rules.runAuditRules(CAPTURE());
    const f = r2.findings.find((x) => x.title.includes('非标准 SUID'));
    assert.ok(f, '非标准 SUID 应报');
    assert.strictEqual(f.severity, 'high');
    assert.ok(f.evidence.includes('custom-backup'), 'evidence 应含具体路径');
  });

  test('全局可写：/tmp（sticky 公共目录）不报，真实目录报 medium', () => {
    const { checks, findings } = rules.runAuditRules(CAPTURE());
    const f = findings.find((x) => x.title.includes('全局可写目录'));
    assert.ok(f);
    assert.ok(!f.evidence.includes('/tmp'), 'sticky /tmp 不应出现在 evidence');
    assert.strictEqual(checks.find((c) => c.id === 'world_writable').status, 'fail');

    const onlyTmp = CAPTURE().replace('/etc/myapp\n', '');
    const r = rules.runAuditRules(onlyTmp);
    assert.strictEqual(r.checks.find((c) => c.id === 'world_writable').status, 'pass', '仅 /tmp 应通过');
  });

  test('敏感文件：shadow 640/sudoers 440/passwd 644 均通过（防误报）', () => {
    const { checks, findings } = rules.runAuditRules(CAPTURE());
    assert.strictEqual(checks.find((c) => c.id === 'shadow_perm').status, 'pass');
    assert.strictEqual(checks.find((c) => c.id === 'sudoers_perm').status, 'pass');
    assert.strictEqual(checks.find((c) => c.id === 'passwd_perm').status, 'pass');
    assert.ok(!findings.some((f) => f.title.includes('/etc/passwd')), 'passwd 644 是标准设计，绝不报');
  });

  test('敏感文件：shadow 644 → high；sudoers 644 → high；passwd 666 → critical', () => {
    const bad = CAPTURE()
      .replace('640 root:shadow', '644 root:shadow')
      .replace('440 root:root', '644 root:root')
      .replace('--- /etc/passwd (permission: 644 root:root) ---', '--- /etc/passwd (permission: 666 root:root) ---');
    const { findings } = rules.runAuditRules(bad);
    assert.strictEqual(findings.find((f) => f.title.includes('/etc/shadow')).severity, 'high');
    assert.strictEqual(findings.find((f) => f.title.includes('/etc/sudoers')).severity, 'high');
    assert.strictEqual(findings.find((f) => f.title.includes('任意用户写入')).severity, 'critical');
  });

  test('端口：0.0.0.0:6379 → high；127.0.0.1:6379 与 22 端口不报', () => {
    const { checks, findings } = rules.runAuditRules(CAPTURE());
    const exposed = findings.filter((f) => f.category === '网络' && f.title.includes('Redis'));
    assert.strictEqual(exposed.length, 0, '本地 redis 不应报');

    const bad = CAPTURE().replace('127.0.0.1:6379', '0.0.0.0:6379');
    const r2 = rules.runAuditRules(bad);
    const f2 = r2.findings.find((x) => x.title.includes('Redis'));
    assert.ok(f2, '公网暴露 redis 应报');
    assert.strictEqual(f2.severity, 'high');
    assert.ok(!r2.findings.some((x) => x.title.includes('22')), 'SSH 22 端口是正常服务，不报');
    assert.strictEqual(r2.checks.find((c) => c.id === 'open_ports').status, 'fail');
  });

  test('sudo：NOPASSWD: ALL → medium；常规需口令规则 → 通过', () => {
    const { checks, findings } = rules.runAuditRules(CAPTURE());
    assert.strictEqual(checks.find((c) => c.id === 'sudo_rules').status, 'pass', '常规 (ALL : ALL) 需口令，不报');

    const bad = CAPTURE().replace('    (ALL : ALL) ALL', '    (ALL : ALL) NOPASSWD: ALL');
    const r2 = rules.runAuditRules(bad);
    const f = r2.findings.find((x) => x.title.includes('NOPASSWD: ALL'));
    assert.ok(f);
    assert.strictEqual(f.severity, 'medium');
  });

  test('通用模式：私钥 → critical；AWS Key → critical', () => {
    const { findings } = rules.runAuditRules('config:/n  key: |\n    -----BEGIN OPENSSH PRIVATE KEY-----\nblob\n');
    assert.strictEqual(findings.find((f) => f.title.includes('私钥')).severity, 'critical');

    const { findings: f2 } = rules.runAuditRules('id = AKIAIOSFODNN7EXAMPLE');
    assert.ok(f2.some((f) => f.title.includes('AccessKey')));
  });

  test('通用模式：占位符密码不报（防误报），真实明文密码报 high', () => {
    for (const placeholder of ['password = <your_password>', 'password: ${DB_PASS}', 'password=changeme123456', 'passwd: xxxx']) {
      // changeme 类弱口令仍属真实风险 → 只对纯占位符断言
      if (placeholder.includes('changeme')) continue;
      const { findings } = rules.runAuditRules(`db:/n  ${placeholder}\n`);
      assert.ok(!findings.some((f) => f.title.includes('明文口令')), `占位符不应报：${placeholder}`);
    }
    const { findings } = rules.runAuditRules('mysql:/n  password: SuperSecret99\n');
    const f = findings.find((x) => x.title.includes('明文口令'));
    assert.ok(f, '真实明文密码应报');
    assert.strictEqual(f.severity, 'high');
  });

  test('通用模式：curl | sh → medium；chmod 777 → medium', () => {
    const { findings } = rules.runAuditRules('install:/n  - curl -fsSL https://x.io/i.sh | sh\n  - chmod 777 /opt/app\n');
    assert.strictEqual(findings.find((f) => f.title.includes('管道执行')).severity, 'medium');
    assert.strictEqual(findings.find((f) => f.title.includes('chmod 777')).severity, 'medium');
  });

  test('Windows NOTE 段 → 全部跳过，不编造风险', () => {
    const win = '=== AUDIT_SECTION: NOTE ===\n安全审计检查项当前仅支持 Linux 远端（Windows 检查集规划中），本次未执行审计。\n\n=== AUDIT_SECTION: BASIC_INFO ===\nWindows Server';
    const { checks, findings } = rules.runAuditRules(win);
    assert.strictEqual(findings.length, 0, '不编造');
    assert.ok(checks.every((c) => c.status === 'skip'));
  });

  test('display-only 段透明登记为跳过（服务/cron/证书）', () => {
    const cap = CAPTURE().replace('=== AUDIT_END ===', [
      '=== AUDIT_SECTION: RUNNING_SERVICES ===',
      'sshd.service loaded active running',
      '',
      '=== AUDIT_SECTION: CRON_JOBS ===',
      'drwxr-xr-x root root /etc/cron.d',
      '',
      '=== AUDIT_END ==='
    ].join('\n'));
    const { checks } = rules.runAuditRules(cap);
    const svc = checks.find((c) => c.id === 'running_services');
    assert.ok(svc);
    assert.strictEqual(svc.status, 'skip');
    assert.ok(svc.detail.includes('人工复核'));
  });

  test('新采集段：docker.sock 666 → high；PASS_MAX_DAYS 99999 → low；fail2ban inactive → low', () => {
    const cap = CAPTURE().replace('=== AUDIT_END ===', [
      '=== AUDIT_SECTION: DOCKER_SOCKET ===',
      '666 root:root',
      '',
      '=== AUDIT_SECTION: AUTH_POLICY ===',
      'PASS_MAX_DAYS\t99999',
      '',
      '=== AUDIT_SECTION: FAIL2BAN ===',
      'inactive',
      '',
      '=== AUDIT_END ==='
    ].join('\n'));
    const { findings } = rules.runAuditRules(cap);
    assert.strictEqual(findings.find((f) => f.title.includes('docker.sock')).severity, 'high');
    assert.strictEqual(findings.find((f) => f.title.includes('口令有效期')).severity, 'low');
    assert.strictEqual(findings.find((f) => f.title.includes('fail2ban')).severity, 'low');
  });

  test('新采集段：docker.sock 660 root:docker → 通过；fail2ban active → 通过', () => {
    const cap = CAPTURE().replace('=== AUDIT_END ===', [
      '=== AUDIT_SECTION: DOCKER_SOCKET ===',
      '660 root:docker',
      '',
      '=== AUDIT_SECTION: FAIL2BAN ===',
      'active',
      '',
      '=== AUDIT_END ==='
    ].join('\n'));
    const { checks, findings } = rules.runAuditRules(cap);
    assert.strictEqual(checks.find((c) => c.id === 'docker_socket').status, 'pass');
    assert.strictEqual(checks.find((c) => c.id === 'fail2ban').status, 'pass');
    assert.ok(!findings.some((f) => f.title.includes('docker.sock') || f.title.includes('fail2ban')));
  });

  test('computeScore：确定性扣分且封底 0', () => {
    assert.strictEqual(rules.computeScore([]), 100);
    assert.strictEqual(rules.computeScore([{ severity: 'critical' }, { severity: 'high' }]), 60);
    assert.strictEqual(rules.computeScore([{ severity: 'medium' }, { severity: 'low' }, { severity: 'info' }]), 88);
    assert.strictEqual(rules.computeScore(Array(10).fill({ severity: 'critical' })), 0);
  });

  test('verifyEvidence：逐字命中 → true；转述/编造 → false；空白差异容忍', () => {
    const content = 'PermitRootLogin yes\nPasswordAuthentication no';
    assert.strictEqual(rules.verifyEvidence('PermitRootLogin yes', content), true);
    assert.strictEqual(rules.verifyEvidence('  PermitRootLogin   yes  ', content), true, '空白差异应容忍');
    assert.strictEqual(rules.verifyEvidence('root 登录已开启', content), false, '转述应判不实');
    assert.strictEqual(rules.verifyEvidence('HostAllow 10.0.0.0/8', content), false, '编造应判不实');
    assert.strictEqual(rules.verifyEvidence('', content), false, '空证据不可信');
  });

  test('mergeAuditFindings：证据不实剔除 + 证据同源去重 + 非法 severity 降级', () => {
    const content = 'PermitRootLogin yes\nMaxSessions 10';
    const ruleF = [{ severity: 'high', title: 'SSH 允许 root 直接登录', evidence: 'PermitRootLogin yes' }];
    const aiF = [
      // 证据与规则同源 → 视为重复，剔除（无论标题是否相近）
      { severity: 'critical', title: 'SSH 允许 root 登录', evidence: 'PermitRootLogin yes' },
      // 证据无法逐字命中原文（AI 转述/编造）→ 剔除
      { severity: 'high', title: '防火墙未配置', evidence: 'ufw status 显示 inactive 且存在高危端口' },
      // 证据独立命中原文 + 非法 severity → 保留并降级为 info
      { severity: '超高危', title: '会话数未限制', evidence: 'MaxSessions 10' }
    ];
    const out = rules.mergeAuditFindings(ruleF, aiF, content);
    assert.strictEqual(out.dropped, 2, '同源与证据不实各剔 1 条');
    assert.strictEqual(out.findings.length, 2, '保留规则版 + 独立证据的 AI 版');
    const keptAi = out.findings.find((f) => f.title.includes('会话数'));
    assert.ok(keptAi, '独立证据的 AI 发现应保留');
    assert.strictEqual(keptAi.severity, 'info', '非法 severity 应降级为 info');
    assert.strictEqual(out.findings[0].severity, 'high', '规则版在前');
  });

  test('安全审计采集命令：全部只读，且不再外传敏感文件内容', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ssh.ts'), 'utf8');
    const fn = src.slice(src.indexOf('async getSecurityAuditData'), src.indexOf('async getDiagnosticsBundle'));
    // 只读红线：无写操作/无破坏性命令
    const mutating = /\bchmod\b|\brm\b|\bmv\b|\btee\b|\bsysctl\s+-w\b|\btruncate\b|>\s*\/(?!dev\/)|\bSet-ItemProperty\b|\bpasswd\s+\<|\buseradd\b|\buserdel\b|\bchown\b/;
    assert.ok(!mutating.test(fn), '安全审计采集命令必须只读');
    // sticky 排除（/tmp 1777 不再被当成全局可写）
    assert.ok(fn.includes('! -perm -1000'), '可写目录采集应排除 sticky 位');
    // 不再 head 输出 shadow/passwd 等文件内容（防哈希/凭据外流进 AI）
    assert.ok(!fn.includes('head -5 "$f"'), '敏感文件只取权限，不取内容');
    // 采集包含 v1.8 新增段
    for (const seg of ['AUTH_POLICY', 'DOCKER_SOCKET', 'FAIL2BAN']) {
      assert.ok(fn.includes(`AUDIT_SECTION: ${seg}`), `缺少 ${seg} 段`);
    }
    // sshd drop-in 覆盖
    assert.ok(fn.includes('sshd_config.d'), '应覆盖 sshd_config.d drop-in');
  });
});

describe('v1.8 审计结果组装（parseAuditResult 兼容 + 合并管线）', () => {
  const audit = require(path.join(DIST, 'ai', 'audit.js'));

  test('parseAuditResult：正常 JSON → findings 数组', () => {
    const r = audit.parseAuditResult('```json\n{"summary":"ok","score":90,"findings":[{"severity":"low","title":"t"}]}\n```');
    assert.strictEqual(r.score, 90);
    assert.strictEqual(r.findings.length, 1);
    assert.strictEqual(r.parseError, undefined);
  });

  test('parseAuditResult：非 JSON → parseError 标记（区分解析失败与系统正常）', () => {
    const r = audit.parseAuditResult('抱歉，我无法输出 JSON');
    assert.strictEqual(r.parseError, true);
    assert.strictEqual(r.findings.length, 0);
    assert.ok(r.rawExcerpt);
  });

  test('parseAuditResult：截断输出 → 抢救完整 findings 并标记 truncated', () => {
    const cut = '{"summary":"部分","score":70,"findings":[{"severity":"high","title":"A"},{"severity":"low","title":"B"},{"severity":"info","title":"C';
    const r = audit.parseAuditResult(cut);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.findings.length, 2, '只抢救已闭合对象');
  });
});

// ============================ v1.9 内置知识库 ============================
describe('v1.9 内置知识库（knowledge / seed / 检索）', () => {
  const knowledge = require(path.join(DIST, 'ai', 'knowledge', 'index.js'));

  test('规模：至少 60 篇，id 唯一且以 builtin- 开头', () => {
    const all = knowledge.ALL_KNOWLEDGE;
    assert.ok(all.length >= 60, `当前 ${all.length} 篇，应 ≥60`);
    const ids = new Set(all.map((k) => k.id));
    assert.strictEqual(ids.size, all.length, 'id 必须唯一');
    for (const k of all) {
      assert.ok(k.id.startsWith('builtin-'), `id 应为 builtin- 前缀：${k.id}`);
      assert.ok(k.title && k.title.length >= 4, `${k.id} 标题缺失`);
      assert.ok(k.category, `${k.id} 分类缺失`);
    }
  });

  test('内容充实：每篇正文 ≥150 字符', () => {
    for (const k of knowledge.ALL_KNOWLEDGE) {
      assert.ok(k.content.length >= 150, `${k.id} 内容过短（${k.content.length} 字符）`);
    }
  });

  test('分类覆盖：8 大分类且每类 ≥5 篇', () => {
    const cats = knowledge.KNOWLEDGE_CATEGORIES;
    const expect = ['系统排障', 'SSH 远程', '网络安全', '数据库', 'Web与中间件', '性能调优', 'Windows运维', '监控与应急'];
    for (const c of expect) assert.ok(cats.includes(c), `缺少分类：${c}`);
    for (const c of expect) {
      const n = knowledge.ALL_KNOWLEDGE.filter((k) => k.category === c).length;
      assert.ok(n >= 5, `分类 ${c} 仅 ${n} 篇，应 ≥5`);
    }
  });

  test('内容红线：不含删除根目录等破坏性示例', () => {
    for (const k of knowledge.ALL_KNOWLEDGE) {
      assert.ok(!/\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(\s|\*|$)/.test(k.content), `${k.id} 含 rm -rf 根删除示例`);
      assert.ok(!/\bmkfs\b/.test(k.content), `${k.id} 含 mkfs 示例`);
      assert.ok(!/\bdd\s+if=.*of=\/dev\//.test(k.content), `${k.id} 含 dd 写盘示例`);
    }
  });

  test('关键词检索命中：磁盘满、SSH 断连、慢查询、502 各命中对应篇章', () => {
    const queries = [
      ['磁盘满了怎么清理', '磁盘'],
      ['SSH 老是自动断开', 'SSH'],
      ['MySQL 慢查询优化', '慢查询'],
      ['nginx 502 错误', '502'],
      ['服务器被入侵了怎么办', '入侵']
    ];
    for (const [q, expect] of queries) {
      const top = knowledge.ALL_KNOWLEDGE.find((k) => k.title.includes(expect) || k.content.includes(expect));
      assert.ok(top, `应存在含「${expect}」的知识`);
    }
    // 走真实检索管线（retrieve 依赖 tokens）
    const rag = require(path.join(DIST, 'ai', 'rag.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-rag-'));
    const oldEnv = process.env.NEBULA_RUNBOOK_DIR;
    process.env.NEBULA_RUNBOOK_DIR = tmp;
    try {
      const seeded = rag.ensureDefaultRunbooks();
      assert.ok(seeded.seeded >= 60, `seed 应写入 ≥60 篇，实际 ${seeded.seeded}`);
      const results = rag.retrieve('磁盘空间满了如何清理', 3);
      assert.ok(results.length > 0, '检索应有结果');
      assert.ok(results[0].score > 0.02, `top1 相似度过低：${results[0].score}`);
      assert.ok(
        results.some((r) => r.doc.title.includes('磁盘') || r.excerpt.includes('磁盘')),
        '磁盘问题应命中磁盘相关知识'
      );
    } finally {
      if (oldEnv === undefined) delete process.env.NEBULA_RUNBOOK_DIR;
      else process.env.NEBULA_RUNBOOK_DIR = oldEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('seed 幂等：空库写入、已有内容不覆盖、用户删除后不复活', () => {
    const rag = require(path.join(DIST, 'ai', 'rag.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-rag-'));
    const oldEnv = process.env.NEBULA_RUNBOOK_DIR;
    process.env.NEBULA_RUNBOOK_DIR = tmp;
    try {
      const first = rag.ensureDefaultRunbooks();
      assert.ok(first.seeded >= 60);
      // 再跑：已有内容 → 不重复写
      assert.strictEqual(rag.ensureDefaultRunbooks().seeded, 0);
      // 用户删 3 篇 → ensure 不复活（尊重用户删除）
      const docs = rag.loadRunbooks();
      for (const d of docs.slice(0, 3)) rag.removeRunbook(d.id);
      const afterDelete = rag.loadRunbooks().length;
      assert.strictEqual(rag.ensureDefaultRunbooks().seeded, 0, '删除后 ensure 不应复活');
      assert.strictEqual(rag.loadRunbooks().length, afterDelete);
    } finally {
      if (oldEnv === undefined) delete process.env.NEBULA_RUNBOOK_DIR;
      else process.env.NEBULA_RUNBOOK_DIR = oldEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('restore 幂等：删 3 篇补回 3 篇、再跑补 0 篇、自定义文档不被删', () => {
    const rag = require(path.join(DIST, 'ai', 'rag.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-rag-'));
    const oldEnv = process.env.NEBULA_RUNBOOK_DIR;
    process.env.NEBULA_RUNBOOK_DIR = tmp;
    try {
      rag.ensureDefaultRunbooks();
      // 加一篇自定义文档
      rag.addRunbook('我的运维笔记', 'mine.md', '这是团队自己的私有 runbook 内容，恢复内置时不得丢失。');
      const docs = rag.loadRunbooks();
      for (const d of docs.filter((x) => x.builtin).slice(0, 3)) rag.removeRunbook(d.id);
      const r1 = rag.restoreBuiltinRunbooks();
      assert.strictEqual(r1.added, 3, '应精确补回 3 篇');
      const r2 = rag.restoreBuiltinRunbooks();
      assert.strictEqual(r2.added, 0, '再次恢复应为 0（幂等）');
      const final = rag.loadRunbooks();
      assert.ok(final.some((d) => d.title === '我的运维笔记'), '自定义文档不得被恢复覆盖');
      const stats = rag.builtinStats();
      assert.strictEqual(stats.present, stats.total, '恢复后内置知识应齐全');
      assert.ok(stats.total >= 60);
    } finally {
      if (oldEnv === undefined) delete process.env.NEBULA_RUNBOOK_DIR;
      else process.env.NEBULA_RUNBOOK_DIR = oldEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================ v2.0 离线许可激活 ============================
describe('v2.0 离线许可激活', () => {
  const lic = require(path.join(DIST, 'license.js'));
  // 测试密钥（与产品内置密钥隔离，避免测试污染真实许可目录）
  const TEST_KEY_B64 = crypto.randomBytes(32).toString('base64');
  const REAL_MACHINE = lic.rawMachineCode().toString('hex').toUpperCase();

  /** 在临时许可目录 + 测试密钥下运行 fn，结束后恢复 env */
  function withLicenseEnv(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-lic-'));
    const oldDir = process.env.NEBULA_LICENSE_DIR;
    const oldKey = process.env.NEBULA_LICENSE_KEY;
    process.env.NEBULA_LICENSE_DIR = tmp;
    process.env.NEBULA_LICENSE_KEY = TEST_KEY_B64;
    try {
      return fn(tmp);
    } finally {
      if (oldDir === undefined) delete process.env.NEBULA_LICENSE_DIR;
      else process.env.NEBULA_LICENSE_DIR = oldDir;
      if (oldKey === undefined) delete process.env.NEBULA_LICENSE_KEY;
      else process.env.NEBULA_LICENSE_KEY = oldKey;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test('机器码格式：32 hex 分 8 组，normalize 兼容连字符与小写', () => {
    const code = lic.machineCode();
    assert.match(code, /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/, `机器码格式异常：${code}`);
    assert.strictEqual(lic.normalizeMachineCode(code), code.replace(/-/g, ''));
    assert.strictEqual(lic.normalizeMachineCode(code.toLowerCase()), code.replace(/-/g, ''));
    assert.strictEqual(lic.normalizeMachineCode('short'), null);
  });

  test('签发/验签往返：perpetual 与 subscription 字段正确', () => {
    const perp = lic.issueLicenseCode(REAL_MACHINE, 'perpetual', null);
    const p = lic.verifyLicenseCode(perp, REAL_MACHINE);
    assert.ok(p, '永久码应验签通过');
    assert.strictEqual(p.type, 'perpetual');
    assert.strictEqual(p.expDays, null);
    assert.strictEqual(p.machine, REAL_MACHINE);
    const day = lic.tsToDay(Date.now()) + 365;
    const sub = lic.issueLicenseCode(REAL_MACHINE, 'subscription', day);
    const s = lic.verifyLicenseCode(sub, REAL_MACHINE);
    assert.strictEqual(s.type, 'subscription');
    assert.strictEqual(s.expDays, day);
  });

  test('验签红线：篡改任一位、机器不匹配、伪造前缀均拒绝', () => {
    const code = lic.issueLicenseCode(REAL_MACHINE, 'perpetual', null);
    assert.ok(lic.verifyLicenseCode(code, REAL_MACHINE), '未篡改码应验签通过');
    // 篡改中间一个字符（保持合法 base32 字符）→ HMAC 失败
    const chars = code.split('');
    const idx = 10;
    chars[idx] = chars[idx] === 'A' ? 'B' : 'A';
    assert.strictEqual(lic.verifyLicenseCode(chars.join(''), REAL_MACHINE), null, '篡改码应验签失败');
    // 机器不匹配：换机器码
    const otherMachine = '0'.repeat(32);
    assert.strictEqual(lic.verifyLicenseCode(code, otherMachine), null, '机器不匹配应拒绝');
    // 验签不带机器参数时可解析（供激活时区分错误类型）
    assert.ok(lic.verifyLicenseCode(code), '不带机器参数应可解析');
    // 伪造前缀 / 随机串
    assert.strictEqual(lic.verifyLicenseCode('FAKE1-ABCDE-FGHJK'), null);
    assert.strictEqual(lic.verifyLicenseCode(''), null);
  });

  test('激活状态机：激活→activated、注销→trial、无效码区分报错', () => {
    withLicenseEnv(() => {
      const trial = lic.getLicenseState();
      assert.strictEqual(trial.status, 'trial');
      assert.ok(trial.trialDaysLeft > 0 && trial.trialDaysLeft <= 14);
      // 绑定其他机器的码 → 明确提示换码
      const foreign = lic.issueLicenseCode('11'.repeat(16), 'perpetual', null);
      const rForeign = lic.activateLicense(foreign);
      assert.strictEqual(rForeign.ok, false);
      assert.match(rForeign.error, /其他机器/);
      // 完全无效的码
      const rBad = lic.activateLicense('NBX1-GARBAGE');
      assert.strictEqual(rBad.ok, false);
      assert.match(rBad.error, /无效/);
      // 正常激活
      const code = lic.issueLicenseCode(REAL_MACHINE, 'subscription', lic.tsToDay(Date.now()) + 30);
      const r = lic.activateLicense(code);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.state.status, 'activated');
      assert.ok(r.state.license.expiresAt, '订阅应有到期时间');
      // 注销回到试用
      assert.strictEqual(lic.deactivateLicense().ok, true);
      assert.strictEqual(lic.getLicenseState().status, 'trial');
    });
  });

  test('过期订阅码拒绝激活；已过期订阅显示 expired（只读）', () => {
    withLicenseEnv(() => {
      // 签发时即已过期（到期日 = 昨天）的码
      const past = lic.tsToDay(Date.now()) - 1;
      const expiredCode = lic.issueLicenseCode(REAL_MACHINE, 'subscription', past);
      const r = lic.activateLicense(expiredCode);
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /过期/);
      // 绕过 activate 直接落盘（模拟旧版本遗留/手改文件），状态应为 expired
      fs.writeFileSync(
        path.join(process.env.NEBULA_LICENSE_DIR, 'license.json'),
        JSON.stringify({ code: expiredCode, activatedAt: new Date().toISOString(), maxSeenTs: Date.now() })
      );
      const st = lic.getLicenseState();
      assert.strictEqual(st.status, 'expired');
      assert.ok(st.license, 'expired 时仍应展示原许可信息');
      assert.strictEqual(lic.isReadOnly(), true);
    });
  });

  test('试用期耗尽→expired；maxSeenTs 防时间回拨绕过', () => {
    withLicenseEnv((tmp) => {
      // 初始化试用
      lic.getLicenseState();
      const now = Date.now();
      // 模拟试用已开始 15 天前
      fs.writeFileSync(
        path.join(tmp, 'trial.json'),
        JSON.stringify({ startTs: now - 15 * 86400000, maxSeenTs: now })
      );
      assert.strictEqual(lic.getLicenseState().status, 'expired');
      // 时间回拨防护：把 startTs 改回今天（想重新试用），但 maxSeenTs 记录过 15 天前的"现在"
      // —— 实际场景是系统时间被拨回；maxSeenTs 应始终不减
      fs.writeFileSync(
        path.join(tmp, 'trial.json'),
        JSON.stringify({ startTs: now - 15 * 86400000, maxSeenTs: now - 13 * 86400000 })
      );
      lic.getLicenseState();
      const rec = JSON.parse(fs.readFileSync(path.join(tmp, 'trial.json'), 'utf8'));
      assert.ok(rec.maxSeenTs >= now - 13 * 86400000, 'maxSeenTs 不应回退');
      assert.ok(rec.maxSeenTs >= now, 'maxSeenTs 应取见过的最大值（当前时间）');
    });
  });

  test('时间回拨绕过订阅到期：maxSeenTs 在未来时按最大时间判过期', () => {
    withLicenseEnv((tmp) => {
      // 明天到期的订阅
      const code = lic.issueLicenseCode(REAL_MACHINE, 'subscription', lic.tsToDay(Date.now()) + 1);
      lic.activateLicense(code);
      // 系统时间被人为拨到 5 天后？不——防护方向：maxSeenTs 已记录未来时间（曾正常运行过），
      // 即使当前 now 更小（时间被拨回），也按 maxSeenTs 判定
      const licFile = path.join(tmp, 'license.json');
      const rec = JSON.parse(fs.readFileSync(licFile, 'utf8'));
      rec.maxSeenTs = Date.now() + 5 * 86400000; // 曾见过 5 天后（订阅应已过期）
      fs.writeFileSync(licFile, JSON.stringify(rec));
      assert.strictEqual(lic.getLicenseState().status, 'expired', '按 maxSeenTs 判定应已过期');
    });
  });

  test('license.json 被篡改（改码一位）→ 验签失败回落试用', () => {
    withLicenseEnv((tmp) => {
      const code = lic.issueLicenseCode(REAL_MACHINE, 'perpetual', null);
      lic.activateLicense(code);
      assert.strictEqual(lic.getLicenseState().status, 'activated');
      const licFile = path.join(tmp, 'license.json');
      const rec = JSON.parse(fs.readFileSync(licFile, 'utf8'));
      const chars = rec.code.split('');
      chars[12] = chars[12] === 'A' ? 'B' : 'A';
      rec.code = chars.join('');
      fs.writeFileSync(licFile, JSON.stringify(rec));
      assert.strictEqual(lic.getLicenseState().status, 'trial', '篡改后应回落试用');
    });
  });

  test('发码工具往返：license-gen.cjs 签发的码可被主进程验签激活', () => {
    withLicenseEnv((tmp) => {
      // 用测试密钥初始化工具密钥文件
      const keyFile = path.join(tmp, 'tool.key');
      fs.writeFileSync(keyFile, TEST_KEY_B64);
      const { execFileSync } = require('node:child_process');
      const out = execFileSync(process.execPath, [
        path.join(__dirname, '..', 'tools', 'license-gen.cjs'),
        'issue', '--machine', lic.machineCode(), '--type', 'subscription', '--months', '6', '--key', keyFile
      ], { encoding: 'utf8' });
      const m = /激活码：(NBX1-[0-9A-Z-]+)/.exec(out);
      assert.ok(m, `工具输出应含激活码：${out}`);
      const r = lic.activateLicense(m[1]);
      assert.strictEqual(r.ok, true, '工具签发的码应可激活');
      assert.strictEqual(r.state.status, 'activated');
      assert.strictEqual(r.state.license.type, 'subscription');
    });
  });

  test('Crockford 容错：小写、I/L→1、O→0、含连字符均可验签', () => {
    withLicenseEnv(() => {
      const code = lic.issueLicenseCode(REAL_MACHINE, 'perpetual', null);
      const lower = code.toLowerCase();
      assert.ok(lic.verifyLicenseCode(lower, REAL_MACHINE), '小写应通过');
      // I/L→1、O→0 映射：仅映射码体（前缀 NBX1 含数字 1，不参与映射）
      const mapped = code.slice(0, 5) + code.slice(5).replace(/[1]/g, 'I').replace(/[0]/g, 'O').toLowerCase();
      assert.ok(lic.verifyLicenseCode(mapped, REAL_MACHINE), 'I/L/O 容错映射应通过');
      // 连字符多余或缺失
      assert.ok(lic.verifyLicenseCode(code.replace(/-/g, ''), REAL_MACHINE), '无连字符应通过');
    });
  });
});
