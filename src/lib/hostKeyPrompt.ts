import type { HostKeyPrompt } from '../types';

/**
 * 主机指纹确认弹窗状态桥（Promise 化）：
 * connect.ts 收到 hostKeyPrompt → promptHostKey() 挂起等待 →
 * App 里的 HostKeyDialog 渲染 → 用户点击 → resolveHostKeyPrompt() 放行。
 */
let resolver: ((accept: boolean) => void) | null = null;
let listener: ((p: HostKeyPrompt | null) => void) | null = null;

let currentPrompt: HostKeyPrompt | null = null;

export function promptHostKey(p: HostKeyPrompt): Promise<boolean> {
  return new Promise((resolve) => {
    resolver = resolve;
    currentPrompt = p;
    listener?.(p);
  });
}

export function resolveHostKeyPrompt(accept: boolean): void {
  const r = resolver;
  resolver = null;
  const p = currentPrompt;
  currentPrompt = null;
  listener?.(null);
  r?.(accept);
}

/** HostKeyDialog 订阅弹窗状态 */
export function onHostKeyPromptChange(cb: (p: HostKeyPrompt | null) => void): () => void {
  listener = cb;
  cb(currentPrompt);
  return () => {
    if (listener === cb) listener = null;
  };
}
