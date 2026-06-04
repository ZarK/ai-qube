export interface JavaScriptTestArgsOptions {
  coverageDirectory: string;
  mode: "coverage" | "unit";
  reportPath: string;
  runner: "jest" | "vitest";
}

export function createPlaywrightTestArgs(): string[] {
  return ["test", "--reporter=json"];
}

export function createDirectJavaScriptTestArgs(options: JavaScriptTestArgsOptions): string[] {
  const { coverageDirectory, mode, reportPath, runner } = options;

  if (runner === "vitest") {
    const args = [
      "--passWithNoTests",
      "--reporter=json",
      `--outputFile=${reportPath}`,
      "--run",
      "--pool=threads",
      "--poolOptions.threads.maxThreads=1",
      "--poolOptions.threads.minThreads=1",
      "--no-file-parallelism",
    ];
    if (mode === "coverage") {
      args.push(
        "--coverage",
        "--coverage.provider=v8",
        `--coverage.reportsDirectory=${coverageDirectory}`,
        "--coverage.reporter=json-summary",
      );
    }

    return args;
  }

  const args = ["--passWithNoTests", "--runInBand", "--json", `--outputFile=${reportPath}`];
  if (mode === "coverage") {
    args.push(
      "--coverage",
      `--coverageDirectory=${coverageDirectory}`,
      "--coverageReporters=json-summary",
    );
  }

  return args;
}

export function createJavaScriptTestArgs(options: JavaScriptTestArgsOptions): string[] {
  return ["test", "--", ...createDirectJavaScriptTestArgs(options)];
}

export interface PythonTestArgsOptions {
  coveragePath: string;
  junitPath: string;
  mode: "coverage" | "unit";
}

export function createPythonTestArgs(options: PythonTestArgsOptions): string[] {
  const { coveragePath, junitPath, mode } = options;
  const args = ["-m", "pytest", "--junitxml", junitPath, "-q"];
  if (mode === "coverage") {
    args.push("-p", "pytest_cov", "--cov=.", "--cov-report", `json:${coveragePath}`);
  }

  return args;
}

export interface BiomeLintCommandOptions {
  files: string[];
}

export function createBiomeLintArgs(options: BiomeLintCommandOptions): string[] {
  return ["lint", "--reporter=json", ...options.files];
}

export interface BiomeFormatCommandOptions {
  files: string[];
}

export function createBiomeFormatArgs(options: BiomeFormatCommandOptions): string[] {
  return ["format", "--reporter=json", ...options.files];
}

export interface ShellcheckCommandOptions {
  files: string[];
}

export function createShellcheckArgs(options: ShellcheckCommandOptions): string[] {
  return ["-f", "json1", ...options.files];
}

export interface ShfmtCommandOptions {
  files: string[];
}

export function createShfmtArgs(options: ShfmtCommandOptions): string[] {
  return ["-l", ...options.files];
}

export interface RuffCheckCommandOptions {
  files: string[];
}

export function createRuffCheckArgs(options: RuffCheckCommandOptions): string[] {
  return ["-m", "ruff", "check", "--output-format", "json", ...options.files];
}

export interface RuffFormatCommandOptions {
  files: string[];
}

export function createRuffFormatArgs(options: RuffFormatCommandOptions): string[] {
  return ["-m", "ruff", "format", ...options.files, "--check"];
}

export interface TyCheckCommandOptions {
  files: string[];
  pythonPath: string;
}

export function createTyCheckArgs(options: TyCheckCommandOptions): string[] {
  return [
    "check",
    "--python",
    options.pythonPath,
    "--output-format",
    "gitlab",
    "--no-progress",
    "--color",
    "never",
    ...options.files,
  ];
}

export interface TyCommandOptions {
  files: string[];
}

export function createTyArgs(options: TyCommandOptions): string[] {
  return ["check", "--output-format", "gitlab", ...options.files];
}

export interface GoVetCommandOptions {
  packages?: string[];
}

export function createGoVetArgs(options: GoVetCommandOptions = {}): string[] {
  return ["vet", "-json", ...(options.packages ?? ["./..."])];
}

export interface GoBuildCommandOptions {
  packages?: string[];
}

export function createGoBuildArgs(options: GoBuildCommandOptions = {}): string[] {
  return ["build", ...(options.packages ?? ["./..."])];
}

export interface GoTestCommandOptions {
  coverageProfile?: string;
  json?: boolean;
  packages?: string[];
}

export function createGoTestArgs(options: GoTestCommandOptions = {}): string[] {
  const args = ["test"];
  if (options.json ?? true) {
    args.push("-json");
  }
  if (options.coverageProfile !== undefined) {
    args.push(`-coverprofile=${options.coverageProfile}`);
  }
  args.push(...(options.packages ?? ["./..."]));
  return args;
}

export interface GoCoverageArgsOptions {
  func: string;
}

export function createGoCoverageArgs(options: GoCoverageArgsOptions): string[] {
  return ["tool", "cover", `-func=${options.func}`];
}

export interface GofmtCommandOptions {
  files: string[];
}

export function createGofmtArgs(options: GofmtCommandOptions): string[] {
  return ["-l", ...options.files];
}

export interface CargoClippyCommandOptions {
  workspace?: boolean;
}

export function createCargoClippyArgs(options: CargoClippyCommandOptions = {}): string[] {
  return [
    "clippy",
    ...((options.workspace ?? true) ? ["--workspace"] : []),
    "--all-targets",
    "--message-format=json",
    "--",
    "-D",
    "warnings",
  ];
}

export interface CargoCheckCommandOptions {
  workspace?: boolean;
}

export function createCargoCheckArgs(options: CargoCheckCommandOptions = {}): string[] {
  return [
    "check",
    ...((options.workspace ?? true) ? ["--workspace"] : []),
    "--all-targets",
    "--message-format=json",
  ];
}

export interface CargoFmtCommandOptions {
  all?: boolean;
  check?: boolean;
}

export function createCargoFmtArgs(options: CargoFmtCommandOptions = {}): string[] {
  const args = ["fmt"];
  if (options.all ?? true) {
    args.push("--all");
  }
  if (options.check ?? true) {
    args.push("--check");
  }
  return args;
}

export interface CargoTestCommandOptions {
  json?: boolean;
  workspace?: boolean;
}

export function createCargoTestArgs(options: CargoTestCommandOptions = {}): string[] {
  return [
    "test",
    ...((options.workspace ?? true) ? ["--workspace"] : []),
    ...((options.json ?? true) ? ["--message-format=json"] : []),
  ];
}

export interface CargoLlvmCovCommandOptions {
  lcovPath?: string;
  workspace?: boolean;
}

export function createCargoLlvmCovArgs(options: CargoLlvmCovCommandOptions = {}): string[] {
  const args = ["llvm-cov"];
  if (options.workspace ?? true) {
    args.push("--workspace");
  }
  if (options.lcovPath !== undefined) {
    args.push("--lcov", "--output-path", options.lcovPath);
  }
  return args;
}

export interface DotNetFormatCommandOptions {
  reportDir: string;
  subcommand: "style" | "whitespace";
  targetPath: string;
  verifyNoChanges?: boolean;
}

export function createDotNetFormatArgs(options: DotNetFormatCommandOptions): string[] {
  return [
    "format",
    options.targetPath,
    options.subcommand,
    ...((options.verifyNoChanges ?? true) ? ["--verify-no-changes"] : []),
    "--report",
    options.reportDir,
    "--verbosity",
    "minimal",
  ];
}

export interface DotNetBuildCommandOptions {
  errorLog?: string;
  nologo?: boolean;
  targetPath: string;
  verbosity?: string;
}

export function createDotNetBuildArgs(options: DotNetBuildCommandOptions): string[] {
  const args = ["build", options.targetPath];
  if (options.nologo ?? true) {
    args.push("--nologo");
  }
  if (options.verbosity !== undefined) {
    args.push("--verbosity", options.verbosity);
  }
  if (options.errorLog !== undefined) {
    args.push(`/p:ErrorLog=${options.errorLog}`);
  }
  return args;
}

export interface DotNetTestCommandOptions {
  logger?: string;
  nologo?: boolean;
  resultsDir?: string;
  targetPath: string;
  verbosity?: string;
}

export function createDotNetTestArgs(options: DotNetTestCommandOptions): string[] {
  const args = ["test", options.targetPath];
  if (options.nologo ?? true) {
    args.push("--nologo");
  }
  if (options.verbosity !== undefined) {
    args.push("--verbosity", options.verbosity);
  }
  if (options.resultsDir !== undefined) {
    args.push("--results-directory", options.resultsDir);
  }
  if (options.logger !== undefined) {
    args.push("--logger", options.logger);
  }
  return args;
}

export interface TerraformFmtCommandOptions {
  check?: boolean;
  files?: string[];
}

export function createTerraformFmtArgs(options: TerraformFmtCommandOptions = {}): string[] {
  const args = ["fmt"];
  if (options.check ?? true) {
    args.push("-check");
  }
  if (options.files !== undefined && options.files.length > 0) {
    args.push(...options.files);
  }
  return args;
}

export interface TerraformInitCommandOptions {
  disableBackend?: boolean;
  disableInput?: boolean;
  noColor?: boolean;
}

export function createTerraformInitArgs(options: TerraformInitCommandOptions = {}): string[] {
  const args = ["init"];
  if (options.disableBackend ?? false) {
    args.push("-backend=false");
  }
  if (options.disableInput ?? false) {
    args.push("-input=false");
  }
  if (options.noColor ?? true) {
    args.push("-no-color");
  }
  return args;
}

export interface TerraformValidateCommandOptions {
  json?: boolean;
  noColor?: boolean;
}

export function createTerraformValidateArgs(
  options: TerraformValidateCommandOptions = {},
): string[] {
  return [
    "validate",
    ...((options.json ?? true) ? ["-json"] : []),
    ...((options.noColor ?? true) ? ["-no-color"] : []),
  ];
}

export interface TscCommandOptions {
  noEmit?: boolean;
  pretty?: boolean;
  project: string;
}

export function createTscArgs(options: TscCommandOptions): string[] {
  return [
    ...((options.noEmit ?? true) ? ["--noEmit"] : []),
    ...((options.pretty ?? false) ? [] : ["--pretty", "false"]),
    "--project",
    options.project,
  ];
}

export interface LizardCommandOptions {
  inputFile: string;
  languages: string[];
  workingThreads?: number;
}

export function createLizardArgs(options: LizardCommandOptions): string[] {
  const args = [
    "lizard",
    "--csv",
    ...options.languages.flatMap((lang) => ["-l", lang]),
    "--input_file",
    options.inputFile,
    "--working_threads",
    String(options.workingThreads ?? 1),
  ];
  return args;
}

export interface MavenCommandOptions {
  args: string[];
  wrapper?: boolean;
}

export interface GradleCommandOptions {
  args: string[];
  console?: string;
  noDaemon?: boolean;
  projectCacheDir?: string;
  wrapper?: boolean;
}
