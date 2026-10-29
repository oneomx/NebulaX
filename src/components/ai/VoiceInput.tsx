import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Loader2, Volume2 } from 'lucide-react';

interface Props {
  onResult: (text: string) => void;
  className?: string;
}

/**
 * 语音输入组件
 * 使用浏览器 Web Speech API（Chromium/Safari 支持）
 * 在 Electron 中也可用（基于 Chromium）
 */
export default function VoiceInput({ onResult, className }: Props) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const [interim, setInterim] = useState('');
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'zh-CN';

    rec.onresult = (event: any) => {
      let final = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) {
          final += r[0].transcript;
        } else {
          interim += r[0].transcript;
        }
      }
      if (interim) setInterim(interim);
      if (final) {
        onResult(final);
        setInterim('');
      }
    };

    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);

    recognitionRef.current = rec;
    return () => {
      try {
        rec.stop();
      } catch {}
    };
  }, [onResult]);

  const toggle = () => {
    if (!recognitionRef.current) return;
    if (listening) {
      recognitionRef.current.stop();
      setListening(false);
    } else {
      try {
        recognitionRef.current.start();
        setListening(true);
      } catch {}
    }
  };

  if (!supported) {
    return (
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] bg-[var(--bg-elevated)] ${className || ''}`}
        title="当前浏览器不支持语音输入（推荐 Chrome/Edge）"
      >
        <MicOff size={14} />
      </div>
    );
  }

  return (
    <div className={`relative ${className || ''}`}>
      <button
        onClick={toggle}
        title={listening ? '停止语音输入' : '语音输入（中文）'}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition ${
          listening
            ? 'bg-[var(--error)]/20 text-[var(--error)] border border-[var(--error)]/40 animate-pulse-soft'
            : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
        }`}
      >
        {listening ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
      </button>
      {interim && (
        <div className="absolute bottom-full right-0 mb-1 px-2 py-1 rounded bg-black/80 text-[10px] text-[var(--text-secondary)] whitespace-nowrap max-w-[200px] truncate">
          {interim}
        </div>
      )}
    </div>
  );
}
