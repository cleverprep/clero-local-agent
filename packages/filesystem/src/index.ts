import { createRequire } from "node:module";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ToolExecutionError, type ToolDefinition } from "@clero-local-agent/mcp-runtime";
import { isJsonObject, type JsonObject, type JsonValue, type ToolName } from "@clero-local-agent/protocol";
import type { WorkspacePolicy } from "@clero-local-agent/workspace";

const FILESYSTEM_TOOL_PREFIX = "filesystem.";
const DEFAULT_MAX_RESULT_BYTES = 200_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SEARCH_EXCLUDE_PATTERNS = [
  ".git",
  "**/.git",
  "**/.git/**",
  "node_modules",
  "**/node_modules",
  "**/node_modules/**",
  ".venv",
  "**/.venv",
  "**/.venv/**",
  "__pycache__",
  "**/__pycache__",
  "**/__pycache__/**",
  ".next",
  "**/.next",
  "**/.next/**",
  ".nuxt",
  "**/.nuxt",
  "**/.nuxt/**",
  "build",
  "**/build",
  "**/build/**",
  "coverage",
  "**/coverage",
  "**/coverage/**",
  "dist",
  "**/dist",
  "**/dist/**",
  "target",
  "**/target",
  "**/target/**",
  "vendor",
  "**/vendor",
  "**/vendor/**"
];

type JsonRpcResponse = {
  id?: number | string | null;
  result?: JsonValue;
  error?: {
    message?: string;
  };
};

type PendingRequest = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type FilesystemToolName =
  | "filesystem.read_text_file"
  | "filesystem.read_multiple_files"
  | "filesystem.list_directory"
  | "filesystem.directory_tree"
  | "filesystem.search_files"
  | "filesystem.create_directory"
  | "filesystem.write_file"
  | "filesystem.edit_file";

const TOOL_DEFINITIONS: Array<{
  name: FilesystemToolName;
  mcpName: string;
  description: string;
  requiresLease: boolean;
}> = [
  {
    name: "filesystem.read_text_file",
    mcpName: "read_text_file",
    description:
      "Read a text file in a local project through the MCP Filesystem server. Use project with a relative path; head and tail can bound large reads.",
    requiresLease: false
  },
  {
    name: "filesystem.read_multiple_files",
    mcpName: "read_multiple_files",
    description:
      "Read several text files from one local project through the MCP Filesystem server.",
    requiresLease: false
  },
  {
    name: "filesystem.list_directory",
    mcpName: "list_directory",
    description:
      "List files and directories at a path in a local project through the MCP Filesystem server.",
    requiresLease: false
  },
  {
    name: "filesystem.directory_tree",
    mcpName: "directory_tree",
    description:
      "Return a recursive JSON directory tree for a local project through the MCP Filesystem server. Exclude generated or dependency directories when possible.",
    requiresLease: false
  },
  {
    name: "filesystem.search_files",
    mcpName: "search_files",
    description:
      "Find files and directories by glob pattern inside a selected local project through the MCP Filesystem server. Filesystem-root and home-directory searches are rejected; choose a project or narrower directory.",
    requiresLease: false
  },
  {
    name: "filesystem.create_directory",
    mcpName: "create_directory",
    description:
      "Create a directory inside a local project through the MCP Filesystem server.",
    requiresLease: true
  },
  {
    name: "filesystem.write_file",
    mcpName: "write_file",
    description:
      "Create or completely overwrite a text file inside a local project through the MCP Filesystem server. Prefer filesystem.edit_file for existing files.",
    requiresLease: true
  },
  {
    name: "filesystem.edit_file",
    mcpName: "edit_file",
    description:
      "Apply exact oldText-to-newText edits to a text file inside a local project through the MCP Filesystem server and return a git-style diff.",
    requiresLease: true
  }
];

export interface FilesystemMcpClient {
  callTool(name: string, args: JsonObject): Promise<JsonValue>;
  dispose?(): Promise<void>;
}

export type OfficialFilesystemMcpClientOptions = {
  allowedDirectories: string[] | (() => string[]);
  serverEntrypoint?: string;
  maxResultBytes?: number;
  requestTimeoutMs?: number;
};

export class OfficialFilesystemMcpClient implements FilesystemMcpClient {
  private readonly options: OfficialFilesystemMcpClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private initializePromise: Promise<void> | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private activeAllowedDirectories: string[] = [];

  constructor(options: OfficialFilesystemMcpClientOptions) {
    this.options = options;
  }

  async callTool(name: string, args: JsonObject): Promise<JsonValue> {
    try {
      this.refreshAllowedDirectories();
      await this.ensureInitialized();
      const result = await this.request("tools/call", { name, arguments: args });
      if (isJsonObject(result) && result.isError === true) {
        throw new Error(mcpResultText(result) || `MCP Filesystem tool failed: ${name}`);
      }
      return normalizedMcpResult(result, this.options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = this.stderrTail.trim();
      throw new ToolExecutionError(
        "tool_failed",
        stderr && !message.includes(stderr) ? `${message}: ${stderr}` : message
      );
    }
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.initializePromise = null;
    this.rejectPending(new Error("MCP Filesystem client was disposed"));
    child?.kill();
  }

  private async ensureInitialized(): Promise<void> {
    this.initializePromise ??= (async () => {
      await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "clero-local-agent-filesystem",
          version: "0.1.0"
        }
      });
      this.notify("notifications/initialized", {});
    })();
    try {
      await this.initializePromise;
    } catch (error) {
      this.initializePromise = null;
      throw error;
    }
  }

  private request(method: string, params: JsonObject): Promise<JsonValue> {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }
        const error = new Error(
          `MCP Filesystem request timed out after ${this.requestTimeoutMs()}ms: ${method}${this.stderrSummary()}`
        );
        this.resetChild(error);
      }, this.requestTimeoutMs());
      timeout.unref?.();

      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error: unknown) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(payload: JsonObject): void {
    this.ensureChild().stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }

    const serverEntrypoint = resolveFilesystemServerEntrypoint(this.options.serverEntrypoint);
    this.stdoutBuffer = "";
    this.stderrTail = "";
    const child = spawn(process.execPath, [serverEntrypoint, ...this.activeAllowedDirectories], {
      env: process.env,
      stdio: "pipe"
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000);
    });
    child.on("error", (error) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.initializePromise = null;
      this.rejectPending(new Error(`Failed to start MCP Filesystem server: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.initializePromise = null;
      this.rejectPending(
        new Error(
          `MCP Filesystem server exited with code ${code ?? "null"} signal ${signal ?? "null"}${this.stderrSummary()}`
        )
      );
    });

    return child;
  }

  private configuredAllowedDirectories(): string[] {
    const configured = typeof this.options.allowedDirectories === "function"
      ? this.options.allowedDirectories()
      : this.options.allowedDirectories;
    return uniqueStrings(
      configured
        .map((directory) => String(directory ?? "").trim())
        .filter(Boolean)
    );
  }

  private refreshAllowedDirectories(): void {
    const next = this.configuredAllowedDirectories();
    if (
      next.length === this.activeAllowedDirectories.length &&
      next.every((directory, index) => directory === this.activeAllowedDirectories[index])
    ) {
      return;
    }
    const child = this.child;
    this.child = null;
    this.initializePromise = null;
    this.stdoutBuffer = "";
    this.rejectPending(new Error("MCP Filesystem roots changed"));
    child?.kill();
    this.activeAllowedDirectories = next;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleStdoutLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      this.stderrTail = `${this.stderrTail}\n${line}`.slice(-4_000);
      return;
    }

    if (!isJsonObject(parsed) || parsed.id === undefined || parsed.id === null) {
      return;
    }

    const id = Number(parsed.id);
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timeout);
    const response = parsed as JsonRpcResponse;
    if (response.error) {
      pending.reject(new Error(response.error.message ?? `MCP Filesystem request failed: ${id}`));
      return;
    }
    pending.resolve(response.result ?? null);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private resetChild(error: Error): void {
    const child = this.child;
    this.child = null;
    this.initializePromise = null;
    this.stdoutBuffer = "";
    this.rejectPending(error);
    child?.kill();
  }

  private requestTimeoutMs(): number {
    return Math.max(
      1_000,
      Math.floor(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    );
  }

  private stderrSummary(): string {
    const detail = this.stderrTail.trim();
    return detail ? `: ${detail}` : "";
  }
}

export type FilesystemToolsOptions = {
  workspacePolicy: WorkspacePolicy;
  client: FilesystemMcpClient;
};

export class FilesystemTools {
  private readonly options: FilesystemToolsOptions;

  constructor(options: FilesystemToolsOptions) {
    this.options = options;
  }

  definitions(): ToolDefinition[] {
    return TOOL_DEFINITIONS.map((definition) => ({
      name: definition.name,
      description: definition.description,
      groups: ["shell"],
      requiresLease: definition.requiresLease,
      handler: (args) => this.call(definition.name, definition.mcpName, args)
    }));
  }

  private async call(toolName: FilesystemToolName, mcpName: string, args: JsonObject): Promise<JsonValue> {
    const mcpArgs = this.resolveArguments(toolName, args);
    return this.options.client.callTool(mcpName, mcpArgs);
  }

  private resolveArguments(toolName: FilesystemToolName, args: JsonObject): JsonObject {
    const project = optionalString(args, "project");
    const mcpArgs: JsonObject = { ...args };
    delete mcpArgs.project;

    if (toolName === "filesystem.read_multiple_files") {
      const paths = stringArray(args, "paths");
      if (paths.length === 0) {
        throw new ToolExecutionError("invalid_arguments", "paths must contain at least one file path");
      }
      mcpArgs.paths = paths.map((candidate) => this.resolvePath(candidate, project));
      return mcpArgs;
    }

    mcpArgs.path = this.resolvePath(requiredString(args, "path"), project);
    if (toolName === "filesystem.search_files") {
      const searchRoot = String(mcpArgs.path);
      if (isBroadSearchRoot(searchRoot)) {
        throw new ToolExecutionError(
          "invalid_arguments",
          `Search root is too broad: ${searchRoot}. Select a project or a narrower directory before calling filesystem.search_files.`
        );
      }
      mcpArgs.excludePatterns = uniqueStrings([
        ...DEFAULT_SEARCH_EXCLUDE_PATTERNS,
        ...stringArray(args, "excludePatterns")
      ]);
    }
    return mcpArgs;
  }

  private resolvePath(candidate: string, project?: string): string {
    if (path.isAbsolute(candidate)) {
      return this.options.workspacePolicy.resolveAllowedPath(candidate);
    }
    const projectDirectory = this.options.workspacePolicy.resolveProjectDirectory(project);
    return this.options.workspacePolicy.resolveAllowedPath(candidate, projectDirectory);
  }
}

function resolveFilesystemServerEntrypoint(configured?: string): string {
  const explicit = configured?.trim() || process.env.CLERO_FILESYSTEM_MCP_ENTRYPOINT?.trim();
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new ToolExecutionError("tool_failed", `MCP Filesystem server entrypoint does not exist: ${explicit}`);
    }
    return explicit;
  }

  const daemonEntrypoint = process.argv[1];
  if (daemonEntrypoint) {
    const bundled = path.resolve(path.dirname(daemonEntrypoint), "../filesystem-server/index.mjs");
    if (existsSync(bundled)) {
      return bundled;
    }
  }

  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("@modelcontextprotocol/server-filesystem/package.json");
    const installed = path.join(path.dirname(packageJson), "dist/index.js");
    if (existsSync(installed)) {
      return installed;
    }
  } catch {
    // The packaged desktop runtime uses the bundled entrypoint above.
  }

  throw new ToolExecutionError(
    "tool_failed",
    "The official MCP Filesystem server is unavailable. Rebuild or reinstall the Clero desktop runtime."
  );
}

function normalizedMcpResult(result: unknown, maxBytes: number): JsonValue {
  if (isJsonObject(result) && isJsonObject(result.structuredContent)) {
    const content = result.structuredContent.content;
    if (typeof content === "string") {
      return boundedContent(content, maxBytes);
    }
    return jsonValue(result.structuredContent);
  }

  const text = mcpResultText(result);
  if (text) {
    return boundedContent(text, maxBytes);
  }
  return jsonValue(result);
}

function boundedContent(content: string, maxBytes: number): JsonObject {
  const limit = Math.max(4_096, Math.floor(maxBytes));
  const bytes = Buffer.byteLength(content);
  if (bytes <= limit) {
    return { content, truncated: false, bytes };
  }

  const buffer = Buffer.from(content);
  return {
    content: buffer.subarray(0, limit).toString("utf8"),
    truncated: true,
    bytes,
    retained_bytes: limit
  };
}

function mcpResultText(result: unknown): string {
  if (!isJsonObject(result) || !Array.isArray(result.content)) {
    return "";
  }
  return result.content
    .map((item) => isJsonObject(item) && item.type === "text" && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function requiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolExecutionError("invalid_arguments", `${key} is required`);
  }
  return value.trim();
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(args: JsonObject, key: string): string[] {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function isBroadSearchRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function isFilesystemTool(tool: ToolName | string): boolean {
  return tool.startsWith(FILESYSTEM_TOOL_PREFIX);
}
