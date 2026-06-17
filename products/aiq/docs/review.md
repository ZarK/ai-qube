Yes. The package-level split is already heading in the right direction. The main problem is that **the engine internals are not modular yet**.

Right now the codebase has a good outer shape:

* `config-schema` owns config
* `engine` owns execution
* `reporters` owns output shaping
* `cli`, `hook`, `github-action`, `lsp`, `mcp`, `opencode-plugin` are surface adapters

That part is good.

The big structural smell is `packages/engine/src/runners.ts`. It currently owns:

* stage dispatch
* language/tech detection details
* project resolution
* tool process execution
* output parsing
* metrics caching
* summary note generation
* test orchestration
* Terraform/HCL, JS/TS, Python, .NET, JVM, Go, Rust, Bash, PowerShell logic

That file is effectively the whole engine stuffed into one module.
So the plan should be: **keep the package boundaries, but fully modularize the engine internals.**

---

# 1. The target design

Use **three clear axes** inside the engine:

1. **Stages**
   What a stage means: lint, format, typecheck, unit, coverage, security, etc.

2. **Languages / techs**
   Python, TypeScript, JavaScript, Terraform, HCL, Go, Rust, .NET, Java, Kotlin, Bash, PowerShell.

3. **Toolchains / ecosystems**
   Shared infrastructure for Node, JVM, .NET, Terraform, Python, Rust, Go, Shell.

That gives you this rule:

* **Stage modules own policy**
* **Language modules own support**
* **Tool adapters own concrete commands and parsing**
* **Core engine only orchestrates**

That is the cleanest way to make “add a new language” and “add a new stage” both easy.

---

# 2. What should stay as-is conceptually

These files show the right direction and should remain the pattern:

* `packages/engine/src/request.ts`
* `packages/engine/src/planner.ts`
* `packages/engine/src/run.ts`
* `packages/engine/src/artifacts.ts`

They are relatively focused:

* request normalization
* planning
* run orchestration
* artifact writing

That is good SRP.

Also, the adapters are mostly thin already, which is good:

* `packages/lsp/src/index.ts`
* `packages/mcp/src/index.ts`
* `packages/opencode-plugin/src/index.ts`
* `packages/hook/src/index.ts`
* `packages/github-action/src/index.ts`

Those should stay thin and should not absorb engine logic.

---

# 3. The core refactor: kill the giant runners file

## Replace this:

* `packages/engine/src/runners.ts`

## With this internal layout:

```text
packages/engine/src/
  core/
    engine.ts
    execute.ts
    task-graph.ts
    project-graph.ts
    cache.ts
    tool-runner.ts
    errors.ts
    telemetry.ts

  model/
    stage.ts
    language.ts
    project.ts
    tool.ts
    diagnostic.ts

  registry/
    stages.ts
    languages.ts

  stages/
    lint/
      definition.ts
      aggregate.ts
    format/
      definition.ts
      aggregate.ts
    typecheck/
      definition.ts
      aggregate.ts
    unit/
      definition.ts
      aggregate.ts
    coverage/
      definition.ts
      aggregate.ts
    sloc/
      definition.ts
      aggregate.ts
    complexity/
      definition.ts
      aggregate.ts
    maintainability/
      definition.ts
      aggregate.ts
    security/
      definition.ts
      aggregate.ts
    e2e/
      definition.ts
      aggregate.ts

  ecosystems/
    node/
      project.ts
      tools.ts
    python/
      project.ts
      tools.ts
    jvm/
      project.ts
      gradle.ts
      maven.ts
    dotnet/
      project.ts
      solution.ts
    terraform/
      project.ts
    shell/
      project.ts
    go/
      project.ts
    rust/
      project.ts

  languages/
    typescript/
      index.ts
      detect.ts
      handlers/
        lint.ts
        format.ts
        typecheck.ts
        unit.ts
        coverage.ts
        metrics.ts
    javascript/
      index.ts
      detect.ts
      handlers/
        lint.ts
        format.ts
        unit.ts
        coverage.ts
        metrics.ts
    python/
      index.ts
      detect.ts
      handlers/
        lint.ts
        format.ts
        typecheck.ts
        unit.ts
        coverage.ts
        metrics.ts
    terraform/
      index.ts
      detect.ts
      handlers/
        lint.ts
        format.ts
        typecheck.ts
    hcl/
      index.ts
      detect.ts
      handlers/
        lint.ts
        format.ts
    go/
    rust/
    dotnet/
    java/
    kotlin/
    bash/
    powershell/

  tools/
    biome.ts
    ruff.ts
    mypy.ts
    pytest.ts
    vitest.ts
    jest.ts
    terraform.ts
    shellcheck.ts
    shfmt.ts
    powershell.ts
    dotnet.ts
    gradle.ts
    maven.ts
    go.ts
    cargo.ts

  parsers/
    junit.ts
    cobertura.ts
    lcov.ts
    sarif.ts
    trx.ts
    biome.ts
    ruff.ts
    mypy.ts
    terraform.ts
    shellcheck.ts
    test-json.ts
```

The exact folders can vary, but the separation should look like this.

---

# 4. Make stages first-class modules

Right now stages are mostly string ids plus switch logic. That is too flat.

Each stage should become a real module with a definition like:

```ts
export interface StageDefinition {
  id: StageId;
  description: string;
  scope: "file" | "project" | "workspace";
  defaultProfiles: ProfileId[];
  supports(language: LanguageId): boolean;
  aggregate(results: StageExecutionResult[]): PhaseResult;
}
```

## Stage owns:

* semantic meaning
* scope
* aggregation rules
* pass/fail/not-implemented policy
* default profile inclusion
* stage-specific notes

## Stage does not own:

* how Ruff runs
* how mypy runs
* how Terraform validate runs

That belongs elsewhere.

### Example

`lint` stage knows:

* it can run per project
* it aggregates diagnostics from handlers
* if no handler exists for a selected language, it should fail with an actionable unsupported/setup diagnostic rather than emit release-visible placeholder status

But `lint` does not know Biome or Ruff flags.

---

# 5. Make languages first-class modules

Each language/tech should export a module like:

```ts
export interface LanguageModule {
  id: LanguageId;
  displayName: string;
  matches(file: FileManifestEntry): boolean;
  resolveProjects(input: LanguageProjectInput): Promise<ProjectDescriptor[]>;
  handlers: Partial<Record<StageId, StageHandler>>;
}
```

## Language owns:

* file matching
* project grouping
* supported stages
* stage handler registration

## Language does not own:

* global run orchestration
* artifact writing
* CLI parsing
* GitHub annotation formatting

### Example

Python owns:

* `.py` / `.pyi` matching
* pyproject / requirements / pytest project grouping
* handlers for lint, format, typecheck, unit, coverage, metrics

Terraform owns:

* `.tf` / `.tfvars`
* project root grouping by directory
* handlers for lint, format, typecheck

HCL owns:

* `.hcl`
* generic HCL validation/formatting handlers

---

# 6. Add an ecosystem layer so shared tech is reusable

This is important if you want “language / tech” modularity without duplication.

Examples:

* Java and Kotlin should share a `jvm` ecosystem layer
* JavaScript and TypeScript should share a `node` ecosystem layer
* Terraform and HCL should share a `hashicorp` or `terraform` ecosystem layer
* Bash and PowerShell can share a `script` testing/formatting pattern where useful

## Ecosystem owns:

* project discovery helpers
* toolchain selection
* command-line conventions
* wrapper resolution (`gradlew`, `mvnw`, etc.)
* common parsers or report paths

## Language owns:

* file extensions
* which ecosystem it uses
* which handlers it enables

This avoids copy-paste when you add:

* Scala later on JVM
* JSX/TSX-specific handling on Node
* extra HashiCorp formats later

---

# 7. Use a registry instead of switch statements

Right now `runPlannedTask()` is a giant switch. That will only get worse.

Use registries:

```ts
const stageRegistry: Record<StageId, StageDefinition> = ...
const languageRegistry: Record<LanguageId, LanguageModule> = ...
```

Then:

1. build a project graph once
2. ask each stage which projects/languages it can run on
3. create execution tasks from registered handlers

Pseudo-flow:

```ts
const manifest = normalizeManifest(...)
const projectGraph = buildProjectGraph(manifest, languageRegistry)
const runGraph = planner.createTasks(projectGraph, selectedStages, stageRegistry)

for (const task of runGraph.tasks) {
  const handler = languageRegistry[task.language].handlers[task.stage]
  const result = await handler.execute(task, context)
  ...
}
```

That makes adding a new stage or language a registry addition, not a surgery on one giant file.

---

# 8. Add a real ProjectGraph

A lot of your current logic repeatedly finds:

* nearest config
* nearest package.json
* nearest Cargo.toml
* nearest tsconfig.json
* nearest Terraform project dir
* nearest .csproj / .sln

That should not happen ad hoc inside stage handlers.

Create a `ProjectGraph` once per run.

```ts
export interface ProjectDescriptor {
  id: string;
  language: LanguageId;
  ecosystem: EcosystemId;
  root: string;
  files: string[];
  metadata: unknown;
}
```

Then stage handlers receive a resolved project, not raw files.

This gives you:

* cleaner code
* less repeated IO
* easier caching
* much better performance

---

# 9. Centralize tool execution

Right now tool execution helpers are mixed into `runners.ts`.

Create one `ToolRunner` service.

```ts
export interface ToolRunner {
  run(invocation: ToolInvocation, signal?: AbortSignal): Promise<ToolExecutionResult>;
}
```

## ToolRunner owns:

* spawn/exec
* timeouts
* env merging
* cwd
* stdout/stderr capture
* cancellation
* common error shaping

## Tool adapters own:

* command
* args
* env
* parse stdout/stderr into canonical diagnostics

That way Ruff, Biome, Terraform, cargo, go, dotnet, etc. all use the same execution path.

---

# 10. Centralize caching

Current caches in `runners.ts`:

* python metrics cache
* .NET metrics cache
* JVM metrics cache
* JS metrics cache
* Terraform validation cache
* installed binary cache
* PowerShell module cache

These should move into a dedicated cache layer.

## Good structure

```text
core/cache/
  cache-service.ts
  cache-key.ts
  memory-cache.ts
  file-cache.ts
```

## Cache owns:

* cache keys
* invalidation
* storage
* hit/miss telemetry

## Handlers own:

* what inputs define cache identity

This matters because cache behavior should be visible and predictable, not hidden in language code.

---

# 11. Split tool adapters from parsers

Every tool integration should look like this:

```ts
// tools/ruff.ts
export const ruffTool = {
  buildLintInvocation(project, files): ToolInvocation,
  buildFormatInvocation(project, files): ToolInvocation,
};

// parsers/ruff.ts
export function parseRuffDiagnostics(output: ToolExecutionResult): Diagnostic[] { ... }
```

That separation matters because:

* command construction changes for project/toolchain reasons
* parsing changes for output shape reasons
* tests become much simpler

Tool adapter tests:

* “does it build the right command?”

Parser tests:

* “does it parse this output into canonical diagnostics?”

Do not mix them.

---

# 12. Unify shared model types in one place

Right now phase ids are duplicated:

* `packages/config-schema/src/index.ts`
* `packages/engine/src/contracts.ts`

That is a maintenance trap.

## Add one shared model package

Something like:

```text
packages/model/
  src/
    ids.ts
    contracts.ts
    diagnostics.ts
    stages.ts
    languages.ts
```

Then:

* config-schema imports stage ids from model
* engine imports stage ids from model
* reporters import status types from model
* adapters import shared ids from model

Also: pick one term.

I would strongly recommend:

* use **stage**
* stop using **phase**

Since this is a clean rewrite, you do not need legacy naming.
That means rename:

* `phaseIds` → `stageIds`
* `PhaseId` → `StageId`
* `PhaseResult` → `StageResult`

That alone will reduce cognitive noise across the repo.

---

# 13. Improve config so it is modular by language and stage

Current config is surface/profile/phase oriented, but not properly language-oriented.

Add a config shape like:

```json
{
  "stages": {
    "lint": { "enabled": true },
    "format": { "enabled": true }
  },
  "languages": {
    "python": {
      "enabled": true,
      "stages": {
        "lint": { "tool": "ruff" },
        "format": { "tool": "ruff" },
        "typecheck": { "tool": "mypy" }
      }
    },
    "typescript": {
      "enabled": true,
      "stages": {
        "lint": { "tool": "biome" },
        "format": { "tool": "biome" },
        "typecheck": { "tool": "tsc" }
      }
    }
  },
  "surfaces": {
    "hook": { "profile": "fast" },
    "github": { "profile": "deep" },
    "opencode": { "profile": "fast", "publishDiagnostics": true }
  }
}
```

## Config should answer:

* is this stage enabled?
* is this language enabled?
* which tool implements this stage for this language?
* does this surface publish diagnostics?
* which stages are cadence-only vs continuous?

That makes the system configurable without editing code.

---

# 14. Make adding a new language boring

That is the goal.

## Add-language checklist

1. Add `LanguageId` in shared model
2. Create `languages/<id>/index.ts`
3. Add file matcher in `detect.ts`
4. Add `resolveProjects()`
5. Add handlers for supported stages
6. Add tool adapters/parsers if needed
7. Register in `registry/languages.ts`
8. Add fixture project
9. Add contract tests
10. Add benchmark scenario if performance-sensitive

If that process needs edits in 10 unrelated places, the architecture is wrong.

---

# 15. Make adding a new stage boring too

## Add-stage checklist

1. Add `StageId` in shared model
2. Create `stages/<stage>/definition.ts`
3. Register it in `registry/stages.ts`
4. Add config defaults/profile defaults
5. Implement handlers only for languages that support it
6. Add stage contract tests
7. Add reporter text if needed
8. Add benchmark scenario if it is expensive

Again: adding a stage should not require editing a central mega-runner.

---

# 16. Clean code / readability rules for the rewrite

These should be explicit project rules.

## Single responsibility

Each module should answer one question only:

* `project.ts` → how do I group files into projects?
* `tool.ts` → how do I run this tool?
* `parser.ts` → how do I parse this tool’s output?
* `definition.ts` → what does this stage mean?
* `adapter.ts` → how do I expose the engine to a surface?

If a file does more than one of those, split it.

## Human readability

* Prefer small files over huge “smart” files
* Prefer explicit names over generic helpers
* Avoid `utils.ts` dumping grounds
* Keep public entrypoints thin (`index.ts` only exports)
* Use domain names: `ProjectGraph`, `StageHandler`, `ToolInvocation`, `CacheService`
* Keep control flow shallow with early returns
* No giant `if / else if / switch` chains for stage-language dispatch

## Clean-code conventions

* one canonical vocabulary: `stage`, `language`, `project`, `tool`, `diagnostic`, `artifact`
* no duplicate constants across packages
* keep pure logic pure: parsers, planners, selectors should have no IO
* isolate side effects: process execution, file reads, env lookup
* use typed errors for expected cases:

  * `ToolNotInstalledError`
  * `UnsupportedLanguageError`
  * `InvalidConfigError`
  * `CancelledError`

## Size discipline

Soft rule:

* target under ~250–300 LOC per file
* if a file crosses ~400 LOC, it needs a justification
* `runners.ts` should not exist in the end-state

---

# 17. Refactor the CLI too

`packages/cli/src/index.ts` is already turning into a command monolith.

Split it into:

```text
packages/cli/src/
  index.ts
  args/
    parse.ts
  commands/
    check.ts
    plan.ts
    watch.ts
    serve.ts
  output/
    text.ts
    json.ts
  watch/
    watcher.ts
    debounce.ts
  serve/
    server.ts
    request.ts
```

The CLI should stay a surface adapter, not become a second engine.

---

# 18. Testing strategy that supports modularity

You want three test layers:

## 1. Unit tests

For:

* parsers
* config merging
* stage definitions
* project resolvers
* cache keys

## 2. Contract tests

For every language module:

* given files X
* stage Y
* handler returns valid canonical `StageResult`

For every stage:

* aggregation rules
* not-implemented behavior
* empty selection behavior

## 3. Integration tests

Real tool execution against fixtures:

* Python fixture
* TypeScript fixture
* Terraform fixture
* HCL fixture
* Rust fixture
* Go fixture
* JVM fixture
* .NET fixture
* Shell/PowerShell fixture

And keep benchmark tests separate.

---

# 19. Practical first refactor sequence

I would do this in order:

## Step 1

Create a shared model package for:

* stage ids
* language ids
* result/status contracts

## Step 2

Rename `phase` to `stage` everywhere.

## Step 3

Split `runners.ts` into:

* `core/tool-runner.ts`
* `parsers/*`
* `tools/*`

## Step 4

Introduce `registry/stages.ts` and `registry/languages.ts`.

## Step 5

Move one language fully first as the template:

* TypeScript/JavaScript

## Step 6

Move one non-Node ecosystem next:

* Python

## Step 7

Move Terraform/HCL with shared ecosystem helpers.

## Step 8

Move JVM and .NET into ecosystem-backed modules.

## Step 9

Split CLI command handling.

## Step 10

Write docs:

* `docs/architecture.md`
* `docs/adding-language.md`
* `docs/adding-stage.md`
* `docs/caching.md`

---

# 20. The architecture rule I’d enforce

If you want one sentence to guide the whole refactor, make it this:

**The engine orchestrates; stages define policy; languages declare support; tool adapters execute commands; parsers translate outputs.**

That gives you:

* easy extension
* better performance
* much better readability
* far less fear when adding new support later

---

# Concrete recommendation for this repo

If I were turning this repo into the clean version, I would do exactly this:

1. **Keep the current package split**
2. **Add one shared model package**
3. **Refactor `packages/engine/src/runners.ts` into registry + language/stage/tool/parser modules**
4. **Split `packages/cli/src/index.ts` into commands**
5. **Add language-stage authoring templates**
6. **Adopt `stage` as the only term**
7. **Put all cross-language/project resolution into a `ProjectGraph`**
8. **Put all spawning/caching into shared engine infrastructure**
9. **Keep every surface adapter thin**

That gets you a system that is modular in exactly the two dimensions you care about:

* adding new **languages/techs**
* adding new **stages**

And it also directly improves:

* SRP
* readability
* maintainability
* testability
* performance predictability

If you want, I’ll turn this into a **concrete target folder tree + interface definitions** for the engine package so you can start refactoring immediately.
