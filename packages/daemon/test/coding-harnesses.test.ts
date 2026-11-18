import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODING_AGENT_GRANT_RULES_VERSION,
  codingAgentCommandCandidates,
  detectCodingAgents,
  resolveCodingAgentCommand,
  type CodingAgentAdapter,
  type CodingAgentProvider,
  type CodingSessionState
} from "@clero-local-agent/coding-agents";
import type { JsonObject } from "@clero-local-agent/protocol";
import { CodingAgentRouter, LocalRuntimeDaemon } from "../src/daemon.ts";
import {
  applyCodingAgentConfigUpdate,
  capabilityOptionsFromConfig,
  codingAgentConfigFromRuntimeConfig,
  loadRuntimeConfig,
  saveRuntimeConfig
} from "../src/runtime-config.ts";

type FakeHarness = CodingAgentAdapter & {
  provider: CodingAgentProvider;
  generation: number;
  disposed: boolean;
  started: JsonObject[];
  statuses: Map<string, string>;
  sessions: Map<string, CodingSessionState>;
  gate?: Promise<void>;
};

function fakeCodingRouter(settings: Partial<Record<CodingAgentProvider, string>> = {}, maxTrackedTasks?: number) {
  const created: FakeHarness[] = [];
  let taskCounter = 0;
  const router = new CodingAgentRouter({
    signature: provider => settings[provider] ?? "",
    resolveProjectDirectory: candidate => candidate || "/default",
    maxTrackedTasks,
    create: (provider, sessions) => {
      const harness: FakeHarness = {
        provider,
        generation: created.filter(item => item.provider === provider).length + 1,
        disposed: false,
        started: [],
        statuses: new Map(),
        sessions,
        async startTask(args) {
          await harness.gate;
          const taskId = `${provider}_${++taskCounter}`;
          harness.started.push(args);
          harness.statuses.set(taskId, "running");
          return { task_id: taskId, provider, status: "running", generation: harness.generation };
        },
        async getStatus(taskId) {
          return { task_id: taskId, provider, status: harness.statuses.get(taskId) ?? "missing", generation: harness.generation };
        },
        async getOutput(taskId, args) {
          const output: JsonObject = { task_id: taskId, provider };
          if (args !== undefined) {
            output.args = args;
          }
          return output;
        },
        async cancel(taskId) {
          harness.statuses.set(taskId, "cancelled");
          return { task_id: taskId, provider, status: "cancelled" };
        },
        async dispose() {
          harness.disposed = true;
        }
      };
      created.push(harness);
      return harness;
    }
  });
  return { router, created };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const codingContext = { requestId: "request-1", agentId: "agent-1" };

test("coding tasks run on the default, an explicitly chosen, or never a disabled harness", async () => {
  const { router, created } = fakeCodingRouter();
  router.configure("codex", ["codex", "claude-code"]);
  assert.equal(created.length, 0);

  const byDefault = await router.startTask({ prompt: "a" }, codingContext);
  assert.equal(byDefault.provider, "codex");
  const chosen = await router.startTask({ prompt: "b", provider: "claude-code" }, codingContext);
  assert.equal(chosen.provider, "claude-code");
  assert.deepEqual(created.map(item => item.provider), ["codex", "claude-code"]);

  await assert.rejects(
    router.startTask({ prompt: "c", provider: "cursor" }, codingContext),
    (error: any) => error.errorCode === "invalid_arguments" &&
      /cursor coding harness is not enabled/.test(error.message) &&
      /codex, claude-code/.test(error.message) &&
      JSON.stringify(error.details.enabled_providers) === JSON.stringify(["codex", "claude-code"])
  );
  await assert.rejects(
    router.startTask({ prompt: "d", provider: "gpt" }, codingContext),
    (error: any) => error.errorCode === "invalid_arguments" && /provider must be one of/.test(error.message)
  );
  assert.equal(created.length, 2);

  assert.equal((await router.getStatus(String(chosen.task_id))).provider, "claude-code");
  assert.equal((await router.getOutput(String(byDefault.task_id))).provider, "codex");
  assert.equal((await router.cancel(String(chosen.task_id))).provider, "claude-code");
  assert.equal(created[1]!.statuses.get(String(chosen.task_id)), "cancelled");
  assert.equal(created[0]!.statuses.get(String(byDefault.task_id)), "running");
  await assert.rejects(
    router.getStatus("codex_unknown"),
    (error: any) => error.errorCode === "not_found" && /Unknown coding task: codex_unknown/.test(error.message)
  );
  assert.equal(created.length, 2, "an unknown task id creates no adapter");
});

test("get_output options pass through the router to the adapter that started the task", async () => {
  const { router } = fakeCodingRouter();
  router.configure("codex", ["codex", "cursor"]);
  const task = await router.startTask({ prompt: "a", provider: "cursor" }, codingContext);
  const options = { task_id: String(task.task_id), include_events: true, since_event_index: 3 };
  assert.deepEqual(await router.getOutput(String(task.task_id), options), {
    task_id: task.task_id,
    provider: "cursor",
    args: options
  });
  assert.equal((await router.getOutput(String(task.task_id))).args, undefined);
});

test("disabled coding keeps its harness list but registers no coding tools", () => {
  const daemon = new LocalRuntimeDaemon({
    wsUrl: "wss://example.invalid/runtime",
    token: "synthetic",
    allowedDirectories: [process.cwd()],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    capabilities: {
      browser: { enabled: false },
      codex: { enabled: false, provider: "claude-code", providers: ["codex", "claude-code"] }
    }
  });
  const runtime = daemon as any;
  assert.deepEqual(runtime.capabilityPayload().settings.coding_agent, {
    enabled: false, provider: "claude-code", providers: ["codex", "claude-code"], sandbox: "read-only"
  });
  assert.equal(runtime.registry.has("coding_agent.start_task"), false);
  runtime.applyCodingAgentConfiguration({ enabled: true, provider: "claude-code", providers: ["codex", "claude-code"] });
  assert.equal(runtime.registry.has("coding_agent.start_task"), true);
  assert.deepEqual(runtime.codingAgentAdapter.providers, ["codex", "claude-code"]);
});

test("continue_session without provider stays on the harness that owns the session", async () => {
  const { router, created } = fakeCodingRouter();
  router.configure("codex", ["codex", "claude-code", "cursor"]);
  await router.startTask({ prompt: "warm codex" }, codingContext);
  await router.startTask({ prompt: "warm claude", provider: "claude-code" }, codingContext);
  await router.startTask({ prompt: "warm cursor", provider: "cursor" }, codingContext);
  const [codex, claude, cursor] = created;
  codex!.sessions.set("agent-1:/p", { providerSessionId: "thread-1", cwd: "/p", updatedAt: "2026-01-01T00:00:00.000Z" });
  claude!.sessions.set("agent-1:/p", { providerSessionId: "claude-1", cwd: "/p", updatedAt: "2026-01-02T00:00:00.000Z" });

  const continued = await router.startTask({ prompt: "more", project: "/p", continue_session: true }, codingContext);
  assert.equal(continued.provider, "claude-code");
  const otherProject = await router.startTask({ prompt: "more", project: "/q", continue_session: true }, codingContext);
  assert.equal(otherProject.provider, "codex", "no stored session: default harness");
  const fresh = await router.startTask({ prompt: "new", project: "/p" }, codingContext);
  assert.equal(fresh.provider, "codex");
  const explicit = await router.startTask({ prompt: "more", project: "/p", continue_session: true, provider: "cursor" }, codingContext);
  assert.equal(explicit.provider, "cursor");
  assert.equal(cursor!.started.length, 2);

  // An explicit provider_session_id goes to the harness that knows it ...
  const byId = await router.startTask({ prompt: "more", continue_session: true, provider_session_id: "thread-1" }, codingContext);
  assert.equal(byId.provider, "codex");
  // ... and one nobody knows (e.g. after a restart) to the default harness.
  router.configure("cursor", ["codex", "claude-code", "cursor"]);
  const unknownId = await router.startTask({ prompt: "more", continue_session: true, provider_session_id: "lost" }, codingContext);
  assert.equal(unknownId.provider, "cursor");

  // The owning harness is known but no longer enabled (e.g. an old backend
  // switched harness): start fresh on the default, never resume Codex's older
  // session under the same key, and say why.
  router.configure("codex", ["codex", "cursor"]);
  assert.equal(codex!.sessions.has("agent-1:/p"), true);
  const switched = await router.startTask({ prompt: "more", project: "/p", continue_session: true }, codingContext);
  assert.equal(switched.provider, "codex");
  assert.match(String(switched.session_warning), /belonged to the claude-code harness, which is not enabled on this computer; started a new codex session/);
  assert.equal(codex!.sessions.has("agent-1:/p"), false, "the stale Codex session is not resumed");
  const explicitTarget = await router.startTask({ prompt: "more", project: "/p", continue_session: true, provider: "cursor" }, codingContext);
  assert.equal(explicitTarget.provider, "cursor");
  assert.match(String(explicitTarget.session_warning), /started a new cursor session/);
  // Only an explicitly named session of a disabled harness is an error.
  await assert.rejects(
    router.startTask({ prompt: "more", continue_session: true, provider_session_id: "claude-1" }, codingContext),
    (error: any) => error.errorCode === "invalid_arguments" &&
      /belongs to the claude-code harness, which is not enabled/.test(error.message)
  );
});

test("changing coding harness settings keeps running tasks on their original adapter", async () => {
  const settings: Partial<Record<CodingAgentProvider, string>> = { codex: "model-a" };
  const { router, created } = fakeCodingRouter(settings);
  router.configure("codex", ["codex"]);
  const running = await router.startTask({ prompt: "long" }, codingContext);
  const firstCodex = created[0]!;
  const finished = await router.startTask({ prompt: "short" }, codingContext);
  router.taskFinished(String(finished.task_id));

  settings.codex = "model-b";
  router.configure("claude-code", ["claude-code", "codex"]);
  assert.equal(firstCodex.disposed, false);
  assert.equal(firstCodex.statuses.get(String(running.task_id)), "running");
  assert.equal((await router.getStatus(String(running.task_id))).generation, 1);

  const next = await router.startTask({ prompt: "next" }, codingContext);
  assert.equal(next.provider, "claude-code");
  const nextCodex = await router.startTask({ prompt: "next", provider: "codex" }, codingContext);
  assert.equal(nextCodex.generation, 2);
  assert.equal(created[2]!.sessions, firstCodex.sessions, "a rebuilt harness keeps its resumable sessions");

  router.configure("claude-code", ["claude-code"]);
  assert.equal(created[2]!.disposed, false, "disabled harness waits for its running task");
  router.taskFinished(String(running.task_id));
  assert.equal(firstCodex.disposed, true);
  assert.equal((await router.getStatus(String(running.task_id))).generation, 1);
  await assert.rejects(router.startTask({ prompt: "x", provider: "codex" }, codingContext), /not enabled/);

  router.taskFinished(String(nextCodex.task_id));
  assert.equal(created[2]!.disposed, true);
  const claude = created[1]!;
  assert.equal(claude.disposed, false);
  await router.dispose();
  assert.equal(claude.disposed, true);
  assert.equal(claude.statuses.get(String(next.task_id)), "cancelled");
  await assert.rejects(router.startTask({ prompt: "late" }, codingContext), /stopping/);
});

test("a harness retired while a start awaits approval is disposed only after that task ends", async () => {
  const settings: Partial<Record<CodingAgentProvider, string>> = { codex: "a" };
  const { router, created } = fakeCodingRouter(settings);
  router.configure("codex", ["codex"]);
  await router.startTask({ prompt: "warm" }, codingContext).then(result => router.taskFinished(String(result.task_id)));
  const codex = created[0]!;
  const approval = deferred();
  codex.gate = approval.promise;
  const pending = router.startTask({ prompt: "needs approval" }, codingContext);
  await Promise.resolve();

  settings.codex = "b";
  router.configure("codex", ["codex"]);
  assert.equal(codex.disposed, false, "a pending start keeps the retired adapter alive");
  approval.resolve();
  const started = await pending;
  assert.equal(started.generation, 1);
  assert.equal(codex.disposed, false, "its task is still running");
  router.taskFinished(String(started.task_id));
  assert.equal(codex.disposed, true);

  // A start that fails on a retired adapter still releases it.
  const failing = fakeCodingRouter({ codex: "a" });
  failing.router.configure("codex", ["codex"]);
  await failing.router.startTask({ prompt: "warm" }, codingContext);
  const failingCodex = failing.created[0]!;
  const reject = deferred();
  failingCodex.gate = reject.promise.then(() => { throw new Error("approval denied"); });
  const denied = failing.router.startTask({ prompt: "x" }, codingContext);
  failing.router.configure("codex", []);
  failing.router.configure("cursor", ["cursor"]);
  failing.router.taskFinished("codex_1");
  failing.router.taskFinished("codex_reported_before_start_failed");
  assert.equal((failing.router as any).finishedBeforeStart.size, 1);
  reject.resolve();
  await assert.rejects(denied, /approval denied/);
  assert.equal(failingCodex.disposed, true);
  assert.equal((failing.router as any).finishedBeforeStart.size, 0);
});

test("dispose while a start awaits approval cancels that task and rejects the start", async () => {
  const { router, created } = fakeCodingRouter();
  router.configure("codex", ["codex"]);
  await router.startTask({ prompt: "warm" }, codingContext);
  const codex = created[0]!;
  const approval = deferred();
  codex.gate = approval.promise;
  const pending = router.startTask({ prompt: "needs approval" }, codingContext);
  await Promise.resolve();
  const disposing = router.dispose();
  approval.resolve();
  await assert.rejects(pending, /stopped before the coding task could start/);
  await disposing;
  assert.equal(codex.disposed, true);
  assert.deepEqual([...codex.statuses.values()], ["cancelled", "cancelled"]);
});

test("only recent finished coding tasks stay routable; running ones always do", async () => {
  const { router } = fakeCodingRouter({}, 2);
  router.configure("codex", ["codex"]);
  const longRunning = await router.startTask({ prompt: "long" }, codingContext);
  const finished: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await router.startTask({ prompt: `short ${index}` }, codingContext);
    router.taskFinished(String(result.task_id));
    finished.push(String(result.task_id));
  }
  assert.equal((await router.getStatus(String(longRunning.task_id))).status, "running");
  assert.equal((await router.getStatus(finished[2]!)).status, "running");
  await assert.rejects(router.getStatus(finished[0]!), /Unknown coding task/);
});

test("daemon routes real harness tasks, continues sessions on their harness, and reports providers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clero-harness-routing-"));
  const fakeCli = path.join(directory, "fake-coding-cli.mjs");
  await writeFile(fakeCli, `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
  if (args[0] === "-p") {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", result: "claude done", session_id: "claude-session-1" }));
  } else {
    console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex done" } }));
  }
});
`);
  await chmod(fakeCli, 0o755);
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const daemon = new LocalRuntimeDaemon({
    wsUrl: "wss://example.invalid/runtime",
    token: "synthetic",
    allowedDirectories: [directory],
    interactiveApprovals: false,
    logger: quiet,
    auditLogger: { record() {} },
    capabilities: {
      browser: { enabled: false },
      codex: {
        enabled: true, provider: "codex", providers: ["codex", "claude-code"],
        command: fakeCli, claudeCommand: fakeCli, defaultSandbox: "read-only", claudePermissionMode: "default"
      }
    }
  });
  const runtime = daemon as any;
  const sent: any[] = [];
  runtime.websocket.send = (message: any) => sent.push(message);
  const router: CodingAgentRouter = runtime.codingAgentAdapter;
  const settle = async (taskId: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = await router.getStatus(taskId);
      if (status.status !== "running") return status;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`task ${taskId} did not finish`);
  };
  try {
    assert.deepEqual(runtime.capabilityPayload().settings.coding_agent, {
      enabled: true, provider: "codex", providers: ["codex", "claude-code"], sandbox: "read-only"
    });

    const claudeTask = await router.startTask({ prompt: "one", cwd: directory, continue_session: true, provider: "claude-code" }, codingContext);
    assert.equal(claudeTask.provider, "claude-code");
    const claudeDone = await settle(String(claudeTask.task_id));
    assert.equal(claudeDone.status, "completed");
    assert.equal(claudeDone.provider_session_id, "claude-session-1");

    const continued = await router.startTask({ prompt: "two", cwd: directory, continue_session: true }, codingContext);
    assert.equal(continued.provider, "claude-code");
    assert.equal(continued.resumed_session, true);
    assert.equal(continued.provider_session_id, "claude-session-1");
    await settle(String(continued.task_id));

    const codexTask = await router.startTask({ prompt: "three", cwd: directory }, codingContext);
    assert.equal(codexTask.provider, "codex");
    const codexDone = await settle(String(codexTask.task_id));
    assert.equal(codexDone.status, "completed");
    assert.equal(codexDone.final_message, "codex done");

    const completions = sent.filter(message => message.type === "local_task_completed");
    assert.deepEqual(
      completions.map(message => [message.task_id, message.result.provider]),
      [
        [claudeTask.task_id, "claude-code"],
        [continued.task_id, "claude-code"],
        [codexTask.task_id, "codex"]
      ]
    );
    assert.ok(sent.some(message => message.type === "local_task_event" && message.task.provider === "claude-code"));

    // Real settings fingerprints: a Claude-only change keeps the Codex adapter.
    const codexAdapter = (router as any).active.get("codex").adapter;
    const claudeAdapter = (router as any).active.get("claude-code").adapter;
    runtime.applyCodingAgentConfiguration({
      enabled: true, provider: "codex", providers: ["codex", "claude-code"],
      command: fakeCli, claude_command: fakeCli, claude_model: "claude-test"
    });
    assert.equal((router as any).active.get("codex").adapter, codexAdapter);
    assert.equal((router as any).active.get("claude-code"), undefined);
    assert.notEqual((router as any).harness("claude-code").adapter, claudeAdapter);

    const byId = await router.startTask({ prompt: "by id", cwd: directory, continue_session: true, provider_session_id: "claude-session-1" }, codingContext);
    assert.equal(byId.provider, "claude-code");
    assert.equal(byId.resumed_session, true);
    await settle(String(byId.task_id));
    const unknownId = await router.startTask({ prompt: "lost", cwd: directory, continue_session: true, provider_session_id: "from-before-restart" }, codingContext);
    assert.equal(unknownId.provider, "codex");
    assert.equal(unknownId.resumed_session, true);
    await settle(String(unknownId.task_id));

    // Claude holds the most recent session for this agent/project ...
    const latestClaude = await router.startTask({ prompt: "latest", cwd: directory, continue_session: true, provider: "claude-code" }, codingContext);
    assert.equal(latestClaude.resumed_session, true);
    await settle(String(latestClaude.task_id));
    // ... when an old backend switches the harness to Codex.
    runtime.applyCodingAgentConfiguration({ enabled: true, provider: "codex", providers: ["codex"], command: fakeCli });
    assert.deepEqual(runtime.capabilityPayload().settings.coding_agent.providers, ["codex"]);
    await assert.rejects(
      router.startTask({ prompt: "four", cwd: directory, provider: "claude-code" }, codingContext),
      /claude-code coding harness is not enabled on this computer\. Enabled coding harnesses: codex/
    );
    const afterSwitch = await router.startTask({ prompt: "five", cwd: directory, continue_session: true }, codingContext);
    assert.equal(afterSwitch.provider, "codex");
    assert.equal(afterSwitch.resumed_session, false);
    assert.match(String(afterSwitch.session_warning), /belonged to the claude-code harness/);
    await settle(String(afterSwitch.task_id));
    const resumedCodex = await router.startTask({ prompt: "six", cwd: directory, continue_session: true }, codingContext);
    assert.equal(resumedCodex.provider, "codex");
    assert.equal(resumedCodex.resumed_session, true, "the fresh Codex session is continued next time");
    assert.equal(resumedCodex.session_warning, undefined);
    await settle(String(resumedCodex.task_id));
    await assert.rejects(
      router.startTask({ prompt: "seven", cwd: directory, continue_session: true, provider_session_id: "claude-session-1" }, codingContext),
      /belongs to the claude-code harness, which is not enabled/
    );
    assert.equal((await router.getStatus(String(claudeTask.task_id))).provider, "claude-code");
  } finally {
    for (const pending of runtime.pendingLocalTaskCompletions.values()) runtime.clearLocalTaskCompletionTimers(pending);
    runtime.pendingLocalTaskCompletions.clear();
    await router.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("harnesses the host reports as not installed are skipped for the run but stay configured", () => {
  const daemon = new LocalRuntimeDaemon({
    wsUrl: "wss://example.invalid/runtime",
    token: "synthetic",
    allowedDirectories: [process.cwd()],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    unavailableCodingProviders: ["cursor", "claude-code"],
    capabilities: {
      browser: { enabled: false },
      codex: { enabled: true, provider: "claude-code", providers: ["codex", "claude-code", "cursor"] }
    }
  });
  const runtime = daemon as any;
  assert.deepEqual(runtime.capabilityPayload().settings.coding_agent.providers, ["codex", "claude-code"], "the default is never skipped");
  assert.deepEqual(runtime.codingAgentAdapter.providers, ["codex", "claude-code"]);
  assert.deepEqual(runtime.options.capabilities.codex.providers, ["codex", "claude-code", "cursor"]);
  runtime.applyCodingAgentConfiguration({ enabled: true, provider: "codex", providers: ["codex", "cursor"] });
  assert.deepEqual(runtime.codingAgentAdapter.providers, ["codex"]);
});

test("a harness skipped for this run does not switch the others to single-harness access", () => {
  const daemon = new LocalRuntimeDaemon({
    wsUrl: "wss://example.invalid/runtime",
    token: "synthetic",
    allowedDirectories: [process.cwd()],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    unavailableCodingProviders: ["claude-code"],
    capabilities: {
      browser: { enabled: false },
      codex: {
        enabled: true,
        provider: "codex",
        providers: ["codex", "claude-code"],
        defaultSandbox: "read-only",
        claudePermissionMode: "bypassPermissions",
        // Shared grants (here from Claude's mode) must not reach Codex.
        allowWorkspaceWrite: true,
        allowDangerFullAccess: true
      }
    }
  });
  const runtime = daemon as any;
  assert.deepEqual(runtime.codingAgentAdapter.providers, ["codex"]);
  const codexOptions = runtime.codingAgentAdapter.harness("codex").adapter.options;
  assert.equal(codexOptions.allowWorkspaceWrite, false);
  assert.equal(codexOptions.allowDangerFullAccess, false);
});

test("coding-agent commands resolve like the adapters spawn them, without running them", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clero-detect-"));
  try {
    const bin = path.join(directory, "bin");
    const other = path.join(directory, "other");
    await mkdir(bin);
    await mkdir(other);
    const codex = path.join(bin, "codex");
    await writeFile(codex, "#!/bin/sh\nexit 1\n");
    await chmod(codex, 0o755);
    const notExecutable = path.join(other, "claude");
    await writeFile(notExecutable, "not a program");
    await chmod(notExecutable, 0o644);
    const custom = path.join(other, "my-cursor");
    await writeFile(custom, "#!/bin/sh\n");
    await chmod(custom, 0o755);
    const env = { PATH: `${other}${path.delimiter}${bin}` };

    assert.deepEqual(resolveCodingAgentCommand("codex", { env }), { installed: true, path: codex });
    assert.deepEqual(resolveCodingAgentCommand(codex, { env: {} }), { installed: true, path: codex });
    assert.deepEqual(resolveCodingAgentCommand("missing-agent", { env }), { installed: false, path: null });
    assert.deepEqual(resolveCodingAgentCommand("claude", { env }), { installed: false, path: null }, "not executable");
    assert.deepEqual(resolveCodingAgentCommand(notExecutable, { env }), { installed: false, path: null });
    assert.deepEqual(resolveCodingAgentCommand("bin", { env: { PATH: directory } }), { installed: false, path: null }, "a directory");
    // Relative paths depend on the task's directory, so they are never reported as installed.
    const daemonCwd = process.cwd();
    process.chdir(directory);
    try {
      assert.deepEqual(resolveCodingAgentCommand("./bin/codex", { env: {} }), { installed: false, path: null }, "relative path");
      assert.deepEqual(resolveCodingAgentCommand("bin/codex", { env: {} }), { installed: false, path: null }, "relative path");
      assert.deepEqual(
        resolveCodingAgentCommand("codex", { env: { PATH: "bin" } }),
        { installed: false, path: null },
        "relative PATH entry"
      );
    } finally {
      process.chdir(daemonCwd);
    }
    assert.deepEqual(resolveCodingAgentCommand("~/codex", { env }), { installed: false, path: null }, "spawn does not expand ~");
    assert.deepEqual(resolveCodingAgentCommand("  ", { env }), { installed: false, path: null });

    const detected = detectCodingAgents(
      { command: "", claude_command: "", antigravity_command: " ", cursor_command: custom },
      { env: { ...env, CLERO_LOCAL_AGENT_ANTIGRAVITY_BIN: codex } }
    );
    assert.deepEqual(detected, [
      { provider: "codex", command: "codex", installed: true, path: codex },
      { provider: "claude-code", command: "claude", installed: false, path: null },
      { provider: "antigravity", command: codex, installed: true, path: codex },
      { provider: "cursor", command: custom, installed: true, path: custom }
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows command lookup follows Node's spawn without a shell", () => {
  const win32 = { platform: "win32" as const };
  assert.deepEqual(
    codingAgentCommandCandidates("agent", { ...win32, env: { Path: 'C:\\Tools;"C:\\Program Files\\Cursor";relative\\bin;;' } }),
    [
      "C:\\Tools\\agent.COM",
      "C:\\Tools\\agent.EXE",
      "C:\\Program Files\\Cursor\\agent.COM",
      "C:\\Program Files\\Cursor\\agent.EXE"
    ],
    "PATH found case-insensitively, quotes stripped, relative and empty entries skipped, no current-directory lookup"
  );
  assert.deepEqual(
    codingAgentCommandCandidates("codex.exe", { ...win32, env: { PATH: "C:\\bin" } }),
    ["C:\\bin\\codex.exe", "C:\\bin\\codex.exe.COM", "C:\\bin\\codex.exe.EXE"]
  );
  assert.deepEqual(
    codingAgentCommandCandidates("C:\\Tools\\claude", { ...win32, env: {} }),
    ["C:\\Tools\\claude.COM", "C:\\Tools\\claude.EXE"]
  );
  for (const command of ["claude.cmd", "agent.BAT", "C:\\Tools\\codex.cmd"]) {
    assert.deepEqual(codingAgentCommandCandidates(command, { ...win32, env: { PATH: "C:\\bin" } }), [], command);
    assert.deepEqual(resolveCodingAgentCommand(command, { ...win32, env: { PATH: "C:\\bin" } }), { installed: false, path: null });
  }
  for (const command of [".\\codex.exe", "tools\\codex", "C:codex"]) {
    assert.deepEqual(codingAgentCommandCandidates(command, { ...win32, env: { PATH: "C:\\bin" } }), [], command);
  }
});

test("get and set coding-agent config report detected harnesses without storing them", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clero-detect-config-"));
  try {
    const configPath = path.join(directory, "config.json");
    const fakeCodex = path.join(directory, "codex-cli");
    await writeFile(fakeCodex, "#!/bin/sh\n");
    await chmod(fakeCodex, 0o755);
    await writeFile(configPath, JSON.stringify({ capabilities: { codex: { enabled: true, provider: "codex", command: fakeCodex } } }));
    const runtimeConfig = await loadRuntimeConfig(configPath);
    const daemon = new LocalRuntimeDaemon({
      wsUrl: "wss://example.invalid/runtime",
      token: "synthetic",
      allowedDirectories: [directory],
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      codingAgentConfiguration: {
        get: () => codingAgentConfigFromRuntimeConfig(runtimeConfig),
        set: async (config) => {
          const saved = applyCodingAgentConfigUpdate(runtimeConfig, config);
          await saveRuntimeConfig(configPath, runtimeConfig);
          return saved;
        }
      },
      capabilities: { browser: { enabled: false }, codex: { enabled: true, provider: "codex", command: fakeCodex } }
    });
    const runtime = daemon as any;
    runtime.sendHeartbeat = () => undefined;
    const get = await runtime.handleControlRequest({ type: "control_request", request_id: "get-1", action: "get_coding_agent_config", arguments: {} });
    assert.equal(get.status, "ok");
    assert.deepEqual(get.result.detected.map((item: any) => item.provider), ["codex", "claude-code", "antigravity", "cursor"]);
    assert.deepEqual(get.result.detected[0], { provider: "codex", command: fakeCodex, installed: true, path: fakeCodex });
    assert.equal(get.result.grant_rules, CODING_AGENT_GRANT_RULES_VERSION);
    assert.equal(get.result.grant_rules, 2);

    const echoed = { ...get.result, providers: ["codex", "cursor"], cursor_command: path.join(directory, "missing-cursor") };
    const set = await runtime.handleControlRequest({ type: "control_request", request_id: "set-1", action: "set_coding_agent_config", arguments: echoed });
    assert.equal(set.status, "ok");
    assert.deepEqual(set.result.providers, ["codex", "cursor"]);
    assert.equal(set.result.grant_rules, 2);
    assert.deepEqual(set.result.detected[3], {
      provider: "cursor", command: path.join(directory, "missing-cursor"), installed: false, path: null
    });
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal("detected" in stored.capabilities.codex, false);
    assert.equal(JSON.stringify(stored).includes("\"detected\""), false);
    assert.equal(JSON.stringify(stored).includes("grant_rules"), false);
    // An echoed (or forged) grant_rules is ignored, not stored.
    const forged = await runtime.handleControlRequest({
      type: "control_request", request_id: "set-2", action: "set_coding_agent_config", arguments: { grant_rules: 99, model: "x" }
    });
    assert.equal(forged.result.grant_rules, 2);
    assert.equal((await readFile(configPath, "utf8")).includes("grant_rules"), false);
    assert.deepEqual(stored.capabilities.codex.providers, ["codex", "cursor"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote coding config reports the real on/off state and only an explicit enabled changes it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clero-coding-enabled-"));
  try {
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ capabilities: { codex: { enabled: false, provider: "codex" } } }));
    const runtimeConfig = await loadRuntimeConfig(configPath);
    const daemon = new LocalRuntimeDaemon({
      wsUrl: "wss://example.invalid/runtime",
      token: "synthetic",
      allowedDirectories: [directory],
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      codingAgentConfiguration: {
        get: () => codingAgentConfigFromRuntimeConfig(runtimeConfig),
        set: async (config) => {
          const saved = applyCodingAgentConfigUpdate(runtimeConfig, config);
          await saveRuntimeConfig(configPath, runtimeConfig);
          return saved;
        }
      },
      capabilities: { browser: { enabled: false }, codex: { enabled: false, provider: "codex" } }
    });
    const runtime = daemon as any;
    runtime.sendHeartbeat = () => undefined;
    const control = (action: string, args: JsonObject) => runtime.handleControlRequest({
      type: "control_request", request_id: `${action}-${Math.random()}`, action, arguments: args
    });
    const heartbeatEnabled = () => runtime.capabilityPayload().settings.coding_agent.enabled;
    const stored = async () => JSON.parse(await readFile(configPath, "utf8")).capabilities.codex.enabled;

    const get = await control("get_coding_agent_config", {});
    assert.equal(get.result.enabled, false);
    assert.equal(heartbeatEnabled(), false);

    // A model or harness change without `enabled` never switches coding on.
    const modelOnly = await control("set_coding_agent_config", { model: "gpt-test", providers: ["codex", "cursor"] });
    assert.equal(modelOnly.status, "ok");
    assert.equal(modelOnly.result.enabled, false);
    assert.equal(heartbeatEnabled(), false);
    assert.equal(runtime.registry.has("coding_agent.start_task"), false);
    assert.equal(await stored(), false);

    const on = await control("set_coding_agent_config", { enabled: true });
    assert.equal(on.result.enabled, true);
    assert.equal(heartbeatEnabled(), true);
    assert.equal(runtime.registry.has("coding_agent.start_task"), true);
    assert.equal((await control("get_coding_agent_config", {})).result.enabled, true);

    // ... and the omitted state now stays on.
    const stillOn = await control("set_coding_agent_config", { model: "gpt-other" });
    assert.equal(stillOn.result.enabled, true);
    assert.equal(heartbeatEnabled(), true);
    assert.equal(await stored(), true);

    const off = await control("set_coding_agent_config", { enabled: false });
    assert.equal(off.result.enabled, false);
    assert.equal(heartbeatEnabled(), false);
    assert.equal(runtime.registry.has("coding_agent.start_task"), false);
    assert.equal((await control("get_coding_agent_config", {})).result.enabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("get_coding_agent_config reports the running state even if the embedder's stored value differs", async () => {
  const daemon = new LocalRuntimeDaemon({
    wsUrl: "wss://example.invalid/runtime",
    token: "synthetic",
    allowedDirectories: [process.cwd()],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    codingAgentConfiguration: {
      get: () => ({ enabled: true, provider: "codex", providers: ["codex"] }),
      set: async (config) => config
    },
    capabilities: { browser: { enabled: false }, codex: { enabled: false, provider: "codex" } }
  });
  const runtime = daemon as any;
  runtime.sendHeartbeat = () => undefined;
  const get = await runtime.handleControlRequest({ type: "control_request", request_id: "g", action: "get_coding_agent_config", arguments: {} });
  assert.equal(get.result.enabled, false);
  // An embedder whose set does not merge still keeps the state when enabled is omitted.
  const set = await runtime.handleControlRequest({ type: "control_request", request_id: "s", action: "set_coding_agent_config", arguments: { model: "x" } });
  assert.equal(set.result.enabled, false);
  assert.equal(runtime.capabilityPayload().settings.coding_agent.enabled, false);
});

test("Claude bypassPermissions runs on the local full-access setting without a one-time user approval", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clero-claude-bypass-"));
  const fakeCli = path.join(directory, "fake-coding-cli.mjs");
  await writeFile(fakeCli, `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
  if (args[0] === "-p") {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", result: "claude done", session_id: "claude-session" }));
  } else {
    console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex done" } }));
  }
});
`);
  await chmod(fakeCli, 0o755);
  const daemons: any[] = [];
  // Settings as stored in config.json; options are built the way the CLI daemon builds them.
  const start = (codex: Record<string, unknown>) => {
    const daemon = new LocalRuntimeDaemon({
      wsUrl: "wss://example.invalid/runtime",
      token: "synthetic",
      allowedDirectories: [directory],
      interactiveApprovals: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      auditLogger: { record() {} },
      capabilities: {
        ...capabilityOptionsFromConfig({ capabilities: { codex: { enabled: true, command: fakeCli, claude_command: fakeCli, ...codex } } }),
        browser: { enabled: false }
      }
    }) as any;
    const sent: any[] = [];
    daemon.websocket.send = (message: any) => sent.push(message);
    daemons.push(daemon);
    return { router: daemon.codingAgentAdapter as CodingAgentRouter, sent };
  };
  // A config file as written by an older version, loaded the way the CLI daemon loads it.
  const loadLegacy = async (codex: Record<string, unknown>) => {
    const legacyPath = path.join(directory, "legacy-config.json");
    await writeFile(legacyPath, JSON.stringify({ capabilities: { codex } }));
    const { command: _command, claude_command: _claudeCommand, ...loaded } = (await loadRuntimeConfig(legacyPath)).capabilities!.codex!;
    return loaded as Record<string, unknown>;
  };
  // An agent-started task: no approval token, no interactive user.
  const agentTask = (router: CodingAgentRouter, args: JsonObject) =>
    router.startTask({ prompt: "go", cwd: directory, ...args }, { requestId: "request-1", agentId: "agent-1" });
  const disabled = /Claude bypassPermissions mode is disabled in local settings/;
  try {
    // Codex + Claude, Claude's own mode is bypassPermissions.
    const multi = start({ provider: "codex", providers: ["codex", "claude-code"], claude_permission_mode: "bypassPermissions" });
    const ran = await agentTask(multi.router, { provider: "claude-code" });
    assert.equal(ran.provider, "claude-code");
    assert.equal(ran.permission_mode, "bypassPermissions");
    assert.equal(ran.approval_reason, "Approved by local full-access setting");
    assert.equal(multi.sent.some((message) => message.type === "approval_request"), false);

    // Claude's mode is default: a per-task bypass request is still refused.
    const defaultMode = start({ provider: "codex", providers: ["codex", "claude-code"], claude_permission_mode: "default" });
    await assert.rejects(agentTask(defaultMode.router, { provider: "claude-code", permission_mode: "bypassPermissions" }), disabled);

    // A Codex full-access sandbox next to a default-mode Claude gives Claude nothing.
    const codexFull = start({
      provider: "codex",
      providers: ["codex", "claude-code"],
      default_sandbox: "danger-full-access",
      claude_permission_mode: "default",
      allow_workspace_write: true,
      allow_danger_full_access: true
    });
    await assert.rejects(agentTask(codexFull.router, { provider: "claude-code", permission_mode: "bypassPermissions" }), disabled);

    // Claude alone: the stored full-access grant decides.
    const granted = start({ provider: "claude-code", providers: ["claude-code"], claude_permission_mode: "bypassPermissions", allow_danger_full_access: true });
    const lone = await agentTask(granted.router, {});
    assert.equal(lone.permission_mode, "bypassPermissions");
    assert.equal(lone.approval_reason, "Approved by local full-access setting");
    const notGranted = start({ provider: "claude-code", providers: ["claude-code"], claude_permission_mode: "bypassPermissions", allow_danger_full_access: false });
    await assert.rejects(agentTask(notGranted.router, {}), disabled);
    // A full-access grant left over from Codex in a pre-multi-harness file (no providers
    // key; switched with an old CLI that did not recompute grants): Claude Code's own mode
    // is default, so a per-task bypass asks for approval, which an agent does not have.
    const legacyFile = await loadLegacy({
      enabled: true,
      provider: "claude-code",
      default_sandbox: "danger-full-access",
      claude_permission_mode: "default",
      allow_workspace_write: true,
      allow_danger_full_access: true
    });
    assert.deepEqual(legacyFile.providers, ["claude-code"]);
    const leftoverGrant = start(legacyFile);
    await assert.rejects(
      agentTask(leftoverGrant.router, { permission_mode: "bypassPermissions" }),
      /Approval denied for Claude Code bypassPermissions task/
    );
    // Stored grant with Claude Code on acceptEdits: a per-task bypass also asks.
    const acceptEdits = start({ provider: "claude-code", providers: ["claude-code"], claude_permission_mode: "acceptEdits", allow_workspace_write: true, allow_danger_full_access: true });
    await assert.rejects(
      agentTask(acceptEdits.router, { permission_mode: "bypassPermissions" }),
      /Approval denied for Claude Code bypassPermissions task/
    );
    // ... and a leftover full-access sandbox does not count for Claude alone.
    const leftover = start({ provider: "claude-code", providers: ["claude-code"], claude_permission_mode: "bypassPermissions", default_sandbox: "danger-full-access" });
    await assert.rejects(agentTask(leftover.router, {}), disabled);

    for (const { router } of [multi, granted]) {
      for (const taskId of [String(ran.task_id), String(lone.task_id)]) {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const status = await router.getStatus(taskId).catch(() => ({ status: "unknown" }));
          if (status.status !== "running") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
  } finally {
    for (const daemon of daemons) {
      for (const pending of daemon.pendingLocalTaskCompletions.values()) daemon.clearLocalTaskCompletionTimers(pending);
      daemon.pendingLocalTaskCompletions.clear();
      await daemon.codingAgentAdapter.dispose();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
