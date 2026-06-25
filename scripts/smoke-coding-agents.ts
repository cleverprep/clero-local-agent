import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  AntigravityCliAdapter,
  ClaudeCodeAdapter,
  CodexCliAdapter,
  CursorCliAdapter,
  type ClaudeCodePermissionMode,
  type ClaudeCodeReasoningEffort,
  type CodexReasoningEffort,
  type CodingAgentAdapter,
  type CodingAgentProvider
} from "../packages/coding-agents/src/index.ts";
import type { JsonObject, JsonValue } from "../packages/protocol/src/index.ts";
import { WorkspacePolicy } from "../packages/workspace/src/index.ts";

const providers: CodingAgentProvider[] = ["codex", "claude-code", "antigravity", "cursor"];

async function main(): Promise<void> {
  const options = parseOptions();
  const selectedProviders =
    options.provider === "all" ? providers : [options.provider];
  const workspace = await prepareWorkspace(options.workspace);
  let shouldCleanup = !options.workspace && !options.keepWorkspace;

  console.log(`coding-agent smoke workspace: ${workspace}`);
  console.log(`coding-agent smoke timeout: ${options.timeoutMs}ms`);

  try {
    for (const provider of selectedProviders) {
      await runProviderSmoke(provider, workspace, options.timeoutMs);
    }
  } catch (error) {
    shouldCleanup = false;
    console.error(`coding-agent smoke workspace kept for debugging: ${workspace}`);
    throw error;
  } finally {
    if (shouldCleanup) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

async function runProviderSmoke(
  provider: CodingAgentProvider,
  workspace: string,
  timeoutMs: number
): Promise<void> {
  const adapter = adapterForProvider(provider, workspace);
  const sessionKey = `smoke:${provider}:${Date.now()}`;

  console.log(`\nChecking ${provider} first task`);
  const first = await adapter.startTask(
    {
      prompt: "Read README.md. Reply with exactly CLERO_SMOKE_FIRST and no extra text.",
      cwd: workspace,
      sandbox: "read-only",
      continue_session: true,
      session_key: sessionKey,
      skip_git_repo_check: true
    },
    {
      requestId: `smoke_${provider}_1`,
      agentId: "smoke-agent",
      taskId: `smoke-${provider}-1`
    }
  );

  assertBooleanField(first, "continue_session", true);
  assertBooleanField(first, "resumed_session", false);
  const firstTaskId = stringField(first, "task_id");
  const firstStatus = await waitForTerminalStatus(adapter, firstTaskId, timeoutMs);
  assertCompleted(provider, firstStatus);
  const providerSessionId = providerSessionIdFromTask(provider, firstStatus);
  if (!providerSessionId) {
    throw new Error(`${provider} did not return a provider session id; cannot verify resume support`);
  }

  console.log(`Checking ${provider} resumed task`);
  const second = await adapter.startTask(
    {
      prompt: "Continue the same conversation. Reply with exactly CLERO_SMOKE_SECOND and no extra text.",
      cwd: workspace,
      sandbox: "read-only",
      continue_session: true,
      session_key: sessionKey,
      skip_git_repo_check: true
    },
    {
      requestId: `smoke_${provider}_2`,
      agentId: "smoke-agent",
      taskId: `smoke-${provider}-2`
    }
  );

  assertBooleanField(second, "continue_session", true);
  assertBooleanField(second, "resumed_session", true);
  assertStringField(second, "provider_session_id", providerSessionId);

  const secondTaskId = stringField(second, "task_id");
  const secondStatus = await waitForTerminalStatus(adapter, secondTaskId, timeoutMs);
  assertCompleted(provider, secondStatus);
  const secondOutput = await adapter.getOutput(secondTaskId);
  assertResumeCommand(provider, secondOutput, providerSessionId);

  console.log(
    JSON.stringify(
      {
        provider,
        ok: true,
        session_key: sessionKey,
        provider_session_id: providerSessionId,
        first_task_id: firstTaskId,
        second_task_id: secondTaskId,
        first_final_message: firstStatus.final_message ?? null,
        second_final_message: secondStatus.final_message ?? null
      },
      null,
      2
    )
  );
}

function adapterForProvider(provider: CodingAgentProvider, workspace: string): CodingAgentAdapter {
  const workspacePolicy = new WorkspacePolicy({ allowedDirectories: [workspace] });

  if (provider === "codex") {
    return new CodexCliAdapter({
      workspacePolicy,
      command: optionalEnv("CLERO_CODEX_BIN"),
      defaultModel: optionalEnv("CLERO_CODEX_MODEL"),
      defaultReasoningEffort: codexReasoningEffortFromEnv()
    });
  }

  if (provider === "claude-code") {
    return new ClaudeCodeAdapter({
      workspacePolicy,
      command: optionalEnv("CLERO_CLAUDE_BIN"),
      defaultModel: optionalEnv("CLERO_CLAUDE_MODEL"),
      defaultReasoningEffort: claudeReasoningEffortFromEnv(),
      permissionMode: claudePermissionModeFromEnv()
    });
  }

  if (provider === "cursor") {
    return new CursorCliAdapter({
      workspacePolicy,
      command: optionalEnv("CLERO_CURSOR_BIN"),
      defaultModel: optionalEnv("CLERO_CURSOR_MODEL")
    });
  }

  return new AntigravityCliAdapter({
    workspacePolicy,
    command: optionalEnv("CLERO_ANTIGRAVITY_BIN")
  });
}

async function prepareWorkspace(workspaceArg: string | undefined): Promise<string> {
  const tempRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const workspace = workspaceArg ?? (await mkdtemp(path.join(tempRoot, "clero-coding-smoke-")));
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "README.md"),
    [
      "# Clero Coding Smoke Workspace",
      "",
      "This temporary workspace is used to verify local coding-agent session continuation.",
      ""
    ].join("\n")
  );
  return workspace;
}

async function waitForTerminalStatus(
  adapter: CodingAgentAdapter,
  taskId: string,
  timeoutMs: number
): Promise<JsonObject> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await adapter.getStatus(taskId);
    if (status.status !== "running") {
      return status;
    }
    await delay(1_000);
  }

  await adapter.cancel(taskId);
  throw new Error(`Timed out waiting for ${taskId} after ${timeoutMs}ms`);
}

function assertCompleted(provider: CodingAgentProvider, status: JsonObject): void {
  if (status.status === "completed") {
    return;
  }

  throw new Error(
    `${provider} task ended with status=${String(status.status)}: ${JSON.stringify(status, null, 2)}`
  );
}

function providerSessionIdFromTask(provider: CodingAgentProvider, task: JsonObject): string | undefined {
  const providerSessionId = optionalStringField(task, "provider_session_id");
  if (providerSessionId) {
    return providerSessionId;
  }

  if (provider === "codex") {
    return optionalStringField(task, "codex_thread_id");
  }
  if (provider === "claude-code") {
    return optionalStringField(task, "claude_session_id");
  }
  if (provider === "cursor") {
    return optionalStringField(task, "cursor_chat_id");
  }
  return optionalStringField(task, "antigravity_conversation_id");
}

function assertResumeCommand(
  provider: CodingAgentProvider,
  output: JsonObject,
  providerSessionId: string
): void {
  const events = eventArray(output.events);
  const processStarted = events.find((event) => event.type === "process.started");
  if (!processStarted) {
    throw new Error(`${provider} did not record a process.started event`);
  }

  const data = objectField(processStarted, "data");
  const args = stringArrayField(data, "args");
  if (provider === "codex") {
    assertArgsContainSequence(provider, args, ["exec", "resume"]);
    assertArgsContain(provider, args, providerSessionId);
    return;
  }
  if (provider === "claude-code") {
    assertArgsContainSequence(provider, args, ["--resume", providerSessionId]);
    return;
  }
  if (provider === "cursor") {
    assertArgsContainSequence(provider, args, ["--resume", providerSessionId]);
    return;
  }
  assertArgsContainSequence(provider, args, ["--conversation", providerSessionId]);
}

function assertArgsContain(provider: CodingAgentProvider, args: string[], expected: string): void {
  if (!args.includes(expected)) {
    throw new Error(`${provider} resume args did not include ${expected}: ${JSON.stringify(args)}`);
  }
}

function assertArgsContainSequence(provider: CodingAgentProvider, args: string[], expected: string[]): void {
  for (let index = 0; index <= args.length - expected.length; index += 1) {
    if (expected.every((item, offset) => args[index + offset] === item)) {
      return;
    }
  }

  throw new Error(`${provider} resume args did not include ${expected.join(" ")}: ${JSON.stringify(args)}`);
}

function parseOptions(): {
  provider: CodingAgentProvider | "all";
  workspace?: string;
  timeoutMs: number;
  keepWorkspace: boolean;
} {
  const provider = providerArg(getArg("--provider") ?? process.env.CLERO_SMOKE_PROVIDER ?? "codex");
  const workspace = getArg("--workspace") ?? optionalEnv("CLERO_SMOKE_WORKSPACE");
  const timeoutMs = positiveInteger(
    getArg("--timeout-ms") ?? process.env.CLERO_SMOKE_TIMEOUT_MS,
    10 * 60 * 1_000
  );
  const keepWorkspace = hasFlag("--keep-workspace") || booleanEnv("CLERO_SMOKE_KEEP_WORKSPACE");
  return { provider, workspace, timeoutMs, keepWorkspace };
}

function providerArg(value: string): CodingAgentProvider | "all" {
  if (value === "all" || value === "codex" || value === "claude-code" || value === "antigravity" || value === "cursor") {
    return value;
  }

  throw new Error("--provider must be codex, claude-code, antigravity, cursor, or all");
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("timeout must be a positive integer");
  }
  return parsed;
}

function booleanEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function codexReasoningEffortFromEnv(): CodexReasoningEffort | undefined {
  const value = optionalEnv("CLERO_CODEX_REASONING_EFFORT");
  if (!value) {
    return undefined;
  }
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new Error("CLERO_CODEX_REASONING_EFFORT must be low, medium, high, or xhigh");
}

function claudeReasoningEffortFromEnv(): ClaudeCodeReasoningEffort | undefined {
  const value = optionalEnv("CLERO_CLAUDE_REASONING_EFFORT");
  if (!value) {
    return undefined;
  }
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value;
  }
  throw new Error("CLERO_CLAUDE_REASONING_EFFORT must be low, medium, high, xhigh, or max");
}

function claudePermissionModeFromEnv(): ClaudeCodePermissionMode | undefined {
  const value = optionalEnv("CLERO_CLAUDE_PERMISSION_MODE");
  if (!value) {
    return undefined;
  }
  if (
    value === "default" ||
    value === "acceptEdits" ||
    value === "plan" ||
    value === "auto" ||
    value === "dontAsk" ||
    value === "bypassPermissions"
  ) {
    return value;
  }
  throw new Error("CLERO_CLAUDE_PERMISSION_MODE must be default, acceptEdits, plan, auto, dontAsk, or bypassPermissions");
}

function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function optionalStringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function assertStringField(object: JsonObject, key: string, expected: string): void {
  const value = stringField(object, key);
  if (value !== expected) {
    throw new Error(`${key} expected ${expected}, got ${value}`);
  }
}

function assertBooleanField(object: JsonObject, key: string, expected: boolean): void {
  const value = object[key];
  if (value !== expected) {
    throw new Error(`${key} expected ${String(expected)}, got ${String(value)}`);
  }
}

function objectField(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  if (!isJsonObject(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value;
}

function stringArrayField(object: JsonObject, key: string): string[] {
  const value = object[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a string array`);
  }
  return value as string[];
}

function eventArray(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !isJsonObject(item))) {
    throw new Error("events must be an object array");
  }
  return value as JsonObject[];
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`coding-agent smoke test failed: ${message}`);
  process.exitCode = 1;
});
