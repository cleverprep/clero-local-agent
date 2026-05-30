import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const repoRoot = resolve(import.meta.dirname, "..");
const browserRequire = createRequire(join(repoRoot, "packages/browser/package.json"));
const outputDir = resolve(process.env.CLERO_CONNECTOR_OUTPUT_DIR ?? join(repoRoot, "dist/connector-release"));
const stagingRoot = join(repoRoot, "dist/connector-package");
const packageRoot = join(stagingRoot, "clero-connector");
const binDir = join(packageRoot, "bin");
const runtimeDir = join(packageRoot, "runtime");
const daemonDir = join(runtimeDir, "daemon");
const platform = normalizedPlatform();
const arch = normalizedArch();
const archiveName = `clero-connector-${platform}-${arch}${platform === "win" ? ".zip" : ".tar.gz"}`;
const archivePath = join(outputDir, archiveName);

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(join(daemonDir, "node_modules"), { recursive: true });
await mkdir(binDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(repoRoot, "apps/cli/src/main.ts")],
  outfile: join(daemonDir, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["playwright"]
});

const playwrightDir = await copyPackage("playwright");
await copyPackage("playwright-core", createRequire(join(playwrightDir, "package.json")));
await copyNodeBinary();
await writeLauncher();
await copyProjectFiles();
await createArchive();

console.log(
  JSON.stringify(
    {
      platform,
      arch,
      package_root: packageRoot,
      archive: archivePath
    },
    null,
    2
  )
);

function normalizedPlatform() {
  if (process.platform === "darwin") {
    return "darwin";
  }
  if (process.platform === "linux") {
    return "linux";
  }
  if (process.platform === "win32") {
    return "win";
  }
  throw new Error(`Unsupported connector platform: ${process.platform}`);
}

function normalizedArch() {
  if (process.arch === "arm64") {
    return "arm64";
  }
  if (process.arch === "x64") {
    return "x64";
  }
  throw new Error(`Unsupported connector architecture: ${process.arch}`);
}

async function copyPackage(name, resolver = browserRequire) {
  const source = resolvePackageDir(name, resolver);
  const target = join(daemonDir, "node_modules", name);
  await cp(source, target, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => !sourcePath.includes("/.local-browsers/") && !sourcePath.includes("\\.local-browsers\\")
  });
  return source;
}

function resolvePackageDir(name, resolver) {
  const packageJson = resolver.resolve(`${name}/package.json`);
  const packageDir = dirname(packageJson);
  if (!existsSync(packageDir)) {
    throw new Error(`Could not resolve package ${name}`);
  }
  return packageDir;
}

async function copyNodeBinary() {
  if (process.platform === "win32") {
    const target = join(runtimeDir, "node", "node.exe");
    await mkdir(dirname(target), { recursive: true });
    await cp(process.execPath, target);
    return;
  }

  const target = join(runtimeDir, "node", "bin", "node");
  await mkdir(dirname(target), { recursive: true });
  await cp(process.execPath, target);
  await chmod(target, 0o755);
}

async function writeLauncher() {
  if (process.platform === "win32") {
    const script = `@echo off\r
setlocal\r
set "SELF_DIR=%~dp0"\r
set "ROOT_DIR=%SELF_DIR%.."\r
set "NODE_BIN=%ROOT_DIR%\\runtime\\node\\node.exe"\r
"%NODE_BIN%" "%ROOT_DIR%\\runtime\\daemon\\index.mjs" %*\r
`;
    await writeFile(join(binDir, "clero-connector.cmd"), script);
    return;
  }

  const script = `#!/bin/sh
set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SELF_DIR/.." && pwd)
NODE_BIN="$ROOT_DIR/runtime/node/bin/node"

exec "$NODE_BIN" "$ROOT_DIR/runtime/daemon/index.mjs" "$@"
`;
  const launcherPath = join(binDir, "clero-connector");
  await writeFile(launcherPath, script);
  await chmod(launcherPath, 0o755);
}

async function copyProjectFiles() {
  if (existsSync(join(repoRoot, "LICENSE"))) {
    await cp(join(repoRoot, "LICENSE"), join(packageRoot, "LICENSE"));
  }
  await writeFile(
    join(packageRoot, "README.md"),
    `# Clero Connector

This archive contains the standalone Clero connector CLI.

Run:

\`\`\`bash
bin/clero-connector help
\`\`\`

The connector stores config in \`~/.clero-local-agent/config.json\`.
`
  );
}

async function createArchive() {
  await rm(archivePath, { force: true });

  if (process.platform === "win32") {
    const escapedPackageRoot = packageRoot.replace(/'/g, "''");
    const escapedArchivePath = archivePath.replace(/'/g, "''");
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${escapedPackageRoot}' -DestinationPath '${escapedArchivePath}' -Force`
      ],
      { stdio: "inherit" }
    );
    return;
  }

  execFileSync("tar", ["-czf", archivePath, "-C", stagingRoot, "clero-connector"], { stdio: "inherit" });
}
