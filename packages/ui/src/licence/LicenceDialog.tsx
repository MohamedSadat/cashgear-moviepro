import { useState } from 'react';
import type { MediaPlatformKind } from '@cgv/engine-client';
import { Dialog } from '../project/Dialog';
import { formatWhen } from '../project/format';
import type { LicenceApi } from './useLicence';

const freeLimits =
  'Exports carry a small CashGear Video watermark and stop at 1080p. A Pro licence removes the watermark and allows exports up to 4K.';

/** The edition, and activating or deactivating a Pro licence key. */
export function LicenceDialog({
  licence,
  platform,
  onClose,
}: {
  licence: LicenceApi;
  platform: MediaPlatformKind;
  onClose(): void;
}) {
  const [key, setKey] = useState('');
  const { status, busy, error } = licence;
  const machine = platform === 'desktop' ? 'computer' : 'browser';
  const pro = status.edition === 'pro' && status.state !== 'development';
  const canActivate = status.state !== 'development' && status.state !== 'unavailable' && !pro;
  return (
    <Dialog
      title="Licence"
      onClose={onClose}
      testId="licence-dialog"
      footer={
        <>
          {pro && (
            <>
              <button type="button" disabled={busy} onClick={() => void licence.refresh()}>
                Check now
              </button>
              <button
                type="button"
                data-testid="licence-deactivate"
                disabled={busy}
                onClick={() => void licence.deactivate()}
              >
                Deactivate on this {machine}
              </button>
            </>
          )}
          <button type="button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div data-testid="licence-status" data-edition={status.edition} data-state={status.state}>
        {status.state === 'development' && (
          <p>This is a development build: every feature is on. Release builds check a licence.</p>
        )}
        {status.state === 'unavailable' && (
          <p>Licensing is not set up in this build, so it is the free edition. {freeLimits}</p>
        )}
        {pro && (
          <>
            <p>
              <strong>CashGear Video Pro</strong> is active on this {machine}.
              {status.checkedAt !== null && ` Last checked ${formatWhen(status.checkedAt)}.`}
            </p>
            {status.expiresAt !== null && (
              <p>The subscription runs until {formatWhen(status.expiresAt)}.</p>
            )}
            {status.state === 'offline' && status.graceUntil !== null && (
              <p className="cgv-licence-warning" role="status">
                The licence server has not been reached for over a week. Connect to the internet by{' '}
                {formatWhen(status.graceUntil)} to keep Pro.
              </p>
            )}
          </>
        )}
        {canActivate && (
          <>
            {status.state === 'lapsed' && status.checkedAt !== null && (
              <p className="cgv-licence-warning" role="status">
                Your Pro licence has not been checked since {formatWhen(status.checkedAt)}, so this
                is the free edition until the app reaches the licence server.{' '}
                <button type="button" disabled={busy} onClick={() => void licence.refresh()}>
                  Check now
                </button>
              </p>
            )}
            {status.state === 'expired' && status.expiresAt !== null && (
              <p className="cgv-licence-warning" role="status">
                Your Pro subscription ended {formatWhen(status.expiresAt)}.
              </p>
            )}
            <p>
              <strong>Free edition.</strong> {freeLimits}
            </p>
            <form
              className="cgv-form cgv-licence-form"
              onSubmit={(event) => {
                event.preventDefault();
                void licence.activate(key).then((done) => done && setKey(''));
              }}
            >
              <label>
                Licence key
                <input
                  value={key}
                  data-testid="licence-key"
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setKey(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="cgv-primary"
                data-testid="licence-activate"
                disabled={busy || !key.trim()}
              >
                {busy ? 'Activating…' : 'Activate'}
              </button>
            </form>
          </>
        )}
      </div>
      {error && (
        <p className="cgv-licence-error" role="alert" data-testid="licence-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
