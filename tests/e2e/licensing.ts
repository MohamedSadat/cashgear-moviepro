import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// The reference licence server (services/licensing) for tests: a signing key and a
// store of its own in a temporary folder, on a free port.

const main = join(process.cwd(), 'services/licensing/src/main.ts');
const run = promisify(execFile);

export interface TestLicensing {
  /** The server's address. */
  base: string;
  publicKey: string;
  /** The query that points a build that is not a release at this server. */
  query: string;
  issue(options?: { machines?: number; expires?: string }): Promise<{ id: string; key: string }>;
  revoke(id: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startLicensing(): Promise<TestLicensing> {
  const folder = await mkdtemp(join(tmpdir(), 'cgv-licensing-e2e-'));
  const store = join(folder, 'licences.json');
  const { stdout } = await run(process.execPath, [main, 'keygen', '--out', folder]);
  const publicKey = /Public key: (\S+)/.exec(stdout)![1];
  const server: ChildProcess = spawn(
    process.execPath,
    [main, 'serve', '--key', join(folder, 'licence-signing.pem'), '--store', store],
    { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const base = await new Promise<string>((resolve, reject) => {
    let output = '';
    server.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const listening = /Listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (listening) resolve(`http://127.0.0.1:${listening[1]}`);
    });
    server.once('exit', (code) => reject(new Error(`The licence server exited (${code}).`)));
  });
  return {
    base,
    publicKey,
    query: `&licenceServer=${encodeURIComponent(base)}&licenceKeys=${encodeURIComponent(publicKey)}`,
    async issue(options = {}) {
      const args = [main, 'issue', '--store', store, '--json'];
      args.push('--machines', String(options.machines ?? 1));
      if (options.expires) args.push('--expires', options.expires);
      return JSON.parse((await run(process.execPath, args)).stdout);
    },
    async revoke(id) {
      await run(process.execPath, [main, 'revoke', '--store', store, '--id', id]);
    },
    async stop() {
      server.kill();
      await rm(folder, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
