# Official Builds And Releases

Official Clero Local Agent builds are distributed by Clero and published through the release workflow.

## Official Download Location

Current public macOS download:

```text
https://media.clero.so/local-agent/latest/clero-local-agent-macos-aarch64.dmg
```

Updater metadata:

```text
https://media.clero.so/local-agent/latest/latest.json
```

## Signing

The release workflow requires Tauri updater signing for safe in-app updates:

- Tauri updater signing: required.
- Apple Developer ID signing and notarization: optional for now.

The Tauri updater key alone does not make macOS trust the app. Without Apple Developer ID signing and notarization, users may see a Gatekeeper warning when opening the app.

## Required GitHub Secrets

```text
TAURI_SIGNING_PRIVATE_KEY
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CLOUDFLARE_R2_BUCKET
```

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional. Leave it unset when the updater private key has no password.

## Release Flow

1. Update the desktop version in `apps/desktop/package.json` and `apps/desktop/src-tauri/tauri.conf.json`.
2. Commit the version change.
3. Push `main`.
4. Create and push a tag such as `desktop-v0.1.6`.
5. Let `.github/workflows/desktop-release.yml` build the app, create the draft GitHub Release, prepare website assets, and upload them to R2.
6. Review and publish the GitHub draft release.
7. Verify the public DMG and updater metadata from `media.clero.so`.

The release workflow keeps the macOS build and R2 upload in separate jobs. If Cloudflare R2 has a transient upload failure, rerun the failed jobs in GitHub Actions; the R2 upload can reuse the prepared release artifact without rebuilding the desktop app.

## Verification

On macOS:

```bash
hdiutil verify /path/to/clero-local-agent-macos-aarch64.dmg
spctl --assess --type open --context context:primary-signature -v /path/to/Clero\ Local\ Agent.app
codesign --verify --deep --strict --verbose=2 /path/to/Clero\ Local\ Agent.app
```

If the app is not Apple Developer ID notarized, macOS may show the malware verification warning on first open.

## Forks And Local Builds

Forks and local builds are not official Clero releases. They may be useful for development, but they should not be presented to users as trusted Clero builds unless the distributor controls the signing and release channel.
