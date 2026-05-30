/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Names resolve to the channel-triplet CSS vars in src/index.css via
        // rgb(var(--x) / <alpha-value>) so Tailwind opacity modifiers
        // (bg-primary/10, border-primary/5, …) work. Light reproduces
        // production exactly (text neutrals corrected to brand 2026-05-29);
        // dark comes from [data-theme="dark"].
        "background": "rgb(var(--surface) / <alpha-value>)",
        "surface": "rgb(var(--surface) / <alpha-value>)",
        "surface-dim": "rgb(var(--surface-dim) / <alpha-value>)",
        "surface-container-lowest": "rgb(var(--surface-elevated) / <alpha-value>)",
        "surface-container-low": "rgb(var(--surface-container-low) / <alpha-value>)",
        "surface-container": "rgb(var(--surface-container) / <alpha-value>)",
        "surface-container-high": "rgb(var(--surface-container-high) / <alpha-value>)",
        "surface-container-highest": "rgb(var(--surface-container-highest) / <alpha-value>)",
        "surface-variant": "rgb(var(--surface-variant) / <alpha-value>)",
        "on-background": "rgb(var(--text-primary) / <alpha-value>)",
        "on-surface": "rgb(var(--text-primary) / <alpha-value>)",
        "on-surface-variant": "rgb(var(--text-secondary) / <alpha-value>)",
        "primary": "rgb(var(--accent) / <alpha-value>)",
        "primary-container": "rgb(var(--primary-container) / <alpha-value>)",
        "primary-dim": "rgb(var(--primary-dim) / <alpha-value>)",
        "on-primary": "rgb(var(--accent-contrast) / <alpha-value>)",
        "on-primary-container": "rgb(var(--text-primary) / <alpha-value>)",
        "secondary": "rgb(var(--secondary) / <alpha-value>)",
        "secondary-container": "rgb(var(--secondary-container) / <alpha-value>)",
        "on-secondary": "rgb(var(--accent-contrast) / <alpha-value>)",
        "on-secondary-container": "rgb(var(--on-secondary-container) / <alpha-value>)",
        "tertiary": "rgb(var(--tertiary) / <alpha-value>)",
        "tertiary-container": "rgb(var(--tertiary-container) / <alpha-value>)",
        "on-tertiary": "rgb(var(--accent-contrast) / <alpha-value>)",
        "on-tertiary-container": "rgb(var(--on-tertiary-container) / <alpha-value>)",
        "error": "rgb(var(--error) / <alpha-value>)",
        "error-container": "rgb(var(--error-container) / <alpha-value>)",
        "on-error": "rgb(var(--accent-contrast) / <alpha-value>)",
        "on-error-container": "rgb(var(--on-error-container) / <alpha-value>)",
        "outline": "rgb(var(--outline) / <alpha-value>)",
        "outline-variant": "rgb(var(--outline-variant) / <alpha-value>)",
        "inverse-primary": "rgb(var(--inverse-primary) / <alpha-value>)",
        "surface-tint": "rgb(var(--accent) / <alpha-value>)",
        // semantic helpers for direct class usage (text-success, bg-danger…)
        "accent": "rgb(var(--accent) / <alpha-value>)",
        "accent-deep": "rgb(var(--accent-deep) / <alpha-value>)",
        "accent-contrast": "rgb(var(--accent-contrast) / <alpha-value>)",
        "text-primary": "rgb(var(--text-primary) / <alpha-value>)",
        "text-secondary": "rgb(var(--text-secondary) / <alpha-value>)",
        "text-faint": "rgb(var(--text-faint) / <alpha-value>)",
        "success": "rgb(var(--success) / <alpha-value>)",
        "danger": "rgb(var(--danger) / <alpha-value>)",
        "warning": "rgb(var(--warning) / <alpha-value>)",
        // pale status surfaces (callout backgrounds)
        "danger-surface": "rgb(var(--danger-surface) / <alpha-value>)",
        "success-surface": "rgb(var(--success-surface) / <alpha-value>)",
        "warning-surface": "rgb(var(--warning-surface) / <alpha-value>)",
        "accent-surface": "rgb(var(--accent-surface) / <alpha-value>)",
      },
      fontFamily: {
        "headline": ["Plus Jakarta Sans", "sans-serif"],
        "body": ["Manrope", "sans-serif"],
      },
      borderRadius: {
        "xl": "1.25rem",
      },
    },
  },
  plugins: [],
};
