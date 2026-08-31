import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import path from "node:path";

import { projectSparseFieldIds, sameLayeredValue, type LayeredConfigField } from "@tjalve/qube-core";

export const QUBE_USER_CONFIG_PATH = ".qube/config.json";
export const QUBE_REPO_CONFIG_PATH = ".qube/init.json";

export const QUBE_UMPIRE_SCOPES = ["ready", "standard", "custom"] as const;
export const QUBE_REVIEW_MODES = ["external", "host", "isolated"] as const;
export const QUBE_REVIEW_PUBLISHERS = ["user", "github-app"] as const;
export type QubeUmpireScope = (typeof QUBE_UMPIRE_SCOPES)[number];
export type QubeReviewMode = (typeof QUBE_REVIEW_MODES)[number];
export type QubeReviewPublisher = (typeof QUBE_REVIEW_PUBLISHERS)[number];
export type QubeExternalReviewer = string;

export interface QubeInitConfig {
  readonly version: 1;
  readonly hosts?: readonly string[];
  readonly workProviders?: readonly string[];
  readonly ciProviders?: readonly string[];
  readonly continuousShipping?: boolean;
  readonly umpire?: {
    readonly scope?: QubeUmpireScope;
  };
  readonly quality?: {
    readonly stages?: readonly string[];
  };
  readonly review?: {
    readonly mode?: QubeReviewMode;
    readonly harness?: string;
    readonly externalReviewers?: readonly QubeExternalReviewer[];
    readonly publisher?: QubeReviewPublisher;
    readonly models?: readonly string[];
  };
  readonly mcp?: {
    readonly optIn?: boolean;
  };
}

export interface QubeInitConfigReadResult {
  readonly path: string;
  readonly status: "missing" | "valid" | "invalid";
  readonly config: QubeInitConfig | null;
  readonly error: string | null;
}

export type QubeInitFieldSource = "explicit" | "machine-local" | "repository" | "user-global" | "detected" | "default" | "derived";

export interface QubeResolvedInitConfig {
  readonly config: RequiredQubeInitConfig;
  readonly sources: Readonly<Record<QubeInitField, QubeInitFieldSource>>;
  readonly derivedFrom: Readonly<Partial<Record<QubeInitField, readonly QubeInitField[]>>>;
  readonly deviations: readonly QubeInitField[];
}

export type QubeInitField =
  | "hosts"
  | "workProviders"
  | "ciProviders"
  | "continuousShipping"
  | "umpire.scope"
  | "quality.stages"
  | "review.mode"
  | "review.harness"
  | "review.externalReviewers"
  | "review.publisher"
  | "review.models"
  | "mcp.optIn";

export const QUBE_INIT_FIELDS = Object.freeze([
  "hosts",
  "workProviders",
  "ciProviders",
  "continuousShipping",
  "umpire.scope",
  "quality.stages",
  "review.mode",
  "review.harness",
  "review.externalReviewers",
  "review.publisher",
  "review.models",
  "mcp.optIn",
] as const satisfies readonly QubeInitField[]);

export const QUBE_INIT_FIELD_REGISTRY: readonly LayeredConfigField<QubeInitConfig, QubeInitField>[] = Object.freeze(
  QUBE_INIT_FIELDS.map(field => Object.freeze({
    id: field,
    read: (config: QubeInitConfig) => readField(config, field),
    comparison: (["workProviders", "ciProviders", "quality.stages", "review.externalReviewers"] as QubeInitField[]).includes(field)
      ? "set" as const
      : "ordered" as const,
    applicable: (config: QubeInitConfig) => isQubeInitFieldApplicable(config as RequiredQubeInitConfig, field),
  })),
);

export interface RequiredQubeInitConfig extends QubeInitConfig {
  readonly hosts: readonly string[];
  readonly workProviders: readonly string[];
  readonly ciProviders: readonly string[];
  readonly continuousShipping: boolean;
  readonly umpire: { readonly scope: QubeUmpireScope };
  readonly quality: { readonly stages: readonly string[] };
  readonly review: {
    readonly mode: QubeReviewMode;
    readonly harness?: string;
    readonly externalReviewers?: readonly QubeExternalReviewer[];
    readonly publisher: QubeReviewPublisher;
    readonly models?: readonly string[];
  };
  readonly mcp: { readonly optIn: boolean };
}

export type QubeRepositoryFieldAction = "add" | "update" | "remove" | "keep";

export interface QubeInitFieldLayerValue {
  readonly present: boolean;
  readonly value?: unknown;
}

export interface QubeInitFieldPlan {
  readonly id: QubeInitField;
  readonly userGlobal: QubeInitFieldLayerValue;
  readonly repository: QubeInitFieldLayerValue;
  readonly effective: {
    readonly value: unknown;
    readonly source: QubeInitFieldSource;
    readonly derivedFrom?: readonly QubeInitField[];
  };
  readonly planned: {
    readonly repositoryAction: QubeRepositoryFieldAction;
    readonly effectiveValue: unknown;
    readonly source: QubeInitFieldSource;
    readonly derivedFrom?: readonly QubeInitField[];
  };
}

export type QubeInitConfigWriteOperation = "create" | "update" | "remove" | "skip";

export function userQubeConfigPath(homeDirectory: string): string {
  return path.join(path.resolve(homeDirectory), ...QUBE_USER_CONFIG_PATH.split("/"));
}

export function repoQubeConfigPath(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), ...QUBE_REPO_CONFIG_PATH.split("/"));
}

export function readQubeInitConfig(filePath: string): QubeInitConfigReadResult {
  const resolved = path.resolve(filePath);
  try {
    const target = resolveQubeConfigTarget(resolved);
    const targetStatus = assertSafeQubeConfigPath(target);
    if (!targetStatus) {
      return Object.freeze({ path: target.path, status: "missing", config: null, error: null });
    }
    const config = parseQubeInitConfig(JSON.parse(readFileSync(target.path, "utf8")) as unknown);
    assertSafeQubeConfigPath(target);
    return Object.freeze({ path: target.path, status: "valid", config, error: null });
  } catch (error) {
    return Object.freeze({
      path: resolved,
      status: "invalid",
      config: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseQubeInitConfig(value: unknown): QubeInitConfig {
  const record = requireRecord(value, "QUBE config");
  rejectUnknownKeys(record, ["version", "hosts", "workProviders", "ciProviders", "continuousShipping", "umpire", "quality", "review", "mcp"], "QUBE config");
  if (record.version !== 1) throw new TypeError("QUBE config version must be 1.");

  const umpire = optionalRecord(record.umpire, "QUBE config umpire");
  if (umpire) rejectUnknownKeys(umpire, ["scope"], "QUBE config umpire");
  const quality = optionalRecord(record.quality, "QUBE config quality");
  if (quality) rejectUnknownKeys(quality, ["stages"], "QUBE config quality");
  const review = optionalRecord(record.review, "QUBE config review");
  if (review) rejectUnknownKeys(review, ["mode", "harness", "externalReviewers", "publisher", "models"], "QUBE config review");
  const mcp = optionalRecord(record.mcp, "QUBE config mcp");
  if (mcp) rejectUnknownKeys(mcp, ["optIn"], "QUBE config mcp");

  return Object.freeze({
    version: 1,
    ...(record.hosts === undefined ? {} : { hosts: readStringList(record.hosts, "QUBE config hosts") }),
    ...(record.workProviders === undefined ? {} : { workProviders: readStringList(record.workProviders, "QUBE config workProviders") }),
    ...(record.ciProviders === undefined ? {} : { ciProviders: readStringList(record.ciProviders, "QUBE config ciProviders") }),
    ...(record.continuousShipping === undefined ? {} : { continuousShipping: readBoolean(record.continuousShipping, "QUBE config continuousShipping") }),
    ...(umpire?.scope === undefined ? {} : { umpire: Object.freeze({ scope: readChoice(umpire.scope, QUBE_UMPIRE_SCOPES, "QUBE config umpire.scope") }) }),
    ...(quality?.stages === undefined ? {} : { quality: Object.freeze({ stages: readStringList(quality.stages, "QUBE config quality.stages") }) }),
    ...(review === undefined ? {} : {
      review: Object.freeze({
        ...(review.mode === undefined ? {} : { mode: readChoice(review.mode, QUBE_REVIEW_MODES, "QUBE config review.mode") }),
        ...(review.harness === undefined ? {} : { harness: readNonEmptyString(review.harness, "QUBE config review.harness") }),
        ...(review.externalReviewers === undefined ? {} : { externalReviewers: readStringList(review.externalReviewers, "QUBE config review.externalReviewers") }),
        ...(review.publisher === undefined ? {} : { publisher: readChoice(review.publisher, QUBE_REVIEW_PUBLISHERS, "QUBE config review.publisher") }),
        ...(review.models === undefined ? {} : { models: readStringList(review.models, "QUBE config review.models", true) }),
      }),
    }),
    ...(mcp?.optIn === undefined ? {} : { mcp: Object.freeze({ optIn: readBoolean(mcp.optIn, "QUBE config mcp.optIn") }) }),
  });
}

export function mergeQubeInitConfigs(globalConfig: QubeInitConfig | null, repoConfig: QubeInitConfig | null): QubeInitConfig {
  return Object.freeze({
    version: 1,
    ...(globalConfig?.hosts === undefined ? {} : { hosts: Object.freeze([...globalConfig.hosts]) }),
    ...(globalConfig?.workProviders === undefined ? {} : { workProviders: Object.freeze([...globalConfig.workProviders]) }),
    ...(globalConfig?.ciProviders === undefined ? {} : { ciProviders: Object.freeze([...globalConfig.ciProviders]) }),
    ...(globalConfig?.continuousShipping === undefined ? {} : { continuousShipping: globalConfig.continuousShipping }),
    ...(globalConfig?.umpire === undefined ? {} : { umpire: Object.freeze({ ...globalConfig.umpire }) }),
    ...(globalConfig?.quality === undefined ? {} : { quality: Object.freeze({ ...globalConfig.quality, ...(globalConfig.quality.stages ? { stages: Object.freeze([...globalConfig.quality.stages]) } : {}) }) }),
    ...(globalConfig?.review === undefined ? {} : { review: cloneReview(globalConfig.review) }),
    ...(globalConfig?.mcp === undefined ? {} : { mcp: Object.freeze({ ...globalConfig.mcp }) }),
    ...(repoConfig?.hosts === undefined ? {} : { hosts: Object.freeze([...repoConfig.hosts]) }),
    ...(repoConfig?.workProviders === undefined ? {} : { workProviders: Object.freeze([...repoConfig.workProviders]) }),
    ...(repoConfig?.ciProviders === undefined ? {} : { ciProviders: Object.freeze([...repoConfig.ciProviders]) }),
    ...(repoConfig?.continuousShipping === undefined ? {} : { continuousShipping: repoConfig.continuousShipping }),
    ...((globalConfig?.umpire || repoConfig?.umpire) ? { umpire: Object.freeze({ ...globalConfig?.umpire, ...repoConfig?.umpire }) } : {}),
    ...((globalConfig?.quality || repoConfig?.quality) ? {
      quality: Object.freeze({
        ...globalConfig?.quality,
        ...repoConfig?.quality,
        ...(repoConfig?.quality?.stages ? { stages: Object.freeze([...repoConfig.quality.stages]) } : globalConfig?.quality?.stages ? { stages: Object.freeze([...globalConfig.quality.stages]) } : {}),
      }),
    } : {}),
    ...((globalConfig?.review || repoConfig?.review) ? { review: cloneReview({ ...globalConfig?.review, ...repoConfig?.review }) } : {}),
    ...((globalConfig?.mcp || repoConfig?.mcp) ? { mcp: Object.freeze({ ...globalConfig?.mcp, ...repoConfig?.mcp }) } : {}),
  });
}

export function resolveQubeInitConfig(input: {
  readonly globalConfig: QubeInitConfig | null;
  readonly repoConfig: QubeInitConfig | null;
  readonly detected?: QubeInitConfig | null;
  readonly explicit?: QubeInitConfig | null;
  readonly defaults: RequiredQubeInitConfig;
}): QubeResolvedInitConfig {
  const layers: readonly { readonly source: QubeInitFieldSource; readonly config: QubeInitConfig | null }[] = [
    { source: "explicit", config: input.explicit ?? null },
    { source: "repository", config: input.repoConfig },
    { source: "user-global", config: input.globalConfig },
    { source: "detected", config: input.detected ?? null },
    { source: "default", config: input.defaults },
  ];
  const selected = <Value>(field: QubeInitField, read: (config: QubeInitConfig) => Value | undefined): { value: Value; source: QubeInitFieldSource } => {
    for (const layer of layers) {
      if (!layer.config) continue;
      const value = read(layer.config);
      if (value !== undefined) return { value, source: layer.source };
    }
    throw new TypeError(`QUBE init default is missing ${field}.`);
  };
  const selectedOptional = <Value>(read: (config: QubeInitConfig) => Value | undefined): { value: Value; source: QubeInitFieldSource } | undefined => {
    for (const layer of layers) {
      if (!layer.config) continue;
      const value = read(layer.config);
      if (value !== undefined) return { value, source: layer.source };
    }
    return undefined;
  };

  const hosts = selected("hosts", config => config.hosts);
  const workProviders = selected("workProviders", config => config.workProviders);
  const ciProviders = selected("ciProviders", config => config.ciProviders);
  const continuousShipping = selected("continuousShipping", config => config.continuousShipping);
  const umpireScope = selected("umpire.scope", config => config.umpire?.scope);
  const qualityStages = selected("quality.stages", config => config.quality?.stages);
  const selectedReviewMode = selected("review.mode", config => config.review?.mode);
  const reviewMode = selectedReviewMode.source === "default"
    ? { value: selectedReviewMode.value, source: "derived" as const }
    : selectedReviewMode;
  const derivedReviewSource: QubeInitFieldSource = "derived";
  const reviewHarness = reviewMode.value === "external"
    ? { value: undefined, source: derivedReviewSource }
    : reviewMode.value === "host"
      ? { value: hosts.value[0], source: derivedReviewSource }
      : (() => {
          const selectedHarness = selectedOptional(config => (
            config.review?.mode !== undefined && config.review.mode !== "isolated" ? undefined : config.review?.harness
          ));
          return selectedHarness?.source === "default"
            ? { value: selectedHarness.value, source: derivedReviewSource }
            : selectedHarness ?? { value: undefined, source: derivedReviewSource };
        })();
  const selectedExternalReviewers = reviewMode.value === "external"
    ? selected("review.externalReviewers", config => config.review?.externalReviewers ?? (config === input.defaults ? [] : undefined))
    : { value: Object.freeze([]) as readonly QubeExternalReviewer[], source: derivedReviewSource };
  const externalReviewers = reviewMode.value === "external" && selectedExternalReviewers.source === "default" && selectedReviewMode.source === "default"
    ? { value: selectedExternalReviewers.value, source: "derived" as const }
    : selectedExternalReviewers;
  const reviewPublisher = selected("review.publisher", config => config.review?.publisher);
  const reviewModels = reviewMode.value === "external"
    ? { value: Object.freeze([]) as readonly string[], source: derivedReviewSource }
    : selected("review.models", config => config.review?.models ?? (config === input.defaults ? [] : undefined));
  const mcpOptIn = selected("mcp.optIn", config => config.mcp?.optIn);

  const config: RequiredQubeInitConfig = Object.freeze({
    version: 1,
    hosts: Object.freeze([...hosts.value]),
    workProviders: Object.freeze([...workProviders.value]),
    ciProviders: Object.freeze([...ciProviders.value]),
    continuousShipping: continuousShipping.value,
    umpire: Object.freeze({ scope: umpireScope.value }),
    quality: Object.freeze({ stages: Object.freeze([...qualityStages.value]) }),
    review: Object.freeze({
      mode: reviewMode.value,
      ...(reviewHarness.value ? { harness: reviewHarness.value } : {}),
      ...(reviewMode.value === "external" && externalReviewers.value.length > 0
        ? { externalReviewers: Object.freeze([...externalReviewers.value]) }
        : {}),
      publisher: reviewPublisher.value,
      ...(reviewModels.value.length > 0 || reviewModels.source !== "default"
        ? { models: Object.freeze([...reviewModels.value]) }
        : {}),
    }),
    mcp: Object.freeze({ optIn: mcpOptIn.value }),
  });
  const sources = Object.freeze({
    hosts: hosts.source,
    workProviders: workProviders.source,
    ciProviders: ciProviders.source,
    continuousShipping: continuousShipping.source,
    "umpire.scope": umpireScope.source,
    "quality.stages": qualityStages.source,
    "review.mode": reviewMode.source,
    "review.harness": reviewHarness.source,
    "review.externalReviewers": externalReviewers.source,
    "review.publisher": reviewPublisher.source,
    "review.models": reviewModels.source,
    "mcp.optIn": mcpOptIn.source,
  }) satisfies Readonly<Record<QubeInitField, QubeInitFieldSource>>;
  const derivedFrom = Object.freeze({
    ...(reviewMode.source === "derived" ? { "review.mode": Object.freeze(["hosts"] as const) } : {}),
    ...(reviewHarness.source === "derived" ? { "review.harness": Object.freeze(["review.mode", "hosts"] as const) } : {}),
    ...(externalReviewers.source === "derived" ? { "review.externalReviewers": Object.freeze(["review.mode", "hosts"] as const) } : {}),
    ...(reviewModels.source === "derived" ? { "review.models": Object.freeze(["review.mode"] as const) } : {}),
  }) satisfies Readonly<Partial<Record<QubeInitField, readonly QubeInitField[]>>>;
  const deviations = Object.freeze((Object.keys(sources) as QubeInitField[]).filter(field => {
    return !sameQubeInitFieldValue(field, readField(config, field), readField(input.defaults, field));
  }));
  return Object.freeze({ config, sources, derivedFrom, deviations });
}

export function configForQubeScope(
  resolved: QubeResolvedInitConfig,
  scope: "global" | "repo",
  existingGlobal: QubeInitConfig | null = null,
): QubeInitConfig {
  if (scope === "global") {
    const useResolved = (field: QubeInitField): boolean => !["repository", "derived"].includes(resolved.sources[field]);
    const globalReviewMode = useResolved("review.mode") ? resolved.config.review.mode : existingGlobal?.review?.mode;
    return Object.freeze({
      version: 1,
      ...(useResolved("hosts") ? { hosts: resolved.config.hosts } : existingGlobal?.hosts ? { hosts: existingGlobal.hosts } : {}),
      ...(useResolved("workProviders") ? { workProviders: resolved.config.workProviders } : existingGlobal?.workProviders ? { workProviders: existingGlobal.workProviders } : {}),
      ...(useResolved("ciProviders") ? { ciProviders: resolved.config.ciProviders } : existingGlobal?.ciProviders ? { ciProviders: existingGlobal.ciProviders } : {}),
      ...(useResolved("continuousShipping") ? { continuousShipping: resolved.config.continuousShipping } : existingGlobal?.continuousShipping === undefined ? {} : { continuousShipping: existingGlobal.continuousShipping }),
      ...(useResolved("umpire.scope") ? { umpire: resolved.config.umpire } : existingGlobal?.umpire ? { umpire: existingGlobal.umpire } : {}),
      ...(useResolved("quality.stages") ? { quality: resolved.config.quality } : existingGlobal?.quality ? { quality: existingGlobal.quality } : {}),
      ...(
        useResolved("review.mode") || useResolved("review.harness") || useResolved("review.externalReviewers") || useResolved("review.publisher") || useResolved("review.models")
          ? {
              review: Object.freeze({
                ...(useResolved("review.mode") ? { mode: resolved.config.review.mode } : existingGlobal?.review?.mode ? { mode: existingGlobal.review.mode } : {}),
                ...(globalReviewMode === "isolated"
                  ? useResolved("review.harness")
                    ? resolved.config.review.harness ? { harness: resolved.config.review.harness } : {}
                    : existingGlobal?.review?.harness ? { harness: existingGlobal.review.harness } : {}
                  : {}),
                ...(globalReviewMode === "external"
                  ? useResolved("review.externalReviewers")
                    ? resolved.config.review.externalReviewers ? { externalReviewers: resolved.config.review.externalReviewers } : {}
                    : existingGlobal?.review?.externalReviewers ? { externalReviewers: existingGlobal.review.externalReviewers } : {}
                  : {}),
                ...(useResolved("review.publisher") ? { publisher: resolved.config.review.publisher } : existingGlobal?.review?.publisher ? { publisher: existingGlobal.review.publisher } : {}),
                ...(globalReviewMode !== "external"
                  ? useResolved("review.models")
                    ? resolved.config.review.models ? { models: resolved.config.review.models } : {}
                    : existingGlobal?.review?.models ? { models: existingGlobal.review.models } : {}
                  : {}),
              }),
            }
          : existingGlobal?.review ? { review: existingGlobal.review } : {}
      ),
      ...(useResolved("mcp.optIn") ? { mcp: resolved.config.mcp } : existingGlobal?.mcp ? { mcp: existingGlobal.mcp } : {}),
    });
  }
  const sparseFields = new Set(projectSparseFieldIds({
    fields: QUBE_INIT_FIELD_REGISTRY,
    desired: resolved.config,
    baseline: existingGlobal,
  }));
  const include = (field: QubeInitField): boolean => {
    if (resolved.sources[field] === "derived") return false;
    if (!existingGlobal && resolved.sources[field] === "user-global") return false;
    return sparseFields.has(field);
  };
  return Object.freeze({
    version: 1,
    ...(include("hosts") ? { hosts: resolved.config.hosts } : {}),
    ...(include("workProviders") ? { workProviders: resolved.config.workProviders } : {}),
    ...(include("ciProviders") ? { ciProviders: resolved.config.ciProviders } : {}),
    ...(include("continuousShipping") ? { continuousShipping: resolved.config.continuousShipping } : {}),
    ...(include("umpire.scope") ? { umpire: resolved.config.umpire } : {}),
    ...(include("quality.stages") ? { quality: resolved.config.quality } : {}),
    ...(
      include("review.mode") ||
      (include("review.harness") && resolved.config.review.harness !== undefined) ||
      (include("review.externalReviewers") && resolved.config.review.externalReviewers !== undefined) ||
      include("review.publisher") ||
      (include("review.models") && resolved.config.review.models !== undefined)
        ? {
            review: Object.freeze({
              ...(include("review.mode") ? { mode: resolved.config.review.mode } : {}),
              ...(include("review.harness") && resolved.config.review.harness ? { harness: resolved.config.review.harness } : {}),
              ...(include("review.externalReviewers") && resolved.config.review.externalReviewers ? { externalReviewers: resolved.config.review.externalReviewers } : {}),
              ...(include("review.publisher") ? { publisher: resolved.config.review.publisher } : {}),
              ...(include("review.models") && resolved.config.review.models ? { models: resolved.config.review.models } : {}),
            }),
          }
        : {}
    ),
    ...(include("mcp.optIn") ? { mcp: resolved.config.mcp } : {}),
  });
}

export function describeQubeInitFields(input: {
  readonly userGlobal: QubeInitConfig | null;
  readonly repository: QubeInitConfig | null;
  readonly resolved: QubeResolvedInitConfig;
  readonly projectedRepository: QubeInitConfig;
}): readonly QubeInitFieldPlan[] {
  return Object.freeze(QUBE_INIT_FIELDS.map(field => {
    const userGlobalValue = input.userGlobal ? readField(input.userGlobal, field) : undefined;
    const repositoryValue = input.repository ? readField(input.repository, field) : undefined;
    const projectedValue = readField(input.projectedRepository, field);
    const effectiveValue = readField(input.resolved.config, field);
    const repositoryAction = repositoryFieldAction(field, repositoryValue, projectedValue);
    const postApplySource: QubeInitFieldSource = input.resolved.sources[field] === "derived"
      ? "derived"
      : projectedValue !== undefined
      ? "repository"
      : userGlobalValue !== undefined
        ? "user-global"
        : input.resolved.sources[field] === "explicit"
          ? "default"
          : input.resolved.sources[field];
    const derivedFrom = input.resolved.derivedFrom[field];
    return Object.freeze({
      id: field,
      userGlobal: layerValue(userGlobalValue),
      repository: layerValue(repositoryValue),
      effective: Object.freeze({
        value: effectiveValue,
        source: input.resolved.sources[field],
        ...(derivedFrom ? { derivedFrom } : {}),
      }),
      planned: Object.freeze({
        repositoryAction,
        effectiveValue,
        source: postApplySource,
        ...(postApplySource === "derived" && derivedFrom ? { derivedFrom } : {}),
      }),
    });
  }));
}

export function omitQubeInitFields(
  config: QubeInitConfig | null,
  fields: readonly QubeInitField[],
): QubeInitConfig | null {
  if (!config || fields.length === 0) return config;
  const omitted = new Set(fields);
  const include = (field: QubeInitField): boolean => !omitted.has(field) && readField(config, field) !== undefined;
  return Object.freeze({
    version: 1,
    ...(include("hosts") ? { hosts: config.hosts } : {}),
    ...(include("workProviders") ? { workProviders: config.workProviders } : {}),
    ...(include("ciProviders") ? { ciProviders: config.ciProviders } : {}),
    ...(include("continuousShipping") ? { continuousShipping: config.continuousShipping } : {}),
    ...(include("umpire.scope") ? { umpire: Object.freeze({ scope: config.umpire!.scope }) } : {}),
    ...(include("quality.stages") ? { quality: Object.freeze({ stages: config.quality!.stages }) } : {}),
    ...(
      include("review.mode") || include("review.harness") || include("review.externalReviewers") || include("review.publisher") || include("review.models")
        ? {
            review: Object.freeze({
              ...(include("review.mode") ? { mode: config.review!.mode } : {}),
              ...(include("review.harness") ? { harness: config.review!.harness } : {}),
              ...(include("review.externalReviewers") ? { externalReviewers: config.review!.externalReviewers } : {}),
              ...(include("review.publisher") ? { publisher: config.review!.publisher } : {}),
              ...(include("review.models") ? { models: config.review!.models } : {}),
            }),
          }
        : {}
    ),
    ...(include("mcp.optIn") ? { mcp: Object.freeze({ optIn: config.mcp!.optIn }) } : {}),
  });
}

export function writeQubeInitConfig(filePath: string, config: QubeInitConfig): QubeInitConfigWriteOperation {
  const target = resolveQubeConfigTarget(filePath);
  let targetStatus = assertSafeQubeConfigPath(target);
  if (isEmptyQubeInitConfig(config)) {
    if (!targetStatus) return "skip";
    assertSafeQubeConfigPath(target);
    unlinkSync(target.path);
    return "remove";
  }

  const content = `${JSON.stringify(config, null, 2)}\n`;
  if (targetStatus) {
    const current = readFileSync(target.path, "utf8");
    if (current === content) return "skip";
  }

  mkdirSync(path.dirname(target.path), { recursive: true });
  targetStatus = assertSafeQubeConfigPath(target);
  if (targetStatus && readFileSync(target.path, "utf8") === content) return "skip";

  const operation: QubeInitConfigWriteOperation = targetStatus ? "update" : "create";
  assertSafeQubeConfigPath(target);
  writeFileSync(target.path, content, { encoding: "utf8", flag: operation === "create" ? "wx" : "w" });
  return operation;
}

interface QubeConfigTarget {
  readonly path: string;
  readonly root: string;
}

function resolveQubeConfigTarget(filePath: string): QubeConfigTarget {
  const selectedPath = path.resolve(filePath);
  const configDirectory = path.dirname(selectedPath);
  const fileName = path.basename(selectedPath);
  if (path.basename(configDirectory) !== ".qube" || !["config.json", "init.json"].includes(fileName)) {
    throw new Error("Refusing to use QUBE config outside a supported .qube/config.json or .qube/init.json path.");
  }

  const selectedRoot = path.dirname(configDirectory);
  const rootStatus = readQubeConfigPathStatus(selectedRoot);
  if (!rootStatus || rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error(`Refusing to use QUBE config through an unsafe root: ${selectedRoot}.`);
  }
  const canonicalRoot = realpathSync(selectedRoot);
  const canonicalPath = path.join(canonicalRoot, ".qube", fileName);
  if (path.relative(canonicalPath, selectedPath) !== "") {
    throw new Error(`Refusing to use QUBE config outside the canonical root: ${canonicalRoot}.`);
  }
  return Object.freeze({ path: canonicalPath, root: canonicalRoot });
}

function assertSafeQubeConfigPath(target: QubeConfigTarget): Stats | undefined {
  const relativePath = path.relative(target.root, target.path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to use QUBE config outside the canonical root: ${target.root}.`);
  }

  const rootStatus = readQubeConfigPathStatus(target.root);
  if (!rootStatus || rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error(`Refusing to use QUBE config through an unsafe root: ${target.root}.`);
  }

  const segments = relativePath.split(path.sep).filter(segment => segment.length > 0);
  let currentPath = target.root;
  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    const status = readQubeConfigPathStatus(currentPath);
    if (!status) return undefined;
    if (status.isSymbolicLink()) {
      throw new Error(`Refusing to use QUBE config through a symbolic link or directory junction: ${currentPath}.`);
    }

    const isLeaf = index === segments.length - 1;
    if (isLeaf ? !status.isFile() : !status.isDirectory()) {
      throw new Error(
        isLeaf
          ? `Refusing to use QUBE config at a non-file path: ${currentPath}.`
          : `Refusing to use QUBE config through a non-directory parent: ${currentPath}.`,
      );
    }
    if (isLeaf) return status;
  }
  return undefined;
}

function readQubeConfigPathStatus(filePath: string): Stats | undefined {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Failed to inspect QUBE config path ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function cloneReview(review: NonNullable<QubeInitConfig["review"]>): NonNullable<QubeInitConfig["review"]> {
  return Object.freeze({
    ...review,
    ...(review.externalReviewers ? { externalReviewers: Object.freeze([...review.externalReviewers]) } : {}),
    ...(review.models ? { models: Object.freeze([...review.models]) } : {}),
  });
}

export function isEmptyQubeInitConfig(config: QubeInitConfig): boolean {
  return Object.keys(config).length === 1 && config.version === 1;
}

export function sameQubeInitFieldValue(field: QubeInitField, left: unknown, right: unknown): boolean {
  const definition = QUBE_INIT_FIELD_REGISTRY.find(candidate => candidate.id === field)!;
  return sameLayeredValue(left, right, definition.comparison);
}

function isQubeInitFieldApplicable(config: RequiredQubeInitConfig, field: QubeInitField): boolean {
  if (field === "review.harness") return config.review.mode === "isolated";
  if (field === "review.externalReviewers") return config.review.mode === "external";
  if (field === "review.models") return config.review.mode !== "external";
  return true;
}

function layerValue(value: unknown): QubeInitFieldLayerValue {
  return Object.freeze(value === undefined ? { present: false } : { present: true, value });
}

function repositoryFieldAction(
  field: QubeInitField,
  current: unknown,
  planned: unknown,
): QubeRepositoryFieldAction {
  if (current === undefined) return planned === undefined ? "keep" : "add";
  if (planned === undefined) return "remove";
  return sameQubeInitFieldValue(field, current, planned) ? "keep" : "update";
}

function readField(config: QubeInitConfig, field: QubeInitField): unknown {
  switch (field) {
    case "hosts": return config.hosts;
    case "workProviders": return config.workProviders;
    case "ciProviders": return config.ciProviders;
    case "continuousShipping": return config.continuousShipping;
    case "umpire.scope": return config.umpire?.scope;
    case "quality.stages": return config.quality?.stages;
    case "review.mode": return config.review?.mode;
    case "review.harness": return config.review?.harness;
    case "review.externalReviewers": return config.review?.externalReviewers;
    case "review.publisher": return config.review?.publisher;
    case "review.models": return config.review?.models;
    case "mcp.optIn": return config.mcp?.optIn;
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireRecord(value, name);
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${name} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
}

function readStringList(value: unknown, name: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`${name} must be ${allowEmpty ? "a" : "a non-empty"} string array.`);
  }
  return Object.freeze([...new Set(value.map((item) => (item as string).trim()))]);
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string.`);
  return value.trim();
}

function readChoice<Value extends string>(value: unknown, values: readonly Value[], name: string): Value {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new TypeError(`${name} must be one of: ${values.join(", ")}.`);
  }
  return value as Value;
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean.`);
  return value;
}
