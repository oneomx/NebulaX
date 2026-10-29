import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Trash2, X } from 'lucide-react';
import { getAPI } from '../lib/api';

/**
 * 串口实时绘图（对标 Serial Plotter / Arduino 串口绘图器）：
 * 订阅会话数据流，按行解析数字序列（逗号/空格/制表符分隔），
 * 每个通道一条曲线，Canvas 实时滚动绘制，Y 轴自动缩放。
 * 适用：单片机/PLC/传感器通过串口周期性输出 `temp,humidity,current` 这类数据行。
 */
const MAX_POINTS = 600; // 每通道保留点数
const MAX_CHANNELS = 8;
// 通道配色（深浅主题均可读）
const PALETTE = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8', '#fff176', '#4dd0e1', '#f06292'];

interface Channel {
  data: number[];
  color: string;
}

export default function SerialPlotter({ sid, onClose }: { sid: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const channelsRef = useRef<Map<number, Channel>>(new Map());
  const lineBufRef = useRef('');
  const pausedRef = useRef(false);
  const rafRef = useRef(0);
  const [paused, setPaused] = useState(false);
  const [channelCount, setChannelCount] = useState(0);
  const [latest, setLatest] = useState<number[]>([]);

  // 订阅数据流并解析（解析与绘制解耦：解析写入通道缓冲，rAF 循环绘制）
  useEffect(() => {
    const off = getAPI().onSshData((id, data) => {
      if (id !== sid || pausedRef.current) return;
      lineBufRef.current += data;
      // 按行切分；末尾不完整行留在缓冲
      let nl: number;
      while ((nl = lineBufRef.current.indexOf('\n')) >= 0) {
        const line = lineBufRef.current.slice(0, nl).replace(/\r/g, '').trim();
        lineBufRef.current = lineBufRef.current.slice(nl + 1);
        if (!line) continue;
        const nums = line.match(/-?\d+(\.\d+)?/g);
        if (!nums) continue; // 非数据行（如日志文本）跳过
        const values = nums.map(Number).slice(0, MAX_CHANNELS);
        const chans = channelsRef.current;
        for (let i = 0; i < values.length; i++) {
          let ch = chans.get(i);
          if (!ch) {
            ch = { data: [], color: PALETTE[i % PALETTE.length] };
            chans.set(i, ch);
          }
          ch.data.push(values[i]);
          if (ch.data.length > MAX_POINTS) ch.data.shift();
        }
      }
      // 缓冲防异常设备无换行撑爆内存
      if (lineBufRef.current.length > 8192) lineBufRef.current = lineBufRef.current.slice(-1024);
    });
    return () => off();
  }, [sid]);

  // 绘制循环
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const styles = getComputedStyle(canvas);
      const bg = styles.getPropertyValue('--terminal-bg').trim() || '#0d1117';
      const grid = 'rgba(148,163,184,0.12)';
      const axisText = styles.getPropertyValue('--text-muted').trim() || '#64748b';

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const chans = channelsRef.current;
      const active = [...chans.values()].filter((c) => c.data.length > 1);
      // 图例/状态同步到 React（节流：仅数量或末值变化明显时更新由 rAF 直接驱动，这里简单每帧 setState 前比较）
      const counts = chans.size;
      if (counts !== channelCount) setChannelCount(counts);
      const lv = [...chans.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c.data[c.data.length - 1] ?? 0);
      setLatest((prev) => (prev.length !== lv.length || lv.some((v, i) => v !== prev[i]) ? lv : prev));

      const padL = 48;
      const padR = 12;
      const padT = 10;
      const padB = 20;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;
      if (plotW <= 0 || plotH <= 0) return;

      // Y 轴范围（全部通道统一缩放）
      let min = Infinity;
      let max = -Infinity;
      for (const c of active) {
        for (const v of c.data) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (!isFinite(min) || !isFinite(max)) {
        ctx.fillStyle = axisText;
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('等待数据行（每行 N 个数字，逗号/空格分隔）', w / 2, h / 2);
        return;
      }
      if (min === max) {
        min -= 1;
        max += 1;
      } else {
        const margin = (max - min) * 0.08;
        min -= margin;
        max += margin;
      }

      // 网格 + Y 刻度（5 格）
      ctx.strokeStyle = grid;
      ctx.fillStyle = axisText;
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padT + (plotH * i) / 4;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        const val = max - ((max - min) * i) / 4;
        ctx.fillText(Math.abs(val) >= 1000 ? val.toFixed(0) : val.toFixed(2), padL - 4, y + 3);
      }

      // 曲线（所有通道共用 X 窗口：最近 MAX_POINTS 点）
      const xOf = (i: number, n: number) => padL + (plotW * i) / Math.max(n - 1, MAX_POINTS - 1);
      const yOf = (v: number) => padT + plotH * (1 - (v - min) / (max - min));
      for (const c of active) {
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let i = 0; i < c.data.length; i++) {
          const x = xOf(i, c.data.length);
          const y = yOf(c.data[i]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
  };

  const clearAll = () => {
    channelsRef.current.clear();
    lineBufRef.current = '';
    setLatest([]);
  };

  return (
    <div className="absolute right-3 bottom-3 z-40 w-[560px] glass shadow-panel rounded-xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-subtle)]">
        <span className="text-[12px] font-medium theme-text-primary">串口绘图 · {channelCount} 通道</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={togglePause}
            title={paused ? '继续' : '暂停'}
            className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
          <button
            onClick={clearAll}
            title="清空数据"
            className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--warning)] hover:bg-[var(--bg-elevated)]"
          >
            <Trash2 size={13} />
          </button>
          <button onClick={onClose} className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--error)]">
            <X size={13} />
          </button>
        </div>
      </div>
      {/* 通道图例 */}
      {channelCount > 0 && (
        <div className="flex items-center gap-3 px-3 py-1 border-b border-[var(--border-subtle)]">
          {latest.map((v, i) => (
            <span key={i} className="flex items-center gap-1 text-[10px] tnum" style={{ color: PALETTE[i % PALETTE.length] }}>
              <span className="w-2.5 h-[2px] rounded" style={{ background: PALETTE[i % PALETTE.length] }} />
              ch{i + 1}
              <span className="theme-text-secondary">{Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)}</span>
            </span>
          ))}
        </div>
      )}
      <canvas ref={canvasRef} className="w-[560px] h-[240px] block" />
    </div>
  );
}
