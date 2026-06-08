---
description: "Project-specific instructions: Electron app shell for Memex"
trigger: glob
globs: **/*.ts,**/*.js,**/*.json
---
# Electron LLM Coding Instructions

Target: **cross-platform desktop shell** hosting React UI and managing .NET backend. Security and performance paramount.

## 1) Prime directive
- **Security first**: Context isolation; validate all IPC calls.
- **Lean Node.js code**: Use async/await; avoid blocking operations.
- **IPC bridge**: Forward UI calls to .NET; stream events back reliably.

## 2) Default repo shape (simple, secure)
Use **modular Node.js structure**:
- apps/memex-electron/src/main.ts: entry point and main process.
- apps/memex-electron/src/preload.ts: IPC command handlers and context bridge.
- apps/memex-electron/src/sidecar.ts: .NET backend management.

Rules:
- Keep Node.js minimal; delegate complex logic to .NET backend.
- Use Electron's APIs for OS integration (dialogs, filesystem permissions).

## 3) Safety defaults
- Validate all inputs with TypeScript types; use typed structs.
- Handle errors with try/catch; log with console or a logger.
- Enable context isolation and nodeIntegration: false for security.

## 4) Performance rules (non-negotiable)
Shell must not block UI; async everywhere.
- Async for I/O operations; non-blocking process spawns.
- Efficient serialization with JSON; stream large responses.
- Minimal allocations; use streams where possible.

## 5) IPC and communication
- Commands for synchronous UI requests (e.g., file dialogs) via ipcMain.handle.
- Events for asynchronous updates (task progress, backend notifications) via ipcRenderer.on.
- Versioned JSON-RPC over Electron's IPC system.

## 6) Testing principles
- Unit tests for IPC handlers; integration tests for full IPC.
- Mock external dependencies.

## 7) Anti-patterns (avoid)
- Blocking calls in async contexts.
- Insecure IPC (no input validation).
- Complex business logic in Node.js (keep in .NET).

## 8) Output expectations
When implementing Electron code:
- Deliver secure, minimal handlers; test IPC round-trips.
- Keep diffs small; document security assumptions.
- If adding packages, justify: why, what it replaces, removal plan.