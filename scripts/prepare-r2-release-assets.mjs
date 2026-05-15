import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const tauriConfigPath = join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json");
const bundleDir = join(repoRoot, "apps/desktop/src-tauri/target/release/bundle");
const outputDir = join(repoRoot, "dist/local-agent-release");
const downloadBaseUrl =
  process.env.CLERO_DOWNLOAD_BASE_URL ||
  "https://media.clero.so/local-agent";

const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
const version = String(process.env.CLERO_RELEASE_VERSION || tauriConfig.version || "").trim();

if (!version) {
  throw new Error(`Unable to resolve desktop app version from ${tauriConfigPath}`);
}

const sourceDmg = join(bundleDir, "dmg", `Clero Local Agent_${version}_aarch64.dmg`);
const sourceUpdater = join(bundleDir, "macos", "Clero Local Agent.app.tar.gz");
const sourceSignature = `${sourceUpdater}.sig`;

const releaseDmgName = `clero-local-agent-${version}-macos-aarch64.dmg`;
const releaseUpdaterName = `clero-local-agent-${version}-darwin-aarch64.app.tar.gz`;
const releaseSignatureName = `${releaseUpdaterName}.sig`;

const releaseDmgPath = join(outputDir, releaseDmgName);
const releaseUpdaterPath = join(outputDir, releaseUpdaterName);
const releaseSignaturePath = join(outputDir, releaseSignatureName);
const latestJsonPath = join(outputDir, "latest.json");
const installJsonPath = join(outputDir, "install.json");
const releaseEnvPath = join(outputDir, "release.env");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await copyFile(sourceDmg, releaseDmgPath);
await copyFile(sourceUpdater, releaseUpdaterPath);
await copyFile(sourceSignature, releaseSignaturePath);

const signature = (await readFile(sourceSignature, "utf8")).trim();
const publishedAt = new Date().toISOString();
const updaterUrl = `${downloadBaseUrl}/releases/${version}/${releaseUpdaterName}`;
const dmgUrl = `${downloadBaseUrl}/releases/${version}/${releaseDmgName}`;
const latestDmgUrl = `${downloadBaseUrl}/latest/clero-local-agent-macos-aarch64.dmg`;
const latestUpdaterUrl = `${downloadBaseUrl}/latest/clero-local-agent-darwin-aarch64.app.tar.gz`;
const latestJsonUrl = `${downloadBaseUrl}/latest/latest.json`;

const latestJson = {
  version,
  notes: `Clero Local Agent ${version}`,
  pub_date: publishedAt,
  platforms: {
    "darwin-aarch64": {
      signature,
      url: updaterUrl
    }
  }
};

const installJson = {
  version,
  pub_date: publishedAt,
  downloads: {
    macos_aarch64: {
      url: latestDmgUrl,
      versioned_url: dmgUrl
    }
  },
  updater: {
    latest_json_url: latestJsonUrl,
    latest_bundle_url: latestUpdaterUrl,
    versioned_bundle_url: updaterUrl
  }
};

const releaseEnv = [
  `LOCAL_AGENT_VERSION=${version}`,
  "LOCAL_AGENT_RELEASE_DIR=dist/local-agent-release",
  `LOCAL_AGENT_DMG=${releaseDmgName}`,
  `LOCAL_AGENT_UPDATER=${releaseUpdaterName}`,
  `LOCAL_AGENT_SIGNATURE=${releaseSignatureName}`,
  "LOCAL_AGENT_LATEST_JSON=latest.json",
  "LOCAL_AGENT_INSTALL_JSON=install.json",
  `LOCAL_AGENT_DMG_NAME=${basename(releaseDmgPath)}`,
  `LOCAL_AGENT_UPDATER_NAME=${basename(releaseUpdaterPath)}`,
  `LOCAL_AGENT_SIGNATURE_NAME=${basename(releaseSignaturePath)}`
].join("\n");

await writeFile(latestJsonPath, `${JSON.stringify(latestJson, null, 2)}\n`);
await writeFile(installJsonPath, `${JSON.stringify(installJson, null, 2)}\n`);
await writeFile(releaseEnvPath, `${releaseEnv}\n`);

console.log(
  JSON.stringify(
    {
      version,
      output_dir: outputDir,
      dmg: releaseDmgPath,
      updater: releaseUpdaterPath,
      signature: releaseSignaturePath,
      latest_json: latestJsonPath,
      install_json: installJsonPath,
      latest_json_url: latestJsonUrl,
      latest_dmg_url: latestDmgUrl
    },
    null,
    2
  )
);
