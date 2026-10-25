// A notice for fonts the project's titles name that this computer lacks, as
// missing media gets one. Those titles draw with the fallback fonts meanwhile.
import { useState } from 'react';
import type { MediaPlatformKind, ProjectSnapshot } from '@cgv/engine-client';
import { missingFonts, useFontFamilies } from './fonts';

interface Props {
  snapshot: ProjectSnapshot | null;
  platform: MediaPlatformKind;
  /** Imported and installed fonts are listed: until then, those would look missing. */
  listed: boolean;
}

export function MissingFontsNotice({ snapshot, platform, listed }: Props) {
  const families = useFontFamilies();
  const [dismissed, setDismissed] = useState('');
  if (!listed || !snapshot) return null;
  const missing = missingFonts(snapshot.project, families);
  const key = missing.join('\n');
  if (missing.length === 0 || key === dismissed) return null;
  return (
    <div className="cgv-notice" role="alert" data-testid="font-notice">
      Missing {missing.length === 1 ? 'font' : 'fonts'}: {missing.join(', ')}. Titles use the
      fallback fonts until you {platform === 'desktop' ? 'install or import' : 'import'}{' '}
      {missing.length === 1 ? 'it' : 'them'}.
      <button type="button" aria-label="Dismiss" onClick={() => setDismissed(key)}>
        ×
      </button>
    </div>
  );
}
