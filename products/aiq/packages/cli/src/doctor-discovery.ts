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
  switch (fileName) {
    case "Cargo.toml":
      languages.add("rust");
      return;
    case "go.mod":
      languages.add("go");
      return;
    case "package.json":
      languages.add("javascript");
      return;
    case "pyproject.toml":
    case "requirements.txt":
      languages.add("python");
      return;
    case "tsconfig.json":
      languages.add("typescript");
      return;
    case "pom.xml":
    case "build.gradle":
    case "build.gradle.kts":
    case "settings.gradle":
    case "settings.gradle.kts":
      languages.add("java");
      return;
  }
}

function addDetectedLanguages(fileName: string, languages: Set<LanguageId>): void {
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".bash":
    case ".bats":
    case ".sh":
      languages.add("bash");
      return;
    case ".cjs":
    case ".js":
    case ".jsx":
    case ".mjs":
      languages.add("javascript");
      return;
    case ".css":
      languages.add("css");
      return;
    case ".cs":
    case ".csproj":
    case ".fsproj":
    case ".sln":
    case ".slnx":
    case ".vbproj":
      languages.add("dotnet");
      return;
    case ".go":
      languages.add("go");
      return;
    case ".hcl":
      languages.add("hcl");
      return;
    case ".htm":
    case ".html":
      languages.add("html");
      return;
    case ".java":
      languages.add("java");
      return;
    case ".kt":
    case ".kts":
      languages.add("kotlin");
      return;
    case ".ps1":
    case ".psd1":
    case ".psm1":
      languages.add("powershell");
      return;
    case ".py":
    case ".pyi":
      languages.add("python");
      return;
    case ".rs":
      languages.add("rust");
      return;
    case ".sql":
      languages.add("sql");
      return;
    case ".tf":
    case ".tfvars":
      languages.add("terraform");
      return;
    case ".ts":
    case ".tsx":
    case ".cts":
    case ".mts":
      languages.add("typescript");
      return;
    case ".yaml":
    case ".yml":
      languages.add("yaml");
      return;
  }
}

export function formatDetectedLanguages(languages: ReadonlySet<LanguageId>): string[] {
  return doctorLanguageOrder
    .filter((language) => languages.has(language))
    .map((language) => doctorLanguageLabels[language]);
}

