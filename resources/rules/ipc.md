---
description: "Project-specific instructions: IPC protocol between Electron, React UI, and .NET backend"
trigger: glob
globs: **/src/Memex.Contracts/**/*.cs,**/*.ts
---
# IPC Protocol LLM Coding Instructions

Target: **versioned JSON-RPC** over stdio/pipe for UI-backend communication. Reliable and efficient.

## 1) Prime directive
- **Versioned contracts**: Stable DTOs; backward-compatible changes.
- **Streaming events**: Task progress via event channel.
- **Error handling**: Structured errors with codes and messages.

## 2) Default contract structure (scalable)
Define in **shared contracts** (src/Memex.Contracts):
- Commands: UI → Electron → .NET (e.g., import.start, query.media).
- Events: .NET → Electron → UI (task.progress, index.updated).
- DTOs: Versioned structs with required/optional fields.

Rules:
- Use JSON-RPC 2.0; support batch requests.
- Cancellation via tokens in long-running ops.

## 3) Safety defaults
- Validate payloads with schemas; typed interfaces everywhere.
- Handle errors gracefully; propagate to UI with user-friendly messages.
- Secure: no sensitive data in IPC without encryption.

## 4) Performance rules (non-negotiable)
IPC is critical path; minimize latency.
- Batch requests where possible; stream large responses.
- Efficient serialization (JSON); avoid deep nesting.
- Async handling; non-blocking.

## 5) Implementation principles
- Electron forwards invokes to .NET; emits events back.
- UI subscribes to events on mount.
- Contracts evolve with semver; deprecate old versions.

## 6) Testing principles
- Unit tests for serialization/deserialization.
- Integration tests for full IPC flows.
- Mock responses for error cases.

## 7) Anti-patterns (avoid)
- Breaking changes without versioning.
- Synchronous blocking calls over IPC.
- Unstructured data; always typed.

## 8) Output expectations
When defining IPC:
- Specify contracts first; implement handlers.
- Keep diffs small; test compatibility.
- If changing protocol, document migration path.</content>
<parameter name="filePath">/Users/tjalve/Github/memex/.windsurf/rules/ipc.md