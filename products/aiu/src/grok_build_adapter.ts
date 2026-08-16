import { createRequire } from "node:module";

const requireAdapter = createRequire(import.meta.url);

export interface GrokBuildStopHookFile {
  readonly relativePath: string;
  readonly description: string;
  readonly content: string;
}

export interface GrokBuildStopPayload {
  readonly cwd?: string;
  readonly hook_event_name?: string;
  readonly session_id?: string;
  readonly stop_hook_active?: boolean;
  readonly last_assistant_message?: string | null;
  readonly permission_mode?: string;
  readonly reason?: string;
}

export interface GrokBuildAdapterModule {
  readonly grokBuildStopHookFile: GrokBuildStopHookFile;
  parseGrokStopPayload(parsed: Record<string, unknown>): { readonly ok: true; readonly payload: GrokBuildStopPayload } | { readonly ok: false; readonly error: string };
  isGrokSessionEndReason(reason: string | undefined): boolean;
}

function isModuleMissing(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error.message.replace(/\\/g, "/");
  const needle = packageName.replace(/\\/g, "/");
  if (!message.includes(needle)) return false;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || /cannot find package|cannot find module/i.test(message);
}

let omitGrokBuildAdapter = false;

export function omitGrokBuildAdapterForTests(): void {
  omitGrokBuildAdapter = true;
}

export function resetGrokBuildAdapterForTests(): void {
  omitGrokBuildAdapter = false;
}

export function loadGrokBuildAdapter(): GrokBuildAdapterModule | null {
  if (omitGrokBuildAdapter) return null;
  try {
    return requireAdapter("@tjalve/qube-adapter-grok-build") as GrokBuildAdapterModule;
  } catch (error) {
    if (isModuleMissing(error, "@tjalve/qube-adapter-grok-build")) return null;
    throw error;
  }
}
