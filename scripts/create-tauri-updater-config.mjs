import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const publicKeyPath = resolve(repoRoot, "apps/desktop/src-tauri/updater.public.key");
const outputPath = resolve(repoRoot, "apps/desktop/src-tauri/tauri.updater.generated.json");

const endpoint =
  process.env.CLERO_UPDATER_ENDPOINT ||
  "https://clero.so/downloads/local-agent/latest/latest.json";
const publicKey = (await readFile(publicKeyPath, "utf8")).trim();

if (!publicKey) {
  throw new Error(`Updater public key is empty: ${publicKeyPath}`);
}

const config = {
  bundle: {
    createUpdaterArtifacts: true
  },
  plugins: {
    updater: {
      pubkey: publicKey,
      endpoints: [endpoint],
      windows: {
        installMode: "passive"
      }
    }
  }
};

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);
console.log(`Updater endpoint: ${endpoint}`);
