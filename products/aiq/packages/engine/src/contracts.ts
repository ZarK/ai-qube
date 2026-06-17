import type { FileManifest, ResolvedRunRequest, StageId } from "@tjalve/aiq/model";

export * from "@tjalve/aiq/model";

export const engineVersion = "0.0.0";

/**
 * Ecosystem types supported by the engine.
 */
export type Ecosystem =
  | "go"
  | "rust"
  | "jvm"
  | "python"
  | "javascript"
  | "typescript"
  | "terraform"
  | "shell"
  | "dotnet"
  | "unknown";

/**
 * Metadata for a project, such as version, name, and specific configuration.
 */
export interface ProjectMetadata {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Describes a logical project discovered within the workspace.
 */
export interface ProjectDescriptor {
  id: string;
  name: string;
  root: string;
  ecosystem: Ecosystem;
  language: string;
  manifestFiles: string[];
  sourceFiles: string[];
  metadata: ProjectMetadata;
}

/**
 * A collection of resolved projects and their relationships.
 */
export interface ProjectGraph {
  fileToProjectIds: Record<string, string[]>;
  projects: ProjectDescriptor[];
  root: string;
  version: string;
}

/**
 * Interface for the centralized cache service.
 */
export interface CacheService {
  deleteByPrefix(prefix: string, exceptKeys?: readonly string[]): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  getOrCreate<T>(
    key: string,
    createValue: () => Promise<T>,
  ): Promise<{ cacheHit: boolean; value: T }>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  generateKey(parts: string[]): string;
}

/**
 * Extended context for an engine run including the project graph and cache.
 */
export interface EngineContext extends ResolvedRunRequest {
  graph: ProjectGraph;
  cache: CacheService;
}
