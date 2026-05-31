import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { ToolExecutionError, type ToolDefinition } from "@clero-local-agent/mcp-runtime";
import type { JsonObject } from "@clero-local-agent/protocol";

export type WorkspacePolicyOptions = {
  allowedDirectories: string[];
};

export class WorkspacePolicy {
  private readonly allowedDirectories: string[];
  private readonly unavailableDirectories: string[];

  constructor(options: WorkspacePolicyOptions) {
    const configuredDirectories = uniqueStrings(
      options.allowedDirectories.filter((directory) => directory.trim().length > 0).map((directory) => path.resolve(directory))
    );
    const allowedDirectories: string[] = [];
    const unavailableDirectories: string[] = [];

    for (const directory of configuredDirectories) {
      const resolved = tryRealpath(directory);
      if (resolved) {
        allowedDirectories.push(resolved);
      } else {
        unavailableDirectories.push(directory);
      }
    }

    this.allowedDirectories = uniqueStrings(allowedDirectories);
    this.unavailableDirectories = uniqueStrings(unavailableDirectories);
  }

  resolveAllowedDirectory(candidate?: string): string {
    if (!candidate || candidate.trim() === "." || candidate.trim() === "") {
      return this.defaultDirectory();
    }

    const resolved = this.resolveCandidateDirectory(candidate);
    if (!this.isAllowed(resolved)) {
      throw new ToolExecutionError(
        "invalid_arguments",
        `Path is outside allowed workspaces: ${candidate}. Allowed roots: ${this.allowedDirectories.join(", ")}`,
        { allowed_roots: this.listAllowedDirectories() }
      );
    }

    return resolved;
  }

  isAllowed(candidate: string): boolean {
    const resolved = resolveExistingCwd(candidate);
    return this.isResolvedPathAllowed(resolved);
  }

  private isResolvedPathAllowed(resolved: string): boolean {
    return this.allowedDirectories.some((allowed) => resolved === allowed || resolved.startsWith(`${allowed}${path.sep}`));
  }

  private resolveCandidateDirectory(candidate: string): string {
    if (this.allowedDirectories.length === 0) {
      throw this.noAllowedDirectoriesError();
    }

    const trimmed = candidate.trim();
    const directCandidates = path.isAbsolute(trimmed)
      ? [trimmed]
      : [path.resolve(trimmed), ...this.allowedDirectories.map((root) => path.join(root, trimmed))];

    for (const directCandidate of uniqueStrings(directCandidates)) {
      const resolved = tryRealpath(directCandidate);
      if (!resolved) {
        continue;
      }
      if (!this.isResolvedPathAllowed(resolved)) {
        throw new ToolExecutionError(
          "invalid_arguments",
          `Path is outside allowed workspaces: ${candidate}. Allowed roots: ${this.allowedDirectories.join(", ")}`,
          { allowed_roots: this.listAllowedDirectories() }
        );
      }
      return resolved;
    }

    const lookup = projectLookupName(trimmed);
    if (lookup) {
      const matches = this.findProjectMatches(lookup);
      if (matches.length === 1) {
        return matches[0]!;
      }
      if (matches.length > 1) {
        throw new ToolExecutionError(
          "invalid_arguments",
          `Project name is ambiguous: ${lookup}. Use one of: ${matches.join(", ")}`,
          { matches }
        );
      }
    }

    throw new ToolExecutionError(
      "invalid_arguments",
      `cwd does not exist: ${candidate}. Use workspace.list_projects and pass the returned project key/name.`,
      { allowed_roots: this.listAllowedDirectories(), project: lookup }
    );
  }

  resolveProjectDirectory(candidate?: string): string {
    if (candidate && candidate.trim() !== "." && candidate.trim() !== "") {
      return this.resolveAllowedDirectory(candidate);
    }

    const defaultDirectory = this.defaultDirectory();
    if (directoryHasProjectMarkers(defaultDirectory)) {
      return defaultDirectory;
    }

    const projects = this.findProjects();
    if (projects.length === 1) {
      return projects[0]!;
    }
    if (projects.length > 1) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "No project was selected. Use workspace.list_projects and pass one returned project key/name.",
        {
          allowed_roots: this.listAllowedDirectories(),
          projects: projects.slice(0, 20).map((projectPath) => this.projectSuggestion(projectPath))
        }
      );
    }

    return defaultDirectory;
  }

  private projectSuggestion(projectPath: string): JsonObject {
    const root = this.allowedDirectories.find((allowedRoot) => projectPath === allowedRoot || projectPath.startsWith(`${allowedRoot}${path.sep}`));
    return {
      project: path.relative(root ?? this.defaultDirectory(), projectPath) || path.basename(projectPath),
      path: projectPath
    };
  }

  private findProjectMatches(lookup: string): string[] {
    const matches: string[] = [];
    for (const root of this.allowedDirectories) {
      scanProjectsSync({
        current: root,
        depth: 0,
        maxDepth: 5,
        lookup,
        matches
      });
    }
    return uniqueStrings(matches);
  }

  private findProjects(): string[] {
    const projects: string[] = [];
    for (const root of this.allowedDirectories) {
      scanProjectDirectoriesSync({
        current: root,
        depth: 0,
        maxDepth: 5,
        projects
      });
    }
    return uniqueStrings(projects);
  }

  listAllowedDirectories(): string[] {
    return [...this.allowedDirectories];
  }

  listUnavailableDirectories(): string[] {
    return [...this.unavailableDirectories];
  }

  defaultDirectory(): string {
    const defaultDirectory = this.allowedDirectories[0];
    if (!defaultDirectory) {
      throw this.noAllowedDirectoriesError();
    }
    return defaultDirectory;
  }

  private noAllowedDirectoriesError(): ToolExecutionError {
    const missing = this.unavailableDirectories.length > 0 ? ` Missing configured roots: ${this.unavailableDirectories.join(", ")}` : "";
    return new ToolExecutionError(
      "invalid_arguments",
      `No allowed workspace directories are available. Add an existing folder in Clero Local Agent settings.${missing}`,
      {
        allowed_roots: this.listAllowedDirectories(),
        unavailable_roots: this.listUnavailableDirectories()
      }
    );
  }
}

export class WorkspaceTools {
  private readonly workspacePolicy: WorkspacePolicy;

  constructor(workspacePolicy: WorkspacePolicy) {
    this.workspacePolicy = workspacePolicy;
  }

  definitions(): ToolDefinition[] {
    return [
      {
        name: "workspace.list_roots",
        description: "List local filesystem roots the agent is allowed to inspect. Use this before choosing a project path.",
        requiresLease: false,
        handler: () => this.listRoots()
      },
      {
        name: "workspace.list_projects",
        description: "Discover local projects under allowed roots. Use the returned project key/name for coding and git tools instead of inventing absolute paths.",
        requiresLease: false,
        handler: (args) => this.listProjects(args)
      },
      {
        name: "workspace.describe_project",
        description: "Inspect a discovered local project key/name or path and summarize markers, stack, package metadata, and git state.",
        requiresLease: false,
        handler: (args) => this.describeProject(args)
      }
    ];
  }

  listRoots(): JsonObject {
    return {
      roots: this.workspacePolicy.listAllowedDirectories().map((root) => ({
        path: root,
        name: path.basename(root)
      })),
      unavailable_roots: this.workspacePolicy.listUnavailableDirectories()
    };
  }

  async listProjects(args: JsonObject = {}): Promise<JsonObject> {
    const root = optionalString(args, "root");
    const roots = root ? [this.workspacePolicy.resolveAllowedDirectory(root)] : this.workspacePolicy.listAllowedDirectories();
    const maxDepth = clampInteger(optionalNumber(args, "max_depth") ?? 3, 0, 8);
    const maxResults = clampInteger(optionalNumber(args, "max_results") ?? 50, 1, 200);
    const projects: JsonObject[] = [];

    for (const allowedRoot of roots) {
      await this.scanDirectory({
        current: allowedRoot,
        root: allowedRoot,
        depth: 0,
        maxDepth,
        maxResults,
        projects
      });
      if (projects.length >= maxResults) {
        break;
      }
    }

    return {
      roots,
      unavailable_roots: this.workspacePolicy.listUnavailableDirectories(),
      max_depth: maxDepth,
      projects
    };
  }

  async describeProject(args: JsonObject): Promise<JsonObject> {
    const projectPath = this.workspacePolicy.resolveAllowedDirectory(optionalString(args, "project") ?? optionalString(args, "path"));
    const entries = await safeReadDir(projectPath);
    const markers = markerNames(entries);
    const packageJson = await readPackageJson(projectPath, markers);
    const git = markers.includes(".git") ? await gitSummary(projectPath) : { is_repository: false };

    return {
      path: projectPath,
      name: packageJson?.name ?? path.basename(projectPath),
      markers,
      detected_stacks: detectedStacks(markers),
      package_manager: packageManager(markers),
      package_json: packageJson ? packageJsonSummary(packageJson) : null,
      git
    };
  }

  private async scanDirectory(input: {
    current: string;
    root: string;
    depth: number;
    maxDepth: number;
    maxResults: number;
    projects: JsonObject[];
  }): Promise<void> {
    if (input.projects.length >= input.maxResults) {
      return;
    }

    const entries = await safeReadDir(input.current);
    const markers = markerNames(entries);
    if (markers.length > 0) {
      const packageJson = await readPackageJson(input.current, markers);
      const project = path.relative(input.root, input.current) || path.basename(input.current);
      input.projects.push({
        path: input.current,
        project,
        name: packageJson?.name ?? path.basename(input.current),
        root: input.root,
        markers,
        detected_stacks: detectedStacks(markers),
        package_manager: packageManager(markers),
        git: {
          is_repository: markers.includes(".git")
        }
      });
    }

    if (input.depth >= input.maxDepth || input.projects.length >= input.maxResults) {
      return;
    }

    for (const entry of entries) {
      if (input.projects.length >= input.maxResults) {
        return;
      }
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await this.scanDirectory({
        ...input,
        current: path.join(input.current, entry.name),
        depth: input.depth + 1
      });
    }
  }
}

function resolveExistingCwd(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!existsSync(resolved)) {
    throw new ToolExecutionError("invalid_arguments", `cwd does not exist: ${candidate}`);
  }
  return realpathSync(resolved);
}

function tryRealpath(candidate: string): string | null {
  if (!existsSync(candidate)) {
    return null;
  }

  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function projectLookupName(candidate: string): string {
  const normalized = candidate.replace(/[\\/]+$/, "");
  return path.basename(normalized).trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function scanProjectsSync(input: {
  current: string;
  depth: number;
  maxDepth: number;
  lookup: string;
  matches: string[];
}): void {
  const entries = safeReadDirSync(input.current);
  const markers = markerNames(entries);
  const basename = path.basename(input.current);
  const packageName = readPackageJsonNameSync(input.current, markers);
  if (markers.length > 0 && (basename === input.lookup || packageName === input.lookup)) {
    const resolved = tryRealpath(input.current);
    if (resolved) {
      input.matches.push(resolved);
    }
  }

  if (input.depth >= input.maxDepth) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    scanProjectsSync({
      ...input,
      current: path.join(input.current, entry.name),
      depth: input.depth + 1
    });
  }
}

function safeReadDirSync(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readPackageJsonNameSync(directory: string, markers: string[]): string | null {
  if (!markers.includes("package.json")) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as unknown;
    return isPlainObject(parsed) && typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function directoryHasProjectMarkers(directory: string): boolean {
  return markerNames(safeReadDirSync(directory)).length > 0;
}

function scanProjectDirectoriesSync(input: {
  current: string;
  depth: number;
  maxDepth: number;
  projects: string[];
}): void {
  const entries = safeReadDirSync(input.current);
  if (markerNames(entries).length > 0) {
    const resolved = tryRealpath(input.current);
    if (resolved) {
      input.projects.push(resolved);
    }
  }

  if (input.depth >= input.maxDepth) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    scanProjectDirectoriesSync({
      ...input,
      current: path.join(input.current, entry.name),
      depth: input.depth + 1
    });
  }
}

const PROJECT_MARKERS = new Set([
  ".git",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "pyproject.toml",
  "requirements.txt",
  "manage.py",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "Gemfile",
  "deno.json",
  "deno.jsonc",
  "tsconfig.json"
]);

const SKIP_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".nuxt",
  ".svn",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor"
]);

async function safeReadDir(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function markerNames(entries: Dirent[]): string[] {
  const names = new Set(entries.map((entry) => entry.name));
  return [...PROJECT_MARKERS].filter((marker) => names.has(marker));
}

function detectedStacks(markers: string[]): string[] {
  const stacks = new Set<string>();
  if (markers.includes("package.json")) {
    stacks.add("node");
  }
  if (markers.includes("tsconfig.json")) {
    stacks.add("typescript");
  }
  if (markers.includes("pyproject.toml") || markers.includes("requirements.txt") || markers.includes("manage.py")) {
    stacks.add("python");
  }
  if (markers.includes("manage.py")) {
    stacks.add("django");
  }
  if (markers.includes("Cargo.toml")) {
    stacks.add("rust");
  }
  if (markers.includes("go.mod")) {
    stacks.add("go");
  }
  if (markers.includes("composer.json")) {
    stacks.add("php");
  }
  if (markers.includes("Gemfile")) {
    stacks.add("ruby");
  }
  if (markers.includes("deno.json") || markers.includes("deno.jsonc")) {
    stacks.add("deno");
  }
  return [...stacks];
}

function packageManager(markers: string[]): string | null {
  if (markers.includes("pnpm-workspace.yaml") || markers.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (markers.includes("yarn.lock")) {
    return "yarn";
  }
  if (markers.includes("package-lock.json")) {
    return "npm";
  }
  return null;
}

async function readPackageJson(directory: string, markers: string[]): Promise<JsonObject | null> {
  if (!markers.includes("package.json")) {
    return null;
  }

  try {
    const raw = await readFile(path.join(directory, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function packageJsonSummary(packageJson: JsonObject): JsonObject {
  return {
    name: typeof packageJson.name === "string" ? packageJson.name : null,
    version: typeof packageJson.version === "string" ? packageJson.version : null,
    private: typeof packageJson.private === "boolean" ? packageJson.private : null,
    scripts: isPlainObject(packageJson.scripts) ? Object.keys(packageJson.scripts) : []
  };
}

async function gitSummary(cwd: string): Promise<JsonObject> {
  const branch = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await runGit(cwd, ["status", "--short", "--branch"]);
  return {
    is_repository: branch.exit_code === 0 || status.exit_code === 0,
    branch: branch.exit_code === 0 ? branch.stdout.trim() : null,
    status: status.stdout,
    exit_code: status.exit_code,
    stderr: `${branch.stderr}${status.stderr}`
  };
}

async function runGit(cwd: string, args: string[]): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ exit_code: code ?? -1, stdout, stderr });
    });
    child.on("error", (error) => {
      resolve({ exit_code: -1, stdout, stderr: `${stderr}${error.message}\n` });
    });
  });
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
