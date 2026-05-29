import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

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

const hdiutilArgs = [
  "create",
  "-volname",
  "Clero Local Agent",
  "-srcfolder",
  stagingDir,
  "-ov",
  "-format",
  "UDZO",
  dmgPath
];

for (let attempt = 1; attempt <= 5; attempt += 1) {
  try {
    await rm(dmgPath, { force: true });
    execFileSync("hdiutil", hdiutilArgs, { stdio: "inherit" });
    break;
  } catch (error) {
    if (attempt === 5) {
      throw error;
    }

    const waitMs = attempt * 5_000;
    console.warn(`hdiutil create failed; retrying in ${waitMs / 1_000}s (${attempt + 1}/5).`);
    await delay(waitMs);
  }
}

await rm(stagingDir, { recursive: true, force: true });

console.log(JSON.stringify({ dmg: dmgPath }, null, 2));
