import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

// Licences and their activations in one JSON file. Every change reads the file,
// changes it and writes it back whole (a temporary file renamed over it), holding a
// lock file meanwhile, so the server and the command line can change it together.
// That suits a store of thousands of licences; a bigger sale wants a database
// behind the same `Licensing` class.

export type Edition = 'pro' | 'business';

export interface Activation {
  machine: string;
  activatedAt: string;
  lastSeenAt: string;
  version: string;
}

export interface Licence {
  id: string;
  keyHash: string;
  product: string;
  edition: Edition;
  /** How many machines (PCs or browsers) may be active at once. */
  machines: number;
  licensee: string | null;
  createdAt: string;
  /** For a subscription, when it ends. */
  expiresAt: string | null;
  revokedAt: string | null;
  activations: Activation[];
}

export interface StoreData {
  licences: Licence[];
}

/** A lock older than this was left by a process that died. */
const STALE_LOCK_MS = 10_000;

export class Store {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<StoreData> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as StoreData;
      return { licences: data.licences ?? [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { licences: [] };
      throw error;
    }
  }

  /** Runs `change` on the current data and saves it, one change at a time. */
  update<T>(change: (data: StoreData) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const release = await this.lock();
      try {
        const data = await this.read();
        const result = change(data);
        const temporary = `${this.path}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
        await rename(temporary, this.path);
        return result;
      } finally {
        await release();
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async lock(): Promise<() => Promise<void>> {
    const path = `${this.path}.lock`;
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await open(path, 'wx');
        await handle.close();
        return () => rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const age = await stat(path).then(
          (info) => Date.now() - info.mtimeMs,
          () => 0,
        );
        if (age > STALE_LOCK_MS) await rm(path, { force: true });
        else if (attempt > 500) throw new Error(`The store is locked: ${path}`, { cause: error });
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
}
