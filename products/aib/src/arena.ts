import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  autoresearchReadinessChecklist,
  type AutoresearchAcceptancePolicy,
  type AutoresearchArena,
  type AutoresearchArenaPlan,
  type AutoresearchBlockingQuestion,
  type AutoresearchEvaluator,
  type AutoresearchInvariant,
  type AutoresearchMutableSurface,
  type AutoresearchObjective,
  type AutoresearchTarget,
  type AutoresearchTargetKind,
} from "@tjalve/qube-core";

export interface AutoresearchSynthesisInput {
  readonly target?: string;
  readonly goal?: string;
  readonly cwd?: string;
}

export function synthesizeAutoresearchArena(input: AutoresearchSynthesisInput): AutoresearchArenaPlan {
  const cwd = input.cwd ?? process.cwd();
  const targetInput = input.target?.trim() ?? "";
  const goal = input.goal?.trim() ?? "";
  const blockingQuestions: AutoresearchBlockingQuestion[] = [];
  if (targetInput.length === 0) {
    blockingQuestions.push({
      id: "target",
      text: "Which local target directory should autoresearch inspect?",
      reason: "Autoresearch needs a concrete local target before it can bound mutable surfaces."
    });
  }
  if (goal.length === 0 || isAmbiguousGoal(goal)) {
    blockingQuestions.push({
      id: "goal",
      text: "What measurable result should improve, and how should success be judged?",
      reason: "The goal is too broad to make progress machine-verifiable without pretending subjective progress is objective."
    });
  }
  if (/^(?:https?:|github:|gitlab:|linear:)/i.test(targetInput)) {
    return incompletePlan({
      classification: "route-normal-planning",
      goal,
      blockingQuestions: [{
        id: "target.kind",
        text: "Provide a local directory target for this autoresearch run.",
        reason: "Remote and provider target kinds are outside this autoresearch setup scope."
      }],
      nextAction: "Route this request to normal planning or clone/prepare a local target before synthesizing an arena."
    });
  }

  const targetPath = targetInput ? path.resolve(cwd, targetInput) : "";
  if (targetInput && (!existsSync(targetPath) || !statSync(targetPath).isDirectory())) {
    blockingQuestions.push({
      id: "target.exists",
      text: "Which existing local directory should autoresearch use?",
      reason: `The target does not resolve to an existing directory: ${targetPath}`
    });
  }
  if (blockingQuestions.length > 0) {
    return incompletePlan({
      classification: "needs-clarification",
      goal,
      blockingQuestions,
      nextAction: "Answer the blocking questions, then rerun aib arena synthesize."
    });
  }

  const targetKind = classifyTarget(targetPath);
  if (targetKind === "unknown") {
    return incompletePlan({
      classification: "needs-clarification",
      goal,
      blockingQuestions: [{
        id: "target.kind",
        text: "What kind of artifact is this target and which files may autoresearch change?",
        reason: "The target does not expose enough code, document, design, or prompt-pack signals to infer a safe arena."
      }],
      nextAction: "Clarify the target kind or add a recognizable project/document fixture before synthesizing."
    });
  }

  const target: AutoresearchTarget = {
    input: targetInput,
    path: targetPath,
    kind: targetKind,
    supportedKind: "local-directory"
  };
  const command = targetKind === "code" ? inferCommand(targetPath) : undefined;
  if (command?.kind === "blocked") {
    return incompletePlan({
      classification: "needs-clarification",
      goal,
      blockingQuestions: [command.question],
      nextAction: "Answer the package-manager question, then rerun aib arena synthesize."
    });
  }
  const objective = createObjective(goal, targetKind);
  const invariants = createInvariants();
  const mutableSurfaces = createMutableSurfaces(target);
  const acceptancePolicy = createAcceptancePolicy(objective, targetKind);
  const evaluator = createEvaluator({ goal, target, objective, invariants, acceptancePolicy, command: command?.command });
  const arena = createArena({ goal, target, objective, mutableSurfaces, invariants, acceptancePolicy, evaluator });
  const draft: Omit<AutoresearchArenaPlan, "readinessChecklist"> = {
    schemaVersion: 1,
    classification: "autoresearch",
    target,
    goal,
    objective,
    evaluator,
    mutableSurfaces,
    invariants,
    acceptancePolicy,
    arena,
    arenaMarkdown: renderArenaMarkdown(arena, evaluator),
    blockingQuestions: [],
    nextAction: "Run qube autoresearch init <target> <goal> --json to persist this synthesized arena."
  };
  return { ...draft, readinessChecklist: autoresearchReadinessChecklist({ ...draft, readinessChecklist: [] }) };
}

function incompletePlan(input: {
  readonly classification: "route-normal-planning" | "needs-clarification";
  readonly goal: string;
  readonly blockingQuestions: readonly AutoresearchBlockingQuestion[];
  readonly nextAction: string;
}): AutoresearchArenaPlan {
  const draft: Omit<AutoresearchArenaPlan, "readinessChecklist"> = {
    schemaVersion: 1,
    classification: input.classification,
    goal: input.goal,
    mutableSurfaces: [],
    invariants: [],
    blockingQuestions: input.blockingQuestions,
    nextAction: input.nextAction
  };
  return { ...draft, readinessChecklist: autoresearchReadinessChecklist({ ...draft, readinessChecklist: [] }) };
}

function isAmbiguousGoal(goal: string): boolean {
  const words = extractSignals(goal);
  if (words.length < 2) return true;
  return /^(?:make\s+)?(?:it\s+)?(?:better|nice|good|faster|cleaner|improve|optimize|fix)$/i.test(goal.trim());
}

function classifyTarget(targetPath: string): AutoresearchTargetKind {
  const entries = safeEntries(targetPath);
  const names = new Set(entries.map(entry => entry.name.toLowerCase()));
  if (names.has("package.json") || names.has("tsconfig.json") || names.has("src")) return "code";
  if (entries.some(entry => /(?:prompt|system|agent).*\.(?:md|txt|json)$/i.test(entry.name))) return "prompt-pack";
  if (entries.some(entry => /\.(?:md|mdx|txt|rst)$/i.test(entry.name))) return "document-corpus";
  if (entries.some(entry => /\.(?:fig|sketch|png|jpg|jpeg|webp|svg)$/i.test(entry.name))) return "design-artifact";
  return "unknown";
}

function safeEntries(targetPath: string): readonly { readonly name: string; readonly path: string; readonly directory: boolean }[] {
  return readdirSync(targetPath, { withFileTypes: true })
    .filter(entry => ![".git", ".qube", "node_modules", "dist", "build"].includes(entry.name))
    .slice(0, 200)
    .map(entry => ({ name: entry.name, path: path.join(targetPath, entry.name), directory: entry.isDirectory() }));
}

function createObjective(goal: string, targetKind: AutoresearchTargetKind): AutoresearchObjective {
  const lower = goal.toLowerCase();
  if (/\b(?:threshold|below|under|above|over|at\s+least|at\s+most|satisfy|pass)\b/.test(lower)) {
    const threshold = extractObjectiveThreshold(lower);
    const direction = /\b(?:above|over|at\s+least)\b/.test(lower) ? "maximize" : "minimize";
    return {
      shape: "threshold",
      direction,
      metric: threshold === undefined ? "threshold result" : `threshold ${threshold}`,
      description: threshold === undefined
        ? "Satisfy the configured threshold checks without weakening invariants."
        : `Satisfy the configured threshold check at ${threshold} without weakening invariants.`
    };
  }
  if (/\b(?:fast|faster|runtime|latency|performance|speed)\b/.test(lower)) {
    return {
      shape: "direct-metric",
      direction: "minimize",
      metric: "runtime",
      description: "Reduce measured runtime while preserving target invariants."
    };
  }
  if (/\b(?:failures?|findings?|bugs?|errors?|violations?)\b/.test(lower)) {
    return {
      shape: "finding-reduction",
      direction: "minimize",
      metric: "finding count",
      description: "Reduce reviewable findings without weakening the acceptance policy."
    };
  }
  if (targetKind === "document-corpus" || /\b(?:summary|quality|clarity|readability|docs?|documentation)\b/.test(lower)) {
    return {
      shape: "judge-rubric",
      direction: "human-gated",
      metric: "rubric score",
      description: "Improve review quality against a fixed rubric and require explicit promotion."
    };
  }
  return {
    shape: "composite",
    direction: "maximize",
    metric: "accepted score",
    description: "Improve the target against synthesized measurable signals and fixed invariants."
  };
}

function createInvariants(): readonly AutoresearchInvariant[] {
  return [
    { id: "sandbox-first", description: "Candidate work stays under .qube/autoresearch until explicit promote." },
    { id: "fixed-evaluator", description: "The evaluator hash must not change after init." },
    { id: "bounded-mutation", description: "Promotion may only write through the declared mutable surfaces." },
    { id: "evidence-retained", description: "Arena, evaluator, attempts, and promotion evidence stay in the run directory." }
  ];
}

function createMutableSurfaces(target: AutoresearchTarget): readonly AutoresearchMutableSurface[] {
  return [{
    path: target.path,
    kind: "directory",
    permission: "read-write",
    reason: "The requested local target is the only surface eligible for promoted changes."
  }];
}

function createAcceptancePolicy(objective: AutoresearchObjective, targetKind: AutoresearchTargetKind): AutoresearchAcceptancePolicy {
  if (objective.shape === "threshold") {
    return {
      mode: "threshold",
      direction: objective.direction,
      threshold: parseObjectiveThreshold(objective.metric),
      promotionRequiresHuman: true,
      evidenceRequired: ["baseline threshold output", "candidate threshold output", "changed files"]
    };
  }
  if (objective.shape === "finding-reduction") {
    return {
      mode: "finding-reduction",
      direction: objective.direction,
      promotionRequiresHuman: true,
      evidenceRequired: ["baseline findings", "candidate findings", "changed files"]
    };
  }
  if (objective.shape === "direct-metric" && targetKind === "code") {
    return {
      mode: "score-improvement",
      direction: objective.direction,
      promotionRequiresHuman: true,
      evidenceRequired: ["baseline command output", "candidate command output", "changed files"]
    };
  }
  return {
    mode: "human-gated",
    direction: "human-gated",
    promotionRequiresHuman: true,
    evidenceRequired: ["fixed rubric", "candidate summary", "changed files"]
  };
}

function createEvaluator(input: {
  readonly goal: string;
  readonly target: AutoresearchTarget;
  readonly objective: AutoresearchObjective;
  readonly invariants: readonly AutoresearchInvariant[];
  readonly acceptancePolicy: AutoresearchAcceptancePolicy;
  readonly command?: string;
}): AutoresearchEvaluator {
  const signals = extractSignals(input.goal);
  const base = {
    schemaVersion: 1 as const,
    kind: input.target.kind === "code" ? "command-metric" as const : "rubric-review" as const,
    owner: "aiq" as const,
    goal: input.goal,
    objective: input.objective,
    direction: input.objective.direction,
    command: input.target.kind === "code" ? input.command : undefined,
    rubric: input.target.kind === "code" ? undefined : createRubric(input.goal),
    signals,
    invariants: input.invariants,
    acceptancePolicy: input.acceptancePolicy,
    provenance: {
      synthesizedBy: "aib" as const,
      targetKind: input.target.kind
    }
  };
  return { ...base, hash: hashJson(base) };
}

type PackageCommandTool = "pnpm" | "npm" | "yarn" | "bun";

type InferredCommand =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "blocked"; readonly question: AutoresearchBlockingQuestion };
type BlockedCommand = Extract<InferredCommand, { readonly kind: "blocked" }>;

function inferCommand(targetPath: string): InferredCommand {
  const manifestPath = path.join(targetPath, "package.json");
  if (!existsSync(manifestPath)) {
    return blockingPackageManagerQuestion("No package.json was found for the code target.");
  }
  let manifest: { scripts?: Record<string, string>; packageManager?: string };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { scripts?: Record<string, string>; packageManager?: string };
  } catch {
    return blockingPackageManagerQuestion("package.json could not be parsed for a fixed evaluator command.");
  }
  const tool = inferPackageCommandTool(targetPath, manifest.packageManager);
  if (tool.kind === "blocked") {
    return tool;
  }
  if (manifest.scripts?.test) {
    return { kind: "command", command: testCommand(tool.tool) };
  }
  if (manifest.scripts?.build) {
    return { kind: "command", command: runScriptCommand(tool.tool, "build") };
  }
  return blockingPackageManagerQuestion("package.json does not define a test or build script for a fixed evaluator command.");
}

function inferPackageCommandTool(
  targetPath: string,
  packageManager: string | undefined
): { readonly kind: "tool"; readonly tool: PackageCommandTool } | { readonly kind: "blocked"; readonly question: AutoresearchBlockingQuestion } {
  const declared = declaredPackageCommandTool(packageManager);
  if (declared) return { kind: "tool", tool: declared };
  if (packageManager && packageManager.trim() !== "") {
    return blockingPackageManagerQuestion(`Unsupported packageManager value: ${packageManager}`);
  }

  const lockfileTools = [
    existsSync(path.join(targetPath, "pnpm-lock.yaml")) ? "pnpm" : undefined,
    existsSync(path.join(targetPath, "package-lock.json")) || existsSync(path.join(targetPath, "npm-shrinkwrap.json")) ? "npm" : undefined,
    existsSync(path.join(targetPath, "yarn.lock")) ? "yarn" : undefined,
    existsSync(path.join(targetPath, "bun.lock")) || existsSync(path.join(targetPath, "bun.lockb")) ? "bun" : undefined
  ].filter((tool): tool is PackageCommandTool => tool !== undefined);
  const uniqueTools = [...new Set(lockfileTools)];
  if (uniqueTools.length === 1) {
    return { kind: "tool", tool: uniqueTools[0] };
  }
  return blockingPackageManagerQuestion(
    uniqueTools.length > 1
      ? `Multiple package-manager lockfiles were found: ${uniqueTools.join(", ")}.`
      : "No packageManager field or package-manager lockfile was found."
  );
}

function declaredPackageCommandTool(packageManager: string | undefined): PackageCommandTool | undefined {
  if (!packageManager) return undefined;
  if (/^pnpm@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageManager)) return "pnpm";
  if (/^npm@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageManager)) return "npm";
  if (/^yarn@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageManager)) return "yarn";
  if (/^bun@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageManager)) return "bun";
  return undefined;
}

function testCommand(tool: PackageCommandTool): string {
  if (tool === "npm") return "npm test";
  if (tool === "bun") return "bun run test";
  return `${tool} test`;
}

function runScriptCommand(tool: PackageCommandTool, script: string): string {
  if (tool === "npm" || tool === "bun") return `${tool} run ${script}`;
  return `${tool} ${script}`;
}

function blockingPackageManagerQuestion(reason: string): BlockedCommand {
  return {
    kind: "blocked",
    question: {
      id: "target.packageManager",
      text: "Which package manager and evaluator script should autoresearch use for this code target?",
      reason
    }
  };
}

function createRubric(goal: string): readonly string[] {
  return [
    `Candidate directly addresses: ${goal}`,
    "Candidate preserves factual claims and source-sensitive wording.",
    "Candidate is easier to review than the baseline.",
    "Promotion remains explicit and evidence-backed."
  ];
}

function extractObjectiveThreshold(goal: string): number | undefined {
  const match = goal.match(/\b\d+(?:\.\d+)?\b/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function parseObjectiveThreshold(metric: string): number | undefined {
  const match = metric.match(/\b\d+(?:\.\d+)?\b/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function createArena(input: {
  readonly goal: string;
  readonly target: AutoresearchTarget;
  readonly objective: AutoresearchObjective;
  readonly mutableSurfaces: readonly AutoresearchMutableSurface[];
  readonly invariants: readonly AutoresearchInvariant[];
  readonly acceptancePolicy: AutoresearchAcceptancePolicy;
  readonly evaluator: AutoresearchEvaluator;
}): AutoresearchArena {
  return {
    schemaVersion: 1,
    goal: input.goal,
    target: input.target,
    objective: input.objective,
    mutableSurfaces: input.mutableSurfaces,
    invariants: input.invariants,
    acceptancePolicy: input.acceptancePolicy,
    evaluator: {
      kind: input.evaluator.kind,
      owner: input.evaluator.owner,
      hash: input.evaluator.hash,
      objective: input.evaluator.objective,
      signals: input.evaluator.signals
    },
    ownership: {
      qube: "top-level lifecycle and .qube/autoresearch state",
      aib: "arena synthesis and acceptance criteria",
      aie: "sandboxed candidate execution boundary",
      aiq: "fixed evaluator and referee evidence",
      aiu: "continuation and next safe command"
    },
    safety: {
      evaluatorFixedBeforeRun: true,
      targetMutationBeforePromote: false,
      promotionExplicit: true
    },
    lifecycle: ["init", "baseline", "run", "status", "dashboard", "promote"]
  };
}

function renderArenaMarkdown(arena: AutoresearchArena, evaluator: AutoresearchEvaluator): string {
  return [
    "# Autoresearch Arena",
    "",
    `Target: ${arena.target.path}`,
    `Target kind: ${arena.target.kind}`,
    `Goal: ${arena.goal}`,
    `Objective: ${arena.objective.description}`,
    `Evaluator: ${evaluator.kind}`,
    evaluator.command ? `Command: ${evaluator.command}` : undefined,
    "",
    "## Mutable Surfaces",
    ...arena.mutableSurfaces.map(surface => `- ${surface.path}: ${surface.reason}`),
    "",
    "## Invariants",
    ...arena.invariants.map(invariant => `- ${invariant.id}: ${invariant.description}`),
    "",
    "## Acceptance",
    `Mode: ${arena.acceptancePolicy.mode}`,
    `Direction: ${arena.acceptancePolicy.direction}`,
    `Promotion requires human: ${arena.acceptancePolicy.promotionRequiresHuman ? "yes" : "no"}`,
    ""
  ].filter((line): line is string => typeof line === "string").join("\n") + "\n";
}

function extractSignals(goal: string): readonly string[] {
  const stop = new Set(["make", "this", "that", "with", "from", "into", "than", "then", "able", "should"]);
  const terms = [...new Set(goal.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [])]
    .filter(term => !stop.has(term))
    .slice(0, 12);
  return terms.length > 0 ? terms : ["goal"];
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
