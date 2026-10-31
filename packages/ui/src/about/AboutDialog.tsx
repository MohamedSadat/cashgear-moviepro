import { useEffect, useState } from 'react';
import type { MediaPlatformKind } from '@cgv/engine-client';
import type { LicenceStatus } from '../licence/licence';
import type { NativeInfo } from '../platform';
import { Dialog } from '../project/Dialog';

/**
 * The version and edition, and the third-party notices the build writes
 * (scripts/third-party-notices.mjs), read when asked for: they run to hundreds of
 * kilobytes.
 */
export function AboutDialog({
  platform,
  native,
  licence,
  onReport,
  onClose,
}: {
  platform: MediaPlatformKind;
  native: NativeInfo | undefined;
  licence: LicenceStatus;
  /** Saves a diagnostic report (diagnostics/report.ts). */
  onReport(): void;
  onClose(): void;
}) {
  const [notices, setNotices] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);
  useEffect(() => {
    if (!showing || notices !== null) return;
    let live = true;
    fetch(new URL('third-party-notices.txt', document.baseURI))
      .then((response) => (response.ok ? response.text() : Promise.reject(response.status)))
      .then(
        (text) => live && setNotices(text),
        () => live && setNotices('The notices are missing from this build.'),
      );
    return () => {
      live = false;
    };
  }, [showing, notices]);
  const version = native?.version ?? import.meta.env.VITE_CGV_VERSION ?? 'development';
  const edition =
    licence.state === 'development'
      ? 'Development build'
      : licence.state === 'included'
        ? 'Full edition'
        : licence.edition === 'pro'
          ? 'Pro'
          : 'Free edition';
  return (
    <Dialog
      title="About CashGear Video"
      onClose={onClose}
      testId="about-dialog"
      wide={showing}
      footer={
        <>
          <button type="button" data-testid="about-report" onClick={onReport}>
            Save a diagnostic report
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p data-testid="about-version">
        <strong>CashGear Video {version}</strong> · {edition} ·{' '}
        {platform === 'desktop' ? 'Desktop app' : 'Web app'}
      </p>
      <p className="cgv-muted">
        Built with open-source software: Rust crates, JavaScript packages, fonts under the SIL Open
        Font License, and AI models.
        {platform === 'desktop' &&
          ' The desktop app runs FFmpeg under the LGPL; its notice and source are in the ffmpeg folder beside the app.'}
      </p>
      {showing ? (
        <pre className="cgv-notices" data-testid="about-notices" tabIndex={0}>
          {notices ?? 'Loading…'}
        </pre>
      ) : (
        <button type="button" data-testid="about-show-notices" onClick={() => setShowing(true)}>
          Third-party notices
        </button>
      )}
    </Dialog>
  );
}
