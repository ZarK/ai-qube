# Testing

## Verification paths

- `pnpm run test` — the complete required suite (builds dependencies and the package first, then runs every `*.test.cjs` under `test/`). This is the gate CI and pre-merge verification run.
- `pnpm run test:fast` — the routine edit-loop path. It builds the package and runs every suite except the subprocess-heavy integration files listed in `SLOW_INTEGRATION_TESTS` (`test/run-node-tests.mjs`). Use it while iterating; always finish with the full `pnpm run test` before shipping.
- `node --test test/<file>.test.cjs` — a single suite against the existing `dist/` build (rebuild first when source changed).

## Runtime expectations

Measured after build (the timings exclude one-time `build:deps`/`build`), Node 24:

| Machine | Path | Tests | Wall time |
|---|---|---|---|
| Linux CI runner (`ubuntu-latest`, the shared reference) | full suite | 785 | **≈ 16 seconds** (runner-reported `duration_ms 16434`) |
| Windows 11, 32 hardware threads, NVMe | full suite | 785 | ≈ 4.6 minutes |
| Windows 11, 32 hardware threads, NVMe | `--fast` | 335 | ≈ 21 seconds |

The Linux and Windows gap is process-spawn cost: the suite intentionally exercises real git and real CLI subprocesses, and Windows pays an order of magnitude more per spawn. Use `test:fast` for the Windows edit loop and the full suite as the gate.

Before the fixture and concurrency work the suite summed to ≈ 17.5 minutes serially on the Windows machine, the former single `pr.test.cjs` alone took 5–8 minutes, and full runs frequently exceeded a 10-minute window. The dominant costs were per-test git repository creation (7 subprocess spawns per repository), full node boots for each spawned CLI invocation, and single-file serialization.

## How the suite stays fast

- **Template-cloned git repositories** (`test/support/git_fixture.cjs`): one pristine repository is built per shape (`bare`, `configured`, `committed`) and every `makeGitRepo()` call clones it with a filesystem copy instead of spawning git. `test/git_fixture.test.cjs` proves clones are independent of the template and each other.
- **Split PR gate suites**: the PR gate tests live in `pr_gate_a/b/c.test.cjs` and `pr_meta.test.cjs`, sharing `test/support/pr_gate_fixture.cjs`, so the runner parallelizes them across processes. Wall-clock-sensitive timing assertions run in a dedicated serial suite.
- **Shared compile cache** (`test/support/compile_cache.cjs`): spawned CLI integration tests inherit one persistent `NODE_COMPILE_CACHE`, so repeated `bin/run` boots skip recompiling the dist bundle.
- **Bounded concurrency** (`test/run-node-tests.mjs`): file-level concurrency is capped because worker count multiplied by in-file test concurrency can oversubscribe subprocess spawning until in-test git calls exceed their own timeouts and fail spuriously.

## Rules when adding tests

- Create test repositories through `cloneGitRepo()` (or a file-local `makeGitRepo()` wrapper around it) rather than spawning the git ceremony per test.
- Keep tests independent of execution order and of each other's repositories; suites under the split PR gate files run concurrently within each file.
- Add a new suite to `SLOW_INTEGRATION_TESTS` in `test/run-node-tests.mjs` only when it genuinely spawns CLIs or runs many real subprocesses; everything else belongs in the fast path.
- Wall-clock assertions must scale their margins with measured values instead of fixed constants, and belong in a serial suite.
