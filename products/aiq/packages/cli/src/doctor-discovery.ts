import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { LanguageId } from "@tjalve/aiq/model";

import { defaultProjectScopeIgnoredDirectoryNames } from "./project-scope.js";

const doctorMaxScannedFiles = 2_000;

const doctorLanguageLabels: Record<LanguageId, string> = {
  bash: "Bash",
  css: "CSS",
  documents: "Documents",
  dotnet: ".NET",
  go: "Go",
  hcl: "HCL",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  kotlin: "Kotlin",
  powershell: "PowerShell",
  python: "Python",
  rust: "Rust",
  sql: "SQL",
  terraform: "Terraform",
  typescript: "TypeScript",
  yaml: "YAML",
};

const doctorLanguageOrder: LanguageId[] = [
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
  "dotnet",
  "java",
  "kotlin",
  "terraform",
  "hcl",
  "bash",
  "powershell",
  "html",
  "css",
  "yaml",
  "sql",
  "documents",
];

const markerLanguageMap: ReadonlyMap<string, LanguageId> = new Map([
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
  ["package.json", "javascript"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["tsconfig.json", "typescript"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["build.gradle.kts", "java"],
  ["settings.gradle", "java"],
  ["settings.gradle.kts", "java"],
]);

const extensionLanguageMap: ReadonlyMap<string, LanguageId> = new Map([
  [".bash", "bash"],
  [".bats", "bash"],
  [".sh", "bash"],
  [".cjs", "javascript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".css", "css"],
  [".cs", "dotnet"],
  [".csproj", "dotnet"],
  [".fsproj", "dotnet"],
  [".sln", "dotnet"],
  [".slnx", "dotnet"],
  [".vbproj", "dotnet"],
  [".go", "go"],
  [".hcl", "hcl"],
  [".htm", "html"],
  [".html", "html"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".ps1", "powershell"],
  [".psd1", "powershell"],
  [".psm1", "powershell"],
  [".py", "python"],
  [".pyi", "python"],
  [".rs", "rust"],
  [".sql", "sql"],
  [".tf", "terraform"],
  [".tfvars", "terraform"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".cts", "typescript"],
  [".mts", "typescript"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);

export async function detectProjectLanguages(cwd: string): Promise<Set<LanguageId>> {
  const languages = new Set<LanguageId>();
  await collectProjectLanguages(cwd, languages, { scannedFiles: 0 });
  return languages;
}

async function collectProjectLanguages(
  directory: string,
  languages: Set<LanguageId>,
  state: { scannedFiles: number },
): Promise<void> {
  if (state.scannedFiles >= doctorMaxScannedFiles) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (state.scannedFiles >= doctorMaxScannedFiles) {
      return;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!defaultProjectScopeIgnoredDirectoryNames.has(entry.name)) {
        await collectProjectLanguages(entryPath, languages, state);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    state.scannedFiles += 1;
    addDetectedLanguages(entry.name, languages);
    addMarkerLanguages(entry.name, languages);
  }
}

function addMarkerLanguages(fileName: string, languages: Set<LanguageId>): void {
  const language = markerLanguageMap.get(fileName);
  if (language !== undefined) {
    languages.add(language);
  }
}

function addDetectedLanguages(fileName: string, languages: Set<LanguageId>): void {
  const language = extensionLanguageMap.get(path.extname(fileName).toLowerCase());
  if (language !== undefined) {
    languages.add(language);
  }
}

export function formatDetectedLanguages(languages: ReadonlySet<LanguageId>): string[] {
  return doctorLanguageOrder
    .filter((language) => languages.has(language))
    .map((language) => doctorLanguageLabels[language]);
}
