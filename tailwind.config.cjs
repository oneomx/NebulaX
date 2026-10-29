/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#08090c',
          900: '#0b0d12',
          850: '#101319',
          800: '#151a23',
          700: '#1d2430',
          600: '#27303f'
        },
        neon: {
          cyan: '#22d3ee',
          blue: '#3b82f6',
          violet: '#8b5cf6',
          pink: '#ec4899',
          green: '#34d399',
          amber: '#fbbf24',
          red: '#f87171'
        }
      },
      fontFamily: {
        sans: ['Inter', 'PingFang SC', 'Microsoft YaHei', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'Consolas', 'monospace']
      },
      boxShadow: {
        glow: '0 0 24px rgba(34, 211, 238, 0.15)',
        'glow-violet': '0 0 24px rgba(139, 92, 246, 0.18)',
        panel: '0 8px 32px rgba(0, 0, 0, 0.45)'
      },
      backgroundImage: {
        'grid-pattern':
          'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
        'radial-fade': 'radial-gradient(ellipse at top, rgba(34,211,238,0.08), transparent 50%)',
        'gradient-neon': 'linear-gradient(135deg, #22d3ee 0%, #8b5cf6 100%)'
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-in': 'slideIn 0.35s ease-out',
        'pulse-soft': 'pulseSoft 2.5s ease-in-out infinite'
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        slideIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' }
        }
      }
    }
  },
  plugins: []
};
