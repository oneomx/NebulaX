/**
 * AI token 用量记账（v1.4）
 * - 按天按模型聚合：日期 -> { promptTokens, completionTokens, calls }
 * - 落盘 ~/.nebula-ssh/token-usage.json，保留最近 90 天
 * - 供设置页展示与成本估算（用户可按自家单价换算）
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const USAGE_FILE = path.join(os.homedir(), '.nebula-ssh', 'token-usage.json');
const KEEP_DAYS = 90;

export interface DayUsage {
  date: string; // YYYY-MM-DD
  model: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

interface UsageFile {
  version: 1;
  entries: DayUsage[];
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function load(): UsageFile {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.entries)) return { version: 1, entries: parsed.entries };
    }
  } catch {
    /* corrupted -> start fresh */
  }
  return { version: 1, entries: [] };
}

function save(f: UsageFile): void {
  // 只保留最近 KEEP_DAYS 天
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  f.entries = f.entries.filter((e) => e.date >= cutoffStr);
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(f, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** 记账一次 AI 调用 */
export function recordUsage(model: string, promptTokens: number, completionTokens: number): void {
  const f = load();
  const date = today();
  const entry = f.entries.find((e) => e.date === date && e.model === model);
  if (entry) {
    entry.promptTokens += promptTokens;
    entry.completionTokens += completionTokens;
    entry.calls += 1;
  } else {
    f.entries.push({ date, model, promptTokens, completionTokens, calls: 1 });
  }
  save(f);
}

export interface UsageSummary {
  /** 今日汇总 */
  today: { promptTokens: number; completionTokens: number; totalTokens: number; calls: number };
  /** 按天明细（近 30 天，含模型维度） */
  daily: DayUsage[];
  /** 按模型汇总（全周期） */
  byModel: { model: string; promptTokens: number; completionTokens: number; totalTokens: number; calls: number }[];
}

/** 查询用量汇总 */
export function getUsage(): UsageSummary {
  const f = load();
  const date = today();
  const daily = [...f.entries].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 90);
  const todayEntries = f.entries.filter((e) => e.date === date);
  const t = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  for (const e of todayEntries) {
    t.promptTokens += e.promptTokens;
    t.completionTokens += e.completionTokens;
    t.calls += e.calls;
  }
  t.totalTokens = t.promptTokens + t.completionTokens;

  const modelMap = new Map<string, { model: string; promptTokens: number; completionTokens: number; totalTokens: number; calls: number }>();
  for (const e of f.entries) {
    let m = modelMap.get(e.model);
    if (!m) {
      m = { model: e.model, promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
      modelMap.set(e.model, m);
    }
    m.promptTokens += e.promptTokens;
    m.completionTokens += e.completionTokens;
    m.calls += e.calls;
    m.totalTokens += e.promptTokens + e.completionTokens;
  }
  const byModel = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return { today: t, daily, byModel };
}
