---
description: "Project-specific instructions: Tailwind CSS 4 styling for Memex UI"
trigger: glob
globs: **/*.css,**/*.tsx,**/*.scss
---
# Tailwind CSS 4 LLM Coding Instructions

Target: **utility-first CSS** for responsive, performant desktop app UI. Dark theme default.

## 1) Prime directive
- **Utility classes first**, custom CSS only for design tokens.
- **Dark theme default**; use CSS variables for tokens.
- **No bloated bundles**; purge unused classes in production.

## 2) Default styling approach (lean, scalable)
- apps/memex-ui/src/styles/: global CSS, Tailwind config.
- Use Tailwind utilities for layout, spacing, colors in components.
- Define design tokens in CSS variables (colors, fonts, spacing) in a central file.

Rules:
- Dark mode via `dark:` prefix; responsive with `sm:`, `md:`, etc.
- Custom components via `@apply` only for reusable patterns (e.g., buttons).

## 3) Safety defaults
- Strict color palette; ensure accessibility (WCAG AA contrast).
- No inline styles; all via classes or CSS variables.
- Consistent typography scale.

## 4) Performance rules (non-negotiable)
UI must be snappy; large galleries require efficient styles.
- Enable JIT mode; purge unused classes aggressively.
- Avoid `@apply` for complex styles; use utilities directly in JSX.
- Minimize custom CSS; prefer Tailwind plugins (e.g., for animations).
- Lazy load styles if needed; no blocking CSS.

## 5) Responsive and layout principles
- Mobile-first: base styles for small screens, `md:` for desktop.
- Flex/grid for media galleries; virtualization-compatible.
- Consistent spacing with Tailwind scale (4px increments).

## 6) Testing and quality
- Visual regression tests with Playwright for key layouts.
- Lint CSS with stylelint; enforce conventions.

## 7) Anti-patterns (avoid)
- Overriding Tailwind with custom CSS (use utilities or extend config).
- Not using design tokens; hardcoded colors/values.
- Heavy CSS bundles; unused styles.

## 8) Output expectations
When styling:
- Use utilities in components; add custom CSS only for tokens.
- Keep styles modular; document custom classes.
- If extending Tailwind, justify additions.</content>
<parameter name="filePath">/Users/tjalve/Github/memex/.windsurf/rules/tailwind.md