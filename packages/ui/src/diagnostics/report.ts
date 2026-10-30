// Diagnostic reports: what a user can save and send with a problem. Nothing is
// sent anywhere: the report is a text file the user chooses to save. It holds the
// app's version and edition, the browser or system, the GPU and what the engine
// reported, and the last errors and warnings, but nothing of the project or media
// (file names are kept out of the messages it records).

const keep = 60;
const entries: { at: number; kind: string; text: string }[] = [];
let installed = false;

/** Paths (two parts or more) and media file names, which may name the user's files. */
const fileLike =
  /(?:[A-Za-z]:)?(?:[\\/][^\s'"`<>|\\/:]+){2,}|[^\s'"`<>|\\/]+\.(?:mp4|mov|mkv|webm|wav|mp3|m4a|aac|flac|ogg|opus|png|jpe?g|webp|cgvproj)\b/gi;

export function scrub(text: string): string {
  return text.replace(fileLike, '<file>').slice(0, 2000);
}

/** Records an entry: kept in memory, the last 60 only. */
export function record(kind: string, text: string) {
  entries.push({ at: Date.now(), kind, text: scrub(text) });
  if (entries.length > keep) entries.splice(0, entries.length - keep);
}

const describe = (value: unknown) =>
  value instanceof Error ? `${value.name}: ${value.message}` : String(value);

/** Starts recording uncaught errors, rejections and console warnings and errors. */
export function recordProblems() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (event) =>
    record('error', describe(event.error ?? event.message)),
  );
  window.addEventListener('unhandledrejection', (event) =>
    record('rejection', describe(event.reason)),
  );
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      record(level, args.map(describe).join(' '));
      original(...args);
    };
  }
}

export interface ReportContext {
  version: string;
  edition: string;
  platform: string;
  /** The capability probe, the engine's state and the like. */
  sections: Record<string, unknown>;
}

export function diagnosticReport(context: ReportContext): string {
  const lines = [
    'CashGear Video diagnostic report',
    `Made: ${new Date().toISOString()}`,
    `Version: ${context.version} (${context.edition}, ${context.platform})`,
    `Browser: ${navigator.userAgent}`,
    `Cores: ${navigator.hardwareConcurrency}; device memory: ${
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 'unknown'
    } GB`,
    '',
  ];
  for (const [name, value] of Object.entries(context.sections)) {
    lines.push(`${name}:`, scrub(JSON.stringify(value, null, 2) ?? 'none'), '');
  }
  lines.push(`Recent problems (${entries.length}):`);
  for (const entry of entries) {
    lines.push(`  ${new Date(entry.at).toISOString()} ${entry.kind}: ${entry.text}`);
  }
  if (!entries.length) lines.push('  none');
  return lines.join('\n') + '\n';
}
