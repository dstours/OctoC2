import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // OctoC2 brand palette
        'octo-blue':    '#00f0ff',
        'octo-red':     '#ff0033',
        'octo-black':   '#05050f',
        'octo-surface': '#0d0d1a',
        'octo-card':    '#12121f',
        'octo-border':  '#1e1e3a',

        // shadcn semantic tokens — wired to octo palette
        background:  'hsl(var(--background))',
        foreground:  'hsl(var(--foreground))',
        primary: {
          DEFAULT:    'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT:    'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT:    'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT:    'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT:    'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT:    'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        border: 'hsl(var(--border))',
        input:  'hsl(var(--input))',
        ring:   'hsl(var(--ring))',
        popover: {
          DEFAULT:    'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        'neon-blue':       '0 0 8px rgba(0,240,255,0.45),  0 0 20px rgba(0,240,255,0.2)',
        'neon-blue-faint': '0 0 6px rgba(0,240,255,0.08)',
        'neon-red':        '0 0 8px rgba(255,0,51,0.45),    0 0 20px rgba(255,0,51,0.2)',
        'neon-green':      '0 0 10px rgba(34,197,94,0.55),  0 0 24px rgba(34,197,94,0.25)',
        'neon-amber':      '0 0 8px rgba(245,158,11,0.4),   0 0 20px rgba(245,158,11,0.15)',
        'glow-blue':       '0 0 15px #00f0ffaa',
        'glow-red':        '0 0 15px #ff0033aa',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'flicker':    'flicker 4s linear infinite',
        'scan':       'scan 8s linear infinite',
      },
      keyframes: {
        flicker: {
          '0%, 95%, 100%': { opacity: '1' },
          '96%':           { opacity: '0.8' },
          '97%':           { opacity: '1' },
          '98%':           { opacity: '0.7' },
        },
        scan: {
          '0%':   { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
