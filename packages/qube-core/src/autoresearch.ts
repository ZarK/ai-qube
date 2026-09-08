import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const AUTORESEARCH_TARGET_KINDS = [
  "code",
  "document-corpus",
  "design-artifact",
  "prompt-pack",
  "unknown",
] as const;

export const AUTORESEARCH_OBJECTIVE_SHAPES = [
  "direct-metric",
  "threshold",
  "finding-reduction",
  "judge-rubric",
  "human-gated",
  "composite",
] as const;

export const AUTORESEARCH_EVALUATOR_KINDS = [
  "command-metric",
  "rubric-review",
  "human-gated",
] as const;

export type AutoresearchTargetKind = typeof AUTORESEARCH_TARGET_KINDS[number];
export type AutoresearchObjectiveShape = typeof AUTORESEARCH_OBJECTIVE_SHAPES[number];
export type AutoresearchEvaluatorKind = typeof AUTORESEARCH_EVALUATOR_KINDS[number];
export type AutoresearchObjectiveDirection = "maximize" | "minimize" | "threshold" | "human-gated";
export type AutoresearchPlanClassification = "autoresearch" | "route-normal-planning" | "needs-clarification";

export interface AutoresearchTarget {
  readonly input: string;
  readonly path: string;
  readonly kind: AutoresearchTargetKind;
  readonly supportedKind: "local-directory";
}

export interface AutoresearchObjective {
  readonly shape: AutoresearchObjectiveShape;
  readonly direction: AutoresearchObjectiveDirection;
  readonly metric: string;
  readonly description: string;
}

export interface AutoresearchMutableSurface {
  readonly path: string;
  readonly kind: "directory" | "file-pattern";
  readonly permission: "read-write" | "read-only";
  readonly reason: string;
}

export interface AutoresearchInvariant {
  readonly id: string;
  readonly description: string;
}

export interface AutoresearchAcceptancePolicy {
  readonly mode: "score-improvement" | "threshold" | "finding-reduction" | "human-gated";
  readonly direction: AutoresearchObjectiveDirection;
  readonly threshold?: number;
  readonly promotionRequiresHuman: boolean;
  readonly evidenceRequired: readonly string[];
}

export interface AutoresearchEvaluator {
  readonly schemaVersion: 1;
  readonly kind: AutoresearchEvaluatorKind;
  readonly owner: "aiq";
  readonly goal: string;
  readonly objective: AutoresearchObjective;
  readonly direction: AutoresearchObjectiveDirection;
  readonly command?: string;
  readonly inputs: readonly AutoresearchEvaluatorInput[];
  readonly rubric?: readonly string[];
  readonly signals: readonly string[];
  readonly invariants: readonly AutoresearchInvariant[];
  readonly acceptancePolicy: AutoresearchAcceptancePolicy;
  readonly provenance: {
    readonly synthesizedBy: "aib";
    readonly targetKind: AutoresearchTargetKind;
  };
  readonly hash: string;
}

export interface AutoresearchEvaluatorInput {
  readonly path: string;
  readonly sha256: string;
}

export interface AutoresearchArena {
  readonly schemaVersion: 1;
  readonly runId?: string;
  readonly goal: string;
  readonly target: AutoresearchTarget;
  readonly objective: AutoresearchObjective;
  readonly mutableSurfaces: readonly AutoresearchMutableSurface[];
  readonly invariants: readonly AutoresearchInvariant[];
  readonly acceptancePolicy: AutoresearchAcceptancePolicy;
  readonly evaluator: Pick<AutoresearchEvaluator, "kind" | "owner" | "hash" | "objective" | "signals">;
  readonly ownership: Readonly<Record<string, string>>;
  readonly safety: {
    readonly evaluatorFixedBeforeRun: true;
    readonly targetMutationBeforePromote: false;
    readonly sandboxDirectory?: string;
    readonly promotionExplicit: true;
    readonly stateDirectory?: string;
  };
  readonly lifecycle: readonly string[];
}

export interface AutoresearchBlockingQuestion {
  readonly id: string;
  readonly text: string;
  readonly reason: string;
}

export interface AutoresearchArenaPlan {
  readonly schemaVersion: 1;
  readonly classification: AutoresearchPlanClassification;
  readonly target?: AutoresearchTarget;
  readonly goal: string;
  readonly objective?: AutoresearchObjective;
  readonly evaluator?: AutoresearchEvaluator;
  readonly mutableSurfaces: readonly AutoresearchMutableSurface[];
  readonly invariants: readonly AutoresearchInvariant[];
  readonly acceptancePolicy?: AutoresearchAcceptancePolicy;
  readonly arena?: AutoresearchArena;
  readonly arenaMarkdown?: string;
  readonly blockingQuestions: readonly AutoresearchBlockingQuestion[];
  readonly readinessChecklist: readonly string[];
  readonly nextAction: string;
}

export function autoresearchReadinessChecklist(plan: AutoresearchArenaPlan): readonly string[] {
  const checks = [
    plan.target ? "target resolved" : "target unresolved",
    plan.objective ? "objective shaped" : "objective unresolved",
    plan.evaluator ? "evaluator proposed" : "evaluator unresolved",
    plan.mutableSurfaces.length > 0 ? "mutable surfaces bounded" : "mutable surfaces unresolved",
    plan.invariants.length > 0 ? "invariants defined" : "invariants unresolved",
    plan.acceptancePolicy ? "acceptance policy defined" : "acceptance policy unresolved",
    plan.blockingQuestions.length === 0 ? "no blocking questions" : "blocking questions open",
  ];
  return Object.freeze(checks);
}

export function hashEvaluatorInputs(
  root: string,
  inputPaths: readonly string[],
): readonly AutoresearchEvaluatorInput[] {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    throw new TypeError(`Evaluator input root cannot be read: ${root}. ${readErrorMessage(error)}`);
  }

  const inputs = new Map<string, AutoresearchEvaluatorInput>();
  for (const inputPath of inputPaths) {
    if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
      throw new TypeError("Evaluator input paths must be non-empty strings.");
    }
    if (path.isAbsolute(inputPath)) {
      throw new TypeError(`Evaluator input must be relative to the target: ${inputPath}`);
    }
    const segments = inputPath.replaceAll("\\", "/").split("/");
    if (segments.includes("..")) {
      throw new TypeError(`Evaluator input must not contain parent traversal: ${inputPath}`);
    }

    const resolvedPath = path.resolve(realRoot, inputPath);
    const relativePath = path.relative(realRoot, resolvedPath).replaceAll("\\", "/");
    if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith("../")) {
      throw new TypeError(`Evaluator input must name a file inside the target: ${inputPath}`);
    }

    let realInputPath: string;
    try {
      realInputPath = realpathSync(resolvedPath);
      if (!statSync(realInputPath).isFile()) {
        throw new TypeError(`Evaluator input is not a regular file: ${relativePath}`);
      }
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new TypeError(
        `Evaluator input cannot be read: ${relativePath}. ${readErrorMessage(error)}`,
      );
    }
    const realRelativePath = path.relative(realRoot, realInputPath);
    if (
      realRelativePath.length === 0 ||
      realRelativePath === ".." ||
      realRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelativePath)
    ) {
      throw new TypeError(`Evaluator input resolves outside the target: ${relativePath}`);
    }

    try {
      const sha256 = createHash("sha256").update(readFileSync(realInputPath)).digest("hex");
      const dedupeKey = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
      inputs.set(dedupeKey, { path: relativePath, sha256 });
    } catch (error) {
      throw new TypeError(
        `Evaluator input cannot be read: ${relativePath}. ${readErrorMessage(error)}`,
      );
    }
  }

  return [...inputs.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
