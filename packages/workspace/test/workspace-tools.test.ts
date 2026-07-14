import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolExecutionError } from "@clero-local-agent/mcp-runtime";
import { WorkspacePolicy, WorkspaceTools } from "../src/index.ts";

test("lists allowed workspace roots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realRoot = realpathSync(root);
  const tools = new WorkspaceTools(new WorkspacePolicy({ allowedDirectories: [root] }));

  const result = tools.listRoots();

  assert.deepEqual(result.roots, [{ path: realRoot, name: path.basename(realRoot) }]);
});

test("uses the first allowed root as the default directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realRoot = realpathSync(root);
  const policy = new WorkspacePolicy({ allowedDirectories: [root] });

  assert.equal(policy.resolveAllowedDirectory(), realRoot);
  assert.equal(policy.resolveAllowedDirectory("."), realRoot);
});

test("rejects a missing cwd with an invalid arguments error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = new WorkspacePolicy({ allowedDirectories: [root] });
  const missing = path.join(root, "missing");
  const isMissingCwdError = (error: unknown) =>
    error instanceof ToolExecutionError &&
    error.errorCode === "invalid_arguments" &&
    error.message.includes(`cwd does not exist: ${missing}`);

  assert.throws(() => policy.resolveAllowedDirectory(missing), isMissingCwdError);
  assert.throws(() => policy.isAllowed(missing), isMissingCwdError);
});

test("resolves a unique relative upload file across allowed roots", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "clero-upload-file-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const firstRoot = path.join(parent, "first");
  const secondRoot = path.join(parent, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const filePath = path.join(secondRoot, "report.txt");
  await writeFile(filePath, "report");
  const policy = new WorkspacePolicy({ allowedDirectories: [firstRoot, secondRoot] });

  assert.equal(policy.resolveAllowedFile("report.txt"), realpathSync(filePath));
});

test("rejects ambiguous relative upload files across allowed roots", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "clero-upload-file-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const firstRoot = path.join(parent, "first");
  const secondRoot = path.join(parent, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  await writeFile(path.join(firstRoot, "report.txt"), "first report");
  await writeFile(path.join(secondRoot, "report.txt"), "second report");
  const policy = new WorkspacePolicy({ allowedDirectories: [firstRoot, secondRoot] });

  assert.throws(
    () => policy.resolveAllowedFile("report.txt"),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.errorCode === "invalid_arguments" &&
      error.message.includes("ambiguous")
  );
});

test("allows absolute files from upload-only roots without granting workspace access", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "clero-upload-only-root-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const workspaceRoot = path.join(parent, "workspace");
  const uploadRoot = path.join(parent, "uploads");
  const outsideRoot = path.join(parent, "outside");
  await mkdir(workspaceRoot);
  await mkdir(uploadRoot);
  await mkdir(outsideRoot);
  const uploadFile = path.join(uploadRoot, "founder-video.mp4");
  const outsideFile = path.join(outsideRoot, "private.txt");
  await writeFile(uploadFile, "video fixture");
  await writeFile(outsideFile, "outside fixture");
  const policy = new WorkspacePolicy({
    allowedDirectories: [workspaceRoot],
    allowedFileDirectories: [uploadRoot]
  });

  assert.equal(policy.resolveAllowedFile(uploadFile), realpathSync(uploadFile));
  assert.deepEqual(policy.listAllowedDirectories(), [realpathSync(workspaceRoot)]);
  assert.deepEqual(
    policy.listAllowedFileDirectories().sort(),
    [realpathSync(workspaceRoot), realpathSync(uploadRoot)].sort()
  );
  assert.throws(
    () => policy.resolveAllowedDirectory(uploadRoot),
    (error: unknown) => error instanceof ToolExecutionError && error.errorCode === "invalid_arguments"
  );
  assert.throws(
    () => policy.resolveAllowedFile(outsideFile),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.errorCode === "invalid_arguments" &&
      error.message.includes("outside allowed upload directories")
  );
});

test("ignores missing configured roots and reports them as unavailable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  const missing = path.join(root, "Projects");
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = new WorkspacePolicy({ allowedDirectories: [missing] });
  const tools = new WorkspaceTools(policy);

  assert.deepEqual(policy.listAllowedDirectories(), []);
  assert.deepEqual(policy.listUnavailableDirectories(), [missing]);
  assert.deepEqual(tools.listRoots(), {
    roots: [],
    unavailable_roots: [missing]
  });
  assert.deepEqual(await tools.listProjects(), {
    roots: [],
    unavailable_roots: [missing],
    max_depth: 3,
    projects: []
  });
  assert.throws(
    () => policy.resolveAllowedDirectory(),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.errorCode === "invalid_arguments" &&
      error.message.includes("No allowed workspace directories are available") &&
      error.message.includes(missing)
  );
});

test("discovers projects under allowed roots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realRoot = realpathSync(root);
  const nodeProject = path.join(root, "node-app");
  const djangoProject = path.join(root, "python-app");
  const realNodeProject = path.join(realRoot, "node-app");
  const realDjangoProject = path.join(realRoot, "python-app");
  await mkdir(nodeProject);
  await mkdir(djangoProject);
  await writeFile(
    path.join(nodeProject, "package.json"),
    JSON.stringify({ name: "node-app", version: "1.0.0", scripts: { test: "node --test" } })
  );
  await writeFile(path.join(nodeProject, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(djangoProject, "manage.py"), "");

  const tools = new WorkspaceTools(new WorkspacePolicy({ allowedDirectories: [root] }));
  const result = await tools.listProjects({ max_depth: 2 });
  const projects = jsonArray(result.projects);

  assert.equal(projects.length, 2);
  assert.deepEqual(projects.map((project) => project.path).sort(), [realDjangoProject, realNodeProject].sort());
  const node = projects.find((project) => project.path === realNodeProject);
  assert.ok(node);
  assert.equal(node.project, "node-app");
  assert.equal(node.name, "node-app");
  assert.deepEqual(node.detected_stacks, ["node"]);
  assert.equal(node.package_manager, "pnpm");
});

test("resolves discovered projects by relative key, folder name, and wrong absolute basename", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nestedProject = path.join(root, "clero", "clero_back");
  await mkdir(nestedProject, { recursive: true });
  await writeFile(path.join(nestedProject, "manage.py"), "");
  const realProject = realpathSync(nestedProject);
  const policy = new WorkspacePolicy({ allowedDirectories: [root] });

  assert.equal(policy.resolveAllowedDirectory("clero/clero_back"), realProject);
  assert.equal(policy.resolveAllowedDirectory("clero_back"), realProject);
  assert.equal(policy.resolveAllowedDirectory("/Users/aiaz/workspace/clero/clero_back"), realProject);
});

test("requires an explicit project when an allowed root contains multiple projects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const apiProject = path.join(root, "api");
  const webProject = path.join(root, "web");
  await mkdir(apiProject);
  await mkdir(webProject);
  await writeFile(path.join(apiProject, "manage.py"), "");
  await writeFile(path.join(webProject, "package.json"), JSON.stringify({ name: "web" }));
  const policy = new WorkspacePolicy({ allowedDirectories: [root] });

  assert.throws(
    () => policy.resolveProjectDirectory(),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.errorCode === "invalid_arguments" &&
      error.message.includes("No project was selected")
  );
});

test("auto-selects the only discovered project under an allowed root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "only-project");
  await mkdir(project);
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "only-project" }));

  const policy = new WorkspacePolicy({ allowedDirectories: [root] });

  assert.equal(policy.resolveProjectDirectory(), realpathSync(project));
});

test("describes an allowed project", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "described-app", private: true, scripts: { typecheck: "tsc" } })
  );
  await writeFile(path.join(root, "tsconfig.json"), "{}");

  const tools = new WorkspaceTools(new WorkspacePolicy({ allowedDirectories: [root] }));
  const result = await tools.describeProject({ project: "described-app" });

  assert.equal(result.name, "described-app");
  assert.deepEqual(result.detected_stacks, ["node", "typescript"]);
  assert.deepEqual(result.markers, ["package.json", "tsconfig.json"]);
  assert.deepEqual(result.package_json, {
    name: "described-app",
    version: null,
    private: true,
    scripts: ["typecheck"]
  });
});

test("rejects project descriptions outside allowed roots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new WorkspaceTools(new WorkspacePolicy({ allowedDirectories: [root] }));

  await assert.rejects(
    () => tools.describeProject({ path: os.tmpdir() }),
    (error: unknown) => error instanceof Error && error.message.includes(root)
  );
});

function jsonArray(value: unknown): Array<Record<string, unknown>> {
  assert.equal(Array.isArray(value), true);
  return value as Array<Record<string, unknown>>;
}
