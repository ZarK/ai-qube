import type { JsonValue } from "@tjalve/qube-core";
import type { GitLabMergeRequest, GitLabMetadata, GitLabNote, GitLabUser } from "./gitlab_review_types.js";

const METADATA_PREFIX = "QUBE_REVIEW_METADATA ";

export function userName(user: GitLabUser | null | undefined): string {
  return user?.username ?? user?.name ?? "gitlab";
}

export function reviewerId(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "reviewer";
}

export function normalizeHandle(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "@reviewer";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

export function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonValue(entry)]));
  return null;
}

export function noteMetadata(note: GitLabNote): GitLabMetadata | null {
  const line = note.body.split(/\r?\n/).find(candidate => candidate.startsWith(METADATA_PREFIX));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(METADATA_PREFIX.length)) as Partial<GitLabMetadata>;
    if (parsed.version !== 1 || (parsed.kind !== "review-request" && parsed.kind !== "lane-review") || typeof parsed.head !== "string") return null;
    return parsed as GitLabMetadata;
  } catch {
    return null;
  }
}

export function metadataLine(metadata: GitLabMetadata): string {
  return `${METADATA_PREFIX}${JSON.stringify(metadata)}`;
}

export function headSha(mr: GitLabMergeRequest): string {
  return mr.sha ?? mr.merge_commit_sha ?? mr.squash_commit_sha ?? "UNKNOWN";
}

export function displayId(iid: number | string): string {
  return `!${iid}`;
}
