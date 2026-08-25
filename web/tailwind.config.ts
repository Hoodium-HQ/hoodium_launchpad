import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

/**
 * Theme wiring for design-system.md section 2.
 *
 * Every colour resolves through a CSS variable rather than a literal, which is
 * what makes WA-5.4 ("AA contrast in both themes") enforceable in one place
 * instead of audited across hundreds of class names.
 */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1280px' } },
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--foreground))' },
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',

        // Semantic colours, deliberately not the brand accent (design-system section 3).
        up: 'hsl(var(--up))',
        down: 'hsl(var(--down))',
        warning: 'hsl(var(--warning))',
        /* The missing stop between amber and lime — see `--caution` in index.css.
           A scale step, not a status. */
        caution: 'hsl(var(--caution))',
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--foreground))' },
      },
      borderRadius: {
        '2xl': 'var(--radius)',
        xl: 'calc(var(--radius) - 4px)',
        lg: 'calc(var(--radius) - 6px)',
        md: 'calc(var(--radius) - 8px)',
      },
      fontFamily: {
        /* Actually shipped, unlike the two faces this line used to name. See the
           import at the top of index.css. */
        sans: ['"Geist Variable"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // design-system.md section 6.
        'page-title': ['1.875rem', { lineHeight: '2.25rem', fontWeight: '600' }],
        'section-title': ['1.25rem', { lineHeight: '1.75rem', fontWeight: '600' }],
        'card-title': ['0.9375rem', { lineHeight: '1.375rem', fontWeight: '500' }],
        label: ['0.75rem', { lineHeight: '1rem' }],
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        // 200ms feed row entry (design-system.md section 10).
        'fade-in': 'fade-in 200ms ease-out',
        // Slow enough to be a presence, not a motion. Sticker illustrations only.
        float: 'float 6s ease-in-out infinite',
      },
    },
  },
  plugins: [animate],
} satisfies Config
