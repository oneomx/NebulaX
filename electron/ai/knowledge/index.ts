/**
 * 内置知识库汇总 — 85 篇运维知识（系统排障/SSH/安全/数据库/中间件/性能/Windows/监控应急）
 * 供 rag.ts 首次启动 seed 与「恢复内置知识」使用；id 稳定（builtin- 前缀）以支持幂等补齐
 */
import { SYSTEM_KNOWLEDGE } from './system';
import { SECURITY_KNOWLEDGE } from './security';
import { DATA_KNOWLEDGE } from './data';
import { OPS_KNOWLEDGE } from './ops';

export interface KnowledgeEntry {
  id: string;
  title: string;
  category: string;
  content: string;
}

export const ALL_KNOWLEDGE: KnowledgeEntry[] = [
  ...SYSTEM_KNOWLEDGE,
  ...SECURITY_KNOWLEDGE,
  ...DATA_KNOWLEDGE,
  ...OPS_KNOWLEDGE
];

/** 内置知识分类清单（前端展示/统计用） */
export const KNOWLEDGE_CATEGORIES: string[] = Array.from(new Set(ALL_KNOWLEDGE.map((k) => k.category)));
