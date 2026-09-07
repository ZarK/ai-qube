import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export type AiuHookWorkspaceResolution =
  | { readonly ok: true; readonly cwd: string }
  | { readonly ok: false; readonly code: "untrusted-hook-cwd"; readonly error: string };

export function resolveTrustedHookWorkspace(
  invocationCwd: string | undefined,
  payloadCwd: string | undefined,
  workspaceRoots: readonly string[] | undefined,
): AiuHookWorkspaceResolution {
  const trustedRoot = path.resolve(invocationCwd ?? process.cwd());
  if (workspaceRoots !== undefined) {
    if (workspaceRoots.length !== 1) {
      return { ok: false, code: "untrusted-hook-cwd", error: "Stop hook workspace roots must identify exactly one repository." };
    }
    const workspaceRoot = workspaceRoots[0]!;
    if (!path.isAbsolute(workspaceRoot)) {
      return { ok: false, code: "untrusted-hook-cwd", error: "Stop hook workspace root must be absolute." };
    }
    if (!isTrustedPath(workspaceRoot, trustedRoot)) {
      return { ok: false, code: "untrusted-hook-cwd", error: "Stop hook workspace root is outside the invocation repository." };
    }
  }
  if (payloadCwd !== undefined && payloadCwd.length > 0 && !isTrustedPath(payloadCwd, trustedRoot)) {
    return { ok: false, code: "untrusted-hook-cwd", error: "Stop hook cwd is outside the invocation repository." };
  }
  return { ok: true, cwd: trustedRoot };
}

function isTrustedPath(candidate: string, trustedRoot: string): boolean {
  const requested = path.resolve(candidate);
  if (!isSameOrChildPath(requested, trustedRoot)) return false;
  if (!existsSync(requested) || !existsSync(trustedRoot)) return true;
  try {
    return isSameOrChildPath(realpathSync(requested), realpathSync(trustedRoot));
  } catch {
    return false;
  }
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate.startsWith(prefix);
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  if (process.platform === "win32" && /^[A-Za-z]:/u.test(resolved)) return resolved[0]!.toLowerCase() + resolved.slice(1);
  return resolved;
}
