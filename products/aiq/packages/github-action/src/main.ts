import * as artifact from "@actions/artifact";
import * as core from "@actions/core";
import { type AiqProfileName, type GitHubAnnotation, aiqProfileNames } from "@tjalve/aiq/api";

import {
  type AiqGitHubActionRunOptions,
  parseGitHubActionStageInput,
  parsePositiveInteger,
  runAiqGitHubAction,
} from "./index.js";

async function main(): Promise<void> {
  try {
    const artifactClient = new artifact.DefaultArtifactClient();
    const options = readActionInputs();
    await runAiqGitHubAction(
      {
        emitAnnotation(annotation: GitHubAnnotation) {
          const properties = toAnnotationProperties(annotation);
          switch (annotation.level) {
            case "error": {
              core.error(annotation.message, properties);
              return;
            }
            case "warning": {
              core.warning(annotation.message, properties);
              return;
            }
            default: {
              core.notice(annotation.message, properties);
            }
          }
        },
        info(message: string) {
          core.info(message);
        },
        setFailed(message: string) {
          core.setFailed(message);
        },
        setOutput(name: string, value: string | number | boolean) {
          core.setOutput(name, value);
        },
        uploadArtifact(name: string, files: string[], rootDirectory: string) {
          return artifactClient.uploadArtifact(name, files, rootDirectory);
        },
      },
      options,
    );
  } catch (error) {
    core.setFailed(formatError(error));
  }
}

await main();

function readActionInputs(): AiqGitHubActionRunOptions {
  const files = core.getMultilineInput("files");
  const stages = parseGitHubActionStageInput(core.getMultilineInput("stages"));
  const profile = parseProfile(core.getInput("profile"));
  const filesFrom = emptyToUndefined(core.getInput("files-from"));
  const outDir = emptyToUndefined(core.getInput("out-dir"));
  const artifactName = emptyToUndefined(core.getInput("artifact-name"));
  const maxAnnotations = parsePositiveInteger(core.getInput("max-annotations"), "max-annotations");

  return {
    annotate: core.getBooleanInput("annotate"),
    ...(artifactName === undefined ? {} : { artifactName }),
    cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    ...(files.length === 0 ? {} : { files }),
    ...(filesFrom === undefined ? {} : { filesFrom }),
    ...(maxAnnotations === undefined ? {} : { maxAnnotations }),
    ...(outDir === undefined ? {} : { outDir }),
    ...(stages.length === 0 ? {} : { stages }),
    ...(profile === undefined ? {} : { profile }),
    uploadArtifact: core.getBooleanInput("upload-artifact"),
  };
}

function parseProfile(value: string): AiqProfileName | undefined {
  const normalized = emptyToUndefined(value);
  if (normalized === undefined) {
    return undefined;
  }

  if (!aiqProfileNames.includes(normalized as AiqProfileName)) {
    throw new Error(`Unsupported profile: ${normalized}`);
  }

  return normalized as AiqProfileName;
}

function emptyToUndefined(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function toAnnotationProperties(annotation: GitHubAnnotation): {
  endColumn?: number;
  endLine?: number;
  file?: string;
  startColumn?: number;
  startLine?: number;
  title?: string;
} {
  const properties: {
    endColumn?: number;
    endLine?: number;
    file?: string;
    startColumn?: number;
    startLine?: number;
    title?: string;
  } = {
    title: annotation.title,
  };

  if (annotation.file !== undefined) {
    properties.file = annotation.file;
  }
  if (annotation.startLine !== undefined) {
    properties.startLine = annotation.startLine;
  }
  if (annotation.startColumn !== undefined) {
    properties.startColumn = annotation.startColumn;
  }
  if (annotation.endLine !== undefined) {
    properties.endLine = annotation.endLine;
  }
  if (annotation.endColumn !== undefined) {
    properties.endColumn = annotation.endColumn;
  }

  return properties;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
