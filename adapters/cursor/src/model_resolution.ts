export type CursorModelTransport = "acp" | "cli";

export interface CursorAcpModelOption {
  readonly value: string;
  readonly name: string | null;
}

export interface CursorModelDescriptor {
  readonly displayId: string;
  readonly transport: CursorModelTransport;
  readonly transportValue: string;
  readonly effort: string | null;
  readonly fast: boolean;
}

export interface CursorAcpCatalog {
  readonly version: 1;
  readonly transport: "acp";
  readonly options: readonly CursorAcpModelOption[];
}

interface CursorModelSemantics {
  readonly base: string;
  readonly effort: string | null;
  readonly fast: boolean;
  readonly unknownOptions: readonly string[];
  readonly valid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeBase(value: string): string {
  return value.trim().toLowerCase().replace(/^cursor-/u, "");
}

function parseDisplayId(displayId: string): CursorModelSemantics {
  const parts = displayId.trim().replace(/^cursor-/iu, "").split("-");
  let effort: string | null = null;
  let fast = false;
  let valid = true;
  while (parts.length > 1) {
    const token = parts.at(-1)?.toLowerCase();
    if (token === "fast") {
      if (fast) valid = false;
      fast = true;
      parts.pop();
      continue;
    }
    if (token === "low" || token === "medium" || token === "high" || token === "xhigh") {
      if (effort !== null) valid = false;
      effort = token;
      parts.pop();
      continue;
    }
    break;
  }
  return {
    base: normalizeBase(parts.join("-")),
    effort,
    fast,
    unknownOptions: Object.freeze([]),
    valid: valid && parts.join("-").trim() !== "",
  };
}

function parseTransportValue(value: string): CursorModelSemantics {
  const match = /^([^\[\]]+?)(?:\[([^\]]*)\])?$/u.exec(value.trim());
  if (!match) return { base: "", effort: null, fast: false, unknownOptions: Object.freeze([]), valid: false };
  let effort: string | null = null;
  let fast = false;
  let effortSeen = false;
  let fastSeen = false;
  let valid = true;
  const unknownOptions: string[] = [];
  if (match[2]) {
    for (const entry of match[2].split(",")) {
      const option = /^\s*([a-z][a-z0-9_-]*)\s*=\s*([^,]+?)\s*$/iu.exec(entry);
      if (!option) {
        valid = false;
        continue;
      }
      const key = option[1].toLowerCase();
      const optionValue = option[2].toLowerCase();
      if (key === "effort" || key === "reasoning") {
        if (effortSeen || !/^(?:low|medium|high|xhigh)$/u.test(optionValue)) valid = false;
        else effort = optionValue;
        effortSeen = true;
      } else if (key === "fast") {
        if (fastSeen || (optionValue !== "true" && optionValue !== "false")) valid = false;
        else fast = optionValue === "true";
        fastSeen = true;
      } else {
        unknownOptions.push(`${key}=${optionValue}`);
      }
    }
  }
  return {
    base: normalizeBase(match[1]),
    effort,
    fast,
    unknownOptions: Object.freeze(unknownOptions.sort()),
    valid: valid && match[1].trim() !== "",
  };
}

function aliasMatches(displayId: string, option: CursorAcpModelOption): boolean {
  const requested = parseDisplayId(displayId);
  const available = parseTransportValue(option.value);
  return requested.valid
    && available.valid
    && available.unknownOptions.length === 0
    && requested.base === available.base
    && requested.effort === available.effort
    && requested.fast === available.fast;
}

export function resolveCursorAcpModel(
  options: readonly CursorAcpModelOption[],
  displayId: string,
): CursorModelDescriptor | null {
  const exact = options.filter(option => option.value === displayId);
  const matches = exact.length > 0 ? exact : options.filter(option => aliasMatches(displayId, option));
  if (matches.length !== 1) return null;
  const semantics = parseTransportValue(matches[0].value);
  return Object.freeze({
    displayId,
    transport: "acp",
    transportValue: matches[0].value,
    effort: semantics.effort,
    fast: semantics.fast,
  });
}

export function compatibleCursorAcpModels(
  displayIds: readonly string[],
  options: readonly CursorAcpModelOption[],
): readonly CursorModelDescriptor[] {
  return Object.freeze(displayIds
    .map(displayId => resolveCursorAcpModel(options, displayId))
    .filter((descriptor): descriptor is CursorModelDescriptor => descriptor !== null));
}

export function directCursorModel(displayId: string): CursorModelDescriptor {
  const semantics = parseDisplayId(displayId);
  return Object.freeze({
    displayId,
    transport: "cli",
    transportValue: displayId,
    effort: semantics.effort,
    fast: semantics.fast,
  });
}

export function cursorAcpModelOptions(session: unknown): readonly CursorAcpModelOption[] {
  if (!isRecord(session) || !Array.isArray(session.configOptions)) return Object.freeze([]);
  const model = session.configOptions.find(option => isRecord(option) && option.id === "model");
  if (!isRecord(model) || !Array.isArray(model.options)) return Object.freeze([]);
  return Object.freeze(model.options.flatMap(option => {
    if (!isRecord(option) || typeof option.value !== "string" || option.value.trim() === "") return [];
    return [Object.freeze({
      value: option.value,
      name: typeof option.name === "string" && option.name.trim() !== "" ? option.name : null,
    })];
  }));
}

export function parseCursorAcpCatalog(output: string): CursorAcpCatalog | null {
  let parsed: unknown;
  try { parsed = JSON.parse(output); }
  catch { return null; }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.transport !== "acp" || !Array.isArray(parsed.options)) return null;
  const options: CursorAcpModelOption[] = [];
  for (const option of parsed.options) {
    if (!isRecord(option) || typeof option.value !== "string" || option.value.trim() === "") return null;
    if (option.name !== null && typeof option.name !== "string") return null;
    options.push(Object.freeze({ value: option.value, name: option.name as string | null }));
  }
  return options.length > 0
    ? Object.freeze({ version: 1, transport: "acp", options: Object.freeze(options) })
    : null;
}
