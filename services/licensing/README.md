# CashGear licence server

A small licence server for the CashGear apps. CashGear Video uses it, and it speaks CashGear Backup's protocol, so one server can serve both. It is plain Node 24 TypeScript with no dependencies: Node runs `src/*.ts` directly.

## How licensing works

- **The seller issues a licence key** for a product and edition, saying how many machines it may be active on. The store keeps only each key's SHA-256.
- **The app activates the key** on a machine. A machine is a PC (a salted hash of Windows' machine id) or, on the web, a browser profile (a random id).
  - The server answers with a token: a signed envelope saying this licence, this machine, this edition, issued now.
  - The app checks tokens offline, with the public keys built into it.
- **The app refreshes the token** every day it is online.
  - A licence keeps working for 14 days after the last good refresh. After that the app falls back to its free edition until a refresh succeeds.
  - A revoked licence (a refund) or an ended subscription cannot be refreshed.
- **Deactivating** frees a machine's place for another.

## Protocol

Every answer allows any origin, because apps call the server from a browser or a webview.

| Request             | Body                               | Answer                |
| ------------------- | ---------------------------------- | --------------------- |
| `POST …/activate`   | `{key, machine, product, version}` | `200 {token}`         |
| `POST …/refresh`    | `{licenceId, machine}`             | `200 {token}`         |
| `POST …/deactivate` | `{licenceId, machine}`             | `200 {ok: true}`      |
| `GET …/health`      |                                    | `200 {ok, publicKey}` |

- **Refusals:** a request is refused with `400` or `403` and `{error, code, revoked}`. `error` is a sentence to show the user. `code` is one of:
  - `bad-request`
  - `invalid-key`
  - `wrong-product`
  - `machine-limit`
  - `revoked`
  - `expired`
  - `not-activated`
- **The token:** `{"payload", "signature"}` in base64. The signature is ECDSA P-256 with SHA-256 over the payload's bytes, in IEEE P1363 form. The payload is `{licenceId, product, edition, machine, issuedAt, expiresAt}`.

## Running it

```bash
node src/main.ts keygen --out D:/secret/cashgear-licensing   # once: the signing key, and the public key to build in
node src/main.ts serve --key D:/secret/cashgear-licensing/licence-signing.pem --store D:/licensing/licences.json
node src/main.ts issue --store D:/licensing/licences.json --product cashgear-video --edition pro --machines 3 --licensee "Ada Lovelace"
node src/main.ts revoke --store D:/licensing/licences.json --id <licence id>
node src/main.ts list --store D:/licensing/licences.json
```

- **The signing key:** keep it secret and back it up offline. Losing it means re-releasing every app with a new public key.
- **Changing the store while serving:** `issue` and `revoke` can run while the server does, because every change holds a lock file.
- **Configuring a host:** `serve` also reads these settings from the environment:
  - `CGV_LICENSING_KEY` (the PEM itself) or `CGV_LICENSING_KEY_FILE`
  - `CGV_LICENSING_STORE`
  - `PORT`

## Deploying

Any host that runs Node 24 or a container can serve it. For example, Azure Container Apps or Azure App Service, built from the `Dockerfile` here:

1. Put the signing key in the host's secret store, and pass it as `CGV_LICENSING_KEY`.
2. Mount persistent storage, and set `CGV_LICENSING_STORE` to a file on it.
3. Serve it over HTTPS at the address the apps are built with (CashGear Video reads `VITE_CGV_LICENCE_SERVER`).
4. Back up the store. It is one JSON file, written whole on every change.

The server speaks plain HTTP: the host ends TLS. The server does not limit how often it is called, but keys have 125 random bits, so guessing them is hopeless. Put rate limits in the host's front door if it offers them.
