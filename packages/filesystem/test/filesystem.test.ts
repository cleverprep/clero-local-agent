import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexCliAdapter } from "@clero-local-agent/coding-agents";
import {
  FilesystemTools,
  OfficialFilesystemMcpClient,
  type FilesystemMcpClient
} from "@clero-local-agent/filesystem";
import { ToolRegistry } from "@clero-local-agent/mcp-runtime";
import type { JsonObject, JsonValue } from "@clero-local-agent/protocol";
import { WorkspacePolicy, WorkspaceTools } from "@clero-local-agent/workspace";
import { LeaseManager } from "../../daemon/src/lease-manager.ts";

test("filesystem-root policy accepts any accessible folder and keeps discovery home-based", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "clero-any-folder-test-"));
  const filesystemRoot = path.parse(os.homedir()).root;
  const workspacePolicy = new WorkspacePolicy({ allowedDirectories: [filesystemRoot] });
  const client = new OfficialFilesystemMcpClient({
    allowedDirectories: workspacePolicy.listAllowedDirectories()
  });
  const definitions = new FilesystemTools({ workspacePolicy, client }).definitions();

  try {
    await writeFile(path.join(project, "outside-projects.txt"), "available anywhere\n");
    assert.equal(workspacePolicy.resolveProjectDirectory(project), realpathSync(project));
    assert.deepEqual(workspacePolicy.listAllowedDirectories(), [realpathSync(filesystemRoot)]);
    assert.deepEqual(workspacePolicy.listDiscoveryDirectories(), [realpathSync(os.homedir())]);
    assert.equal(workspacePolicy.defaultDirectory(), realpathSync(os.homedir()));
    const readResult = await callTool(definitions, "filesystem.read_text_file", {
      project,
      path: "outside-projects.txt"
    });
    assert.equal(resultContent(readResult), "available anywhere\n");
  } finally {
    await client.dispose();
    await rm(project, { recursive: true, force: true });
  }
});

test("filesystem tools call the official MCP server inside allowed roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-filesystem-test-"));
  await writeFile(path.join(root, "package.json"), '{"name":"filesystem-test"}\n');
  await writeFile(path.join(root, "example.txt"), "hello world\n");

  const workspacePolicy = new WorkspacePolicy({ allowedDirectories: [root] });
  const client = new OfficialFilesystemMcpClient({
    allowedDirectories: workspacePolicy.listAllowedDirectories()
  });
  const definitions = new FilesystemTools({ workspacePolicy, client }).definitions();

  try {
    const readResult = await callTool(definitions, "filesystem.read_text_file", {
      project: root,
      path: "example.txt"
    });
    assert.equal(resultContent(readResult), "hello world\n");

    const writeDefinition = definitions.find((item) => item.name === "filesystem.write_file");
    const editDefinition = definitions.find((item) => item.name === "filesystem.edit_file");
    assert.equal(writeDefinition?.requiresLease, true);
    assert.equal(editDefinition?.requiresLease, true);

    await callTool(definitions, "filesystem.write_file", {
      project: root,
      path: "created.txt",
      content: "first version\n"
    });
    await callTool(definitions, "filesystem.edit_file", {
      project: root,
      path: "created.txt",
      edits: [{ oldText: "first version", newText: "second version" }]
    });
    assert.equal(await readFile(path.join(root, "created.txt"), "utf8"), "second version\n");

    await assert.rejects(
      () => callTool(definitions, "filesystem.read_text_file", {
        project: root,
        path: "../outside.txt"
      }),
      /outside allowed workspaces/
    );
  } finally {
    await client.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem MCP requests fail locally before the backend timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-filesystem-timeout-test-"));
  const serverEntrypoint = path.join(root, "silent-server.mjs");
  await writeFile(
    serverEntrypoint,
    'process.stdin.resume();\nprocess.stdin.on("data", () => {});\n'
  );
  const client = new OfficialFilesystemMcpClient({
    allowedDirectories: [root],
    serverEntrypoint,
    requestTimeoutMs: 1_000
  });

  try {
    await assert.rejects(
      () => client.callTool("read_text_file", { path: path.join(root, "missing.txt") }),
      /timed out after 1000ms/
    );
  } finally {
    await client.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem defaults to clero while allowing the rest of the user directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "clero-home-test-"));
  const cleroDirectory = path.join(home, "clero");
  const outsideClero = path.join(home, "Documents");
  await mkdir(cleroDirectory, { recursive: true });
  await mkdir(outsideClero, { recursive: true });
  const workspacePolicy = new WorkspacePolicy({
    allowedDirectories: [home],
    defaultDirectory: cleroDirectory
  });

  try {
    assert.equal(workspacePolicy.defaultDirectory(), realpathSync(cleroDirectory));
    assert.equal(workspacePolicy.resolveProjectDirectory(), realpathSync(cleroDirectory));
    assert.deepEqual(workspacePolicy.listAllowedDirectories(), [realpathSync(home)]);
    assert.equal(
      workspacePolicy.resolveAllowedPath("dashboard.html"),
      path.join(realpathSync(cleroDirectory), "dashboard.html")
    );
    assert.equal(
      workspacePolicy.resolveAllowedPath(path.join(outsideClero, "notes.txt")),
      path.join(realpathSync(outsideClero), "notes.txt")
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("leases are scoped by the actual tool rather than the shared backend action", () => {
  let leaseNumber = 0;
  const leaseManager = new LeaseManager({
    maxAgentSlots: 3,
    leaseIdFactory: () => `lease-${++leaseNumber}`
  });

  const filesystemLease = leaseManager.ensureLeaseForToolCall({
    requestId: "filesystem-request",
    agentId: "filesystem-agent",
    taskId: "filesystem-task",
    requestedActionKey: "local_runtime_181.shell",
    toolName: "filesystem.write_file",
    workspaceKey: "/Users/example/clero"
  });
  const browserLease = leaseManager.ensureLeaseForToolCall({
    requestId: "browser-request",
    agentId: "browser-agent",
    taskId: "browser-task",
    requestedActionKey: "local_runtime_181.shell",
    toolName: "browser.screenshot"
  });

  assert.equal(filesystemLease.status, "ok");
  assert.equal(browserLease.status, "ok");
  assert.equal(leaseManager.getStatus().active_leases?.length, 2);
});

test("tool registry releases an automatically acquired lease after the call", async () => {
  const released: string[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "filesystem.write_file",
    description: "write",
    inputSchema: { type: "object", properties: {} },
    requiresLease: true,
    handler: () => ({ written: true })
  });

  const result = await registry.execute(
    {
      type: "tool_call",
      request_id: "write-request",
      tool: "filesystem.write_file",
      arguments: {}
    },
    {
      hasActiveLease: () => false,
      ensureLeaseForToolCall: () => ({ status: "ok", leaseId: "implicit-lease" }),
      releaseLease: (leaseId) => released.push(leaseId)
    }
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(released, ["implicit-lease"]);
});

test("filesystem search rejects home and applies safe default exclusions", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "clero-search-test-"));
  const workspacePolicy = new WorkspacePolicy({
    allowedDirectories: [path.parse(os.homedir()).root]
  });
  const calls: Array<{ name: string; args: JsonObject }> = [];
  const client: FilesystemMcpClient = {
    callTool: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve({ matches: [] });
    }
  };
  const definitions = new FilesystemTools({ workspacePolicy, client }).definitions();

  try {
    await assert.rejects(
      () => callTool(definitions, "filesystem.search_files", {
        project: os.homedir(),
        path: ".",
        pattern: "**/*.ts"
      }),
      /Search root is too broad/
    );

    await callTool(definitions, "filesystem.search_files", {
      project,
      path: ".",
      pattern: "**/*.ts",
      excludePatterns: ["fixtures/**"]
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "search_files");
    const excludePatterns = calls[0]?.args.excludePatterns;
    assert.ok(Array.isArray(excludePatterns));
    assert.ok(excludePatterns.includes("**/node_modules/**"));
    assert.ok(excludePatterns.includes("**/.git/**"));
    assert.ok(excludePatterns.includes("fixtures/**"));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("workspace resolves markerless project folders and skips hidden discovery trees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  const markerlessProject = path.join(root, "hackaton");
  const visibleProject = path.join(root, "visible-project");
  const hiddenProject = path.join(root, ".antigravity", "extensions", "hidden-project");
  await mkdir(markerlessProject, { recursive: true });
  await mkdir(visibleProject, { recursive: true });
  await mkdir(hiddenProject, { recursive: true });
  await writeFile(path.join(visibleProject, "package.json"), '{"name":"visible-project"}\n');
  await writeFile(path.join(hiddenProject, "package.json"), '{"name":"hidden-project"}\n');
  const workspacePolicy = new WorkspacePolicy({ allowedDirectories: [root] });
  const workspaceTools = new WorkspaceTools(workspacePolicy);

  try {
    assert.equal(
      workspacePolicy.resolveProjectDirectory("hackaton"),
      realpathSync(markerlessProject)
    );
    const result = await workspaceTools.listProjects({ max_depth: 4 });
    const projects = Array.isArray(result.projects) ? result.projects : [];
    assert.equal(projects.length, 1);
    assert.equal(
      projects[0] && typeof projects[0] === "object" && !Array.isArray(projects[0])
        ? projects[0].name
        : null,
      "visible-project"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex tasks bypass the git repository check for markerless workspaces", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "clero-codex-markerless-test-"));
  const workspacePolicy = new WorkspacePolicy({ allowedDirectories: [project] });
  let startedArgs: JsonValue[] = [];
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const adapter = new CodexCliAdapter({
    workspacePolicy,
    command: "/usr/bin/true",
    defaultSandbox: "read-only",
    onTaskEvent: (_task, event) => {
      if (event.type === "process.started" && Array.isArray(event.data?.args)) {
        startedArgs = event.data.args;
      }
    },
    onTaskTerminal: () => resolveTerminal?.()
  });

  try {
    await adapter.startTask(
      {
        prompt: "Inspect this markerless workspace.",
        cwd: project
      },
      { requestId: "markerless-codex-test" }
    );
    await terminal;
    assert.ok(startedArgs.includes("--skip-git-repo-check"));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

async function callTool(
  definitions: ReturnType<FilesystemTools["definitions"]>,
  name: string,
  args: JsonObject
): Promise<JsonValue> {
  const definition = definitions.find((item) => item.name === name);
  assert.ok(definition, `Missing tool definition: ${name}`);
  return definition.handler(args, { requestId: `test-${name}` });
}

function resultContent(result: JsonValue): string | undefined {
  return result && typeof result === "object" && !Array.isArray(result) && typeof result.content === "string"
    ? result.content
    : undefined;
}
