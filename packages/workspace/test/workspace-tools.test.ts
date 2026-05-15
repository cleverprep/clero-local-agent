import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspacePolicy, WorkspaceTools } from "../src/index.ts";

test("lists allowed workspace roots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new WorkspaceTools(new WorkspacePolicy({ allowedDirectories: [root] }));

  const result = tools.listRoots();

  assert.deepEqual(result.roots, [{ path: root, name: path.basename(root) }]);
});

test("discovers projects under allowed roots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeProject = path.join(root, "node-app");
  const djangoProject = path.join(root, "python-app");
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
  assert.deepEqual(projects.map((project) => project.path).sort(), [djangoProject, nodeProject].sort());
  const node = projects.find((project) => project.path === nodeProject);
  assert.ok(node);
  assert.equal(node.name, "node-app");
  assert.deepEqual(node.detected_stacks, ["node"]);
  assert.equal(node.package_manager, "pnpm");
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
  const result = await tools.describeProject({ path: root });

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

  await assert.rejects(() => tools.describeProject({ path: os.tmpdir() }), /outside allowed workspaces/);
});

function jsonArray(value: unknown): Array<Record<string, unknown>> {
  assert.equal(Array.isArray(value), true);
  return value as Array<Record<string, unknown>>;
}
