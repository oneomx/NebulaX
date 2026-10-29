import type { ITheme } from 'xterm'
import type { ThemeId } from '../store/theme'

/**
 * 4 套主题对应的 xterm 终端配色
 * 低饱和、与整体高端视觉一致
 */
export const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
  // 曜石黑：深灰黑 + 香槟金光标
  nebula: {
    background: '#101116',
    foreground: '#d6d4cf',
    cursor: '#c9a96e',
    cursorAccent: '#101116',
    selectionBackground: 'rgba(201, 169, 110, 0.22)',
    selectionForeground: '#ffffff',
    black: '#101116',
    red: '#c97f6e',
    green: '#7fa88a',
    yellow: '#c9a35f',
    blue: '#7d94ab',
    magenta: '#a88a9e',
    cyan: '#7d9eab',
    white: '#d6d4cf',
    brightBlack: '#5c5a56',
    brightRed: '#d99a8a',
    brightGreen: '#95bb9f',
    brightYellow: '#d9b87a',
    brightBlue: '#95a8bb',
    brightMagenta: '#bb9fb0',
    brightCyan: '#95b1bb',
    brightWhite: '#efece7',
  },

  // 黑客：纯黑 + 终端绿
  hacker: {
    background: '#030604',
    foreground: '#a7f3d0',
    cursor: '#34d399',
    cursorAccent: '#030604',
    selectionBackground: 'rgba(52, 211, 153, 0.25)',
    selectionForeground: '#d1fae5',
    black: '#030604',
    red: '#e07a5f',
    green: '#34d399',
    yellow: '#a3b18a',
    blue: '#2dd4bf',
    magenta: '#6ee7b7',
    cyan: '#2dd4bf',
    white: '#a7f3d0',
    brightBlack: '#065f46',
    brightRed: '#e99680',
    brightGreen: '#6ee7b7',
    brightYellow: '#c5d6a8',
    brightBlue: '#5eead4',
    brightMagenta: '#a7f3d0',
    brightCyan: '#5eead4',
    brightWhite: '#ecfdf5',
  },

  // 极简白：纸白 + 深蓝
  minimal: {
    background: '#ffffff',
    foreground: '#1a1a18',
    cursor: '#2c4a7c',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(44, 74, 124, 0.16)',
    selectionForeground: '#1a1a18',
    black: '#1a1a18',
    red: '#b0564a',
    green: '#5a7d65',
    yellow: '#b08a4a',
    blue: '#2c4a7c',
    magenta: '#7a5a7d',
    cyan: '#4a7c8a',
    white: '#e8e7e3',
    brightBlack: '#a3a29e',
    brightRed: '#c9736a',
    brightGreen: '#73947d',
    brightYellow: '#c9a566',
    brightBlue: '#4a6a9c',
    brightMagenta: '#957399',
    brightCyan: '#6394a3',
    brightWhite: '#f7f7f5',
  },

  // 藏蓝行政：靛蓝墨 + 铂金
  cyberpunk: {
    background: '#121a26',
    foreground: '#dde3ec',
    cursor: '#8fa3bf',
    cursorAccent: '#121a26',
    selectionBackground: 'rgba(143, 163, 191, 0.2)',
    selectionForeground: '#ffffff',
    black: '#121a26',
    red: '#c97f6e',
    green: '#7fa88a',
    yellow: '#c9a35f',
    blue: '#8fa3bf',
    magenta: '#a893b8',
    cyan: '#7d9eab',
    white: '#dde3ec',
    brightBlack: '#5c6b7f',
    brightRed: '#d99a8a',
    brightGreen: '#95bb9f',
    brightYellow: '#d9b87a',
    brightBlue: '#a8b8cf',
    brightMagenta: '#bda8cb',
    brightCyan: '#95b1bb',
    brightWhite: '#f0f3f8',
  },
}

export function getTerminalTheme(id: ThemeId): ITheme {
  return TERMINAL_THEMES[id] ?? TERMINAL_THEMES.nebula
}
