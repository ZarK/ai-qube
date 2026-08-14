import { readFileSync } from "node:fs";

import { packageInstallSpecs, type InstallPackageSelections } from "./install_packages.js";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_AGE_DAYS = 7;
const SENSITIVE_AGE_DAYS = 14;
const DEFAULT_TIMEOUT_MS = 10_000;
const LIFECYCLE_SCRIPT_NAMES = Object.freeze([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepare",
  "prepack",
  "postpack"
]);

export const INSTALL_REGISTRY_DEFAULT_AGE_DAYS = DEFAULT_AGE_DAYS;
export const INSTALL_REGISTRY_SENSITIVE_AGE_DAYS = SENSITIVE_AGE_DAYS;
export const DEFAULT_PACKAGE_AGE_DAYS = DEFAULT_AGE_DAYS;
export const SENSITIVE_PACKAGE_AGE_DAYS = SENSITIVE_AGE_DAYS;

export type RegistryGateReason =
  | "ok"
  | "offline"
  | "unverified-identity"
  | "missing-version"
  | "too-new"
  | "unverifiable-age"
  | "missing-provenance"
  | "unverified-provenance"
  | "lifecycle-scripts"
  | "unverified-registry";

export interface InstallPackageRef {
  readonly name: string;
  readonly version: string;
}

export interface RegistryPackageCheck {
  readonly name: string;
  readonly version: string;
  readonly status: "passed" | "planned";
  readonly reasonCode: RegistryGateReason;
  readonly summary: string;
  readonly ageDaysRequired: number;
}

export interface RegistryCheckResult {
  readonly id: "identity" | "age" | "provenance" | "scripts" | "registry";
  readonly status: "pass" | "fail";
  readonly summary: string;
}

export interface RegistryGateResult {
  readonly status: "passed" | "plan-only";
  readonly reason?: string;
  readonly packages: readonly RegistryPackageCheck[];
  readonly checks: readonly RegistryCheckResult[];
  readonly summary: string;
}

export interface RegistryGateOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly registryUrl?: string;
  readonly offline?: boolean;
  readonly timeoutMs?: number;
}

interface PackumentVersion {
  readonly name?: string;
  readonly version?: string;
  readonly scripts?: Readonly<Record<string, string | undefined>>;
  readonly hasInstallScript?: boolean;
  readonly dist?: {
    readonly integrity?: string;
    readonly tarball?: string;
    readonly attestations?: {
      readonly url?: string;
      readonly provenance?: { readonly predicateType?: string };
    };
  };
}

export interface Packument {
  readonly name?: string;
  readonly "dist-tags"?: Readonly<Record<string, string | undefined>>;
  readonly versions?: Readonly<Record<string, PackumentVersion | undefined>>;
  readonly time?: Readonly<Record<string, string | undefined>>;
  readonly attestations?: Readonly<Record<string, unknown>>;
}

export function parseExactPackageSpec(spec: string): InstallPackageRef | undefined {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return undefined;
  const name = spec.slice(0, at).trim();
  const version = spec.slice(at + 1).trim();
  if (name === "" || !EXACT_VERSION.test(version)) return undefined;
  return { name, version };
}

export function requiredPublishAgeDays(name: string): number {
  return name.startsWith("@tjalve/") ? SENSITIVE_AGE_DAYS : DEFAULT_AGE_DAYS;
}

export const requiredPackageAgeDays = requiredPublishAgeDays;
export const parsePackageSpec = parseExactPackageSpec;
export const createFixtureRegistryFetch = createPackumentFetch;

export async function verifyInstallRegistryPackages(
  specs: readonly string[],
  options: RegistryGateOptions = {},
): Promise<RegistryGateResult> {
  const packages: RegistryPackageCheck[] = [];
  for (const spec of specs) {
    const parsed = parseExactPackageSpec(spec);
    if (!parsed) {
      packages.push(plannedCheck(spec, "unknown", "unverified-identity", "Package specifier is not an exact name@version pin.", DEFAULT_AGE_DAYS));
      continue;
    }
    packages.push(await verifyOnePackage(parsed, options));
  }
  const failed = packages.filter(item => item.status !== "passed");
  const checks = collectRegistryChecks(packages);
  if (failed.length === 0) {
    return Object.freeze({
      status: "passed",
      packages: Object.freeze(packages),
      checks,
      summary: "Registry identity, age, provenance, and lifecycle checks passed.",
    });
  }
  const summary = failed.map(item => item.summary).join(" ");
  return Object.freeze({
    status: "plan-only",
    reason: summary,
    packages: Object.freeze(packages),
    checks,
    summary,
  });
}

export async function verifyInstallRegistryGate(input: {
  readonly selections: InstallPackageSelections;
  readonly env: NodeJS.ProcessEnv;
  readonly offline?: boolean;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
}): Promise<RegistryGateResult> {
  const offline = input.offline === true
    || input.env.QUBE_INSTALL_OFFLINE === "1"
    || input.env.npm_config_offline === "true"
    || input.env.QUBE_TEST_REGISTRY === "offline";
  let fetchImpl = input.fetchImpl;
  const fixturePath = input.env.QUBE_TEST_INSTALL_PACKAGES;
  const testMode = input.env.QUBE_TEST_REGISTRY?.trim();
  const useFixtures = Boolean(fetchImpl)
    || Boolean(fixturePath && fixturePath.trim() !== "")
    || Boolean(input.env.QUBE_TEST_PACKAGE_ROOT)
    || Boolean(testMode);
  if (!fetchImpl && typeof fixturePath === "string" && fixturePath.trim() !== "") {
    try {
      const packuments = JSON.parse(readFileSync(fixturePath, "utf8")) as Readonly<Record<string, Packument>>;
      fetchImpl = createPackumentFetch(packuments);
    } catch {
      return Object.freeze({
        status: "plan-only",
        reason: "Install registry fixture is unverifiable.",
        packages: Object.freeze([]),
        checks: Object.freeze([]),
        summary: "Install registry fixture is unverifiable.",
      });
    }
  } else if (!fetchImpl && useFixtures && testMode !== "offline") {
    fetchImpl = createPackumentFetch(createTestPackuments(input.selections, testMode ?? "pass", (input.now ?? Date.now)()));
  }
  return verifyInstallRegistryPackages(packageInstallSpecs(input.selections), {
    fetchImpl,
    now: input.now,
    registryUrl: input.env.QUBE_INSTALL_REGISTRY ?? input.env.npm_config_registry,
    offline,
  });
}

function createTestPackuments(
  selections: InstallPackageSelections,
  mode: string,
  now: number,
): Readonly<Record<string, Packument>> {
  const packuments: Record<string, Packument> = {};
  const publishedAt = mode === "too-new"
    ? new Date(now - 60 * 60 * 1000).toISOString()
    : new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  for (const spec of packageInstallSpecs(selections)) {
    const parsed = parseExactPackageSpec(spec);
    if (!parsed) continue;
    packuments[parsed.name] = createPassingPackument(parsed.name, parsed.version, {
      publishedAt,
      scripts: mode === "scripts" ? { postinstall: "node -e \"process.exit(0)\"" } : undefined,
      omitAttestations: mode === "no-provenance",
    });
  }
  return packuments;
}

function collectRegistryChecks(packages: readonly RegistryPackageCheck[]): readonly RegistryCheckResult[] {
  const ids = ["identity", "age", "provenance", "scripts", "registry"] as const;
  return Object.freeze(ids.map(id => {
    const failed = packages.filter(pkg => checkIdForReason(pkg.reasonCode) === id);
    return Object.freeze({
      id,
      status: failed.length > 0 ? "fail" : "pass",
      summary: failed[0]?.summary ?? `${id} passed.`,
    });
  }));
}

function checkIdForReason(reason: RegistryGateReason): RegistryCheckResult["id"] | undefined {
  switch (reason) {
    case "unverified-identity":
    case "missing-version":
      return "identity";
    case "too-new":
    case "unverifiable-age":
      return "age";
    case "missing-provenance":
    case "unverified-provenance":
      return "provenance";
    case "lifecycle-scripts":
      return "scripts";
    case "offline":
    case "unverified-registry":
      return "registry";
    default:
      return undefined;
  }
}

export function createPassingPackument(
  name: string,
  version: string,
  options: {
    readonly publishedAt?: string;
    readonly scripts?: Readonly<Record<string, string>>;
    readonly hasInstallScript?: boolean;
    readonly integrity?: string;
    readonly tarballHost?: string;
    readonly omitAttestations?: boolean;
    readonly omitDistTags?: boolean;
    readonly distTags?: Readonly<Record<string, string | undefined>>;
    readonly subjectDigest?: string;
    readonly attestationPredicateType?: string;
  } = {},
): Packument {
  const integrity = options.integrity ?? `sha512-${Buffer.from(`${name}@${version}`, "utf8").toString("base64")}`;
  const hex = Buffer.from(`${name}@${version}`, "utf8").toString("hex");
  const registry = options.tarballHost ?? DEFAULT_REGISTRY;
  const attestationUrl = `${registry}/-/npm/v1/attestations/${name}@${version}`;
  const publishedAt = options.publishedAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    name,
    ...(options.omitDistTags === true ? {} : { "dist-tags": options.distTags ?? { latest: version } }),
    time: { [version]: publishedAt },
    versions: {
      [version]: {
        name,
        version,
        scripts: options.scripts,
        hasInstallScript: options.hasInstallScript,
        dist: {
          integrity,
          tarball: `${registry}/${name}/-/${name.split("/").pop()}-${version}.tgz`,
          ...(options.omitAttestations === true ? {} : { attestations: { url: attestationUrl, provenance: { predicateType: "https://slsa.dev/provenance/v1" } } }),
        },
      },
    },
    attestations: {
      [version]: {
        attestations: [
          {
            predicateType: options.attestationPredicateType ?? "https://slsa.dev/provenance/v1",
            subject: [{ digest: { sha512: options.subjectDigest ?? hex } }],
          },
        ],
      },
    },
  };
}

export function createPackumentFetch(packuments: Readonly<Record<string, Packument>>): typeof fetch {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const attestation = parseAttestationPath(url.pathname);
    if (attestation) {
      const packument = packuments[attestation.name];
      const document = packument?.attestations?.[attestation.version];
      if (!document) return jsonResponse(404, { error: "Not found" });
      return jsonResponse(200, document);
    }
    const name = decodePackumentName(url.pathname);
    const packument = name ? packuments[name] : undefined;
    if (!packument) return jsonResponse(404, { error: "Not found" });
    return jsonResponse(200, packument);
  };
}

async function verifyOnePackage(pkg: InstallPackageRef, options: RegistryGateOptions): Promise<RegistryPackageCheck> {
  const ageDaysRequired = requiredPublishAgeDays(pkg.name);
  if (options.offline === true) {
    return plannedCheck(pkg.name, pkg.version, "offline", `${pkg.name}@${pkg.version} is unverifiable offline.`, ageDaysRequired);
  }
  const registryUrl = normalizeRegistryUrl(options.registryUrl ?? DEFAULT_REGISTRY);
  if (!registryUrl) {
    return plannedCheck(pkg.name, pkg.version, "unverified-registry", `${pkg.name}@${pkg.version} registry origin is unverifiable.`, ageDaysRequired);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let packument: Packument;
  try {
    packument = await readJson<Packument>(
      fetchImpl,
      packumentUrl(registryUrl, pkg.name),
      timeoutMs,
    );
  } catch (error) {
    return plannedCheck(
      pkg.name,
      pkg.version,
      classifyFetchFailure(error),
      `${pkg.name}@${pkg.version} registry metadata is unverifiable.`,
      ageDaysRequired,
    );
  }
  if (packument.name !== pkg.name) {
    return plannedCheck(pkg.name, pkg.version, "unverified-identity", `${pkg.name}@${pkg.version} packument name does not match the requested package.`, ageDaysRequired);
  }
  const distTagError = distTagIdentityError(pkg, packument);
  if (distTagError) {
    return plannedCheck(pkg.name, pkg.version, "unverified-identity", distTagError, ageDaysRequired);
  }
  const versionDoc = packument.versions?.[pkg.version];
  if (!versionDoc) {
    return plannedCheck(pkg.name, pkg.version, "missing-version", `${pkg.name}@${pkg.version} does not exist on the registry.`, ageDaysRequired);
  }
  if (versionDoc.name !== undefined && versionDoc.name !== pkg.name) {
    return plannedCheck(pkg.name, pkg.version, "unverified-identity", `${pkg.name}@${pkg.version} version document name does not match the requested package.`, ageDaysRequired);
  }
  if (versionDoc.version !== undefined && versionDoc.version !== pkg.version) {
    return plannedCheck(pkg.name, pkg.version, "unverified-identity", `${pkg.name}@${pkg.version} version document does not match the requested version.`, ageDaysRequired);
  }
  const tarball = versionDoc.dist?.tarball;
  if (typeof tarball !== "string" || !sameRegistryOrigin(registryUrl, tarball)) {
    return plannedCheck(pkg.name, pkg.version, "unverified-identity", `${pkg.name}@${pkg.version} tarball is not on the configured registry origin.`, ageDaysRequired);
  }
  const integrity = versionDoc.dist?.integrity;
  if (typeof integrity !== "string" || integrity.trim() === "") {
    return plannedCheck(pkg.name, pkg.version, "unverified-identity", `${pkg.name}@${pkg.version} is missing a registry integrity digest.`, ageDaysRequired);
  }
  if (hasLifecycleScripts(versionDoc)) {
    return plannedCheck(pkg.name, pkg.version, "lifecycle-scripts", `${pkg.name}@${pkg.version} declares install lifecycle scripts.`, ageDaysRequired);
  }
  const publishedAt = packument.time?.[pkg.version];
  const publishedMs = typeof publishedAt === "string" ? Date.parse(publishedAt) : Number.NaN;
  if (!Number.isFinite(publishedMs)) {
    return plannedCheck(pkg.name, pkg.version, "unverifiable-age", `${pkg.name}@${pkg.version} publish time is unverifiable.`, ageDaysRequired);
  }
  const now = (options.now ?? Date.now)();
  const ageMs = now - publishedMs;
  if (ageMs < 0) {
    return plannedCheck(pkg.name, pkg.version, "unverifiable-age", `${pkg.name}@${pkg.version} publish time is unverifiable.`, ageDaysRequired);
  }
  if (ageMs < ageDaysRequired * 24 * 60 * 60 * 1000) {
    return plannedCheck(pkg.name, pkg.version, "too-new", `${pkg.name}@${pkg.version} is newer than the ${ageDaysRequired}-day publish-age gate.`, ageDaysRequired);
  }
  const attestations = versionDoc.dist?.attestations;
  const attestationUrl = typeof attestations?.url === "string" ? attestations.url : undefined;
  if (!attestationUrl) {
    return plannedCheck(pkg.name, pkg.version, "missing-provenance", `${pkg.name}@${pkg.version} has no provenance attestation.`, ageDaysRequired);
  }
  if (!sameRegistryOrigin(registryUrl, attestationUrl)) {
    return plannedCheck(pkg.name, pkg.version, "unverified-provenance", `${pkg.name}@${pkg.version} provenance URL is not on the configured registry origin.`, ageDaysRequired);
  }
  let attestationDoc: unknown;
  try {
    attestationDoc = await readJson<unknown>(fetchImpl, attestationUrl, timeoutMs);
  } catch {
    return plannedCheck(pkg.name, pkg.version, "unverified-provenance", `${pkg.name}@${pkg.version} provenance attestation is unverifiable.`, ageDaysRequired);
  }
  if (!attestationMatchesIntegrity(attestationDoc, integrity)) {
    return plannedCheck(pkg.name, pkg.version, "unverified-provenance", `${pkg.name}@${pkg.version} provenance subject does not match the registry integrity digest.`, ageDaysRequired);
  }
  return Object.freeze({
    name: pkg.name,
    version: pkg.version,
    status: "passed",
    reasonCode: "ok",
    summary: `${pkg.name}@${pkg.version} passed registry identity, age, provenance, and lifecycle checks.`,
    ageDaysRequired,
  });
}

function distTagIdentityError(pkg: InstallPackageRef, packument: Packument): string | undefined {
  const distTags = packument["dist-tags"];
  if (distTags === undefined || distTags === null || typeof distTags !== "object" || Array.isArray(distTags)) {
    return `${pkg.name}@${pkg.version} packument is missing dist-tag identity.`;
  }
  const versions = packument.versions ?? {};
  for (const [tag, taggedVersion] of Object.entries(distTags)) {
    if (typeof taggedVersion !== "string" || !EXACT_VERSION.test(taggedVersion)) {
      return `${pkg.name}@${pkg.version} dist-tag ${tag} is not an exact version.`;
    }
    if (!versions[taggedVersion]) {
      return `${pkg.name}@${pkg.version} dist-tag ${tag} points at missing version ${taggedVersion}.`;
    }
  }
  return undefined;
}

function hasLifecycleScripts(versionDoc: PackumentVersion): boolean {
  if (versionDoc.hasInstallScript === true) return true;
  const scripts = versionDoc.scripts ?? {};
  return LIFECYCLE_SCRIPT_NAMES.some(name => {
    const value = scripts[name];
    return typeof value === "string" && value.trim() !== "";
  });
}

function attestationMatchesIntegrity(document: unknown, integrity: string): boolean {
  const expectedHex = integrityHex(integrity);
  if (!expectedHex) return false;
  if (document === null || typeof document !== "object" || Array.isArray(document)) return false;
  const record = document as {
    readonly attestations?: readonly unknown[];
    readonly subject?: readonly unknown[];
    readonly subjectDigest?: string;
  };
  if (!Array.isArray(record.attestations) || !record.attestations.some(isProvenanceAttestation)) {
    return false;
  }
  if (typeof record.subjectDigest === "string" && normalizeHex(record.subjectDigest) === expectedHex) {
    return true;
  }
  const subjects = [
    ...(Array.isArray(record.subject) ? record.subject : []),
    ...record.attestations.flatMap(attestationSubjects),
  ];
  return subjects.some(subject => subjectDigestHex(subject) === expectedHex);
}

function isProvenanceAttestation(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const predicateType = (value as { readonly predicateType?: unknown }).predicateType;
  return typeof predicateType === "string" && predicateType.includes("slsa.dev/provenance");
}

function attestationSubjects(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as {
    readonly subject?: readonly unknown[];
    readonly bundle?: { readonly dsseEnvelope?: { readonly payload?: string } };
  };
  const fromField = Array.isArray(record.subject) ? record.subject : [];
  const payload = record.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string" || payload.trim() === "") return fromField;
  try {
    const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { readonly subject?: unknown };
    if (Array.isArray(statement.subject)) return [...fromField, ...statement.subject];
  } catch {
    return fromField;
  }
  return fromField;
}

function subjectDigestHex(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const digest = (value as { readonly digest?: Readonly<Record<string, string | undefined>> }).digest;
  const hex = digest?.sha512 ?? digest?.sha256;
  return typeof hex === "string" ? normalizeHex(hex) : undefined;
}

function integrityHex(integrity: string): string | undefined {
  const match = /^(sha512|sha256)-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  if (!match) return undefined;
  try {
    return Buffer.from(match[2], "base64").toString("hex");
  } catch {
    return undefined;
  }
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}

function plannedCheck(
  name: string,
  version: string,
  reasonCode: Exclude<RegistryGateReason, "ok">,
  summary: string,
  ageDaysRequired: number,
): RegistryPackageCheck {
  return Object.freeze({
    name,
    version,
    status: "planned",
    reasonCode,
    summary,
    ageDaysRequired,
  });
}

function normalizeRegistryUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

function sameRegistryOrigin(registryUrl: string, candidate: string): boolean {
  try {
    return new URL(candidate).origin === new URL(registryUrl).origin;
  } catch {
    return false;
  }
}

function packumentUrl(registryUrl: string, name: string): string {
  return `${registryUrl}/${name.split("/").map(part => encodeURIComponent(part)).join("/")}`;
}

function decodePackumentName(pathname: string): string | undefined {
  const trimmed = pathname.replace(/^\/+/, "");
  if (trimmed === "" || trimmed.startsWith("-/")) return undefined;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return undefined;
  }
}

function parseAttestationPath(pathname: string): { readonly name: string; readonly version: string } | undefined {
  const match = /^\/-\/npm\/v1\/attestations\/(.+)$/.exec(pathname);
  if (!match) return undefined;
  let rest: string;
  try {
    rest = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  const at = rest.lastIndexOf("@");
  if (at <= 0) return undefined;
  return { name: rest.slice(0, at), version: rest.slice(at + 1) };
}

async function readJson<T>(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<T> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const error = new Error(`Registry GET ${url} failed with HTTP ${response.status}.`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return await response.json() as T;
}

function classifyFetchFailure(error: unknown): Exclude<RegistryGateReason, "ok"> {
  if (error instanceof Error && "status" in error && (error as Error & { status?: number }).status === 404) {
    return "missing-version";
  }
  return "unverified-registry";
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
