import { randomUUID, type KeyObject } from 'node:crypto';
import { signEnvelope } from './envelope.ts';
import { keyHash, newLicenceKey, normaliseKey } from './keys.ts';
import type { Edition, Licence, Store } from './store.ts';

// The licence server's rules, apart from HTTP. The protocol is CashGear Backup's,
// so one server serves both apps:
//   activate {key, machine, product, version} and refresh {licenceId, machine}
//   answer {token} or a refusal {error, code, revoked};
//   deactivate {licenceId, machine} frees the machine's place.
// A token is a signed envelope (envelope.ts) around a `TokenPayload`.

/** What a token says. Backup reads all but `product`, which the other apps check. */
export interface TokenPayload {
  licenceId: string;
  product: string;
  edition: Edition;
  machine: string;
  issuedAt: string;
  expiresAt: string | null;
}

export type RefusalCode =
  | 'bad-request'
  | 'invalid-key'
  | 'wrong-product'
  | 'machine-limit'
  | 'revoked'
  | 'expired'
  | 'not-activated';

export interface Refusal {
  status: number;
  code: RefusalCode;
  error: string;
  revoked: boolean;
}

export type Answer = { token: string } | Refusal;

const MESSAGES: Record<RefusalCode, string> = {
  'bad-request': 'The request is not valid.',
  'invalid-key': 'That licence key is not valid.',
  'wrong-product': 'That licence key is for another CashGear app.',
  'machine-limit':
    'That licence is active on as many computers as it allows. Deactivate it on one of them first.',
  revoked: 'That licence has been withdrawn.',
  expired: 'That licence has expired.',
  'not-activated': 'This computer is no longer activated. Enter the licence key again.',
};

function refuse(code: RefusalCode): Refusal {
  return {
    status: code === 'bad-request' ? 400 : 403,
    code,
    error: MESSAGES[code],
    revoked: code === 'revoked',
  };
}

/** Machine ids are hashes or random ids, never names. */
const MACHINE = /^[A-Za-z0-9._:-]{8,128}$/;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export interface IssueRequest {
  product: string;
  edition: Edition;
  machines: number;
  licensee?: string | null;
  expiresAt?: string | null;
}

export class Licensing {
  private readonly store: Store;
  /** Null for the seller's commands, which sign nothing. */
  private readonly signingKey: KeyObject | null;
  private readonly now: () => Date;

  constructor(store: Store, signingKey: KeyObject | null, now: () => Date = () => new Date()) {
    this.store = store;
    this.signingKey = signingKey;
    this.now = now;
  }

  async activate(body: Record<string, unknown>): Promise<Answer> {
    const key = typeof body.key === 'string' ? normaliseKey(body.key) : null;
    const machine = text(body.machine, 128);
    const product = text(body.product, 64);
    const version = text(body.version, 64) ?? '';
    if (!key || !machine || !MACHINE.test(machine) || !product) return refuse('bad-request');
    const hash = keyHash(key);
    // Wrong keys are the likely abuse, and need no write.
    if (!(await this.store.read()).licences.some((licence) => licence.keyHash === hash)) {
      return refuse('invalid-key');
    }
    return this.store.update((data) => {
      const licence = data.licences.find((candidate) => candidate.keyHash === hash);
      if (!licence) return refuse('invalid-key');
      if (licence.product !== product) return refuse('wrong-product');
      const refusal = this.lapsed(licence);
      if (refusal) return refusal;
      const now = this.now().toISOString();
      const activation = licence.activations.find((candidate) => candidate.machine === machine);
      if (activation) {
        activation.lastSeenAt = now;
        activation.version = version;
      } else if (licence.activations.length >= licence.machines) {
        return refuse('machine-limit');
      } else {
        licence.activations.push({ machine, activatedAt: now, lastSeenAt: now, version });
      }
      return { token: this.token(licence, machine, now) };
    });
  }

  async refresh(body: Record<string, unknown>): Promise<Answer> {
    const id = text(body.licenceId, 64);
    const machine = text(body.machine, 128);
    if (!id || !machine) return refuse('bad-request');
    return this.store.update((data) => {
      const licence = data.licences.find((candidate) => candidate.id === id);
      if (!licence) return refuse('invalid-key');
      const refusal = this.lapsed(licence);
      if (refusal) return refusal;
      const activation = licence.activations.find((candidate) => candidate.machine === machine);
      if (!activation) return refuse('not-activated');
      const now = this.now().toISOString();
      activation.lastSeenAt = now;
      return { token: this.token(licence, machine, now) };
    });
  }

  /** Frees the machine's place. Deactivating twice is not an error. */
  async deactivate(body: Record<string, unknown>): Promise<{ ok: true } | Refusal> {
    const id = text(body.licenceId, 64);
    const machine = text(body.machine, 128);
    if (!id || !machine) return refuse('bad-request');
    return this.store.update((data) => {
      const licence = data.licences.find((candidate) => candidate.id === id);
      if (!licence) return refuse('invalid-key');
      licence.activations = licence.activations.filter(
        (activation) => activation.machine !== machine,
      );
      return { ok: true as const };
    });
  }

  /** A new licence. The key is shown once: the store keeps only its hash. */
  issue(request: IssueRequest): Promise<{ licence: Licence; key: string }> {
    if (!Number.isInteger(request.machines) || request.machines < 1) {
      throw new Error('A licence allows at least one machine.');
    }
    const key = newLicenceKey();
    const licence: Licence = {
      id: randomUUID(),
      keyHash: keyHash(normaliseKey(key)!),
      product: request.product,
      edition: request.edition,
      machines: request.machines,
      licensee: request.licensee ?? null,
      createdAt: this.now().toISOString(),
      expiresAt: request.expiresAt ?? null,
      revokedAt: null,
      activations: [],
    };
    return this.store.update((data) => {
      data.licences.push(licence);
      return { licence, key };
    });
  }

  /** Withdraws a licence (a refund): it can no longer be activated or refreshed. */
  revoke(id: string): Promise<boolean> {
    return this.store.update((data) => {
      const licence = data.licences.find((candidate) => candidate.id === id);
      if (!licence) return false;
      licence.revokedAt ??= this.now().toISOString();
      return true;
    });
  }

  private lapsed(licence: Licence): Refusal | null {
    if (licence.revokedAt) return refuse('revoked');
    if (licence.expiresAt && Date.parse(licence.expiresAt) <= this.now().getTime()) {
      return refuse('expired');
    }
    return null;
  }

  private token(licence: Licence, machine: string, issuedAt: string): string {
    if (!this.signingKey) throw new Error('Signing needs the signing key.');
    const payload: TokenPayload = {
      licenceId: licence.id,
      product: licence.product,
      edition: licence.edition,
      machine,
      issuedAt,
      expiresAt: licence.expiresAt,
    };
    return signEnvelope(payload, this.signingKey);
  }
}
