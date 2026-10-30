# Releasing CashGear Video

A release is a version tag (`v1.2.3`). The release workflow (`.github/workflows/release.yml`):

1. Checks the version.
2. Builds the app.
3. Installs, updates and uninstalls a test build.
4. Builds the signed installer.
5. Drafts the GitHub release once every setting below exists. Publishing the draft is what installed apps see.

## Before the first release (once)

1. **Licence server.**
   - Make its signing key on a machine you trust, and back up the private key offline: `node services/licensing/src/main.ts keygen --out <folder>`.
   - Deploy `services/licensing` over HTTPS (its README covers how), for example at `https://licensing.cashgearerp.com`. Its address must match `*.cashgearerp.com`, which the desktop's content security policy allows; another domain means changing `connect-src` in `tauri.conf.json`.
   - Set the repository variables `CGV_LICENCE_SERVER` (its address) and `CGV_LICENCE_KEYS` (the public key that `keygen` printed; comma-separated, for when keys rotate).
   - The web deploy reads them too: until they exist, the public web app is the free edition.
2. **Updater key.**
   - Make it with `pnpm --filter @cgv/desktop tauri signer generate -w <folder>/cashgear-video-updater.key`, choosing a password.
   - Set the secrets `TAURI_SIGNING_PRIVATE_KEY` (the key file's contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the variable `CGV_UPDATER_PUBKEY` (the `.pub` file's contents).
   - Keep the private key safe. Losing it means installed apps can never update again: they would have to be reinstalled by hand.
3. **Code signing (Azure Artifact Signing, formerly Trusted Signing).**
   - Create the signing account and a certificate profile. Microsoft validates the publisher's identity.
   - Create an app registration with the "Artifact Signing Certificate Profile Signer" role on the profile.
   - Set the variables `CGV_SIGN_ENDPOINT` (for example `https://eus.codesigning.azure.net`), `CGV_SIGN_ACCOUNT` and `CGV_SIGN_PROFILE`.
   - Set the secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and `AZURE_TENANT_ID`.
   - Until these exist, releases are signed with a throwaway certificate, and Windows warns about an unknown publisher.
4. **Web domain.** Add `video.cashgearerp.com` to the Azure Static Web App (Custom domains), and the CNAME record its page asks for at your DNS host.
5. **The store.** Sell keys with `node services/licensing/src/main.ts issue …` (or a store that calls it), and decide where the app's "Licence" dialog should send people to buy.
6. **Legal.**
   - Get advice on codec patents (H.264, HEVC, AAC) for the markets you sell in.
   - Get advice on the LGPL notice and the FFmpeg source the release carries.
   - The repository is public: decide whether it stays so.

## Each release

1. Write the release's section in `CHANGELOG.md`.
2. Set the version everywhere: the `package.json` files, `[workspace.package]` in `Cargo.toml`, and `tauri.conf.json`. Then run `cargo update --workspace` and `pnpm release:check`.
3. Run the checks in `CLAUDE.md` on the reference machine, plus:
   - `pnpm desktop:installer-test`
   - `CGV_STRESS_MINUTES=60 npx playwright test stress --project=chrome`
   - `CGV_PLAYBACK_HOURS=8 npx playwright test long-playback --project=chrome` (overnight)
4. Push, wait for CI, then tag: `git tag -a v1.2.3 -m "CashGear Video 1.2.3" && git push origin v1.2.3`.
5. When the workflow has drafted the release:
   - Install it on a clean Windows machine. Check that SmartScreen names the publisher, and that the app updates from the previous version.
   - Then publish the draft as the latest release.
6. Data releases (test media, models) must never be marked latest (`gh release create … --latest=false`): installed apps read updates from the latest release's `latest.json`.
