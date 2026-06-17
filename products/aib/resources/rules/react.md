---
description: "Project-specific instructions: React 19.2 + TypeScript frontend for Memex (local-first desktop app)"
trigger: glob
globs: **/*.tsx,**/*.ts,**/*.jsx,**/*.js
---
# React 19.2 + TypeScript LLM Coding Instructions

Target: **local-first desktop app frontend** (UI) that feels native, performant, and reliable. No web app compromises.

## 1) Prime directive
- **Correctness + reactivity first**, then performance.
- **Prefer functional components** with hooks over class components.
- **No unnecessary ceremony** (no over-abstracting, keep components lean).
- If you introduce a pattern, say what it replaces and why it's worth it.

## 2) Default repo shape (simple, scalable)
Use **modular structure** for maintainability:
- apps/memex-ui/src/components/: reusable UI components.
- apps/memex-ui/src/pages/: route-level components.
- apps/memex-ui/src/hooks/: custom hooks for logic reuse.
- apps/memex-ui/src/lib/: utilities, types, constants.

Rules:
- Keep components small and focused; use composition over inheritance.
- Prefer server state with TanStack Query; UI state with Zustand.
- Virtualization with react-virtual for large lists/grids.

## 3) Safety defaults
- **TypeScript strict mode** enabled; no `any` unless absolutely necessary.
- **Immutable updates** for state; use `immer` if needed for deep updates.
- Always handle loading/error states in queries and mutations.
- Use ESLint/Prettier for consistent code.

## 4) Performance rules (non-negotiable)
Frontend handles large media libraries; 60fps scrolling essential.
- **Virtualization first**: Use react-virtual for grids/lists to handle 10k+ items at 60fps.
- **Lazy loading**: Code-split routes with TanStack Router; lazy load heavy components.
- **Optimize re-renders**: Memoize expensive computations; use `React.memo` sparingly.
- **Debounce/throttle** search and filter inputs (e.g., 300ms debounce).
- Use `useMemo`/`useCallback` for stable references in dependency arrays.
- Avoid unnecessary effects; prefer derived state.

## 5) Data fetching and state management
- TanStack Query for server state (media queries, mutations); optimistic updates.
- Zustand for local UI state (filters, selections, modals).
- Avoid prop drilling; use context sparingly for shared state.
- Stream events from backend via Electron for real-time updates.

## 6) Testing principles (high value)
- Unit tests: Jest + React Testing Library for components/hooks.
- E2E: Playwright for full flows (import wizard, library search, task monitoring).
- Mock TanStack Query; test loading/error states, user interactions.
- Golden fixtures for UI snapshots.

## 7) Anti-patterns (avoid)
- Large monolithic components (>200 lines).
- Manual DOM manipulation.
- Over-reliance on global state; prefer local state.
- Ignoring accessibility (ARIA, keyboard nav).

## 8) Output expectations when generating code
When implementing UI:
- Deliver a minimal working slice end-to-end (component → hook → test).
- Keep diffs small; focus on user value.
- If adding a library, justify: why it exists, what it replaces, how to remove.</content>
<parameter name="filePath">/Users/tjalve/Github/memex/.windsurf/rules/react.md