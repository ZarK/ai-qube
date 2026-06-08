---
description: "Modern .NET 10 + C# 14 LLM coding instructions (batch/CLI, simple, performance-first)"
trigger: glob
globs: **/*.cs,**/*.csproj,**/Program.cs,**/*.json,**/*.md
---

# Modern .NET 10 + C# 14 LLM Coding Instructions (Batch/CLI)

Target: **local + offline batch processing** tools (CLI) that can chew through **multi-TB media libraries** safely and fast.
No enterprise architecture cosplay.

## 1) Prime directive
- **Correctness + reproducibility first**, then performance.
- **Prefer boring & readable** over clever, *except* in proven hotspots.
- **No layered ceremony** (no “Manager/Factory/Builder” pyramids, no inheritance trees).
- If you introduce a pattern, say what it replaces and why it’s worth it.

## 2) Default repo shape (simple, scalable)
Use **modular projects** for separation of concerns:
- `src/Memex.Core/` — pure domain library: parsing, merge logic, scoring, query model (no I/O).
- `src/Memex.Backend/` — .NET worker service: jobs, SQLite, CLI runners, query endpoints.
- `src/Memex.Contracts/` — shared DTOs and JSON-RPC contracts (versioned).
- `tests/Memex.Tests/` — unit tests + golden fixtures.

Rules:
- `Core` must be **pure** (no filesystem, no processes). Inject dependencies via interfaces.
- `Backend` orchestrates I/O, pipelines, and external tools.
- Contracts ensure stable IPC; version for breaking changes.

## 3) Safety defaults
- **Never mutate originals in-place** by default.
  - Always write to an **output** (staging) folder first.
  - Provide a `--in-place` flag later only with scary confirmation and dry-run support.
- Always support:
  - `--dry-run`
  - `--resume` (checkpoint file)
  - `--max-parallelism N` (bounded)

## 4) Performance rules (non-negotiable)
This project is I/O-heavy. Assume millions of files.

### 4.1 Don’t spawn a process per file
- Avoid `exiftool file1; exiftool file2; ...`.
- Prefer:
  - **one long-lived exiftool process** (`-stay_open True`) with request/response framing, **or**
  - batched invocation (`exiftool -json file1 file2 ...`) with chunking.

### 4.2 Don’t read full files unless needed
- Metadata extraction should read **headers only** whenever possible.
- If you need image dimensions/codec info:
  - Use lightweight header parsing where possible.
  - Avoid decoding bitmaps in managed memory.

### 4.3 Bounded concurrency, not “Parallel.ForEach everywhere”
- Use `Channel<T>` or a simple bounded worker pool.
- Concurrency defaults should be conservative (NAS disks thrash).
- Prefer **streaming pipelines** over huge in-memory lists.

### 4.4 Reduce allocations in hot paths
- Use `ReadOnlySpan<char>` / `Span<char>` for parsing.
- Avoid `Regex` in inner loops if you can:
  - Precompile and reuse patterns; prefer deterministic parsers for known timestamp shapes.
- Use `ArrayPool<T>` for large temporary buffers if needed.

### 4.5 Logging must be cheap
- Use structured logging, but avoid string interpolation unless the log level is enabled.
- Separate:
  - *progress* (periodic counters)
  - *events* (warnings about conflicts)
  - *audit* (what was kept/deleted/rewritten)

## 5) CLI principles
- Commands should be composable and script-friendly.
- Output:
  - Default to **NDJSON** or **CSV** for machine consumption.
  - Use pretty console only behind `--human` if desired.
- Every command must support:
  - `--input`
  - `--output` (when producing files)
  - `--config` (json/yaml)
  - `--log` path

## 6) Testing principles (high value)
- Unit tests for:
  - datetime parsing from path/name
  - metadata merge selection (field-by-field)
  - spam filtering rules
  - scoring logic (best content picker)
- Golden fixtures:
  - keep small representative sample files (or metadata json extracts) in `tests/Fixtures/`
  - avoid gigantic binaries in git; generate synthetic trees for path/name testing.

## 7) Anti-patterns (avoid)
- “Clean Architecture” folder labyrinths.
- Repositories/UnitOfWork (no DB here unless proven needed).
- Interfaces everywhere “for testability”.
- Loading the entire file list / czkawka output into RAM when streaming works.

## 8) Output expectations when generating code
When implementing something:
- Deliver a minimal working slice end-to-end (CLI command → core logic → tests).
- Keep diffs small.
- If you add a dependency, state:
  - why it exists
  - what it replaces
  - how to remove it
