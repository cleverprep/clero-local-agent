import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const browserRequire = createRequire(join(root, "packages/browser/package.json"));
const tauriDir = join(root, "apps/desktop/src-tauri");
const runtimeDir = join(tauriDir, "resources/clero-local-agent-runtime");
const daemonDir = join(runtimeDir, "daemon");
const binariesDir = join(tauriDir, "binaries");
const targetTriple = process.env.CLERO_LOCAL_AGENT_TARGET_TRIPLE ?? rustHostTriple();
const sidecarPath = join(binariesDir, `clero-local-agent-daemon-${targetTriple}`);

if (!targetTriple.includes("apple-darwin")) {
  throw new Error(`Desktop production packaging currently supports macOS targets only. Got ${targetTriple}.`);
}

await rm(runtimeDir, { recursive: true, force: true });
await mkdir(join(daemonDir, "node_modules"), { recursive: true });
await mkdir(join(runtimeDir, "node/bin"), { recursive: true });
await mkdir(binariesDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "apps/cli/src/main.ts")],
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

console.log(JSON.stringify({
  runtime_dir: runtimeDir,
  sidecar: sidecarPath,
  target_triple: targetTriple
}, null, 2));

async function copyPackage(name, resolver = browserRequire) {
  const source = resolvePackageDir(name, resolver);
  const target = join(daemonDir, "node_modules", name);
  await cp(source, target, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => !sourcePath.includes("/.local-browsers/")
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
  await cp(process.execPath, join(runtimeDir, "node/bin/node"));
  await chmod(join(runtimeDir, "node/bin/node"), 0o755);
}

async function writeLauncher() {
  const script = `#!/bin/sh
set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RESOURCE_DIR="\${CLERO_LOCAL_AGENT_RUNTIME_DIR:-$SELF_DIR/../Resources/clero-local-agent-runtime}"

if [ ! -d "$RESOURCE_DIR" ]; then
  RESOURCE_DIR="$SELF_DIR/../../Resources/clero-local-agent-runtime"
fi

if [ ! -d "$RESOURCE_DIR" ]; then
  RESOURCE_DIR="$SELF_DIR/../resources/clero-local-agent-runtime"
fi

NODE_BIN="$RESOURCE_DIR/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="node"
fi

exec "$NODE_BIN" "$RESOURCE_DIR/daemon/index.mjs" "$@"
`;
  await writeFile(sidecarPath, script);
  await chmod(sidecarPath, 0o755);
}

function rustHostTriple() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = output.match(/^host:\s*(.+)$/m);
  if (!match) {
    throw new Error("Could not determine Rust host target triple.");
  }
  return match[1].trim();
}
