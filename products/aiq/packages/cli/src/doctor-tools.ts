import type { LanguageId, StageId } from "@tjalve/aiq/model";

export const doctorPrerequisites = [
  {
    binaries: ["node"],
    install: "Install Node.js 24 or newer from your normal Node version manager.",
    minimumMajor: 24,
    required: true,
    name: "Node.js runtime",
  },
  {
    binaries: ["npm"],
    install: "Install npm with Node.js, or use the package manager configured for this project.",
    required: false,
    name: "npm package manager",
  },
  {
    binaries: ["git"],
    install: "Install Git from your OS package manager or git-scm.com.",
    required: false,
    name: "Git",
  },
] as const satisfies readonly DoctorPrerequisite[];

export interface DoctorPrerequisite {
  binaries: readonly string[];
  install: string;
  minimumMajor?: number;
  name: string;
  required: boolean;
}

interface DoctorToolRequirement extends DoctorPrerequisite {
  source: "external";
}

interface DoctorBundledTool {
  detail: string;
  name: string;
  source: "bundled" | "project";
}

export function resolveDoctorToolRequirements(
  languages: ReadonlySet<LanguageId>,
  stages: readonly StageId[],
): DoctorToolRequirement[] {
  const requirements = new Map<string, DoctorToolRequirement>();
  const selected = new Set(stages);

  const addRequirement = (requirement: DoctorToolRequirement) => {
    requirements.set(requirement.name, requirement);
  };

  if (
    languages.has("python") &&
    usesAnyStage(selected, [
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
    ])
  ) {
    addRequirement({
      binaries: ["python3", "python"],
      install: "Install Python 3 and project Python tools such as ruff, ty, pytest, and radon.",
      name: "Python runtime",
      required: true,
      source: "external",
    });
  }

  if (
    languages.has("go") &&
    usesAnyStage(selected, [
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
    ])
  ) {
    addRequirement({
      binaries: ["go"],
      install: "Install the Go toolchain from your normal toolchain manager.",
      name: "Go toolchain",
      required: true,
      source: "external",
    });
  }

  if (
    languages.has("rust") &&
    usesAnyStage(selected, [
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
    ])
  ) {
    addRequirement({
      binaries: ["cargo"],
      install: "Install Rust and Cargo with rustup or your normal toolchain manager.",
      name: "Rust Cargo",
      required: true,
      source: "external",
    });
  }

  if (
    languages.has("dotnet") &&
    usesAnyStage(selected, [
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
    ])
  ) {
    addRequirement({
      binaries: ["dotnet"],
      install: "Install the .NET SDK for this project.",
      name: ".NET SDK",
      required: true,
      source: "external",
    });
  }

  if (
    (languages.has("java") || languages.has("kotlin")) &&
    usesAnyStage(selected, [
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
      "maintainability",
      "coverage",
    ])
  ) {
    addRequirement({
      binaries: ["java"],
      install: "Install a JVM runtime and the project build tool wrapper or Maven/Gradle.",
      name: "JVM runtime",
      required: true,
      source: "external",
    });
  }

  if (
    (languages.has("terraform") || languages.has("hcl")) &&
    usesAnyStage(selected, ["lint", "format", "typecheck"])
  ) {
    addRequirement({
      binaries: ["terraform"],
      install: "Install Terraform CLI to enable Terraform/HCL lint, format, and validation.",
      name: "Terraform CLI",
      required: true,
      source: "external",
    });
  }

  if (
    languages.has("powershell") &&
    usesAnyStage(selected, ["lint", "format", "unit", "coverage"])
  ) {
    addRequirement({
      binaries:
        process.platform === "win32"
          ? ["pwsh.exe", "pwsh", "powershell.exe", "powershell"]
          : ["pwsh"],
      install: "Install PowerShell 7 (pwsh) and project PowerShell modules.",
      name: "PowerShell runtime",
      required: true,
      source: "external",
    });
  }

  if (usesAnyStage(selected, ["sloc", "complexity", "maintainability"])) {
    const lizardLanguages: LanguageId[] = [
      "javascript",
      "typescript",
      "go",
      "rust",
      "dotnet",
      "java",
      "kotlin",
    ];
    if (lizardLanguages.some((language) => languages.has(language))) {
      addRequirement({
        binaries: ["lizard"],
        install: "Install lizard where AIQ runs to enable non-Python metrics stages.",
        name: "Lizard metrics tool",
        required: true,
        source: "external",
      });
    }
  }

  return [...requirements.values()];
}

export function resolveDoctorBundledTools(
  languages: ReadonlySet<LanguageId>,
  stages: readonly StageId[],
): DoctorBundledTool[] {
  const selected = new Set(stages);
  const checks = new Map<string, DoctorBundledTool>();
  const add = (tool: DoctorBundledTool) => {
    checks.set(tool.name, tool);
  };

  if (
    (languages.has("javascript") || languages.has("typescript")) &&
    usesAnyStage(selected, ["lint", "format"])
  ) {
    add({
      detail: "provided by the @tjalve/aiq package dependency graph",
      name: "Biome JS/TS lint/format tool",
      source: "bundled",
    });
  }

  if (languages.has("typescript") && selected.has("typecheck")) {
    add({
      detail: "provided by the @tjalve/aiq package dependency graph",
      name: "TypeScript compiler",
      source: "bundled",
    });
  }

  if (
    usesAnyStage(selected, ["unit", "coverage"]) &&
    (languages.has("javascript") || languages.has("typescript"))
  ) {
    add({
      detail: "uses the project's configured npm test runner when present",
      name: "JS/TS test runner",
      source: "project",
    });
  }

  if (
    usesAnyStage(selected, ["lint", "format"]) &&
    (languages.has("html") || languages.has("css") || languages.has("yaml") || languages.has("sql"))
  ) {
    add({
      detail: "provided by the @tjalve/aiq package dependency graph",
      name: "Bundled web/data document tools",
      source: "bundled",
    });
  }

  if (selected.has("security") && languages.size > 0) {
    add({
      detail: "provided by the @tjalve/aiq package runtime",
      name: "AIQ shared security scanner",
      source: "bundled",
    });
  }

  return [...checks.values()];
}

export function mergeDoctorPrerequisites(
  prerequisites: readonly DoctorPrerequisite[],
  requirements: readonly DoctorToolRequirement[],
): Array<DoctorPrerequisite | DoctorToolRequirement> {
  const merged = new Map<string, DoctorPrerequisite | DoctorToolRequirement>();
  for (const prerequisite of prerequisites) {
    merged.set(prerequisite.name, prerequisite);
  }

  for (const requirement of requirements) {
    merged.set(requirement.name, requirement);
  }

  return [...merged.values()];
}

function usesAnyStage(selected: ReadonlySet<StageId>, stages: readonly StageId[]): boolean {
  return stages.some((stage) => selected.has(stage));
}

