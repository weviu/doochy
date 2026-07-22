import type { Config } from "tailwindcss";

// Dark Notion design system (see UI/prompt). Semantic tokens backed by CSS
// variables in index.css so a light theme is a drop-in later.
const config: Config = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          hover: "rgb(var(--surface-hover) / <alpha-value>)",
          active: "rgb(var(--surface-active) / <alpha-value>)",
        },
        hairline: {
          DEFAULT: "rgb(var(--line) / 0.09)",
          strong: "rgb(var(--line) / 0.14)",
        },
        fg: {
          DEFAULT: "rgb(var(--text) / 0.90)",
          muted: "rgb(var(--text) / 0.56)",
          faint: "rgb(var(--text) / 0.40)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          hover: "rgb(var(--accent-hover) / <alpha-value>)",
          soft: "rgb(var(--accent-deep) / 0.22)",
          fg: "rgb(var(--accent-fg) / <alpha-value>)",
        },
        success: {
          DEFAULT: "rgb(var(--success) / <alpha-value>)",
          soft: "rgb(var(--success) / 0.14)",
        },
        danger: {
          DEFAULT: "rgb(var(--danger) / <alpha-value>)",
          soft: "rgb(var(--danger) / 0.14)",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
      },
      transitionDuration: { DEFAULT: "200ms", "250": "250ms" },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(0.4, 0, 0.2, 1)",
        "out-soft": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      boxShadow: {
        subtle: "0 1px 2px rgba(0, 0, 0, 0.20)",
        card: "0 1px 3px rgba(0, 0, 0, 0.25), 0 1px 2px rgba(0, 0, 0, 0.15)",
        overlay: "0 12px 48px rgba(0, 0, 0, 0.55)",
      },
    },
  },
  plugins: [],
};

export default config;
