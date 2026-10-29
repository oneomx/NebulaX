/**
 * RAG 知识库 — 本地 runbook / SOP 文档向量化检索
 * 简化版：用 token-based TF 余弦相似度做本地检索（不依赖 embedding API，离线可用）
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ALL_KNOWLEDGE, type KnowledgeEntry } from './knowledge';

export interface RunbookDoc {
  id: string;
  title: string;
  filename: string;
  content: string;
  tokens: string[];
  addedAt: number;
  /** 内置知识（id 以 builtin- 开头），可被用户删除、可通过恢复接口补齐 */
  builtin?: boolean;
}

export interface RetrievalResult {
  doc: RunbookDoc;
  score: number;
  excerpt: string;
}

// 测试可用 NEBULA_RUNBOOK_DIR 覆盖到临时目录，避免污染用户真实知识库。
// 惰性求值：测试可在模块加载后设置 env（常量会在首次 import 时固化路径）
function ragDir(): string {
  return process.env.NEBULA_RUNBOOK_DIR || path.join(os.homedir(), '.nebula-ssh', 'runbooks');
}
function indexFile(): string {
  return path.join(ragDir(), 'index.json');
}
const BUILTIN_PREFIX = 'builtin-';

// 分词：支持中文（按字符 bigram）+ 英文
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // 英文/数字单词
  const words = lower.match(/[a-z_][a-z0-9_-]+/g) || [];
  tokens.push(...words);
  // 中文按 2-gram
  const chinese = lower.match(/[一-龥]+/g) || [];
  for (const seg of chinese) {
    for (let i = 0; i < seg.length - 1; i++) {
      tokens.push(seg.slice(i, i + 2));
    }
    if (seg.length > 0) tokens.push(seg);
  }
  return tokens;
}

export function loadRunbooks(): RunbookDoc[] {
  try {
    const file = indexFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {}
  return [];
}

export function saveRunbooks(docs: RunbookDoc[]): void {
  fs.mkdirSync(ragDir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(docs, null, 2), 'utf8');
}

const MAX_DOCS = 500;

export function addRunbook(title: string, filename: string, content: string): RunbookDoc {
  const doc: RunbookDoc = {
    id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || filename,
    filename,
    content,
    tokens: tokenize(content),
    addedAt: Date.now()
  };
  let docs = loadRunbooks();
  docs.push(doc);
  // 超过上限时移除最旧的文档，防止 index.json 无限膨胀
  if (docs.length > MAX_DOCS) {
    docs = docs.slice(docs.length - MAX_DOCS);
  }
  saveRunbooks(docs);
  return doc;
}

export function removeRunbook(id: string): void {
  const docs = loadRunbooks().filter((d) => d.id !== id);
  saveRunbooks(docs);
}

function entryToDoc(k: KnowledgeEntry): RunbookDoc {
  return {
    id: k.id,
    title: k.title,
    filename: `内置/${k.category}.md`,
    content: k.content,
    tokens: tokenize(k.content + ' ' + k.title + ' ' + k.category),
    addedAt: Date.now(),
    builtin: true
  };
}

/**
 * 首次启动 seed：知识库不存在或为空时写入全部内置知识。
 * 已有内容（含用户删过默认知识后留下的自定义文档）时不动，尊重用户选择。
 */
export function ensureDefaultRunbooks(): { seeded: number } {
  try {
    const existing = loadRunbooks();
    if (existing.length > 0) return { seeded: 0 };
    const docs = ALL_KNOWLEDGE.map(entryToDoc);
    saveRunbooks(docs);
    return { seeded: docs.length };
  } catch {
    return { seeded: 0 };
  }
}

/**
 * 恢复内置知识：按 id 幂等补齐缺失的内置文档（用户删除的可加回，已存在的不重复）。
 * 也用于版本升级后新增的内置知识。
 */
export function restoreBuiltinRunbooks(): { added: number; total: number } {
  const docs = loadRunbooks();
  const ids = new Set(docs.map((d) => d.id));
  let added = 0;
  for (const k of ALL_KNOWLEDGE) {
    if (ids.has(k.id)) continue;
    docs.push(entryToDoc(k));
    ids.add(k.id);
    added++;
  }
  if (added > 0) saveRunbooks(docs);
  return { added, total: docs.length };
}

/** 内置知识统计（前端展示"内置 N 篇"） */
export function builtinStats(): { total: number; present: number } {
  const ids = new Set(loadRunbooks().map((d) => d.id).filter((id) => id.startsWith(BUILTIN_PREFIX)));
  return { total: ALL_KNOWLEDGE.length, present: ids.size };
}

// 余弦相似度
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const [, v] of a) magA += v * v;
  for (const [, v] of b) magB += v * v;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w) dot += v * w;
  }
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

function tf(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

export function retrieve(query: string, topK = 3): RetrievalResult[] {
  const docs = loadRunbooks();
  const queryTokens = tf(tokenize(query));
  const scored = docs.map((doc) => {
    const docTokens = tf(doc.tokens);
    const score = cosine(queryTokens, docTokens);
    // 找相关片段（取含最多 query token 的 200 字窗口）
    const queryWords = new Set(Array.from(queryTokens.keys()));
    let bestIdx = 0;
    let bestHit = -1;
    for (let i = 0; i < doc.content.length - 200; i += 100) {
      const win = doc.content.slice(i, i + 200).toLowerCase();
      let hit = 0;
      for (const w of queryWords) {
        if (win.includes(w)) hit++;
      }
      if (hit > bestHit) {
        bestHit = hit;
        bestIdx = i;
      }
    }
    const excerpt = doc.content.slice(bestIdx, bestIdx + 300);
    return { doc, score, excerpt };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function buildRagContext(query: string): string {
  const results = retrieve(query, 3).filter((r) => r.score > 0.02);
  if (results.length === 0) return '';
  return (
    `【检索到的公司 SOP / runbook 知识库】\n` +
    results
      .map(
        (r, i) =>
          `--- 文档 ${i + 1}：${r.doc.title}（相似度 ${r.score.toFixed(2)}）---\n${r.excerpt}`
      )
      .join('\n\n')
  );
}
