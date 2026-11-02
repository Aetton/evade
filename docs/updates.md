# EvaDE updates

## Security model

Desktop releases **must** be signed with the Tauri updater private key. The public key ships in the app, the private signing key never ships to clients. Never switch off updater signature validation.

## Desktop release setup (not active by default)

The updater plugin is installed in the source tree and the settings screen can query it. The released app needs an updater config and verified downloadable release packages before it can install updates.

1. Generate an Ed25519 updater keypair with `npm run tauri signer generate -- -w ~/.tauri/evade.key` from `desktop/`. Back up the private key off the repo.
2. Supply the **public** key and an HTTPS manifest endpoint using Tauri config overlay (see `desktop/updater.config.example.json`).
3. Build signed platform bundles with `TAURI_SIGNING_PRIVATE_KEY` and optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in a protected CI secret store. Set `bundle.createUpdaterArtifacts` to true in release configuration.
4. Publish the updater JSON manifest with platform-specific URLs **and signature contents** only after all artifacts upload successfully.
5. Test a previous signed version upgrading to the new signed release on Windows and Linux.

Do not advertise auto-updating before completing the above. The UI currently checks for available versions; downloading and installing will be enabled only after verified release automation exists.

## Backend

Backend should be deployed as an immutable container image tagged by commit SHA, preferably from an internal registry. Use a controlled rollout: pull exact version, back up DB, run migrations, replace container, probe `/health`, and roll back to previous image if probe fails. **Do not mount the source and run git pull on a live service.**

The Compose deployment's `api` has a Dockerfile build for local development only. CI and production image publication, Alembic migrations, and an opt-in systemd deployment timer are not yet configured. They must be added before claiming unattended backend updates.

Compatibility: require the backend to support the previous client version through one release cycle. Future desktop client should block new features until backend capabilities are supported.
