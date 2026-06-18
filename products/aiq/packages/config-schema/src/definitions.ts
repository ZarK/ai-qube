import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type LanguageId,
  type RunStageConfigurations,
  type StageId,
  type SurfaceId,
  languageIds,
  stageIds,
  surfaceIds,
} from "@tjalve/aiq/model";

export const aiqConfigFileNames = [".aiq/aiq.config.json", "aiq.config.json"] as const;
export const aiqProgressFileName = ".aiq/progress.json" as const;

export const aiqProfileNames = ["fast", "standard", "deep"] as const;

export type AiqProfileName = (typeof aiqProfileNames)[number];

export const aiqStageIds = stageIds;

export type AiqStageId = StageId;

export const aiqLanguageIds = languageIds;

export type AiqLanguageId = LanguageId;

export const aiqSurfaceIds = surfaceIds;

export type AiqSurfaceId = SurfaceId;

export const aiqProgressStageIndexes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type AiqProgressStageIndex = (typeof aiqProgressStageIndexes)[number];

export const aiqStageLadderIds = [
  "e2e",
  "lint",
  "format",
  "typecheck",
  "unit",
  "sloc",
  "complexity",
  "maintainability",
  "coverage",
  "security",
] as const satisfies readonly AiqStageId[];

export const aiqToolIds = [
  "bash",
  "biome",
  "css",
  "documents",
  "dotnet",
  "go",
  "html",
  "javascript",
  "jvm",
  "powershell",
  "python",
  "rust",
  "security",
  "sql",
  "terraform",
  "typescript",
  "yaml",
] as const;

export type AiqToolId = (typeof aiqToolIds)[number];

export interface AiqProfileConfig {
  changedOnly: boolean;
  stages: AiqStageId[];
}

export interface AiqStageLanguageConfig {
  enabled: boolean;
  tool: AiqToolId;
}

export interface AiqStageConfig {
  enabled: boolean;
  languages: Partial<Record<AiqLanguageId, AiqStageLanguageConfig>>;
}

export interface AiqStageConfigFile {
  enabled?: boolean;
  languages?: Partial<Record<AiqLanguageId, AiqStageLanguageConfig>>;
}

export interface AiqInputsConfig {
  ignore: string[];
}

export interface AiqSurfaceConfig {
  cadenceMs?: number;
  cadenceStages?: AiqStageId[];
  changedOnly?: boolean;
  stages?: AiqStageId[];
  profile: AiqProfileName;
  publishDiagnostics?: boolean;
}

export interface AiqConfig {
  version: 1;
  inputs: AiqInputsConfig;
  stages: Record<AiqStageId, AiqStageConfig>;
  profiles: Record<AiqProfileName, AiqProfileConfig>;
  surfaces: Record<AiqSurfaceId, AiqSurfaceConfig>;
}

export interface AiqConfigFile {
  $schema?: string;
  version: 1;
  inputs?: Partial<AiqInputsConfig>;
  stages?: Partial<Record<AiqStageId, AiqStageConfigFile>>;
  profiles?: Partial<Record<AiqProfileName, Partial<AiqProfileConfig>>>;
  surfaces?: Partial<Record<AiqSurfaceId, Partial<AiqSurfaceConfig>>>;
}

export interface LoadedAiqConfig {
  config?: AiqConfigFile;
  path?: string;
}

export interface AiqProgressState {
  current_stage: AiqProgressStageIndex;
  disabled: AiqProgressStageIndex[];
  order: AiqProgressStageIndex[];
  last_run: string | null;
}

export interface LoadedAiqProgress {
  path: string;
  progress: AiqProgressState;
  source: "defaults" | "file";
}

export interface AiqWorkflowStage {
  id: AiqStageId;
  index: number;
  name: AiqStageId;
}

export interface AiqProgressRunSelection {
  currentStage: AiqWorkflowStage;
  defaultRun: {
    range: string;
    stages: AiqWorkflowStage[];
  };
  progressPath: string;
  progressSource: "defaults" | "file";
  selectedStages: AiqStageId[];
}

export interface InitializedAiqProjectConfig {
  configCreated: boolean;
  configPath: string;
  progressCreated: boolean;
  progressPath: string;
}

export interface ResolveAiqConfigOptions {
  cwd?: string;
  stages?: readonly AiqStageId[];
  profile?: AiqProfileName;
  surface: AiqSurfaceId;
}

export interface ResolvedAiqConfig {
  cadenceMs?: number;
  cadenceStages: AiqStageId[];
  changedOnly: boolean;
  config: AiqConfig;
  configPath?: string;
  cwd: string;
  stages: AiqStageId[];
  stageConfigurations?: RunStageConfigurations;
  profile: AiqProfileName;
  publishDiagnostics: boolean;
  source: "defaults" | "file";
  surface: AiqSurfaceId;
}

const defaultStageLanguageTools: Record<AiqStageId, Partial<Record<AiqLanguageId, AiqToolId>>> = {
  lint: {
    javascript: "biome",
    typescript: "biome",
    python: "python",
    terraform: "terraform",
    hcl: "terraform",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    bash: "bash",
    powershell: "powershell",
    html: "html",
    css: "css",
    yaml: "yaml",
    sql: "sql",
  },
  format: {
    javascript: "biome",
    typescript: "biome",
    terraform: "terraform",
    hcl: "terraform",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    python: "python",
    bash: "bash",
    powershell: "powershell",
    html: "documents",
    css: "documents",
    yaml: "documents",
    sql: "sql",
  },
  typecheck: {
    terraform: "terraform",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    typescript: "typescript",
    python: "python",
  },
  unit: {
    bash: "bash",
    powershell: "powershell",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    javascript: "javascript",
    typescript: "javascript",
    python: "python",
  },
  e2e: {
    javascript: "javascript",
    typescript: "javascript",
  },
  sloc: {
    javascript: "javascript",
    typescript: "javascript",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    python: "python",
  },
  complexity: {
    javascript: "javascript",
    typescript: "javascript",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    python: "python",
  },
  maintainability: {
    javascript: "javascript",
    typescript: "javascript",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    python: "python",
  },
  coverage: {
    bash: "bash",
    powershell: "powershell",
    go: "go",
    rust: "rust",
    dotnet: "dotnet",
    java: "jvm",
    kotlin: "jvm",
    javascript: "javascript",
    typescript: "javascript",
    python: "python",
  },
  security: Object.fromEntries(
    aiqLanguageIds.map((languageId) => [languageId, "security"]),
  ) as Partial<Record<AiqLanguageId, AiqToolId>>,
};

export const supportedStageToolIds: Record<AiqStageId, readonly AiqToolId[]> = aiqStageIds.reduce(
  (accumulator, stageId) => {
    accumulator[stageId] = [...new Set(Object.values(defaultStageLanguageTools[stageId]))].sort();
    return accumulator;
  },
  {} as Record<AiqStageId, readonly AiqToolId[]>,
);

export const defaultConfig: AiqConfig = {
  version: 1,
  inputs: {
    ignore: ["node_modules/**", ".git/**", ".venv/**", "dist/**", "build/**"],
  },
  stages: Object.fromEntries(
    aiqStageIds.map((stageId) => [stageId, createDefaultStageConfig(stageId)]),
  ) as Record<AiqStageId, AiqStageConfig>,
  profiles: {
    fast: {
      changedOnly: true,
      stages: ["lint"],
    },
    standard: {
      changedOnly: false,
      stages: ["lint", "typecheck", "unit"],
    },
    deep: {
      changedOnly: false,
      stages: ["lint", "typecheck", "unit", "coverage", "security"],
    },
  },
  surfaces: {
    cli: {
      profile: "fast",
    },
    hook: {
      profile: "fast",
    },
    github: {
      profile: "deep",
      publishDiagnostics: true,
    },
    opencode: {
      profile: "fast",
      publishDiagnostics: true,
    },
    lsp: {
      profile: "fast",
      publishDiagnostics: true,
    },
    mcp: {
      profile: "fast",
    },
    watch: {
      profile: "fast",
    },
    serve: {
      profile: "standard",
    },
  },
};

export const defaultProgressState: AiqProgressState = {
  current_stage: 1,
  disabled: [],
  order: [...aiqProgressStageIndexes],
  last_run: null,
};

function createDefaultStageConfig(stageId: AiqStageId): AiqStageConfig {
  return {
    enabled: true,
    languages: Object.fromEntries(
      Object.entries(defaultStageLanguageTools[stageId]).map(([languageId, tool]) => [
        languageId,
        { enabled: true, tool },
      ]),
    ) as Partial<Record<AiqLanguageId, AiqStageLanguageConfig>>,
  };
}
