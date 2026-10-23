import {
  createCargoClippyArgs,
  createCargoFmtArgs,
  createCargoLlvmCovArgs,
  createDotNetFormatArgs,
  lizardVersion,
  powerShellCommands,
} from "@tjalve/aiq/engine";
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
  pinnedVersion?: string;
  name: string;
  pythonModule?: string;
  source?: "external" | "project";
  versionArgs?: readonly string[];
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

const toolchainStages: StageId[] = ["lint", "format", "typecheck", "unit", "coverage"];

const doctorToolRequirementRules: Array<{
  languages: readonly LanguageId[];
  requirement: DoctorToolRequirement;
  stages: readonly StageId[];
}> = [
  {
    languages: ["python"],
    requirement: {
      binaries: [process.platform === "win32" ? "python" : "python3"],
      install: "Install Python 3 and project Python tools such as ruff, ty, pytest, and radon.",
      name: "Python runtime",
      required: true,
      source: "external",
    },
    stages: ["typecheck", "unit", "sloc", "complexity", "maintainability", "coverage"],
  },
  {
    languages: ["python"],
    requirement: {
      binaries: ["ruff"],
      install: "Install Ruff on PATH to enable Python lint and format checks.",
      name: "Ruff",
      required: true,
      source: "external",
    },
    stages: ["lint", "format"],
  },
  {
    languages: ["python"],
    requirement: {
      binaries: [],
      install: "Install Radon in the Python interpreter used by Quality.",
      name: "Radon",
      pythonModule: "radon",
      required: true,
      source: "external",
    },
    stages: ["sloc", "complexity", "maintainability"],
  },
  {
    languages: ["python"],
    requirement: {
      binaries: ["ty"],
      install: "Install Astral ty on PATH to enable Python type checks.",
      name: "ty",
      required: true,
      source: "external",
    },
    stages: ["typecheck"],
  },
  {
    languages: ["python"],
    requirement: {
      binaries: [],
      install: "Install pytest in the Python interpreter used by Quality.",
      name: "pytest",
      pythonModule: "pytest",
      required: true,
      source: "external",
    },
    stages: ["unit", "coverage"],
  },
  {
    languages: ["python"],
    requirement: {
      binaries: [],
      install: "Install pytest-cov in the Python interpreter used by Quality.",
      name: "pytest-cov",
      pythonModule: "pytest_cov",
      required: true,
      source: "external",
    },
    stages: ["coverage"],
  },
  {
    languages: ["bash"],
    requirement: {
      binaries: ["shellcheck"],
      install: "Install ShellCheck on PATH to enable Shell lint checks.",
      name: "ShellCheck",
      required: true,
      source: "external",
    },
    stages: ["lint"],
  },
  {
    languages: ["bash"],
    requirement: {
      binaries: ["shfmt"],
      install: "Install shfmt on PATH to enable Shell format checks.",
      name: "shfmt",
      required: true,
      source: "external",
    },
    stages: ["format"],
  },
  {
    languages: ["bash"],
    requirement: {
      binaries: ["bats"],
      install: "Install Bats on PATH to enable Shell test checks.",
      name: "Bats",
      required: true,
      source: "external",
    },
    stages: ["unit", "coverage"],
  },
  {
    languages: ["bash"],
    requirement: {
      binaries: ["kcov"],
      install: "Install kcov on PATH to enable Shell coverage checks.",
      name: "kcov",
      required: true,
      source: "external",
    },
    stages: ["coverage"],
  },
  {
    languages: ["go"],
    requirement: {
      binaries: ["go"],
      install: "Install the Go toolchain from your normal toolchain manager.",
      name: "Go toolchain",
      required: true,
      source: "external",
      versionArgs: ["version"],
    },
    stages: toolchainStages,
  },
  {
    languages: ["go"],
    requirement: {
      binaries: ["gofmt"],
      install: "Install gofmt with the Go toolchain to enable Go format checks.",
      name: "gofmt",
      required: true,
      source: "external",
      versionArgs: ["-h"],
    },
    stages: ["format"],
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
  ...[
    {
      languages: ["rust"] as const,
      stages: ["lint"] as const,
      name: "Rust Clippy",
      binary: "cargo",
      args: createCargoClippyArgs(),
      install: "Install the Clippy component for the Rust toolchain used by Cargo.",
    },
    {
      languages: ["rust"] as const,
      stages: ["format"] as const,
      name: "Rust rustfmt",
      binary: "cargo",
      args: createCargoFmtArgs(),
      install: "Install the rustfmt component for the Rust toolchain used by Cargo.",
    },
    {
      languages: ["rust"] as const,
      stages: ["coverage"] as const,
      name: "cargo-llvm-cov",
      binary: "cargo",
      args: createCargoLlvmCovArgs(),
      install: "Install cargo-llvm-cov for the Rust toolchain used by Cargo.",
    },
    {
      languages: ["dotnet"] as const,
      stages: ["lint", "format"] as const,
      name: ".NET format",
      binary: "dotnet",
      args: createDotNetFormatArgs({ reportDir: "", subcommand: "style", targetPath: "" }),
      install: "Install a .NET SDK with the dotnet format command.",
    },
  ].map(({ languages, stages, name, binary, args, install }) => ({
    languages,
    stages,
    requirement: {
      binaries: [binary],
      install,
      name,
      required: true,
      source: "external" as const,
      versionArgs: [...args.slice(0, 1), "--version"],
    },
  })),
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
    languages: ["terraform"],
    requirement: {
      binaries: ["terraform"],
      install: "Install Terraform CLI to enable Terraform/HCL lint, format, and validation.",
      name: "Terraform CLI",
      required: true,
      source: "external",
    },
    stages: ["lint", "format", "typecheck"],
  },
  {
    languages: ["hcl"],
    requirement: {
      binaries: ["terraform"],
      install: "Install Terraform CLI to enable HCL lint and format checks.",
      name: "Terraform CLI",
      required: true,
      source: "external",
    },
    stages: ["lint", "format"],
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
      binaries: powerShellCommands,
      install: "Install PowerShell 7 (pwsh) and project PowerShell modules.",
      name: "PowerShell runtime",
      required: true,
      source: "external",
      versionArgs: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$PSVersionTable.PSVersion.ToString()",
      ],
    });
    addPowerShellModuleRequirements(requirements, selected);
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
        binaries: [process.platform === "win32" ? "uvx.exe" : "uvx"],
        install: `Install uv with uvx on PATH to provision Lizard ${lizardVersion} for shared metrics.`,
        name: "Lizard metrics tool",
        pinnedVersion: lizardVersion,
        required: true,
        source: "external",
      });
    }
  }

  return [...requirements.values()];
}

function addPowerShellModuleRequirements(
  requirements: Map<string, DoctorToolRequirement>,
  selected: ReadonlySet<StageId>,
): void {
  const modules: Array<{ name: string; stages: StageId[] }> = [
    { name: "PSScriptAnalyzer", stages: ["lint", "format"] },
    { name: "Pester", stages: ["unit", "coverage"] },
  ];
  for (const module of modules) {
    if (!usesAnyStage(selected, module.stages)) {
      continue;
    }
    requirements.set(module.name, {
      binaries: powerShellCommands,
      install: `Install the ${module.name} module for the PowerShell runtime used by Quality.`,
      name: module.name,
      required: true,
      source: "external",
      versionArgs: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference = 'Stop'; Import-Module ${module.name}; $module = Get-Module ${module.name}; Write-Output ($module.Path + '; ' + $module.Version)`,
      ],
    });
  }
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
