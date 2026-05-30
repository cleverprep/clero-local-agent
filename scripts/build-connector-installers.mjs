import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const releaseDir = resolve(process.env.CLERO_CONNECTOR_RELEASE_DIR ?? join(repoRoot, "dist/connector-release"));
const downloadBaseUrl = process.env.CLERO_DOWNLOAD_BASE_URL || "https://media.clero.so/local-agent";
const latestBaseUrl = `${downloadBaseUrl}/latest`;
const archiveNames = (await readdir(releaseDir))
  .filter((name) => /^clero-connector-(darwin|linux|win)-(arm64|x64)\.(tar\.gz|zip)$/.test(name))
  .sort();

if (archiveNames.length === 0) {
  throw new Error(`No connector archives found in ${releaseDir}`);
}

const checksums = await Promise.all(
  archiveNames.map(async (name) => `${await sha256(join(releaseDir, name))}  ${name}`)
);

await writeFile(join(releaseDir, "checksums.txt"), `${checksums.join("\n")}\n`);
await writeFile(join(releaseDir, "install.sh"), posixInstaller(latestBaseUrl));
await chmod(join(releaseDir, "install.sh"), 0o755);
await writeFile(join(releaseDir, "install.ps1"), windowsInstaller(latestBaseUrl));
await updateInstallJson();

console.log(
  JSON.stringify(
    {
      release_dir: releaseDir,
      archives: archiveNames,
      generated: ["checksums.txt", "install.sh", "install.ps1"]
    },
    null,
    2
  )
);

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function updateInstallJson() {
  const installJsonPath = join(releaseDir, "install.json");
  if (!existsSync(installJsonPath)) {
    return;
  }

  const installJson = JSON.parse(await readFile(installJsonPath, "utf8"));
  installJson.cli = {
    install_sh_url: `${latestBaseUrl}/install.sh`,
    install_ps1_url: `${latestBaseUrl}/install.ps1`,
    checksums_url: `${latestBaseUrl}/checksums.txt`,
    downloads: Object.fromEntries(
      archiveNames.map((name) => [
        name
          .replace(/^clero-connector-/, "")
          .replace(/\.tar\.gz$/, "")
          .replace(/\.zip$/, "")
          .replace(/-/g, "_"),
        {
          url: `${latestBaseUrl}/${name}`,
          versioned_url: `${downloadBaseUrl}/releases/${installJson.version}/${name}`
        }
      ])
    )
  };

  await writeFile(installJsonPath, `${JSON.stringify(installJson, null, 2)}\n`);
}

function posixInstaller(defaultBaseUrl) {
  return `#!/bin/sh
set -eu

DEFAULT_BASE_URL="${defaultBaseUrl}"
BASE_URL="\${CLERO_CONNECTOR_BASE_URL:-$DEFAULT_BASE_URL}"
INSTALL_ROOT="\${CLERO_CONNECTOR_HOME:-$HOME/.local/share/clero-connector}"
BIN_DIR="\${CLERO_CONNECTOR_BIN_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

archive="clero-connector-$os-$arch.tar.gz"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "Downloading $archive..."
curl -fsSL "$BASE_URL/checksums.txt" -o "$tmp_dir/checksums.txt"
curl -fL "$BASE_URL/$archive" -o "$tmp_dir/$archive"

expected="$(grep "  $archive$" "$tmp_dir/checksums.txt" | awk '{print $1}')"
if [ -z "$expected" ]; then
  echo "No checksum found for $archive" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp_dir/$archive" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp_dir/$archive" | awk '{print $1}')"
fi

if [ "$expected" != "$actual" ]; then
  echo "Checksum verification failed for $archive" >&2
  exit 1
fi

mkdir -p "$tmp_dir/extract" "$INSTALL_ROOT" "$BIN_DIR"
tar -xzf "$tmp_dir/$archive" -C "$tmp_dir/extract"

rm -rf "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current.prev"
mv "$tmp_dir/extract/clero-connector" "$INSTALL_ROOT/current.new"
if [ -d "$INSTALL_ROOT/current" ]; then
  mv "$INSTALL_ROOT/current" "$INSTALL_ROOT/current.prev"
fi
mv "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"
cat > "$BIN_DIR/clero-connector" <<EOF
#!/bin/sh
exec "$INSTALL_ROOT/current/bin/clero-connector" "\\$@"
EOF
chmod +x "$BIN_DIR/clero-connector"

"$BIN_DIR/clero-connector" help >/dev/null

echo "Installed clero-connector to $BIN_DIR/clero-connector"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "Add this to your shell profile if clero-connector is not found:"
    echo "  export PATH=\\"$BIN_DIR:\\$PATH\\""
    ;;
esac
`;
}

function windowsInstaller(defaultBaseUrl) {
  return `$ErrorActionPreference = "Stop"

$DefaultBaseUrl = "${defaultBaseUrl}"
$BaseUrl = if ($env:CLERO_CONNECTOR_BASE_URL) { $env:CLERO_CONNECTOR_BASE_URL } else { $DefaultBaseUrl }
$InstallRoot = if ($env:CLERO_CONNECTOR_HOME) { $env:CLERO_CONNECTOR_HOME } else { Join-Path $env:LOCALAPPDATA "CleroConnector" }
$BinDir = if ($env:CLERO_CONNECTOR_BIN_DIR) { $env:CLERO_CONNECTOR_BIN_DIR } else { Join-Path $env:USERPROFILE ".local\\bin" }

$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x64" }
  "ARM64" {
    Write-Host "Windows ARM64 detected; installing x64 connector for compatibility."
    "x64"
  }
  default { throw "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

$Archive = "clero-connector-win-$Arch.zip"
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("clero-connector-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

try {
  $ChecksumsPath = Join-Path $TmpDir "checksums.txt"
  $ArchivePath = Join-Path $TmpDir $Archive
  Invoke-WebRequest -Uri "$BaseUrl/checksums.txt" -OutFile $ChecksumsPath
  Invoke-WebRequest -Uri "$BaseUrl/$Archive" -OutFile $ArchivePath

  $Line = Get-Content $ChecksumsPath | Where-Object { $_ -match "\\s$([regex]::Escape($Archive))$" } | Select-Object -First 1
  if (-not $Line) {
    throw "No checksum found for $Archive"
  }
  $Expected = ($Line -split "\\s+")[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) {
    throw "Checksum verification failed for $Archive"
  }

  $ExtractDir = Join-Path $TmpDir "extract"
  Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force
  New-Item -ItemType Directory -Force -Path $InstallRoot, $BinDir | Out-Null

  $NewDir = Join-Path $InstallRoot "current.new"
  $CurrentDir = Join-Path $InstallRoot "current"
  $PrevDir = Join-Path $InstallRoot "current.prev"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $NewDir, $PrevDir
  Move-Item (Join-Path $ExtractDir "clero-connector") $NewDir
  if (Test-Path $CurrentDir) {
    Move-Item $CurrentDir $PrevDir
  }
  Move-Item $NewDir $CurrentDir

  $ShimPath = Join-Path $BinDir "clero-connector.cmd"
  $TargetCmd = Join-Path $CurrentDir "bin\\clero-connector.cmd"
  Set-Content -Path $ShimPath -Value "@echo off\`r\`ncall \`"$TargetCmd\`" %*\`r\`n"
  & $ShimPath help | Out-Null

  Write-Host "Installed clero-connector to $ShimPath"
  if (($env:PATH -split ";") -notcontains $BinDir) {
    Write-Host "Add this directory to PATH if clero-connector is not found: $BinDir"
  }
}
finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $TmpDir
}
`;
}
