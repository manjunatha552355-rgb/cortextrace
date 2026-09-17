# Releasing

## Versioning

Semantic versioning. Record changes in `CHANGELOG.md`, update `version` in `package.json`, then tag:

```bash
npm version 0.2.0 --no-git-tag-version
git commit -am "Release 0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
```

The **Release** workflow tests, builds installers on Windows, macOS and Linux runners, writes `SHA256SUMS-*.txt`, and creates a **draft** GitHub release. A maintainer reviews it, smoke-tests at least one installer per OS (run `E2E_APP=<installed binary> node scripts/e2e.mjs`), then publishes.

## Local builds

```bash
npm ci
npx electron scripts/icons.cjs
npm run licenses
npm run dist:win     # release/*.exe (NSIS, x64+arm64), *.msi (x64)
npm run dist:mac     # release/*.dmg (arm64, x64), *.pkg (universal)   — must run on macOS
npm run dist:linux   # release/*.AppImage, *.deb, *.rpm                — rpm needs rpmbuild
```

The build is reproducible from the lockfile. `scripts/build.mjs` bundles everything into `dist/`, so no `node_modules` ship inside the app.

## Code signing

| Platform | How | Secrets (CI) |
|---|---|---|
| Windows | Authenticode via electron-builder (`CSC_LINK` PFX), or Azure Trusted Signing (`win.azureSignOptions` in `electron-builder.yml`) | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |
| macOS | Developer ID Application + Installer certificates; hardened runtime with `build/entitlements.mac.plist`; notarization via notarytool | `CSC_LINK`/`CSC_KEY_PASSWORD` (p12), `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Linux | publish SHA256SUMS; optionally sign them with GPG and sign the `.deb`/`.rpm` repositories | maintainer GPG key |

Without secrets the workflow still produces **unsigned** installers. Label those clearly in release notes.

## Auto-update strategy

Automatic updating is **not enabled** in 0.1.x, on purpose: an updater is a remote code-delivery channel and needs signing in place first. The plan:

1. Ship signed builds for two releases.
2. Add `electron-updater` with the GitHub provider. Update checks are opt-in (Settings → General), verify signatures (Windows: publisher name pinning; macOS: code-signature validation built into Squirrel.Mac), and never auto-install without the user's consent.
3. Linux: AppImage uses the same updater; `.deb`/`.rpm` users update through their package manager or a signed apt/yum repository.

Until then, the About page shows the version, and releases are announced on GitHub.

## Release checklist

- [ ] `npm run typecheck && npm test` green on all three OSes (CI)
- [ ] `npm run e2e` green on all three OSes (CI artifacts contain screenshots; look at them)
- [ ] `npm run bench`: no regression beyond 20% against the previous release notes
- [ ] `npm run licenses` passes and `THIRD_PARTY_NOTICES.md` is committed
- [ ] `npm audit` has no high/critical issues
- [ ] CHANGELOG updated; docs mention any new data source (PRIVACY.md) or trust boundary (THREAT_MODEL.md)
- [ ] installers signed/notarized where secrets are available; SHA256SUMS attached
- [ ] install → run → uninstall smoke test on each OS
