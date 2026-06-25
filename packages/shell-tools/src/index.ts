import { spawn } from "node:child_process";
import type { ApprovalProvider } from "@clero-local-agent/approvals";
import { ToolExecutionError, type ToolDefinition, type ToolExecutionContext } from "@clero-local-agent/mcp-runtime";
import type { JsonObject } from "@clero-local-agent/protocol";
import type { WorkspacePolicy } from "@clero-local-agent/workspace";

export type ShellAccess = "read-only" | "workspace-write" | "danger-full-access";

export type ShellToolsOptions = {
  workspacePolicy: WorkspacePolicy;
  approvalProvider?: ApprovalProvider;
  shell?: string;
  defaultAccess?: ShellAccess;
  allowWorkspaceWrite?: boolean;
  allowDangerFullAccess?: boolean;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
  maxOutputBytes?: number;
};

export class ShellTools {
  private readonly options: ShellToolsOptions;

  constructor(options: ShellToolsOptions) {
    this.options = options;
  }

  definitions(): ToolDefinition[] {
    return [
      {
        name: "shell.run",
        description:
          "Run a bounded shell command in an allowed project. Prefer project over absolute cwd. Shell is local and disabled by default.",
        handler: (args, context) => this.run(args, context)
      }
    ];
  }

  async run(args: JsonObject, context: ToolExecutionContext): Promise<JsonObject> {
    const command = requiredString(args, "command").trim();
    const cwd = this.options.workspacePolicy.resolveProjectDirectory(optionalString(args, "project") ?? optionalString(args, "cwd"));
    const access = effectiveAccess(args, this.options.defaultAccess);
    validateReadOnlyCommand(command, access);
    const approval = await this.ensureAccessApproval(access, cwd, command, context);
    const timeoutMs = boundedInteger(
      optionalNumber(args, "timeout_ms") ?? this.options.defaultTimeoutMs ?? 30_000,
      1_000,
      this.options.maxTimeoutMs ?? 120_000,
      "timeout_ms"
    );
    const maxOutputBytes = boundedInteger(
      optionalNumber(args, "max_output_bytes") ?? this.options.defaultMaxOutputBytes ?? 200_000,
      4_096,
      this.options.maxOutputBytes ?? 1_000_000,
      "max_output_bytes"
    );

    const startedAt = Date.now();
    const result = await runShellCommand({
      command,
      cwd,
      shell: optionalString(args, "shell") ?? this.options.shell ?? defaultShell(),
      timeoutMs,
      maxOutputBytes
    });

    return {
      cwd,
      command,
      access,
      approved: approval.approved,
      approval_required: approval.required,
      approval_reason: approval.reason ?? null,
      timeout_ms: timeoutMs,
      duration_ms: Date.now() - startedAt,
      ...result
    };
  }

  private async ensureAccessApproval(
    access: ShellAccess,
    cwd: string,
    command: string,
    context: ToolExecutionContext
  ): Promise<{ required: boolean; approved: boolean | null; reason?: string }> {
    if (access === "read-only") {
      return { required: false, approved: null, reason: "No approval required for inspection-only shell command" };
    }

    if (access === "workspace-write" && this.options.allowWorkspaceWrite === false) {
      throw new ToolExecutionError("approval_denied", "Shell workspace-write access is disabled in local settings.", {
        cwd,
        access
      });
    }
    if (access === "workspace-write" && this.options.allowWorkspaceWrite === true) {
      return {
        required: true,
        approved: true,
        reason: "Approved by local shell workspace-write setting"
      };
    }

    if (access === "danger-full-access" && this.options.allowDangerFullAccess !== true) {
      throw new ToolExecutionError("approval_denied", "Shell full local access is disabled in local settings.", {
        cwd,
        access
      });
    }
    if (access === "danger-full-access" && this.options.allowDangerFullAccess === true) {
      return {
        required: true,
        approved: true,
        reason: "Approved by local shell full-access setting"
      };
    }

    if (!this.options.approvalProvider) {
      throw new ToolExecutionError(
        "approval_denied",
        `Approval is required to run shell with ${access} access, but no approval provider is configured.`,
        { cwd, access }
      );
    }

    const decision = await this.options.approvalProvider.requestApproval({
      tool: "shell.run",
      summary: `Run shell with ${access} access in ${cwd}`,
      metadata: {
        cwd,
        access,
        command_preview: command.slice(0, 1_000),
        agent_id: context.agentId ?? null,
        event_run_id: context.eventRunId ?? null
      }
    });

    if (!decision.approved) {
      throw new ToolExecutionError(
        "approval_denied",
        `Approval denied for shell ${access} command: ${decision.reason ?? "No reason provided"}`,
        { cwd, access, reason: decision.reason ?? null }
      );
    }

    return { required: true, approved: true, reason: decision.reason };
  }
}

type ShellRunInput = {
  command: string;
  cwd: string;
  shell: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

type BoundedOutput = {
  text: string;
  bytes: number;
  truncated: boolean;
};

async function runShellCommand(input: ShellRunInput): Promise<JsonObject> {
  const shellArgs = shellArgsForCommand(input.shell, input.command);
  return new Promise((resolve) => {
    const child = spawn(input.shell, shellArgs, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        TERM: process.env.TERM ?? "dumb",
        NO_COLOR: process.env.NO_COLOR ?? "1"
      }
    });
    const stdout = boundedOutput(input.maxOutputBytes);
    const stderr = boundedOutput(input.maxOutputBytes);
    let timedOut = false;
    let closed = false;
    let errorMessage = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, 1_000).unref?.();
    }, input.timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    child.on("error", (error) => {
      errorMessage = error.message;
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      const stdoutResult = stdout.result();
      const stderrResult = stderr.result();
      resolve({
        exit_code: code ?? (timedOut ? 124 : -1),
        signal: signal ?? null,
        timed_out: timedOut,
        stdout: stdoutResult.text,
        stderr: errorMessage ? `${stderrResult.text}${errorMessage}\n` : stderrResult.text,
        stdout_truncated: stdoutResult.truncated,
        stderr_truncated: stderrResult.truncated,
        stdout_bytes: stdoutResult.bytes,
        stderr_bytes: stderrResult.bytes
      });
    });
  });
}

function boundedOutput(maxBytes: number): { append: (chunk: Buffer) => void; result: () => BoundedOutput } {
  let text = "";
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk: Buffer): void {
      bytes += chunk.length;
      if (truncated) {
        return;
      }
      const remaining = maxBytes - Buffer.byteLength(text);
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        text += chunk.toString("utf8");
        return;
      }
      text += chunk.subarray(0, remaining).toString("utf8");
      truncated = true;
    },
    result(): BoundedOutput {
      return { text, bytes, truncated };
    }
  };
}

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

function shellArgsForCommand(shell: string, command: string): string[] {
  const basename = shell.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (process.platform === "win32" || basename === "cmd.exe") {
    return ["/d", "/s", "/c", command];
  }
  return ["-lc", command];
}

function effectiveAccess(args: JsonObject, defaultAccess?: ShellAccess): ShellAccess {
  const requested = shellAccessArg(args, "access");
  if (defaultAccess === "danger-full-access") {
    return "danger-full-access";
  }
  return requested ?? defaultAccess ?? "read-only";
}

function shellAccessArg(args: JsonObject, key: string): ShellAccess | undefined {
  const value = args[key];
  if (typeof value !== "string") {
    return undefined;
  }
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  throw new Error(`${key} must be read-only, workspace-write, or danger-full-access`);
}

function validateReadOnlyCommand(command: string, access: ShellAccess): void {
  if (access !== "read-only") {
    return;
  }

  if (hasUnquotedRedirection(command)) {
    throw new ToolExecutionError("approval_denied", "Inspection-only shell blocks output redirection. Enable shell write access to run this command.", {
      blocked_reason: "redirection"
    });
  }

  const tokens = shellWords(command);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = normalizeCommandToken(tokens[index] ?? "");
    if (!token || SHELL_CONTROL_WORDS.has(token)) {
      continue;
    }

    if (READ_ONLY_BLOCKED_COMMANDS.has(token)) {
      throw readOnlyBlockedCommand(token);
    }

    if (token === "git" && GIT_WRITE_SUBCOMMANDS.has((tokens[index + 1] ?? "").toLowerCase())) {
      throw readOnlyBlockedCommand(`git ${tokens[index + 1]}`);
    }

    if (PACKAGE_MANAGERS.has(token) && PACKAGE_WRITE_SUBCOMMANDS.has((tokens[index + 1] ?? "").toLowerCase())) {
      throw readOnlyBlockedCommand(`${token} ${tokens[index + 1]}`);
    }
  }
}

function readOnlyBlockedCommand(command: string): ToolExecutionError {
  return new ToolExecutionError(
    "approval_denied",
    `Inspection-only shell blocks "${command}". Enable shell write access or full local access to run this command.`,
    { blocked_command: command }
  );
}

function hasUnquotedRedirection(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if ((character === "'" || character === '"') && !quote) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = null;
      continue;
    }
    if (!quote && character === ">") {
      return true;
    }
  }
  return false;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  const pushCurrent = () => {
    if (current.length > 0) {
      words.push(current);
      current = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (character === "\\" && quote !== "'") {
      const next = command[index + 1];
      if (next) {
        current += next;
        index += 1;
      }
      continue;
    }
    if ((character === "'" || character === '"') && !quote) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(character)) {
      pushCurrent();
      continue;
    }
    if (!quote && [";", "|", "&", "(", ")"].includes(character)) {
      pushCurrent();
      words.push(character);
      continue;
    }
    current += character;
  }
  pushCurrent();
  return words;
}

function normalizeCommandToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  const basename = normalized.split(/[\\/]/).at(-1) ?? normalized;
  return basename.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

function requiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  const integer = Math.floor(value);
  if (!Number.isFinite(integer) || integer < min || integer > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return integer;
}

const SHELL_CONTROL_WORDS = new Set([";", "|", "&", "(", ")", "&&", "||"]);

const READ_ONLY_BLOCKED_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "truncate",
  "dd",
  "tee",
  "install",
  "rsync",
  "scp",
  "sftp",
  "ssh",
  "curl",
  "wget",
  "nc",
  "netcat"
]);

const GIT_WRITE_SUBCOMMANDS = new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "clean",
  "commit",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag"
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "cargo", "go", "gem", "bundle"]);
const PACKAGE_WRITE_SUBCOMMANDS = new Set([
  "add",
  "build",
  "install",
  "i",
  "link",
  "publish",
  "remove",
  "rm",
  "sync",
  "update",
  "upgrade"
]);
