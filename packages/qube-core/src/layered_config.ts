export const LAYERED_CONFIG_SOURCES = Object.freeze([
  "explicit",
  "machine-local",
  "repository",
  "user-global",
  "detected",
  "default",
  "derived",
] as const);

export type LayeredConfigSource = (typeof LAYERED_CONFIG_SOURCES)[number];
export type DurableConfigSource = Exclude<LayeredConfigSource, "explicit">;
export type LayeredValueComparison = "exact" | "ordered" | "set";

export const QUBE_INIT_LAYER_CONTEXT_ENV = "QUBE_INIT_LAYER_CONTEXT";

export interface InitLayerContext {
  readonly version: 1;
  readonly selectedScope: "repository" | "user-global";
  readonly effective: Readonly<Record<string, unknown>>;
  readonly sources: Readonly<Record<string, LayeredConfigSource>>;
  readonly baseline: Readonly<Record<string, unknown>> | null;
  readonly repository: Readonly<Record<string, unknown>> | null;
}

export interface LayeredConfigField<Config, Field extends string> {
  readonly id: Field;
  readonly read: (config: Config) => unknown | undefined;
  readonly comparison?: LayeredValueComparison;
  readonly applicable?: (effective: Config) => boolean;
}

export interface LayeredConfigLayer<Config> {
  readonly source: Exclude<LayeredConfigSource, "derived">;
  readonly config: Config | null;
}

export interface ResolvedLayeredFields<Field extends string> {
  readonly values: Readonly<Record<Field, unknown>>;
  readonly sources: Readonly<Record<Field, Exclude<LayeredConfigSource, "derived">>>;
}

export function resolveLayeredFields<Config, Field extends string>(input: {
  readonly fields: readonly LayeredConfigField<Config, Field>[];
  readonly layers: readonly LayeredConfigLayer<Config>[];
}): ResolvedLayeredFields<Field> {
  const values = {} as Record<Field, unknown>;
  const sources = {} as Record<Field, Exclude<LayeredConfigSource, "derived">>;
  for (const field of input.fields) {
    let found = false;
    for (const layer of input.layers) {
      if (!layer.config) continue;
      const value = field.read(layer.config);
      if (value === undefined) continue;
      values[field.id] = value;
      sources[field.id] = layer.source;
      found = true;
      break;
    }
    if (!found) throw new TypeError(`Layered configuration is missing ${field.id}.`);
  }
  return Object.freeze({ values: Object.freeze(values), sources: Object.freeze(sources) });
}

export function projectSparseFieldIds<Config, Field extends string>(input: {
  readonly fields: readonly LayeredConfigField<Config, Field>[];
  readonly desired: Config;
  readonly baseline: Config | null;
}): readonly Field[] {
  return Object.freeze(input.fields.flatMap(field => {
    if (field.applicable && !field.applicable(input.desired)) return [];
    const desired = field.read(input.desired);
    if (desired === undefined) return [];
    const baseline = input.baseline ? field.read(input.baseline) : undefined;
    return baseline !== undefined && sameLayeredValue(desired, baseline, field.comparison) ? [] : [field.id];
  }));
}

export function sameLayeredValue(
  left: unknown,
  right: unknown,
  comparison: LayeredValueComparison = "exact",
): boolean {
  if (comparison === "set") {
    return JSON.stringify(normalizeSet(left)) === JSON.stringify(normalizeSet(right));
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

export function serializeInitLayerContext(context: InitLayerContext): string {
  return JSON.stringify(context);
}

export function readInitLayerContext(environment: NodeJS.ProcessEnv = process.env): InitLayerContext | null {
  const raw = environment[QUBE_INIT_LAYER_CONTEXT_ENV];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`Invalid ${QUBE_INIT_LAYER_CONTEXT_ENV}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new TypeError(`Invalid ${QUBE_INIT_LAYER_CONTEXT_ENV}: version must be 1.`);
  }
  if (parsed.selectedScope !== "repository" && parsed.selectedScope !== "user-global") {
    throw new TypeError(`Invalid ${QUBE_INIT_LAYER_CONTEXT_ENV}: selectedScope must be repository or user-global.`);
  }
  if (!isRecord(parsed.effective) || !isRecord(parsed.sources)) {
    throw new TypeError(`Invalid ${QUBE_INIT_LAYER_CONTEXT_ENV}: effective and sources must be objects.`);
  }
  if (parsed.baseline !== null && !isRecord(parsed.baseline)) {
    throw new TypeError(`Invalid ${QUBE_INIT_LAYER_CONTEXT_ENV}: baseline must be an object or null.`);
  }
  if (parsed.repository !== null && !isRecord(parsed.repository)) {
    throw new TypeError(`Invalid ${QUBE_INIT_LAYER_CONTEXT_ENV}: repository must be an object or null.`);
  }
  const sources: Record<string, LayeredConfigSource> = {};
  for (const [field, source] of Object.entries(parsed.sources)) {
    if (typeof source !== "string" || !LAYERED_CONFIG_SOURCES.includes(source as LayeredConfigSource)) {
      throw new TypeError(`Invalid ${QUBE_INIT_LAYER_CONTEXT_ENV}: source for ${field} is not supported.`);
    }
    sources[field] = source as LayeredConfigSource;
  }
  return Object.freeze({
    version: 1,
    selectedScope: parsed.selectedScope,
    effective: Object.freeze({ ...parsed.effective }),
    sources: Object.freeze(sources),
    baseline: parsed.baseline === null ? null : Object.freeze({ ...parsed.baseline }),
    repository: parsed.repository === null ? null : Object.freeze({ ...parsed.repository }),
  });
}

function normalizeSet(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return [...new Set(value.map(entry => typeof entry === "string" ? entry.trim() : entry))]
    .sort((left, right) => String(left).localeCompare(String(right)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
