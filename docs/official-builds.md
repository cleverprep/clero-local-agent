# Official Builds And Releases

Official Clero Local Agent builds are distributed by Clero and should be signed, notarized, and published through the release workflow.

## Official Download Location

Current public macOS download:

```text
https://media.clero.so/local-agent/latest/clero-local-agent-macos-aarch64.dmg
```

Updater metadata:

```text
https://media.clero.so/local-agent/latest/latest.json
```

## Required Signing

macOS public releases require two separate signatures:

- Apple Developer ID signing and notarization for Gatekeeper.
- Tauri updater signing for safe in-app updates.

The Tauri updater key alone does not make macOS trust the app. Without Apple Developer ID signing and notarization, users will see a Gatekeeper warning.

## Required GitHub Secrets

```text
TAURI_SIGNING_PRIVATE_KEY
APPLE_CERTIFICATE
APPLE_CERTIFICATE_PASSWORD
APPLE_SIGNING_IDENTITY
APPLE_ID
APPLE_PASSWORD
APPLE_TEAM_ID
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CLOUDFLARE_R2_BUCKET
```

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional. Leave it unset when the updater private key has no password.

## Release Flow

1. Update the desktop version in `apps/desktop/package.json` and `apps/desktop/src-tauri/tauri.conf.json`.
2. Commit the version change.
3. Push `main`.
4. Create and push a tag such as `desktop-v0.1.1`.
5. Let `.github/workflows/desktop-release.yml` build, sign, notarize, create the draft GitHub Release, and upload website assets to R2.
6. Review and publish the GitHub draft release.
7. Verify the public DMG and updater metadata from `media.clero.so`.

## Verification

On macOS:

```bash
hdiutil verify /path/to/clero-local-agent-macos-aarch64.dmg
spctl --assess --type open --context context:primary-signature -v /path/to/Clero\ Local\ Agent.app
codesign --verify --deep --strict --verbose=2 /path/to/Clero\ Local\ Agent.app
```

The app should open without the malware verification warning when installed from the official notarized DMG.

## Forks And Local Builds

Forks and local builds are not official Clero releases. They may be useful for development, but they should not be presented to users as trusted Clero builds unless they are signed and notarized by an appropriate developer identity.
