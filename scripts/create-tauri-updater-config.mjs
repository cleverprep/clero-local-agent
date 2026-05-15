import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const publicKeyPath = resolve(repoRoot, "apps/desktop/src-tauri/updater.public.key");
const outputPath = resolve(repoRoot, "apps/desktop/src-tauri/tauri.updater.generated.json");

const endpoint =
  process.env.CLERO_UPDATER_ENDPOINT ||
  "https://media.clero.so/local-agent/latest/latest.json";
const publicKey = (await readFile(publicKeyPath, "utf8")).trim();
const endpointUrl = new URL(endpoint);

if (!publicKey) {
  throw new Error(`Updater public key is empty: ${publicKeyPath}`);
}

if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(endpointUrl.hostname)) {
  throw new Error(`Updater endpoint must not be local: ${endpoint}`);
}

if (
  endpointUrl.hostname === "clero.so" &&
  (endpointUrl.pathname.startsWith("/downloads/local-agent") || endpointUrl.pathname.startsWith("/local-agent"))
) {
  throw new Error(
    `Updater endpoint ${endpoint} is not served by the website. Use https://media.clero.so/local-agent/latest/latest.json.`
  );
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
