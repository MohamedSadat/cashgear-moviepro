import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeys, loadPrivateKey, publicKeyOf } from './envelope.ts';
import { Licensing } from './licensing.ts';
import { createLicenceServer } from './server.ts';
import { Store, type Edition } from './store.ts';

// The licence server and the seller's commands (see README.md):
//   keygen --out <folder>         makes the signing key and prints the public key
//   public-key --key <pem>        prints the public key the apps build in
//   serve --key <pem> --store <json> [--port 8080] [--host 0.0.0.0]
//   issue --store <json> [--product cashgear-video] [--edition pro] [--machines 3]
//         [--licensee <name>] [--expires <date>] [--json]
//   revoke --store <json> --id <licence id>
//   list --store <json>
// `serve` also reads CGV_LICENSING_KEY (the PEM itself), CGV_LICENSING_KEY_FILE,
// CGV_LICENSING_STORE and PORT, as a host such as Azure sets them.

const [command, ...rest] = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < rest.length; i++) {
  const name = rest[i];
  if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
  const value = rest[i + 1];
  if (value === undefined || value.startsWith('--')) options.set(name.slice(2), 'true');
  else options.set(name.slice(2), rest[++i]);
}

function option(name: string, fallback?: string): string {
  const value = options.get(name) ?? fallback;
  if (value === undefined) throw new Error(`--${name} is required.`);
  return value;
}

async function signingKeyPem(): Promise<string> {
  if (options.has('key')) return readFile(option('key'), 'utf8');
  if (process.env.CGV_LICENSING_KEY) return process.env.CGV_LICENSING_KEY;
  if (process.env.CGV_LICENSING_KEY_FILE)
    return readFile(process.env.CGV_LICENSING_KEY_FILE, 'utf8');
  throw new Error('--key (or CGV_LICENSING_KEY or CGV_LICENSING_KEY_FILE) is required.');
}

function store(): Store {
  return new Store(option('store', process.env.CGV_LICENSING_STORE));
}

/** Commands that only change the store sign nothing, so they need no key. */
function offline(): Licensing {
  return new Licensing(store(), null);
}

switch (command) {
  case 'keygen': {
    const path = join(option('out'), 'licence-signing.pem');
    const keys = generateKeys();
    await writeFile(path, keys.privatePem, { flag: 'wx', mode: 0o600 });
    console.log(`Signing key: ${path} (keep it secret, and back it up offline)`);
    console.log(`Public key: ${keys.publicKey}`);
    break;
  }
  case 'public-key':
    console.log(publicKeyOf(loadPrivateKey(await readFile(option('key'), 'utf8'))));
    break;
  case 'serve': {
    const key = loadPrivateKey(await signingKeyPem());
    const publicKey = publicKeyOf(key);
    const server = createLicenceServer(new Licensing(store(), key), {
      publicKey,
      log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    });
    const port = Number(option('port', process.env.PORT ?? '8080'));
    const host = option('host', '0.0.0.0');
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      console.log(`Listening on http://${host}:${bound} with public key ${publicKey}`);
    });
    break;
  }
  case 'issue': {
    const expires = options.get('expires');
    const { licence, key } = await offline().issue({
      product: option('product', 'cashgear-video'),
      edition: option('edition', 'pro') as Edition,
      machines: Number(option('machines', '3')),
      licensee: options.get('licensee') ?? null,
      expiresAt: expires ? new Date(expires).toISOString() : null,
    });
    if (options.has('json')) console.log(JSON.stringify({ id: licence.id, key }));
    else console.log(`Licence ${licence.id}\nKey: ${key}`);
    break;
  }
  case 'revoke':
    if (!(await offline().revoke(option('id')))) throw new Error('No licence has that id.');
    console.log('Revoked.');
    break;
  case 'list':
    for (const licence of (await store().read()).licences) {
      console.log(
        [
          licence.id,
          licence.product,
          licence.edition,
          `${licence.activations.length}/${licence.machines} machines`,
          licence.licensee ?? '-',
          licence.expiresAt ? `ends ${licence.expiresAt}` : 'perpetual',
          licence.revokedAt ? `revoked ${licence.revokedAt}` : '',
        ].join('  '),
      );
    }
    break;
  default:
    console.error('Commands: keygen, public-key, serve, issue, revoke, list (see README.md).');
    process.exit(1);
}
