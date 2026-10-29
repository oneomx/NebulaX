/**
 * 终端分屏 Pane 树操作工具（纯函数，方便测试与撤销）。
 */
import type { PaneNode } from '../types';

let counter = 0;
function newId(): string {
  return `pane_${Date.now()}_${(counter++).toString(36)}`;
}

export function createLeaf(tabId: string): PaneNode {
  return { type: 'leaf', id: newId(), tabId };
}

/**
 * 在指定 leaf 处水平/垂直分裂；原 leaf 变成 split，左/上保留原 leaf，右/下新建 leaf。
 * newLeafId 由调用方生成并作为新叶的唯一 id（会话映射键），保证树内 id 与
 * spawnPaneSession/closePaneSession 使用的键一致；tabId 同值。
 */
export function splitPane(root: PaneNode, targetPaneId: string, dir: 'row' | 'col', newLeafId: string): PaneNode {
  return mapPane(root, (node) => {
    if (node.type === 'leaf' && node.id === targetPaneId) {
      const newLeaf: PaneNode = { type: 'leaf', id: newLeafId, tabId: newLeafId };
      return {
        type: 'split',
        id: newId(),
        dir,
        ratio: 0.5,
        children: [node, newLeaf]
      };
    }
    return node;
  });
}

/** 关闭指定 leaf：父 split 被兄弟节点替换；若只剩一个叶子则返回单叶子 */
export function closePane(root: PaneNode, targetPaneId: string): PaneNode | null {
  if (root.type === 'leaf') {
    return root.id === targetPaneId ? null : root;
  }
  const left = closePane(root.children[0], targetPaneId);
  const right = closePane(root.children[1], targetPaneId);
  if (left && right) return { ...root, children: [left, right] };
  return left || right;
}

/** 设置 split 的 ratio（0.15 ~ 0.85） */
export function setRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  return mapPane(root, (node) => {
    if (node.type === 'split' && node.id === splitId) {
      return { ...node, ratio: Math.max(0.15, Math.min(0.85, ratio)) };
    }
    return node;
  });
}

export function findPane(root: PaneNode, paneId: string): PaneNode | null {
  if (root.id === paneId) return root;
  if (root.type === 'split') {
    return findPane(root.children[0], paneId) || findPane(root.children[1], paneId);
  }
  return null;
}

/** 收集所有 leaf id */
export function collectLeaves(root: PaneNode): string[] {
  if (root.type === 'leaf') return [root.id];
  return [...collectLeaves(root.children[0]), ...collectLeaves(root.children[1])];
}

function mapPane(node: PaneNode, fn: (n: PaneNode) => PaneNode): PaneNode {
  const mapped = fn(node);
  if (mapped.type === 'split') {
    return {
      ...mapped,
      children: [mapPane(mapped.children[0], fn), mapPane(mapped.children[1], fn)]
    };
  }
  return mapped;
}
