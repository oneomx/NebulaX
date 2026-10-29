/**
 * v1.4 定时巡检模块测试（node:test）
 * 覆盖：阈值评估（CPU/内存/磁盘、warning/critical 分级）、报告生成
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { evaluateSnapshot, formatPatrolReport } = require(path.join(__dirname, '..', 'dist-electron', 'patrol.js'));

const TH = { cpu: 85, mem: 90, disk: 90 };

function snap(overrides = {}) {
  return {
    ts: Date.now(),
    hostname: 'host1',
    cpuPercent: 10,
    memPercent: 20,
    disk: [{ mount: '/', usePercent: 30, availGB: 100 }],
    load1: 0.1,
    connections: 5,
    ...overrides
  };
}

describe('evaluateSnapshot', () => {
  test('低于阈值不产生告警', () => {
    const alerts = evaluateSnapshot(snap(), TH);
    assert.strictEqual(alerts.length, 0);
  });

  test('CPU 超阈值产生 warning 告警', () => {
    const alerts = evaluateSnapshot(snap({ cpuPercent: 90 }), TH);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].resource, 'cpu');
    assert.strictEqual(alerts[0].severity, 'warning');
    assert.strictEqual(alerts[0].currentPercent, 90);
    assert.ok(alerts[0].command, '告警应带排查命令');
  });

  test('CPU >= 95 升级为 critical', () => {
    const alerts = evaluateSnapshot(snap({ cpuPercent: 96.5 }), TH);
    assert.strictEqual(alerts[0].severity, 'critical');
  });

  test('内存超阈值产生 mem 告警', () => {
    const alerts = evaluateSnapshot(snap({ memPercent: 92 }), TH);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].resource, 'mem');
    assert.strictEqual(alerts[0].severity, 'warning');
  });

  test('单个磁盘超阈值告警带挂载点', () => {
    const s = snap({
      disk: [
        { mount: '/', usePercent: 50, availGB: 100 },
        { mount: '/data', usePercent: 93, availGB: 5 }
      ]
    });
    const alerts = evaluateSnapshot(s, TH);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].resource, 'disk');
    assert.strictEqual(alerts[0].mount, '/data');
    assert.strictEqual(alerts[0].currentPercent, 93);
  });

  test('磁盘 >= 95 升级为 critical', () => {
    const s = snap({ disk: [{ mount: '/', usePercent: 97, availGB: 1 }] });
    const alerts = evaluateSnapshot(s, TH);
    assert.strictEqual(alerts[0].severity, 'critical');
  });

  test('多项同时超阈值全部返回', () => {
    const s = snap({
      cpuPercent: 99,
      memPercent: 95,
      disk: [{ mount: '/', usePercent: 96, availGB: 1 }]
    });
    const alerts = evaluateSnapshot(s, TH);
    assert.strictEqual(alerts.length, 3);
    assert.ok(alerts.every((a) => a.severity === 'critical'));
  });
});

describe('formatPatrolReport', () => {
  test('正常主机报告包含 ✅ 与汇总行', () => {
    const report = formatPatrolReport(
      [{ host: 'web-1', ok: true, snapshot: snap(), alerts: [] }],
      new Date('2026-01-02T10:00:00')
    );
    assert.ok(report.includes('# 巡检报告'));
    assert.ok(report.includes('## web-1'));
    assert.ok(report.includes('✅ 各项指标正常'));
    assert.ok(report.includes('巡检主机：1 台'));
    assert.ok(report.includes('异常项：0'));
  });

  test('告警主机报告包含级别、资源与命令', () => {
    const s = snap({ cpuPercent: 91, disk: [{ mount: '/data', usePercent: 94, availGB: 3 }] });
    const alerts = evaluateSnapshot(s, TH);
    const report = formatPatrolReport([{ host: 'db-1', ok: true, snapshot: s, alerts }], new Date('2026-01-02T10:00:00'));
    assert.ok(report.includes('🟡 警告 CPU 91%'));
    assert.ok(report.includes('磁盘 /data 94%'));
    assert.ok(report.includes('top -bn1'));
    assert.ok(report.includes('异常项：2'));
  });

  test('巡检失败主机报告包含错误信息', () => {
    const report = formatPatrolReport(
      [{ host: 'down-1', ok: false, error: 'connect timeout', alerts: [] }],
      new Date('2026-01-02T10:00:00')
    );
    assert.ok(report.includes('❌ 巡检失败：connect timeout'));
  });
});
