# Emerging naming conventions for AI-bootstrap repos

## Summary of findings

There is no single cross-tool “standard” for agent scaffolding yet, but a few conventions are converging because multiple popular tools now *explicitly* look for the same filenames and directory patterns (notably `AGENTS.md`, and GitHub-hosted instruction/prompt files under `.github/`). citeturn0search2turn9view0turn27view0turn2view1

The strongest practical constraint is tool compatibility: some tools hard-code defaults (for example, OpenCode’s `.opencode/` as the per-project config directory), while others ignore dot-directories in parts of their indexing pipelines, which makes “AI-only docs in `.aidocs/`” risky as a default. citeturn25view1turn26view2turn30view0

A workable “emerging standard” for what you want is therefore less about inventing a new directory name and more about **layering**: keep the tool-native directories so tools work out of the box, and add “tool-agnostic” files/dirs where multiple ecosystems already try to converge (notably `AGENTS.md` and `.github/*` instruction/prompt files). citeturn25view1turn11view0turn27view0turn26view0

## Agent configuration directories and instruction-file naming

### Can you use `.agents` instead of `.opencode`?

**Partially, yes—depending on what you want to store there.**

*OpenCode today* uses a per-project config directory named `.opencode/` (and global configs under OS-specific config locations), and it documents a precedence system across “remote”, “global”, and “per project” config locations. citeturn25view1

However, OpenCode also documents a **custom config directory** via `OPENCODE_CONFIG_DIR`, meaning you *can* point OpenCode at another folder name (e.g., `.agents`) if you’re willing to standardize that environment variable (or wrap OpenCode invocation in a small script). citeturn25view1

Separately, OpenCode’s **skills** discovery is already “agent-compatible” and explicitly searches `.agents/skills/*` (and `~/.agents/skills/*`) as part of its precedence chain. This is a strong signal that `.agents` is being treated as a tool-agnostic cross-CLI “skills” location, at least for that feature. citeturn11view0turn11view1

There is also independent reinforcement of `.agents` as a shared directory in other ecosystems: LangChain’s Deep Agents CLI documents `~/.agents/` and `.agents/` (project-level) as “tool-agnostic” locations for skills intended to work across different AI CLI tools. citeturn26view0

**Practical takeaway:**  
- If your goal is *“one folder for everything AI”*, `.agents/` is a plausible *tool-agnostic overlay* for shared assets like skills. citeturn11view0turn26view0  
- If your goal is *“OpenCode should work without extra env vars”*, you should keep `.opencode/` as the OpenCode-native directory and optionally mirror or sync subset content into `.agents/`. citeturn25view1turn24view6  

### Is `AGENTS.md` the best name for core agent instructions?

Right now, **`AGENTS.md` is the closest thing to a cross-tool convergence point**:

- OpenCode’s rules guidance uses `AGENTS.md` as the canonical place for project instructions and recommends committing it (and also references other tool ecosystems like Cursor rule directories and “Claude Code skills”). citeturn0search2turn0search6  
- entity["company","OpenAI","ai research company"]’s Codex agent documentation describes how it discovers instructions, starting with `AGENTS.md` or `AGENTS.override.md`, and also lists fallbacks like `.agents.md`. citeturn9view0  
- GitHub’s Copilot documentation explicitly references “agent instructions” via `AGENTS.md` files and describes how precedence can work based on proximity in the directory tree. citeturn27view0  
- Windsurf documents support for `AGENTS.md` (and also `agents.md`) and describes scoping behavior for multiple instruction files. citeturn2view1  

By contrast, `CLAUDE.md` is strongly associated with Anthropic’s Claude Code ecosystem and is supported as one of several instruction-file patterns, but it is not as cross-vendor as `AGENTS.md` is becoming. citeturn9view0turn0search2

**Practical takeaway:** `AGENTS.md` is the best default name for “core instructions” if you want multi-tool portability today. citeturn9view0turn2view1turn27view0

### Dot-directories for “AI docs” (`.aidocs`, `.aifiles`) are risky as a default

Two separate classes of evidence suggest dot-directories are a bad default for *documentation you expect the assistant to always see*:

- MkDocs documentation states that files/directories beginning with a dot are ignored by default (unless overridden), which is representative of “docs tooling” behavior more broadly. citeturn30view0  
- A Cursor community report specifically says that dot folders were ignored for context, including a `.aidocs` folder used for LLM context. Even if that behavior changes over time, it’s exactly the instability you want to avoid in a bootstrap standard. citeturn26view2  

**Practical takeaway:** Use `docs/ai/` or `docs/agents/` rather than `.aidocs/` as the canonical location for project context docs you want reliably indexed. citeturn30view0turn26view2

## Requirements and documentation folder naming

### Should you use `docs/` instead of `spec/`?

If you want “emerging standard” alignment across documentation tooling and repo conventions, **`docs/` is the safest umbrella**:

- MkDocs documents that `docs/` is the default documentation directory in its canonical project layout. citeturn30view0  
- Docusaurus documentation structures examples under a `docs/` directory and explains how organization under `docs/` affects IDs and URLs. citeturn30view1  

This matters because even if you don’t adopt MkDocs/Docusaurus yourself, many projects do, and “docs live in `docs/`” is a stable expectation for humans and tools.

A `spec/` folder is still reasonable, but it’s more “team convention” than ecosystem standard. The most compatible approach is often:

- keep **user-facing and project docs** under `docs/`, and
- store your “dry spec” *either* as `docs/spec.md` *or* `docs/spec/…`, depending on whether you want one-file or multi-file. citeturn30view0turn30view1  

### Recommendation: treat “spec” as a *type*, not a top-level folder

A pattern that fits both docs tooling and your AI-bootstrap workflow is:

- `docs/spec.md` — a durable, stable “contract” spec (your dry spec)  
- `docs/milestones/` — milestone-level delivery units  
- `docs/architecture/` or `docs/adr/` — architecture decisions and gates  
- `docs/ux/` — UX flows if you want them separated

This matches how most doc tools expect content to live under `docs/` while still making “spec vs milestone vs ADR” explicit by path. citeturn30view0turn30view1turn7search2

## Document naming for specs, milestones, architecture, and UX

### Is `spec.md` a good name for the dry spec?

As a general naming choice, `spec.md` is clear and stable, and it aligns with “single source of truth” behavior you want. Your own current pattern already uses `spec.md` as a root-level “dry spec” artifact, which demonstrates that it works well for navigation and linking. fileciteturn0file5

That said, GitHub’s new “spec-driven development” materials (Copilot-focused) show that teams may also place “spec artifacts” under `.github/prompts/` and/or a dedicated spec workspace folder as part of agent workflows. This suggests you should expect *multiple spec-adjacent file types* to coexist: contract spec(s), prompt templates, and scoped instruction files. citeturn27view0turn23view0turn23view1

**Practical takeaway:** Prefer `docs/spec.md` as the canonical location, and optionally keep a short root `spec.md` that points to it if you want maximal discoverability. citeturn30view0turn30view1

### Milestone naming: `M<N>-slug.md` is consistent with broader “numbered proposals” traditions

Numbered, prefixed documents are a long-running pattern in large OSS ecosystems because they sort well, remain linkable, and convey sequencing:

- Rust RFCs explicitly use numeric prefixes in filenames (e.g., copying `0000-template.md` to `text/0000-my-feature.md`, later renaming to the accepted number). citeturn32search1turn32search3  
- Kubernetes Enhancement Proposals (KEPs) similarly treat proposals as structured, tracked artifacts, reinforcing the “design/proposal doc as a first-class unit” concept (even if their exact folder layout differs). citeturn7search11  

Your milestone naming approach mirrors this: predictable IDs + descriptive slugs. You already have milestone-like docs where the milestone number is part of the filename (for example, an M27 query API milestone doc), which is exactly the “sortable, referencable” behavior those ecosystems optimize for. fileciteturn0file6

**Practical takeaway:** `docs/milestones/M00-e2e-harness.md`, `docs/milestones/M01-import.md`, etc., is aligned with robust conventions. citeturn32search1turn30view0

### Splitting by prefix: `M` for milestones, `A` for architecture gates, `U` for UX

This split is not a universal standard, but it matches established “document type taxonomy” patterns:

- ADRs are a well-established convention for architecture decisions (commonly stored in `docs/adr/` and named with an `ADR-` prefix or numbering). citeturn7search2  
- KEPs and RFCs show that “proposal/design docs” often get their own namespaces and numbering patterns. citeturn7search11turn32search3  

So you can implement a simple taxonomy without inventing new terms:

- `M##-...` for milestone delivery slices (user-visible outcomes + tests)  
- `A##-...` for architecture constraints (“gates”) and scalability rules  
- `U##-...` for UX flows and UI contracts if you want them separable from engineering milestones

This is likely easier to maintain than trying to force everything into one sequence, because architecture gates often apply across many milestones, and UX flows often change differently than backend contracts. citeturn7search2turn7search11turn32search3

### Can `M0` always be “bootstrap the E2E harness”?

As a *team standard*, yes—and it’s defensible from a reliability perspective:

- Playwright documents `getByTestId()` and the default `data-testid` attribute convention, which supports your preference for stable selectors and deterministic automation contracts. citeturn31search0  
- Playwright also documents dedicated Electron automation support, reinforcing that “E2E harness as a first-class artifact” is feasible and common in Electron apps. citeturn31search1  
- The broader testing literature emphasizes that “broad-stack tests are expensive/slow/brittle” unless you deliberately engineer them to be fast and reliable, which aligns with your approach of building test-mode flags, stable selectors, and deterministic fixtures early. citeturn31search2  

So “M0 = harness” is a good policy, with one nuance: keep M0’s acceptance criteria narrowly about **determinism + isolation + test APIs**, not about product features, so it stays stable and doesn’t turn into a dumping ground. citeturn31search2turn31search0turn27view0

## Command naming conventions for your workflow

### OpenCode custom commands: where they live and how they’re named

OpenCode documents that custom commands live in `.opencode/commands/*` and are invoked as slash commands (e.g., `/component Button`), with argument substitution via `$ARGUMENTS` or positional `$1`, `$2`, etc. citeturn24view6turn25view1

OpenCode also documents that you can override built-in commands by creating a command file with the same name. citeturn24view6

This strongly suggests you should:
- choose command names that won’t collide unintentionally with common built-ins (`init`, `help`, etc.), and
- standardize a consistent prefix/namespace to make discovery and autocomplete predictable. citeturn24view6turn25view1

### GitHub-centric “prompt commands” are converging under `.github/`

GitHub Copilot supports repo-wide instructions via `.github/copilot-instructions.md`, scoped instructions under `.github/instructions/*.instructions.md`, and also prompt files under `.github/prompts/*.prompt.md`. citeturn27view0

This matters because, over time, you may want your ai-bootstrap system to emit both:
- OpenCode commands (`.opencode/commands/*.md`) for OpenCode users, and
- Copilot prompt files (`.github/prompts/*.prompt.md`) for GitHub-native agent workflows,

without forcing the project to “pick one tool.” citeturn27view0turn25view1

### Recommended command names, and how to keep them short

Your proposed command set is coherent:

- `/bootstrap`
- `/create-spec <idea>`
- `/validate-spec [inputs]`
- `/create-milestone <feature>`
- `/create-issues <milestone>`
- `/solve-issues`

The main “standardization” question is naming collisions and grouping. OpenCode lists commands together, so using a prefix is the simplest “namespace.” citeturn24view6

Given your desire for a short brand prefix that pairs with `aiq`, a practical convention is:

- Use `aib-` as the **command namespace** (3 letters, still short).
- Optionally define 2-letter *aliases* later if OpenCode adds aliasing (not documented today), but your stable primary names remain `aib-*`. citeturn24view6turn25view1

So the OpenCode command names become:

- `/aib-bootstrap`
- `/aib-spec`
- `/aib-validate-spec`
- `/aib-milestone`
- `/aib-issues`
- `/aib-solve`

This avoids collisions with generic verbs like `/bootstrap` that other ecosystems might add later, and it keeps all your commands adjacent in command pickers/autocomplete. citeturn24view6

## A naming standard that fits your goals and current ecosystem constraints

### Directory and filename proposal

A structure that aligns with today’s tool expectations while preserving a tool-agnostic core:

```text
AGENTS.md                      # primary, cross-tool agent instructions
README.md                       # human + agent-friendly, “how to bootstrap”
.github/
  copilot-instructions.md       # optional: GitHub Copilot repo-wide baseline
  instructions/                 # optional: file-scoped Copilot instructions
  prompts/                      # optional: reusable prompt templates (.prompt.md)
.opencode/
  opencode.jsonc                # OpenCode config (or leave global)
  commands/                     # OpenCode slash commands
  plugins/                      # OpenCode plugins (if needed)
.agents/
  skills/                       # tool-agnostic skills (cross-CLI compatible)
docs/
  spec.md                       # dry spec contract (canonical)
  milestones/
    M00-e2e-harness.md
    M01-...
  architecture/
    A01-...
  adr/
    ADR-YYYYMMDD-...
  ux/
    U01-...
```

Why this structure matches “emerging standards”:

- `AGENTS.md` is now recognized or referenced across multiple toolchains (OpenCode, GitHub Copilot agent guidance, Windsurf, OpenAI Codex docs). citeturn0search2turn27view0turn2view1turn9view0  
- `.opencode/commands` is explicitly the OpenCode custom command mechanism. citeturn24view6turn25view1  
- `.github/*` is GitHub’s documented home for Copilot instructions and prompt files, which is the clearest “standard” location if you want GitHub-native compatibility. citeturn27view0  
- `.agents/skills` is already a documented search path for OpenCode skills and also appears in other ecosystems as a tool-agnostic location. citeturn11view0turn26view0  
- `docs/` is the most interoperable umbrella folder for documentation and avoids dotfolder-ignoring behavior in common doc tooling and reported assistant ingestion pipelines. citeturn30view0turn26view2turn30view1  

### How this maps to your existing artifacts

Your current “dry spec + numbered milestone docs” approach is already consistent with these conventions; the main difference is whether you keep `spec.md` at repo root or place it under `docs/`. The content and naming pattern you’re using (single spec doc plus numbered milestones) already matches what’s worked in large ecosystems (numbered, stable, linkable docs). fileciteturn0file5 citeturn32search1turn32search3

### Recommendation on the `.opencode` vs `.agents` question

If your *primary goal* is “I can clone and immediately run the workflow without any env vars,” keep `.opencode/` as the authoritative OpenCode config home and treat `.agents/` as a cross-tool “shared skill library.” citeturn25view1turn11view0

If your *primary goal* is “one stable directory name across multiple AI CLIs,” you can move OpenCode’s config into `.agents/` **only if** you commit to setting `OPENCODE_CONFIG_DIR=.agents` as part of your bootstrap wrapper. citeturn25view1turn26view0