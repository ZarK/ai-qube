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

const toolchainStages: StageId[] = [
  "lint",
  "format",
  "typecheck",
  "unit",
  "sloc",
  "complexity",
  "maintainability",
  "coverage",
];

const doctorToolRequirementRules: Array<{
  languages: readonly LanguageId[];
  requirement: DoctorToolRequirement;
  stages: readonly StageId[];
}> = [
  {
    languages: ["python"],
    requirement: {
      binaries: ["python3", "python"],
      install: "Install Python 3 and project Python tools such as ruff, ty, pytest, and radon.",
      name: "Python runtime",
      required: true,
      source: "external",
    },
    stages: toolchainStages,
  },
  {
    languages: ["go"],
    requirement: {
      binaries: ["go"],
      install: "Install the Go toolchain from your normal toolchain manager.",
      name: "Go toolchain",
      required: true,
      source: "external",
    },
    stages: toolchainStages,
  },
  {
    languages: ["rust"],
    requirement: {
      binaries: ["cargo"],
      install: "Install Rust and Cargo with rustup or your normal toolchain manager.",
      name: "Rust Cargo",
      required: true,
      source: "external",
    },
    stages: toolchainStages,
  },
  {
    languages: ["dotnet"],
    requirement: {
      binaries: ["dotnet"],
      install: "Install the .NET SDK for this project.",
      name: ".NET SDK",
      required: true,
      source: "external",
    },
    stages: toolchainStages,
  },
  {
    languages: ["java", "kotlin"],
    requirement: {
      binaries: ["java"],
      install: "Install a JVM runtime and the project build tool wrapper or Maven/Gradle.",
      name: "JVM runtime",
      required: true,
      source: "external",
    },
    stages: toolchainStages,
  },
  {
    languages: ["terraform", "hcl"],
    requirement: {
      binaries: ["terraform"],
      install: "Install Terraform CLI to enable Terraform/HCL lint, format, and validation.",
      name: "Terraform CLI",
      required: true,
      source: "external",
    },
    stages: ["lint", "format", "typecheck"],
  },
];

const bundledToolRules: Array<{
  applies: (languages: ReadonlySet<LanguageId>, selected: ReadonlySet<StageId>) => boolean;
  tool: DoctorBundledTool;
}> = [
  {
    applies: (languages, selected) =>
      usesAnyLanguage(languages, ["javascript", "typescript"]) &&
      usesAnyStage(selected, ["lint", "format"]),
    tool: {
      detail: "provided by the @tjalve/aiq package dependency graph",
      name: "Biome JS/TS lint/format tool",
      source: "bundled",
    },
  },
  {
    applies: (languages, selected) => languages.has("typescript") && selected.has("typecheck"),
    tool: {
      detail: "provided by the @tjalve/aiq package dependency graph",
      name: "TypeScript compiler",
      source: "bundled",
    },
  },
  {
    applies: (languages, selected) =>
      usesAnyStage(selected, ["unit", "coverage"]) &&
      usesAnyLanguage(languages, ["javascript", "typescript"]),
    tool: {
      detail: "uses the project's configured npm test runner when present",
      name: "JS/TS test runner",
      source: "project",
    },
  },
  {
    applies: (languages, selected) =>
      usesAnyStage(selected, ["lint", "format"]) &&
      usesAnyLanguage(languages, ["html", "css", "yaml", "sql"]),
    tool: {
      detail: "provided by the @tjalve/aiq package dependency graph",
      name: "Bundled web/data document tools",
      source: "bundled",
    },
  },
  {
    applies: (languages, selected) => selected.has("security") && languages.size > 0,
    tool: {
      detail: "provided by the @tjalve/aiq package runtime",
      name: "AIQ shared security scanner",
      source: "bundled",
    },
  },
];

export function resolveDoctorToolRequirements(
  languages: ReadonlySet<LanguageId>,
  stages: readonly StageId[],
): DoctorToolRequirement[] {
  const requirements = new Map<string, DoctorToolRequirement>();
  const selected = new Set(stages);

  for (const rule of doctorToolRequirementRules) {
    if (usesAnyLanguage(languages, rule.languages) && usesAnyStage(selected, rule.stages)) {
      requirements.set(rule.requirement.name, rule.requirement);
    }
  }

  if (
    languages.has("powershell") &&
    usesAnyStage(selected, ["lint", "format", "unit", "coverage"])
  ) {
    requirements.set("PowerShell runtime", {
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
      requirements.set("Lizard metrics tool", {
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
  for (const rule of bundledToolRules) {
    if (rule.applies(languages, selected)) {
      checks.set(rule.tool.name, rule.tool);
    }
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

function usesAnyLanguage(
  languages: ReadonlySet<LanguageId>,
  candidates: readonly LanguageId[],
): boolean {
  return candidates.some((language) => languages.has(language));
}

