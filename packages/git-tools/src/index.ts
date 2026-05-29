import { spawn } from "node:child_process";
import type { ApprovalProvider } from "@clero-local-agent/approvals";
import { ToolExecutionError, type ToolDefinition } from "@clero-local-agent/mcp-runtime";
import type { JsonObject } from "@clero-local-agent/protocol";
import type { WorkspacePolicy } from "@clero-local-agent/workspace";

export type GitToolsOptions = {
  workspacePolicy: WorkspacePolicy;
  approvalProvider: ApprovalProvider;
};

export class GitTools {
  private readonly options: GitToolsOptions;

  constructor(options: GitToolsOptions) {
    this.options = options;
  }

  definitions(): ToolDefinition[] {
    return [
      {
        name: "git.status",
        description: "Read git status for a discovered project. Prefer project over absolute cwd.",
        requiresLease: false,
        handler: (args) => this.status(args)
      },
      {
        name: "git.diff",
        description: "Read git diff for a discovered project. Prefer project over absolute cwd.",
        requiresLease: false,
        handler: (args) => this.diff(args)
      },
      {
        name: "git.commit",
        description: "Create a git commit in a discovered project after local approval. Prefer project over absolute cwd.",
        handler: (args) => this.commit(args)
      },
      {
        name: "git.push",
        description: "Push commits from a discovered project after local approval. Prefer project over absolute cwd.",
        handler: (args) => this.push(args)
      }
    ];
  }

  async status(args: JsonObject): Promise<JsonObject> {
    const cwd = this.cwd(args);
    const result = await runGit(cwd, ["status", "--short", "--branch"]);
    return { cwd, ...result };
  }

  async diff(args: JsonObject): Promise<JsonObject> {
    const cwd = this.cwd(args);
    const gitArgs = booleanArg(args, "staged") ? ["diff", "--staged"] : ["diff"];
    const result = await runGit(cwd, gitArgs);
    return { cwd, ...result };
  }

  async commit(args: JsonObject): Promise<JsonObject> {
    const cwd = this.cwd(args);
    const message = requiredString(args, "message");
    const paths = stringArray(args, "paths");
    const approval = await this.options.approvalProvider.requestApproval({
      tool: "git.commit",
      summary: `Create git commit in ${cwd}: ${message}`,
      metadata: { cwd, message, paths }
    });

    if (!approval.approved) {
      throw new ToolExecutionError("approval_denied", `Approval denied: ${approval.reason ?? "No reason provided"}`);
    }

    if (paths.length > 0) {
      await runGit(cwd, ["add", "--", ...paths]);
    }

    const result = await runGit(cwd, ["commit", "-m", message]);
    return { cwd, approved: true, ...result };
  }

  async push(args: JsonObject): Promise<JsonObject> {
    const cwd = this.cwd(args);
    const remote = optionalString(args, "remote") ?? "origin";
    const branch = optionalString(args, "branch");
    const approval = await this.options.approvalProvider.requestApproval({
      tool: "git.push",
      summary: `Push commits from ${cwd} to ${remote}${branch ? ` ${branch}` : ""}`,
      metadata: branch ? { cwd, remote, branch } : { cwd, remote }
    });

    if (!approval.approved) {
      throw new ToolExecutionError("approval_denied", `Approval denied: ${approval.reason ?? "No reason provided"}`);
    }

    const result = await runGit(cwd, branch ? ["push", remote, branch] : ["push", remote]);
    return { cwd, approved: true, ...result };
  }

  private cwd(args: JsonObject): string {
    return this.options.workspacePolicy.resolveAllowedDirectory(optionalString(args, "project") ?? optionalString(args, "cwd"));
  }
}

async function runGit(cwd: string, args: string[]): Promise<JsonObject> {
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
      resolve({
        exit_code: code ?? -1,
        stdout,
        stderr
      });
    });
    child.on("error", (error) => {
      resolve({
        exit_code: -1,
        stdout,
        stderr: `${stderr}${error.message}\n`
      });
    });
  });
}

function requiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function booleanArg(args: JsonObject, key: string): boolean {
  return args[key] === true;
}

function stringArray(args: JsonObject, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
