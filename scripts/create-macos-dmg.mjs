import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const tauriConfig = JSON.parse(
  await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")
);
const version = tauriConfig.version || "0.0.0";
const bundleDir = join(root, "apps/desktop/src-tauri/target/release/bundle");
const appPath = join(bundleDir, "macos/Clero Local Agent.app");
const dmgDir = join(bundleDir, "dmg");
const stagingDir = join(dmgDir, "Clero Local Agent.dmgroot");
const dmgPath = join(dmgDir, `Clero Local Agent_${version}_aarch64.dmg`);

await rm(stagingDir, { recursive: true, force: true });
await rm(dmgPath, { force: true });
await mkdir(stagingDir, { recursive: true });

execFileSync("ditto", [appPath, join(stagingDir, "Clero Local Agent.app")]);
await symlink("/Applications", join(stagingDir, "Applications"));

execFileSync("hdiutil", [
  "create",
  "-volname",
  "Clero Local Agent",
  "-srcfolder",
  stagingDir,
  "-ov",
  "-format",
  "UDZO",
  dmgPath
], { stdio: "inherit" });

await rm(stagingDir, { recursive: true, force: true });

console.log(JSON.stringify({ dmg: dmgPath }, null, 2));
