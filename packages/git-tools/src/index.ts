import { spawn } from "node:child_process";
import type { ApprovalProvider } from "@clero-local-agent/approvals";
import { ToolExecutionError, type ToolDefinition } from "@clero-local-agent/mcp-runtime";
import type { JsonObject } from "@clero-local-agent/protocol";
import type { WorkspacePolicy } from "@clero-local-agent/workspace";

export type GitToolsOptions = {
  workspacePolicy: WorkspacePolicy;
  approvalProvider: ApprovalProvider;
};

type GitCommandResult = {
  exit_code: number;
  stdout: string;
  stderr: string;
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
        name: "git.list_branches",
        description: "List local and remote git branches for a discovered project.",
        requiresLease: false,
        handler: (args) => this.listBranches(args)
      },
      {
        name: "git.checkout",
        description: "Switch to or create a git branch after local approval.",
        handler: (args) => this.checkout(args)
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
    const status = await runGit(cwd, ["status", "--porcelain=v2", "--branch"]);
    if (status.exit_code !== 0) {
      return {
        cwd,
        is_repository: false,
        clean: false,
        ...status
      };
    }

    const unstagedLines = await runGit(cwd, ["diff", "--numstat"]);
    const stagedLines = await runGit(cwd, ["diff", "--cached", "--numstat"]);
    const remote = await runGit(cwd, ["remote", "get-url", "origin"]);
    const unstagedCounts = parseNumstat(unstagedLines.stdout, "unstaged");
    const stagedCounts = parseNumstat(stagedLines.stdout, "staged");
    return {
      cwd,
      is_repository: true,
      ...parsePorcelainStatus(status.stdout),
      lines: {
        ...unstagedCounts,
        ...stagedCounts,
        added: unstagedCounts.unstaged_added + stagedCounts.staged_added,
        deleted: unstagedCounts.unstaged_deleted + stagedCounts.staged_deleted
      },
      remote_url: remote.exit_code === 0 ? sanitizeRemoteUrl(remote.stdout) : null,
      exit_code: status.exit_code,
      stdout: status.stdout,
      stderr: `${status.stderr}${unstagedLines.stderr}${stagedLines.stderr}${remote.stderr}`
    };
  }

  async diff(args: JsonObject): Promise<JsonObject> {
    const cwd = this.cwd(args);
    const gitArgs = booleanArg(args, "staged") ? ["diff", "--staged"] : ["diff"];
    const result = await runGit(cwd, gitArgs);
    return { cwd, ...result };
  }

  async listBranches(args: JsonObject): Promise<JsonObject> {
    const cwd = this.cwd(args);
    const [current, local, remote] = await Promise.all([
      runGit(cwd, ["branch", "--show-current"]),
      runGit(cwd, ["for-each-ref", "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)", "refs/heads"]),
      runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"])
    ]);
    if (local.exit_code !== 0) {
      throw new ToolExecutionError(
        "tool_failed",
        local.stderr.trim() || "Could not list Git branches."
      );
    }

    return {
      cwd,
      current_branch: current.exit_code === 0 ? current.stdout.trim() : "",
      branches: local.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [name = "", head = "", upstream = ""] = line.split("\t");
          return { name, current: head.trim() === "*", upstream };
        }),
      remote_branches: remote.exit_code === 0
        ? remote.stdout
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter((name) => name.length > 0 && !name.endsWith("/HEAD"))
        : []
    };
  }

  async checkout(args: JsonObject): Promise<JsonObject> {
    const cwd = this.cwd(args);
    const branch = requiredString(args, "branch").trim();
    const create = booleanArg(args, "create");
    if (!branch || branch.startsWith("-") || /[\u0000-\u0020\u007f]/.test(branch)) {
      throw new ToolExecutionError("invalid_arguments", "Enter a valid Git branch name.");
    }
    const validation = await runGit(cwd, ["check-ref-format", "--branch", branch]);
    if (validation.exit_code !== 0) {
      throw new ToolExecutionError(
        "invalid_arguments",
        validation.stderr.trim() || `Invalid Git branch name: ${branch}`
      );
    }

    const approvalToken = optionalString(args, "approval_token");
    const approval = await this.options.approvalProvider.requestApproval({
      tool: "git.checkout",
      summary: create
        ? `Create and switch to branch ${branch} in ${cwd}`
        : `Switch to branch ${branch} in ${cwd}`,
      metadata: approvalToken
        ? { cwd, branch, create, approval_token: approvalToken }
        : { cwd, branch, create }
    });
    if (!approval.approved) {
      throw new ToolExecutionError("approval_denied", `Approval denied: ${approval.reason ?? "No reason provided"}`);
    }

    const result = await runGit(cwd, create
      ? ["switch", "--create", branch]
      : ["switch", branch]);
    if (result.exit_code !== 0) {
      throw new ToolExecutionError(
        "tool_failed",
        result.stderr.trim() || result.stdout.trim() || `Could not switch to ${branch}.`
      );
    }
    return { cwd, approved: true, branch, created: create, ...result };
  }

  async commit(args: JsonObject): Promise<JsonObject> {
    const cwd = this.cwd(args);
    const message = requiredString(args, "message");
    const paths = stringArray(args, "paths");
    const approvalToken = optionalString(args, "approval_token");
    const approval = await this.options.approvalProvider.requestApproval({
      tool: "git.commit",
      summary: `Create git commit in ${cwd}: ${message}`,
      metadata: approvalToken
        ? { cwd, message, paths, approval_token: approvalToken }
        : { cwd, message, paths }
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
    const setUpstream = booleanArg(args, "set_upstream");
    const approvalToken = optionalString(args, "approval_token");
    const approval = await this.options.approvalProvider.requestApproval({
      tool: "git.push",
      summary: `Push commits from ${cwd} to ${remote}${branch ? ` ${branch}` : ""}`,
      metadata: approvalToken
        ? { cwd, remote, ...(branch ? { branch } : {}), set_upstream: setUpstream, approval_token: approvalToken }
        : { cwd, remote, ...(branch ? { branch } : {}), set_upstream: setUpstream }
    });

    if (!approval.approved) {
      throw new ToolExecutionError("approval_denied", `Approval denied: ${approval.reason ?? "No reason provided"}`);
    }

    const result = await runGit(
      cwd,
      branch
        ? ["push", ...(setUpstream ? ["--set-upstream"] : []), "--", remote, branch]
        : ["push", "--", remote]
    );
    return { cwd, approved: true, ...result };
  }

  private cwd(args: JsonObject): string {
    return this.options.workspacePolicy.resolveProjectDirectory(optionalString(args, "project") ?? optionalString(args, "cwd"));
  }
}

function parsePorcelainStatus(stdout: string): JsonObject {
  let branch: string | null = null;
  let headSha: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  const changedPaths: JsonObject[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branch = value === "(detached)" ? null : value;
      continue;
    }
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim();
      headSha = value === "(initial)" ? null : value;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      ahead = Number(match?.[1] ?? 0);
      behind = Number(match?.[2] ?? 0);
      continue;
    }
    if (line.startsWith("? ")) {
      const filePath = line.slice(2);
      untracked += 1;
      changedPaths.push({ path: filePath, staged: false, unstaged: false, untracked: true, conflicted: false });
      continue;
    }
    if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const filePath = parts.slice(10).join(" ");
      conflicted += 1;
      changedPaths.push({ path: filePath, staged: false, unstaged: false, untracked: false, conflicted: true });
      continue;
    }
    if (!line.startsWith("1 ") && !line.startsWith("2 ")) {
      continue;
    }

    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    const filePath = line.startsWith("2 ")
      ? parts.slice(9).join(" ").split("\t")[0] ?? ""
      : parts.slice(8).join(" ");
    const isStaged = xy[0] !== ".";
    const isUnstaged = xy[1] !== ".";
    if (isStaged) staged += 1;
    if (isUnstaged) unstaged += 1;
    changedPaths.push({
      path: filePath,
      staged: isStaged,
      unstaged: isUnstaged,
      untracked: false,
      conflicted: false
    });
  }

  return {
    branch,
    head_sha: headSha,
    detached: branch === null && headSha !== null,
    upstream,
    ahead,
    behind,
    clean: staged === 0 && unstaged === 0 && untracked === 0 && conflicted === 0,
    files: {
      changed: changedPaths.length,
      staged,
      unstaged,
      untracked,
      conflicted
    },
    changed_paths: changedPaths.slice(0, 500)
  };
}

function parseNumstat(stdout: string, prefix: "staged" | "unstaged"): Record<string, number> {
  let added = 0;
  let deleted = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const [rawAdded, rawDeleted] = line.split("\t");
    const parsedAdded = Number(rawAdded);
    const parsedDeleted = Number(rawDeleted);
    if (Number.isFinite(parsedAdded)) added += parsedAdded;
    if (Number.isFinite(parsedDeleted)) deleted += parsedDeleted;
  }
  return {
    [`${prefix}_added`]: added,
    [`${prefix}_deleted`]: deleted
  };
}

function sanitizeRemoteUrl(value: string): string {
  const remote = value.trim();
  if (!remote) return "";
  if (remote.startsWith("git@")) return remote;
  if (!/^(https?|ssh):\/\//i.test(remote)) {
    return remote.includes("@") ? remote.slice(remote.lastIndexOf("@") + 1) : remote;
  }
  try {
    const parsed = new URL(remote);
    if (parsed.protocol === "ssh:" && parsed.username === "git") {
      parsed.username = "git";
    } else {
      parsed.username = "";
    }
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

async function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
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
